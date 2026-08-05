/**
 * O laboratório do Dia 2, ponta a ponta.
 *
 * Dois modos, um caminho de observação:
 *
 *   --baseline   observa e grava `reports/day-2/baseline.json`
 *   (sem flag)   observa, compara com a baseline, explica e publica o painel
 *
 * O modo de comparação é o `npm run day2:check`, e ele observa a aplicação **como
 * ela está** — sem ativar cenário, sem injetar atraso, sem variável especial. O
 * laboratório mede o que existe; provocar a anomalia é um passo separado e
 * deliberado, não um efeito colateral de rodar a verificação.
 *
 * Três decisões que valem para quem for evoluir:
 *
 * 1. **A observação e a decisão são funções distintas e injetáveis.** `runCheck`
 *    recebe `observe` como parâmetro. É o que permite testar a política inteira —
 *    detecção, explicação, relatório — sem subir processo, sem abrir porta e sem
 *    depender do relógio.
 * 2. **O processo sai com 0 por padrão, mesmo com anomalia.** Reprovar o terminal
 *    de quem está apresentando a aula não ajuda ninguém, e o Dia 2 não está
 *    ligado a nenhum workflow. Quem quiser o gate como código de saída pede:
 *    `--fail-on-anomaly`. Opt-in explícito, como o resto do repositório.
 * 3. **Sem baseline não há comparação — e isso é erro, não `unknown`.** Inventar
 *    uma baseline a partir da própria execução observada faria toda execução
 *    parecer normal, que é exatamente o pior modo de falhar de um detector.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { redactSecrets } from '../redact-secrets.mjs';
import { detectAnomalies } from './detect.mjs';
import { buildAnomalyEvidence, explainAnomaly } from './explain.mjs';
import { observeApplication, DEFAULT_MEASURED_REQUESTS, DEFAULT_PORT, DEFAULT_WARMUP_REQUESTS } from './observe.mjs';
import {
  DAY2_REPORT_DIR,
  baselineSchema,
  buildAnomalyReport,
  writeAnomalyReports,
  writeBaseline,
} from './report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = resolve(HERE, '..', '..');
export const REPO_ROOT = resolve(AUTOMATION_ROOT, '..');

export const BASELINE_PATH = join(DAY2_REPORT_DIR, 'baseline.json');

/**
 * @param {string[]} argv
 * @returns {{ mode: 'baseline'|'check', port: number, requests: number, warmup: number, outDir: string|null, baselinePath: string|null, failOnAnomaly: boolean }}
 */
export function parseArgs(argv = []) {
  const options = {
    mode: 'check',
    port: DEFAULT_PORT,
    requests: DEFAULT_MEASURED_REQUESTS,
    warmup: DEFAULT_WARMUP_REQUESTS,
    outDir: null,
    baselinePath: null,
    failOnAnomaly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--baseline') options.mode = 'baseline';
    else if (arg === '--fail-on-anomaly') options.failOnAnomaly = true;
    else if (arg === '--port') options.port = Number(argv[index + 1]) || DEFAULT_PORT;
    else if (arg === '--requests') options.requests = Number(argv[index + 1]) || DEFAULT_MEASURED_REQUESTS;
    else if (arg === '--warmup') options.warmup = Number(argv[index + 1]) || DEFAULT_WARMUP_REQUESTS;
    else if (arg === '--out') options.outDir = argv[index + 1] ?? null;
    else if (arg === '--baseline-file') options.baselinePath = argv[index + 1] ?? null;
  }

  return options;
}

/**
 * Lê e valida a baseline.
 *
 * Falha alto e com instrução: a mensagem diz o comando que resolve. Um erro de
 * schema cru mandaria quem está na aula abrir o arquivo para descobrir que ele
 * simplesmente não existe.
 *
 * @param {string} [path]
 * @returns {object} baseline validada
 */
export function readBaseline(path = BASELINE_PATH) {
  if (!existsSync(path)) {
    throw new Error(
      `baseline não encontrada em \`${path}\`. Gere-a antes da verificação: \`npm run day2:baseline\`.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`baseline ilegível em \`${path}\`: o arquivo não é JSON válido. Regere com \`npm run day2:baseline\`.`);
  }

  const result = baselineSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `baseline em \`${path}\` não tem o formato esperado (faltam ou estão inválidos os quatro sinais). ` +
        'Regere com `npm run day2:baseline`.',
    );
  }

  return result.data;
}

/**
 * Modo `--baseline`: observa e grava a referência.
 *
 * @param {object} [input]
 * @returns {Promise<{ baseline: object, path: string, observation: object }>}
 */
export async function runBaseline({
  port = DEFAULT_PORT,
  measuredRequests = DEFAULT_MEASURED_REQUESTS,
  warmupRequests = DEFAULT_WARMUP_REQUESTS,
  outDir = DAY2_REPORT_DIR,
  observe = observeApplication,
  commitSha = null,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const observation = await observe({ port, measuredRequests, warmupRequests });
  const { baseline, path } = writeBaseline({
    summary: observation.summary,
    commitSha: commitSha ?? resolveCommitSha(env),
    outDir,
    now,
  });

  return { baseline, path, observation };
}

/**
 * Modo padrão: observa, compara, explica e publica.
 *
 * @param {object} [input]
 * @returns {Promise<{ report: object, paths: object, detection: object }>}
 */
export async function runCheck({
  port = DEFAULT_PORT,
  measuredRequests = DEFAULT_MEASURED_REQUESTS,
  warmupRequests = DEFAULT_WARMUP_REQUESTS,
  outDir = DAY2_REPORT_DIR,
  baselinePath = BASELINE_PATH,
  baseline = null,
  observe = observeApplication,
  explain = explainAnomaly,
  client = null,
  commitSha = null,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const reference = baseline ?? readBaseline(baselinePath);
  const observation = await observe({ port, measuredRequests, warmupRequests });

  // Determinístico primeiro. O veredito existe antes de a IA ser consultada — e
  // é essa ordem que torna impossível o modelo influenciá-lo.
  const detection = detectAnomalies(reference, observation.summary);

  const evidence = buildAnomalyEvidence({
    logEvents: observation.logEvents,
    samples: observation.samples,
  });

  const { explanation, usedFallback, modelCall, fallbackNote } = await explain({
    baseline: reference,
    observed: observation.summary,
    detection,
    evidence,
    observationLimitations: observation.limitations,
    env,
    client,
  });

  const report = buildAnomalyReport({
    observation,
    baseline: reference,
    detection,
    evidence,
    explanation,
    usedFallback,
    modelCall,
    fallbackNote,
    commitSha: commitSha ?? resolveCommitSha(env),
    now,
  });

  const paths = writeAnomalyReports({ report, outDir });

  return { report, paths, detection };
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

async function main() {
  dotenv.config({ path: [join(AUTOMATION_ROOT, '.env'), join(REPO_ROOT, '.env')], quiet: true });

  const options = parseArgs(process.argv.slice(2));
  const outDir = options.outDir ? resolve(options.outDir) : DAY2_REPORT_DIR;

  if (options.mode === 'baseline') {
    const { baseline, path } = await runBaseline({
      port: options.port,
      measuredRequests: options.requests,
      warmupRequests: options.warmup,
      outDir,
    });

    process.stdout.write(
      '[day-2] baseline gravada\n' +
        `  amostras ................ ${baseline.sampleCount}\n` +
        `  latencyP95Ms ............ ${baseline.latencyP95Ms}\n` +
        `  errorRate ............... ${baseline.errorRate}\n` +
        `  logLinesPerRequest ...... ${baseline.logLinesPerRequest}\n` +
        `  responseSizeP95Bytes .... ${baseline.responseSizeP95Bytes}\n` +
        `  arquivo ................. ${path}\n\n` +
        '  Colete a baseline com a aplicação saudável. Ela é a referência de tudo o que vem depois.\n',
    );
    return;
  }

  const { report, paths, detection } = await runCheck({
    port: options.port,
    measuredRequests: options.requests,
    warmupRequests: options.warmup,
    outDir,
    baselinePath: options.baselinePath ? resolve(options.baselinePath) : BASELINE_PATH,
  });

  process.stdout.write(
    `[day-2] ${detection.anomalyDetected ? 'ANOMALIA DETECTADA' : 'NORMAL'}\n` +
      `  gate .................... ${detection.gateResult}\n` +
      `  tipos ................... ${detection.anomalyTypes.length > 0 ? detection.anomalyTypes.join(', ') : '—'}\n` +
      `  primeiro sinal .......... ${detection.firstAnomalousSignal ?? '—'}\n` +
      `  latencyP95Ms ............ ${report.baseline.latencyP95Ms} → ${report.observed.latencyP95Ms}\n` +
      `  errorRate ............... ${report.baseline.errorRate} → ${report.observed.errorRate}\n` +
      `  logLinesPerRequest ...... ${report.baseline.logLinesPerRequest} → ${report.observed.logLinesPerRequest}\n` +
      `  responseSizeP95Bytes .... ${report.baseline.responseSizeP95Bytes} → ${report.observed.responseSizeP95Bytes}\n` +
      `  explicação .............. ${report.usedFallback ? 'gerador determinístico' : `modelo (${report.model})`}\n` +
      `  JSON .................... ${paths.jsonPath}\n` +
      `  Markdown ................ ${paths.markdownPath}\n` +
      `  Painel HTML ............. ${paths.htmlPath}\n\n` +
      '  O detector é determinístico. O modelo explica o resultado; ele não o decide.\n',
  );

  // Ver decisão 2 no cabeçalho.
  if (options.failOnAnomaly && detection.anomalyDetected) process.exitCode = 1;
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * O commit em análise.
 *
 * Ordem: ambiente (CI já sabe), depois `git`, depois `unknown`. O `git` roda com
 * `execFileSync` e argumentos em array — nunca por shell, que é onde um nome de
 * diretório criativo viraria execução de comando.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveCommitSha(env = process.env) {
  const fromEnv = (env.GITHUB_SHA || env.COMMIT_SHA || '').trim();
  if (fromEnv.length > 0) return fromEnv;

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    // Sem git, fora de repositório, ou `git` ausente na imagem: não é motivo
    // para não haver relatório.
    return 'unknown';
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[day-2] erro: ${redactSecrets(String(error?.message ?? error))}\n`);
    process.exitCode = 1;
  });
}
