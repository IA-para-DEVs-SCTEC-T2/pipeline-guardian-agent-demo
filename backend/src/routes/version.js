import { Router } from 'express';

import { releaseInfo } from '../release.js';

const router = Router();

/**
 * GET /api/version
 *
 * Só os metadados da release. Serve para o smoke test confirmar QUAL versão
 * está no ar antes de validar o comportamento dela — sem depender do resto do
 * payload de `/api/health`, que carrega uptime e timestamp variáveis.
 *
 * A montagem é a mesma de `/api/health` (`releaseInfo`), de propósito: um único
 * lugar decide o que é metadado público de release.
 */
router.get('/', (req, res) => {
  res.json({ ...releaseInfo(), requestId: req.id });
});

export default router;
