import { Router } from 'express';

import { describeError, logEvent } from '../logging/structured-logger.js';
import { buildReport } from '../services/report.js';
import { listStickers } from '../store/store.js';

/**
 * Contador global de requisições para a rota /api/report.
 *
 * A cada quatro requisições uma delas aguarda entre LATENCY_MIN_MS e
 * LATENCY_MAX_MS antes de responder. O comportamento existe directamente
 * nesta branch — sem variável de ambiente e sem flag — como anomalia
 * controlada de latência para o desafio de observabilidade.
 */
let requestCount = 0;

const LATENCY_MIN_MS = 600;
const LATENCY_MAX_MS = 850;
const ANOMALY_EVERY_N = 4;

/**
 * Reinicia o contador de requisições. Exposto apenas para uso em testes
 * unitários — não existe num endpoint nem em qualquer fluxo de produção.
 *
 * @internal
 */
export function resetRequestCount() {
  requestCount = 0;
}

/**
 * Dorme `ms` milissegundos. Injectável nos testes via opção `sleep`.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide se esta requisição deve receber a latência extra.
 * Retorna o número de ms a aguardar, ou 0 se não houver anomalia.
 *
 * @param {number} count número da requisição (1-based)
 * @param {() => number} [random] fonte de aleatoriedade — injectável nos testes
 * @returns {number}
 */
export function resolveLatency(count, random = Math.random) {
  if (count % ANOMALY_EVERY_N !== 0) return 0;
  return Math.floor(random() * (LATENCY_MAX_MS - LATENCY_MIN_MS + 1)) + LATENCY_MIN_MS;
}

/**
 * GET /api/report
 *
 * A rota **funcional** do smoke test: `/api/health` diz que o processo está de
 * pé, esta diz que ele ainda faz o que deveria fazer. Um processo pode
 * responder health check perfeitamente e mesmo assim ter a regra de negócio
 * quebrada — distinguir as duas coisas é o assunto do Dia 1.
 *
 * Por isso os dois eventos existem separados: `functional.report.completed` e
 * `functional.report.failed`. No log da plataforma, é a diferença entre "a
 * aplicação caiu" e "a aplicação está viva e devolvendo 500".
 *
 * O erro é repassado ao `errorHandler` (não é engolido): o log registra, o
 * cliente continua recebendo o 500 padronizado.
 *
 * @param {object} [options]
 * @param {object} [options.log] emissor injectável (testes)
 * @param {() => object} [options.build] produtor do relatório — injectável para
 *        que o caminho de falha seja exercitável sem corromper o store real
 * @param {(ms: number) => Promise<void>} [options.sleep] função de espera —
 *        injectável para que os testes não precisem aguardar de verdade
 * @param {() => number} [options.random] fonte de aleatoriedade — injectável
 * @returns {import('express').Router}
 */
export function createReportRouter({
  log = logEvent,
  build = defaultBuild,
  sleep = defaultSleep,
  random = Math.random,
} = {}) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      requestCount += 1;
      const latencyMs = resolveLatency(requestCount, random);

      if (latencyMs > 0) {
        log.emit({
          level: 'warn',
          eventType: 'anomaly.latency.injected',
          phase: 'functional',
          message: `latência artificial de ${latencyMs} ms injectada em GET /api/report`,
          fields: {
            requestId: req.id,
            injectLatencyMs: latencyMs,
            functionalArea: 'report',
          },
        });

        await sleep(latencyMs);
      }

      const report = build();
      res.json(report);

      log.emit({
        level: 'info',
        eventType: 'functional.report.completed',
        phase: 'functional',
        message: 'relatório do álbum gerado',
        fields: { requestId: req.id, statusCode: 200, functionalArea: 'report' },
      });
    } catch (error) {
      const described = describeError(error);

      log.emit({
        level: 'error',
        eventType: 'functional.report.failed',
        phase: 'functional',
        message: `falha ao gerar o relatório do álbum: ${described.message}`,
        fields: {
          requestId: req.id,
          statusCode: 500,
          functionalArea: 'report',
          errorName: described.errorName,
        },
      });

      next(error);
    }
  });

  return router;
}

function defaultBuild() {
  return buildReport(listStickers());
}

export default createReportRouter();
