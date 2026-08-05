/**
 * Dia 3 — divisão treino/teste e avaliação sem vazamento temporal.
 *
 * Dois cuidados que valem a aula inteira:
 *
 * 1. **A divisão separa sequências inteiras, nunca janelas.** Janelas vizinhas
 *    compartilham quase todo o passado: a janela 4 e a janela 5 da mesma
 *    sequência têm as mesmas três medições no cálculo da tendência. Sortear
 *    janelas colocaria parte do passado do teste dentro do treino, e a métrica
 *    resultante mediria memória, não previsão.
 * 2. **O teste não participa de nada além de ser medido.** Média, desvio e
 *    limiar saem do treino (ou são constantes declaradas). Se o conjunto de
 *    teste influenciasse o scaler, a avaliação já estaria contaminada antes da
 *    primeira previsão.
 *
 * A divisão é **estratificada por padrão e determinística**: dos 10 exemplares
 * de cada padrão, os 3 primeiros vão para o teste e os 7 restantes para o
 * treino. Um sorteio global daria 70/30 no total e poderia, num azar, deixar o
 * teste sem nenhum pico transitório — justamente o caso que a avaliação
 * precisa cobrir.
 */

import { buildDataset } from './features.mjs';
import { predictProbability } from './logistic-regression.mjs';

/** Proporção do treino. O teste é o complemento. */
export const TRAIN_RATIO = 0.7;

/** Limiar de decisão do laboratório. Constante declarada, não ajustada em dados. */
export const DECISION_THRESHOLD = 0.7;

/** Faixas visuais do painel. A ordem é do menor risco para o maior. */
export const RISK_BANDS = Object.freeze([
  { id: 'low', max: 0.4, label: 'Risco baixo — observar', icon: '●' },
  { id: 'attention', max: 0.7, label: 'Atenção — investigar', icon: '▲' },
  { id: 'likely', max: Infinity, label: 'Falha provável — mitigar', icon: '■' },
]);

/** Quantidade de faixas do histograma de probabilidades. */
const HISTOGRAM_BINS = 10;

/**
 * A faixa de decisão de uma probabilidade.
 *
 * @param {number} probability
 * @returns {{ id: string, label: string, icon: string }}
 */
export function riskBand(probability) {
  const band = RISK_BANDS.find((candidate) => probability < candidate.max) ?? RISK_BANDS.at(-1);
  return { id: band.id, label: band.label, icon: band.icon };
}

/**
 * Divide as sequências em treino e teste, estratificando por padrão.
 *
 * @param {Array<{ id: string, pattern: string }>} sequences
 * @param {object} [options]
 * @param {number} [options.trainRatio]
 * @returns {{ train: object[], test: object[] }}
 */
export function splitSequences(sequences, { trainRatio = TRAIN_RATIO } = {}) {
  const byPattern = new Map();
  for (const sequence of sequences) {
    if (!byPattern.has(sequence.pattern)) byPattern.set(sequence.pattern, []);
    byPattern.get(sequence.pattern).push(sequence);
  }

  const train = [];
  const test = [];

  for (const group of byPattern.values()) {
    const testCount = Math.max(1, Math.round(group.length * (1 - trainRatio)));
    group.forEach((sequence, index) => {
      if (index < testCount) test.push(sequence);
      else train.push(sequence);
    });
  }

  return { train, test };
}

/**
 * Métricas de classificação binária no limiar informado.
 *
 * Toda divisão é protegida: sem positivos previstos, `precision` é 0 e não
 * `NaN`. Um `NaN` num painel é pior que um zero, porque parece um bug do
 * relatório em vez de uma informação sobre o modelo.
 *
 * @param {number[]} probabilities
 * @param {number[]} labels
 * @param {number} [threshold]
 * @returns {object}
 */
export function computeMetrics(probabilities, labels, threshold = DECISION_THRESHOLD) {
  const matrix = { truePositives: 0, falsePositives: 0, trueNegatives: 0, falseNegatives: 0 };

  probabilities.forEach((probability, index) => {
    const predicted = probability >= threshold;
    const actual = labels[index] === 1;
    if (predicted && actual) matrix.truePositives += 1;
    else if (predicted && !actual) matrix.falsePositives += 1;
    else if (!predicted && actual) matrix.falseNegatives += 1;
    else matrix.trueNegatives += 1;
  });

  const total = probabilities.length;
  const precision = safeRatio(
    matrix.truePositives,
    matrix.truePositives + matrix.falsePositives,
  );
  const recall = safeRatio(matrix.truePositives, matrix.truePositives + matrix.falseNegatives);

  return {
    threshold,
    confusionMatrix: matrix,
    accuracy: safeRatio(matrix.truePositives + matrix.trueNegatives, total),
    precision,
    recall,
    f1Score: safeRatio(2 * precision * recall, precision + recall),
    examples: total,
    positiveExamples: labels.filter((label) => label === 1).length,
    negativeExamples: labels.filter((label) => label !== 1).length,
  };
}

/**
 * Distribuição das probabilidades por classe real, em 10 faixas de 0,1.
 *
 * É o gráfico que mostra *como* o modelo erra: um positivo previsto com 0,72 e
 * um previsto com 0,99 contam igual na matriz de confusão e não significam a
 * mesma coisa.
 *
 * @param {number[]} probabilities
 * @param {number[]} labels
 * @returns {Array<{ from: number, to: number, positives: number, negatives: number }>}
 */
export function probabilityDistribution(probabilities, labels) {
  const bins = Array.from({ length: HISTOGRAM_BINS }, (_value, index) => ({
    from: index / HISTOGRAM_BINS,
    to: (index + 1) / HISTOGRAM_BINS,
    positives: 0,
    negatives: 0,
  }));

  probabilities.forEach((probability, index) => {
    const slot = Math.min(HISTOGRAM_BINS - 1, Math.floor(probability * HISTOGRAM_BINS));
    if (labels[index] === 1) bins[slot].positives += 1;
    else bins[slot].negatives += 1;
  });

  return bins;
}

/**
 * Avalia um modelo sobre um conjunto de sequências.
 *
 * @param {object} input
 * @param {object} input.model
 * @param {object[]} input.sequences
 * @param {number} [input.threshold]
 * @returns {object} métricas + distribuição + probabilidades
 */
export function evaluateModel({ model, sequences, threshold = DECISION_THRESHOLD }) {
  const { rows, labels } = buildDataset(sequences);
  const probabilities = rows.map((row) => predictProbability(model, row));

  return {
    ...computeMetrics(probabilities, labels, threshold),
    sequences: sequences.length,
    distribution: probabilityDistribution(probabilities, labels),
    probabilities,
    labels,
  };
}

/**
 * Divisão protegida: denominador zero devolve 0, nunca `NaN` nem `Infinity`.
 *
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number}
 */
export function safeRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) ? ratio : 0;
}
