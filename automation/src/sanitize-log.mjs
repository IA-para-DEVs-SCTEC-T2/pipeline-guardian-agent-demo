/**
 * Sanitização central de logs.
 *
 * Todo log de comando (lint/test/build) passa por aqui antes de ser reduzido a
 * trechos relevantes, escaneado por segredos ou exibido no relatório. Isola o
 * que é "ruído do terminal" (cor ANSI, carriage return, linhas separadoras
 * longas) do que é conteúdo — para que o classificador e o Markdown final
 * nunca vejam a primeira categoria.
 */

import stripAnsi from 'strip-ansi';

const DEFAULT_MAX_LENGTH = 20_000;
/** Linhas como "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/8]⎯" viram um separador curto e legível. */
const SEPARATOR_LINE = /^(\s*)([^\w\s])\2{9,}(.*)$/;
const SEPARATOR_REPLACEMENT_LENGTH = 20;
/** Controle C0/C1 exceto tab e nova linha — não têm nada a fazer num relatório. */
// eslint-disable-next-line no-control-regex -- remoção deliberada de caracteres de controle do log
const DANGEROUS_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Remove ANSI, carriage return e caracteres de controle perigosos; colapsa
 * linhas separadoras longas; limita o tamanho total preservando quebras de
 * linha legíveis.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxLength]
 * @returns {string}
 */
export function sanitizeLog(text, { maxLength = DEFAULT_MAX_LENGTH } = {}) {
  if (typeof text !== 'string' || text.length === 0) return '';

  let output = stripAnsi(text);
  output = output.replace(/\r/g, '');
  output = output.replace(DANGEROUS_CONTROL_CHARS, '');

  output = output
    .split('\n')
    .map((line) => {
      const match = line.match(SEPARATOR_LINE);
      if (!match) return line;
      const [, indent, char, rest] = match;
      return `${indent}${char.repeat(SEPARATOR_REPLACEMENT_LENGTH)}${rest.trim()}`;
    })
    .join('\n');

  if (output.length > maxLength) {
    output = `${output.slice(0, maxLength)}\n… (log truncado em ${maxLength} caracteres)`;
  }

  return output;
}
