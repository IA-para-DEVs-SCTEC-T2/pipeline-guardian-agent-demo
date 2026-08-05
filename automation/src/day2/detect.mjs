/**
 * Detector de anomalias — regras transparentes, sem estatística escondida.
 *
 * Este módulo é **puro**: não lê arquivo, não abre rede, não olha o relógio.
 * Recebe dois conjuntos de quatro números (baseline e observado) e devolve um
 * veredito que qualquer pessoa consegue refazer com uma calculadora. É essa
 * propriedade — e não a sofisticação — que faz dele o gate.
 *
 * Cinco decisões que valem para quem for evoluir:
 *
 * 1. **Duas condições, sempre em `E`.** Cada regra exige variação *relativa*
 *    **e** diferença *absoluta*. Sozinha, a relativa transforma 2 ms → 8 ms em
 *    "latência quadruplicou"; sozinha, a absoluta transforma um serviço que
 *    sempre levou 900 ms em anômalo por levar 1050 ms. Juntas, só passa o que é
 *    grande nas duas escalas. É também o que protege o cálculo quando a baseline
 *    é zero: `observado ≥ 0 × 3` é sempre verdadeiro, e é a condição absoluta que
 *    segura a porta.
 * 2. **Sem score, sem severidade.** Um número de 0 a 100 parece mais informativo
 *    e é menos acionável: ninguém sabe dizer por que deu 73. Aqui a saída é
 *    binária por sinal, e ao lado dela fica a conta que a produziu.
 * 3. **A ordem de `ANOMALY_RULES` é a ordem do veredito.** `firstAnomalousSignal`
 *    é o primeiro sinal disparado *nesta* ordem — latência, erro, log, payload —
 *    que é a ordem em que os sintomas costumam aparecer para quem opera. Não é o
 *    "mais grave": não existe mais grave sem severidade, e inventar uma aqui
 *    seria reintroduzir pela porta dos fundos o score que a decisão 2 recusa.
 * 4. **Regra que não disparou também é resultado.** `evaluations` traz os quatro
 *    sinais sempre, com as duas condições avaliadas separadamente. "Subiu 5×, mas
 *    a diferença foi de 16 ms" é a explicação que impede a pergunta seguinte — e
 *    é a única forma de o painel mostrar por que um pico visível não virou
 *    anomalia.
 * 5. **A IA não entra aqui.** Este arquivo não importa nada de `explain.mjs`, e a
 *    dependência na direção contrária é de propósito: o modelo explica um
 *    veredito que já existe. Ver `explain.mjs`.
 */

/** Os quatro sinais decisórios. `requestCount` é contexto e não aparece aqui. */
export const SIGNAL_KEYS = [
  'latencyP95Ms',
  'errorRate',
  'logLinesPerRequest',
  'responseSizeP95Bytes',
];

/** Resultados possíveis do gate. Binário, como a decisão 2 exige. */
export const GATE_RESULTS = ['pass', 'anomaly'];

/**
 * As quatro regras, na ordem do veredito (decisão 3).
 *
 * `relative` e `absolute` são funções para que o painel e o Markdown imprimam a
 * **mesma** conta que o código executou. Uma regra descrita num texto e aplicada
 * noutro lugar é uma regra que diverge da própria documentação na primeira
 * mudança de limiar.
 */
export const ANOMALY_RULES = [
  {
    id: 'latency',
    signal: 'latencyP95Ms',
    anomalyType: 'latency',
    label: 'Latência (P95)',
    unit: 'ms',
    decimals: 2,
    relativeFactor: 3,
    absoluteDelta: 150,
    relative: (baseline, observed) => observed >= baseline * 3,
    absolute: (baseline, observed) => observed - baseline >= 150,
    relativeText: 'observado ≥ baseline × 3',
    absoluteText: 'observado − baseline ≥ 150 ms',
  },
  {
    id: 'error_rate',
    signal: 'errorRate',
    anomalyType: 'error_rate',
    label: 'Taxa de erro',
    unit: '',
    decimals: 4,
    // A primeira condição desta regra é um piso absoluto, não um múltiplo: uma
    // baseline saudável tem `errorRate: 0`, e multiplicar zero por três nunca
    // detectaria nada. 15% de falha é ruim independentemente do histórico.
    relativeFactor: null,
    absoluteDelta: 0.1,
    relative: (_baseline, observed) => observed >= 0.15,
    absolute: (baseline, observed) => observed - baseline >= 0.1,
    relativeText: 'observado ≥ 0,15 (15%)',
    absoluteText: 'observado − baseline ≥ 0,10 (10 p.p.)',
  },
  {
    id: 'log_volume',
    signal: 'logLinesPerRequest',
    anomalyType: 'log_volume',
    label: 'Linhas de log por requisição',
    unit: '',
    decimals: 2,
    relativeFactor: 3,
    absoluteDelta: 5,
    relative: (baseline, observed) => observed >= baseline * 3,
    absolute: (baseline, observed) => observed - baseline >= 5,
    relativeText: 'observado ≥ baseline × 3',
    absoluteText: 'observado − baseline ≥ 5 linhas',
  },
  {
    id: 'payload_size',
    signal: 'responseSizeP95Bytes',
    anomalyType: 'payload_size',
    label: 'Tamanho da resposta (P95)',
    unit: 'bytes',
    decimals: 0,
    relativeFactor: 3,
    absoluteDelta: 1500,
    relative: (baseline, observed) => observed >= baseline * 3,
    absolute: (baseline, observed) => observed - baseline >= 1500,
    relativeText: 'observado ≥ baseline × 3',
    absoluteText: 'observado − baseline ≥ 1500 bytes',
  },
];

/** Rótulos textuais do status de cada cartão. Texto, nunca só cor. */
export const SIGNAL_STATUS_LABELS = {
  normal: 'dentro da baseline',
  relative_only: 'variação relativa alta, diferença absoluta pequena',
  absolute_only: 'diferença absoluta alta, variação relativa pequena',
  anomaly: 'anomalia detectada',
};

/**
 * Extrai os quatro sinais de um objeto qualquer, com `0` para o que faltar.
 *
 * Campo ausente vira zero e **não** vira exceção: uma baseline gravada por uma
 * versão anterior do laboratório ainda produz um relatório legível, com a
 * diferença aparecendo no painel em vez de num stack trace.
 *
 * @param {object} input
 * @returns {{ latencyP95Ms: number, errorRate: number, logLinesPerRequest: number, responseSizeP95Bytes: number }}
 */
export function readSignals(input = {}) {
  return Object.fromEntries(
    SIGNAL_KEYS.map((key) => {
      const value = Number(input?.[key]);
      return [key, Number.isFinite(value) ? value : 0];
    }),
  );
}

/**
 * Avalia uma regra, disparando ou não.
 *
 * @param {object} rule uma de `ANOMALY_RULES`
 * @param {object} baseline sinais da baseline
 * @param {object} observed sinais observados
 * @returns {object} avaliação completa, com as duas condições separadas
 */
export function evaluateRule(rule, baseline, observed) {
  const baselineValue = Number(baseline?.[rule.signal]) || 0;
  const observedValue = Number(observed?.[rule.signal]) || 0;

  const relativeMet = rule.relative(baselineValue, observedValue);
  const absoluteMet = rule.absolute(baselineValue, observedValue);
  const triggered = relativeMet && absoluteMet;

  return {
    id: rule.id,
    signal: rule.signal,
    anomalyType: rule.anomalyType,
    label: rule.label,
    unit: rule.unit,
    decimals: rule.decimals,
    baselineValue,
    observedValue,
    difference: roundTo(observedValue - baselineValue, rule.decimals),
    // `null` quando a baseline é zero: "aumentou infinitas vezes" não é
    // informação, é divisão por zero com roupa de métrica.
    ratio: baselineValue > 0 ? roundTo(observedValue / baselineValue, 2) : null,
    conditions: [
      { text: rule.relativeText, met: relativeMet },
      { text: rule.absoluteText, met: absoluteMet },
    ],
    rule: `${rule.relativeText} **e** ${rule.absoluteText}`,
    triggered,
    status: statusOf(relativeMet, absoluteMet),
    statusText: SIGNAL_STATUS_LABELS[statusOf(relativeMet, absoluteMet)],
  };
}

/**
 * Avalia os quatro sinais, disparando ou não. É o que alimenta os cartões do
 * painel (decisão 4).
 *
 * @param {object} baseline
 * @param {object} observed
 * @returns {Array<object>}
 */
export function evaluateSignals(baseline, observed) {
  const baselineSignals = readSignals(baseline);
  const observedSignals = readSignals(observed);

  return ANOMALY_RULES.map((rule) => evaluateRule(rule, baselineSignals, observedSignals));
}

/**
 * O veredito.
 *
 * @param {object} baseline sinais de referência
 * @param {object} observed sinais da execução observada
 * @returns {{
 *   anomalyDetected: boolean,
 *   anomalyTypes: string[],
 *   firstAnomalousSignal: string|null,
 *   gateResult: 'pass'|'anomaly',
 *   triggeredRules: Array<object>,
 *   evaluations: Array<object>,
 * }}
 */
export function detectAnomalies(baseline, observed) {
  const evaluations = evaluateSignals(baseline, observed);
  const triggeredRules = evaluations.filter((evaluation) => evaluation.triggered);
  const anomalyDetected = triggeredRules.length > 0;

  return {
    anomalyDetected,
    anomalyTypes: triggeredRules.map((evaluation) => evaluation.anomalyType),
    // Primeiro na ordem de `ANOMALY_RULES` — que é a ordem de `evaluations`.
    firstAnomalousSignal: anomalyDetected ? triggeredRules[0].signal : null,
    gateResult: anomalyDetected ? 'anomaly' : 'pass',
    triggeredRules,
    evaluations,
  };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function statusOf(relativeMet, absoluteMet) {
  if (relativeMet && absoluteMet) return 'anomaly';
  if (relativeMet) return 'relative_only';
  if (absoluteMet) return 'absolute_only';
  return 'normal';
}

function roundTo(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return 0;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}
