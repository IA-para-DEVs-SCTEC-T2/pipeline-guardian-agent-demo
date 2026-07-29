/**
 * Ancoragem de evidências.
 *
 * O antídoto contra citação inventada: uma evidência só sobrevive se o trecho
 * citado existir de fato no material coletado. O que não existe é descartado e
 * vira limitação declarada.
 *
 * Usado tanto pelo diagnóstico de pipeline (`analyze-pipeline.mjs`) quanto pelo
 * diagnóstico de deployment (`analyze-deployment.mjs`) — a regra é a mesma, e
 * ter duas cópias dela seria ter duas oportunidades de afrouxá-la.
 */

/** Trechos curtos demais casam com qualquer coisa: não sustentam nada. */
export const MIN_GROUNDED_EXCERPT_LENGTH = 12;

/**
 * Normaliza para comparação: espaços colapsados, sem caixa. Isso tolera
 * reindentação e quebra de linha, sem tolerar texto inventado.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeForGrounding(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Mantém apenas as evidências cujo trecho aparece no material coletado.
 *
 * @param {Array<{ source: string, excerpt: string }>} evidence citações do modelo
 * @param {Array<{ source: string, content: string }>} textSources material coletado
 * @returns {{ evidence: Array<object>, grounded: boolean, dropped: number }}
 */
export function groundEvidenceAgainst(evidence = [], textSources = []) {
  const haystack = normalizeForGrounding(
    textSources.map((entry) => entry.content).join('\n'),
  );

  const kept = evidence.filter((item) => {
    const needle = normalizeForGrounding(item.excerpt);
    if (needle.length < MIN_GROUNDED_EXCERPT_LENGTH) return false;
    return haystack.includes(needle);
  });

  return { evidence: kept, grounded: kept.length > 0, dropped: evidence.length - kept.length };
}
