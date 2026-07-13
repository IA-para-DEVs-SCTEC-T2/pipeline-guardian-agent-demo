/**
 * Calcula o número de repetidas de uma figurinha.
 * @param {number} quantity
 * @returns {number}
 */
export function duplicateCopies(quantity) {
  return Math.max(quantity - 1, 0);
}

/**
 * Gera o relatório consolidado do álbum.
 * @param {Array<object>} stickers
 * @returns {object}
 */
export function buildReport(stickers) {
  const totalRegistered = stickers.length;
  const obtained = stickers.filter((s) => s.quantity >= 1).length;
  const missing = totalRegistered - obtained;
  const totalDuplicateCopies = stickers.reduce(
    (acc, s) => acc + duplicateCopies(s.quantity),
    0,
  );

  const completionPercentage =
    totalRegistered === 0 ? 0 : Math.round((obtained / totalRegistered) * 100);

  const byCountry = {};
  for (const s of stickers) {
    if (!byCountry[s.country]) {
      byCountry[s.country] = {
        country: s.country,
        countryCode: s.countryCode,
        total: 0,
        obtained: 0,
        missing: 0,
        duplicateCopies: 0,
      };
    }
    const entry = byCountry[s.country];
    entry.total += 1;
    if (s.quantity >= 1) entry.obtained += 1;
    else entry.missing += 1;
    entry.duplicateCopies += duplicateCopies(s.quantity);
  }

  const missingStickers = stickers
    .filter((s) => s.quantity === 0)
    .map(toSummary);

  const duplicateStickers = stickers
    .filter((s) => s.quantity > 1)
    .map((s) => ({ ...toSummary(s), duplicateCopies: duplicateCopies(s.quantity) }));

  return {
    totalRegistered,
    obtained,
    missing,
    duplicateCopies: totalDuplicateCopies,
    completionPercentage,
    byCountry: Object.values(byCountry).sort((a, b) =>
      a.country.localeCompare(b.country),
    ),
    missingStickers,
    duplicateStickers,
  };
}

/**
 * @param {object} sticker
 * @returns {object} resumo enxuto usado no relatório
 */
function toSummary(sticker) {
  return {
    id: sticker.id,
    albumNumber: sticker.albumNumber,
    playerName: sticker.playerName,
    country: sticker.country,
    countryCode: sticker.countryCode,
    position: sticker.position,
    quantity: sticker.quantity,
  };
}
