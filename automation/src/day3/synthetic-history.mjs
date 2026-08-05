/**
 * Dia 3 — histórico sintético, determinístico e reproduzível.
 *
 * O laboratório precisa de dados que ninguém consiga contestar por acidente:
 * mesma semente, mesmas 80 sequências, os mesmos números até a última casa
 * decimal. Por isso **nenhum** `Math.random()` aparece aqui — o gerador é um
 * `mulberry32` semeado, e cada sequência recebe a sua própria derivação da
 * semente para que acrescentar um padrão no fim da lista não desloque os
 * números de todos os anteriores.
 *
 * Os oito padrões existem para ensinar uma distinção só, dita de oito maneiras:
 * **degradação persistente e crescente termina em falha; pico isolado, ruído e
 * platô, não.** Sem os quatro padrões negativos (`stable-normal`,
 * `transient-spike`, `moderate-noise`, `plateau-below-threshold`) o modelo
 * aprenderia que "métrica alta = falha" e reprovaria todo pico transitório —
 * exatamente o falso positivo que a aula quer discutir.
 *
 * O identificador do padrão viaja junto com a sequência como **metadado**, para
 * a estratificação treino/teste e para o relatório. Ele nunca entra numa
 * feature: ver `features.mjs`.
 */

import { isFailureWindow } from './features.mjs';

/** Semente fixa do laboratório. Mudar aqui muda todo o dataset. */
export const GENERATOR_SEED = 20260805;

/** Sequências por padrão. 8 padrões × 10 = 80 sequências. */
export const SEQUENCES_PER_PATTERN = 10;

/** Comprimento das sequências: 7 a 10 janelas. */
export const MIN_SEQUENCE_LENGTH = 7;
export const MAX_SEQUENCE_LENGTH = 10;

/**
 * Gerador pseudoaleatório `mulberry32`.
 *
 * Escolhido por caber em cinco linhas e ser auditável a olho nu: num
 * laboratório didático, o gerador de números não pode ser a parte misteriosa.
 *
 * @param {number} seed
 * @returns {() => number} valores em [0, 1)
 */
export function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Descrição de cada padrão, para o relatório de treino. */
export const PATTERN_LABELS = Object.freeze({
  'stable-normal': 'Operação estável dentro da baseline',
  'latency-growth': 'Latência crescendo de forma gradual até a falha',
  'error-growth': 'Taxa de erro crescendo de forma gradual até a falha',
  'log-then-latency': 'Volume de logs crescendo e, em seguida, latência e falha',
  'mixed-degradation': 'Degradação mista (latência e erros) até a falha',
  'transient-spike': 'Pico isolado com recuperação imediata, sem falha',
  'moderate-noise': 'Ruído moderado sem tendência e sem falha',
  'plateau-below-threshold': 'Degradação que estabiliza abaixo do limite de falha',
});

const PATTERN_BUILDERS = Object.freeze({
  'stable-normal': buildStableNormal,
  'latency-growth': buildLatencyGrowth,
  'error-growth': buildErrorGrowth,
  'log-then-latency': buildLogThenLatency,
  'mixed-degradation': buildMixedDegradation,
  'transient-spike': buildTransientSpike,
  'moderate-noise': buildModerateNoise,
  'plateau-below-threshold': buildPlateauBelowThreshold,
});

/** Os oito padrões, na ordem em que são gerados. */
export const PATTERN_IDS = Object.freeze(Object.keys(PATTERN_BUILDERS));

/**
 * Gera o histórico completo do laboratório.
 *
 * @param {object} [input]
 * @param {number} [input.seed]
 * @param {number} [input.sequencesPerPattern]
 * @returns {Array<{ id: string, pattern: string, length: number, windows: object[],
 *                   hasFailure: boolean }>}
 */
export function generateHistory({
  seed = GENERATOR_SEED,
  sequencesPerPattern = SEQUENCES_PER_PATTERN,
} = {}) {
  const sequences = [];

  PATTERN_IDS.forEach((pattern, patternIndex) => {
    for (let variant = 0; variant < sequencesPerPattern; variant += 1) {
      // Semente própria por sequência: acrescentar um padrão no fim não muda
      // os números dos padrões anteriores.
      const random = createRandom(seed + patternIndex * 1000 + variant * 7);
      const length =
        MIN_SEQUENCE_LENGTH + (variant % (MAX_SEQUENCE_LENGTH - MIN_SEQUENCE_LENGTH + 1));

      const windows = PATTERN_BUILDERS[pattern](random, length, variant).map(finishWindow);

      sequences.push({
        id: `${pattern}-${String(variant + 1).padStart(2, '0')}`,
        pattern,
        variant,
        length: windows.length,
        windows,
        hasFailure: windows.some(isFailureWindow),
      });
    }
  });

  return sequences;
}

/* ------------------------------------------------------------------------- */
/* Padrões                                                                     */
/* ------------------------------------------------------------------------- */

/** Estável: tudo dentro da baseline, sem tendência. */
function buildStableNormal(random, length) {
  return range(length).map((index) => ({
    index,
    latencyP95Ms: 10 + random() * 8,
    errorRate: random() * 0.02,
    logLinesPerRequest: 1.8 + random() * 0.6,
    healthFailure: false,
  }));
}

/**
 * Latência subindo em progressão geométrica até estourar 1500 ms.
 *
 * **Erros e logs quase não se mexem aqui, de propósito.** Este é o padrão que
 * ensina que latência crescente e persistente basta para prever falha. Se toda
 * sequência de latência trouxesse junto uma taxa de erro subindo, o modelo
 * aprenderia a depender do erro e daria "atenção" — não "mitigar" — a uma
 * degradação de latência pura, que é exatamente o cenário `latency-growth` da
 * aula.
 */
function buildLatencyGrowth(random, length, variant) {
  const failureAt = failureIndex(length, variant);
  const start = 10 + random() * 6;
  const peak = 1650 + random() * 900;
  const growth = (peak / start) ** (1 / failureAt);

  return range(length).map((index) => {
    const base = start * growth ** index;
    const progress = index / failureAt;
    return {
      index,
      latencyP95Ms: clampLatency(base * jitter(random, 0.1), index, failureAt),
      errorRate: Math.min(0.07, progress * 0.05 * jitter(random, 0.3)),
      logLinesPerRequest: 1.9 + progress * 0.9 * jitter(random, 0.2),
      healthFailure: false,
    };
  });
}

/** Taxa de erro subindo em curva côncava até passar de 0,50. */
function buildErrorGrowth(random, length, variant) {
  const failureAt = failureIndex(length, variant);
  const peak = 0.52 + random() * 0.14;
  const curve = 1.8 + random() * 0.9;
  const latencyPeak = 60 + random() * 260;

  return range(length).map((index) => {
    const progress = index / failureAt;
    const raw = peak * progress ** curve * jitter(random, 0.12);
    return {
      index,
      latencyP95Ms: 12 + latencyPeak * progress ** 1.6 * jitter(random, 0.15),
      errorRate: clampErrorRate(raw, index, failureAt),
      logLinesPerRequest: 1.9 + progress * 2.2 * jitter(random, 0.2),
      healthFailure: false,
    };
  });
}

/**
 * Logs crescendo primeiro; latência explode só nas duas últimas janelas.
 *
 * É o padrão que sustenta o cenário `log-growth`: o volume de log é o sinal
 * antecedente, não a causa confirmada. O relatório repete essa distinção.
 */
function buildLogThenLatency(random, length, variant) {
  const failureAt = failureIndex(length, variant);
  const logPeak = 24 + random() * 14;
  const logGrowth = (logPeak / 2) ** (1 / failureAt);
  const peak = 1600 + random() * 700;

  return range(length).map((index) => {
    // A latência só reage nas duas janelas finais da rampa.
    const stepsToFailure = failureAt - index;
    const latency =
      stepsToFailure >= 2
        ? 12 + index * (random() * 6)
        : stepsToFailure === 1
          ? 260 + random() * 420
          : peak;

    return {
      index,
      latencyP95Ms: clampLatency(latency * jitter(random, 0.08), index, failureAt),
      errorRate: Math.min(0.22, (index / failureAt) * 0.18 * jitter(random, 0.3)),
      logLinesPerRequest: 2 * logGrowth ** index * jitter(random, 0.1),
      healthFailure: false,
    };
  });
}

/** Latência e erros subindo juntos; a falha vem pela taxa de erro. */
function buildMixedDegradation(random, length, variant) {
  const failureAt = failureIndex(length, variant);
  const latencyPeak = 780 + random() * 560;
  const errorPeak = 0.54 + random() * 0.2;
  const logPeak = 7 + random() * 8;

  return range(length).map((index) => {
    const progress = index / failureAt;
    const failing = index >= failureAt;

    return {
      index,
      latencyP95Ms: Math.min(1450, (12 + latencyPeak * progress ** 2.4) * jitter(random, 0.12)),
      errorRate: clampErrorRate(errorPeak * progress ** 2.6 * jitter(random, 0.12), index, failureAt),
      logLinesPerRequest: 2 + logPeak * progress ** 2.0 * jitter(random, 0.15),
      // Um terço das variantes acrescenta o health check reprovado — a mesma
      // falha vista por outra condição do alvo.
      healthFailure: failing && variant % 3 === 0,
    };
  });
}

/**
 * Um pico isolado, alto, seguido de recuperação — e **sem** falha.
 *
 * O contraexemplo mais importante do dataset. Sem ele, o modelo aprende que
 * "métrica alta agora" basta para prever falha, e o cenário `transient-spike`
 * da aula passaria do limiar.
 */
function buildTransientSpike(random, length, variant) {
  const spikeAt = 2 + (variant % Math.max(1, length - 5));
  const errorSpike = variant % 2 === 1;

  return range(length).map((index) => {
    const distance = index - spikeAt;

    if (distance === 0) {
      return {
        index,
        // Alto o bastante para assustar, baixo o bastante para não ser falha.
        latencyP95Ms: errorSpike ? 120 + random() * 200 : 320 + random() * 380,
        errorRate: errorSpike ? 0.16 + random() * 0.14 : random() * 0.03,
        logLinesPerRequest: 2.2 + random() * 2.6,
        healthFailure: false,
      };
    }

    if (distance === 1) {
      // Recuperação parcial: ainda acima do normal, já abaixo da degradação.
      return {
        index,
        latencyP95Ms: 40 + random() * 60,
        errorRate: errorSpike ? 0.02 + random() * 0.05 : random() * 0.02,
        logLinesPerRequest: 2 + random() * 1.2,
        healthFailure: false,
      };
    }

    return {
      index,
      latencyP95Ms: 10 + random() * 9,
      errorRate: random() * 0.02,
      logLinesPerRequest: 1.8 + random() * 0.7,
      healthFailure: false,
    };
  });
}

/** Ruído sem tendência: oscila, nunca degrada, nunca falha. */
function buildModerateNoise(random, length) {
  return range(length).map((index) => ({
    index,
    latencyP95Ms: 12 + random() * 45,
    errorRate: random() * 0.11,
    logLinesPerRequest: 1.5 + random() * 3.4,
    healthFailure: false,
  }));
}

/**
 * Degradação que sobe, estabiliza e fica — sem nunca atingir o limite de falha.
 *
 * Ensina que persistência sozinha não prevê falha: sem tendência de
 * crescimento, um sistema degradado pode simplesmente permanecer degradado.
 */
function buildPlateauBelowThreshold(random, length, variant) {
  const rampWindows = 3 + (variant % 3);
  const plateauLatency = 180 + random() * 260;
  const plateauError = 0.15 + random() * 0.15;
  const plateauLogs = 6.5 + random() * 5;

  return range(length).map((index) => {
    const progress = Math.min(1, index / rampWindows);
    return {
      index,
      latencyP95Ms: (12 + (plateauLatency - 12) * progress) * jitter(random, 0.05),
      errorRate: Math.min(0.42, plateauError * progress * jitter(random, 0.08)),
      logLinesPerRequest: (2 + (plateauLogs - 2) * progress) * jitter(random, 0.06),
      healthFailure: false,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                  */
/* ------------------------------------------------------------------------- */

function range(size) {
  return Array.from({ length: size }, (_value, index) => index);
}

/** Ruído multiplicativo determinístico: 1 ± `amount`. */
function jitter(random, amount) {
  return 1 + (random() * 2 - 1) * amount;
}

/**
 * Onde a falha começa: uma das três últimas janelas, variando por variante.
 *
 * Quanto mais cedo a falha, mais janelas rotuladas `1` a sequência produz — a
 * janela que enxerga a falha no horizonte e as duas anteriores. Variar entre as
 * três posições dá ao modelo exemplos positivos em distâncias diferentes do
 * evento, que é o que ele precisa para acender **antes** e não junto.
 *
 * Nunca antes da quarta janela: uma sequência que falha logo no começo não tem
 * história saudável para o modelo observar.
 */
function failureIndex(length, variant) {
  return Math.max(4, length - 1 - (variant % 3));
}

/**
 * Mantém a rampa de latência do lado certo do limite em cada janela.
 *
 * O ruído multiplicativo pode empurrar a janela anterior à falha acima de
 * 1500 ms (antecipando a falha) ou a janela da falha abaixo dele (apagando a
 * falha). O grampo resolve os dois casos sem alterar o formato da curva.
 */
function clampLatency(value, index, failureAt) {
  if (index >= failureAt) return Math.max(1520, value);
  return Math.min(1400, value);
}

/** Mesmo grampo, para a taxa de erro. */
function clampErrorRate(value, index, failureAt) {
  if (index >= failureAt) return Math.min(0.95, Math.max(0.52, value));
  return Math.max(0, Math.min(0.46, value));
}

/**
 * Arredonda a janela para valores estáveis em JSON.
 *
 * Sem isso, um `0.30000000000000004` no meio de uma tabela didática vira
 * pergunta em sala — e o arredondamento não muda nenhuma decisão, porque os
 * limites de falha estão longe da terceira casa decimal.
 */
function finishWindow(window, index) {
  return {
    index,
    latencyP95Ms: Math.round(window.latencyP95Ms),
    errorRate: Number(Math.max(0, window.errorRate).toFixed(4)),
    logLinesPerRequest: Number(Math.max(0, window.logLinesPerRequest).toFixed(2)),
    healthFailure: window.healthFailure === true,
  };
}
