/**
 * Dia 3 — o vocabulário numérico do laboratório preditivo.
 *
 * Aqui moram quatro coisas, e a separação entre elas é o assunto da aula:
 *
 *   1. **A baseline operacional** — o "normal" contra o qual tudo é comparado.
 *      É fixa e didática: pertence ao laboratório, não a uma medição real.
 *   2. **O que é uma janela em falha** (`isFailureWindow`) — a definição do
 *      evento que se quer prever. Ela é dura, numérica e não opinável.
 *   3. **O que é uma janela degradada** (`isDegradedWindow`) — um limite *mais
 *      baixo*, usado **apenas** para medir persistência. Degradação não é
 *      falha: é o que costuma vir antes dela.
 *   4. **As features** — sete números por janela, e nada além disso.
 *
 * A regra que atravessa o módulo inteiro: **nenhuma feature olha o futuro.**
 * Toda função recebe a sequência e um índice, e só lê `windows[0..index]`. O
 * rótulo (`labelWindow`) é o único que olha para a frente — e olha exatamente
 * duas janelas, porque é isso que o alvo promete.
 *
 * O nome do cenário que gerou a sequência **nunca** entra numa feature. Se
 * entrasse, o modelo aprenderia a ler a etiqueta em vez de aprender o sinal, e
 * o laboratório inteiro passaria a demonstrar uma coisa que não existe fora
 * dele.
 */

/**
 * Baseline operacional do laboratório.
 *
 * Fixa de propósito: os cenários didáticos precisam de um "normal" estável para
 * que a mesma métrica signifique a mesma coisa em todos os relatórios. Aparece
 * nos relatórios como referência declarada, nunca como medição.
 */
export const BASELINE = Object.freeze({
  latencyP95Ms: 12,
  errorRate: 0,
  logLinesPerRequest: 2,
});

/**
 * Quando uma janela **é** falha. Basta uma condição.
 *
 * `errorRate` e `latencyP95Ms` são limites; `healthFailure` é um fato binário
 * reportado pela própria janela. Não há peso, média nem tolerância: o alvo
 * precisa ser verificável por qualquer pessoa que olhe a tabela.
 */
export const FAILURE_THRESHOLDS = Object.freeze({
  errorRate: 0.5,
  latencyP95Ms: 1500,
});

/**
 * Limites **didáticos de degradação** — usados só para contar persistência.
 *
 * São propositalmente mais baixos que os de falha, e cada um exige *razão sobre
 * a baseline* **e** *diferença absoluta*. A segunda condição existe porque
 * razão sozinha mente perto do zero: 6 ms contra uma baseline de 2 ms é o
 * triplo, e não é degradação nenhuma.
 */
export const DEGRADATION_THRESHOLDS = Object.freeze({
  latencyRatio: 3,
  latencyAbsoluteMs: 150,
  errorRate: 0.15,
  logRatio: 3,
  logAbsoluteLines: 5,
});

/** Quantas janelas à frente o alvo cobre. Ver `labelWindow`. */
export const HORIZON_WINDOWS = 2;

/** Nome do alvo, repetido nos relatórios para que ninguém precise adivinhar. */
export const TARGET_NAME = 'failureWithinNext2Windows';

/** Quantas janelas entram no cálculo de inclinação. Ver `slopeOfLastWindows`. */
export const SLOPE_WINDOW = 3;

/**
 * As sete features, **nesta ordem**.
 *
 * A ordem é contrato: os pesos do modelo serializado, o vetor padronizado e a
 * tabela do painel de avaliação são todos posicionais. Inserir uma feature no
 * meio invalidaria um `model.json` já treinado sem que nada reclamasse — por
 * isso feature nova entra no fim, e nunca no meio.
 */
export const FEATURE_NAMES = Object.freeze([
  'currentLatencyRatio',
  'latencySlope3',
  'currentErrorRate',
  'errorRateSlope3',
  'currentLogRatio',
  'logSlope3',
  'consecutiveDegradedWindows',
]);

/** Descrição legível de cada feature, para os painéis. */
export const FEATURE_LABELS = Object.freeze({
  currentLatencyRatio: 'Latência p95 atual ÷ baseline (12 ms)',
  latencySlope3: 'Tendência da latência nas últimas 3 janelas (ms por janela)',
  currentErrorRate: 'Taxa de erro atual (0 a 1)',
  errorRateSlope3: 'Tendência da taxa de erro nas últimas 3 janelas (por janela)',
  currentLogRatio: 'Logs por requisição ÷ baseline (2 linhas)',
  logSlope3: 'Tendência dos logs nas últimas 3 janelas (linhas por janela)',
  consecutiveDegradedWindows: 'Janelas degradadas consecutivas até agora (persistência)',
});

/**
 * Uma janela é falha?
 *
 * @param {object} window `{ latencyP95Ms, errorRate, healthFailure }`
 * @returns {boolean}
 */
export function isFailureWindow(window) {
  if (!window) return false;
  return (
    Number(window.errorRate) >= FAILURE_THRESHOLDS.errorRate ||
    Number(window.latencyP95Ms) >= FAILURE_THRESHOLDS.latencyP95Ms ||
    window.healthFailure === true
  );
}

/**
 * Qual condição de falha disparou. Serve ao relatório, não ao modelo.
 *
 * @param {object} window
 * @returns {string[]} lista vazia quando a janela não é falha
 */
export function failureReasons(window) {
  const reasons = [];
  if (!window) return reasons;
  if (Number(window.errorRate) >= FAILURE_THRESHOLDS.errorRate) {
    reasons.push(`errorRate ≥ ${FAILURE_THRESHOLDS.errorRate}`);
  }
  if (Number(window.latencyP95Ms) >= FAILURE_THRESHOLDS.latencyP95Ms) {
    reasons.push(`latencyP95Ms ≥ ${FAILURE_THRESHOLDS.latencyP95Ms} ms`);
  }
  if (window.healthFailure === true) reasons.push('healthFailure = true');
  return reasons;
}

/**
 * Uma janela está degradada?
 *
 * Nunca é usada como alvo — só alimenta `consecutiveDegradedWindows`. Uma
 * janela em falha normalmente também está degradada, mas a recíproca é falsa, e
 * é justamente esse intervalo entre os dois limites que o modelo aprende a ler.
 *
 * @param {object} window
 * @returns {boolean}
 */
export function isDegradedWindow(window) {
  if (!window) return false;

  const latency = Number(window.latencyP95Ms);
  const logs = Number(window.logLinesPerRequest);

  const latencyDegraded =
    latency >= BASELINE.latencyP95Ms * DEGRADATION_THRESHOLDS.latencyRatio &&
    latency - BASELINE.latencyP95Ms >= DEGRADATION_THRESHOLDS.latencyAbsoluteMs;

  const errorDegraded = Number(window.errorRate) >= DEGRADATION_THRESHOLDS.errorRate;

  const logsDegraded =
    logs >= BASELINE.logLinesPerRequest * DEGRADATION_THRESHOLDS.logRatio &&
    logs - BASELINE.logLinesPerRequest >= DEGRADATION_THRESHOLDS.logAbsoluteLines;

  return latencyDegraded || errorDegraded || logsDegraded;
}

/**
 * Inclinação por mínimos quadrados sobre índices igualmente espaçados.
 *
 * Positiva quando a série cresce, negativa quando se recupera, zero quando
 * está estável. Com três pontos igualmente espaçados o resultado é exatamente
 * `(y2 - y0) / 2` — a forma geral fica aqui porque também precisa responder
 * para dois pontos (início da sequência).
 *
 * @param {number[]} values série já recortada
 * @returns {number} unidades da métrica por janela
 */
export function linearSlope(values) {
  const size = values.length;
  if (size < 2) return 0;

  const meanX = (size - 1) / 2;
  const meanY = values.reduce((total, value) => total + value, 0) / size;

  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < size; index += 1) {
    const deltaX = index - meanX;
    numerator += deltaX * (values[index] - meanY);
    denominator += deltaX * deltaX;
  }

  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Inclinação das últimas `size` janelas até `endIndex` — **passado e presente,
 * nunca futuro**.
 *
 * Nas duas primeiras janelas da sequência não há três pontos: a função usa os
 * que existem (e devolve 0 quando existe só um). Preencher com zeros à esquerda
 * inventaria uma queda que não aconteceu.
 *
 * @param {number[]} values série completa
 * @param {number} endIndex índice da janela atual (inclusive)
 * @param {number} [size]
 * @returns {number}
 */
export function slopeOfLastWindows(values, endIndex, size = SLOPE_WINDOW) {
  const start = Math.max(0, endIndex - size + 1);
  return linearSlope(values.slice(start, endIndex + 1));
}

/**
 * Quantas janelas degradadas consecutivas terminam em `index` (inclusive).
 *
 * @param {object[]} windows
 * @param {number} index
 * @returns {number}
 */
export function consecutiveDegradedWindows(windows, index) {
  let count = 0;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (!isDegradedWindow(windows[cursor])) break;
    count += 1;
  }
  return count;
}

/**
 * As sete features da janela `index`.
 *
 * @param {object[]} windows sequência completa
 * @param {number} index janela atual
 * @returns {Record<string, number>}
 */
export function buildFeatures(windows, index) {
  const current = windows[index];
  const latencies = windows.map((window) => Number(window.latencyP95Ms));
  const errorRates = windows.map((window) => Number(window.errorRate));
  const logs = windows.map((window) => Number(window.logLinesPerRequest));

  return {
    currentLatencyRatio: Number(current.latencyP95Ms) / BASELINE.latencyP95Ms,
    latencySlope3: slopeOfLastWindows(latencies, index),
    currentErrorRate: Number(current.errorRate),
    errorRateSlope3: slopeOfLastWindows(errorRates, index),
    currentLogRatio: Number(current.logLinesPerRequest) / BASELINE.logLinesPerRequest,
    logSlope3: slopeOfLastWindows(logs, index),
    consecutiveDegradedWindows: consecutiveDegradedWindows(windows, index),
  };
}

/**
 * Features na ordem de `FEATURE_NAMES`.
 *
 * @param {Record<string, number>} features
 * @returns {number[]}
 */
export function toFeatureVector(features) {
  return FEATURE_NAMES.map((name) => Number(features[name]));
}

/**
 * O rótulo da janela `index`: **haverá falha nas próximas duas janelas?**
 *
 * Duas decisões explícitas:
 *
 *   1. **Só o horizonte conta.** Uma falha na janela `index + 3` não rotula
 *      esta janela. O alvo promete duas janelas e entrega duas.
 *   2. **Horizonte incompleto é `null`, não `0`.** As últimas janelas de cada
 *      sequência não têm duas janelas à frente para observar. Chamá-las de
 *      "não vai falhar" seria inventar um negativo a partir da ausência de
 *      dado — e o modelo aprenderia que toda sequência termina bem.
 *
 *      A exceção é quando a parte observável do horizonte **já** contém uma
 *      falha: aí a resposta não depende do que falta, e o rótulo é `1`.
 *
 * @param {object[]} windows
 * @param {number} index
 * @returns {{ label: 0|1|null, horizonComplete: boolean, observedHorizon: number }}
 */
export function labelWindow(windows, index) {
  const horizon = [];
  for (let step = 1; step <= HORIZON_WINDOWS; step += 1) {
    const window = windows[index + step];
    if (window) horizon.push(window);
  }

  if (horizon.some(isFailureWindow)) {
    return { label: 1, horizonComplete: true, observedHorizon: horizon.length };
  }
  if (horizon.length < HORIZON_WINDOWS) {
    return { label: null, horizonComplete: false, observedHorizon: horizon.length };
  }
  return { label: 0, horizonComplete: true, observedHorizon: horizon.length };
}

/**
 * Índice da primeira janela em falha de uma sequência.
 *
 * @param {object[]} windows
 * @returns {number|null}
 */
export function firstFailureWindow(windows) {
  const index = windows.findIndex(isFailureWindow);
  return index === -1 ? null : index;
}

/**
 * Transforma uma sequência inteira em exemplos de treino/avaliação.
 *
 * Duas janelas ficam de fora, por motivos diferentes:
 *
 * - **Sem horizonte completo** (as últimas da sequência): não há resposta
 *   conhecida para comparar. Elas continuam na sequência e o painel mostra a
 *   previsão para elas — só não entram na conta de acerto e erro.
 * - **Já em falha**: prever o que já aconteceu não é previsão. E há um efeito
 *   colateral que importa tanto quanto o argumento: os valores dessas janelas
 *   são extremos (latência de 1700 ms contra uma baseline de 12), e deixá-las
 *   no treino infla o desvio padrão a ponto de comprimir todo o resto — uma
 *   degradação real de 900 ms viraria "meio desvio acima da média", e o modelo
 *   só acenderia depois que a falha já tivesse acontecido.
 *
 * @param {{ id: string, windows: object[] }} sequence
 * @returns {Array<{ sequenceId: string, windowIndex: number, features: object,
 *                   vector: number[], label: 0|1 }>}
 */
export function buildExamples(sequence) {
  const examples = [];

  sequence.windows.forEach((window, index) => {
    if (isFailureWindow(window)) return;

    const { label } = labelWindow(sequence.windows, index);
    if (label === null) return;

    const features = buildFeatures(sequence.windows, index);
    examples.push({
      sequenceId: sequence.id,
      windowIndex: index,
      features,
      vector: toFeatureVector(features),
      label,
    });
  });

  return examples;
}

/**
 * Junta os exemplos de várias sequências num conjunto pronto para o treino.
 *
 * @param {Array<object>} sequences
 * @returns {{ rows: number[][], labels: number[], examples: Array<object> }}
 */
export function buildDataset(sequences) {
  const examples = sequences.flatMap(buildExamples);
  return {
    rows: examples.map((example) => example.vector),
    labels: examples.map((example) => example.label),
    examples,
  };
}
