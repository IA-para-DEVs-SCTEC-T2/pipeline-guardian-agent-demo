import { describe, it, expect } from 'vitest';
import {
  getInitials,
  stickerStatus,
  filterStickers,
  buildReportText,
} from './utils.js';

describe('getInitials', () => {
  it('retorna duas iniciais de nome composto', () => {
    expect(getInitials('Lucas Ferreira')).toBe('LF');
  });
  it('lida com nome único', () => {
    expect(getInitials('Ronaldo')).toBe('RO');
  });
  it('lida com vazio', () => {
    expect(getInitials('')).toBe('?');
  });
});

describe('stickerStatus', () => {
  it('classifica faltante, obtida e repetida', () => {
    expect(stickerStatus({ quantity: 0 })).toBe('missing');
    expect(stickerStatus({ quantity: 1 })).toBe('obtained');
    expect(stickerStatus({ quantity: 4 })).toBe('duplicate');
  });
});

describe('filterStickers', () => {
  const data = [
    { playerName: 'Lucas Ferreira', country: 'Brasil', quantity: 3 },
    { playerName: 'Diego Sosa', country: 'Argentina', quantity: 0 },
    { playerName: 'Hugo Lefevre', country: 'França', quantity: 1 },
  ];

  it('filtra por busca de nome', () => {
    const out = filterStickers(data, { search: 'diego' });
    expect(out).toHaveLength(1);
    expect(out[0].playerName).toBe('Diego Sosa');
  });

  it('filtra por país', () => {
    expect(filterStickers(data, { country: 'Brasil' })).toHaveLength(1);
  });

  it('filtra por situação repetidas', () => {
    const out = filterStickers(data, { status: 'duplicate' });
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(3);
  });

  it('status all não filtra', () => {
    expect(filterStickers(data, { status: 'all' })).toHaveLength(3);
  });
});

describe('buildReportText', () => {
  it('inclui percentual e país', () => {
    const text = buildReportText({
      completionPercentage: 75,
      totalRegistered: 12,
      obtained: 9,
      missing: 3,
      duplicateCopies: 5,
      byCountry: [{ country: 'Brasil', countryCode: 'BR', obtained: 2, total: 3 }],
      missingStickers: [],
      duplicateStickers: [],
    });
    expect(text).toContain('Conclusão: 75%');
    expect(text).toContain('Brasil (BR): 2/3');
  });
});
