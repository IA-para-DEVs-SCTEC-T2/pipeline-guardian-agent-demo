import { z } from 'zod';

import { modelCallFields } from './diagnosis-schema.mjs';
import { FEATURE_NAMES, HORIZON_WINDOWS, TARGET_NAME } from '../src/day3/features.mjs';

/**
 * Dia 3 — o contrato do relatório de previsão.
 *
 * A divisão de trabalho está codificada aqui, e é a razão de o arquivo existir:
 *
 * - **`modelPredictionExplanationSchema`** é tudo o que a IA generativa pode
 *   produzir: cinco campos de texto. `failureProbability`, `predictedFailure`,
 *   `threshold`, `actualFailure`, `target`, as features e os `topFactors`
 *   **não estão nele**. Não é uma regra escrita num prompt e conferida depois:
 *   é o schema do structured output. O modelo não tem como devolver esses
 *   campos, então não tem como alterá-los.
 * - **`predictionReportSchema`** valida o relatório final, montado a partir dos
 *   números da regressão logística. A explicação entra como um bloco à parte,
 *   com a origem declarada (`openai` ou `fallback`).
 *
 * O `origin` no relatório existe para que ninguém precise adivinhar de onde
 * veio o texto que está lendo. Um laboratório que às vezes chama o modelo e às
 * vezes não, sem dizer qual foi, ensina a confiar no texto errado.
 */

/** Origem da explicação em linguagem natural. */
export const EXPLANATION_ORIGINS = ['openai', 'fallback'];

/** Faixas de decisão. Espelham `RISK_BANDS` em `evaluate.mjs`. */
export const RISK_BAND_IDS = ['low', 'attention', 'likely'];

/** Resultado no ponto de decisão, quando o desfecho é revelado. */
export const DECISION_OUTCOMES = ['true_positive', 'false_positive', 'true_negative', 'false_negative'];

/** Uma janela observada. */
export const windowSchema = z.object({
  index: z.number().int().nonnegative(),
  latencyP95Ms: z.number().nonnegative(),
  errorRate: z.number().min(0).max(1),
  logLinesPerRequest: z.number().nonnegative(),
  healthFailure: z.boolean(),
});

/** Contribuição aproximada de uma feature: `peso × valor padronizado`. */
export const factorSchema = z.object({
  feature: z.enum(FEATURE_NAMES),
  weight: z.number().finite(),
  rawValue: z.number().finite(),
  standardizedValue: z.number().finite(),
  contribution: z.number().finite(),
  direction: z.enum(['increases', 'decreases']),
});

/** Previsão de uma janela. */
export const windowPredictionSchema = z.object({
  windowIndex: z.number().int().nonnegative(),
  window: windowSchema,
  features: z.record(z.enum(FEATURE_NAMES), z.number().finite()),
  failureProbability: z.number().min(0).max(1),
  predictedFailure: z.boolean(),
  riskBand: z.enum(RISK_BAND_IDS),
  topFactors: z.array(factorSchema),
  /** `null` quando a janela não tem horizonte completo — nunca `false`. */
  actualFailureWithinHorizon: z.boolean().nullable(),
  isFailureWindow: z.boolean(),
});

/**
 * O recorte da IA generativa. Cinco campos, todos texto.
 *
 * Sem `.optional()` e sem `.default()`: o structured output da OpenAI exige
 * JSON Schema estrito, com todas as propriedades obrigatórias.
 */
export const modelPredictionExplanationSchema = z.object({
  summary: z.string(),
  evidence: z.array(z.string()),
  interpretation: z.string(),
  recommendedActions: z.array(z.string()),
  limitations: z.array(z.string()),
});

/** A explicação já com a origem carimbada. */
export const explanationSchema = modelPredictionExplanationSchema.extend({
  origin: z.enum(EXPLANATION_ORIGINS),
  ...modelCallFields,
});

/** O relatório completo de um cenário ou desafio. */
export const predictionReportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(['scenario', 'challenge']),
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),

  target: z.literal(TARGET_NAME),
  predictionHorizonWindows: z.literal(HORIZON_WINDOWS),
  threshold: z.number().min(0).max(1),
  baseline: z.object({
    latencyP95Ms: z.number().positive(),
    errorRate: z.number().min(0),
    logLinesPerRequest: z.number().positive(),
  }),

  /** Janelas efetivamente analisadas (num desafio, até o ponto de decisão). */
  windows: z.array(windowSchema).min(1),
  predictions: z.array(windowPredictionSchema).min(1),

  currentWindowIndex: z.number().int().nonnegative(),
  failureProbability: z.number().min(0).max(1),
  predictedFailure: z.boolean(),
  riskBand: z.enum(RISK_BAND_IDS),
  topFactors: z.array(factorSchema),
  firstPredictedFailureWindow: z.number().int().nonnegative().nullable(),

  /**
   * O desfecho. `revealed: false` ⇒ todos os campos abaixo são `null`, e é
   * assim que o comando de execução do desafio não entrega o final.
   */
  outcome: z.object({
    revealed: z.boolean(),
    actualFailure: z.boolean().nullable(),
    firstActualFailureWindow: z.number().int().nonnegative().nullable(),
    leadTimeWindows: z.number().int().nullable(),
    decisionOutcome: z.enum(DECISION_OUTCOMES).nullable(),
  }),

  /** Presente apenas no relatório da versão mitigada. */
  mitigation: z
    .object({
      interventionWindowIndex: z.number().int().nonnegative(),
      decayPerWindow: z.number().positive(),
      baselineProbability: z.number().min(0).max(1),
      mitigatedProbability: z.number().min(0).max(1),
      baselineMaxProbability: z.number().min(0).max(1),
      mitigatedMaxProbability: z.number().min(0).max(1),
      comparison: z.array(
        z.object({
          windowIndex: z.number().int().nonnegative(),
          baselineProbability: z.number().min(0).max(1),
          mitigatedProbability: z.number().min(0).max(1),
          baselineLatencyP95Ms: z.number().nonnegative(),
          mitigatedLatencyP95Ms: z.number().nonnegative(),
          baselineErrorRate: z.number().min(0).max(1),
          mitigatedErrorRate: z.number().min(0).max(1),
          baselineLogLinesPerRequest: z.number().nonnegative(),
          mitigatedLogLinesPerRequest: z.number().nonnegative(),
        }),
      ),
    })
    .nullable(),

  modelMetrics: z.object({
    accuracy: z.number().min(0).max(1),
    precision: z.number().min(0).max(1),
    recall: z.number().min(0).max(1),
    f1Score: z.number().min(0).max(1),
    examples: z.number().int().nonnegative(),
    positiveExamples: z.number().int().nonnegative(),
    negativeExamples: z.number().int().nonnegative(),
  }),

  explanation: explanationSchema,
  limitations: z.array(z.string()),
  generatedAt: z.string().datetime(),
});
