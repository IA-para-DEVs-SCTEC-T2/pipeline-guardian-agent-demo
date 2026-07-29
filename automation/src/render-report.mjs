/**
 * Renderização do diagnóstico em Markdown.
 *
 * A entrada é um diagnóstico já validado pelo schema e já mascarado. Aqui só se
 * formata — nenhuma decisão é tomada.
 *
 * Sobre segredos, a ordem é: **cada campo não confiável é redigido ao ser
 * inserido** (`safe`), e o texto final passa por uma última barreira que
 * reconhece material de credencial (`redactCredentialMaterial`).
 *
 * Antes, a redação completa era aplicada de uma vez sobre o Markdown pronto — o
 * que fazia o relatório redigir o próprio rótulo: `Tokens: 1.300` casava com a
 * regra de `token: valor` e virava `Tokens: [REDACTED]`. Rótulo escrito por nós
 * não é conteúdo suspeito; conteúdo suspeito é o que vem do modelo e dos logs, e
 * é nele que a regra forte precisa incidir.
 */

import { redactCredentialMaterial, redactSecrets } from './redact-secrets.mjs';
import { renderModelCallLines } from './render-model-call.mjs';
import { sanitizeLog } from './sanitize-log.mjs';

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
    `**${safe(diagnosis.repository)}** · \`${safe(diagnosis.branch)}\` · ` +
      `\`${safe(diagnosis.commitSha.slice(0, 7))}\` · ` +
      `pipeline: ${PIPELINE_STATUS_LABELS[diagnosis.pipelineStatus]}`,
  );
  lines.push('');

  lines.push('## Resumo');
  lines.push('');
  lines.push(safe(diagnosis.summary));
  lines.push('');

  lines.push('## Sinal');
  lines.push('');
  lines.push(`\`${safe(diagnosis.signal)}\``);
  lines.push('');

  lines.push('## Tipo de falha');
  lines.push('');
  lines.push(`\`${diagnosis.failureType}\` (${FAILURE_TYPE_LABELS[diagnosis.failureType]})`);
  lines.push('');

  lines.push('## Causa provável');
  lines.push('');
  lines.push(safe(diagnosis.probableCause));
  lines.push('');

  lines.push('## Evidências');
  lines.push('');
  if (diagnosis.evidence.length === 0) {
    lines.push('_Nenhuma evidência coletada._');
  } else {
    for (const item of diagnosis.evidence) {
      const cleanExcerpt = safe(sanitizeLog(item.excerpt));
      lines.push(`- **${safe(item.source)}**`);
      lines.push('');
      lines.push('  ```text');
      lines.push(`  ${cleanExcerpt.split('\n').join('\n  ')}`);
      lines.push('  ```');
    }
  }
  lines.push('');

  lines.push('## Impacto');
  lines.push('');
  lines.push(safe(diagnosis.impact));
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
    diagnosis.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${safe(step)}`));
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
      lines.push(`- ${safe(reason)}`);
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
      lines.push(`- ${safe(limitation)}`);
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

  const modelCall = renderModelCallLines(diagnosis);
  if (modelCall.length > 0) {
    lines.push('### Chamada ao modelo');
    lines.push('');
    lines.push(...modelCall);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `\`analysisId: ${safe(diagnosis.analysisId)}\` · \`requestId: ${safe(diagnosis.requestId)}\` · ` +
      `gerado em ${safe(diagnosis.generatedAt)}`,
  );
  lines.push('');

  // Última barreira. Só material de credencial: os campos não confiáveis já
  // passaram por `safe`, e o resto do texto é rótulo nosso.
  return redactCredentialMaterial(lines.join('\n'));
}

/** Redação completa de um campo não confiável, na hora de inseri-lo. */
function safe(value) {
  return redactSecrets(String(value ?? ''));
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
