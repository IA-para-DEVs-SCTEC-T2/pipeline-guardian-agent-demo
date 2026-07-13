/**
 * Publicação do diagnóstico como comentário de Pull Request.
 *
 * Ação externa e visível: por isso o padrão é **dry-run**. O comentário é
 * gravado em disco e nada é enviado ao GitHub, a menos que o operador habilite
 * explicitamente `AUTOMATION_ALLOW_PR_COMMENT=true` e forneça um token.
 *
 * O upsert usa o marcador `REPORT_MARKER`: se já existe um comentário do agente
 * na PR, ele é atualizado; caso contrário, um novo é criado. Assim o histórico
 * da PR não vira uma pilha de comentários repetidos a cada push.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { REPORT_MARKER, renderPullRequestComment } from './render-report.mjs';

const GITHUB_API = 'https://api.github.com';

/**
 * @param {object} input
 * @param {object} input.diagnosis diagnóstico validado
 * @param {string} input.repository no formato `owner/repo`
 * @param {number|string|null} input.pullRequestNumber
 * @param {string} [input.token] token do GitHub
 * @param {boolean} [input.dryRun=true] quando true, não faz chamada de rede
 * @param {string} [input.outFile] onde gravar o corpo do comentário
 * @param {typeof fetch} [input.fetchImpl] injetável nos testes
 * @returns {Promise<{ action: string, dryRun: boolean, url: string|null, outFile: string|null, reason?: string }>}
 */
export async function upsertPullRequestComment({
  diagnosis,
  repository,
  pullRequestNumber,
  token,
  dryRun = true,
  outFile = null,
  fetchImpl = fetch,
}) {
  const body = renderPullRequestComment(diagnosis);

  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, body, 'utf8');
  }

  if (dryRun) {
    return { action: 'dry_run', dryRun: true, url: null, outFile, reason: 'dry-run: nada foi enviado ao GitHub.' };
  }

  if (!token) {
    return { action: 'skipped', dryRun: false, url: null, outFile, reason: 'token do GitHub ausente.' };
  }

  if (!pullRequestNumber) {
    return { action: 'skipped', dryRun: false, url: null, outFile, reason: 'número da Pull Request ausente.' };
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  const listUrl = `${GITHUB_API}/repos/${repository}/issues/${pullRequestNumber}/comments?per_page=100`;
  const listResponse = await fetchImpl(listUrl, { method: 'GET', headers });
  if (!listResponse.ok) {
    throw new Error(`Falha ao listar comentários da PR: HTTP ${listResponse.status}`);
  }

  const comments = await listResponse.json();
  const existing = comments.find((comment) => comment.body?.includes(REPORT_MARKER));

  const target = existing
    ? `${GITHUB_API}/repos/${repository}/issues/comments/${existing.id}`
    : `${GITHUB_API}/repos/${repository}/issues/${pullRequestNumber}/comments`;

  const response = await fetchImpl(target, {
    method: existing ? 'PATCH' : 'POST',
    headers,
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    throw new Error(`Falha ao publicar comentário na PR: HTTP ${response.status}`);
  }

  const created = await response.json();
  return {
    action: existing ? 'updated' : 'created',
    dryRun: false,
    url: created.html_url ?? null,
    outFile,
  };
}

/**
 * Lê a intenção do operador a partir do ambiente. Publicar exige um opt-in
 * explícito; a ausência da variável significa dry-run.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function isPullRequestCommentEnabled(env = process.env) {
  return env.AUTOMATION_ALLOW_PR_COMMENT === 'true' && Boolean(env.GITHUB_TOKEN);
}
