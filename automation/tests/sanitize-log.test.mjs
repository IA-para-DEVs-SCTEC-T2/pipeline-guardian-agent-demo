import { describe, it, expect } from 'vitest';

import { sanitizeLog } from '../src/sanitize-log.mjs';

const ESC = String.fromCharCode(27);

describe('sanitizeLog', () => {
  it('remove códigos ANSI de cor e estilo', () => {
    const input = `${ESC}[31m${ESC}[1mFAIL${ESC}[22m ${ESC}[7mreport.test.js${ESC}[27m${ESC}[0m`;
    const output = sanitizeLog(input);

    expect(output).not.toContain(ESC);
    expect(output).toBe('FAIL report.test.js');
  });

  it('remove carriage returns', () => {
    const output = sanitizeLog('linha 1\r\nlinha 2\rlinha 3');

    expect(output).not.toContain('\r');
    expect(output).toBe('linha 1\nlinha 2linha 3');
  });

  it('remove caracteres de controle perigosos preservando tab e nova linha', () => {
    const withControlChars = `a${String.fromCharCode(7)} bc\td\ne`;
    const output = sanitizeLog(withControlChars);

    expect(output).toBe('a bc\td\ne');
  });

  it('colapsa linhas separadoras longas mantendo o texto legível', () => {
    const separator = `${'⎯'.repeat(80)}[5/8]⎯`;
    const output = sanitizeLog(`antes\n${separator}\ndepois`);

    expect(output).toContain('antes');
    expect(output).toContain('depois');
    expect(output.length).toBeLessThan(separator.length + 20);
  });

  it('limita o tamanho total preservando quebras de linha', () => {
    const huge = Array.from({ length: 1000 }, (_, i) => `linha ${i}`).join('\n');
    const output = sanitizeLog(huge, { maxLength: 100 });

    expect(output.length).toBeLessThan(200);
    expect(output).toContain('truncado');
    expect(output.split('\n').length).toBeGreaterThan(1);
  });

  it('devolve string vazia para entrada vazia ou não textual', () => {
    expect(sanitizeLog('')).toBe('');
    expect(sanitizeLog(undefined)).toBe('');
    expect(sanitizeLog(null)).toBe('');
  });
});
