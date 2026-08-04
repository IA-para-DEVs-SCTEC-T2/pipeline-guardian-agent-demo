/**
 * Detector de anomalias — Dia 2.
 *
 * Módulo **puro**: não lê arquivo, não abre rede, não chama modelo. Recebe dois
 * números medidos e dois números de baseline, e devolve um veredito.
 *
 * ## O princípio
 *
 * A decisão é determinística. `anomalyDetected`, `anomalyType`,
 * `firstAnomalousSignal` e `gateResult` saem daqui e **nunca** da IA. A IA lê o
 * resultado pronto e explica; se ela discordar, o resultado continua sendo
 * este. É a mesma invariante do Dia 1 (o modelo não decide deploy), aplicada ao
 * assunto do Dia 2.
 *
 * ## Dois sinais, e só dois
 *
 * - `latencyP95Ms` — latência p95 de `GET /api/report`;
 * - `logLinesPerRequest` — linhas de log estruturado por requisição da mesma
 *   rota.
 *
 * `requestCount`, `statusCode`, `errorCount`, `latencyMinMs` e `latencyMaxMs`
 * aparecem no relatório como **contexto** e não entram na decisão. Métrica que
 * decide é métrica que precisa de baseline, de regra e de explicação; cinco
 * delas a mais transformariam um laboratório de uma hora numa plataforma de
 * observabilidade pela metade.
 *
 * ## Por que p95, e não média nem máximo
 *
 * A média some com o problema: 10 requisições de 500 ms entre 30 viram 170 ms
 * de média, que ainda parece "meio lento". O máximo faz o contrário — uma única
 * requisição infeliz (o primeiro acesso, o GC) vira incidente. O p95 fica no
 * meio: enxerga a cauda sem ser refém de um ponto isolado.
 *
 * ## Por que duas condições, e não uma
 *
 * Cada sinal só dispara quando a diferença é **relativa** (≥ 3× a baseline) e
 * **absoluta** (≥ 150 ms, ≥ 5 linhas) ao mesmo tempo:
 *
 * - só a relativa: uma baseline de 2 ms com observação de 7 ms é 3,5× — e não
 *   significa nada. É a fábrica de falso positivo do laboratório;
 * - só a absoluta: uma aplicação que normalmente responde em 900 ms levaria
 *   1.050 ms sem que nada tivesse mudado.
 *
 * As duas juntas dizem "mudou de patamar **e** o tamanho da mudança importa".
 */

/** A rota observada. Uma só, de propósito. */
export const OBSERVED_ROUTE = '/api/report';

/** Sinais decisórios, na ordem em que são avaliados. */
export const SIGNALS = ['latencyP95Ms', 'logLinesPerRequest'];

/** Tipo de anomalia por sinal. */
export const ANOMALY_TYPE_BY_SIGNAL = {
  latencyP95Ms: 'latency',
  logLinesPerRequest: 'log-volume',
};

/**
 * Limiares. `ratio` é a diferença relativa; `absolute`, a mínima em unidade do
 * sinal. Mudou um número aqui, mudou a regra para todo mundo — inclusive para
 * os textos do relatório, que são gerados a partir destes valores.
 */
export const THRESHOLDS = {
  latencyP95Ms: { ratio: 3, absolute: 150, unit: 'ms' },
  logLinesPerRequest: { ratio: 3, absolute: 5, unit: 'linhas' },
};

/** Rótulo humano de cada sinal, usado no relatório e na explicação. */
export const SIGNAL_LABELS = {
  latencyP95Ms: 'latência p95 (ms)',
  logLinesPerRequest: 'linhas de log por requisição',
};

/**
 * Arredonda para duas casas. Métrica de laboratório com sete casas decimais não
 * é mais precisa — é só mais difícil de ler em voz alta na aula.
 *
 * @param {number} value
 * @returns {number}
 */
export function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/**
 * Percentil 95 pelo método do **posto mais próximo**: ordena e pega o valor na
 * posição `ceil(0.95 × n)`.
 *
 * Sem interpolação de propósito — o valor devolvido é uma medição que existiu de
 * verdade, e não uma média entre duas. Com 30 amostras, cai na 29ª: a mais lenta
 * é descartada, as duas mais lentas não.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function percentile95(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;

  const rank = Math.ceil(0.95 * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return round2(sorted[index]);
}

/**
 * Reduz as medições brutas aos dois sinais + o contexto exibido no relatório.
 *
 * @param {object} input
 * @param {Array<{ durationMs: number, statusCode: number }>} input.samples
 * @param {number} input.logLineCount linhas de log atribuídas às amostras
 * @param {string} [input.route]
 * @returns {object} observação
 */
export function summarizeMeasurement({ samples = [], logLineCount = 0, route = OBSERVED_ROUTE } = {}) {
  const durations = samples.map((sample) => Number(sample.durationMs));
  const sampleCount = samples.length;

  const statusCodes = {};
  let errorCount = 0;
  for (const sample of samples) {
    const code = String(sample.statusCode ?? 'sem-resposta');
    statusCodes[code] = (statusCodes[code] ?? 0) + 1;
    if (!(Number(sample.statusCode) >= 200 && Number(sample.statusCode) < 400)) errorCount += 1;
  }

  return {
    route,
    sampleCount,
    // Os dois sinais decisórios.
    latencyP95Ms: percentile95(durations),
    logLinesPerRequest: sampleCount > 0 ? round2(logLineCount / sampleCount) : 0,
    // Contexto. Não decide nada — ver o cabeçalho do módulo.
    context: {
      requestCount: sampleCount,
      errorCount,
      statusCodes,
      logLineCount,
      latencyMinMs: durations.length > 0 ? round2(Math.min(...durations)) : 0,
      latencyMaxMs: durations.length > 0 ? round2(Math.max(...durations)) : 0,
    },
  };
}

/**
 * Texto da regra relativa, exatamente como aparece em `triggeredRules`.
 *
 * @param {string} signal
 * @returns {string}
 */
export function ratioRuleText(signal) {
  return `${signal} >= baseline * ${THRESHOLDS[signal].ratio}`;
}

/**
 * Texto da regra absoluta.
 *
 * @param {string} signal
 * @returns {string}
 */
export function absoluteRuleText(signal) {
  const { absolute, unit } = THRESHOLDS[signal];
  return `${signal} - baseline >= ${absolute} ${unit}`;
}

/**
 * Avalia um sinal contra a sua baseline.
 *
 * @param {object} input
 * @param {string} input.signal
 * @param {number} input.baseline
 * @param {number} input.observed
 * @returns {object} avaliação, com as duas regras e o veredito do sinal
 */
export function evaluateSignal({ signal, baseline, observed }) {
  const baselineValue = toNumber(baseline);
  const observedValue = toNumber(observed);
  const { ratio, absolute } = THRESHOLDS[signal];

  const difference = round2(observedValue - baselineValue);
  const ratioSatisfied = observedValue >= baselineValue * ratio;
  const absoluteSatisfied = difference >= absolute;

  return {
    signal,
    label: SIGNAL_LABELS[signal],
    baseline: baselineValue,
    observed: observedValue,
    difference,
    // Baseline zero não tem razão definida: dividir por zero produziria
    // `Infinity` no relatório, que não é informação — é ruído.
    ratio: baselineValue > 0 ? round2(observedValue / baselineValue) : null,
    ratioRule: { text: ratioRuleText(signal), satisfied: ratioSatisfied },
    absoluteRule: { text: absoluteRuleText(signal), satisfied: absoluteSatisfied },
    // As duas condições, sempre. Ver o cabeçalho do módulo.
    triggered: ratioSatisfied && absoluteSatisfied,
  };
}

/**
 * O veredito.
 *
 * Percorre os sinais em ordem fixa. O primeiro que dispara define
 * `firstAnomalousSignal` e `anomalyType`; `triggeredRules` traz as regras de
 * todos os sinais que dispararam, para que o relatório nunca esconda que dois
 * sinais desviaram ao mesmo tempo.
 *
 * @param {object} input
 * @param {{ latencyP95Ms: number, logLinesPerRequest: number }} input.baseline
 * @param {{ latencyP95Ms: number, logLinesPerRequest: number }} input.observed
 * @returns {object} resultado determinístico
 */
export function detectAnomaly({ baseline = {}, observed = {} } = {}) {
  const evaluations = SIGNALS.map((signal) =>
    evaluateSignal({ signal, baseline: baseline[signal], observed: observed[signal] }),
  );

  const first = evaluations.find((evaluation) => evaluation.triggered) ?? null;
  const triggeredRules = evaluations
    .filter((evaluation) => evaluation.triggered)
    .flatMap((evaluation) => [evaluation.ratioRule.text, evaluation.absoluteRule.text]);

  return {
    anomalyDetected: Boolean(first),
    anomalyType: first ? ANOMALY_TYPE_BY_SIGNAL[first.signal] : null,
    firstAnomalousSignal: first ? first.signal : null,
    gateResult: first ? 'fail' : 'pass',
    baseline: {
      latencyP95Ms: toNumber(baseline.latencyP95Ms),
      logLinesPerRequest: toNumber(baseline.logLinesPerRequest),
    },
    observed: {
      latencyP95Ms: toNumber(observed.latencyP95Ms),
      logLinesPerRequest: toNumber(observed.logLinesPerRequest),
    },
    triggeredRules,
    // Por que cada sinal disparou — ou por que não disparou. É o que permite ao
    // relatório mostrar a conta, e não só o resultado dela.
    evaluations,
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round2(parsed) : 0;
}
