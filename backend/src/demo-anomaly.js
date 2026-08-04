/**
 * Modos de demonstração de anomalia — Dia 2.
 *
 * Existe para a aula ter uma anomalia **reproduzível** sem ninguém precisar
 * quebrar a aplicação de verdade. O aluno liga um modo por variável de
 * ambiente, mede, compara com a baseline e vê o detector acusar.
 *
 * Três decisões que valem para quem for evoluir:
 *
 * 1. **Sem `DEMO_ANOMALY_MODE`, este módulo não faz nada.** `resolveDemoMode`
 *    devolve `none` para ausente, vazio ou valor desconhecido, e o middleware
 *    vira um `next()` puro. O comportamento padrão da aplicação é exatamente o
 *    do Dia 1 — se ligar o Dia 2 mudasse a linha de base, a baseline medida
 *    não descreveria mais o normal.
 * 2. **A anomalia é intermitente, não permanente.** Só a cada terceira
 *    requisição de `GET /api/report`. É o que torna o p95 interessante de
 *    ensinar: a média esconde o problema, o percentil alto não.
 * 3. **A aplicação continua funcional.** Nada de erro, nada de 500, nada de
 *    loop. `/api/health` nunca é tocado: o processo continua "saudável" e é
 *    justamente por isso que a anomalia não é uma falha — é um desvio de
 *    comportamento que o health check não vê.
 *
 * ## Por que 18 linhas, e não 12
 *
 * A regra de volume de log exige **as duas** condições: `observado >=
 * baseline * 3` **e** `observado - baseline >= 5`. A baseline real de
 * `GET /api/report` é 2 linhas por requisição (o log da requisição e o evento
 * funcional). Um estouro a cada três requisições dilui por três: 12 linhas
 * viram +4 por requisição, o que passa na regra relativa (6 >= 6) e **reprova**
 * na absoluta (4 < 5) — a demonstração terminaria com `anomalyDetected: false`,
 * ensinando o oposto do que se quer ensinar. 18 linhas viram +6 por requisição
 * (2 → 8), com folga nas duas regras.
 */

import { logEvent } from './logging/structured-logger.js';

/** Modos aceitos. Qualquer outro valor é tratado como `none`. */
export const DEMO_ANOMALY_MODES = ['none', 'latency', 'noisy-logs'];

/** A única rota afetada. `/api/health` fica de fora de propósito. */
export const DEMO_TARGET_PATH = '/api/report';

/** Cadência do desvio: 1 a cada 3 requisições da rota alvo. */
export const DEMO_EVERY_NTH_REQUEST = 3;

/** Atraso injetado no modo `latency`. */
export const DEMO_LATENCY_MS = 500;

/** Linhas extras por estouro no modo `noisy-logs`. Ver o cabeçalho do módulo. */
export const DEMO_NOISY_LOG_LINES = 18;

/** Evento das linhas extras. Está em `LOG_EVENT_TYPES` — a lista é fechada. */
export const DEMO_NOISY_LOG_EVENT = 'demo.anomaly.noisy-log';

/**
 * Lê o modo do ambiente.
 *
 * Valor desconhecido não derruba a aplicação nem liga um modo por engano: vira
 * `none`. Uma variável escrita errada tem que ser inofensiva.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'none'|'latency'|'noisy-logs'}
 */
export function resolveDemoMode(env = process.env) {
  const raw = String(env.DEMO_ANOMALY_MODE ?? '').trim().toLowerCase();
  return DEMO_ANOMALY_MODES.includes(raw) && raw.length > 0 ? raw : 'none';
}

/**
 * O caminho pedido, sem query string.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function requestPath(req) {
  return String(req.originalUrl ?? req.url ?? '').split('?')[0];
}

/**
 * A requisição é alvo da demonstração?
 *
 * `GET /api/report` e nada mais — nem sub-rota, nem outro método.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isDemoTarget(req) {
  if (req.method !== 'GET') return false;
  const path = requestPath(req).replace(/\/+$/, '');
  return path === DEMO_TARGET_PATH;
}

/**
 * Cria o middleware da demonstração.
 *
 * Com `mode: 'none'` devolve um middleware que só chama `next()` — sem
 * contador, sem timer, sem log. É o caminho de produção.
 *
 * @param {object} [options]
 * @param {'none'|'latency'|'noisy-logs'} [options.mode]
 * @param {object} [options.log] emissor estruturado injetável (testes)
 * @param {number} [options.delayMs]
 * @param {number} [options.lines]
 * @param {(ms: number) => Promise<void>} [options.sleep] injetável (testes)
 * @returns {import('express').RequestHandler}
 */
export function createDemoAnomalyMiddleware({
  mode = 'none',
  log = logEvent,
  delayMs = DEMO_LATENCY_MS,
  lines = DEMO_NOISY_LOG_LINES,
  sleep = defaultSleep,
} = {}) {
  if (mode !== 'latency' && mode !== 'noisy-logs') {
    return function demoAnomalyDisabled(req, res, next) {
      next();
    };
  }

  // Contador por processo. Não é estado de negócio: some quando o processo
  // reinicia, e é isso que se espera de uma demonstração.
  let seen = 0;

  return function demoAnomaly(req, res, next) {
    if (!isDemoTarget(req)) return next();

    seen += 1;
    if (seen % DEMO_EVERY_NTH_REQUEST !== 0) return next();

    if (mode === 'latency') {
      // O atraso vem ANTES da resposta: é isso que o cliente mede como latência
      // e o que o `durationMs` do log da requisição registra. A resposta
      // continua sendo 200 com o corpo de sempre.
      sleep(delayMs).then(() => next(), next);
      return;
    }

    emitNoisyLines({ log, requestId: req.id, lines, sequence: seen });
    next();
  };
}

/**
 * Emite o estouro de linhas estruturadas.
 *
 * Cada linha carrega o `requestId` — sem ele, não haveria como atribuir o
 * volume à requisição que o produziu, e a métrica "linhas por requisição"
 * viraria chute.
 *
 * @param {object} input
 */
function emitNoisyLines({ log, requestId, lines, sequence }) {
  for (let index = 1; index <= lines; index += 1) {
    log.emit({
      level: 'info',
      eventType: DEMO_NOISY_LOG_EVENT,
      phase: 'runtime',
      message: `linha de depuração ${index}/${lines} da requisição ${sequence} de /api/report`,
      fields: { requestId, functionalArea: 'report' },
    });
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
