import { describe, expect, it } from 'vitest';

import { isFailureWindow } from '../src/day3/features.mjs';
import { splitSequences } from '../src/day3/evaluate.mjs';
import {
  GENERATOR_SEED,
  MAX_SEQUENCE_LENGTH,
  MIN_SEQUENCE_LENGTH,
  PATTERN_IDS,
  SEQUENCES_PER_PATTERN,
  createRandom,
  generateHistory,
} from '../src/day3/synthetic-history.mjs';

describe('gerador determinístico', () => {
  it('produz exatamente a mesma saída com a mesma semente', () => {
    expect(generateHistory({ seed: 4242 })).toEqual(generateHistory({ seed: 4242 }));
  });

  it('produz saída diferente com semente diferente', () => {
    const a = generateHistory({ seed: 1 });
    const b = generateHistory({ seed: 2 });
    expect(a).not.toEqual(b);
    // Mas a estrutura é a mesma: a semente muda os números, não o desenho.
    expect(a.map((sequence) => sequence.id)).toEqual(b.map((sequence) => sequence.id));
  });

  it('o PRNG devolve valores em [0, 1) e é reproduzível', () => {
    const first = Array.from({ length: 50 }, createRandom(7));
    const second = Array.from({ length: 50 }, createRandom(7));
    expect(first).toEqual(second);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('forma do histórico', () => {
  const sequences = generateHistory();

  it('gera ao menos 60 sequências, 10 por padrão', () => {
    expect(sequences.length).toBeGreaterThanOrEqual(60);
    expect(sequences).toHaveLength(PATTERN_IDS.length * SEQUENCES_PER_PATTERN);
    for (const pattern of PATTERN_IDS) {
      expect(sequences.filter((sequence) => sequence.pattern === pattern)).toHaveLength(
        SEQUENCES_PER_PATTERN,
      );
    }
  });

  it('cada sequência tem de 7 a 10 janelas, com valores finitos', () => {
    for (const sequence of sequences) {
      expect(sequence.windows.length).toBeGreaterThanOrEqual(MIN_SEQUENCE_LENGTH);
      expect(sequence.windows.length).toBeLessThanOrEqual(MAX_SEQUENCE_LENGTH);

      sequence.windows.forEach((window, index) => {
        expect(window.index).toBe(index);
        expect(Number.isFinite(window.latencyP95Ms)).toBe(true);
        expect(Number.isFinite(window.errorRate)).toBe(true);
        expect(Number.isFinite(window.logLinesPerRequest)).toBe(true);
        expect(window.latencyP95Ms).toBeGreaterThan(0);
        expect(window.errorRate).toBeGreaterThanOrEqual(0);
        expect(window.errorRate).toBeLessThanOrEqual(1);
        expect(typeof window.healthFailure).toBe('boolean');
      });
    }
  });

  it('as variações determinísticas evitam sequências idênticas dentro do padrão', () => {
    for (const pattern of PATTERN_IDS) {
      const serialized = sequences
        .filter((sequence) => sequence.pattern === pattern)
        .map((sequence) => JSON.stringify(sequence.windows));
      expect(new Set(serialized).size).toBe(serialized.length);
    }
  });

  it('nenhuma janela carrega o nome do padrão', () => {
    const windowKeys = new Set(sequences.flatMap((s) => s.windows.flatMap((w) => Object.keys(w))));
    expect([...windowKeys].sort()).toEqual([
      'errorRate',
      'healthFailure',
      'index',
      'latencyP95Ms',
      'logLinesPerRequest',
    ]);
  });
});

describe('padrões com e sem falha', () => {
  const sequences = generateHistory();
  const byPattern = (pattern) => sequences.filter((sequence) => sequence.pattern === pattern);

  it.each(['latency-growth', 'error-growth', 'log-then-latency', 'mixed-degradation'])(
    'o padrão %s sempre termina em falha',
    (pattern) => {
      for (const sequence of byPattern(pattern)) {
        expect(sequence.hasFailure).toBe(true);
        // A falha nunca é a primeira janela: sem história saudável não há o que prever.
        expect(sequence.windows.findIndex(isFailureWindow)).toBeGreaterThanOrEqual(4);
      }
    },
  );

  it.each(['stable-normal', 'transient-spike', 'moderate-noise', 'plateau-below-threshold'])(
    'o padrão %s nunca atinge o limite de falha',
    (pattern) => {
      for (const sequence of byPattern(pattern)) {
        expect(sequence.hasFailure).toBe(false);
        expect(sequence.windows.some(isFailureWindow)).toBe(false);
      }
    },
  );

  it('o pico transitório sobe e volta na janela seguinte', () => {
    for (const sequence of byPattern('transient-spike')) {
      const peak = Math.max(...sequence.windows.map((window) => window.latencyP95Ms));
      const peakIndex = sequence.windows.findIndex((window) => window.latencyP95Ms === peak);
      const next = sequence.windows[peakIndex + 1];
      expect(next).toBeDefined();
      expect(next.latencyP95Ms).toBeLessThan(peak);
    }
  });
});

describe('divisão treino/teste', () => {
  const sequences = generateHistory();
  const { train, test } = splitSequences(sequences);

  it('separa sequências completas, sem sobreposição de janelas', () => {
    const trainIds = new Set(train.map((sequence) => sequence.id));
    const testIds = new Set(test.map((sequence) => sequence.id));

    expect(trainIds.size + testIds.size).toBe(sequences.length);
    for (const id of testIds) expect(trainIds.has(id)).toBe(false);
    // Nenhuma sequência aparece parcialmente dos dois lados.
    for (const sequence of test) {
      expect(train.some((other) => other.id === sequence.id)).toBe(false);
    }
  });

  it('mantém 70/30 e estratifica por padrão', () => {
    expect(train.length / sequences.length).toBeCloseTo(0.7, 2);
    for (const pattern of PATTERN_IDS) {
      expect(test.filter((sequence) => sequence.pattern === pattern).length).toBeGreaterThan(0);
      expect(train.filter((sequence) => sequence.pattern === pattern).length).toBeGreaterThan(0);
    }
  });

  it('é determinística: a mesma semente dá a mesma divisão', () => {
    const again = splitSequences(generateHistory({ seed: GENERATOR_SEED }));
    expect(again.train.map((sequence) => sequence.id)).toEqual(train.map((sequence) => sequence.id));
    expect(again.test.map((sequence) => sequence.id)).toEqual(test.map((sequence) => sequence.id));
  });
});
