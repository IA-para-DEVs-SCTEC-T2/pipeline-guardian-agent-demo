import { Router } from 'express';

import { createLatencyAnomaly } from '../demo-anomalies.js';
import { describeError, logEvent } from '../logging/structured-logger.js';
import { buildReport } from '../services/report.js';
import { listStickers } from '../store/store.js';

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
 * O laboratório do Dia 2 entra aqui, e só aqui: `demoAnomaly` é o middleware de
 * `demo-anomalies.js`, inerte enquanto `DEMO_ANOMALY_MODE` não pedir um cenário.
 * Ele fica **antes** do handler porque a anomalia é atraso na resposta, não
 * mudança no relatório — o corpo devolvido é o mesmo com ou sem cenário ligado.
 *
 * @param {object} [options]
 * @param {object} [options.log] emissor injetável (testes)
 * @param {() => object} [options.build] produtor do relatório — injetável para
 *        que o caminho de falha seja exercitável sem corromper o store real
 * @param {import('express').RequestHandler} [options.demoAnomaly] cenário do Dia 2
 * @returns {import('express').Router}
 */
export function createReportRouter({
  log = logEvent,
  build = defaultBuild,
  demoAnomaly = createLatencyAnomaly({ log }),
} = {}) {
  const router = Router();

  router.get('/', demoAnomaly, (req, res, next) => {
    try {
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
