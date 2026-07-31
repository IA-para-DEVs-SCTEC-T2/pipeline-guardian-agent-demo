import { z } from 'zod';

import { CONFIDENCE_LEVELS, modelCallFields } from './diagnosis-schema.mjs';

/**
 * Fases do fluxo operacional — CI, plataforma, inicialização e runtime.
 *
 * **Uma lista só**, usada por três coisas ao mesmo tempo: a fase afetada do
 * diagnóstico, a fase de cada fato observado e a fase de cada evento da linha do
 * tempo. Duas listas parecidas para "onde isso aconteceu" seriam duas listas que
 * divergem na primeira fase nova — e a divergência aparece como erro de schema
 * no pior momento possível, com o relatório pronto.
 *
 * A ordem é **cronológica** e é usada para ordenar eventos que não têm
 * timestamp (ver `sortTimeline`). Os três últimos valores não são momentos no
 * tempo e ficam no fim de propósito:
 *
 * - `version_mismatch` — não é uma etapa, é uma quebra de correlação;
 * - `success` — quando nada falhou não há fase afetada a nomear, e forçar uma
 *   seria inventar problema;
 * - `unknown` — resposta legítima quando nada se sustenta nos dados.
 */
export const OPERATIONAL_PHASES = [
  'ci_quality',
  'ci_tests',
  'ci_build',
  'ci_docker',
  'railway_build',
  'railway_deploy',
  'deployment',
  'startup',
  'environment',
  'network',
  'healthcheck',
  'functional',
  'runtime',
  'post_deployment_validation',
  'version_mismatch',
  'success',
  'unknown',
];

/** Resultado técnico de cada gate. Vem de exit code e código HTTP, nunca do modelo. */
export const CI_STATUSES = ['success', 'failure', 'unknown'];
export const RAILWAY_STATUSES = ['success', 'failed', 'crashed', 'in_progress', 'removed', 'unknown'];
export const SMOKE_STATUSES = ['success', 'failure', 'not_executed', 'unknown'];
export const OVERALL_STATUSES = ['success', 'failure', 'unknown'];

export const CORRELATION_STATUSES = ['matched', 'partial', 'mismatch', 'unknown'];

/**
 * Força da causa apontada — a distinção que separa diagnóstico de palpite.
 *
 * `direct_evidence` só quando o log **mostra** a causa (a exceção, a variável
 * faltando). `probable` é a explicação mais provável a partir de sintomas.
 * `weak_hypothesis` é o que se cogita com material insuficiente, e precisa ser
 * dizível para não virar `probable` por conveniência. `unavailable` é a resposta
 * honesta quando não há material.
 *
 * Nada aqui admite a expressão "causa raiz confirmada" a partir de sintoma —
 * ver `automation/prompts/operational-analysis.md`.
 */
export const CAUSE_STRENGTHS = ['direct_evidence', 'probable', 'weak_hypothesis', 'unavailable'];

/**
 * Um fato observado: um trecho que **existe** no material coletado, com a
 * origem e a fase. O `id` (`F1`, `F2`, …) é o que as inferências citam.
 */
export const observedFactSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  phase: z.enum(OPERATIONAL_PHASES),
  timestamp: z.string().nullable(),
  excerpt: z.string().min(1),
});

/**
 * Uma inferência: uma afirmação que **não** está no log, derivada de fatos que
 * estão. `supportedBy` referencia os `id` dos fatos — uma inferência sem apoio
 * válido é removida pelo agente, não publicada com aparência de conclusão.
 */
export const inferenceSchema = z.object({
  statement: z.string().min(1),
  supportedBy: z.array(z.string()),
  confidence: z.enum(CONFIDENCE_LEVELS),
});

export const technicalStatusSchema = z.object({
  overall: z.enum(OVERALL_STATUSES),
  ci: z.enum(CI_STATUSES),
  railwayDeployment: z.enum(RAILWAY_STATUSES),
  smokeTest: z.enum(SMOKE_STATUSES),
});

export const sourceCoverageSchema = z.object({
  ciLint: z.boolean(),
  ciTests: z.boolean(),
  ciBuild: z.boolean(),
  ciDocker: z.boolean(),
  railwayBuild: z.boolean(),
  railwayDeploy: z.boolean(),
  railwayRuntime: z.boolean(),
  smokeTest: z.boolean(),
});

/**
 * Diagnóstico operacional completo.
 *
 * `technicalStatus`, `sourceCoverage`, `correlationStatus` e `usedFallback` são
 * fatos do sistema. `summary`, `inferences`, `probableCause` e
 * `recommendedActions` são descrição. A ordem das chaves é a ordem do relatório.
 */
export const operationalDiagnosisSchema = z.object({
  analysisId: z.string().uuid(),
  requestId: z.string().min(1),
  repository: z.string().min(1),
  commitSha: z.string().min(1),
  deploymentId: z.string().nullable(),
  service: z.string().nullable(),
  environment: z.string().nullable(),
  /** Só o host: a URL completa poderia carregar credencial ou token em query. */
  targetHost: z.string().min(1),

  technicalStatus: technicalStatusSchema,
  affectedPhase: z.enum(OPERATIONAL_PHASES),

  summary: z.string().min(1),
  observedFacts: z.array(observedFactSchema),
  inferences: z.array(inferenceSchema),
  probableCause: z.string().nullable(),
  causeStrength: z.enum(CAUSE_STRENGTHS),
  recommendedActions: z.array(z.string()),
  limitations: z.array(z.string()),

  sourceCoverage: sourceCoverageSchema,
  correlationStatus: z.enum(CORRELATION_STATUSES),
  expectedCommitSha: z.string().min(1),
  observedCommitSha: z.string().nullable(),

  usedFallback: z.boolean(),
  ...modelCallFields,
  generatedAt: z.string().datetime(),
});

/**
 * Recorte que o modelo pode produzir.
 *
 * Fora daqui, de propósito: `technicalStatus` (vem do exit code e do código
 * HTTP), `sourceCoverage` (vem da coleta), `correlationStatus` (vem do SHA) e
 * os campos de identidade. O modelo **explica**; ele não aprova, não reprova e
 * não redefine o que foi observado.
 *
 * Sem `.optional()` e sem `.default()`: o structured output da OpenAI exige JSON
 * Schema estrito com todas as propriedades obrigatórias. `probableCause` é
 * anulável porque "não sei apontar a causa" precisa ser dizível.
 */
export const modelOperationalDiagnosisSchema = z.object({
  summary: z.string(),
  affectedPhase: z.enum(OPERATIONAL_PHASES),
  observedFacts: z.array(observedFactSchema),
  inferences: z.array(inferenceSchema),
  probableCause: z.string().nullable(),
  causeStrength: z.enum(CAUSE_STRENGTHS),
  recommendedActions: z.array(z.string()),
  limitations: z.array(z.string()),
});
