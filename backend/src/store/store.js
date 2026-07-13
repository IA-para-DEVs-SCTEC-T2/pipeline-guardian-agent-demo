import { randomUUID } from 'node:crypto';
import { seedStickers } from '../data/seed.js';

/**
 * Store em memória para as figurinhas.
 *
 * ATENÇÃO: os dados vivem apenas enquanto o processo estiver rodando.
 * Não há persistência em banco de dados — reiniciar o servidor recria o seed.
 */

/** @type {Map<string, object>} */
let stickers = new Map();

/**
 * (Re)inicializa o store com os dados de seed. Útil para testes.
 */
export function resetStore() {
  stickers = new Map();
  for (const sticker of seedStickers()) {
    const id = randomUUID();
    stickers.set(id, { id, ...sticker });
  }
}

// Inicializa na primeira importação.
resetStore();

/**
 * @returns {Array<object>} todas as figurinhas ordenadas por albumNumber.
 */
export function listStickers() {
  return [...stickers.values()].sort((a, b) => a.albumNumber - b.albumNumber);
}

/**
 * @param {string} id
 * @returns {object|null}
 */
export function getSticker(id) {
  return stickers.get(id) ?? null;
}

/**
 * @param {number} albumNumber
 * @returns {boolean}
 */
export function albumNumberExists(albumNumber) {
  return [...stickers.values()].some((s) => s.albumNumber === albumNumber);
}

/**
 * Cria uma figurinha. Assume que os dados já foram validados.
 * @param {object} data
 * @returns {object} figurinha criada
 */
export function createSticker(data) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const sticker = {
    id,
    albumNumber: data.albumNumber,
    playerName: data.playerName,
    country: data.country,
    countryCode: data.countryCode,
    position: data.position,
    quantity: data.quantity ?? 0,
    createdAt: now,
    updatedAt: now,
  };
  stickers.set(id, sticker);
  return sticker;
}

/**
 * Aplica increment/decrement na quantidade, nunca abaixo de zero.
 * @param {string} id
 * @param {'increment'|'decrement'} operation
 * @returns {object|null} figurinha atualizada ou null se não existir
 */
export function changeQuantity(id, operation) {
  const sticker = stickers.get(id);
  if (!sticker) return null;

  const delta = operation === 'increment' ? 1 : -1;
  sticker.quantity = Math.max(0, sticker.quantity + delta);
  sticker.updatedAt = new Date().toISOString();
  stickers.set(id, sticker);
  return sticker;
}

/**
 * @param {string} id
 * @returns {boolean} true se removeu, false se não existia
 */
export function deleteSticker(id) {
  return stickers.delete(id);
}
