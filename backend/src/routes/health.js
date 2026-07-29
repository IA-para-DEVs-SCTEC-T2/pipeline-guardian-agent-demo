import { Router } from 'express';

import { releaseInfo, uptimeSeconds } from '../release.js';

const router = Router();

/**
 * GET /api/health
 *
 * Responde 200 enquanto o processo consegue atender. Devolve apenas metadados
 * não sensíveis: nada de `process.env`, tokens ou configuração interna.
 *
 * É este endpoint que o Docker `HEALTHCHECK`, o Railway e o smoke test
 * pós-deployment consultam.
 */
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    ...releaseInfo(),
    uptimeSeconds: uptimeSeconds(),
    timestamp: new Date().toISOString(),
    requestId: req.id,
  });
});

export default router;
