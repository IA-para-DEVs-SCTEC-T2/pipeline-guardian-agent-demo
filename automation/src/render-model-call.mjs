/**
 * Bloco "chamada ao modelo" dos relatórios em Markdown.
 *
 * Compartilhado pelos dois renderizadores (pipeline e deployment) porque é
 * exatamente a mesma informação: qual modelo respondeu, quanto demorou, quantos
 * tokens custou e se o diagnóstico veio dele ou do fallback.
 *
 * O que **não** aparece aqui: a chave, os headers, o conteúdo enviado, a
 * mensagem de erro do SDK. Quando a chamada falha, o relatório mostra a
 * categoria (`timeout`, `rate_limit`, …) e nada além disso.
 *
 * Nada neste bloco entra em decisão de CI ou de CD — é conta de luz.
 *
 * As contagens são **números**, formatados aqui: nunca passam por redação, e é
 * por isso que `Tokens: 1.300` chega inteiro ao relatório. Os dois campos de
 * texto que vêm da resposta da API (nome do modelo e id) são redigidos ao
 * entrar.
 */

import { redactSecrets } from './redact-secrets.mjs';

const NOT_AVAILABLE = '—';

const ERROR_CATEGORY_LABELS = {
  authentication: 'autenticação recusada',
  rate_limit: 'limite de requisições',
  timeout: 'tempo esgotado',
  network: 'falha de rede',
  invalid_output: 'saída fora do schema',
  incomplete: 'resposta incompleta',
  unknown: 'não identificada',
};

/**
 * @param {object} diagnosis diagnóstico já validado
 * @returns {string[]} linhas Markdown (vazio quando o relatório é anterior a
 *                     estes metadados)
 */
export function renderModelCallLines(diagnosis) {
  // Relatórios gerados antes desta versão não têm os campos: melhor omitir a
  // seção do que inventar "desconhecido" para tudo.
  if (!diagnosis.model && !diagnosis.modelProvider) return [];

  const lines = [];
  lines.push(
    `- Modelo: \`${text(diagnosis.model)}\` (${text(diagnosis.modelProvider)})`,
  );
  lines.push(`- Fallback: ${diagnosis.usedFallback ? 'sim' : 'não'}`);
  lines.push(`- Latência: ${formatLatency(diagnosis.modelLatencyMs)}`);
  lines.push(`- Tokens: ${formatUsage(diagnosis.modelUsage)}`);

  if (diagnosis.modelResponseId) {
    lines.push(`- Resposta: \`${text(diagnosis.modelResponseId)}\``);
  }
  if (diagnosis.modelErrorCategory) {
    const label = ERROR_CATEGORY_LABELS[diagnosis.modelErrorCategory] ?? 'não identificada';
    lines.push(`- Falha da chamada: \`${diagnosis.modelErrorCategory}\` (${label})`);
  }

  return lines;
}

/**
 * @param {number|null|undefined} milliseconds
 * @returns {string}
 */
export function formatLatency(milliseconds) {
  if (!Number.isFinite(milliseconds)) return NOT_AVAILABLE;
  if (milliseconds < 1000) return `${formatNumber(milliseconds)} ms`;

  return `${(milliseconds / 1000).toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} s`;
}

/**
 * @param {object|null|undefined} usage
 * @returns {string}
 */
export function formatUsage(usage) {
  if (!usage) return NOT_AVAILABLE;

  const total = Number.isFinite(usage.totalTokens) ? formatNumber(usage.totalTokens) : NOT_AVAILABLE;
  const parts = [
    Number.isFinite(usage.inputTokens) ? `entrada ${formatNumber(usage.inputTokens)}` : null,
    Number.isFinite(usage.outputTokens) ? `saída ${formatNumber(usage.outputTokens)}` : null,
    Number.isFinite(usage.reasoningTokens) ? `raciocínio ${formatNumber(usage.reasoningTokens)}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? `${total} (${parts.join(' · ')})` : total;
}

function formatNumber(value) {
  return Number(value).toLocaleString('pt-BR');
}

/** Texto vindo da resposta da API: redigido antes de entrar no relatório. */
function text(value) {
  return value ? redactSecrets(String(value)) : NOT_AVAILABLE;
}
