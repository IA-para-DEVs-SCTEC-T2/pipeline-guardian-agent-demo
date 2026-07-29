import { releaseInfo } from '../release.js';

/**
 * Logger estruturado em JSON, uma linha por requisição.
 *
 * Escreve em `stdout` de propósito: é assim que Docker, Railway e GitHub
 * Actions coletam o log — sem arquivo, sem agente e sem biblioteca de
 * observabilidade.
 *
 * Nunca imprime headers sensíveis (Authorization, Cookie), corpo de requisição
 * nem variáveis de ambiente: só o que identifica a requisição e a release.
 */
export function logger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const line = {
      level: res.statusCode >= 500 ? 'error' : 'info',
      time: new Date().toISOString(),
      ...releaseInfo(),
      message: `${req.method} ${req.originalUrl} ${res.statusCode}`,
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  });

  next();
}
