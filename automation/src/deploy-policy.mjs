/**
 * Política de deploy.
 *
 * Roda DEPOIS do modelo e sobrescreve qualquer recomendação insegura. O modelo
 * descreve a falha; quem decide se algo pode ser promovido é este arquivo, com
 * regras legíveis e testáveis.
 *
 * Precedência: blocked > requires_human_approval > eligible_for_staging.
 * Na dúvida, fecha (fail-closed).
 */

/** Tipos de falha que bloqueiam a promoção, por si só. */
export const BLOCKING_FAILURE_TYPES = ['lint', 'test', 'build', 'security', 'permission'];

/**
 * Limitações que invalidam a confiança no diagnóstico: falam de evidência
 * ausente, inacessível ou ambígua. Limitações puramente informativas (ex.: "uso
 * do classificador determinístico") não bloqueiam.
 */
export const RELEVANT_LIMITATION_PATTERNS = [
  /ausente/i,
  /sem acesso/i,
  /sem logs/i,
  /n[ãa]o (?:est[áa] )?dispon[ií]vel/i,
  /indispon[ií]vel/i,
  /n[ãa]o foi poss[ií]vel/i,
  /n[ãa]o (?:foi|foram) encontrad/i,
  /incomplet/i,
  /insuficient/i,
  /amb[ií]gu/i,
  /contradit/i,
  /unavailable/i,
  /no access/i,
  /unable to/i,
  /missing (?:context|logs|evidence)/i,
];

/**
 * @param {string[]} limitations
 * @returns {string[]} apenas as limitações consideradas relevantes
 */
export function findRelevantLimitations(limitations = []) {
  return limitations.filter((limitation) =>
    RELEVANT_LIMITATION_PATTERNS.some((pattern) => pattern.test(limitation)),
  );
}

/**
 * Aplica a política sobre o diagnóstico (do modelo ou do fallback).
 *
 * @param {object} input
 * @param {object} input.diagnosis campos de `modelDiagnosisSchema`
 * @param {object} input.metadata metadados normalizados do pipeline
 * @param {object} input.results resultado de `inspectCommandResults`
 * @param {object} [input.sensitive] resultado de `scanForSensitiveData`
 * @returns {{ deployDecision: string, requiresHumanApproval: boolean, riskLevel: string, reasons: string[] }}
 */
export function applyDeployPolicy({ diagnosis, metadata, results, sensitive } = {}) {
  const reasons = [];
  const blockers = [];

  const securityIssue = Boolean(sensitive?.hasSensitiveData) || diagnosis.failureType === 'security';
  if (securityIssue) {
    blockers.push('security: conteúdo sensível detectado — risco elevado para high.');
  }

  if (BLOCKING_FAILURE_TYPES.includes(diagnosis.failureType) && !securityIssue) {
    blockers.push(`${diagnosis.failureType}: falha desta categoria bloqueia a promoção.`);
  }

  if (results?.pipelineStatus === 'failed') {
    blockers.push('pipeline com comandos em falha — nada é promovido com pipeline vermelho.');
  }

  if (diagnosis.confidence === 'low') {
    blockers.push('confiança baixa no diagnóstico — não se promove o que não se entende.');
  }

  if (diagnosis.riskLevel === 'high' && !securityIssue) {
    blockers.push('risco alto apontado pelo diagnóstico — promoção bloqueada.');
  }

  const relevantLimitations = findRelevantLimitations(diagnosis.limitations);
  if (relevantLimitations.length > 0) {
    blockers.push(`limitações relevantes na análise: ${relevantLimitations.join(' ')}`);
  }

  // Risco: a política só escala, nunca reduz o que o diagnóstico apontou.
  const riskLevel = securityIssue ? 'high' : escalate(diagnosis.riskLevel, blockers.length > 0 ? 'medium' : 'low');

  const environment = metadata?.environment ?? 'unknown';
  const isRollback = Boolean(metadata?.isRollback);

  let deployDecision;

  if (blockers.length > 0) {
    deployDecision = 'blocked';
    reasons.push(...blockers);
  } else if (environment === 'production' && isRollback) {
    deployDecision = 'requires_human_approval';
    reasons.push('rollback de production exige aprovação humana explícita.');
  } else if (environment === 'production') {
    deployDecision = 'requires_human_approval';
    reasons.push('deploy em production exige aprovação humana explícita.');
  } else if (environment === 'staging') {
    deployDecision = 'eligible_for_staging';
    reasons.push('staging com todos os gates aprovados: elegível para promoção.');
  } else {
    deployDecision = 'requires_human_approval';
    reasons.push(`ambiente "${environment}" não reconhecido pela política: exige aprovação humana.`);
  }

  return {
    deployDecision,
    requiresHumanApproval: deployDecision !== 'eligible_for_staging',
    riskLevel,
    reasons,
  };
}

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

function escalate(current, floor) {
  const currentRank = RISK_ORDER[current] ?? 0;
  const floorRank = RISK_ORDER[floor] ?? 0;
  const winner = currentRank >= floorRank ? current : floor;
  return winner in RISK_ORDER ? winner : 'medium';
}
