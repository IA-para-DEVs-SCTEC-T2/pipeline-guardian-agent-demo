/**
 * O detector é a peça que decide. Estes testes cobrem os três cenários da aula
 * e as bordas das duas regras — é aqui que um afrouxamento acidental aparece.
 */

import { describe, expect, it } from 'vitest';

import {
  ANOMALY_TYPE_BY_SIGNAL,
  THRESHOLDS,
  detectAnomaly,
  evaluateSignal,
  percentile95,
  summarizeMeasurement,
} from '../src/simple-anomaly-detector.mjs';

const BASELINE = { latencyP95Ms: 4, logLinesPerRequest: 2 };

/** Amostras com as durações informadas, todas com HTTP 200. */
function samplesFrom(durations) {
  return durations.map((durationMs, index) => ({
    requestId: `lab-${String(index + 1).padStart(4, '0')}`,
    statusCode: 200,
    durationMs,
  }));
}

/** 29 requisições entre 2 e 5 ms + uma de 50 ms. */
function normalDurations() {
  const durations = Array.from({ length: 29 }, (_unused, index) => 2 + (index % 4));
  durations[13] = 50;
  // A de 50 ms precisa ser uma das 30, não uma a mais.
  return [...durations, 3];
}

describe('percentile95', () => {
  it('usa o posto mais próximo: com 30 amostras, cai na 29ª', () => {
    const values = [...Array.from({ length: 29 }, () => 5), 500];
    expect(percentile95(values)).toBe(5);
  });

  it('enxerga a cauda quando ela é maior que 5% das amostras', () => {
    const values = [...Array.from({ length: 20 }, () => 5), ...Array.from({ length: 10 }, () => 500)];
    expect(percentile95(values)).toBe(500);
  });

  it('devolve 0 para lista vazia em vez de NaN', () => {
    expect(percentile95([])).toBe(0);
  });
});

describe('cenário 1 — normal', () => {
  const durations = normalDurations();
  const observed = summarizeMeasurement({ samples: samplesFrom(durations), logLineCount: 60 });

  it('descarta a única requisição de 50 ms no p95', () => {
    expect(observed.sampleCount).toBe(30);
    expect(observed.latencyP95Ms).toBeLessThan(10);
    expect(observed.context.latencyMaxMs).toBe(50);
  });

  it('não acusa anomalia', () => {
    const result = detectAnomaly({ baseline: BASELINE, observed });

    expect(result.anomalyDetected).toBe(false);
    expect(result.anomalyType).toBeNull();
    expect(result.firstAnomalousSignal).toBeNull();
    expect(result.gateResult).toBe('pass');
    expect(result.triggeredRules).toEqual([]);
  });
});

describe('cenário 2 — latência', () => {
  // Duas em cada três entre 2 e 5 ms; uma em cada três em ~500 ms.
  const durations = Array.from({ length: 30 }, (_unused, index) =>
    (index + 1) % 3 === 0 ? 500 + (index % 5) : 2 + (index % 4),
  );
  const observed = summarizeMeasurement({ samples: samplesFrom(durations), logLineCount: 60 });

  it('acusa anomalia de latência', () => {
    const result = detectAnomaly({ baseline: BASELINE, observed });

    expect(result.anomalyDetected).toBe(true);
    expect(result.anomalyType).toBe('latency');
    expect(result.firstAnomalousSignal).toBe('latencyP95Ms');
    expect(result.gateResult).toBe('fail');
    expect(result.triggeredRules).toEqual([
      'latencyP95Ms >= baseline * 3',
      'latencyP95Ms - baseline >= 150 ms',
    ]);
  });

  it('não arrasta o volume de log junto', () => {
    const result = detectAnomaly({ baseline: BASELINE, observed });
    const logSignal = result.evaluations.find((item) => item.signal === 'logLinesPerRequest');

    expect(observed.logLinesPerRequest).toBe(2);
    expect(logSignal.triggered).toBe(false);
  });
});

describe('cenário 3 — volume de log', () => {
  const durations = Array.from({ length: 30 }, (_unused, index) => 2 + (index % 4));
  // 8 linhas por requisição: o que o modo `noisy-logs` produz (2 + 18/3).
  const observed = summarizeMeasurement({ samples: samplesFrom(durations), logLineCount: 240 });

  it('acusa anomalia de volume de log', () => {
    const result = detectAnomaly({ baseline: BASELINE, observed });

    expect(observed.logLinesPerRequest).toBe(8);
    expect(result.anomalyDetected).toBe(true);
    expect(result.anomalyType).toBe('log-volume');
    expect(result.firstAnomalousSignal).toBe('logLinesPerRequest');
    expect(result.gateResult).toBe('fail');
    expect(result.triggeredRules).toEqual([
      'logLinesPerRequest >= baseline * 3',
      'logLinesPerRequest - baseline >= 5 linhas',
    ]);
  });

  it('a latência continua normal', () => {
    const result = detectAnomaly({ baseline: BASELINE, observed });
    expect(result.evaluations[0].triggered).toBe(false);
  });
});

describe('as duas condições, sempre', () => {
  it('razão sozinha não dispara: 2 ms → 7 ms é 3,5x e não significa nada', () => {
    const evaluation = evaluateSignal({ signal: 'latencyP95Ms', baseline: 2, observed: 7 });

    expect(evaluation.ratioRule.satisfied).toBe(true);
    expect(evaluation.absoluteRule.satisfied).toBe(false);
    expect(evaluation.triggered).toBe(false);
  });

  it('diferença absoluta sozinha não dispara: 900 ms → 1.060 ms não mudou de patamar', () => {
    const evaluation = evaluateSignal({ signal: 'latencyP95Ms', baseline: 900, observed: 1060 });

    expect(evaluation.ratioRule.satisfied).toBe(false);
    expect(evaluation.absoluteRule.satisfied).toBe(true);
    expect(evaluation.triggered).toBe(false);
  });

  it('12 linhas a cada três requisições (+4) ficariam abaixo da regra absoluta', () => {
    // Registrado como teste porque é exatamente por isso que o modo de
    // demonstração emite 18 linhas, e não 12. Ver `backend/src/demo-anomaly.js`.
    const evaluation = evaluateSignal({ signal: 'logLinesPerRequest', baseline: 2, observed: 6 });

    expect(evaluation.ratioRule.satisfied).toBe(true);
    expect(evaluation.absoluteRule.satisfied).toBe(false);
    expect(evaluation.triggered).toBe(false);
  });

  it('a borda exata dispara: >= e não >', () => {
    const evaluation = evaluateSignal({ signal: 'latencyP95Ms', baseline: 50, observed: 200 });

    expect(evaluation.ratio).toBe(4);
    expect(evaluation.difference).toBe(150);
    expect(evaluation.triggered).toBe(true);
  });
});

describe('precedência e forma do resultado', () => {
  it('quando os dois sinais desviam, a latência é o primeiro e as duas regras aparecem', () => {
    const result = detectAnomaly({
      baseline: BASELINE,
      observed: { latencyP95Ms: 500, logLinesPerRequest: 8 },
    });

    expect(result.firstAnomalousSignal).toBe('latencyP95Ms');
    expect(result.anomalyType).toBe(ANOMALY_TYPE_BY_SIGNAL.latencyP95Ms);
    expect(result.triggeredRules).toHaveLength(4);
  });

  it('baseline zero não vira Infinity no relatório', () => {
    const evaluation = evaluateSignal({ signal: 'latencyP95Ms', baseline: 0, observed: 300 });
    expect(evaluation.ratio).toBeNull();
  });

  it('os limiares são os do enunciado', () => {
    expect(THRESHOLDS.latencyP95Ms).toMatchObject({ ratio: 3, absolute: 150 });
    expect(THRESHOLDS.logLinesPerRequest).toMatchObject({ ratio: 3, absolute: 5 });
  });

  it('conta erros e códigos de status como contexto, sem decidir nada', () => {
    const observed = summarizeMeasurement({
      samples: [
        { statusCode: 200, durationMs: 3 },
        { statusCode: 500, durationMs: 4 },
        { statusCode: null, durationMs: 5 },
      ],
      logLineCount: 6,
    });

    expect(observed.context.errorCount).toBe(2);
    expect(observed.context.statusCodes).toEqual({ 200: 1, 500: 1, 'sem-resposta': 1 });
    expect(detectAnomaly({ baseline: BASELINE, observed }).anomalyDetected).toBe(false);
  });
});
