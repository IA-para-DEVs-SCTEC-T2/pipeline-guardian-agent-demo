/**
 * Diagnóstico inteligente da validação pós-deployment.
 *
 * Mesmo agente, outro material: onde o Pipeline Guardian lê logs de `lint`,
 * `test` e `build`, este módulo lê o log do smoke test executado contra a
 * aplicação já publicada.
 *
 * Ele **reusa** a infraestrutura existente em vez de recriá-la — sanitização
 * (`sanitize-log`), redação (`redact-secrets`), redução de log
 * (`selectRelevantLines`), ancoragem de evidências (`ground-evidence`),
 * validação por Zod e o padrão de degradação do agente. O que é novo aqui é o
 * vocabulário do domínio: `healthcheck`, `startup`, `environment`, `network`,
 * `deployment`.
 *
 * As três invariantes do projeto continuam valendo:
 *
 *   1. O modelo NÃO decide se o deployment passou. `status` vem do smoke test
 *      (códigos HTTP, exit code) e sequer é exposto ao modelo.
 *   2. Nada circula sem máscara. O log é mascarado antes de ir ao modelo, ao
 *      disco e ao Job Summary.
 *   3. Evidência citada que não existe no log é descartada e vira limitação.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import {
  deploymentDiagnosisSchema,
  modelDeploymentDiagnosisSchema,
} from '../schemas/deployment-diagnosis-schema.mjs';
import { scanForSensitiveData, selectRelevantLines } from './collect-context.mjs';
import {
  buildDeterministicDeploymentDiagnosis,
  classifyDeployment,
} from './deployment-classifier.mjs';
import { groundEvidenceAgainst } from './ground-evidence.mjs';
import { callStructuredModel, classifyModelError, createOpenAIClient } from './openai-client.mjs';
import {
  PAYLOAD_LIMITS,
  TRUNCATION_LIMITATION,
  canUseModel,
  capText,
  emptyModelCallMetadata,
  resolveOpenAIConfig,
} from './openai-config.mjs';
import { redactSecrets, redactSecretsDeep } from './redact-secrets.mjs';
import { renderDeploymentDiagnosis } from './render-deployment-diagnosis.mjs';
import { sanitizeLog } from './sanitize-log.mjs';
import { VERDICT_PREFIX } from './smoke-test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(AUTOMATION_ROOT, '..');
const PROMPT_PATH = join(AUTOMATION_ROOT, 'prompts', 'deployment-analysis.md');

const MAX_LOG_LINES = 120;
const MAX_EVIDENCE_ITEMS = 5;
const MAX_EXCERPT_LENGTH = 240;

/** Linha que o smoke test grava no fim do log. */
const VERDICT_PATTERN = new RegExp(`^${VERDICT_PREFIX}\\s*(PASS|FAIL)\\b`, 'm');

// A regra de "pode usar o modelo?" é a mesma dos dois agentes e vive em
// `openai-config.mjs`. Reexportada aqui para quem já importava daqui.
export { canUseModel };

/**
 * De onde vem o `status` TÉCNICO, em ordem de precedência:
 *
 *   1. valor explícito (`--status`), usado nas fixtures da aula;
 *   2. `reports/smoke-test.json`, escrito pelo próprio smoke test;
 *   3. a linha `SMOKE TEST RESULT:` no fim do log;
 *   4. nada disso → `failure`, com a limitação declarada.
 *
 * O passo 4 é fail-closed de propósito: não saber se o deployment passou não
 * pode ser reportado como sucesso.
 *
 * @param {object} input
 * @returns {{ status: 'success'|'failure', source: string, limitation: string|null }}
 */
export function readTechnicalStatus({ explicit = null, resultFile = null, log = '' } = {}) {
  if (explicit === 'success' || explicit === 'failure') {
    return { status: explicit, source: 'parâmetro explícito', limitation: null };
  }

  if (resultFile && existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
      if (parsed.status === 'success' || parsed.status === 'failure') {
        return { status: parsed.status, source: 'resultado do smoke test', limitation: null };
      }
    } catch {
      // Arquivo ilegível ou corrompido: cai para o log, sem derrubar o agente.
    }
  }

  const verdict = log.match(VERDICT_PATTERN);
  if (verdict) {
    return {
      status: verdict[1] === 'PASS' ? 'success' : 'failure',
      source: 'linha de veredito no log',
      limitation: null,
    };
  }

  return {
    status: 'failure',
    source: 'nenhuma origem confiável',
    limitation:
      'O resultado técnico do smoke test não foi encontrado (sem `smoke-test.json` e sem linha ' +
      `\`${VERDICT_PREFIX}\` no log). Assumido \`failure\`: não confirmar sucesso é mais seguro que presumi-lo.`,
  };
}

/**
 * Prepara o material para análise: sanitiza, escaneia segredos no conteúdo
 * ORIGINAL, mascara e reduz aos trechos relevantes.
 *
 * A partir do retorno desta função, só conteúdo mascarado circula.
 *
 * @param {object} input
 * @returns {object} contexto do deployment
 */
export function collectDeploymentContext({ log = '', status = 'failure', metadata = {} } = {}) {
  const rawLog = sanitizeLog(log);
  const limitations = [];

  // Detecção sobre o conteúdo original; tudo o que sai daqui já vai mascarado.
  const sensitive = scanForSensitiveData([{ source: 'log:deployment', content: rawLog }]);
  if (sensitive.hasSensitiveData) {
    limitations.push(
      'Conteúdo sensível foi detectado no log da validação e mascarado antes de qualquer análise. ' +
        'Revise a origem: um segredo não deveria aparecer em log de deployment.',
    );
  }

  const { text, truncated } = selectRelevantLines(rawLog, MAX_LOG_LINES);
  const maskedLog = redactSecrets(text);

  if (truncated) {
    limitations.push('Log longo reduzido aos trechos relevantes (início, linhas com erro e final).');
  }
  if (rawLog.trim().length === 0) {
    limitations.push('Nenhum log de validação foi coletado.');
  }

  // A limitação estrutural do material — vale para TODA execução, verde ou
  // vermelha, e é a diferença entre "sintoma observado" e "causa comprovada".
  limitations.push(
    'Os logs analisados são do smoke test, executado de fora da aplicação: eles não incluem o ' +
      'log interno da plataforma de deployment (Railway).',
  );

  return {
    metadata: {
      repository: redactSecrets(metadata.repository ?? 'unknown/unknown'),
      commitSha: redactSecrets(metadata.commitSha ?? 'unknown'),
      targetHost: redactSecrets(metadata.targetHost ?? 'unknown'),
    },
    status,
    log: maskedLog,
    truncated,
    sensitive,
    textSources: [{ source: 'log:deployment', content: maskedLog }],
    limitations,
  };
}

/**
 * Monta as evidências a partir do que foi observado — trechos reais do log,
 * com a linha de onde vieram.
 *
 * @param {object} input
 * @returns {Array<{ source: string, excerpt: string }>}
 */
export function buildDeploymentEvidence({ classification, context }) {
  const evidence = [];
  const seen = new Set();

  const push = (source, excerpt) => {
    const clean = redactSecrets(String(excerpt).trim()).slice(0, MAX_EXCERPT_LENGTH);
    const key = `${source}::${clean}`;
    if (!clean || seen.has(key) || evidence.length >= MAX_EVIDENCE_ITEMS) return;
    seen.add(key);
    evidence.push({ source, excerpt: clean });
  };

  if (context.sensitive?.hasSensitiveData) {
    for (const finding of context.sensitive.findings) {
      push(
        `scanner:${finding.source}`,
        `Conteúdo sensível detectado (regra ${finding.rule}, ${finding.count} ocorrência(s)); valor mascarado.`,
      );
    }
  }

  for (const match of classification.matches) {
    push(`log:deployment:${match.line}`, match.excerpt);
  }

  // O veredito e o resumo final do smoke test sempre valem como evidência:
  // são a linha que sustenta o `status`.
  for (const line of context.log.split('\n')) {
    if (/smoke-test: health=|health check: (?:aprovado|reprovado)|rota funcional: (?:aprovado|reprovado)/.test(line)) {
      push('log:deployment', line.trim());
    }
  }

  return evidence;
}

/**
 * Payload enviado ao modelo: já mascarado, restrito ao necessário e limitado em
 * tamanho.
 *
 * @param {object} input
 * @returns {{ payload: string, limitations: string[] }}
 */
export function buildDeploymentModelRequest({ context, classification }) {
  const limitations = [];

  const log = capText(context.log, PAYLOAD_LIMITS.maxLogChars);
  if (log.truncated) limitations.push(TRUNCATION_LIMITATION);

  const payload = {
    deployment: {
      repository: context.metadata.repository,
      commitSha: context.metadata.commitSha,
      targetHost: context.metadata.targetHost,
      stage: 'post_deployment_validation',
      // Fato, não opinião: o modelo recebe isto para descrever, não para revisar.
      technicalStatus: context.status,
    },
    smokeTestLog: log.text,
    deterministicClassifier: {
      failureType: classification.failureType,
      confidence: classification.confidence,
      ambiguous: classification.ambiguous,
      note: 'Sinal auxiliar por padrões de log. Discorde dele se as evidências indicarem outra coisa.',
    },
    collectedLimitations: context.limitations,
  };

  const serialized = redactSecrets(JSON.stringify(payload, null, 2));
  const capped = capText(serialized, PAYLOAD_LIMITS.maxTotalChars);
  if (capped.truncated) limitations.push(TRUNCATION_LIMITATION);

  return { payload: capped.text, limitations: unique(limitations) };
}

/**
 * Só o texto do payload. Mantida para quem já usava esta forma.
 *
 * @param {object} input
 * @returns {string} JSON
 */
export function buildDeploymentModelPayload({ context, classification }) {
  return buildDeploymentModelRequest({ context, classification }).payload;
}

/**
 * Chama a Responses API com saída estruturada validada por Zod.
 *
 * @param {object} input
 * @returns {Promise<{ modelDiagnosis: object, metadata: object, limitations: string[] }>}
 */
export async function analyzeWithModel({
  context,
  classification,
  env = process.env,
  client = null,
  config = null,
}) {
  const resolved = config ?? resolveOpenAIConfig(env);
  const openai = client ?? (await createOpenAIClient({ env, config: resolved }));
  const { payload, limitations } = buildDeploymentModelRequest({ context, classification });

  const { parsed, metadata } = await callStructuredModel({
    client: openai,
    config: resolved,
    instructions: readFileSync(PROMPT_PATH, 'utf8'),
    input: payload,
    schema: modelDeploymentDiagnosisSchema,
    schemaName: 'deployment_diagnosis',
  });

  return { modelDiagnosis: parsed, metadata, limitations };
}

/**
 * Funde a saída do modelo com o que foi observado. O modelo descreve; os fatos
 * (status técnico, evidência ancorada, limitações da coleta) continuam do
 * sistema.
 *
 * @param {object} input
 * @returns {object}
 */
export function mergeModelDeploymentDiagnosis({ modelDiagnosis, deterministic, context }) {
  const model = redactSecretsDeep(modelDiagnosis);
  const limitations = [...model.limitations, ...context.limitations];

  const { evidence, grounded } = groundEvidenceAgainst(model.evidence, context.textSources);
  if (!grounded) {
    limitations.push(
      'Evidências citadas pelo modelo não foram encontradas no log coletado; usadas as evidências do coletor.',
    );
  }

  // O status é fato: `success` não admite tipo de falha, `failure` não admite
  // `success`. Se o modelo discordar, o fato prevalece e a divergência aparece.
  let failureType = model.failureType;
  if (context.status === 'success' && failureType !== 'success') {
    limitations.push(
      `Classificação do modelo (\`${failureType}\`) descartada: o smoke test aprovou a validação.`,
    );
    failureType = 'success';
  }
  if (context.status === 'failure' && failureType === 'success') {
    limitations.push(
      'Classificação do modelo (`success`) descartada: o smoke test reprovou a validação.',
    );
    failureType = deterministic.failureType;
  }

  return {
    summary: model.summary,
    failureType,
    evidence: evidence.length > 0 ? evidence : deterministic.evidence,
    probableCause: model.probableCause,
    confidence: model.confidence,
    nextSteps: model.nextSteps,
    limitations: unique(limitations),
  };
}

/**
 * Análise ponta a ponta do pós-deployment.
 *
 * @param {object} input
 * @param {string} input.log log do smoke test
 * @param {'success'|'failure'} input.status resultado técnico
 * @param {object} [input.metadata]
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {object} [input.client] cliente OpenAI injetável (testes)
 * @returns {Promise<{ diagnosis: object, context: object, classification: object }>}
 */
export async function analyzeDeployment({
  log = '',
  status = 'failure',
  metadata = {},
  env = process.env,
  now = () => new Date(),
  client = null,
  requestId,
  extraLimitations = [],
} = {}) {
  const context = collectDeploymentContext({ log, status, metadata });
  context.limitations = unique([...context.limitations, ...extraLimitations]);

  const classification = classifyDeployment({ log: context.log, status });
  const evidence = buildDeploymentEvidence({ classification, context });

  const deterministic = buildDeterministicDeploymentDiagnosis({
    classification,
    evidence,
    limitations: context.limitations,
  });

  const config = resolveOpenAIConfig(env);

  let core = deterministic;
  let usedFallback = true;
  let modelCall = emptyModelCallMetadata(config);
  let fallbackNote = 'Sem `OPENAI_API_KEY`: diagnóstico produzido pelo classificador determinístico.';
  let payloadLimitations = [];

  if (config.enabled) {
    try {
      const result = await analyzeWithModel({ context, classification, env, client, config });
      core = mergeModelDeploymentDiagnosis({
        modelDiagnosis: result.modelDiagnosis,
        deterministic,
        context,
      });
      payloadLimitations = result.limitations;
      modelCall = result.metadata;
      usedFallback = false;
      fallbackNote = null;
    } catch (error) {
      // Erro de rede, chave inválida, timeout, recusa ou saída fora do schema:
      // a falha do modelo não pode esconder a falha do deployment. Só a
      // categoria é publicada; a mensagem bruta do SDK, nunca.
      const category = classifyModelError(error);
      fallbackNote =
        `Falha na análise com modelo (categoria: \`${category}\`): a análise com o modelo não ` +
        'foi concluída; foi utilizado o classificador determinístico.';
      modelCall = emptyModelCallMetadata(config, category);
      core = deterministic;
      usedFallback = true;
    }
  }

  const limitations = unique([
    ...core.limitations,
    ...payloadLimitations,
    ...config.notes,
    ...(fallbackNote ? [fallbackNote] : []),
  ]);

  const diagnosis = deploymentDiagnosisSchema.parse(
    redactSecretsDeep({
      analysisId: randomUUID(),
      requestId: requestId ?? env.REQUEST_ID ?? randomUUID(),
      repository: context.metadata.repository,
      commitSha: context.metadata.commitSha,
      targetHost: context.metadata.targetHost,

      stage: 'post_deployment_validation',
      status,
      failureType: core.failureType,
      summary: core.summary,
      evidence: core.evidence,
      probableCause: core.probableCause,
      confidence: core.confidence,
      nextSteps: core.nextSteps,
      limitations,
      usedFallback,
      ...modelCall,
      generatedAt: now().toISOString(),
    }),
  );

  return { diagnosis, context, classification };
}

/**
 * Grava `deployment-diagnosis.json` e `deployment-diagnosis.md`.
 *
 * @param {object} input
 * @returns {{ jsonPath: string, markdownPath: string, markdown: string }}
 */
export function writeDeploymentReports({ diagnosis, outDir = join(REPO_ROOT, 'reports') }) {
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, 'deployment-diagnosis.json');
  const markdownPath = join(outDir, 'deployment-diagnosis.md');
  const markdown = renderDeploymentDiagnosis(diagnosis);

  writeFileSync(jsonPath, `${JSON.stringify(diagnosis, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, markdown, 'utf8');

  return { jsonPath, markdownPath, markdown };
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * @param {string[]} argv
 * @returns {{ logFile: string|null, resultFile: string|null, status: string|null, outDir: string|null }}
 */
export function parseArgs(argv) {
  const options = { logFile: null, resultFile: null, status: null, outDir: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--log') options.logFile = argv[index + 1] ?? null;
    else if (arg === '--result') options.resultFile = argv[index + 1] ?? null;
    else if (arg === '--status') options.status = argv[index + 1] ?? null;
    else if (arg === '--out') options.outDir = argv[index + 1] ?? null;
  }

  return options;
}

async function main() {
  dotenv.config({ path: [join(AUTOMATION_ROOT, '.env'), join(REPO_ROOT, '.env')], quiet: true });

  const env = process.env;
  const options = parseArgs(process.argv.slice(2));

  const logFile = resolve(options.logFile ?? env.DEPLOYMENT_LOG_FILE ?? join(REPO_ROOT, 'reports', 'deployment.log'));
  const resultFile = resolve(
    options.resultFile ?? env.SMOKE_RESULT_FILE ?? join(REPO_ROOT, 'reports', 'smoke-test.json'),
  );
  const outDir = resolve(options.outDir ?? env.CI_OUTPUT_DIR ?? join(REPO_ROOT, 'reports'));

  const extraLimitations = [];
  let log = '';

  if (existsSync(logFile)) {
    log = readFileSync(logFile, 'utf8');
  } else {
    extraLimitations.push(`Arquivo de log não encontrado: \`${logFile}\`.`);
  }

  const technical = readTechnicalStatus({ explicit: options.status, resultFile, log });
  if (technical.limitation) extraLimitations.push(technical.limitation);

  const { diagnosis } = await analyzeDeployment({
    log,
    status: technical.status,
    metadata: {
      repository: env.GITHUB_REPOSITORY,
      commitSha: env.GITHUB_SHA,
      targetHost: readTargetHost({ resultFile, env }),
    },
    env,
    extraLimitations,
  });

  const { jsonPath, markdownPath } = writeDeploymentReports({ diagnosis, outDir });

  process.stdout.write(
    '[deployment-guardian] diagnóstico gerado\n' +
      `  status .......... ${diagnosis.status} (${technical.source})\n` +
      `  tipo ............ ${diagnosis.failureType}\n` +
      `  confiança ....... ${diagnosis.confidence}\n` +
      `  fallback ........ ${diagnosis.usedFallback}\n` +
      `  modelo .......... ${diagnosis.model ?? 'n/d'}` +
      `${diagnosis.modelErrorCategory ? ` (falha: ${diagnosis.modelErrorCategory})` : ''}\n` +
      `  latência ........ ${diagnosis.modelLatencyMs === null || diagnosis.modelLatencyMs === undefined ? 'n/d' : `${diagnosis.modelLatencyMs} ms`}\n` +
      `  tokens .......... ${diagnosis.modelUsage?.totalTokens ?? 'n/d'}\n` +
      `  JSON ............ ${jsonPath}\n` +
      `  Markdown ........ ${markdownPath}\n\n` +
      '  O diagnóstico é INFORMATIVO. Quem reprova o deployment é o smoke test.\n',
  );

  // Exit code 0 sempre: o gate técnico é o smoke test, não este script. Uma
  // falha de análise não pode reprovar um deployment saudável — nem esconder um
  // deployment quebrado, que já falhou antes de chegar aqui.
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function readTargetHost({ resultFile, env }) {
  if (existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
      if (parsed.targetHost) return parsed.targetHost;
    } catch {
      // Segue para a URL do ambiente.
    }
  }

  const base = (env.APP_BASE_URL ?? '').trim();
  if (!base) return 'unknown';

  try {
    return new URL(base).host;
  } catch {
    return 'unknown';
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `[deployment-guardian] erro: ${redactSecrets(String(error.stack ?? error.message))}\n`,
    );
    process.exitCode = 1;
  });
}
