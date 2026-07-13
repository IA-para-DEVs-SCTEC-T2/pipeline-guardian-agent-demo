/**
 * Compartilha um texto usando navigator.share quando disponível,
 * com fallback para navigator.clipboard.writeText.
 *
 * Não usa bibliotecas externas.
 *
 * @param {{title?: string, text: string}} payload
 * @returns {Promise<'shared'|'copied'|'unsupported'>}
 */
export async function shareText({ title = 'CopaFigurinhas', text }) {
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ title, text });
      return 'shared';
    } catch (err) {
      // Usuário cancelou o diálogo de compartilhamento: não é erro.
      if (err && err.name === 'AbortError') return 'shared';
      // Cai para o fallback de cópia.
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return 'copied';
  }

  return 'unsupported';
}

/**
 * Copia texto para a área de transferência.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return false;
}
