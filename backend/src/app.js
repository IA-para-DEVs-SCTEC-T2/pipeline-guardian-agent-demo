import express from 'express';
import cors from 'cors';

import { requestId } from './middleware/requestId.js';
import { logger } from './middleware/logger.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { mountFrontend } from './static.js';

import healthRouter from './routes/health.js';
import versionRouter from './routes/version.js';
import stickersRouter from './routes/stickers.js';
import reportRouter from './routes/report.js';

/**
 * Cria e configura a aplicação Express.
 *
 * app.js é separado de server.js para permitir testes de integração
 * sem abrir uma porta de rede.
 *
 * A ordem do pipeline importa e é a mesma em desenvolvimento e em produção:
 *
 *   middlewares → rotas `/api` → frontend compilado + fallback da SPA
 *   → 404 da API → tratamento de erro
 *
 * O frontend entra DEPOIS das rotas `/api` e ANTES do `notFound`: assim uma
 * rota inexistente da API cai no 404 em JSON, e só o que não é `/api` recebe o
 * `index.html`.
 *
 * @param {object} [options]
 * @param {boolean} [options.serveFrontend] monta (ou não) o frontend compilado
 * @param {string} [options.frontendDist] diretório compilado alternativo (testes)
 * @param {(line: object) => void} [options.log] emissor de log estruturado
 * @returns {import('express').Express}
 */
export function createApp({ serveFrontend = true, frontendDist, log } = {}) {
  const app = express();

  const corsOrigin = process.env.CORS_ORIGIN || '*';

  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());
  app.use(requestId);
  app.use(logger);

  app.use('/api/health', healthRouter);
  app.use('/api/version', versionRouter);
  app.use('/api/stickers', stickersRouter);
  app.use('/api/report', reportRouter);

  app.locals.frontend = serveFrontend
    ? mountFrontend(app, { dist: frontendDist, log })
    : { mounted: false, dist: null };

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
