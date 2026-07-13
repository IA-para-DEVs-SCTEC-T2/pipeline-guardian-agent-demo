/**
 * Renderização do diagnóstico em Markdown.
 *
 * A entrada é um diagnóstico já validado pelo schema e já mascarado. Aqui só se
 * formata — nenhuma decisão é tomada.
 */

import { redactSecrets } from './redact-secrets.mjs';

/** Marcador usado para localizar o comentário do agente na Pull Request. */
export const REPORT_MARKER = '<!-- pipeline-guardian -->';

const PIPELINE_STATUS_LABELS = {
  success: '✅ sucesso',
  failed: '❌ falhou',
  partial: '⚠️ parcial',
};

const FAILURE_TYPE_LABELS = {
  lint: 'lint',
  test: 'testes',
  dependency: 'dependência',
  build: 'build',
  environment: 'ambiente',
  permission: 'permissão',
  security: 'segurança',
  unknown: 'não identificado',
};

const RISK_LABELS = { low: '🟢 baixo', medium: '🟡 médio', high: '🔴 alto' };
const CONFIDENCE_LABELS = { low: '🔴 baixa', medium: '🟡 média', high: '🟢 alta' };

const DECISION_LABELS = {
  eligible_for_staging: '🟢 `eligible_for_staging` — elegível para staging',
  blocked: '🔴 `blocked` — promoção bloqueada',
  requires_human_approval: '🟡 `requires_human_approval` — exige aprovação humana',
};

/**
 * @param {object} diagnosis diagnóstico validado
 * @param {object} [options]
 * @param {string[]} [options.policyReasons] por que a política decidiu o que decidiu
 * @returns {string} relatório em Markdown
 */
export function renderMarkdown(diagnosis, { policyReasons = [] } = {}) {
  const lines = [];

  lines.push('# 🛡️ Pipeline Guardian');
  lines.push('');
  lines.push(
    `**${diagnosis.repository}** · \`${diagnosis.branch}\` · \`${diagnosis.commitSha.slice(0, 7)}\` · ` +
      `pipeline: ${PIPELINE_STATUS_LABELS[diagnosis.pipelineStatus]}`,
  );
  lines.push('');

  lines.push('## Resumo');
  lines.push('');
  lines.push(diagnosis.summary);
  lines.push('');

  lines.push('## Sinal');
  lines.push('');
  lines.push(`\`${diagnosis.signal}\``);
  lines.push('');

  lines.push('## Tipo de falha');
  lines.push('');
  lines.push(`\`${diagnosis.failureType}\` (${FAILURE_TYPE_LABELS[diagnosis.failureType]})`);
  lines.push('');

  lines.push('## Causa provável');
  lines.push('');
  lines.push(diagnosis.probableCause);
  lines.push('');

  lines.push('## Evidências');
  lines.push('');
  if (diagnosis.evidence.length === 0) {
    lines.push('_Nenhuma evidência coletada._');
  } else {
    for (const item of diagnosis.evidence) {
      lines.push(`- **${item.source}**`);
      lines.push('');
      lines.push('  ```text');
      lines.push(`  ${item.excerpt.split('\n').join('\n  ')}`);
      lines.push('  ```');
    }
  }
  lines.push('');

  lines.push('## Impacto');
  lines.push('');
  lines.push(diagnosis.impact);
  lines.push('');

  lines.push('## Risco e confiança');
  lines.push('');
  lines.push('| Dimensão | Valor |');
  lines.push('| --- | --- |');
  lines.push(`| Risco | ${RISK_LABELS[diagnosis.riskLevel]} |`);
  lines.push(`| Confiança | ${CONFIDENCE_LABELS[diagnosis.confidence]} |`);
  lines.push('');

  lines.push('## Próximos passos');
  lines.push('');
  if (diagnosis.nextSteps.length === 0) {
    lines.push('_Nenhum passo sugerido._');
  } else {
    diagnosis.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  lines.push('');

  lines.push('## Decisão de deploy');
  lines.push('');
  lines.push(DECISION_LABELS[diagnosis.deployDecision]);
  lines.push('');
  if (policyReasons.length > 0) {
    lines.push('Motivos da política:');
    lines.push('');
    for (const reason of policyReasons) {
      lines.push(`- ${reason}`);
    }
    lines.push('');
  }
  lines.push(
    `**Aprovação humana:** ${diagnosis.requiresHumanApproval ? '✋ necessária' : 'não necessária para staging'}`,
  );
  lines.push('');
  lines.push('> A decisão é da política de deploy, aplicada após a análise. O modelo não decide promoção.');
  lines.push('');

  lines.push('## Limitações');
  lines.push('');
  if (diagnosis.limitations.length === 0) {
    lines.push('_Nenhuma limitação declarada._');
  } else {
    for (const limitation of diagnosis.limitations) {
      lines.push(`- ${limitation}`);
    }
  }
  lines.push('');

  lines.push('## Origem do diagnóstico');
  lines.push('');
  lines.push(
    diagnosis.usedFallback
      ? '⚙️ **Fallback determinístico** (`usedFallback: true`) — gerado por classificação de padrões, sem modelo.'
      : '🤖 **Modelo** (`usedFallback: false`) — gerado com saída estruturada validada por schema.',
  );
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(
    `\`analysisId: ${diagnosis.analysisId}\` · \`requestId: ${diagnosis.requestId}\` · ` +
      `gerado em ${diagnosis.generatedAt}`,
  );
  lines.push('');

  return redactSecrets(lines.join('\n'));
}

/**
 * Corpo do comentário de Pull Request: o mesmo relatório, com o marcador que
 * permite localizar e atualizar o comentário existente.
 *
 * @param {object} diagnosis
 * @returns {string}
 */
export function renderPullRequestComment(diagnosis) {
  return `${REPORT_MARKER}\n${renderMarkdown(diagnosis)}`;
}
