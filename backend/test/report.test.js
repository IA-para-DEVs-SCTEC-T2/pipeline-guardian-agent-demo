import { describe, it, expect } from 'vitest';
import { buildReport, duplicateCopies } from '../src/services/report.js';

describe('duplicateCopies', () => {
  it('retorna 0 quando quantity é 0', () => {
    expect(duplicateCopies(0)).toBe(0);
  });

  it('retorna 0 quando quantity é 1 (sem repetidas)', () => {
    expect(duplicateCopies(1)).toBe(0);
  });

  it('retorna quantity - 1 quando há repetidas', () => {
    expect(duplicateCopies(3)).toBe(2);
  });
});

describe('buildReport: percentual de conclusão', () => {
  it('calcula o percentual arredondado de figurinhas obtidas', () => {
    const report = buildReport([
      { id: 'a', albumNumber: 1, playerName: 'X', country: 'Brasil', countryCode: 'BR', position: 'forward', quantity: 0 },
      { id: 'b', albumNumber: 2, playerName: 'Y', country: 'Brasil', countryCode: 'BR', position: 'forward', quantity: 2 },
    ]);
    expect(report.totalRegistered).toBe(2);
    expect(report.obtained).toBe(1);
    expect(report.missing).toBe(1);
    expect(report.completionPercentage).toBe(50);
    expect(report.duplicateCopies).toBe(1);
  });

  it('retorna 0% quando não há figurinhas cadastradas', () => {
    const report = buildReport([]);
    expect(report.totalRegistered).toBe(0);
    expect(report.completionPercentage).toBe(0);
  });

  it('retorna 100% quando todas foram obtidas', () => {
    const report = buildReport([
      { id: 'a', albumNumber: 1, playerName: 'X', country: 'Brasil', countryCode: 'BR', position: 'forward', quantity: 1 },
      { id: 'b', albumNumber: 2, playerName: 'Y', country: 'Brasil', countryCode: 'BR', position: 'forward', quantity: 1 },
    ]);
    expect(report.completionPercentage).toBe(100);
    expect(report.missing).toBe(0);
  });
});

describe('buildReport: agrupamento por país', () => {
  it('agrupa totais, obtidas, faltantes e repetidas por país', () => {
    const report = buildReport([
      { id: 'a', albumNumber: 1, playerName: 'X', country: 'Brasil', countryCode: 'BR', position: 'forward', quantity: 0 },
      { id: 'b', albumNumber: 2, playerName: 'Y', country: 'Brasil', countryCode: 'BR', position: 'defender', quantity: 3 },
      { id: 'c', albumNumber: 3, playerName: 'Z', country: 'Argentina', countryCode: 'AR', position: 'goalkeeper', quantity: 1 },
    ]);

    expect(report.byCountry).toHaveLength(2);

    const brasil = report.byCountry.find((c) => c.country === 'Brasil');
    expect(brasil.total).toBe(2);
    expect(brasil.obtained).toBe(1);
    expect(brasil.missing).toBe(1);
    expect(brasil.duplicateCopies).toBe(2);

    const argentina = report.byCountry.find((c) => c.country === 'Argentina');
    expect(argentina.total).toBe(1);
    expect(argentina.obtained).toBe(1);
    expect(argentina.missing).toBe(0);
  });

  it('ordena os países por ordem alfabética', () => {
    const report = buildReport([
      { id: 'a', albumNumber: 1, playerName: 'X', country: 'Portugal', countryCode: 'PT', position: 'forward', quantity: 1 },
      { id: 'b', albumNumber: 2, playerName: 'Y', country: 'Argentina', countryCode: 'AR', position: 'defender', quantity: 1 },
    ]);
    expect(report.byCountry.map((c) => c.country)).toEqual(['Argentina', 'Portugal']);
  });
});

describe('buildReport: listas de faltantes e repetidas', () => {
  it('lista as figurinhas faltantes e repetidas com seus dados', () => {
    const report = buildReport([
      { id: 'a', albumNumber: 1, playerName: 'Faltante', country: 'Brasil', countryCode: 'BR', position: 'forward', quantity: 0 },
      { id: 'b', albumNumber: 2, playerName: 'Repetida', country: 'Brasil', countryCode: 'BR', position: 'defender', quantity: 3 },
    ]);

    expect(report.missingStickers).toHaveLength(1);
    expect(report.missingStickers[0].playerName).toBe('Faltante');

    expect(report.duplicateStickers).toHaveLength(1);
    expect(report.duplicateStickers[0].playerName).toBe('Repetida');
    expect(report.duplicateStickers[0].duplicateCopies).toBe(2);
  });
});
