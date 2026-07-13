/**
 * Renderização da avaliação de deploy em Markdown (Job Summary + artefato).
 *
 * Aqui só se formata. A decisão já foi tomada pela política; este arquivo
 * apenas garante que quem lê o relatório veja os dois vereditos lado a lado —
 * o do agente e o da política — e nunca confunda um com o outro.
 */

import { redactSecrets } from './redact-secrets.mjs';
import { sanitizeLog } from './sanitize-log.mjs';

const GATE_LABELS = { passed: '✅ passou', failed: '❌ falhou', skipped: '⚠️ não executado' };
const RISK_LABELS = { low: '🟢 baixo', medium: '🟡 médio', high: '🔴 alto' };
const CONFIDENCE_LABELS = { low: '🔴 baixa', medium: '🟡 média', high: '🟢 alta' };

const RECOMMENDATION_LABELS = {
  eligible_for_staging: '🟢 `eligible_for_staging` — tecnicamente pronto para staging',
  technically_ready: '🟡 `technically_ready` — tecnicamente pronto; a decisão não é do agente',
  not_ready: '🔴 `not_ready` — não está pronto',
};

const DECISION_LABELS = {
  eligible_for_staging: '🟢 `eligible_for_staging` — liberado para staging',
  requires_human_approval: '🟡 `requires_human_approval` — exige aprovação humana no GitHub Environment',
  blocked: '🔴 `blocked` — promoção bloqueada',
};

/**
 * @param {object} assessment avaliação validada por `deployAssessmentSchema`
 * @returns {string} relatório em Markdown
 */
export function renderDeployAssessment(assessment) {
  const lines = [];

  lines.push('# 🚀 Deploy assistido — CopaFigurinhas');
  lines.push('');
  lines.push(
    `**${assessment.repository}** · release \`${assessment.releaseVersion}\` · ` +
      `ambiente \`${assessment.environment}\` · \`${assessment.commitSha.slice(0, 7)}\``,
  );
  lines.push('');

  lines.push('## Resumo');
  lines.push('');
  lines.push(assessment.summary);
  lines.push('');

  lines.push('## Gates técnicos');
  lines.push('');
  lines.push('| Gate | Resultado |');
  lines.push('| --- | --- |');
  for (const [gate, status] of Object.entries(assessment.gateResults)) {
    lines.push(`| ${gate} | ${GATE_LABELS[status]} |`);
  }
  lines.push('');

  lines.push('## Risco e confiança');
  lines.push('');
  lines.push('| Dimensão | Valor |');
  lines.push('| --- | --- |');
  lines.push(`| Risco | ${RISK_LABELS[assessment.riskLevel]} |`);
  lines.push(`| Confiança | ${CONFIDENCE_LABELS[assessment.confidence]} |`);
  lines.push('');

  lines.push('## Evidências');
  lines.push('');
  if (assessment.evidence.length === 0) {
    lines.push('_Nenhuma evidência coletada._');
  } else {
    for (const item of assessment.evidence) {
      lines.push(`- **${item.source}**`);
      lines.push('');
      lines.push('  ```text');
      lines.push(`  ${sanitizeLog(item.excerpt).split('\n').join('\n  ')}`);
      lines.push('  ```');
    }
  }
  lines.push('');

  // O coração do relatório: os dois vereditos, separados e nomeados.
  lines.push('## Recomendação do agente × decisão da política');
  lines.push('');
  lines.push('| Origem | Veredito |');
  lines.push('| --- | --- |');
  lines.push(`| 🤖 \`agentRecommendation\` | ${RECOMMENDATION_LABELS[assessment.agentRecommendation]} |`);
  lines.push(`| 🛡️ \`policyDecision\` | ${DECISION_LABELS[assessment.policyDecision]} |`);
  lines.push('');
  lines.push(
    `**Aprovação humana:** ${assessment.requiresHumanApproval ? '✋ necessária' : 'não necessária'}`,
  );
  lines.push('');

  if (assessment.policyOverrodeAgent) {
    lines.push(
      '> ⚠️ **A política sobrescreveu a recomendação do agente.** Vale a decisão da política. ' +
        'O agente descreve a prontidão técnica; quem autoriza a promoção é a política determinística.',
    );
    lines.push('');
  }

  lines.push('Motivos da política:');
  lines.push('');
  if (assessment.policyReasons.length === 0) {
    lines.push('- _Nenhum motivo registrado._');
  } else {
    for (const reason of assessment.policyReasons) {
      lines.push(`- ${reason}`);
    }
  }
  lines.push('');

  lines.push('## Próximos passos');
  lines.push('');
  if (assessment.nextSteps.length === 0) {
    lines.push('_Nenhum passo sugerido._');
  } else {
    assessment.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  lines.push('');

  lines.push('## Limitações');
  lines.push('');
  if (assessment.limitations.length === 0) {
    lines.push('_Nenhuma limitação declarada._');
  } else {
    for (const limitation of assessment.limitations) {
      lines.push(`- ${limitation}`);
    }
  }
  lines.push('');

  lines.push('## Origem do diagnóstico');
  lines.push('');
  lines.push(
    assessment.usedFallback
      ? '⚙️ **Fallback determinístico** (`usedFallback: true`) — sem modelo.'
      : '🤖 **Modelo** (`usedFallback: false`) — saída estruturada validada por schema.',
  );
  lines.push('');
  lines.push('> Nenhum deploy real é executado. A promoção é **simulada**.');
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(`\`assessmentId: ${assessment.assessmentId}\` · gerado em ${assessment.generatedAt}`);
  lines.push('');

  return redactSecrets(lines.join('\n'));
}
