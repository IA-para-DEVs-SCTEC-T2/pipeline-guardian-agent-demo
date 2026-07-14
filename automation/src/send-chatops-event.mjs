/**
 * Transporte do diagnóstico do Pipeline Guardian para o ChatOps.
 *
 * Este script **não diagnostica nada**. O Pipeline Guardian já rodou, já
 * decidiu e já gravou `reports/diagnosis.json`. Aqui o diagnóstico só é
 * embrulhado, assinado e entregue — se este script sumir, o diagnóstico
 * continua existindo no Job Summary e nos artefatos.
 *
 * A assinatura cobre `timestamp.corpo_bruto`, e o corpo assinado é exatamente a
 * string enviada no POST. Reserializar o JSON entre assinar e enviar produziria
 * bytes diferentes — e uma assinatura que não confere do outro lado.
 */

import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { redactSecrets } from './redact-secrets.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Canais lógicos aceitos. Espelha a allowlist do FastAPI. */
export const ALLOWED_TARGETS = ['test', 'class'];

/**
 * A branch real da Pull Request é `GITHUB_HEAD_REF`; `GITHUB_REF_NAME`, em PRs,
 * vira `<numero>/merge`. Fora de PR, só existe `GITHUB_REF_NAME`.
 */
export function resolveBranch(env = process.env) {
  return env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || 'unknown';
}

/**
 * Monta o envelope de transporte a partir do diagnóstico e do contexto do CI.
 *
 * O `diagnosis` entra **como está**: é o JSON do Guardian, sem tradução de
 * campo e sem segundo schema.
 */
export function buildTransportPayload({ diagnosis, env = process.env }) {
  const repository = env.GITHUB_REPOSITORY ?? diagnosis.repository;
  const runId = env.GITHUB_RUN_ID ?? '0';
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';

  return {
    event_type: 'pipeline_diagnosis',
    source: 'github_actions',
    repository,
    branch: resolveBranch(env),
    commit_sha: env.GITHUB_SHA ?? diagnosis.commitSha,
    run_id: String(runId),
    run_url: `${server}/${repository}/actions/runs/${runId}`,
    target: env.CHATOPS_TARGET ?? 'test',
    diagnosis,
  };
}

/** HMAC SHA-256 sobre `timestamp.corpo_bruto`, no formato `sha256=<hex>`. */
export function signPayload({ secret, timestamp, rawBody }) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

/**
 * Entrega o evento ao ChatOps.
 *
 * @returns {Promise<{ status: number, requestId: string|null, messageId: string|null }>}
 */
export async function sendChatOpsEvent({
  payload,
  endpointUrl,
  secret,
  token,
  now = () => Math.floor(Date.now() / 1000),
  fetchImpl = fetch,
}) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(now());

  const url = `${endpointUrl.replace(/\/+$/, '')}/webhooks/github-actions`;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-ChatOps-Timestamp': timestamp,
      'X-ChatOps-Signature': signPayload({ secret, timestamp, rawBody }),
    },
    body: rawBody,
  });

  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    // A mensagem do backend já é segura por contrato, mas passa pela máscara
    // assim mesmo: uma resposta inesperada não vai virar vazamento no log do CI.
    const detalhe = redactSecrets(String(body.message ?? 'sem detalhe'));
    throw new Error(`ChatOps recusou o evento: HTTP ${response.status} — ${detalhe}`);
  }

  return {
    status: response.status,
    requestId: body.request_id ?? null,
    messageId: body.message_id ?? null,
  };
}

async function main() {
  const env = process.env;

  const endpointUrl = env.CHATOPS_ENDPOINT_URL;
  if (!endpointUrl) {
    process.stdout.write('[chatops] CHATOPS_ENDPOINT_URL não definido: notificação desabilitada.\n');
    return;
  }

  const secret = env.CHATOPS_SHARED_SECRET;
  const token = env.CHATOPS_API_TOKEN;
  if (!secret || !token) {
    throw new Error('CHATOPS_SHARED_SECRET e CHATOPS_API_TOKEN são obrigatórios para notificar.');
  }

  const target = env.CHATOPS_TARGET ?? 'test';
  if (!ALLOWED_TARGETS.includes(target)) {
    throw new Error(`CHATOPS_TARGET inválido: use ${ALLOWED_TARGETS.join(' ou ')}.`);
  }

  const diagnosisPath = resolve(env.CHATOPS_DIAGNOSIS_PATH ?? join(REPO_ROOT, 'reports', 'diagnosis.json'));
  if (!existsSync(diagnosisPath)) {
    throw new Error(`diagnóstico não encontrado em ${diagnosisPath}: o Pipeline Guardian não gerou o relatório.`);
  }

  const diagnosis = JSON.parse(readFileSync(diagnosisPath, 'utf8'));
  const payload = buildTransportPayload({ diagnosis, env });

  const { status, requestId, messageId } = await sendChatOpsEvent({
    payload,
    endpointUrl,
    secret,
    token,
  });

  process.stdout.write(
    `[chatops] evento aceito — HTTP ${status}, canal: ${target}, ` +
      `decisão: ${diagnosis.deployDecision}\n` +
      `[chatops] request_id: ${requestId}\n[chatops] message_id: ${messageId}\n`,
  );
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    // Sem stack e sem URL: o log do CI é público em repositório público.
    process.stderr.write(`[chatops] falha ao notificar: ${redactSecrets(String(error.message))}\n`);
    process.exitCode = 1;
  });
}
