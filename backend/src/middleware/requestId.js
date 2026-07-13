import { randomUUID } from 'node:crypto';

/**
 * Anexa um identificador único a cada requisição e o expõe no header.
 */
export function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
}
