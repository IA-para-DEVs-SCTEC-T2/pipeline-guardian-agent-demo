import { Router } from 'express';

import { logEvent } from '../logging/structured-logger.js';
import { releaseInfo, uptimeSeconds } from '../release.js';

/**
 * GET /api/health
 *
 * Responde 200 enquanto o processo consegue atender. Devolve apenas metadados
 * não sensíveis: nada de `process.env`, tokens ou configuração interna.
 *
 * É este endpoint que o Docker `HEALTHCHECK`, o Railway e o smoke test
 * pós-deployment consultam.
 *
 * Além da resposta, emite `health.check.completed` no log estruturado. O corpo
 * da resposta some assim que a requisição termina; o evento fica no log da
 * plataforma, e é ele que o diagnóstico operacional consegue ler depois para
 * dizer "o processo estava vivo às 13:02".
 *
 * @param {object} [options]
 * @param {object} [options.log] emissor injetável (testes)
 * @returns {import('express').Router}
 */
export function createHealthRouter({ log = logEvent } = {}) {
  const router = Router();

  router.get('/', (req, res) => {
    const release = releaseInfo();

    res.json({
      status: 'ok',
      ...release,
      uptimeSeconds: uptimeSeconds(),
      timestamp: new Date().toISOString(),
      requestId: req.id,
    });

    log.emit({
      level: 'info',
      eventType: 'health.check.completed',
      phase: 'healthcheck',
      message: 'health check respondido',
      fields: { requestId: req.id, statusCode: 200, healthStatus: 'ok' },
    });
  });

  return router;
}

export default createHealthRouter();
