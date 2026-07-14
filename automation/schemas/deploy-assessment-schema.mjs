import { z } from 'zod';

import {
  CONFIDENCE_LEVELS,
  DEPLOY_DECISIONS,
  evidenceSchema,
  RISK_LEVELS,
} from './diagnosis-schema.mjs';

export const DEPLOY_ENVIRONMENTS = ['staging', 'production'];

/**
 * O que o AGENTE pode recomendar — vocabulário deliberadamente diferente do de
 * `DEPLOY_DECISIONS`.
 *
 * A separação é o ponto central do deploy assistido: o agente avalia prontidão
 * *técnica* (`technically_ready`), a política decide *promoção*
 * (`requires_human_approval`). Um agente que pudesse escrever
 * `eligible_for_staging` para production estaria autorizando deploy — e não é
 * dele essa decisão.
 *
 * `eligible_for_staging` aparece nos dois vocabulários porque, em staging, a
 * recomendação técnica e a decisão coincidem quando tudo está verde. Mesmo
 * assim os campos continuam separados: a coincidência é resultado, não regra.
 */
export const AGENT_RECOMMENDATIONS = ['eligible_for_staging', 'technically_ready', 'not_ready'];

export const GATE_STATUSES = ['passed', 'failed', 'skipped'];

/** Resultado de cada gate técnico, derivado do exit code — não de opinião. */
export const gateResultsSchema = z.object({
  lint: z.enum(GATE_STATUSES),
  test: z.enum(GATE_STATUSES),
  build: z.enum(GATE_STATUSES),
});

/**
 * Avaliação de prontidão para deploy.
 *
 * `agentRecommendation` e `policyDecision` são campos irmãos e independentes:
 * o consumidor (workflow, Job Summary, pessoa revisora) enxerga os dois e vê
 * quando a política discordou do agente (`policyOverrodeAgent: true`).
 * Quem controla os jobs de deploy é `policyDecision` — sempre.
 */
export const deployAssessmentSchema = z.object({
  assessmentId: z.string().uuid(),
  repository: z.string().min(1),
  commitSha: z.string().min(1),
  environment: z.enum(DEPLOY_ENVIRONMENTS),
  releaseVersion: z.string().min(1),

  summary: z.string().min(1),
  gateResults: gateResultsSchema,
  evidence: z.array(evidenceSchema),
  riskLevel: z.enum(RISK_LEVELS),
  confidence: z.enum(CONFIDENCE_LEVELS),
  nextSteps: z.array(z.string()),

  agentRecommendation: z.enum(AGENT_RECOMMENDATIONS),
  policyDecision: z.enum(DEPLOY_DECISIONS),
  requiresHumanApproval: z.boolean(),
  policyOverrodeAgent: z.boolean(),
  policyReasons: z.array(z.string()),

  limitations: z.array(z.string()),
  usedFallback: z.boolean(),
  generatedAt: z.string().datetime(),
});

/**
 * Manifesto do deploy SIMULADO. Não descreve infraestrutura: descreve o que
 * *teria* sido promovido. `status` é sempre `simulated` — não existe outro
 * valor possível neste projeto.
 */
export const deploymentManifestSchema = z.object({
  manifestId: z.string().uuid(),
  environment: z.enum(DEPLOY_ENVIRONMENTS),
  releaseVersion: z.string().min(1),
  repository: z.string().min(1),
  commitSha: z.string().min(1),
  policyDecision: z.enum(DEPLOY_DECISIONS),
  approvalRequired: z.boolean(),
  status: z.literal('simulated'),
  simulatedAt: z.string().datetime(),
  runId: z.string().nullable(),
  note: z.string().min(1),
});
