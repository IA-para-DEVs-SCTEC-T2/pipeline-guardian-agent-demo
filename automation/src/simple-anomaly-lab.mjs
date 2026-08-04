/**
 * Laboratório de anomalias — Dia 2.
 *
 * Um comando, um processo, nenhum passo manual. O aluno digita
 * `npm run anomaly:baseline` e o laboratório sobe a aplicação, mede, encerra a
 * aplicação e grava o resultado. Não existe "abra outro terminal", não existe
 * "redirecione a saída para um arquivo", não existe "não esqueça de matar o
 * processo": tudo isso é erro de aula esperando para acontecer, e cada um
 * deles é um minuto que não se gasta discutindo baseline.
 *
 * ## Quatro comandos
 *
 *   baseline          mede o normal e grava `reports/day-2/baseline.json`
 *   check             mede de novo, compara, explica e gera o relatório
 *   demo <modo>       igual ao check, com `DEMO_ANOMALY_MODE` ligado
 *   fixture <cenário> tudo offline, sem subir aplicação e sem OpenAI
 *
 * ## Como a medição funciona
 *
 * 1. confere se a porta do laboratório está livre — porta ocupada vira mensagem
 *    clara, não `EADDRINUSE` no meio de um stack trace;
 * 2. sobe `backend/src/server.js` como processo filho, com `stdout` e `stderr`
 *    capturados (é daí que saem as linhas de log estruturado);
 * 3. espera `/api/health` responder;
 * 4. dispara 5 requisições de **aquecimento** e as descarta — a primeira
 *    requisição de um processo Node paga JIT, abertura de socket e primeira
 *    passagem por cada middleware. Medi-las seria medir a partida, não o regime;
 * 5. dispara 30 requisições medidas, uma de cada vez, cada uma com o seu
 *    `x-request-id`. É o `x-request-id` que permite atribuir cada linha de log à
 *    requisição que a produziu — sem isso, "linhas por requisição" seria uma
 *    divisão com numerador chutado;
 * 6. espera o log de todas elas aparecer (o log da requisição é escrito depois
 *    da resposta chegar ao cliente);
 * 7. encerra o processo filho **em `finally`** — inclusive quando a medição
 *    falha no meio.
 *
 * ## O que este módulo não faz
 *
 * Não decide nada. A decisão é do detector (`simple-anomaly-detector.mjs`), o
 * texto é do explicador (`simple-anomaly-explainer.mjs`) e o arquivo é do
 * renderizador (`simple-anomaly-report.mjs`).
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { redactSecrets } from './redact-secrets.mjs';
import {
  OBSERVED_ROUTE,
  detectAnomaly,
  summarizeMeasurement,
} from './simple-anomaly-detector.mjs';
import { explainAnomaly } from './simple-anomaly-explainer.mjs';
import { buildAnomalyReport, writeAnomalyReports } from './simple-anomaly-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AUTOMATION_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(AUTOMATION_ROOT, '..');

/** Ponto de entrada da aplicação, subido como processo filho. */
export const SERVER_PATH = join(REPO_ROOT, 'backend', 'src', 'server.js');

/** Cenários offline versionados. */
export const FIXTURES_DIR = join(REPO_ROOT, 'samples', 'day-2-anomalies');

/** Saída padrão do laboratório. */
export const DEFAULT_OUT_DIR = join(REPO_ROOT, 'reports', 'day-2');

/** Porta exclusiva do laboratório: não colide com 3001 (dev) nem 5173 (Vite). */
export const DEFAULT_LAB_PORT = 3102;

/** Requisições descartadas antes da medição. */
export const WARMUP_REQUESTS = 5;

/** Requisições medidas. */
export const MEASURED_REQUESTS = 30;

/** Modos de demonstração aceitos pelo comando `demo`. */
export const DEMO_MODES = ['latency', 'noisy-logs'];

/** Cenários offline aceitos pelo comando `fixture`. */
export const FIXTURE_SCENARIOS = ['normal', 'latency', 'noisy-logs'];

/** Teto de trechos de log no relatório. */
const MAX_EXCERPTS = 5;

/** Aviso obrigatório do modo fixture. */
export const FIXTURE_BANNER =
  'Modo fixture offline.\nNenhuma chamada à OpenAI é realizada.\nO fallback determinístico é esperado.';

/**
 * Erro de laboratório: mensagem já pronta para o aluno ler.
 *
 * Existe para separar "o laboratório não pôde rodar" (porta ocupada, baseline
 * ausente, aplicação que não subiu) de um erro de programação — o primeiro sai
 * como uma frase, o segundo continua saindo como erro.
 */
export class LabError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LabError';
  }
}

/* ------------------------------------------------------------------------- */
/* Ciclo de vida da aplicação                                                 */
/* ------------------------------------------------------------------------- */

/**
 * A porta está livre?
 *
 * Verificada **antes** de subir o processo filho: um `EADDRINUSE` vindo do
 * `stderr` do filho chegaria como stack trace no meio da aula.
 *
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<void>} rejeita com `LabError` quando ocupada
 */
export function ensurePortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolveCheck, rejectCheck) => {
    const probe = createServer();

    probe.once('error', (error) => {
      probe.close();
      if (error?.code === 'EADDRINUSE') {
        rejectCheck(
          new LabError(
            `A porta ${port} já está em uso. O laboratório precisa dela só para si.\n` +
              `  - encerre o processo que está ouvindo em ${port} (por exemplo, um \`npm run dev\` aberto), ou\n` +
              `  - rode o comando com outra porta: \`-- --port 3103\`.`,
          ),
        );
        return;
      }
      rejectCheck(error);
    });

    probe.once('listening', () => probe.close(() => resolveCheck()));
    probe.listen(port, host);
  });
}

/**
 * O ambiente do processo filho — montado do zero, não herdado.
 *
 * Herdar `process.env` traria o `.env` da máquina junto: `PORT`, `NODE_ENV` e,
 * pior, `OPENAI_API_KEY`. A aplicação não chama a OpenAI e não tem por que
 * enxergar a chave; o laboratório também não quer que um `PORT=3001` no `.env`
 * decida em qual porta a medição acontece.
 *
 * @param {object} input
 * @returns {NodeJS.ProcessEnv}
 */
export function buildChildEnv({ port, mode = 'none', env = process.env } = {}) {
  const childEnv = {
    PATH: env.PATH ?? '',
    PORT: String(port),
    DEMO_ANOMALY_MODE: mode,
    // Sem `production`: o laboratório não serve `frontend/dist` e não precisa do
    // aviso de build ausente poluindo o log medido.
    NODE_ENV: 'development',
  };

  if (env.COMMIT_SHA) childEnv.COMMIT_SHA = env.COMMIT_SHA;
  return childEnv;
}

/**
 * Encerra o processo filho. Educado primeiro, firme depois.
 *
 * @param {object} child
 * @param {object} [options]
 * @returns {Promise<void>}
 */
export function stopApplication(child, { graceMs = 5_000 } = {}) {
  if (!child || child.exitCode !== null || child.killed === true) return Promise.resolve();

  return new Promise((resolveStop) => {
    const forced = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // O processo já morreu entre o timer e agora: nada a fazer.
      }
      resolveStop();
    }, graceMs);
    forced.unref?.();

    child.once('exit', () => {
      clearTimeout(forced);
      resolveStop();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(forced);
      resolveStop();
    }
  });
}

/**
 * Acumula linhas completas de um fluxo, entregando uma a uma.
 *
 * @param {object} stream
 * @param {(line: string) => void} onLine
 */
function readLines(stream, onLine) {
  let buffer = '';
  stream?.setEncoding?.('utf8');
  stream?.on?.('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) if (part.trim().length > 0) onLine(part);
  });
}

/**
 * Uma linha de log estruturado, quando for uma.
 *
 * O que não for JSON válido com `schemaVersion` não é log da aplicação — é
 * aviso do runtime, saída de outra biblioteca ou lixo. Não entra na contagem.
 *
 * @param {string} line
 * @returns {object|null}
 */
export function parseStructuredLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && 'schemaVersion' in parsed ? parsed : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Espera `/api/health` responder 200.
 *
 * @param {object} input
 * @returns {Promise<void>}
 */
async function waitForHealth({ port, fetchImpl, timeoutMs, child, stderrLines }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new LabError(
        `A aplicação encerrou antes de responder ao health check (código ${child.exitCode}).\n` +
          tail(stderrLines),
      );
    }

    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`);
      await response.text();
      if (response.ok) return;
    } catch {
      // Ainda subindo: `ECONNREFUSED` nas primeiras tentativas é o normal.
    }

    await sleep(200);
  }

  throw new LabError(
    `A aplicação não respondeu em \`/api/health\` na porta ${port} dentro de ${timeoutMs} ms.\n` +
      tail(stderrLines),
  );
}

/**
 * Dispara requisições sequenciais e mede cada uma.
 *
 * Sequencial de propósito: requisições em paralelo mediriam a fila, não a rota,
 * e transformariam a latência p95 numa função do paralelismo escolhido.
 *
 * @param {object} input
 * @returns {Promise<Array<{ requestId: string, statusCode: number|null, durationMs: number }>>}
 */
async function runRequests({ port, route, count, prefix, fetchImpl }) {
  const samples = [];
  const url = `http://127.0.0.1:${port}${route}`;

  for (let index = 1; index <= count; index += 1) {
    const requestId = `${prefix}-${String(index).padStart(4, '0')}`;
    const startedAt = performance.now();
    let statusCode = null;

    try {
      const response = await fetchImpl(url, { headers: { 'x-request-id': requestId } });
      statusCode = response.status;
      // O corpo precisa ser consumido: a requisição só terminou de verdade
      // quando ele chegou, e é isso que o cliente sente como latência.
      await response.text();
    } catch {
      statusCode = null;
    }

    samples.push({ requestId, statusCode, durationMs: performance.now() - startedAt });
  }

  return samples;
}

/**
 * Sobe a aplicação, mede e encerra.
 *
 * @param {object} [input]
 * @returns {Promise<{ samples: Array, logLines: Array, allLogLines: Array,
 *                     stderrLines: string[], drained: boolean, mode: string, port: number }>}
 */
export async function measureApplication({
  mode = 'none',
  port = DEFAULT_LAB_PORT,
  route = OBSERVED_ROUTE,
  requests = MEASURED_REQUESTS,
  warmup = WARMUP_REQUESTS,
  serverPath = SERVER_PATH,
  env = process.env,
  spawnFn = spawn,
  fetchImpl = fetch,
  healthTimeoutMs = 20_000,
  drainTimeoutMs = 5_000,
  checkPort = ensurePortAvailable,
  out = process.stdout,
} = {}) {
  await checkPort(port);

  const child = spawnFn(process.execPath, [serverPath], {
    env: buildChildEnv({ port, mode, env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const allLogLines = [];
  const stderrLines = [];

  const collect = (line) => {
    const parsed = parseStructuredLine(line);
    if (parsed) allLogLines.push(parsed);
    else stderrLines.push(line);
  };

  readLines(child.stdout, collect);
  readLines(child.stderr, collect);

  try {
    await waitForHealth({ port, fetchImpl, timeoutMs: healthTimeoutMs, child, stderrLines });

    out?.write?.(`  aquecimento ..... ${warmup} requisição(ões) descartada(s)\n`);
    await runRequests({ port, route, count: warmup, prefix: 'warmup', fetchImpl });

    out?.write?.(`  medição ......... ${requests} requisição(ões) em ${route}\n`);
    const samples = await runRequests({ port, route, count: requests, prefix: 'lab', fetchImpl });

    const measuredIds = new Set(samples.map((sample) => sample.requestId));
    const drained = await waitForLogDrain({ allLogLines, measuredIds, timeoutMs: drainTimeoutMs });

    return {
      mode,
      port,
      samples,
      // Só o que pertence às requisições medidas. O aquecimento e a subida da
      // aplicação produziram log — e nenhum deles conta.
      logLines: allLogLines.filter((line) => measuredIds.has(line.requestId)),
      allLogLines,
      stderrLines,
      drained,
    };
  } finally {
    // Em `finally`: uma medição que falhou no meio não pode deixar a aplicação
    // ouvindo na porta do laboratório.
    await stopApplication(child);
  }
}

/**
 * Espera o log das requisições medidas aparecer.
 *
 * O evento `http.request.completed` é emitido quando a resposta termina — ou
 * seja, **depois** de o cliente já ter recebido o corpo. Contar sem esperar
 * mediria linhas a menos por uma corrida.
 *
 * @param {object} input
 * @returns {Promise<boolean>} `true` quando todas apareceram
 */
async function waitForLogDrain({ allLogLines, measuredIds, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const completed = new Set(
      allLogLines
        .filter((line) => line.eventType === 'http.request.completed' && measuredIds.has(line.requestId))
        .map((line) => line.requestId),
    );
    if (completed.size >= measuredIds.size) return true;
    await sleep(50);
  }

  return false;
}

/* ------------------------------------------------------------------------- */
/* Evidências                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Escolhe até cinco trechos que sustentam o veredito.
 *
 * A ordem é a da leitura: primeiro o resumo do que o log tem (a distribuição de
 * `eventType`, que é a evidência direta de volume), depois a requisição mais
 * lenta e a mais rápida (que é a evidência direta de latência), depois exemplos
 * das linhas que mais apareceram.
 *
 * @param {object} input
 * @returns {Array<{ source: string, excerpt: string }>}
 */
export function selectLogExcerpts({ logLines = [], samples = [], sampleCount = 0 } = {}) {
  const excerpts = [];
  const total = sampleCount || samples.length || 0;

  const byEventType = {};
  for (const line of logLines) {
    byEventType[line.eventType] = (byEventType[line.eventType] ?? 0) + 1;
  }

  const distribution = Object.entries(byEventType)
    .sort((a, b) => b[1] - a[1])
    .map(([eventType, count]) => `${eventType}=${count}`)
    .join(', ');

  if (distribution.length > 0) {
    excerpts.push({
      source: 'medição:distribuição de eventType',
      excerpt: `${logLines.length} linha(s) de log em ${total} requisição(ões) medida(s): ${distribution}.`,
    });
  }

  const requestLines = logLines.filter(
    (line) => line.eventType === 'http.request.completed' && Number.isFinite(line.durationMs),
  );

  if (requestLines.length > 0) {
    const sorted = [...requestLines].sort((a, b) => b.durationMs - a.durationMs);
    excerpts.push({ source: 'log:requisição mais lenta', excerpt: JSON.stringify(sorted[0]) });
    excerpts.push({
      source: 'log:requisição mais rápida',
      excerpt: JSON.stringify(sorted[sorted.length - 1]),
    });
  }

  // Exemplos das linhas que não são o par padrão da rota: é aqui que aparece o
  // evento que estourou o volume.
  const extras = logLines.filter(
    (line) =>
      line.eventType !== 'http.request.completed' && line.eventType !== 'functional.report.completed',
  );
  for (const line of extras.slice(0, 2)) {
    excerpts.push({ source: `log:${line.eventType}`, excerpt: JSON.stringify(line) });
  }

  return excerpts.slice(0, MAX_EXCERPTS);
}

/* ------------------------------------------------------------------------- */
/* Baseline                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * O commit em que a baseline foi medida. Informativo: uma baseline de outro
 * commit ainda é utilizável, mas quem lê o relatório precisa saber disso.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function readCommitSha(env = process.env) {
  if (env.COMMIT_SHA) return env.COMMIT_SHA;
  if (env.GITHUB_SHA) return env.GITHUB_SHA;

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    // Sem git disponível ou fora de um repositório: não é motivo para falhar.
    return 'unknown';
  }
}

/**
 * @param {object} input
 * @returns {object} conteúdo de `baseline.json`
 */
export function buildBaseline({ observation, env = process.env, now = () => new Date() }) {
  return {
    sampleCount: observation.sampleCount,
    route: observation.route,
    latencyP95Ms: observation.latencyP95Ms,
    logLinesPerRequest: observation.logLinesPerRequest,
    createdAt: now().toISOString(),
    commitSha: readCommitSha(env),
  };
}

/**
 * @param {string} path
 * @returns {object}
 */
export function loadBaseline(path) {
  if (!existsSync(path)) {
    throw new LabError(
      `Baseline não encontrada em \`${path}\`.\n` +
        '  Meça o comportamento normal primeiro: `npm run anomaly:baseline`.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new LabError(`A baseline em \`${path}\` não é um JSON válido. Meça de novo: \`npm run anomaly:baseline\`.`);
  }

  if (!Number.isFinite(parsed?.latencyP95Ms) || !Number.isFinite(parsed?.logLinesPerRequest)) {
    throw new LabError(
      `A baseline em \`${path}\` não tem \`latencyP95Ms\` e \`logLinesPerRequest\` numéricos. ` +
        'Meça de novo: `npm run anomaly:baseline`.',
    );
  }

  return parsed;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

/* ------------------------------------------------------------------------- */
/* Comandos                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * `npm run anomaly:baseline`
 *
 * @param {object} [input]
 * @returns {Promise<{ baseline: object, path: string, observation: object }>}
 */
export async function runBaseline({
  outDir = DEFAULT_OUT_DIR,
  env = process.env,
  out = process.stdout,
  now = () => new Date(),
  ...measureOptions
} = {}) {
  out?.write?.('[anomaly-lab] medindo a baseline (modo `none`)\n');

  const measurement = await measureApplication({ mode: 'none', env, out, ...measureOptions });
  const observation = summarizeMeasurement({
    samples: measurement.samples,
    logLineCount: measurement.logLines.length,
  });

  const baseline = buildBaseline({ observation, env, now });
  const path = writeJson(join(outDir, 'baseline.json'), baseline);

  out?.write?.(
    '\n[anomaly-lab] baseline gravada\n' +
      `  rota ............ ${baseline.route}\n` +
      `  amostras ........ ${baseline.sampleCount}\n` +
      `  latencyP95Ms .... ${baseline.latencyP95Ms}\n` +
      `  logLinesPerReq .. ${baseline.logLinesPerRequest}\n` +
      `  commit .......... ${baseline.commitSha}\n` +
      `  arquivo ......... ${path}\n\n` +
      '  Esta é a definição de "normal" deste laboratório. Compare com `npm run anomaly:check`.\n',
  );

  return { baseline, path, observation, measurement };
}

/**
 * `npm run anomaly:check` e `npm run anomaly:demo -- <modo>`
 *
 * @param {object} [input]
 * @returns {Promise<object>}
 */
export async function runCheck({
  mode = 'none',
  baselinePath = join(DEFAULT_OUT_DIR, 'baseline.json'),
  outDir = DEFAULT_OUT_DIR,
  scenario = null,
  env = process.env,
  client = null,
  out = process.stdout,
  now = () => new Date(),
  ...measureOptions
} = {}) {
  const baseline = loadBaseline(baselinePath);

  out?.write?.(
    `[anomaly-lab] observando a aplicação (modo \`${mode}\`)\n` +
      `  baseline ........ ${baselinePath}\n`,
  );

  const measurement = await measureApplication({ mode, env, out, ...measureOptions });
  const observation = summarizeMeasurement({
    samples: measurement.samples,
    logLineCount: measurement.logLines.length,
  });

  const excerpts = selectLogExcerpts({
    logLines: measurement.logLines,
    samples: measurement.samples,
    sampleCount: observation.sampleCount,
  });

  const detection = detectAnomaly({ baseline, observed: observation });

  const explained = await explainAnomaly({
    detection: { ...detection, route: observation.route },
    excerpts,
    context: observation.context,
    env,
    client,
  });

  const extraLimitations = [];
  if (!measurement.drained) {
    extraLimitations.push(
      'Nem todas as requisições medidas tiveram o log correspondente coletado no tempo esperado; ' +
        '`logLinesPerRequest` pode estar subestimado.',
    );
  }

  const report = buildAnomalyReport({
    detection,
    observation,
    baseline,
    explanation: {
      ...explained.explanation,
      limitations: [...explained.explanation.limitations, ...extraLimitations],
    },
    explanationSource: explained,
    excerpts: explained.excerpts,
    scenario: scenario ?? (mode === 'none' ? 'check' : `demo:${mode}`),
    now,
  });

  const observationPath = writeJson(join(outDir, 'observation.json'), observation);
  const { paths } = writeAnomalyReports({ report, outDir });

  printResult({ out, report, paths: [observationPath, ...paths], explained });

  return { report, detection, observation, baseline, paths: [observationPath, ...paths], explained };
}

/**
 * `npm run anomaly:demo -- <modo>`
 *
 * Exige uma baseline normal — e a cria quando ela não existe. Um comando de
 * demonstração que falha porque falta um passo anterior não é demonstração.
 *
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function runDemo({
  mode,
  outDir = DEFAULT_OUT_DIR,
  baselinePath = null,
  out = process.stdout,
  ...options
} = {}) {
  if (!DEMO_MODES.includes(mode)) {
    throw new LabError(
      `Modo de demonstração desconhecido: \`${mode ?? ''}\`. Use: ${DEMO_MODES.join(', ')}.`,
    );
  }

  const path = baselinePath ?? join(outDir, 'baseline.json');

  if (!existsSync(path)) {
    out?.write?.('[anomaly-lab] sem baseline: medindo o comportamento normal antes da demonstração\n\n');
    await runBaseline({ outDir, out, ...options });
    out?.write?.('\n');
  }

  return runCheck({ mode, baselinePath: path, outDir, out, ...options });
}

/**
 * `npm run anomaly:fixture -- <cenário>`
 *
 * Nada sobe, nada sai pela rede. Os números vêm de um arquivo versionado, e é
 * exatamente por isso que o cenário serve para explicar a regra: ele não muda
 * de uma execução para outra.
 *
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function runFixture({
  scenario,
  outDir = join(DEFAULT_OUT_DIR, 'fixtures'),
  fixturesDir = FIXTURES_DIR,
  env = process.env,
  client = null,
  out = process.stdout,
  now = () => new Date(),
} = {}) {
  if (!FIXTURE_SCENARIOS.includes(scenario)) {
    throw new LabError(
      `Cenário desconhecido: \`${scenario ?? ''}\`. Use: ${FIXTURE_SCENARIOS.join(', ')} ou \`all\`.`,
    );
  }

  const path = join(fixturesDir, `${scenario}.json`);
  if (!existsSync(path)) throw new LabError(`Fixture não encontrada: \`${path}\`.`);

  const fixture = JSON.parse(readFileSync(path, 'utf8'));
  const detection = detectAnomaly({ baseline: fixture.baseline, observed: fixture.observed });

  // A chave não liga o modelo aqui. Não é uma condição em volta da chamada: é a
  // chave não existir para quem chamaria. Mesma decisão do Dia 1.
  const { OPENAI_API_KEY: _key, ...offlineEnv } = env;

  const explained = await explainAnomaly({
    detection: { ...detection, route: fixture.observed?.route ?? OBSERVED_ROUTE },
    excerpts: fixture.logExcerpts ?? [],
    context: fixture.observed?.context ?? {},
    env: offlineEnv,
    client,
  });

  const report = buildAnomalyReport({
    detection,
    observation: fixture.observed,
    baseline: fixture.baseline,
    explanation: explained.explanation,
    explanationSource: explained,
    excerpts: explained.excerpts,
    scenario: `fixture:${scenario}`,
    now,
  });

  const scenarioDir = join(outDir, scenario);
  const { paths } = writeAnomalyReports({ report, outDir: scenarioDir });

  out?.write?.(`\n[anomaly-lab] cenário \`${scenario}\` — ${fixture.description ?? ''}\n`);
  printResult({ out, report, paths, explained });

  return { report, detection, paths, explained };
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * @param {string[]} argv
 * @returns {object}
 */
export function parseLabArgs(argv = []) {
  const options = {
    command: null,
    target: null,
    baselinePath: null,
    outDir: null,
    port: null,
    requests: null,
    warmup: null,
    failOnAnomaly: false,
  };

  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const value = next && !next.startsWith('--') ? next : null;

    if (arg === '--baseline') options.baselinePath = value;
    else if (arg === '--out') options.outDir = value;
    else if (arg === '--port') options.port = value ? Number(value) : null;
    else if (arg === '--requests') options.requests = value ? Number(value) : null;
    else if (arg === '--warmup') options.warmup = value ? Number(value) : null;
    else if (arg === '--fail-on-anomaly') options.failOnAnomaly = true;
    else if (!arg.startsWith('--')) positional.push(arg);
  }

  // Um valor consumido por uma opção não é posicional.
  const consumed = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    if (['--baseline', '--out', '--port', '--requests', '--warmup'].includes(argv[index])) {
      consumed.add(argv[index + 1]);
    }
  }

  const free = positional.filter((item) => !consumed.has(item));
  options.command = free[0] ?? null;
  options.target = free[1] ?? null;

  return options;
}

/**
 * Impressão comum a `check`, `demo` e `fixture`.
 *
 * @param {object} input
 */
function printResult({ out, report, paths, explained }) {
  const signals = report.signals
    .map(
      (signal) =>
        `${signal.triggered ? '🔴' : '🟢'} ${signal.signal}: baseline ${signal.baseline} → observado ${signal.observed}` +
        `${signal.ratio === null ? '' : ` (${signal.ratio}x)`}`,
    )
    .join('\n                    ');

  out?.write?.(
    '\n[anomaly-lab] resultado\n' +
      `  anomalyDetected . ${report.anomalyDetected}\n` +
      `  anomalyType ..... ${report.anomalyType ?? 'null'}\n` +
      `  firstSignal ..... ${report.firstAnomalousSignal ?? 'null'}\n` +
      `  gateResult ...... ${report.gateResult}\n` +
      `  sinais .......... ${signals}\n` +
      `  regras .......... ${report.triggeredRules.length > 0 ? report.triggeredRules.join('; ') : 'nenhuma acionada'}\n` +
      `  arquivos ........ ${paths.join('\n                    ')}\n` +
      `\nExplicação: ${explained.sourceLabel}\n`,
  );
}

function tail(lines = [], count = 5) {
  const selected = lines.slice(-count).map((line) => `    ${redactSecrets(line)}`);
  return selected.length > 0 ? `  Últimas linhas da aplicação:\n${selected.join('\n')}` : '';
}

async function main() {
  dotenv.config({ path: [join(AUTOMATION_ROOT, '.env'), join(REPO_ROOT, '.env')], quiet: true });

  const options = parseLabArgs(process.argv.slice(2));
  const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
  const baselinePath = resolve(options.baselinePath ?? join(outDir, 'baseline.json'));

  const measureOptions = {};
  if (Number.isInteger(options.port)) measureOptions.port = options.port;
  if (Number.isInteger(options.requests)) measureOptions.requests = options.requests;
  if (Number.isInteger(options.warmup)) measureOptions.warmup = options.warmup;

  if (options.command === 'baseline') {
    await runBaseline({ outDir, ...measureOptions });
    return;
  }

  if (options.command === 'check') {
    const { report } = await runCheck({ baselinePath, outDir, ...measureOptions });
    if (options.failOnAnomaly && report.anomalyDetected) process.exitCode = 1;
    return;
  }

  if (options.command === 'demo') {
    const { report } = await runDemo({
      mode: options.target,
      baselinePath: options.baselinePath ? baselinePath : null,
      outDir,
      ...measureOptions,
    });
    if (options.failOnAnomaly && report.anomalyDetected) process.exitCode = 1;
    return;
  }

  if (options.command === 'fixture') {
    process.stdout.write(`${FIXTURE_BANNER}\n`);

    const scenarios = options.target === 'all' ? FIXTURE_SCENARIOS : [options.target];
    for (const scenario of scenarios) {
      await runFixture({ scenario, outDir: join(outDir, 'fixtures') });
    }
    return;
  }

  process.stderr.write(
    'Uso:\n' +
      '  npm run anomaly:baseline\n' +
      '  npm run anomaly:check -- --baseline reports/day-2/baseline.json\n' +
      `  npm run anomaly:demo -- <${DEMO_MODES.join('|')}>\n` +
      `  npm run anomaly:fixture -- <${FIXTURE_SCENARIOS.join('|')}|all>\n\n` +
      'Opções: --out <dir> --port <n> --requests <n> --warmup <n> --fail-on-anomaly\n',
  );
  process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    if (error instanceof LabError) {
      process.stderr.write(`\n[anomaly-lab] ${redactSecrets(error.message)}\n`);
    } else {
      process.stderr.write(`\n[anomaly-lab] erro: ${redactSecrets(String(error?.stack ?? error?.message ?? error))}\n`);
    }
    process.exitCode = 1;
  });
}
