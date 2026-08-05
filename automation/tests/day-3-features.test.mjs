import { describe, expect, it } from 'vitest';

import {
  BASELINE,
  FEATURE_NAMES,
  HORIZON_WINDOWS,
  buildDataset,
  buildExamples,
  buildFeatures,
  consecutiveDegradedWindows,
  isDegradedWindow,
  isFailureWindow,
  labelWindow,
  linearSlope,
  slopeOfLastWindows,
  toFeatureVector,
} from '../src/day3/features.mjs';

/** Uma janela saudável, para compor sequências nos testes. */
function window(overrides = {}) {
  return {
    latencyP95Ms: 12,
    errorRate: 0,
    logLinesPerRequest: 2,
    healthFailure: false,
    ...overrides,
  };
}

describe('definição de falha', () => {
  it('dispara com qualquer uma das três condições', () => {
    expect(isFailureWindow(window({ errorRate: 0.5 }))).toBe(true);
    expect(isFailureWindow(window({ latencyP95Ms: 1500 }))).toBe(true);
    expect(isFailureWindow(window({ healthFailure: true }))).toBe(true);
  });

  it('não dispara logo abaixo dos limites', () => {
    expect(isFailureWindow(window({ errorRate: 0.4999 }))).toBe(false);
    expect(isFailureWindow(window({ latencyP95Ms: 1499 }))).toBe(false);
    expect(isFailureWindow(window())).toBe(false);
  });
});

describe('definição de degradação', () => {
  it('exige razão sobre a baseline E diferença absoluta na latência', () => {
    // 100 ms é mais que o triplo da baseline (36 ms), mas a diferença é 88 ms.
    expect(isDegradedWindow(window({ latencyP95Ms: 100 }))).toBe(false);
    expect(isDegradedWindow(window({ latencyP95Ms: 162 }))).toBe(true);
  });

  it('exige razão E diferença absoluta nos logs', () => {
    expect(isDegradedWindow(window({ logLinesPerRequest: 6.5 }))).toBe(false);
    expect(isDegradedWindow(window({ logLinesPerRequest: 7 }))).toBe(true);
  });

  it('a taxa de erro degrada em 0,15, bem abaixo do limite de falha', () => {
    expect(isDegradedWindow(window({ errorRate: 0.15 }))).toBe(true);
    expect(isDegradedWindow(window({ errorRate: 0.14 }))).toBe(false);
  });

  it('conta janelas degradadas consecutivas até o índice, olhando para trás', () => {
    const windows = [
      window(),
      window({ latencyP95Ms: 300 }),
      window({ latencyP95Ms: 400 }),
      window({ latencyP95Ms: 500 }),
    ];
    expect(consecutiveDegradedWindows(windows, 0)).toBe(0);
    expect(consecutiveDegradedWindows(windows, 3)).toBe(3);
  });
});

describe('inclinação', () => {
  it('é positiva no crescimento, negativa na recuperação e zero na estabilidade', () => {
    expect(linearSlope([1, 2, 3])).toBeCloseTo(1, 10);
    expect(linearSlope([3, 2, 1])).toBeCloseTo(-1, 10);
    expect(linearSlope([5, 5, 5])).toBeCloseTo(0, 10);
  });

  it('com três pontos igualmente espaçados equivale a (y2 - y0) / 2', () => {
    expect(linearSlope([10, 40, 90])).toBeCloseTo((90 - 10) / 2, 10);
    expect(linearSlope([12, 90, 240])).toBeCloseTo((240 - 12) / 2, 10);
  });

  it('devolve 0 com menos de dois pontos', () => {
    expect(linearSlope([])).toBe(0);
    expect(linearSlope([42])).toBe(0);
  });

  it('usa apenas passado e presente: nunca lê índices posteriores', () => {
    const series = [10, 20, 30, 999999, 999999];
    // A janela 2 não pode enxergar o pico das janelas 3 e 4.
    expect(slopeOfLastWindows(series, 2)).toBeCloseTo(10, 10);
    expect(slopeOfLastWindows(series, 1)).toBeCloseTo(10, 10);
    expect(slopeOfLastWindows(series, 0)).toBe(0);
  });
});

describe('features', () => {
  it('normaliza pela baseline declarada', () => {
    const windows = [window({ latencyP95Ms: 120, logLinesPerRequest: 8, errorRate: 0.25 })];
    const features = buildFeatures(windows, 0);

    expect(features.currentLatencyRatio).toBeCloseTo(120 / BASELINE.latencyP95Ms, 10);
    expect(features.currentLogRatio).toBeCloseTo(8 / BASELINE.logLinesPerRequest, 10);
    expect(features.currentErrorRate).toBe(0.25);
  });

  it('nenhuma feature muda quando o futuro muda', () => {
    const past = [window(), window({ latencyP95Ms: 80 }), window({ latencyP95Ms: 200 })];
    const calm = [...past, window(), window()];
    const catastrophic = [
      ...past,
      window({ latencyP95Ms: 9000, errorRate: 0.99, healthFailure: true }),
      window({ latencyP95Ms: 9000, errorRate: 0.99, healthFailure: true }),
    ];

    for (let index = 0; index < past.length; index += 1) {
      expect(buildFeatures(calm, index)).toEqual(buildFeatures(catastrophic, index));
    }
  });

  it('o vetor respeita a ordem de FEATURE_NAMES', () => {
    const features = buildFeatures([window({ latencyP95Ms: 240 })], 0);
    const vector = toFeatureVector(features);

    expect(vector).toHaveLength(FEATURE_NAMES.length);
    FEATURE_NAMES.forEach((name, index) => expect(vector[index]).toBe(features[name]));
  });
});

describe('rótulo', () => {
  it('olha exatamente as duas janelas seguintes', () => {
    const windows = [
      window(),
      window(),
      window(),
      window({ errorRate: 0.9 }), // falha na janela 3
      window(),
      window(),
    ];

    expect(labelWindow(windows, 1).label).toBe(1); // janela 3 está no horizonte
    expect(labelWindow(windows, 2).label).toBe(1);
    expect(labelWindow(windows, 0).label).toBe(0); // janela 3 está fora do horizonte
  });

  it('uma falha na terceira janela à frente não rotula a janela atual', () => {
    const windows = [window(), window(), window(), window({ latencyP95Ms: 5000 }), window(), window()];
    expect(HORIZON_WINDOWS).toBe(2);
    expect(labelWindow(windows, 0).label).toBe(0);
  });

  it('horizonte incompleto vira null, não 0', () => {
    const windows = [window(), window(), window()];
    expect(labelWindow(windows, 2)).toMatchObject({ label: null, horizonComplete: false });
    expect(labelWindow(windows, 1)).toMatchObject({ label: null, horizonComplete: false });
    expect(labelWindow(windows, 0)).toMatchObject({ label: 0, horizonComplete: true });
  });

  it('horizonte parcial com falha observada é resolvido como 1', () => {
    const windows = [window(), window(), window({ healthFailure: true })];
    expect(labelWindow(windows, 1)).toMatchObject({ label: 1, horizonComplete: true });
  });
});

describe('construção de exemplos', () => {
  it('descarta janelas sem horizonte completo e janelas já em falha', () => {
    const windows = [
      window(),
      window(),
      window(),
      window({ latencyP95Ms: 1600 }),
      window({ latencyP95Ms: 1700 }),
      window({ latencyP95Ms: 1800 }),
    ];

    const examples = buildExamples({ id: 'seq', windows });
    // Sobram as janelas 0, 1 e 2: as três seguintes já estão em falha.
    expect(examples.map((example) => example.windowIndex)).toEqual([0, 1, 2]);
    expect(examples.map((example) => example.label)).toEqual([0, 1, 1]);
  });

  it('o dataset alinha linhas, rótulos e exemplos', () => {
    const windows = [window(), window(), window(), window({ errorRate: 0.8 }), window({ errorRate: 0.8 })];
    const { rows, labels, examples } = buildDataset([{ id: 'a', windows }, { id: 'b', windows }]);

    expect(rows).toHaveLength(labels.length);
    expect(rows).toHaveLength(examples.length);
    expect(rows.every((row) => row.length === FEATURE_NAMES.length)).toBe(true);
    expect(rows.every((row) => row.every(Number.isFinite))).toBe(true);
  });
});
