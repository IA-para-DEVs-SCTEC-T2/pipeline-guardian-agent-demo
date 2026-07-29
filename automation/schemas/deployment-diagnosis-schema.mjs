import { z } from 'zod';

import { CONFIDENCE_LEVELS, evidenceSchema, modelCallFields } from './diagnosis-schema.mjs';

/**
 * A etapa analisada. Hoje só existe uma; o campo é explícito para que o
 * relatório nunca deixe dúvida sobre O QUE foi observado — logs do smoke test
 * pós-deployment, não o log interno da plataforma.
 */
export const DEPLOYMENT_STAGES = ['post_deployment_validation'];

/**
 * Resultado TÉCNICO da validação. Vem do smoke test (códigos HTTP, exit code),
 * nunca do modelo — por isso está fora de `modelDeploymentDiagnosisSchema`.
 */
export const DEPLOYMENT_STATUSES = ['success', 'failure'];

/**
 * Classificação da falha. `success` é um valor legítimo: quando o deployment
 * deu certo, não há falha a tipificar.
 */
export const DEPLOYMENT_FAILURE_TYPES = [
  'success',
  'healthcheck',
  'startup',
  'environment',
  'network',
  'deployment',
  'unknown',
];

/**
 * Diagnóstico completo da validação pós-deployment.
 *
 * `status` e `usedFallback` são fatos do sistema; o resto é descrição. A ordem
 * das chaves é a ordem em que o relatório apresenta as informações.
 */
export const deploymentDiagnosisSchema = z.object({
  analysisId: z.string().uuid(),
  requestId: z.string().min(1),
  repository: z.string().min(1),
  commitSha: z.string().min(1),
  /** Só o host — a URL completa poderia carregar credenciais ou token em query. */
  targetHost: z.string().min(1),

  stage: z.enum(DEPLOYMENT_STAGES),
  status: z.enum(DEPLOYMENT_STATUSES),
  failureType: z.enum(DEPLOYMENT_FAILURE_TYPES),
  summary: z.string().min(1),
  evidence: z.array(evidenceSchema),
  probableCause: z.string().nullable(),
  confidence: z.enum(CONFIDENCE_LEVELS),
  nextSteps: z.array(z.string()),
  limitations: z.array(z.string()),
  usedFallback: z.boolean(),
  // Metadados da chamada — opcionais, não decidem nada. Ver `modelCallFields`.
  ...modelCallFields,
  generatedAt: z.string().datetime(),
});

/**
 * Recorte que o modelo pode produzir.
 *
 * `status` fica de fora de propósito: quem diz se o deployment passou é o smoke
 * test, a partir de códigos HTTP e exit codes. O modelo resume, classifica e
 * recomenda — não decide se a versão está no ar.
 *
 * Sem `.optional()` e sem `.default()`: o structured output da OpenAI exige
 * JSON Schema estrito, com todas as propriedades obrigatórias. `probableCause`
 * é anulável porque "não sei apontar a causa" precisa ser dizível.
 */
export const modelDeploymentDiagnosisSchema = z.object({
  summary: z.string(),
  failureType: z.enum(DEPLOYMENT_FAILURE_TYPES),
  evidence: z.array(evidenceSchema),
  probableCause: z.string().nullable(),
  confidence: z.enum(CONFIDENCE_LEVELS),
  nextSteps: z.array(z.string()),
  limitations: z.array(z.string()),
});
