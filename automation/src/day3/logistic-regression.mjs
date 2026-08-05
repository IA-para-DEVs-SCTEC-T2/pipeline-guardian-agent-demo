/**
 * Dia 3 — regressão logística didática, em JavaScript puro.
 *
 * Sem dependência nova, sem Python, sem framework de ML. O objetivo não é ter o
 * melhor classificador possível: é ter um classificador cujo comportamento
 * inteiro caiba numa tela e possa ser apontado com o dedo durante a aula.
 *
 * O que este módulo garante, e por quê:
 *
 * - **`sigmoid` numericamente estável.** `1 / (1 + Math.exp(-z))` estoura para
 *   `NaN` com `z` muito negativo; a versão em dois ramos não. Um `NaN` numa
 *   probabilidade contamina tudo o que vem depois sem deixar rastro.
 * - **Inicialização determinística** (pesos em zero). Duas execuções produzem o
 *   mesmo modelo, e a aula pode comparar números entre máquinas.
 * - **Padronização com média e desvio do treino, e só dele.** O `scaler` faz
 *   parte do modelo e viaja com ele no JSON: aplicar médias diferentes na
 *   inferência é a forma mais silenciosa de quebrar um modelo treinado.
 * - **Desvio padrão zero vira 1.** Uma feature constante não informa nada;
 *   dividir por zero informaria `Infinity` em todas as linhas.
 * - **Contribuição por feature = `peso × valor padronizado`.** É uma
 *   aproximação local — a soma das contribuições mais o viés é exatamente o
 *   logit, mas a relação com a probabilidade não é linear. Os relatórios dizem
 *   isso com todas as letras.
 */

/** Taxa de aprendizado do gradient descent. Alta o bastante para convergir em
 *  poucos milhares de iterações, baixa o bastante para não oscilar sobre
 *  features já padronizadas. */
export const LEARNING_RATE = 0.1;

/** Teto de iterações. O treino também para sozinho quando a loss estabiliza. */
export const MAX_ITERATIONS = 8000;

/**
 * Regularização L2 — pequena, mas **não** desprezível, e o motivo é didático.
 *
 * `currentLatencyRatio` e `latencySlope3` são quase colineares numa rampa
 * geométrica: quando a latência dobra a cada janela, o nível e a tendência
 * carregam a mesma informação. Sem regularização suficiente, o ajuste distribui
 * essa informação de forma arbitrária entre as duas — e o resultado observado
 * neste dataset era um peso **negativo** para `currentLatencyRatio`,
 * compensado por um peso enorme para a tendência. A previsão continuava
 * correta e a tabela de pesos passava a dizer que latência alta *reduz* o
 * risco. Num laboratório cujo produto é a explicação, isso é pior que um ponto
 * de F1 a menos.
 *
 * Com `0.02` os sete pesos ficam positivos, na ordem que a intuição espera, e a
 * perda de desempenho no teste é de casas decimais.
 */
export const L2_LAMBDA = 0.02;

/** Parada antecipada: variação relativa da loss abaixo disto encerra o treino. */
export const CONVERGENCE_TOLERANCE = 1e-9;

/** Piso do desvio padrão. Ver o cabeçalho. */
export const MIN_STANDARD_DEVIATION = 1e-8;

/** Versão do arquivo `model.json`. Muda quando o formato muda. */
export const MODEL_SCHEMA_VERSION = 1;

/**
 * Sigmoid estável.
 *
 * Para `z >= 0` usa `exp(-z)` (que tende a 0); para `z < 0` usa `exp(z)` (idem).
 * Em nenhum ramo o expoente é grande e positivo, então não há overflow.
 *
 * @param {number} z
 * @returns {number} valor em (0, 1)
 */
export function sigmoid(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  if (z >= 0) {
    const exp = Math.exp(-z);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(z);
  return exp / (1 + exp);
}

/**
 * Média e desvio padrão de cada coluna — calculados **apenas** sobre o conjunto
 * recebido, que por contrato é o de treino.
 *
 * @param {number[][]} rows
 * @returns {{ mean: number[], std: number[] }}
 */
export function fitScaler(rows) {
  if (rows.length === 0) return { mean: [], std: [] };

  const columns = rows[0].length;
  const mean = new Array(columns).fill(0);
  const std = new Array(columns).fill(0);

  for (let column = 0; column < columns; column += 1) {
    let total = 0;
    for (const row of rows) total += row[column];
    mean[column] = total / rows.length;

    let variance = 0;
    for (const row of rows) {
      const delta = row[column] - mean[column];
      variance += delta * delta;
    }
    // Desvio populacional: o conjunto de treino é a população do laboratório.
    const deviation = Math.sqrt(variance / rows.length);
    std[column] = deviation < MIN_STANDARD_DEVIATION ? 1 : deviation;
  }

  return { mean, std };
}

/**
 * Padroniza uma linha com o scaler do treino.
 *
 * @param {number[]} row
 * @param {{ mean: number[], std: number[] }} scaler
 * @returns {number[]}
 */
export function standardizeRow(row, scaler) {
  return row.map((value, index) => {
    const mean = scaler.mean[index] ?? 0;
    const std = scaler.std[index] || 1;
    const standardized = (value - mean) / std;
    return Number.isFinite(standardized) ? standardized : 0;
  });
}

/**
 * Log loss (entropia cruzada binária) com o termo de regularização.
 *
 * As probabilidades são grampeadas longe de 0 e 1 antes do logaritmo: um
 * `log(0)` devolveria `-Infinity` e a curva de perda perderia o sentido.
 *
 * @param {number[][]} standardized
 * @param {number[]} labels
 * @param {{ weights: number[], bias: number }} model
 * @param {number} [lambda]
 * @returns {number}
 */
export function logLoss(standardized, labels, { weights, bias }, lambda = L2_LAMBDA) {
  if (standardized.length === 0) return 0;

  let total = 0;
  for (let index = 0; index < standardized.length; index += 1) {
    const probability = clampProbability(sigmoid(dot(standardized[index], weights) + bias));
    total += labels[index] === 1 ? -Math.log(probability) : -Math.log(1 - probability);
  }

  const penalty = (lambda / 2) * weights.reduce((sum, weight) => sum + weight * weight, 0);
  return total / standardized.length + penalty;
}

/**
 * Treina por gradient descent em lote.
 *
 * Lote completo (não estocástico) de propósito: com algumas centenas de
 * exemplos ele é instantâneo, e a curva de perda sai monótona — o que faz da
 * própria curva um material de aula.
 *
 * O viés (`bias`) **não** é regularizado: penalizá-lo empurraria o modelo para
 * prever 50% quando não sabe, em vez de aprender a taxa-base do conjunto.
 *
 * @param {object} input
 * @param {number[][]} input.rows linhas **não** padronizadas
 * @param {number[]} input.labels 0 ou 1
 * @param {string[]} input.featureNames
 * @param {number} [input.learningRate]
 * @param {number} [input.maxIterations]
 * @param {number} [input.lambda]
 * @returns {object} modelo pronto para serializar
 */
export function trainLogisticRegression({
  rows,
  labels,
  featureNames,
  learningRate = LEARNING_RATE,
  maxIterations = MAX_ITERATIONS,
  lambda = L2_LAMBDA,
}) {
  if (rows.length === 0) throw new Error('sem exemplos de treino');

  const scaler = fitScaler(rows);
  const standardized = rows.map((row) => standardizeRow(row, scaler));
  const columns = standardized[0].length;

  // Inicialização determinística: zeros. Nenhum sorteio, nenhuma semente.
  const weights = new Array(columns).fill(0);
  let bias = 0;

  const lossHistory = [];
  let iterations = 0;

  for (let step = 0; step < maxIterations; step += 1) {
    const gradients = new Array(columns).fill(0);
    let biasGradient = 0;

    for (let index = 0; index < standardized.length; index += 1) {
      const error = sigmoid(dot(standardized[index], weights) + bias) - labels[index];
      biasGradient += error;
      for (let column = 0; column < columns; column += 1) {
        gradients[column] += error * standardized[index][column];
      }
    }

    for (let column = 0; column < columns; column += 1) {
      const gradient = gradients[column] / standardized.length + lambda * weights[column];
      weights[column] -= learningRate * gradient;
    }
    bias -= learningRate * (biasGradient / standardized.length);

    iterations = step + 1;

    // A perda é registrada a cada 50 passos: 4000 pontos numa curva didática
    // seriam 4000 números que ninguém lê.
    if (step % 50 === 0 || step === maxIterations - 1) {
      const loss = logLoss(standardized, labels, { weights, bias }, lambda);
      const previous = lossHistory.at(-1);
      lossHistory.push({ iteration: iterations, loss });
      if (previous && Math.abs(previous.loss - loss) < CONVERGENCE_TOLERANCE) break;
    }
  }

  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    featureNames: [...featureNames],
    weights,
    bias,
    scaler,
    hyperparameters: { learningRate, maxIterations, lambda, initialization: 'zeros' },
    training: {
      examples: rows.length,
      positives: labels.filter((label) => label === 1).length,
      iterations,
      initialLoss: lossHistory[0]?.loss ?? null,
      finalLoss: lossHistory.at(-1)?.loss ?? null,
      lossHistory,
    },
  };
}

/**
 * Probabilidade prevista para uma linha **não** padronizada.
 *
 * @param {object} model
 * @param {number[]} row
 * @returns {number}
 */
export function predictProbability(model, row) {
  return sigmoid(logit(model, row));
}

/**
 * O logit (`z`): soma das contribuições mais o viés.
 *
 * @param {object} model
 * @param {number[]} row
 * @returns {number}
 */
export function logit(model, row) {
  return dot(standardizeRow(row, model.scaler), model.weights) + model.bias;
}

/**
 * Contribuição aproximada de cada feature: `peso × valor padronizado`.
 *
 * Ordenada pela **magnitude absoluta** — o que mais empurra a decisão, para
 * qualquer lado. Uma contribuição negativa é informação: é uma feature que está
 * *segurando* o risco, e escondê-la faria o painel parecer um acusador.
 *
 * @param {object} model
 * @param {number[]} row
 * @returns {Array<{ feature: string, weight: number, standardizedValue: number,
 *                   rawValue: number, contribution: number, direction: 'increases'|'decreases' }>}
 */
export function explainContributions(model, row) {
  const standardized = standardizeRow(row, model.scaler);

  return model.featureNames
    .map((feature, index) => {
      const contribution = model.weights[index] * standardized[index];
      return {
        feature,
        weight: model.weights[index],
        standardizedValue: standardized[index],
        rawValue: row[index],
        contribution,
        direction: contribution >= 0 ? 'increases' : 'decreases',
      };
    })
    .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
}

/**
 * Modelo em forma serializável.
 *
 * Sem carimbo de tempo: `model.json` precisa ser byte a byte igual entre duas
 * execuções da mesma semente, para que a aula possa comparar arquivos. A data
 * do treino fica em `training-summary.json`, que é o relatório da execução.
 *
 * @param {object} model
 * @returns {object}
 */
export function serializeModel(model) {
  return {
    schemaVersion: model.schemaVersion,
    featureNames: model.featureNames,
    weights: model.weights,
    bias: model.bias,
    scaler: model.scaler,
    hyperparameters: model.hyperparameters,
    training: model.training,
  };
}

/**
 * Recarrega um modelo serializado, reprovando o que não for utilizável.
 *
 * A validação é curta e nominal: comprimento dos vetores e finitude dos
 * números. Um modelo com um `null` no meio dos pesos produziria `NaN` em toda
 * previsão, e `NaN` não avisa que chegou.
 *
 * @param {object} raw
 * @returns {object}
 */
export function deserializeModel(raw) {
  const featureNames = raw?.featureNames;
  const weights = raw?.weights;
  const scaler = raw?.scaler;

  if (!Array.isArray(featureNames) || featureNames.length === 0) {
    throw new Error('modelo inválido: `featureNames` ausente');
  }
  if (!Array.isArray(weights) || weights.length !== featureNames.length) {
    throw new Error('modelo inválido: `weights` com tamanho diferente de `featureNames`');
  }
  if (
    !scaler ||
    !Array.isArray(scaler.mean) ||
    !Array.isArray(scaler.std) ||
    scaler.mean.length !== featureNames.length ||
    scaler.std.length !== featureNames.length
  ) {
    throw new Error('modelo inválido: `scaler` incompatível com `featureNames`');
  }
  const numbers = [...weights, ...scaler.mean, ...scaler.std, raw.bias];
  if (numbers.some((value) => !Number.isFinite(value))) {
    throw new Error('modelo inválido: valor não finito em pesos, viés ou scaler');
  }

  return {
    schemaVersion: raw.schemaVersion ?? MODEL_SCHEMA_VERSION,
    featureNames: [...featureNames],
    weights: [...weights],
    bias: raw.bias,
    scaler: { mean: [...scaler.mean], std: [...scaler.std] },
    hyperparameters: raw.hyperparameters ?? {},
    training: raw.training ?? {},
  };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                  */
/* ------------------------------------------------------------------------- */

function dot(row, weights) {
  let total = 0;
  for (let index = 0; index < weights.length; index += 1) total += row[index] * weights[index];
  return total;
}

function clampProbability(probability) {
  const epsilon = 1e-12;
  return Math.min(1 - epsilon, Math.max(epsilon, probability));
}
