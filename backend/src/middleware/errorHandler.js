import { ZodError } from 'zod';

/**
 * Erro de aplicação com status HTTP associado.
 */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Handler de erro centralizado com resposta padronizada.
 */
// eslint-disable-next-line no-unused-vars -- Express identifica o handler de erro pela aridade (4 args).
export function errorHandler(err, req, res, next) {
  // Erros de validação do Zod -> 400
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos',
        details: err.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
      requestId: req.id,
    });
  }

  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message },
      requestId: req.id,
    });
  }

  // Erro inesperado -> 500
  const line = {
    level: 'error',
    time: new Date().toISOString(),
    requestId: req.id,
    message: err.message,
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);

  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Erro interno do servidor' },
    requestId: req.id,
  });
}
