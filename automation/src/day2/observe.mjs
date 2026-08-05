/**
 * Observação da aplicação — a coleta de sinais do Dia 2.
 *
 * O Dia 1 lia logs que **já** existiam (artefato de CI, log do Railway). O Dia 2
 * produz os seus: sobe a aplicação de verdade, faz requisições de verdade e mede
 * o que aconteceu. É a diferença entre diagnosticar um pipeline e observar um
 * serviço em execução.
 *
 * Quatro decisões que valem para quem for evoluir:
 *
 * 1. **Quatro sinais, e só quatro.** `latencyP95Ms`, `errorRate`,
 *    `logLinesPerRequest` e `responseSizeP95Bytes`. `requestCount` é contexto —
 *    aparece no relatório, mas nenhuma regra do detector olha para ele. Métrica
 *    que não entra em decisão não é métrica decisória, e misturar as duas
 *    categorias é como um painel passa a ter trinta números e nenhuma conclusão.
 * 2. **O aquecimento é descartado.** As primeiras requisições pagam JIT, abertura
 *    de socket e primeira montagem do relatório em memória. Incluí-las na
 *    baseline é criar uma baseline que descreve a subida do processo, não o
 *    regime de operação — e uma baseline inflada esconde exatamente a anomalia
 *    que ela deveria revelar.
 * 3. **O log é correlacionado pelo `requestId`, não pelo relógio.** O header
 *    `x-request-id` vai na requisição, volta na resposta e aparece em cada linha
 *    do log estruturado. Contar linhas por janela de tempo funcionaria até a
 *    primeira requisição concorrente; contar por identificador funciona sempre.
 *    Quando a correlação não fecha, o valor cai para a média por janela e isso é
 *    **declarado** — não silenciosamente aproximado.
 * 4. **O processo filho morre no `finally`.** Não no caminho feliz, não no
 *    `catch`: no `finally`. Um laboratório que deixa um servidor pendurado na
 *    porta 3102 é um laboratório que falha na segunda execução da aula, com uma
 *    mensagem (`EADDRINUSE`) que não tem nada a ver com o que se está ensinando.
 *
 * Este módulo **não** decide nada. Ele mede. A decisão é do `detect.mjs`.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = resolve(HERE, '..', '..');
export const REPO_ROOT = resolve(AUTOMATION_ROOT, '..');

/** Porta do laboratório. Fora da faixa de desenvolvimento (3001) de propósito. */
export const DEFAULT_PORT = 3102;

/** Descartadas. Ver decisão 2 no cabeçalho. */
export const DEFAULT_WARMUP_REQUESTS = 5;

/** Medidas. Com 30 amostras o índice do P95 cai em 28 — ver `nearestRankPercentile`. */
export const DEFAULT_MEASURED_REQUESTS = 30;

/** Rota observada: a funcional, não a de health. */
export const DEFAULT_PATH = '/api/report';

/**
 * Espera depois da última requisição medida.
 *
 * `http.request.completed` é emitido no evento `finish` da resposta, que ocorre
 * **depois** de o cliente já ter o corpo em mãos. Matar o processo na hora
 * perderia a última linha de log de cada execução — e um relatório que perde uma
 * linha em trinta reporta `logLinesPerRequest: 1.97` sem que nada tenha
 * acontecido com a aplicação.
 */
export const DEFAULT_DRAIN_MS = 300;

/** Teto da espera pelo `/api/health`. */
export const DEFAULT_READY_TIMEOUT_MS = 20_000;

/** Intervalo entre tentativas de health check. */
const READY_POLL_INTERVAL_MS = 150;

/**
 * Espera pelo encerramento controlado antes do `SIGKILL`.
 *
 * O `SIGTERM` é a forma educada e produz `app.shutdown.requested` no log. O
 * `SIGKILL` é a garantia: conexão keep-alive pendurada segura `server.close()`,
 * e o laboratório não pode depender da boa vontade do pool de sockets.
 */
export const DEFAULT_KILL_TIMEOUT_MS = 3_000;

/* ------------------------------------------------------------------------- */
/* Estatística                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Percentil por **posto mais próximo**, na forma didática.
 *
 * `index = Math.ceil(n * 0.95) - 1` sobre a lista ordenada. Sem interpolação,
 * sem estimador de densidade: o valor devolvido é um valor **que foi realmente
 * medido**, e quem estiver assistindo consegue conferir na tabela de amostras do
 * painel. Um P95 interpolado seria mais correto estatisticamente e menos
 * verificável — e a coisa que este laboratório ensina é a verificação.
 *
 * Com n = 30: `ceil(28.5) - 1 = 28`, o penúltimo valor da lista ordenada. É por
 * isso que **uma** requisição lenta isolada não move o P95 — comportamento
 * desejado, e coberto por teste.
 *
 * @param {number[]} values
 * @param {number} [fraction]
 * @returns {number} 0 quando não há valor numérico algum
 */
export function nearestRankPercentile(values, fraction = 0.95) {
  const sorted = (Array.isArray(values) ? values : [])
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (sorted.length === 0) return 0;

  const index = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

/**
 * Uma amostra é um erro quando não houve resposta (`statusCode: 0`) ou quando o
 * código é 4xx/5xx.
 *
 * O 4xx conta: a rota observada é `GET /api/report`, sem parâmetro e sem corpo.
 * Um 404 ali não é "cliente errado", é a rota tendo sumido.
 *
 * @param {object} sample
 * @returns {boolean}
 */
export function isErrorSample(sample) {
  const status = Number(sample?.statusCode);
  return !Number.isFinite(status) || status === 0 || status >= 400;
}

/**
 * Reduz as amostras aos quatro sinais (mais `requestCount`, que é contexto).
 *
 * @param {Array<object>} samples
 * @returns {{
 *   sampleCount: number,
 *   requestCount: number,
 *   latencyP95Ms: number,
 *   errorRate: number,
 *   logLinesPerRequest: number,
 *   responseSizeP95Bytes: number,
 * }}
 */
export function summarizeSamples(samples = []) {
  const list = Array.isArray(samples) ? samples : [];
  const count = list.length;

  if (count === 0) {
    return {
      sampleCount: 0,
      requestCount: 0,
      latencyP95Ms: 0,
      errorRate: 0,
      logLinesPerRequest: 0,
      responseSizeP95Bytes: 0,
    };
  }

  const errors = list.filter(isErrorSample).length;
  const logLines = list.reduce((total, sample) => total + toCount(sample.logLineCount), 0);

  return {
    sampleCount: count,
    requestCount: count,
    latencyP95Ms: round(nearestRankPercentile(list.map((s) => Number(s.durationMs))), 2),
    errorRate: round(errors / count, 4),
    logLinesPerRequest: round(logLines / count, 2),
    responseSizeP95Bytes: Math.round(
      nearestRankPercentile(list.map((s) => Number(s.responseSizeBytes))),
    ),
  };
}

/* ------------------------------------------------------------------------- */
/* Leitura do log estruturado                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Interpreta **apenas** linhas que são JSON válido e objeto.
 *
 * O `stdout` de um processo Node carrega mais do que o log estruturado: aviso do
 * runtime, `ExperimentalWarning`, o que uma dependência resolver imprimir. Nada
 * disso é evento, e tentar adivinhar o que "parece" um log é como um contador de
 * linhas passa a depender do humor do ambiente. Linha que não é JSON é contada
 * como ruído e fica de fora da correlação.
 *
 * @param {string} text
 * @returns {{ events: Array<object>, noiseLines: string[] }}
 */
export function parseLogLines(text) {
  const events = [];
  const noiseLines = [];

  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (!trimmed.startsWith('{')) {
      noiseLines.push(trimmed);
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed);
      } else {
        noiseLines.push(trimmed);
      }
    } catch {
      // JSON partido (linha cortada pelo buffer do pipe, por exemplo): ruído.
      noiseLines.push(trimmed);
    }
  }

  return { events, noiseLines };
}

/**
 * Atribui a cada amostra o número de linhas de log que ela produziu.
 *
 * Estratégia primária: casar `requestId`. Se **toda** amostra encontrar pelo
 * menos uma linha, a contagem é exata e `strategy` é `request_id`.
 *
 * Estratégia de contingência: dividir o total de linhas da janela medida pelo
 * número de requisições. É uma média, e por isso a função devolve
 * `strategy: 'window_average'` — quem publica o relatório declara a
 * aproximação em vez de apresentá-la como contagem.
 *
 * @param {Array<object>} samples
 * @param {Array<object>} events eventos do log já interpretados
 * @returns {{ samples: Array<object>, strategy: 'request_id'|'window_average', matched: number }}
 */
export function attachLogCounts(samples = [], events = []) {
  const byRequestId = new Map();
  for (const event of events) {
    const id = typeof event?.requestId === 'string' ? event.requestId : null;
    if (!id) continue;
    byRequestId.set(id, (byRequestId.get(id) ?? 0) + 1);
  }

  const counts = samples.map((sample) => byRequestId.get(sample.requestId) ?? 0);
  const matched = counts.filter((value) => value > 0).length;

  if (samples.length > 0 && matched === samples.length) {
    return {
      samples: samples.map((sample, index) => ({ ...sample, logLineCount: counts[index] })),
      strategy: 'request_id',
      matched,
    };
  }

  const average = samples.length > 0 ? events.length / samples.length : 0;
  return {
    samples: samples.map((sample) => ({ ...sample, logLineCount: round(average, 2) })),
    strategy: 'window_average',
    matched,
  };
}

/* ------------------------------------------------------------------------- */
/* Execução                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Sobe a aplicação, mede e encerra.
 *
 * Tudo o que toca o mundo externo é injetável (`spawnFn`, `requestFn`, `sleep`)
 * porque um teste que precisasse de porta livre, rede e relógio real para
 * verificar uma média não seria teste — seria sorte.
 *
 * @param {object} [input]
 * @param {number} [input.port]
 * @param {string} [input.path] rota observada
 * @param {number} [input.warmupRequests]
 * @param {number} [input.measuredRequests]
 * @param {string} [input.serverPath] entrada do backend
 * @param {object} [input.env] ambiente do processo filho
 * @param {Function} [input.spawnFn]
 * @param {Function} [input.requestFn] executor HTTP injetável
 * @param {Function} [input.sleep]
 * @returns {Promise<object>} observação completa
 */
export async function observeApplication({
  port = DEFAULT_PORT,
  path = DEFAULT_PATH,
  warmupRequests = DEFAULT_WARMUP_REQUESTS,
  measuredRequests = DEFAULT_MEASURED_REQUESTS,
  serverPath = join(REPO_ROOT, 'backend', 'src', 'server.js'),
  env = {},
  spawnFn = spawn,
  requestFn = performRequest,
  sleep = defaultSleep,
  drainMs = DEFAULT_DRAIN_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const stdoutChunks = [];
  const stderrChunks = [];
  const limitations = [];

  const child = spawnFn(process.execPath, [serverPath], {
    // A porta é o único ajuste obrigatório. O resto do ambiente é herdado para
    // que a aplicação observada seja a mesma que roda em desenvolvimento — um
    // laboratório que mede uma configuração especial mede a si mesmo.
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));

  // O filho existe a partir daqui: qualquer erro abaixo passa pelo `finally`.
  try {
    const ready = await waitForHealth({ baseUrl, requestFn, sleep, timeoutMs: readyTimeoutMs, child });
    if (!ready.ok) {
      throw new Error(`a aplicação não respondeu ao health check em ${readyTimeoutMs} ms`);
    }

    // Aquecimento: executado e jogado fora, inclusive o log que produziu.
    for (let index = 0; index < warmupRequests; index += 1) {
      await requestFn({ url: `${baseUrl}${path}`, requestId: `warmup-${index + 1}-${randomUUID()}` });
    }
    await sleep(drainMs);

    // Marco da janela medida, **por corrente**.
    //
    // `stdout` e `stderr` são dois arquivos abertos ao mesmo tempo: o nível
    // `error` vai para o segundo, o resto para o primeiro. Um marco único sobre
    // a concatenação das duas correntes funcionaria enquanto a aplicação
    // estivesse saudável e erraria exatamente quando ela não estivesse — a
    // linha de erro do aquecimento entraria na janela medida e uma linha boa
    // sairia dela. Guardar um deslocamento por corrente resolve isso sem
    // depender de relógio.
    const boundary = { stdout: stdoutChunks.join('').length, stderr: stderrChunks.join('').length };

    const startedAt = now().toISOString();
    const rawSamples = [];

    for (let index = 0; index < measuredRequests; index += 1) {
      const requestId = `day2-${index + 1}-${randomUUID()}`;
      const result = await requestFn({ url: `${baseUrl}${path}`, requestId });

      rawSamples.push({
        sequence: index + 1,
        statusCode: result.statusCode,
        durationMs: round(result.durationMs, 2),
        responseSizeBytes: result.responseSizeBytes,
        logLineCount: 0,
        requestId: result.requestId ?? requestId,
      });
    }

    // Sem esta espera, a última linha de log de cada requisição pode não ter
    // sido escrita ainda. Ver `DEFAULT_DRAIN_MS`.
    await sleep(drainMs);
    const finishedAt = now().toISOString();

    const measuredOutput =
      `${stdoutChunks.join('').slice(boundary.stdout)}\n${stderrChunks.join('').slice(boundary.stderr)}`;
    const parsed = parseLogLines(measuredOutput);
    const measuredEvents = parsed.events;

    const correlated = attachLogCounts(rawSamples, measuredEvents);
    if (correlated.strategy === 'window_average') {
      limitations.push(
        'Nem toda requisição medida encontrou log com o mesmo `requestId` ' +
          `(${correlated.matched} de ${rawSamples.length}). \`logLinesPerRequest\` é a média da janela, ` +
          'não uma contagem por requisição.',
      );
    }
    if (parsed.noiseLines.length > 0) {
      limitations.push(
        `${parsed.noiseLines.length} linha(s) da saída do processo não eram JSON válido e ficaram ` +
          'fora da contagem de log.',
      );
    }

    return {
      samples: correlated.samples,
      summary: summarizeSamples(correlated.samples),
      logEvents: measuredEvents,
      logCorrelation: correlated.strategy,
      noiseLines: parsed.noiseLines,
      warmupRequests,
      startedAt,
      finishedAt,
      port,
      path,
      limitations,
    };
  } finally {
    // Sempre. Ver decisão 4 no cabeçalho.
    await terminateChild(child, { killTimeoutMs, sleep });
  }
}

/**
 * Encerra o processo filho: `SIGTERM`, espera, `SIGKILL`.
 *
 * @param {object} child
 * @param {object} options
 * @returns {Promise<{ terminated: boolean, forced: boolean }>}
 */
export async function terminateChild(child, { killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS, sleep = defaultSleep } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { terminated: true, forced: false };
  }

  const exited = new Promise((resolveExit) => {
    child.once('exit', () => resolveExit(true));
  });

  try {
    child.kill('SIGTERM');
  } catch {
    // Processo já morto entre a checagem e o sinal: nada a fazer.
    return { terminated: true, forced: false };
  }

  const graceful = await Promise.race([exited, sleep(killTimeoutMs).then(() => false)]);
  if (graceful) return { terminated: true, forced: false };

  try {
    child.kill('SIGKILL');
  } catch {
    // Idem.
  }
  await Promise.race([exited, sleep(killTimeoutMs).then(() => false)]);

  return { terminated: true, forced: true };
}

/**
 * Aguarda `/api/health` responder 200.
 *
 * Desiste cedo se o processo morrer: continuar batendo numa porta cujo dono já
 * saiu só transforma um erro de inicialização em um timeout de 20 segundos.
 *
 * @param {object} input
 * @returns {Promise<{ ok: boolean, attempts: number }>}
 */
export async function waitForHealth({ baseUrl, requestFn, sleep, timeoutMs, child = null }) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    if (child && child.exitCode !== null) return { ok: false, attempts };

    const result = await requestFn({ url: `${baseUrl}/api/health`, requestId: `ready-${attempts}` });
    if (result.statusCode === 200) return { ok: true, attempts };

    await sleep(READY_POLL_INTERVAL_MS);
  }

  return { ok: false, attempts };
}

/**
 * Uma requisição medida.
 *
 * O corpo é lido por inteiro **antes** de parar o cronômetro: o tempo até o
 * primeiro byte esconderia justamente a anomalia de payload que o Dia 2 procura.
 * O tamanho vem de `Buffer.byteLength`, não de `Content-Length` — o header pode
 * faltar, e bytes contados são bytes recebidos.
 *
 * Falha de conexão vira `statusCode: 0`, nunca exceção: uma aplicação que caiu no
 * meio da observação é um dado, não um erro do laboratório.
 *
 * @param {object} input
 * @returns {Promise<{ statusCode: number, durationMs: number, responseSizeBytes: number, requestId: string|null }>}
 */
export async function performRequest({ url, requestId, fetchFn = fetch }) {
  const startedAt = performance.now();

  try {
    const response = await fetchFn(url, {
      headers: { 'x-request-id': requestId, accept: 'application/json' },
    });
    const body = await response.text();
    const durationMs = performance.now() - startedAt;

    return {
      statusCode: response.status,
      durationMs,
      responseSizeBytes: Buffer.byteLength(body, 'utf8'),
      // O servidor devolve o mesmo `x-request-id` que recebeu; se não devolver,
      // vale o que enviamos.
      requestId: response.headers?.get?.('x-request-id') ?? requestId,
    };
  } catch {
    return {
      statusCode: 0,
      durationMs: performance.now() - startedAt,
      responseSizeBytes: 0,
      requestId,
    };
  }
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function defaultSleep(ms) {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}

function toCount(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

/**
 * Arredondamento estável. Números com dezessete casas decimais num painel são
 * ruído; a diferença entre 8.1 e 8.13 nunca decidiu nada aqui.
 *
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
export function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return 0;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}
