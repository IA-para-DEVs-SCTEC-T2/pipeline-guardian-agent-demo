import { z } from 'zod';

import { MODEL_ERROR_CATEGORIES } from '../src/openai-config.mjs';

export const PIPELINE_STATUSES = ['success', 'failed', 'partial'];

export const FAILURE_TYPES = [
  'lint',
  'test',
  'dependency',
  'build',
  'environment',
  'permission',
  'security',
  'unknown',
];

export const RISK_LEVELS = ['low', 'medium', 'high'];
export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];

export const DEPLOY_DECISIONS = ['eligible_for_staging', 'blocked', 'requires_human_approval'];

/** Um trecho concreto que sustenta o diagnóstico. */
export const evidenceSchema = z.object({
  source: z.string(),
  excerpt: z.string(),
});

/**
 * Consumo de tokens da chamada. Cada campo é anulável: um detalhe de
 * observabilidade que o SDK não informou não pode invalidar o diagnóstico.
 */
export const modelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
});

/**
 * Metadados observáveis da chamada ao modelo — os mesmos nos dois diagnósticos.
 *
 * São **opcionais** para que relatórios gerados antes desta versão continuem
 * válidos, e não entram em nenhuma decisão: quem decide CI é o exit code dos
 * comandos, quem decide CD é o smoke test. Isto aqui é conta de luz, não voto.
 *
 * Nada aqui é sensível: sem chave, sem header, sem corpo de requisição, sem o
 * conteúdo enviado ao modelo. `modelErrorCategory` nomeia a falha da chamada
 * sem carregar a mensagem bruta que a produziu.
 */
export const modelCallFields = {
  modelProvider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  modelResponseId: z.string().min(1).nullable().optional(),
  modelLatencyMs: z.number().int().nonnegative().nullable().optional(),
  modelUsage: modelUsageSchema.nullable().optional(),
  modelErrorCategory: z.enum(MODEL_ERROR_CATEGORIES).nullable().optional(),
};

/**
 * Diagnóstico completo. A ordem das chaves é a ordem do relatório.
 */
export const diagnosisSchema = z.object({
  analysisId: z.string().uuid(),
  requestId: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  commitSha: z.string().min(7),
  pipelineStatus: z.enum(PIPELINE_STATUSES),
  summary: z.string().min(1),
  signal: z.string().min(1),
  failureType: z.enum(FAILURE_TYPES),
  probableCause: z.string().min(1),
  evidence: z.array(evidenceSchema),
  impact: z.string().min(1),
  riskLevel: z.enum(RISK_LEVELS),
  confidence: z.enum(CONFIDENCE_LEVELS),
  nextSteps: z.array(z.string()),
  deployDecision: z.enum(DEPLOY_DECISIONS),
  requiresHumanApproval: z.boolean(),
  limitations: z.array(z.string()),
  usedFallback: z.boolean(),
  ...modelCallFields,
  generatedAt: z.string().datetime(),
});

/**
 * Recorte que o modelo pode produzir.
 *
 * `deployDecision`, `requiresHumanApproval`, `pipelineStatus` e os campos de
 * identidade ficam de fora de propósito: a decisão de deploy é da política
 * (`deploy-policy.mjs`), não do modelo, e o status vem dos códigos de saída dos
 * comandos, não de uma opinião.
 *
 * Sem `.optional()`, `.default()` ou restrições de tamanho: o structured output
 * da OpenAI exige JSON Schema estrito, com todas as propriedades obrigatórias.
 */
export const modelDiagnosisSchema = z.object({
  summary: z.string(),
  signal: z.string(),
  failureType: z.enum(FAILURE_TYPES),
  probableCause: z.string(),
  evidence: z.array(evidenceSchema),
  impact: z.string(),
  riskLevel: z.enum(RISK_LEVELS),
  confidence: z.enum(CONFIDENCE_LEVELS),
  nextSteps: z.array(z.string()),
  limitations: z.array(z.string()),
});
