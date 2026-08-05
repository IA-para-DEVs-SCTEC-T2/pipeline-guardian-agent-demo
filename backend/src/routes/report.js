import { Router } from 'express';

import { createDemoAnomaly } from '../demo-anomalies.js';
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
 * Ele fica **antes** do handler porque nenhum cenário mexe no relatório: o
 * `latency` atrasa a resposta, o `error-rate` a substitui por um 500 do
 * `errorHandler` e o `payload-bloat` envolve `res.json` para repetir uma lista
 * **na saída**, depois de o relatório já estar montado. `buildReport`, o store e
 * este handler não sabem que qualquer um deles existe — e sem a variável, o
 * `res.json` que a rota chama é o do Express, sem nenhuma camada em volta.
 *
 * A requisição reprovada pelo `error-rate` não emite `functional.report.failed`:
 * o handler nem chega a rodar, e registrar "falha ao gerar o relatório" quando o
 * relatório não foi gerado seria o laboratório mentindo sobre o próprio efeito.
 * O evento que existe é `demo.anomaly.error-rate`, com o nome da causa.
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
  demoAnomaly = createDemoAnomaly({ log }),
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
