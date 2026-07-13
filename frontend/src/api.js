/**
 * Cliente HTTP mínimo para a API do CopaFigurinhas.
 *
 * A base vem de VITE_API_URL; se ausente, usa caminho relativo (proxy do Vite).
 */
const BASE_URL = import.meta.env.VITE_API_URL || '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (res.status === 204) return null;

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const message = body?.error?.message || 'Erro na requisição';
    const details = body?.error?.details;
    const error = new Error(message);
    error.details = details;
    throw error;
  }

  return body;
}

export const api = {
  health: () => request('/api/health'),
  listStickers: () => request('/api/stickers'),
  createSticker: (data) =>
    request('/api/stickers', { method: 'POST', body: JSON.stringify(data) }),
  changeQuantity: (id, operation) =>
    request(`/api/stickers/${id}/quantity`, {
      method: 'PATCH',
      body: JSON.stringify({ operation }),
    }),
  deleteSticker: (id) => request(`/api/stickers/${id}`, { method: 'DELETE' }),
  getReport: () => request('/api/report'),
};
