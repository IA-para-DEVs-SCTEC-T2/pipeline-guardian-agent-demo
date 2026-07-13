import express from 'express';
import cors from 'cors';

import { requestId } from './middleware/requestId.js';
import { logger } from './middleware/logger.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

import healthRouter from './routes/health.js';
import stickersRouter from './routes/stickers.js';
import reportRouter from './routes/report.js';

/**
 * Cria e configura a aplicação Express.
 *
 * app.js é separado de server.js para permitir testes de integração
 * sem abrir uma porta de rede.
 *
 * @returns {import('express').Express}
 */
export function createApp() {
  const app = express();

  const corsOrigin = process.env.CORS_ORIGIN || '*';

  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());
  app.use(requestId);
  app.use(logger);

  app.use('/api/health', healthRouter);
  app.use('/api/stickers', stickersRouter);
  app.use('/api/report', reportRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
