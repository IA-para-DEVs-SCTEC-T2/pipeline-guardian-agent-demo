/**
 * Health check do container.
 *
 * Usado pelo `HEALTHCHECK` do Dockerfile e pelo `healthcheck` do
 * `compose.yaml`. Usa o Node que já está na imagem — não há motivo para
 * instalar `curl` ou `wget` só para bater em uma URL local.
 *
 * Exit code 0 = saudável; qualquer outro = não saudável.
 */

const PORT = Number(process.env.PORT) || 3001;
const TIMEOUT_MS = Number(process.env.HEALTHCHECK_TIMEOUT_MS) || 4000;
const URL_ = `http://127.0.0.1:${PORT}/api/health`;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

try {
  const response = await fetch(URL_, { signal: controller.signal });
  const body = await response.json();

  // 200 não basta: o corpo precisa declarar `status: "ok"`.
  process.exit(response.ok && body?.status === 'ok' ? 0 : 1);
} catch {
  process.exit(1);
} finally {
  clearTimeout(timer);
}
