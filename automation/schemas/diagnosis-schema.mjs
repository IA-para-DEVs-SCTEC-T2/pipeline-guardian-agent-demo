import { z } from 'zod';

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
