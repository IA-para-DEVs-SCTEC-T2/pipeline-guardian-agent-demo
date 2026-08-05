/**
 * Os cenários provocados do Dia 2 — `npm run day2:scenario -- <modo>`.
 *
 * O `day2:check` observa a aplicação **como ela está**. Este comando observa a
 * aplicação **como ele pediu que ela ficasse**: sobe o backend com
 * `DEMO_ANOMALY_MODE=<modo>`, mede as mesmas trinta requisições, compara com a
 * mesma baseline e publica o mesmo painel. A diferença começa e termina na
 * variável de ambiente entregue ao processo filho.
 *
 * Três decisões que valem para quem for evoluir:
 *
 * 1. **O cenário não tem detector, relatório nem painel próprios.** Ele injeta
 *    `env` na observação e delega tudo o mais a `runCheck`. Um caminho paralelo
 *    seria uma segunda implementação da mesma política — e a primeira divergência
 *    entre as duas apareceria como "no laboratório deu anomalia, na verificação
 *    não", que é o pior lugar para uma divergência aparecer.
 * 2. **A variável vive do lado de cá, não do lado de lá.** Quem liga o cenário é
 *    este arquivo, no `env` do `spawn`; o backend só sabe ler
 *    `DEMO_ANOMALY_MODE`. É por isso que rodar `npm start` na mão nunca produz
 *    atraso: não existe padrão ligado em lugar nenhum.
 * 3. **Só o que está implementado no backend.** `SCENARIOS` tem exatamente as
 *    entradas que `backend/src/demo-anomalies.js` sabe provocar. Modo
 *    desconhecido falha alto, listando o que existe, em vez de rodar o
 *    laboratório sem anomalia alguma e deixar a aula concluir que o detector não
 *    funciona.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { redactSecrets } from '../redact-secrets.mjs';
import { DEFAULT_MEASURED_REQUESTS, DEFAULT_PORT, DEFAULT_WARMUP_REQUESTS, observeApplication } from './observe.mjs';
import { DAY2_REPORT_DIR } from './report.mjs';
import { BASELINE_PATH, REPO_ROOT, runCheck } from './run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = resolve(HERE, '..', '..');

/** A variável lida pelo `backend/src/demo-anomalies.js`. Um nome, um lugar. */
export const DEMO_ANOMALY_ENV_VAR = 'DEMO_ANOMALY_MODE';

/**
 * Os cenários disponíveis.
 *
 * `expectedSignal` não é usado para decidir nada — o veredito continua sendo o
 * do detector. Ele serve para o comando dizer, no fim, se o cenário reproduziu
 * o que prometia: um laboratório que provoca latência e detecta outra coisa é
 * um laboratório com um problema, e o silêncio esconderia isso.
 *
 * `mode` e `expectedAnomalyType` são campos diferentes porque são vocabulários
 * diferentes, e igualá-los seria alinhar dois arquivos que não se conhecem. O
 * `mode` é o que o usuário digita e o que vai para `DEMO_ANOMALY_MODE`
 * (`error-rate`); o `anomalyType` é o que o `detect.mjs` publica há mais tempo
 * (`error_rate`). Renomear a regra do detector para fechar a diferença mudaria
 * o conteúdo de relatórios já gerados — e o detector não muda por causa de um
 * cenário.
 */
export const SCENARIOS = {
  latency: {
    mode: 'latency',
    envValue: 'latency',
    label: 'latência intermitente',
    summary: 'a cada terceira requisição, 500 ms de espera antes do mesmo 200',
    expectedSignal: 'latencyP95Ms',
    expectedAnomalyType: 'latency',
  },
  'error-rate': {
    mode: 'error-rate',
    envValue: 'error-rate',
    label: 'erro intermitente',
    summary: 'a cada quinta requisição, HTTP 500 controlado no lugar do relatório (~20%)',
    expectedSignal: 'errorRate',
    expectedAnomalyType: 'error_rate',
  },
  // O modo é `noisy-logs` (plural, é o cenário) e o evento emitido é
  // `demo.anomaly.noisy-log` (singular, é uma linha do bloco). A diferença é
  // proposital, e a mesma da nota acima: cada nome pertence ao seu vocabulário.
  'noisy-logs': {
    mode: 'noisy-logs',
    envValue: 'noisy-logs',
    label: 'excesso de logs',
    summary:
      'a cada terceira requisição, 18 eventos `demo.anomaly.noisy-log` a mais — no mesmo 200, ' +
      'no mesmo tempo e com o mesmo corpo (2 → 8 linhas por requisição)',
    expectedSignal: 'logLinesPerRequest',
    expectedAnomalyType: 'log_volume',
  },
  // O único cenário que age em **toda** requisição, e não a cada N: o sintoma
  // imitado é uma regressão de formato (a serialização passou a repetir uma
  // lista), não um evento esporádico. Ver `createPayloadBloatAnomaly`.
  'payload-bloat': {
    mode: 'payload-bloat',
    envValue: 'payload-bloat',
    label: 'payload inflado',
    summary:
      'em toda requisição, a lista `duplicateStickers` repetida até o corpo ficar ao menos 3× ' +
      'maior — no mesmo 200, no mesmo tempo e com o mesmo formato de relatório ' +
      '(~1,9 KB → ~6,6 KB)',
    expectedSignal: 'responseSizeP95Bytes',
    expectedAnomalyType: 'payload_size',
  },
};

export const SCENARIO_MODES = Object.keys(SCENARIOS);

/**
 * @param {string} mode
 * @returns {object} cenário
 */
export function resolveScenario(mode) {
  const normalized = String(mode ?? '').trim().toLowerCase();

  if (normalized.length === 0) {
    throw new Error(
      `informe o cenário: \`npm run day2:scenario -- ${SCENARIO_MODES[0]}\`. Disponível: ${SCENARIO_MODES.join(', ')}.`,
    );
  }

  const scenario = SCENARIOS[normalized];
  if (!scenario) {
    throw new Error(`cenário desconhecido: \`${normalized}\`. Disponível: ${SCENARIO_MODES.join(', ')}.`);
  }

  return scenario;
}

/**
 * @param {string[]} argv
 * @returns {{ mode: string, port: number, requests: number, warmup: number, outDir: string|null, baselinePath: string|null }}
 */
export function parseArgs(argv = []) {
  const options = {
    mode: '',
    port: DEFAULT_PORT,
    requests: DEFAULT_MEASURED_REQUESTS,
    warmup: DEFAULT_WARMUP_REQUESTS,
    outDir: null,
    baselinePath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') options.port = Number(argv[index + 1]) || DEFAULT_PORT;
    else if (arg === '--requests') options.requests = Number(argv[index + 1]) || DEFAULT_MEASURED_REQUESTS;
    else if (arg === '--warmup') options.warmup = Number(argv[index + 1]) || DEFAULT_WARMUP_REQUESTS;
    else if (arg === '--out') options.outDir = argv[index + 1] ?? null;
    else if (arg === '--baseline-file') options.baselinePath = argv[index + 1] ?? null;
    else if (!arg.startsWith('--') && options.mode === '') options.mode = arg;
  }

  return options;
}

/**
 * Roda o cenário ponta a ponta.
 *
 * A ordem é a do enunciado do laboratório, e cada passo já existia:
 *
 *   1. baseline (`readBaseline`, dentro de `runCheck`)
 *   2. backend de pé com a variável (`observeApplication`, com `env`)
 *   3. trinta requisições observadas (`observeApplication`)
 *   4. detecção determinística (`detectAnomalies`)
 *   5. explicação da IA, com fallback (`explainAnomaly`)
 *   6. painel HTML + JSON + Markdown (`writeAnomalyReports`)
 *   7. backend encerrado (o `finally` de `observeApplication`)
 *
 * @param {object} [input]
 * @returns {Promise<{ scenario: object, report: object, paths: object, detection: object, reproduced: boolean }>}
 */
export async function runScenario({
  mode = SCENARIO_MODES[0],
  port = DEFAULT_PORT,
  measuredRequests = DEFAULT_MEASURED_REQUESTS,
  warmupRequests = DEFAULT_WARMUP_REQUESTS,
  outDir = DAY2_REPORT_DIR,
  baselinePath = BASELINE_PATH,
  baseline = null,
  observe = observeApplication,
  check = runCheck,
  client = null,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const scenario = resolveScenario(mode);

  // Passo 2: a única diferença entre este comando e o `day2:check`.
  const scenarioObserve = (input) =>
    observe({ ...input, env: { [DEMO_ANOMALY_ENV_VAR]: scenario.envValue } });

  const { report, paths, detection } = await check({
    port,
    measuredRequests,
    warmupRequests,
    outDir,
    baselinePath,
    baseline,
    observe: scenarioObserve,
    client,
    env,
    now,
  });

  return {
    scenario,
    report,
    paths,
    detection,
    // "O cenário fez o que prometeu?" — pergunta de conferência, não de gate.
    reproduced:
      detection.anomalyDetected && detection.firstAnomalousSignal === scenario.expectedSignal,
  };
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

async function main() {
  dotenv.config({ path: [join(AUTOMATION_ROOT, '.env'), join(REPO_ROOT, '.env')], quiet: true });

  const options = parseArgs(process.argv.slice(2));
  const scenario = resolveScenario(options.mode);

  process.stdout.write(
    `[day-2] cenário \`${scenario.mode}\` — ${scenario.label}\n` +
      `  ${scenario.summary}\n` +
      `  ${DEMO_ANOMALY_ENV_VAR}=${scenario.envValue} vai apenas para o backend observado.\n\n`,
  );

  const { report, paths, detection, reproduced } = await runScenario({
    mode: scenario.mode,
    port: options.port,
    measuredRequests: options.requests,
    warmupRequests: options.warmup,
    outDir: options.outDir ? resolve(options.outDir) : DAY2_REPORT_DIR,
    baselinePath: options.baselinePath ? resolve(options.baselinePath) : BASELINE_PATH,
  });

  process.stdout.write(
    `[day-2] ${detection.anomalyDetected ? 'ANOMALIA DETECTADA' : 'NORMAL'}\n` +
      `  gate .................... ${detection.gateResult}\n` +
      `  tipos ................... ${detection.anomalyTypes.length > 0 ? detection.anomalyTypes.join(', ') : '—'}\n` +
      `  primeiro sinal .......... ${detection.firstAnomalousSignal ?? '—'} (esperado: ${scenario.expectedSignal})\n` +
      `  latencyP95Ms ............ ${report.baseline.latencyP95Ms} → ${report.observed.latencyP95Ms}\n` +
      `  errorRate ............... ${report.baseline.errorRate} → ${report.observed.errorRate}\n` +
      `  logLinesPerRequest ...... ${report.baseline.logLinesPerRequest} → ${report.observed.logLinesPerRequest}\n` +
      `  responseSizeP95Bytes .... ${report.baseline.responseSizeP95Bytes} → ${report.observed.responseSizeP95Bytes}\n` +
      `  explicação .............. ${report.usedFallback ? 'gerador determinístico' : `modelo (${report.model})`}\n` +
      `  JSON .................... ${paths.jsonPath}\n` +
      `  Markdown ................ ${paths.markdownPath}\n` +
      `  Painel HTML ............. ${paths.htmlPath}\n\n` +
      (reproduced
        ? `  Cenário reproduzido: o sinal esperado (${scenario.expectedSignal}) foi o primeiro a disparar.\n`
        : '  CENÁRIO NÃO REPRODUZIDO: o detector não apontou o sinal esperado. Confira se a baseline\n' +
          '  foi coletada nesta máquina (`npm run day2:baseline`) e se o backend subiu com a variável.\n'),
  );
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[day-2] erro: ${redactSecrets(String(error?.message ?? error))}\n`);
    process.exitCode = 1;
  });
}
