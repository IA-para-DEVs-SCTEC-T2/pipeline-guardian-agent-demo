/**
 * Dia 3 — a explicação da previsão. Nada além dela.
 *
 * Reusa a infraestrutura do Dia 1 sem criar um segundo cliente: a mesma
 * configuração (`openai-config.mjs`), a mesma fábrica e a mesma chamada
 * estruturada (`openai-client.mjs`), a mesma tradução de erro em categoria e a
 * mesma redação de segredos. Um segundo cliente seria um segundo timeout, um
 * segundo padrão de modelo e uma segunda forma de vazar uma chave.
 *
 * A divisão de trabalho é a regra do dia:
 *
 *   A regressão logística calcula → `failureProbability`, `predictedFailure`,
 *   `threshold`, `topFactors`.
 *   A IA generativa escreve     → `summary`, `evidence`, `interpretation`,
 *   `recommendedActions`, `limitations`.
 *
 * Ela é garantida pelo schema, não pelo prompt: `modelPredictionExplanationSchema`
 * não tem os campos numéricos, então o structured output não tem como
 * devolvê-los. O relatório é montado a partir dos números da regressão e a
 * explicação entra como um bloco de texto ao lado.
 *
 * **Sem chave, o laboratório continua funcionando.** O fallback determinístico
 * é montado dos mesmos números, a origem é declarada (`origin: 'fallback'`) e
 * os três formatos de relatório saem iguais.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  modelPredictionExplanationSchema,
} from '../../schemas/day-3-prediction-schema.mjs';
import { callStructuredModel, classifyModelError, createOpenAIClient } from '../openai-client.mjs';
import {
  PAYLOAD_LIMITS,
  canUseModel,
  capText,
  emptyModelCallMetadata,
  resolveOpenAIConfig,
} from '../openai-config.mjs';
import { redactSecrets, redactSecretsDeep } from '../redact-secrets.mjs';
import { FEATURE_LABELS, HORIZON_WINDOWS, TARGET_NAME } from './features.mjs';
import { AUTOMATION_ROOT } from './predict.mjs';

const PROMPT_PATH = join(AUTOMATION_ROOT, 'prompts', 'day-3-prediction-explanation.md');

/** Quantas janelas recentes vão para o modelo. O resto não muda a explicação. */
export const MAX_WINDOWS_SENT = 6;

/** Nome do schema no structured output. */
const SCHEMA_NAME = 'day3_prediction_explanation';

/** Limitações que valem para toda execução do laboratório. */
export const LAB_LIMITATIONS = Object.freeze([
  'Os dados são sintéticos e determinísticos: servem para ensinar o método, não para estimar o risco de um sistema real.',
  `O horizonte de previsão é de ${HORIZON_WINDOWS} janelas. Nada aqui diz o que acontece depois disso.`,
  'A regressão logística mede correlação entre séries. Ela não observa código, configuração nem infraestrutura, e por isso não estabelece causa.',
  'As contribuições por feature são aproximações lineares no espaço padronizado: elas somam o logit, não a probabilidade.',
]);

/**
 * O material que a IA generativa recebe.
 *
 * **Nada aqui identifica o cenário ou o caso.** Sem `id`, sem título, sem o
 * padrão que gerou a sequência. Num desafio, o nome do caso é a resposta; e um
 * modelo que recebesse "case-a — degradação mista que termina em falha"
 * escreveria a explicação a partir do rótulo, não dos números.
 *
 * Também não entram variáveis de ambiente, caminhos de arquivo ou qualquer
 * coisa que não seja número de janela, feature e métrica.
 *
 * @param {object} input
 * @returns {object} payload neutro
 */
export function buildExplanationPayload({ analysis, threshold, modelMetrics, limitations = [] }) {
  const current = analysis.predictions[analysis.currentWindowIndex];

  return {
    target: TARGET_NAME,
    predictionHorizonWindows: HORIZON_WINDOWS,
    threshold,
    failureProbability: current.failureProbability,
    predictedFailure: current.predictedFailure,
    riskBand: current.riskBand,
    recentWindows: analysis.windows.slice(-MAX_WINDOWS_SENT).map((window) => ({
      index: window.index,
      latencyP95Ms: window.latencyP95Ms,
      errorRate: window.errorRate,
      logLinesPerRequest: window.logLinesPerRequest,
      healthFailure: window.healthFailure,
    })),
    probabilityByWindow: analysis.predictions
      .slice(-MAX_WINDOWS_SENT)
      .map((entry) => ({ index: entry.windowIndex, failureProbability: entry.failureProbability })),
    currentFeatures: Object.fromEntries(
      Object.entries(current.features).map(([name, value]) => [
        name,
        { value, meaning: FEATURE_LABELS[name] },
      ]),
    ),
    topFactors: current.topFactors,
    modelEvaluation: modelMetrics,
    knownLimitations: [...LAB_LIMITATIONS, ...limitations],
  };
}

/**
 * Explica a previsão — com o modelo quando há chave, com o fallback quando não.
 *
 * O caminho de erro é o mesmo do Dia 1: qualquer desvio (sem chave, rede,
 * timeout, 401, 429, resposta incompleta, saída fora do schema) cai no
 * determinístico e declara a categoria. O laboratório nunca fica sem
 * explicação, e nunca finge que a explicação veio do modelo.
 *
 * @param {object} input
 * @param {object} input.analysis saída de `analyzeSequence`
 * @param {number} input.threshold
 * @param {object} input.modelMetrics métricas de avaliação
 * @param {string[]} [input.limitations]
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {object} [input.client] cliente injetável (testes)
 * @returns {Promise<object>} explicação validada, com `origin`
 */
export async function explainPrediction({
  analysis,
  threshold,
  modelMetrics,
  limitations = [],
  env = process.env,
  client = null,
}) {
  const config = resolveOpenAIConfig(env);
  const fallback = () =>
    buildFallbackExplanation({ analysis, threshold, modelMetrics, limitations });

  if (!canUseModel(env)) {
    return {
      ...fallback(),
      origin: 'fallback',
      ...emptyModelCallMetadata(config, null),
    };
  }

  const payload = buildExplanationPayload({ analysis, threshold, modelMetrics, limitations });
  // Redação antes do corte: cortar só remove conteúdo, então não há como o
  // corte revelar o que a máscara escondeu.
  const serialized = redactSecrets(JSON.stringify(payload, null, 2));
  const { text } = capText(serialized, PAYLOAD_LIMITS.maxTotalChars);

  try {
    const openai = client ?? (await createOpenAIClient({ env, config }));
    const { parsed, metadata } = await callStructuredModel({
      client: openai,
      config,
      instructions: readFileSync(PROMPT_PATH, 'utf8'),
      input: text,
      schema: modelPredictionExplanationSchema,
      schemaName: SCHEMA_NAME,
    });

    // Última barreira: a saída do modelo também passa pelo redator.
    const safe = redactSecretsDeep(parsed);
    return {
      summary: safe.summary,
      evidence: safe.evidence,
      interpretation: safe.interpretation,
      recommendedActions: safe.recommendedActions,
      limitations: mergeLimitations(safe.limitations, limitations),
      origin: 'openai',
      ...metadata,
    };
  } catch (error) {
    return {
      ...fallback(),
      origin: 'fallback',
      ...emptyModelCallMetadata(config, classifyModelError(error)),
    };
  }
}

/**
 * A explicação determinística: os mesmos números, escritos por regra.
 *
 * Ela não é um consolo pela ausência da chave — é o piso de qualidade do
 * laboratório. Tudo o que ela afirma sai de um valor calculado, e é por isso
 * que ela nunca inventa causa.
 *
 * @param {object} input
 * @returns {object} sem `origin` (quem chama carimba)
 */
export function buildFallbackExplanation({ analysis, threshold, modelMetrics, limitations = [] }) {
  const current = analysis.predictions[analysis.currentWindowIndex];
  const window = current.window;
  const percent = (value) => `${(value * 100).toFixed(1)}%`;

  const rising = analysis.predictions.length >= 2 &&
    current.failureProbability > analysis.predictions.at(-2).failureProbability;

  const summary = current.predictedFailure
    ? `Na janela ${current.windowIndex}, o modelo estima ${percent(current.failureProbability)} de ` +
      `probabilidade de falha nas próximas ${HORIZON_WINDOWS} janelas — acima do limiar de ` +
      `${percent(threshold)}. A faixa de decisão é "falha provável — mitigar".`
    : `Na janela ${current.windowIndex}, o modelo estima ${percent(current.failureProbability)} de ` +
      `probabilidade de falha nas próximas ${HORIZON_WINDOWS} janelas — abaixo do limiar de ` +
      `${percent(threshold)}.`;

  const evidence = [
    `Janela ${window.index}: latência p95 de ${window.latencyP95Ms} ms, taxa de erro de ${window.errorRate}, ` +
      `${window.logLinesPerRequest} linhas de log por requisição.`,
    `Janelas degradadas consecutivas até agora: ${current.features.consecutiveDegradedWindows}.`,
    ...current.topFactors.map(
      (factor) =>
        `${FEATURE_LABELS[factor.feature]}: valor ${round(factor.rawValue)} ` +
        `(contribuição ${factor.contribution >= 0 ? '+' : ''}${round(factor.contribution)} no logit, ` +
        `${factor.direction === 'increases' ? 'aumentando' : 'reduzindo'} o risco).`,
    ),
  ];

  const interpretation = current.predictedFailure
    ? `O padrão numérico é compatível com uma degradação que se mantém e cresce: ${describeFactors(current.topFactors)}. ` +
      'A hipótese mais direta é que o recurso sob pressão continue saturando dentro do horizonte; ' +
      'confirmá-la exigiria instrumentação que este laboratório não tem. Correlação entre séries, não causa.'
    : rising
      ? `As métricas se movem, mas o conjunto ainda não sustenta previsão de falha: ${describeFactors(current.topFactors)}. ` +
        'A leitura é de observação, não de mitigação.'
      : `O conjunto de features está próximo da baseline do laboratório e sem tendência sustentada: ` +
        `${describeFactors(current.topFactors)}. Não há sinal de falha no horizonte.`;

  const recommendedActions = current.predictedFailure
    ? [
        'Confirmar, na janela seguinte, se a tendência das três séries se mantém — uma janela isolada não sustenta decisão.',
        'Identificar o recurso associado à métrica de maior contribuição antes de qualquer mudança.',
        'Preparar a mitigação correspondente (reduzir carga, reverter a alteração recente, aumentar capacidade) para aplicação com pessoa responsável.',
      ]
    : rising
      ? [
          'Manter a sequência sob observação por mais duas janelas e reavaliar.',
          'Registrar o valor atual das três séries para comparação na próxima leitura.',
        ]
      : [
          'Nenhuma ação de mitigação se justifica com estes números.',
          'Seguir com a coleta normal das janelas.',
        ];

  return {
    summary,
    evidence,
    interpretation,
    recommendedActions,
    limitations: mergeLimitations(
      [
        `Avaliação do modelo no conjunto de teste: acurácia ${percent(modelMetrics.accuracy)}, ` +
          `precisão ${percent(modelMetrics.precision)}, recall ${percent(modelMetrics.recall)}. ` +
          'Recall abaixo de 100% significa que existem falhas que o modelo não antecipa.',
      ],
      limitations,
    ),
  };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                  */
/* ------------------------------------------------------------------------- */

/** Junta limitações sem repetir e sem perder as do laboratório. */
function mergeLimitations(fromExplanation = [], extra = []) {
  return [...new Set([...LAB_LIMITATIONS, ...extra, ...fromExplanation])];
}

function describeFactors(factors) {
  return factors
    .map(
      (factor) =>
        `${FEATURE_LABELS[factor.feature]} em ${round(factor.rawValue)} ` +
        `(${factor.direction === 'increases' ? 'empurra o risco para cima' : 'segura o risco'})`,
    )
    .join('; ');
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
