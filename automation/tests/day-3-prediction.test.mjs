import { describe, expect, it } from 'vitest';

import { DECISION_THRESHOLD, splitSequences } from '../src/day3/evaluate.mjs';
import { LAB_LIMITATIONS, buildExplanationPayload, explainPrediction } from '../src/day3/explain.mjs';
import { FEATURE_NAMES, buildDataset, isFailureWindow } from '../src/day3/features.mjs';
import { trainLogisticRegression } from '../src/day3/logistic-regression.mjs';
import { analyzeSequence, findDefinition, listScenarioIds } from '../src/day3/predict.mjs';
import { generateHistory } from '../src/day3/synthetic-history.mjs';

const { train } = splitSequences(generateHistory());
const { rows, labels } = buildDataset(train);
const model = trainLogisticRegression({ rows, labels, featureNames: FEATURE_NAMES });

/** Analisa um cenário versionado do jeito que a CLI faz. */
function analyzeScenario(id) {
  const definition = findDefinition('scenarios', id);
  return {
    definition,
    ...analyzeSequence({ model, windows: definition.windows, revealed: true }),
  };
}

const METRICS = {
  accuracy: 0.91,
  precision: 0.92,
  recall: 0.5,
  f1Score: 0.65,
  examples: 144,
  positiveExamples: 24,
  negativeExamples: 120,
};

describe('cenários visuais', () => {
  it('os quatro cenários existem e produzem probabilidades finitas', () => {
    expect(listScenarioIds()).toEqual([
      'latency-growth',
      'error-growth',
      'log-growth',
      'transient-spike',
    ]);

    for (const id of listScenarioIds()) {
      const analysis = analyzeScenario(id);
      for (const entry of analysis.predictions) {
        expect(Number.isFinite(entry.failureProbability)).toBe(true);
        expect(entry.failureProbability).toBeGreaterThanOrEqual(0);
        expect(entry.failureProbability).toBeLessThanOrEqual(1);
      }
    }
  });

  it('latency-growth: a probabilidade cresce e passa do limiar ANTES da falha', () => {
    const { definition, predictions } = analyzeScenario('latency-growth');
    const failureIndex = definition.windows.findIndex(isFailureWindow);
    const probabilities = predictions.map((entry) => entry.failureProbability);

    // Monotonicamente crescente ao longo da rampa.
    for (let index = 1; index <= failureIndex; index += 1) {
      expect(probabilities[index]).toBeGreaterThan(probabilities[index - 1]);
    }
    // O alarme acende antes da janela em falha.
    expect(probabilities[failureIndex - 1]).toBeGreaterThanOrEqual(DECISION_THRESHOLD);
    expect(probabilities[0]).toBeLessThan(0.4);
  });

  it('error-growth: a probabilidade cresce e passa do limiar ANTES da falha', () => {
    const { definition, predictions } = analyzeScenario('error-growth');
    const failureIndex = definition.windows.findIndex(isFailureWindow);
    const probabilities = predictions.map((entry) => entry.failureProbability);

    for (let index = 1; index <= failureIndex; index += 1) {
      expect(probabilities[index]).toBeGreaterThan(probabilities[index - 1]);
    }
    expect(probabilities[failureIndex - 1]).toBeGreaterThanOrEqual(DECISION_THRESHOLD);

    // O sinal dominante é a taxa de erro, não a latência.
    const factors = predictions[failureIndex - 1].topFactors.map((factor) => factor.feature);
    expect(factors).toContain('errorRateSlope3');
  });

  it('log-growth: o risco sobe quando a tendência de logs se torna persistente', () => {
    const { definition, predictions } = analyzeScenario('log-growth');
    const failureIndex = definition.windows.findIndex(isFailureWindow);
    const probabilities = predictions.map((entry) => entry.failureProbability);

    // Enquanto só os logs crescem, o modelo ainda não decide.
    expect(probabilities[2]).toBeLessThan(DECISION_THRESHOLD);
    // Quando a tendência persiste e a latência acompanha, ele decide — antes da falha.
    expect(probabilities[failureIndex - 1]).toBeGreaterThanOrEqual(DECISION_THRESHOLD);
    expect(predictions[failureIndex - 1].features.consecutiveDegradedWindows).toBeGreaterThanOrEqual(2);

    const factors = predictions[failureIndex - 1].topFactors.map((factor) => factor.feature);
    expect(factors).toContain('logSlope3');
  });

  it('transient-spike: o risco cai após a recuperação e nunca passa do limiar', () => {
    const { definition, predictions } = analyzeScenario('transient-spike');
    const probabilities = predictions.map((entry) => entry.failureProbability);
    const spikeIndex = definition.windows.reduce(
      (best, window, index) => (window.latencyP95Ms > definition.windows[best].latencyP95Ms ? index : best),
      0,
    );

    expect(spikeIndex).toBe(2);
    expect(probabilities[spikeIndex + 1]).toBeLessThan(probabilities[spikeIndex]);
    expect(probabilities.at(-1)).toBeLessThan(probabilities[spikeIndex]);
    for (const probability of probabilities) {
      expect(probability).toBeLessThan(DECISION_THRESHOLD);
    }
    expect(definition.windows.some(isFailureWindow)).toBe(false);
  });

  it('as previsões de um cenário truncado coincidem com as do cenário inteiro', () => {
    const definition = findDefinition('scenarios', 'latency-growth');
    const full = analyzeSequence({ model, windows: definition.windows, revealed: true });
    const truncated = analyzeSequence({ model, windows: definition.windows, decisionIndex: 3 });

    expect(truncated.predictions).toHaveLength(4);
    truncated.predictions.forEach((entry, index) => {
      expect(entry.failureProbability).toBe(full.predictions[index].failureProbability);
      expect(entry.features).toEqual(full.predictions[index].features);
    });
  });
});

describe('fronteira entre o modelo estatístico e a IA generativa', () => {
  const analysis = analyzeScenario('latency-growth');

  it('o payload enviado ao modelo não identifica o cenário nem carrega ambiente', () => {
    const payload = buildExplanationPayload({
      analysis,
      threshold: DECISION_THRESHOLD,
      modelMetrics: METRICS,
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('latency-growth');
    expect(serialized).not.toContain('Sequência A');
    expect(serialized).not.toContain('scenario');
    expect(payload).not.toHaveProperty('id');
    expect(payload).not.toHaveProperty('title');
    expect(payload).not.toHaveProperty('pattern');
    // Nada de variável de ambiente vazando por dentro do payload.
    expect(serialized).not.toContain('OPENAI');
    expect(serialized).not.toContain('PATH');
  });

  it('a IA não altera probability, predictedFailure nem threshold', async () => {
    const hostile = {
      responses: {
        parse: async () => ({
          status: 'completed',
          id: 'resp_teste',
          model: 'gpt-5-mini',
          output_parsed: {
            summary: 'Resumo do modelo.',
            evidence: ['Fato citado pelo modelo.'],
            interpretation: 'Interpretação do modelo.',
            recommendedActions: ['Ação sugerida.'],
            limitations: ['Limitação declarada.'],
            // O modelo tenta devolver os números — e não deve conseguir.
            failureProbability: 0.01,
            predictedFailure: false,
            threshold: 0.01,
            topFactors: [],
            actualFailure: false,
          },
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      },
    };

    const explanation = await explainPrediction({
      analysis,
      threshold: DECISION_THRESHOLD,
      modelMetrics: METRICS,
      env: { OPENAI_API_KEY: 'sk-teste-nao-usada' },
      client: hostile,
    });

    expect(explanation.origin).toBe('openai');
    expect(explanation.summary).toBe('Resumo do modelo.');
    // Os campos numéricos simplesmente não sobrevivem ao schema.
    expect(explanation).not.toHaveProperty('failureProbability');
    expect(explanation).not.toHaveProperty('predictedFailure');
    expect(explanation).not.toHaveProperty('threshold');
    expect(explanation).not.toHaveProperty('topFactors');
    expect(explanation).not.toHaveProperty('actualFailure');

    // E a análise permanece intacta.
    expect(analysis.failureProbability).toBeGreaterThan(DECISION_THRESHOLD);
    expect(analysis.predictedFailure).toBe(true);
  });

  it('sem OPENAI_API_KEY usa o fallback determinístico, sem tocar na rede', async () => {
    const client = {
      responses: {
        parse: async () => {
          throw new Error('a rede não deveria ser chamada');
        },
      },
    };

    const explanation = await explainPrediction({
      analysis,
      threshold: DECISION_THRESHOLD,
      modelMetrics: METRICS,
      env: {},
      client,
    });

    expect(explanation.origin).toBe('fallback');
    expect(explanation.summary).toContain('probabilidade de falha');
    expect(explanation.evidence.length).toBeGreaterThan(0);
    expect(explanation.recommendedActions.length).toBeGreaterThan(0);
    expect(explanation.modelErrorCategory).toBeNull();
    for (const limitation of LAB_LIMITATIONS) {
      expect(explanation.limitations).toContain(limitation);
    }
  });

  it('erro do modelo cai no fallback e vira categoria, nunca mensagem bruta', async () => {
    const failing = {
      responses: {
        parse: async () => {
          const error = new Error('Incorrect API key provided: sk-segredo-real');
          error.status = 401;
          throw error;
        },
      },
    };

    const explanation = await explainPrediction({
      analysis,
      threshold: DECISION_THRESHOLD,
      modelMetrics: METRICS,
      env: { OPENAI_API_KEY: 'sk-teste-nao-usada' },
      client: failing,
    });

    expect(explanation.origin).toBe('fallback');
    expect(explanation.modelErrorCategory).toBe('authentication');
    expect(JSON.stringify(explanation)).not.toContain('sk-segredo-real');
    expect(JSON.stringify(explanation)).not.toContain('Incorrect API key');
  });

  it('o fallback não inventa recomendação quando o risco é baixo', async () => {
    const calm = analyzeScenario('transient-spike');
    const explanation = await explainPrediction({
      analysis: calm,
      threshold: DECISION_THRESHOLD,
      modelMetrics: METRICS,
      env: {},
    });

    expect(explanation.origin).toBe('fallback');
    expect(explanation.interpretation).not.toMatch(/degradação que se mantém e cresce/);
    expect(explanation.recommendedActions.join(' ')).toMatch(/Nenhuma ação de mitigação|observação/i);
  });
});
