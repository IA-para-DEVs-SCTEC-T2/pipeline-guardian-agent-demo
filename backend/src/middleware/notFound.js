/**
 * Middleware 404 para rotas não mapeadas.
 */
export function notFound(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Rota não encontrada: ${req.method} ${req.originalUrl}`,
    },
    requestId: req.id,
  });
}
