/**
 * Logger simples em JSON.
 *
 * Nunca imprime headers sensíveis (Authorization, Cookie) nem o corpo da
 * requisição, para evitar vazamento de credenciais nos logs.
 */
export function logger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const line = {
      level: res.statusCode >= 500 ? 'error' : 'info',
      time: new Date().toISOString(),
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    };
    // Impressão em JSON de uma linha; sem Authorization/Cookie.
    process.stdout.write(`${JSON.stringify(line)}\n`);
  });

  next();
}
