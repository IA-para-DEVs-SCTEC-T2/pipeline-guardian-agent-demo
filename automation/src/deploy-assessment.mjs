/**
 * Deploy assistido — avaliação de prontidão de uma release.
 *
 * O agente **avalia**; a política **decide**. Este arquivo não reimplementa o
 * Pipeline Guardian: reusa a coleta (`buildCiSource`), a análise
 * (`analyzePipeline`) e a política (`applyDeployPolicy`, já aplicada dentro da
 * análise). O que ele acrescenta é o recorte de deploy — release, gates,
 * recomendação do agente — e a separação explícita entre os dois vereditos:
 *
 *   agentRecommendation  o que o agente acha da prontidão TÉCNICA
 *   policyDecision       o que a política PERMITE promover
 *
 * A segunda sempre vence. Não existe caminho neste módulo em que
 * `agentRecommendation` influencie `policyDecision`: a política é calculada a
 * partir dos fatos (exit codes, segredos, limitações), nunca a partir da
 * opinião do agente. Quando as duas discordam, `policyOverrodeAgent` fica
 * `true` e o motivo aparece no relatório.
 *
 * Nada aqui promove nada. O deploy é simulado: `--manifest` só descreve o que
 * *teria* sido publicado.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deployAssessmentSchema,
  deploymentManifestSchema,
  DEPLOY_ENVIRONMENTS,
} from '../schemas/deploy-assessment-schema.mjs';
import { analyzePipeline, REPO_ROOT } from './analyze-pipeline.mjs';
import { buildCiSource } from './ci-diagnose.mjs';
import { BLOCKING_FAILURE_TYPES } from './deploy-policy.mjs';
import { redactSecrets, redactSecretsDeep } from './redact-secrets.mjs';
import { renderDeployAssessment } from './render-deploy-assessment.mjs';

/** Os gates técnicos avaliados, na ordem em que rodam no pipeline. */
export const GATES = ['lint', 'test', 'build', 'docker'];

/**
 * Única promoção que cada ambiente aceita. Usado duas vezes de propósito: para
 * decidir o job no workflow e, de novo, para autorizar a escrita do manifesto.
 * O `if:` do YAML não é a única barreira.
 */
export const ALLOWED_DECISION_BY_ENVIRONMENT = {
  staging: 'eligible_for_staging',
  production: 'requires_human_approval',
};

/**
 * Estado de cada gate, derivado do exit code observado — não de uma opinião do
 * modelo. Comando não observado é `skipped`, nunca `passed`: ausência de
 * evidência não é evidência de sucesso.
 *
 * @param {Array<{ name: string, status: string }>} commands
 * @returns {{ lint: string, test: string, build: string }}
 */
export function buildGateResults(commands = []) {
  const byName = new Map(commands.map((command) => [command.name, command]));

  return Object.fromEntries(
    GATES.map((gate) => [gate, byName.get(gate)?.status ?? 'skipped']),
  );
}

/**
 * A recomendação do AGENTE: sua leitura da prontidão técnica da release.
 *
 * Lê o diagnóstico (do modelo ou do fallback) e nada mais — é por isso que ela
 * pode estar errada. Um modelo que descreva um pipeline vermelho como
 * "unknown / risco baixo / confiança alta" produz aqui um
 * `eligible_for_staging` indevido. É exatamente esse o caso que a política
 * intercepta depois, olhando os exit codes reais.
 *
 * Note que production nunca recebe `eligible_for_staging`: o melhor veredito
 * que o agente consegue emitir para production é `technically_ready` — pronto
 * do ponto de vista técnico, ainda pendente de decisão humana.
 *
 * @param {object} input
 * @param {object} input.diagnosis campos de `modelDiagnosisSchema`
 * @param {string} input.environment
 * @returns {string} um valor de `AGENT_RECOMMENDATIONS`
 */
export function deriveAgentRecommendation({ diagnosis, environment }) {
  const notReady =
    BLOCKING_FAILURE_TYPES.includes(diagnosis.failureType) ||
    diagnosis.riskLevel === 'high' ||
    diagnosis.confidence === 'low';

  if (notReady) return 'not_ready';

  return environment === 'production' ? 'technically_ready' : 'eligible_for_staging';
}

/**
 * Quanto cada veredito PERMITE promover. Os dois vocabulários são diferentes de
 * propósito, então compará-los com `!==` não diz nada: em production, o agente
 * dizer `technically_ready` e a política responder `requires_human_approval` é
 * concordância — os dois estão dizendo "não promova sem uma pessoa".
 */
const AGENT_CLAIM_RANK = { not_ready: 0, technically_ready: 1, eligible_for_staging: 2 };
const POLICY_RANK = { blocked: 0, requires_human_approval: 1, eligible_for_staging: 2 };

/**
 * O agente pediu MAIS do que a política concedeu?
 *
 * Só isso é sobrescrita: a recomendação, se obedecida, teria promovido algo que
 * a política não autoriza. A política ser mais permissiva que o agente nunca
 * acontece na prática (o agente não abre portas), mas se acontecesse também não
 * seria sobrescrita — seria a política decidindo, como sempre.
 *
 * @param {string} agentRecommendation
 * @param {string} policyDecision
 * @returns {boolean}
 */
export function policyOverrodeAgent(agentRecommendation, policyDecision) {
  return AGENT_CLAIM_RANK[agentRecommendation] > POLICY_RANK[policyDecision];
}

/**
 * Monta a avaliação final a partir do diagnóstico, da política e da
 * recomendação do agente.
 *
 * Função pura e o ponto onde a precedência é imposta: `policyDecision` vem
 * inteiro de `policy`, e `agentRecommendation` é apenas transportado. Nenhuma
 * expressão abaixo lê a recomendação para decidir promoção.
 *
 * @param {object} input
 * @returns {object} conforme `deployAssessmentSchema`
 */
export function buildAssessment({
  diagnosis,
  policy,
  context,
  environment,
  releaseVersion,
  agentRecommendation,
  usedFallback,
  now = () => new Date(),
}) {
  const gateResults = buildGateResults(context.commands);
  const policyDecision = policy.deployDecision;

  // Sobrescrita não é erro: é o mecanismo funcionando. Só precisa ficar visível.
  const overrode = policyOverrodeAgent(agentRecommendation, policyDecision);

  return deployAssessmentSchema.parse(
    redactSecretsDeep({
      assessmentId: randomUUID(),
      repository: context.metadata.repository,
      commitSha: context.metadata.commitSha,
      environment,
      releaseVersion,

      summary: diagnosis.summary,
      gateResults,
      evidence: diagnosis.evidence,
      riskLevel: policy.riskLevel,
      confidence: diagnosis.confidence,
      nextSteps: diagnosis.nextSteps,

      agentRecommendation,
      policyDecision,
      requiresHumanApproval: policy.requiresHumanApproval,
      policyOverrodeAgent: overrode,
      policyReasons: policy.reasons,

      limitations: diagnosis.limitations,
      usedFallback,
      generatedAt: now().toISOString(),
    }),
  );
}

/**
 * Avaliação ponta a ponta: coleta → Pipeline Guardian → recomendação do agente
 * → política → avaliação validada por schema.
 *
 * @param {object} input
 * @param {object} input.source contexto bruto (logs + metadados do pipeline)
 * @param {string} input.environment `staging` ou `production`
 * @param {string} input.releaseVersion
 * @returns {Promise<{ assessment: object, diagnosis: object, policy: object }>}
 */
export async function assessDeployReadiness({
  source,
  environment,
  releaseVersion,
  env = process.env,
  client = null,
  now = () => new Date(),
}) {
  if (!DEPLOY_ENVIRONMENTS.includes(environment)) {
    throw new Error(`ambiente inválido: "${environment}". Esperado: ${DEPLOY_ENVIRONMENTS.join(' ou ')}.`);
  }
  if (!releaseVersion) {
    throw new Error('releaseVersion é obrigatória.');
  }

  // O ambiente do deploy é o do input do workflow, não o do `.env` do runner.
  const scoped = { ...source, pipeline: { ...source.pipeline, environment } };

  const { diagnosis, policy, context } = await analyzePipeline({ source: scoped, env, client, now });

  const agentRecommendation = deriveAgentRecommendation({ diagnosis, environment });

  const assessment = buildAssessment({
    diagnosis,
    policy,
    context,
    environment,
    releaseVersion,
    agentRecommendation,
    usedFallback: diagnosis.usedFallback,
    now,
  });

  return { assessment, diagnosis, policy };
}

/**
 * Manifesto do deploy simulado.
 *
 * Revalida a decisão antes de escrever: um manifesto só existe para a promoção
 * que a política de fato autorizou naquele ambiente. Se o job for disparado com
 * uma decisão incompatível (condição do workflow alterada, execução manual do
 * script), isto falha em vez de registrar uma promoção que ninguém aprovou.
 *
 * @param {object} input
 * @returns {object} conforme `deploymentManifestSchema`
 */
export function buildDeploymentManifest({ assessment, runId = null, now = () => new Date() }) {
  const expected = ALLOWED_DECISION_BY_ENVIRONMENT[assessment.environment];

  if (assessment.policyDecision !== expected) {
    throw new Error(
      `deploy simulado recusado: ambiente "${assessment.environment}" exige policyDecision ` +
        `"${expected}", mas a política decidiu "${assessment.policyDecision}".`,
    );
  }

  const approvalRequired = assessment.environment === 'production';

  return deploymentManifestSchema.parse({
    manifestId: randomUUID(),
    environment: assessment.environment,
    releaseVersion: assessment.releaseVersion,
    repository: assessment.repository,
    commitSha: assessment.commitSha,
    policyDecision: assessment.policyDecision,
    approvalRequired,
    status: 'simulated',
    simulatedAt: now().toISOString(),
    runId: runId ? String(runId) : null,
    note: approvalRequired
      ? 'Deploy SIMULADO. A aprovação humana foi concedida no GitHub Environment; nada foi publicado em infraestrutura real.'
      : 'Deploy SIMULADO em staging. Nada foi publicado em infraestrutura real.',
  });
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Expõe a decisão para os jobs seguintes do workflow.
 *
 * Só valores validados pelo schema (enums) chegam aqui — nada vindo do modelo
 * ou de log é escrito no `GITHUB_OUTPUT`.
 */
export function writeGithubOutput(values, outputPath) {
  if (!outputPath) return false;

  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  return true;
}

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runAssess({ env, outDir }) {
  const inputDir = resolve(env.CI_INPUT_DIR ?? join(REPO_ROOT, 'reports', 'input'));

  const source = buildCiSource({ inputDir, env });
  const { assessment } = await assessDeployReadiness({
    source,
    environment: env.DEPLOY_ENVIRONMENT,
    releaseVersion: env.RELEASE_VERSION,
    env,
  });

  const jsonPath = join(outDir, 'deploy-assessment.json');
  const markdownPath = join(outDir, 'deploy-assessment.md');

  writeJson(jsonPath, assessment);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(markdownPath, renderDeployAssessment(assessment), 'utf8');

  writeGithubOutput(
    {
      policyDecision: assessment.policyDecision,
      agentRecommendation: assessment.agentRecommendation,
      requiresHumanApproval: String(assessment.requiresHumanApproval),
      riskLevel: assessment.riskLevel,
    },
    env.GITHUB_OUTPUT,
  );

  process.stdout.write(
    `[deploy-assessment] release ${assessment.releaseVersion} → ${assessment.environment}\n` +
      `[deploy-assessment] agentRecommendation: ${assessment.agentRecommendation}\n` +
      `[deploy-assessment] policyDecision ....: ${assessment.policyDecision}` +
      `${assessment.policyOverrodeAgent ? ' (política sobrescreveu o agente)' : ''}\n` +
      `[deploy-assessment] aprovação humana ..: ${assessment.requiresHumanApproval ? 'necessária' : 'não necessária'}\n` +
      `[deploy-assessment] ${jsonPath}\n[deploy-assessment] ${markdownPath}\n`,
  );
}

async function runManifest({ env, outDir }) {
  const { readFileSync } = await import('node:fs');
  const assessmentPath = resolve(env.ASSESSMENT_FILE ?? join(outDir, 'deploy-assessment.json'));

  // O manifesto nasce da avaliação já validada — nunca de variáveis soltas do
  // job, que poderiam divergir do que a política decidiu.
  const assessment = deployAssessmentSchema.parse(JSON.parse(readFileSync(assessmentPath, 'utf8')));
  const manifest = buildDeploymentManifest({ assessment, runId: env.GITHUB_RUN_ID ?? null });

  const manifestPath = join(outDir, 'deployment-manifest.json');
  writeJson(manifestPath, manifest);

  process.stdout.write(
    `[deploy-assessment] deploy SIMULADO — ${manifest.environment} · ${manifest.releaseVersion}\n` +
      `[deploy-assessment] status ..........: ${manifest.status}\n` +
      `[deploy-assessment] approvalRequired : ${manifest.approvalRequired}\n` +
      `[deploy-assessment] ${manifestPath}\n`,
  );
}

async function main() {
  const env = process.env;
  const outDir = resolve(env.CI_OUTPUT_DIR ?? join(REPO_ROOT, 'reports'));
  const manifestMode = process.argv.slice(2).includes('--manifest');

  await (manifestMode ? runManifest({ env, outDir }) : runAssess({ env, outDir }));
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `[deploy-assessment] erro: ${redactSecrets(String(error.stack ?? error.message))}\n`,
    );
    process.exitCode = 1;
  });
}
