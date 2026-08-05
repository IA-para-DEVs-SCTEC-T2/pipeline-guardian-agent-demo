/**
 * Dia 3 — inferência sobre uma sequência, e o que o laboratório faz com ela.
 *
 * Este módulo é o único lugar que sabe a diferença entre um **cenário** e um
 * **desafio**, e ela é só uma: quanto da sequência fica visível.
 *
 * - Um cenário mostra tudo. É demonstração: a falha real aparece no gráfico ao
 *   lado da curva de probabilidade, e a aula compara as duas.
 * - Um desafio mostra a sequência **até o ponto de decisão** e nada além. As
 *   janelas seguintes existem no arquivo de definição, mas não entram no
 *   relatório enquanto `revealed` for falso. Não é um filtro no renderizador: o
 *   desfecho simplesmente não é calculado, e por isso não há de onde vazar.
 *
 * A mitigação é uma terceira leitura da mesma sequência: as métricas decaem em
 * direção à baseline a partir da janela de intervenção, as features são
 * recalculadas do zero e o modelo é consultado de novo. Nenhuma probabilidade
 * é ajustada à mão — se o risco cai, cai porque as features mudaram.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DECISION_THRESHOLD, riskBand } from './evaluate.mjs';
import {
  BASELINE,
  buildFeatures,
  firstFailureWindow,
  isFailureWindow,
  labelWindow,
  toFeatureVector,
} from './features.mjs';
import { explainContributions, predictProbability } from './logistic-regression.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AUTOMATION_ROOT = resolve(HERE, '..', '..');
export const REPO_ROOT = resolve(AUTOMATION_ROOT, '..');
const SAMPLES_DIR = join(REPO_ROOT, 'samples', 'day-3');

/**
 * Quanto de cada métrica sobrevive a cada janela após a intervenção.
 *
 * `0.45` significa "pouco mais da metade some por janela": em três janelas o
 * excesso sobre a baseline cai a ~9%. Rápido o bastante para a diferença
 * aparecer no gráfico da aula, lento o bastante para não parecer mágica.
 */
export const MITIGATION_DECAY = 0.45;

/** Quantos fatores o relatório mostra. Sete caberiam; três é o que se discute. */
export const TOP_FACTORS = 3;

/**
 * Carrega as definições versionadas em `samples/day-3/`.
 *
 * @param {'scenarios'|'challenges'} kind
 * @returns {object[]}
 */
export function loadDefinitions(kind) {
  const path = join(SAMPLES_DIR, `${kind}.json`);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return parsed[kind];
}

/** @returns {string[]} */
export function listScenarioIds() {
  return loadDefinitions('scenarios').map((entry) => entry.id);
}

/** @returns {string[]} */
export function listChallengeIds() {
  return loadDefinitions('challenges').map((entry) => entry.id);
}

/**
 * @param {'scenarios'|'challenges'} kind
 * @param {string} id
 * @returns {object}
 */
export function findDefinition(kind, id) {
  const found = loadDefinitions(kind).find((entry) => entry.id === id);
  if (!found) throw new Error(`cenário/caso desconhecido: ${id}`);
  return found;
}

/**
 * Previsão janela a janela.
 *
 * As features de cada janela olham apenas `windows[0..index]` — a garantia vive
 * em `features.mjs`, e por isso truncar a sequência no ponto de decisão produz
 * exatamente as mesmas features das janelas anteriores. Um desafio e o cenário
 * completo concordam, número a número, no trecho que compartilham.
 *
 * @param {object} input
 * @param {object} input.model
 * @param {object[]} input.windows janelas visíveis
 * @param {number} [input.threshold]
 * @param {object[]|null} [input.fullWindows] sequência completa, para o rótulo real
 * @param {boolean} [input.revealed] revela o rótulo real de cada janela
 * @returns {object[]}
 */
export function predictWindows({
  model,
  windows,
  threshold = DECISION_THRESHOLD,
  fullWindows = null,
  revealed = false,
}) {
  const reference = fullWindows ?? windows;

  return windows.map((window, index) => {
    const features = buildFeatures(windows, index);
    const vector = toFeatureVector(features);
    const probability = predictProbability(model, vector);

    return {
      windowIndex: index,
      window: { ...window, index },
      features,
      failureProbability: round(probability, 6),
      predictedFailure: probability >= threshold,
      riskBand: riskBand(probability).id,
      topFactors: explainContributions(model, vector)
        .slice(0, TOP_FACTORS)
        .map((factor) => ({
          feature: factor.feature,
          weight: round(factor.weight, 6),
          rawValue: round(factor.rawValue, 6),
          standardizedValue: round(factor.standardizedValue, 6),
          contribution: round(factor.contribution, 6),
          direction: factor.direction,
        })),
      actualFailureWithinHorizon: revealed ? toBoolean(labelWindow(reference, index).label) : null,
      isFailureWindow: isFailureWindow(window),
    };
  });
}

/**
 * Analisa uma sequência: previsões, janela atual e — se revelado — o desfecho.
 *
 * @param {object} input
 * @param {object} input.model
 * @param {object[]} input.windows sequência completa da definição
 * @param {number|null} [input.decisionIndex] última janela visível
 * @param {boolean} [input.revealed]
 * @param {number} [input.threshold]
 * @returns {object}
 */
export function analyzeSequence({
  model,
  windows,
  decisionIndex = null,
  revealed = false,
  threshold = DECISION_THRESHOLD,
}) {
  const currentWindowIndex = decisionIndex ?? windows.length - 1;
  const visible = windows.slice(0, currentWindowIndex + 1).map((window, index) => ({
    ...window,
    index,
  }));

  const predictions = predictWindows({
    model,
    windows: visible,
    threshold,
    fullWindows: windows,
    revealed,
  });

  const current = predictions[currentWindowIndex];
  const firstPositive = predictions.find((entry) => entry.predictedFailure) ?? null;

  return {
    windows: visible,
    predictions,
    currentWindowIndex,
    failureProbability: current.failureProbability,
    predictedFailure: current.predictedFailure,
    riskBand: current.riskBand,
    topFactors: current.topFactors,
    firstPredictedFailureWindow: firstPositive ? firstPositive.windowIndex : null,
    outcome: revealed
      ? revealOutcome({ windows, predictions, currentWindowIndex, firstPositive })
      : hiddenOutcome(),
  };
}

/**
 * O desfecho, calculado sobre a sequência **completa**.
 *
 * `leadTimeWindows` é a antecedência oferecida pelo modelo: quantas janelas
 * separam o primeiro alarme da primeira falha real. Um número negativo seria
 * um alarme tardio; `null` quer dizer que faltou um dos dois eventos.
 *
 * @param {object} input
 * @returns {object}
 */
export function revealOutcome({ windows, predictions, currentWindowIndex, firstPositive }) {
  const firstFailure = firstFailureWindow(windows);
  const actualLabel = labelWindow(windows, currentWindowIndex).label;
  const predicted = predictions[currentWindowIndex].predictedFailure;

  return {
    revealed: true,
    actualFailure: firstFailure !== null,
    firstActualFailureWindow: firstFailure,
    leadTimeWindows:
      firstFailure !== null && firstPositive ? firstFailure - firstPositive.windowIndex : null,
    decisionOutcome: actualLabel === null ? null : classifyDecision(predicted, actualLabel === 1),
  };
}

/** O desfecho ainda não revelado: nada de `false`, tudo `null`. */
export function hiddenOutcome() {
  return {
    revealed: false,
    actualFailure: null,
    firstActualFailureWindow: null,
    leadTimeWindows: null,
    decisionOutcome: null,
  };
}

/**
 * @param {boolean} predicted
 * @param {boolean} actual
 * @returns {'true_positive'|'false_positive'|'true_negative'|'false_negative'}
 */
export function classifyDecision(predicted, actual) {
  if (predicted && actual) return 'true_positive';
  if (predicted && !actual) return 'false_positive';
  if (!predicted && actual) return 'false_negative';
  return 'true_negative';
}

/**
 * A sequência mitigada: a partir da janela seguinte à intervenção, cada métrica
 * decai em direção à baseline.
 *
 * O ponto de partida do decaimento é o valor **da janela de intervenção**, não
 * o valor que a sequência original teria naquele instante. É a diferença entre
 * "o crescimento parou e o sistema está se recuperando" e "o crescimento
 * continuou, só que menos" — e a primeira é a história que uma mitigação conta.
 *
 * `healthFailure` é zerado depois da intervenção pelo mesmo motivo: a
 * intervenção existe justamente para o health check voltar a passar.
 *
 * @param {object[]} windows
 * @param {object} input
 * @param {number} input.interventionIndex
 * @param {number} [input.decay]
 * @returns {object[]}
 */
export function applyMitigation(windows, { interventionIndex, decay = MITIGATION_DECAY }) {
  const anchor = windows[interventionIndex];
  if (!anchor) throw new Error('janela de intervenção fora da sequência');

  return windows.map((window, index) => {
    if (index <= interventionIndex) return { ...window, index };

    const factor = decay ** (index - interventionIndex);
    return {
      index,
      latencyP95Ms: Math.round(BASELINE.latencyP95Ms + (anchor.latencyP95Ms - BASELINE.latencyP95Ms) * factor),
      errorRate: round(Math.max(0, BASELINE.errorRate + (anchor.errorRate - BASELINE.errorRate) * factor), 4),
      logLinesPerRequest: round(
        Math.max(0, BASELINE.logLinesPerRequest + (anchor.logLinesPerRequest - BASELINE.logLinesPerRequest) * factor),
        2,
      ),
      healthFailure: false,
    };
  });
}

/**
 * Compara a sequência original com a mitigada, janela a janela.
 *
 * @param {object} input
 * @returns {object}
 */
export function compareMitigation({ model, windows, interventionIndex, decay = MITIGATION_DECAY, threshold = DECISION_THRESHOLD }) {
  const mitigatedWindows = applyMitigation(windows, { interventionIndex, decay });

  const original = predictWindows({ model, windows, threshold });
  const mitigated = predictWindows({ model, windows: mitigatedWindows, threshold });

  const comparison = windows.map((window, index) => ({
    windowIndex: index,
    baselineProbability: original[index].failureProbability,
    mitigatedProbability: mitigated[index].failureProbability,
    baselineLatencyP95Ms: window.latencyP95Ms,
    mitigatedLatencyP95Ms: mitigatedWindows[index].latencyP95Ms,
    baselineErrorRate: window.errorRate,
    mitigatedErrorRate: mitigatedWindows[index].errorRate,
    baselineLogLinesPerRequest: window.logLinesPerRequest,
    mitigatedLogLinesPerRequest: mitigatedWindows[index].logLinesPerRequest,
  }));

  return {
    mitigatedWindows,
    mitigation: {
      interventionWindowIndex: interventionIndex,
      decayPerWindow: decay,
      baselineProbability: original.at(-1).failureProbability,
      mitigatedProbability: mitigated.at(-1).failureProbability,
      baselineMaxProbability: Math.max(...original.map((entry) => entry.failureProbability)),
      mitigatedMaxProbability: Math.max(...mitigated.map((entry) => entry.failureProbability)),
      comparison,
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                  */
/* ------------------------------------------------------------------------- */

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toBoolean(label) {
  return label === null ? null : label === 1;
}
