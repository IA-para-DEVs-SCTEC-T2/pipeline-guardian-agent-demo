import { logEvent } from '../logging/structured-logger.js';

/**
 * Logger estruturado de requisições — uma linha JSON por requisição concluída.
 *
 * O formato do evento é o contrato de `logging/structured-logger.js`; aqui só se
 * decide **o que** registrar de uma requisição HTTP:
 *
 * - `requestId`, `method`, `path`, `statusCode` e `durationMs` — o suficiente
 *   para correlacionar esta linha com o smoke test e com o log da plataforma;
 * - nada de `Authorization`, `Cookie`, corpo de requisição, corpo de resposta ou
 *   query string (o `path` é gravado sem o que vem depois do `?`).
 *
 * A severidade vem do código HTTP: 5xx é `error` (a aplicação falhou), 4xx é
 * `warn` (o cliente errou — não é incidente, mas conta como sinal) e o resto é
 * `info`. Sem essa distinção, uma rajada de 500 fica indistinguível de tráfego
 * normal no log da plataforma.
 *
 * @param {object} [options]
 * @param {object} [options.log] emissor injetável (testes)
 * @returns {import('express').RequestHandler}
 */
export function createRequestLogger({ log = logEvent } = {}) {
  return function requestLogger(req, res, next) {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

      log.emit({
        level: levelFor(res.statusCode),
        eventType: 'http.request.completed',
        phase: phaseFor(req.originalUrl),
        message: `${req.method} ${req.originalUrl} ${res.statusCode}`,
        fields: {
          requestId: req.id,
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
        },
      });
    });

    next();
  };
}

/** Instância padrão, usada por `createApp`. */
export const logger = createRequestLogger();

/**
 * A fase da requisição.
 *
 * `/api/health` é `healthcheck` e `/api/report` é `functional` porque essa é
 * exatamente a distinção que o diagnóstico do Dia 1 precisa fazer: processo vivo
 * (health respondendo) não é o mesmo que funcionalidade sadia (rota de negócio
 * respondendo). Sem separar as duas na origem, o agente teria que inferir isso
 * do caminho — e inferência é o que se quer evitar.
 *
 * @param {string} path
 * @returns {string}
 */
export function phaseFor(path) {
  const clean = String(path ?? '').split('?')[0];
  if (clean.startsWith('/api/health')) return 'healthcheck';
  if (clean.startsWith('/api/report')) return 'functional';
  return 'runtime';
}

/**
 * @param {number} statusCode
 * @returns {'info'|'warn'|'error'}
 */
export function levelFor(statusCode) {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
}
