/**
 * Renderização do diagnóstico de deployment em Markdown (Job Summary + artefato).
 *
 * A entrada já está validada pelo schema e mascarada. Aqui só se formata —
 * nenhuma decisão é tomada.
 *
 * As seções seguem a ordem em que um plantonista lê um incidente: o que foi
 * afetado, o que aconteceu, o que sustenta essa afirmação, o que se supõe a
 * partir disso, quanto se confia, o que fazer e o que não foi possível saber.
 * Fato, hipótese, recomendação e limitação ficam em seções separadas de
 * propósito — misturá-los é o jeito mais rápido de transformar diagnóstico em
 * palpite com aparência de conclusão.
 */

import { redactSecrets } from './redact-secrets.mjs';
import { sanitizeLog } from './sanitize-log.mjs';

const STATUS_LABELS = {
  success: '✅ aprovado',
  failure: '❌ reprovado',
};

const FAILURE_TYPE_LABELS = {
  success: 'sem falha',
  healthcheck: 'health check',
  startup: 'inicialização',
  environment: 'ambiente/configuração',
  network: 'rede/endereço',
  deployment: 'deployment',
  unknown: 'não identificado',
};

const CONFIDENCE_LABELS = { low: '🔴 baixa', medium: '🟡 média', high: '🟢 alta' };

/**
 * @param {object} diagnosis diagnóstico validado por `deploymentDiagnosisSchema`
 * @returns {string} relatório em Markdown
 */
export function renderDeploymentDiagnosis(diagnosis) {
  const lines = [];

  lines.push('# 🚦 Validação pós-deployment');
  lines.push('');
  lines.push(
    `**${diagnosis.repository}** · \`${String(diagnosis.commitSha).slice(0, 7)}\` · ` +
      `\`${diagnosis.targetHost}\` · resultado: ${STATUS_LABELS[diagnosis.status]}`,
  );
  lines.push('');

  lines.push('## Etapa afetada');
  lines.push('');
  lines.push('Validação pós-deployment (smoke test contra a aplicação publicada).');
  lines.push('');

  lines.push(diagnosis.status === 'success' ? '## Resultado' : '## Erro principal');
  lines.push('');
  lines.push(diagnosis.summary);
  lines.push('');
  lines.push(`Tipo: \`${diagnosis.failureType}\` (${FAILURE_TYPE_LABELS[diagnosis.failureType]})`);
  lines.push('');

  lines.push('## Evidências');
  lines.push('');
  lines.push('_Trechos que existem no log coletado._');
  lines.push('');
  if (diagnosis.evidence.length === 0) {
    lines.push('_Nenhuma evidência coletada._');
  } else {
    for (const item of diagnosis.evidence) {
      lines.push(`- **${item.source}**`);
      lines.push('');
      lines.push('  ```text');
      lines.push(`  ${sanitizeLog(item.excerpt).split('\n').join('\n  ')}`);
      lines.push('  ```');
    }
  }
  lines.push('');

  lines.push('## Causa provável');
  lines.push('');
  lines.push('_Hipótese inferida a partir das evidências — não é fato observado._');
  lines.push('');
  lines.push(
    diagnosis.probableCause ??
      '_Não foi possível estabelecer uma causa provável com o material disponível._',
  );
  lines.push('');

  lines.push('## Confiança');
  lines.push('');
  lines.push(CONFIDENCE_LABELS[diagnosis.confidence]);
  lines.push('');

  lines.push('## Próximos passos');
  lines.push('');
  if (diagnosis.nextSteps.length === 0) {
    lines.push('_Nenhum passo sugerido._');
  } else {
    diagnosis.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
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
  lines.push(
    '> Este diagnóstico é **informativo**. Quem aprova ou reprova o deployment é o smoke test ' +
      'determinístico (códigos HTTP e exit code) — a IA descreve, não decide.',
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
