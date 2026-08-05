import { describe, expect, it } from 'vitest';

import {
  DECISION_THRESHOLD,
  computeMetrics,
  evaluateModel,
  probabilityDistribution,
  riskBand,
  safeRatio,
  splitSequences,
} from '../src/day3/evaluate.mjs';
import { FEATURE_NAMES, buildDataset } from '../src/day3/features.mjs';
import {
  MIN_STANDARD_DEVIATION,
  deserializeModel,
  explainContributions,
  fitScaler,
  logLoss,
  logit,
  predictProbability,
  serializeModel,
  sigmoid,
  standardizeRow,
  trainLogisticRegression,
} from '../src/day3/logistic-regression.mjs';
import { generateHistory } from '../src/day3/synthetic-history.mjs';

const sequences = generateHistory();
const { train, test } = splitSequences(sequences);
const trainSet = buildDataset(train);
const model = trainLogisticRegression({
  rows: trainSet.rows,
  labels: trainSet.labels,
  featureNames: FEATURE_NAMES,
});

describe('sigmoid', () => {
  it('é estável nos extremos', () => {
    for (const z of [-1e6, -1000, -50, 0, 50, 1000, 1e6]) {
      const value = sigmoid(z);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(sigmoid(0)).toBeCloseTo(0.5, 12);
    expect(sigmoid(-1e6)).toBe(0);
    expect(sigmoid(1e6)).toBe(1);
  });

  it('não devolve NaN nem para Infinity', () => {
    expect(sigmoid(Infinity)).toBe(1);
    expect(sigmoid(-Infinity)).toBe(0);
    expect(Number.isNaN(sigmoid(-1e308 * 10))).toBe(false);
  });
});

describe('padronização', () => {
  it('usa apenas as linhas recebidas — o teste não influencia média nem desvio', () => {
    const trainRows = [[1, 10], [3, 30], [5, 50]];
    const scaler = fitScaler(trainRows);

    // Uma linha absurda "do teste" não altera o scaler já ajustado.
    const outlier = standardizeRow([1000, 10000], scaler);
    expect(fitScaler(trainRows)).toEqual(scaler);
    expect(scaler.mean).toEqual([3, 30]);
    expect(outlier.every(Number.isFinite)).toBe(true);
  });

  it('protege contra desvio padrão zero', () => {
    const scaler = fitScaler([[7, 1], [7, 2], [7, 3]]);
    expect(scaler.std[0]).toBe(1);
    expect(standardizeRow([7, 2], scaler)[0]).toBe(0);
    expect(standardizeRow([99, 2], scaler).every(Number.isFinite)).toBe(true);
    expect(MIN_STANDARD_DEVIATION).toBeGreaterThan(0);
  });

  it('o scaler do modelo treinado vem do conjunto de treino', () => {
    expect(model.scaler).toEqual(fitScaler(trainSet.rows));
  });
});

describe('treino', () => {
  it('reduz a loss de forma verificável', () => {
    expect(model.training.finalLoss).toBeLessThan(model.training.initialLoss);
    const history = model.training.lossHistory.map((entry) => entry.loss);
    expect(history.at(-1)).toBeLessThan(history[0]);
    expect(history.every(Number.isFinite)).toBe(true);
  });

  it('a loss cai monotonicamente com lote completo', () => {
    const history = model.training.lossHistory.map((entry) => entry.loss);
    for (let index = 1; index < history.length; index += 1) {
      expect(history[index]).toBeLessThanOrEqual(history[index - 1] + 1e-12);
    }
  });

  it('é determinístico: mesma entrada, mesmos pesos', () => {
    const again = trainLogisticRegression({
      rows: trainSet.rows,
      labels: trainSet.labels,
      featureNames: FEATURE_NAMES,
    });
    expect(again.weights).toEqual(model.weights);
    expect(again.bias).toBe(model.bias);
  });

  it('a inicialização é em zeros, sem sorteio', () => {
    expect(model.hyperparameters.initialization).toBe('zeros');
    const zeroStep = trainLogisticRegression({
      rows: trainSet.rows,
      labels: trainSet.labels,
      featureNames: FEATURE_NAMES,
      maxIterations: 0,
    });
    expect(zeroStep.weights).toEqual(new Array(FEATURE_NAMES.length).fill(0));
    expect(zeroStep.bias).toBe(0);
  });

  it('todos os pesos são finitos', () => {
    expect(model.weights.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(model.bias)).toBe(true);
    expect(Number.isFinite(logLoss([[0, 0, 0, 0, 0, 0, 0]], [1], model))).toBe(true);
  });
});

describe('serialização', () => {
  it('o modelo recarregado devolve exatamente a mesma previsão', () => {
    const reloaded = deserializeModel(JSON.parse(JSON.stringify(serializeModel(model))));

    for (const row of trainSet.rows) {
      expect(predictProbability(reloaded, row)).toBe(predictProbability(model, row));
      expect(logit(reloaded, row)).toBe(logit(model, row));
    }
  });

  it('reprova um modelo corrompido em vez de produzir NaN', () => {
    const serialized = serializeModel(model);
    expect(() => deserializeModel({ ...serialized, weights: [1, 2] })).toThrow(/weights/);
    expect(() => deserializeModel({ ...serialized, weights: serialized.weights.map(() => null) })).toThrow();
    expect(() => deserializeModel({ ...serialized, featureNames: [] })).toThrow(/featureNames/);
    expect(() => deserializeModel({ ...serialized, scaler: { mean: [], std: [] } })).toThrow(/scaler/);
  });

  it('não carrega carimbo de tempo: duas execuções produzem o mesmo arquivo', () => {
    const first = JSON.stringify(serializeModel(model));
    const second = JSON.stringify(
      serializeModel(
        trainLogisticRegression({
          rows: trainSet.rows,
          labels: trainSet.labels,
          featureNames: FEATURE_NAMES,
        }),
      ),
    );
    expect(first).toBe(second);
  });
});

describe('contribuições', () => {
  it('somam o logit junto com o viés', () => {
    const row = trainSet.rows[10];
    const total = explainContributions(model, row).reduce((sum, factor) => sum + factor.contribution, 0);
    expect(total + model.bias).toBeCloseTo(logit(model, row), 9);
  });

  it('são ordenadas pela magnitude absoluta', () => {
    const factors = explainContributions(model, trainSet.rows[3]);
    const magnitudes = factors.map((factor) => Math.abs(factor.contribution));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
    expect(factors).toHaveLength(FEATURE_NAMES.length);
  });

  it('declaram a direção de cada contribuição', () => {
    for (const factor of explainContributions(model, trainSet.rows[5])) {
      expect(factor.direction).toBe(factor.contribution >= 0 ? 'increases' : 'decreases');
    }
  });
});

describe('avaliação', () => {
  const evaluation = evaluateModel({ model, sequences: test });

  it('não produz NaN nem Infinity em nenhuma métrica', () => {
    for (const key of ['accuracy', 'precision', 'recall', 'f1Score']) {
      expect(Number.isFinite(evaluation[key])).toBe(true);
      expect(evaluation[key]).toBeGreaterThanOrEqual(0);
      expect(evaluation[key]).toBeLessThanOrEqual(1);
    }
    expect(evaluation.probabilities.every(Number.isFinite)).toBe(true);
  });

  it('a matriz de confusão fecha com o total de exemplos', () => {
    const matrix = evaluation.confusionMatrix;
    const total =
      matrix.truePositives + matrix.falsePositives + matrix.trueNegatives + matrix.falseNegatives;
    expect(total).toBe(evaluation.examples);
    expect(evaluation.positiveExamples + evaluation.negativeExamples).toBe(evaluation.examples);
  });

  it('protege toda divisão por zero', () => {
    expect(safeRatio(1, 0)).toBe(0);
    expect(safeRatio(0, 0)).toBe(0);
    const empty = computeMetrics([], []);
    for (const key of ['accuracy', 'precision', 'recall', 'f1Score']) {
      expect(Number.isFinite(empty[key])).toBe(true);
    }

    // Nenhum positivo previsto: precisão 0 em vez de NaN.
    const noPositives = computeMetrics([0.1, 0.2], [1, 0]);
    expect(noPositives.precision).toBe(0);
    expect(noPositives.f1Score).toBe(0);
  });

  it('a distribuição soma o total e respeita as classes', () => {
    const bins = probabilityDistribution(evaluation.probabilities, evaluation.labels);
    const positives = bins.reduce((sum, bin) => sum + bin.positives, 0);
    const negatives = bins.reduce((sum, bin) => sum + bin.negatives, 0);

    expect(bins).toHaveLength(10);
    expect(positives).toBe(evaluation.positiveExamples);
    expect(negatives).toBe(evaluation.negativeExamples);
  });

  it('o modelo é melhor que a taxa-base do conjunto de teste', () => {
    const baseRate = evaluation.negativeExamples / evaluation.examples;
    expect(evaluation.accuracy).toBeGreaterThan(baseRate);
    expect(evaluation.confusionMatrix.truePositives).toBeGreaterThan(0);
  });

  it('as faixas de risco seguem o limiar declarado', () => {
    expect(DECISION_THRESHOLD).toBe(0.7);
    expect(riskBand(0.1).id).toBe('low');
    expect(riskBand(0.39).id).toBe('low');
    expect(riskBand(0.4).id).toBe('attention');
    expect(riskBand(0.69).id).toBe('attention');
    expect(riskBand(0.7).id).toBe('likely');
    expect(riskBand(1).id).toBe('likely');
  });
});
