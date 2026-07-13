/**
 * Pipeline Guardian — orquestração do agente.
 *
 * Fluxo:
 *   coletar contexto (ferramentas) → mascarar segredos → classificar
 *   → analisar (modelo OU fallback determinístico) → aplicar política de deploy
 *   → validar no schema → gravar reports/diagnosis.{json,md}
 *
 * O modelo é opcional: sem `OPENAI_API_KEY`/`OPENAI_MODEL`, com erro de rede ou
 * com saída inválida, o agente cai no classificador determinístico e ainda
 * produz um diagnóstico válido. A decisão de deploy nunca é do modelo.
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { diagnosisSchema, modelDiagnosisSchema } from '../schemas/diagnosis-schema.mjs';
import { buildEvidenceList, collectContext } from './collect-context.mjs';
import { applyDeployPolicy } from './deploy-policy.mjs';
import { buildDeterministicDiagnosis, classifyFailure } from './deterministic-classifier.mjs';
import { redactSecrets, redactSecretsDeep } from './redact-secrets.mjs';
import { renderMarkdown } from './render-report.mjs';
import { SCENARIOS, simulateFailure, simulateSuccess, diffFiles } from './simulate-failure.mjs';
import { isPullRequestCommentEnabled, upsertPullRequestComment } from './upsert-pr-comment.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(AUTOMATION_ROOT, '..');
const PROMPT_PATH = join(AUTOMATION_ROOT, 'prompts', 'pipeline-analysis.md');

const DEFAULT_COMMANDS = ['npm run lint', 'npm run test', 'npm run build'];
const COMMAND_TIMEOUT_MS = 300_000;
const DEFAULT_MODEL_TIMEOUT_MS = 45_000;

/**
 * O agente pode usar o modelo? Exige as duas variáveis; sem qualquer uma delas,
 * o caminho é o fallback.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function canUseModel(env = process.env) {
  return Boolean(env.OPENAI_API_KEY) && Boolean(env.OPENAI_MODEL);
}

/**
 * Monta o payload enviado ao modelo: já mascarado e restrito aos trechos
 * relevantes. O modelo não recebe o repositório inteiro nem logs completos.
 *
 * @param {object} input
 * @returns {string} JSON
 */
export function buildModelPayload({ context, classification }) {
  const payload = {
    pipeline: {
      repository: context.metadata.repository,
      branch: context.metadata.branch,
      commitSha: context.metadata.commitSha,
      environment: context.metadata.environment,
      trigger: context.metadata.trigger,
      pipelineStatus: context.results.pipelineStatus,
    },
    commands: context.commands.map((command) => ({
      name: command.name,
      command: command.command,
      exitCode: command.exitCode,
      status: command.status,
      log: command.status === 'failed' ? command.log : undefined,
    })),
    pullRequestDiff: {
      files: context.diff.files,
      patch: context.diff.patch,
    },
    deterministicClassifier: {
      failureType: classification.failureType,
      signal: classification.signal,
      confidence: classification.confidence,
      ambiguous: classification.ambiguous,
      note: 'Sinal auxiliar por padrões de log. Discorde dele se as evidências indicarem outra coisa.',
    },
    collectedLimitations: context.limitations,
  };

  return redactSecrets(JSON.stringify(payload, null, 2));
}

/**
 * Chama a Responses API com saída estruturada validada por Zod.
 *
 * @param {object} input
 * @returns {Promise<object>} objeto conforme `modelDiagnosisSchema`
 */
export async function analyzeWithModel({ context, classification, env = process.env, client = null }) {
  const openai = client ?? (await createClient(env));
  const instructions = readFileSync(PROMPT_PATH, 'utf8');
  const { zodTextFormat } = await import('openai/helpers/zod');

  const response = await openai.responses.parse({
    model: env.OPENAI_MODEL,
    instructions,
    input: [{ role: 'user', content: buildModelPayload({ context, classification }) }],
    text: { format: zodTextFormat(modelDiagnosisSchema, 'pipeline_diagnosis') },
  });

  if (response.status === 'incomplete') {
    throw new Error(`resposta incompleta: ${response.incomplete_details?.reason ?? 'motivo desconhecido'}`);
  }

  const parsed = response.output_parsed;
  if (!parsed) {
    throw new Error('resposta do modelo sem saída estruturada');
  }

  // Valida de novo do nosso lado: nunca confiar na forma do que veio da rede.
  return modelDiagnosisSchema.parse(parsed);
}

/**
 * Executa a análise ponta a ponta.
 *
 * @param {object} input
 * @param {object} input.source contexto bruto (fixture ou execução real)
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {() => Date} [input.now]
 * @param {object} [input.client] cliente OpenAI injetável (testes)
 * @param {string} [input.requestId]
 * @returns {Promise<{ diagnosis: object, policy: object, context: object, classification: object }>}
 */
export async function analyzePipeline({
  source,
  env = process.env,
  now = () => new Date(),
  client = null,
  requestId,
} = {}) {
  const context = collectContext(source);

  const classification = classifyFailure({
    sources: context.failureSources,
    secretsDetected: context.sensitive.hasSensitiveData,
    hasFailedCommands: context.results.failedCommands.length > 0,
    hasCommands: context.commands.length > 0,
  });

  const evidence = buildEvidenceList({
    matches: classification.matches,
    commands: context.commands,
    diff: context.diff,
    sensitive: context.sensitive,
  });

  const deterministic = buildDeterministicDiagnosis({
    classification,
    evidence,
    failedCommands: context.results.failedCommands,
    limitations: context.limitations,
  });

  let core = deterministic;
  let usedFallback = true;
  let fallbackNote = 'Sem `OPENAI_API_KEY`/`OPENAI_MODEL`: diagnóstico produzido pelo classificador determinístico.';

  if (canUseModel(env)) {
    try {
      const modelDiagnosis = await analyzeWithModel({ context, classification, env, client });
      core = mergeModelDiagnosis({ modelDiagnosis, deterministic, context });
      usedFallback = false;
      fallbackNote = null;
    } catch (error) {
      // Erro de rede, chave inválida, recusa ou saída fora do schema: o agente
      // não pode ficar sem resposta — cai no determinístico.
      fallbackNote = `Falha na análise com modelo (${redactSecrets(String(error.message))}): usado o classificador determinístico.`;
      core = deterministic;
      usedFallback = true;
    }
  }

  const limitations = unique([...core.limitations, ...(fallbackNote ? [fallbackNote] : [])]);

  const policy = applyDeployPolicy({
    diagnosis: { ...core, limitations },
    metadata: context.metadata,
    results: context.results,
    sensitive: context.sensitive,
  });

  const diagnosis = diagnosisSchema.parse(
    redactSecretsDeep({
      analysisId: randomUUID(),
      requestId: requestId ?? env.REQUEST_ID ?? randomUUID(),
      repository: context.metadata.repository,
      branch: context.metadata.branch,
      commitSha: context.metadata.commitSha,
      pipelineStatus: context.results.pipelineStatus,
      summary: core.summary,
      signal: core.signal,
      failureType: core.failureType,
      probableCause: core.probableCause,
      evidence: core.evidence,
      impact: core.impact,
      riskLevel: policy.riskLevel,
      confidence: core.confidence,
      nextSteps: core.nextSteps,
      deployDecision: policy.deployDecision,
      requiresHumanApproval: policy.requiresHumanApproval,
      limitations,
      usedFallback,
      generatedAt: now().toISOString(),
    }),
  );

  return { diagnosis, policy, context, classification };
}

/**
 * Funde a saída do modelo com o que foi observado. O modelo descreve; os fatos
 * (status, segredo detectado, limitações da coleta) continuam vindo do sistema.
 *
 * @param {object} input
 * @returns {object}
 */
export function mergeModelDiagnosis({ modelDiagnosis, deterministic, context }) {
  const model = redactSecretsDeep(modelDiagnosis);
  const limitations = [...model.limitations, ...context.limitations];

  const { evidence, grounded } = groundEvidence(model.evidence, context);
  if (!grounded) {
    limitations.push(
      'Evidências citadas pelo modelo não foram encontradas no material coletado; usadas as evidências do coletor.',
    );
  }

  // Segredo encontrado pelo scanner não é opinião: prevalece sobre o modelo.
  const secretsDetected = context.sensitive.hasSensitiveData;
  const failureType = secretsDetected ? 'security' : model.failureType;
  if (secretsDetected && model.failureType !== 'security') {
    limitations.push(
      'Classificação do modelo sobrescrita para `security`: o scanner encontrou conteúdo sensível.',
    );
  }

  return {
    summary: model.summary,
    signal: model.signal,
    failureType,
    probableCause: model.probableCause,
    evidence: evidence.length > 0 ? evidence : deterministic.evidence,
    impact: model.impact,
    riskLevel: model.riskLevel,
    confidence: model.confidence,
    nextSteps: model.nextSteps,
    limitations: unique(limitations),
  };
}

/**
 * Mantém apenas as evidências cujo trecho existe de fato no material coletado.
 * É o antídoto contra citação inventada.
 *
 * @param {Array<{source: string, excerpt: string}>} evidence
 * @param {object} context
 * @returns {{ evidence: Array<object>, grounded: boolean }}
 */
export function groundEvidence(evidence = [], context) {
  const haystack = normalize(
    context.textSources.map((entry) => entry.content).join('\n'),
  );

  const kept = evidence.filter((item) => {
    const needle = normalize(item.excerpt);
    if (needle.length < 12) return false;
    return haystack.includes(needle);
  });

  return { evidence: kept, grounded: kept.length > 0 };
}

/**
 * Grava `reports/diagnosis.json` e `reports/diagnosis.md`.
 *
 * @param {object} input
 * @returns {{ jsonPath: string, markdownPath: string, markdown: string }}
 */
export function writeReports({ diagnosis, policy, outDir = join(REPO_ROOT, 'reports') }) {
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, 'diagnosis.json');
  const markdownPath = join(outDir, 'diagnosis.md');
  const markdown = renderMarkdown(diagnosis, { policyReasons: policy?.reasons ?? [] });

  writeFileSync(jsonPath, `${JSON.stringify(diagnosis, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, markdown, 'utf8');

  return { jsonPath, markdownPath, markdown };
}

/**
 * Coleta o contexto de uma execução real: metadados do ambiente de CI (ou do
 * git local), logs dos comandos do pipeline e o diff do working tree.
 *
 * @param {object} [input]
 * @returns {{ pipeline: object, commands: Array<object>, diff: object }}
 */
export function collectLiveSource({ env = process.env, exec = true, cwd = REPO_ROOT } = {}) {
  const commandLines = (env.AGENT_PIPELINE_COMMANDS ?? '')
    .split(',')
    .map((line) => line.trim())
    .filter(Boolean);

  const plan = commandLines.length > 0 ? commandLines : DEFAULT_COMMANDS;

  const commands = plan.map((command) => {
    if (!exec) {
      return { name: commandName(command), command, exitCode: null, log: '' };
    }

    const started = Date.now();
    const result = spawnSync(command, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });

    return {
      name: commandName(command),
      command,
      exitCode: result.status ?? 1,
      durationMs: Date.now() - started,
      log: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  });

  const patch = readWorkingTreeDiff(cwd, env);

  return {
    pipeline: {
      repository: env.GITHUB_REPOSITORY ?? gitRemoteSlug(cwd),
      branch: env.GITHUB_REF_NAME ?? git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      commitSha: env.GITHUB_SHA ?? git(cwd, ['rev-parse', 'HEAD']),
      environment: env.DEPLOY_ENVIRONMENT ?? 'staging',
      trigger: env.GITHUB_EVENT_NAME ?? 'local',
      isRollback: env.DEPLOY_ROLLBACK === 'true',
      pullRequestNumber: env.PR_NUMBER ? Number(env.PR_NUMBER) : null,
      workflow: env.GITHUB_WORKFLOW ?? 'ci',
      runId: env.GITHUB_RUN_ID ?? null,
    },
    commands,
    diff: { files: diffFiles(patch), patch },
  };
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const options = {
    fixture: null,
    environment: null,
    rollback: false,
    exec: true,
    outDir: null,
    comment: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--fixture') options.fixture = argv[index + 1] ?? null;
    else if (arg === '--environment') options.environment = argv[index + 1] ?? null;
    else if (arg === '--out') options.outDir = argv[index + 1] ?? null;
    else if (arg === '--rollback') options.rollback = true;
    else if (arg === '--no-exec') options.exec = false;
    else if (arg === '--comment') options.comment = true;
  }

  return options;
}

async function main() {
  dotenv.config({
    path: [join(AUTOMATION_ROOT, '.env'), join(REPO_ROOT, '.env')],
    quiet: true,
  });

  const options = parseArgs(process.argv.slice(2));

  let source;
  if (options.fixture) {
    const overrides = {};
    if (options.environment) overrides.environment = options.environment;
    if (options.rollback) overrides.isRollback = true;

    source =
      options.fixture === 'success'
        ? simulateSuccess(overrides)
        : simulateFailure(options.fixture, overrides);
  } else {
    source = collectLiveSource({ exec: options.exec });
    if (options.environment) source.pipeline.environment = options.environment;
    if (options.rollback) source.pipeline.isRollback = true;
  }

  const { diagnosis, policy } = await analyzePipeline({ source });
  const outDir = options.outDir ? resolve(options.outDir) : join(REPO_ROOT, 'reports');
  const { jsonPath, markdownPath } = writeReports({ diagnosis, policy, outDir });

  if (options.comment) {
    const result = await upsertPullRequestComment({
      diagnosis,
      repository: diagnosis.repository,
      pullRequestNumber: source.pipeline.pullRequestNumber,
      token: process.env.GITHUB_TOKEN,
      dryRun: !isPullRequestCommentEnabled(process.env),
      outFile: join(outDir, 'pr-comment.md'),
    });
    process.stdout.write(`[pipeline-guardian] comentário de PR: ${result.action} — ${result.reason ?? result.url}\n`);
  }

  const lines = [
    '',
    `  status .......... ${diagnosis.pipelineStatus}`,
    `  tipo ............ ${diagnosis.failureType}`,
    `  sinal ........... ${diagnosis.signal}`,
    `  risco ........... ${diagnosis.riskLevel}`,
    `  confiança ....... ${diagnosis.confidence}`,
    `  decisão ......... ${diagnosis.deployDecision}`,
    `  aprovação ....... ${diagnosis.requiresHumanApproval ? 'humana necessária' : 'não necessária'}`,
    `  fallback ........ ${diagnosis.usedFallback}`,
    '',
    '  política:',
    ...policy.reasons.map((reason) => `    - ${reason}`),
    '',
    `  JSON ............ ${jsonPath}`,
    `  Markdown ........ ${markdownPath}`,
    '',
  ];

  process.stdout.write(`[pipeline-guardian] diagnóstico gerado\n${lines.join('\n')}`);

  // Pipeline vermelho ou promoção bloqueada não devem "passar" silenciosamente.
  if (diagnosis.deployDecision === 'blocked') process.exitCode = 1;
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

async function createClient(env) {
  const { default: OpenAI } = await import('openai');
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    timeout: Number(env.OPENAI_TIMEOUT_MS ?? DEFAULT_MODEL_TIMEOUT_MS),
    maxRetries: 1,
  });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalize(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function commandName(command) {
  return command.replace(/^npm run /, '').split(' ')[0];
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function gitRemoteSlug(cwd) {
  const url = git(cwd, ['config', '--get', 'remote.origin.url']);
  const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : 'local/copa-figurinhas';
}

function readWorkingTreeDiff(cwd, env) {
  const base = env.AGENT_DIFF_BASE ?? 'HEAD';
  const working = git(cwd, ['diff', '--no-color', base]);
  if (working && working !== 'unknown') return working;

  const previous = git(cwd, ['diff', '--no-color', 'HEAD~1', 'HEAD']);
  return previous === 'unknown' ? '' : previous;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[pipeline-guardian] erro: ${redactSecrets(String(error.stack ?? error.message))}\n`);
    process.exitCode = 1;
  });
}

export { SCENARIOS, REPO_ROOT };
