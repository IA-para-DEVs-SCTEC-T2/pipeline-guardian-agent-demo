/**
 * Rótulos legíveis das posições.
 */
export const POSITION_LABELS = {
  goalkeeper: 'Goleiro',
  defender: 'Defensor',
  midfielder: 'Meio-campo',
  forward: 'Atacante',
};

export const POSITIONS = Object.keys(POSITION_LABELS);

/**
 * Extrai até duas iniciais do nome do jogador.
 * @param {string} name
 * @returns {string}
 */
export function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Classifica a situação de uma figurinha.
 * @param {{quantity: number}} sticker
 * @returns {'missing'|'obtained'|'duplicate'}
 */
export function stickerStatus(sticker) {
  if (sticker.quantity === 0) return 'missing';
  if (sticker.quantity === 1) return 'obtained';
  return 'duplicate';
}

/**
 * Aplica os filtros de busca, país e situação à lista.
 * @param {Array} stickers
 * @param {{search: string, country: string, status: string}} filters
 * @returns {Array}
 */
export function filterStickers(stickers, filters) {
  const search = (filters.search || '').trim().toLowerCase();
  return stickers.filter((sticker) => {
    if (search && !sticker.playerName.toLowerCase().includes(search)) return false;
    if (filters.country && sticker.country !== filters.country) return false;

    if (filters.status && filters.status !== 'all') {
      const status = stickerStatus(sticker);
      if (filters.status === 'obtained' && sticker.quantity < 1) return false;
      if (filters.status === 'missing' && status !== 'missing') return false;
      if (filters.status === 'duplicate' && status !== 'duplicate') return false;
    }
    return true;
  });
}

/**
 * Monta o texto do relatório para compartilhamento/cópia.
 * @param {object} report
 * @returns {string}
 */
export function buildReportText(report) {
  if (!report) return '';
  const lines = [
    'CopaFigurinhas — Relatório do álbum',
    '',
    `Conclusão: ${report.completionPercentage}%`,
    `Cadastradas: ${report.totalRegistered}`,
    `Obtidas: ${report.obtained}`,
    `Faltantes: ${report.missing}`,
    `Repetidas: ${report.duplicateCopies}`,
    '',
    'Por país:',
    ...report.byCountry.map(
      (c) => `- ${c.country} (${c.countryCode}): ${c.obtained}/${c.total} obtidas`,
    ),
  ];

  if (report.missingStickers.length > 0) {
    lines.push('', 'Faltantes:');
    for (const s of report.missingStickers) {
      lines.push(`- #${s.albumNumber} ${s.playerName} (${s.country})`);
    }
  }

  if (report.duplicateStickers.length > 0) {
    lines.push('', 'Repetidas:');
    for (const s of report.duplicateStickers) {
      lines.push(`- #${s.albumNumber} ${s.playerName}: ${s.duplicateCopies} repetida(s)`);
    }
  }

  return lines.join('\n');
}
