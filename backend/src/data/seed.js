/**
 * Dados iniciais fictícios do álbum CopaFigurinhas.
 *
 * Distribuídos entre quatro países (Brasil, Argentina, França, Portugal)
 * e quatro posições (goalkeeper, defender, midfielder, forward),
 * com exemplos de quantity 0, 1, 2 e 3.
 *
 * Nomes de jogadores são fictícios e não representam pessoas reais.
 */

const now = new Date('2026-01-01T12:00:00.000Z').toISOString();

/**
 * @returns {Array<object>} lista de figurinhas iniciais (sem id).
 */
export function seedStickers() {
  const base = [
    // Brasil
    { albumNumber: 1, playerName: 'Marcos Vieira', country: 'Brasil', countryCode: 'BR', position: 'goalkeeper', quantity: 1 },
    { albumNumber: 2, playerName: 'Rafael Andrade', country: 'Brasil', countryCode: 'BR', position: 'defender', quantity: 0 },
    { albumNumber: 3, playerName: 'Lucas Ferreira', country: 'Brasil', countryCode: 'BR', position: 'midfielder', quantity: 3 },
    // Argentina
    { albumNumber: 4, playerName: 'Diego Sosa', country: 'Argentina', countryCode: 'AR', position: 'forward', quantity: 2 },
    { albumNumber: 5, playerName: 'Emiliano Gómez', country: 'Argentina', countryCode: 'AR', position: 'goalkeeper', quantity: 0 },
    { albumNumber: 6, playerName: 'Nicolás Herrera', country: 'Argentina', countryCode: 'AR', position: 'midfielder', quantity: 1 },
    // França
    { albumNumber: 7, playerName: 'Antoine Moreau', country: 'França', countryCode: 'FR', position: 'defender', quantity: 2 },
    { albumNumber: 8, playerName: 'Hugo Lefevre', country: 'França', countryCode: 'FR', position: 'forward', quantity: 1 },
    { albumNumber: 9, playerName: 'Julien Roche', country: 'França', countryCode: 'FR', position: 'midfielder', quantity: 0 },
    // Portugal
    { albumNumber: 10, playerName: 'Bruno Carvalho', country: 'Portugal', countryCode: 'PT', position: 'forward', quantity: 3 },
    { albumNumber: 11, playerName: 'Tiago Fonseca', country: 'Portugal', countryCode: 'PT', position: 'defender', quantity: 1 },
    { albumNumber: 12, playerName: 'André Ramos', country: 'Portugal', countryCode: 'PT', position: 'goalkeeper', quantity: 2 },
  ];

  return base.map((sticker) => ({
    ...sticker,
    createdAt: now,
    updatedAt: now,
  }));
}
