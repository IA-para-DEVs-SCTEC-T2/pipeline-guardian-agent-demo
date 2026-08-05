import { describe, expect, it } from 'vitest';

import { ANOMALY_RULES, SIGNAL_KEYS, detectAnomalies, evaluateSignals, readSignals } from '../src/day2/detect.mjs';
import { summarizeSamples } from '../src/day2/observe.mjs';

/** Uma baseline saudável, com os números que a aplicação real produz. */
const BASELINE = {
  latencyP95Ms: 8,
  errorRate: 0,
  logLinesPerRequest: 2,
  responseSizeP95Bytes: 3820,
};

/** Observação idêntica à baseline, salvo o que o teste alterar. */
const observed = (overrides = {}) => ({ ...BASELINE, ...overrides });

/** Trinta amostras iguais, salvo o que o teste alterar por índice. */
function samples(overridesFor = () => ({})) {
  return Array.from({ length: 30 }, (_, index) => ({
    sequence: index + 1,
    statusCode: 200,
    durationMs: 4,
    responseSizeBytes: 3820,
    logLineCount: 2,
    requestId: `r-${index + 1}`,
    ...overridesFor(index),
  }));
}

describe('cenário normal', () => {
  it('não detecta anomalia quando o observado é igual à baseline', () => {
    const result = detectAnomalies(BASELINE, observed());

    expect(result).toMatchObject({
      anomalyDetected: false,
      anomalyTypes: [],
      firstAnomalousSignal: null,
      gateResult: 'pass',
      triggeredRules: [],
    });
  });

  it('não detecta anomalia com variação pequena para cima e para baixo', () => {
    const result = detectAnomalies(
      BASELINE,
      observed({ latencyP95Ms: 11, logLinesPerRequest: 2, responseSizeP95Bytes: 3910 }),
    );

    expect(result.anomalyDetected).toBe(false);
    expect(result.gateResult).toBe('pass');
  });

  it('avalia os quatro sinais mesmo quando nenhum dispara', () => {
    const result = detectAnomalies(BASELINE, observed());

    expect(result.evaluations).toHaveLength(4);
    expect(result.evaluations.map((item) => item.signal)).toEqual(SIGNAL_KEYS);
    expect(result.evaluations.every((item) => item.status === 'normal')).toBe(true);
  });
});

describe('as duas condições são obrigatórias', () => {
  it('uma única requisição de 50 ms em 30 não gera anomalia', () => {
    // O P95 por posto mais próximo cai no índice 28 de 30: o valor isolado, que
    // fica no índice 29, não é alcançado.
    const summary = summarizeSamples(samples((index) => (index === 7 ? { durationMs: 50 } : {})));

    expect(summary.latencyP95Ms).toBe(4);
    expect(detectAnomalies(BASELINE, summary).anomalyDetected).toBe(false);
  });

  it('aumento relativo grande com diferença absoluta pequena não gera anomalia', () => {
    // 5× a baseline, mas apenas +16 ms: longe dos 150 ms exigidos.
    const result = detectAnomalies({ ...BASELINE, latencyP95Ms: 4 }, observed({ latencyP95Ms: 20 }));
    const latency = result.evaluations[0];

    expect(latency.conditions[0].met).toBe(true);
    expect(latency.conditions[1].met).toBe(false);
    expect(latency.triggered).toBe(false);
    expect(latency.status).toBe('relative_only');
    expect(latency.statusText).toBe('variação relativa alta, diferença absoluta pequena');
    expect(result.anomalyDetected).toBe(false);
  });

  it('diferença absoluta grande com aumento relativo pequeno não gera anomalia', () => {
    // Um serviço que já levava 900 ms passar a levar 1100 ms é +200 ms, mas
    // está longe de triplicar.
    const result = detectAnomalies({ ...BASELINE, latencyP95Ms: 900 }, observed({ latencyP95Ms: 1100 }));
    const latency = result.evaluations[0];

    expect(latency.conditions[0].met).toBe(false);
    expect(latency.conditions[1].met).toBe(true);
    expect(latency.status).toBe('absolute_only');
    expect(result.anomalyDetected).toBe(false);
  });

  it('baseline zero não vira anomalia automática', () => {
    // `observado ≥ 0 × 3` é sempre verdadeiro; quem segura a porta é a
    // condição absoluta.
    const zerada = { latencyP95Ms: 0, errorRate: 0, logLinesPerRequest: 0, responseSizeP95Bytes: 0 };
    const result = detectAnomalies(zerada, { latencyP95Ms: 6, errorRate: 0, logLinesPerRequest: 2, responseSizeP95Bytes: 900 });

    expect(result.anomalyDetected).toBe(false);
    expect(result.evaluations[0].ratio).toBeNull();
  });
});

describe('regra de latência', () => {
  it('dispara com ≥ 3× e ≥ 150 ms', () => {
    const result = detectAnomalies(BASELINE, observed({ latencyP95Ms: 260 }));

    expect(result.anomalyDetected).toBe(true);
    expect(result.anomalyTypes).toEqual(['latency']);
    expect(result.firstAnomalousSignal).toBe('latencyP95Ms');
    expect(result.gateResult).toBe('anomaly');
    expect(result.triggeredRules[0]).toMatchObject({
      signal: 'latencyP95Ms',
      baselineValue: 8,
      observedValue: 260,
      difference: 252,
      triggered: true,
    });
  });

  it('não dispara exatamente abaixo do limiar absoluto', () => {
    // 157 ms é 19,6× a baseline, mas a diferença é 149 ms.
    expect(detectAnomalies(BASELINE, observed({ latencyP95Ms: 157 })).anomalyDetected).toBe(false);
    // 158 ms fecha as duas condições.
    expect(detectAnomalies(BASELINE, observed({ latencyP95Ms: 158 })).anomalyDetected).toBe(true);
  });
});

describe('regra de taxa de erro', () => {
  it('dispara com ≥ 0,15 e ≥ 0,10 acima da baseline', () => {
    const result = detectAnomalies(BASELINE, observed({ errorRate: 0.2 }));

    expect(result.anomalyDetected).toBe(true);
    expect(result.anomalyTypes).toEqual(['error_rate']);
    expect(result.firstAnomalousSignal).toBe('errorRate');
  });

  it('não dispara abaixo do piso de 15%, por maior que seja o salto relativo', () => {
    // De 0,01 para 0,14 é 14×, e ainda assim está abaixo do piso.
    const result = detectAnomalies({ ...BASELINE, errorRate: 0.01 }, observed({ errorRate: 0.14 }));

    expect(result.anomalyDetected).toBe(false);
    expect(result.evaluations[1].status).toBe('absolute_only');
  });

  it('não dispara quando a baseline já era ruim e a diferença é pequena', () => {
    const result = detectAnomalies({ ...BASELINE, errorRate: 0.15 }, observed({ errorRate: 0.2 }));

    expect(result.anomalyDetected).toBe(false);
    expect(result.evaluations[1].status).toBe('relative_only');
  });
});

describe('regra de log por requisição', () => {
  it('dispara com ≥ 3× e ≥ 5 linhas', () => {
    const result = detectAnomalies(BASELINE, observed({ logLinesPerRequest: 7 }));

    expect(result.anomalyDetected).toBe(true);
    expect(result.anomalyTypes).toEqual(['log_volume']);
    expect(result.firstAnomalousSignal).toBe('logLinesPerRequest');
  });

  it('não dispara com 3× e apenas 4 linhas a mais', () => {
    const result = detectAnomalies(BASELINE, observed({ logLinesPerRequest: 6 }));

    expect(result.anomalyDetected).toBe(false);
    expect(result.evaluations[2].status).toBe('relative_only');
  });
});

describe('regra de tamanho da resposta', () => {
  it('dispara com ≥ 3× e ≥ 1500 bytes', () => {
    const result = detectAnomalies(BASELINE, observed({ responseSizeP95Bytes: 12_000 }));

    expect(result.anomalyDetected).toBe(true);
    expect(result.anomalyTypes).toEqual(['payload_size']);
    expect(result.firstAnomalousSignal).toBe('responseSizeP95Bytes');
  });

  it('não dispara quando o payload é pequeno, ainda que triplique', () => {
    const result = detectAnomalies({ ...BASELINE, responseSizeP95Bytes: 400 }, observed({ responseSizeP95Bytes: 1200 }));

    expect(result.anomalyDetected).toBe(false);
    expect(result.evaluations[3].status).toBe('relative_only');
  });
});

describe('vários sinais ao mesmo tempo', () => {
  it('firstAnomalousSignal segue a ordem de ANOMALY_RULES', () => {
    const result = detectAnomalies(
      BASELINE,
      observed({ latencyP95Ms: 900, errorRate: 0.5, logLinesPerRequest: 20, responseSizeP95Bytes: 40_000 }),
    );

    expect(result.anomalyTypes).toEqual(['latency', 'error_rate', 'log_volume', 'payload_size']);
    expect(result.firstAnomalousSignal).toBe('latencyP95Ms');
    expect(result.triggeredRules).toHaveLength(4);
  });

  it('sem latência, o primeiro sinal passa a ser o próximo da ordem', () => {
    const result = detectAnomalies(BASELINE, observed({ errorRate: 0.5, responseSizeP95Bytes: 40_000 }));

    expect(result.anomalyTypes).toEqual(['error_rate', 'payload_size']);
    expect(result.firstAnomalousSignal).toBe('errorRate');
  });
});

describe('forma da saída', () => {
  it('não expõe score nem nível de severidade', () => {
    const result = detectAnomalies(BASELINE, observed({ latencyP95Ms: 900 }));
    const chaves = [...Object.keys(result), ...Object.keys(result.evaluations[0])].join(' ');

    expect(chaves).not.toMatch(/score|severity|severidade|gravidade/i);
  });

  it('publica a regra e as duas condições, com a mesma conta que o código executou', () => {
    const [latency] = evaluateSignals(BASELINE, observed({ latencyP95Ms: 260 }));

    expect(latency.rule).toBe('observado ≥ baseline × 3 **e** observado − baseline ≥ 150 ms');
    expect(latency.conditions).toEqual([
      { text: 'observado ≥ baseline × 3', met: true },
      { text: 'observado − baseline ≥ 150 ms', met: true },
    ]);
    expect(latency.ratio).toBe(32.5);
  });

  it('as quatro regras cobrem exatamente os quatro sinais decisórios', () => {
    expect(ANOMALY_RULES.map((rule) => rule.signal)).toEqual(SIGNAL_KEYS);
    expect(ANOMALY_RULES).toHaveLength(4);
  });

  it('requestCount não é sinal decisório', () => {
    expect(SIGNAL_KEYS).not.toContain('requestCount');
    expect(readSignals({ requestCount: 999 })).not.toHaveProperty('requestCount');
  });

  it('sinal ausente vira zero em vez de exceção', () => {
    expect(readSignals({})).toEqual({
      latencyP95Ms: 0,
      errorRate: 0,
      logLinesPerRequest: 0,
      responseSizeP95Bytes: 0,
    });
    expect(() => detectAnomalies({}, {})).not.toThrow();
  });
});
