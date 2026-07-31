/**
 * Relatório operacional em Markdown (Job Summary e artefato).
 *
 * A entrada já está validada pelo schema e mascarada. Aqui só se formata.
 *
 * As quatro categorias — FATO, INFERÊNCIA, RECOMENDAÇÃO, LIMITAÇÃO — ganham
 * seções separadas **e rótulo visível**. Separar por seção já ajuda; o rótulo
 * explícito é o que sobrevive quando alguém copia um trecho solto para uma
 * mensagem e o contexto da seção se perde.
 *
 * Sobre segredos, vale a mesma ordem de `render-deployment-diagnosis.mjs`: cada
 * campo não confiável é redigido ao ser inserido, e o texto final passa pela
 * barreira que reconhece material de credencial — não pela regra de
 * `chave: valor`, que confundiria o rótulo `Tokens: 1.300` com um segredo.
 */

import { redactCredentialMaterial, redactSecrets } from './redact-secrets.mjs';
import { renderModelCallLines } from './render-model-call.mjs';
import { sanitizeLog } from './sanitize-log.mjs';

export const STATUS_LABELS = {
  success: '✅ aprovado',
  failure: '❌ reprovado',
  unknown: '❔ indeterminado',
};

export const PHASE_LABELS = {
  success: 'sem falha',
  ci_quality: 'CI — lint',
  ci_tests: 'CI — testes',
  ci_build: 'CI — build da aplicação',
  ci_docker: 'CI — build da imagem',
  railway_build: 'Railway — build',
  deployment: 'deployment',
  startup: 'inicialização do container',
  environment: 'ambiente/configuração',
  network: 'rede/endereço',
  healthcheck: 'health check',
  functional: 'funcionalidade da aplicação',
  runtime: 'runtime',
  version_mismatch: 'correlação de versão',
  unknown: 'não identificada',
};

export const CAUSE_STRENGTH_LABELS = {
  direct_evidence: 'comprovada diretamente pelo log',
  probable: 'causa provável (inferida a partir dos sintomas)',
  weak_hypothesis: 'hipótese fraca — material insuficiente',
  unavailable: 'não foi possível apontar uma causa',
};

export const CONFIDENCE_LABELS = { low: '🔴 baixa', medium: '🟡 média', high: '🟢 alta' };

export const CORRELATION_LABELS = {
  matched: 'correspondente',
  partial: 'parcial',
  mismatch: '⚠️ divergente',
  unknown: 'não verificada',
};

/** Rótulos das fontes na seção de cobertura, na ordem CI → CD → runtime. */
export const COVERAGE_ROWS = [
  ['ciLint', 'CI lint'],
  ['ciTests', 'CI tests'],
  ['ciBuild', 'CI build'],
  ['ciDocker', 'Docker'],
  ['railwayBuild', 'Railway build'],
  ['railwayDeploy', 'Railway deploy'],
  ['railwayRuntime', 'Railway runtime'],
  ['smokeTest', 'Smoke test'],
];

/**
 * @param {object} diagnosis diagnóstico validado por `operationalDiagnosisSchema`
 * @param {object} [context] contexto operacional (para a linha do tempo)
 * @returns {string} relatório em Markdown
 */
export function renderOperationalReport(diagnosis, context = null) {
  const lines = [];
  const status = diagnosis.technicalStatus;

  lines.push('# 🛰️ Relatório operacional do deployment');
  lines.push('');
  lines.push(
    `**${safe(diagnosis.repository)}** · \`${safe(String(diagnosis.commitSha).slice(0, 7))}\` · ` +
      `\`${safe(diagnosis.targetHost)}\` · resultado: ${STATUS_LABELS[status.overall]}`,
  );
  lines.push('');

  lines.push('| Gate | Resultado |');
  lines.push('| ---- | --------- |');
  lines.push(`| CI (lint, testes, build, docker) | \`${status.ci}\` |`);
  lines.push(`| Deployment (Railway) | \`${status.railwayDeployment}\` |`);
  lines.push(`| Smoke test pós-deployment | \`${status.smokeTest}\` |`);
  lines.push(`| **Geral** | **\`${status.overall}\`** |`);
  lines.push('');

  lines.push(`- Ambiente: \`${safe(diagnosis.environment ?? 'não informado')}\``);
  lines.push(`- Serviço: \`${safe(diagnosis.service ?? 'não informado')}\``);
  lines.push(`- Deployment ID: \`${safe(diagnosis.deploymentId ?? 'não informado')}\``);
  lines.push(`- Gerado em: ${safe(diagnosis.generatedAt)}`);
  lines.push('');

  /* ---- Fase afetada ------------------------------------------------------ */

  lines.push('## Fase afetada');
  lines.push('');
  lines.push(`\`${diagnosis.affectedPhase}\` — ${PHASE_LABELS[diagnosis.affectedPhase]}`);
  lines.push('');
  lines.push(safe(diagnosis.summary));
  lines.push('');

  /* ---- Correlação -------------------------------------------------------- */

  lines.push('## Correlação da release');
  lines.push('');
  lines.push(`- Status: **${CORRELATION_LABELS[diagnosis.correlationStatus]}** (\`${diagnosis.correlationStatus}\`)`);
  lines.push(`- Commit esperado: \`${safe(diagnosis.expectedCommitSha)}\``);
  lines.push(`- Commit observado: \`${safe(diagnosis.observedCommitSha ?? 'não informado pela plataforma')}\``);
  if (diagnosis.correlationStatus === 'mismatch') {
    lines.push('');
    lines.push(
      '> ⚠️ **A versão observada não é a versão esperada.** Os logs desta coleta podem pertencer a outra ' +
        'release — nenhuma conclusão sobre o commit em análise se sustenta sobre eles.',
    );
  }
  lines.push('');

  /* ---- Cobertura --------------------------------------------------------- */

  lines.push('## Cobertura das fontes');
  lines.push('');
  lines.push('```text');
  for (const [key, label] of COVERAGE_ROWS) {
    const dots = '.'.repeat(Math.max(1, 20 - label.length));
    lines.push(`${label} ${dots} ${diagnosis.sourceCoverage[key] ? 'coletado' : 'ausente'}`);
  }
  lines.push('```');
  lines.push('');

  /* ---- Fatos ------------------------------------------------------------- */

  lines.push('## Fatos observados');
  lines.push('');
  lines.push('_Trechos que **existem** no material coletado._');
  lines.push('');
  if (diagnosis.observedFacts.length === 0) {
    lines.push('_Nenhum fato foi coletado._');
  } else {
    for (const fact of diagnosis.observedFacts) {
      lines.push(
        `- **[FATO] ${safe(fact.id)}** · fonte \`${safe(fact.source)}\` · fase \`${fact.phase}\`` +
          (fact.timestamp ? ` · ${safe(fact.timestamp)}` : ' · _sem timestamp_'),
      );
      lines.push('');
      lines.push('  ```text');
      lines.push(`  ${safe(sanitizeLog(fact.excerpt)).split('\n').join('\n  ')}`);
      lines.push('  ```');
    }
  }
  lines.push('');

  /* ---- Inferências ------------------------------------------------------- */

  lines.push('## Inferências');
  lines.push('');
  lines.push('_Afirmações **deduzidas** dos fatos — não estão literalmente no log._');
  lines.push('');
  if (diagnosis.inferences.length === 0) {
    lines.push('_Nenhuma inferência se sustentou nos fatos coletados._');
  } else {
    for (const inference of diagnosis.inferences) {
      lines.push(`- **[INFERÊNCIA]** ${safe(inference.statement)}`);
      lines.push(
        `  - Sustentada por: ${inference.supportedBy.map((id) => `\`${safe(id)}\``).join(', ')}`,
      );
      lines.push(`  - Confiança: ${CONFIDENCE_LABELS[inference.confidence]}`);
    }
  }
  lines.push('');

  /* ---- Causa ------------------------------------------------------------- */

  lines.push('## Causa provável');
  lines.push('');
  lines.push(`Força da afirmação: **${CAUSE_STRENGTH_LABELS[diagnosis.causeStrength]}**`);
  lines.push('');
  lines.push(
    diagnosis.probableCause
      ? safe(diagnosis.probableCause)
      : '_Não foi possível estabelecer uma causa com o material disponível._',
  );
  lines.push('');

  /* ---- Recomendações ----------------------------------------------------- */

  lines.push('## Recomendações');
  lines.push('');
  if (diagnosis.recommendedActions.length === 0) {
    lines.push('_Nenhuma ação sugerida._');
  } else {
    diagnosis.recommendedActions.forEach((action, index) =>
      lines.push(`${index + 1}. **[RECOMENDAÇÃO]** ${safe(action)}`),
    );
  }
  lines.push('');

  /* ---- Limitações -------------------------------------------------------- */

  lines.push('## Limitações');
  lines.push('');
  if (diagnosis.limitations.length === 0) {
    lines.push('_Nenhuma limitação declarada._');
  } else {
    for (const limitation of diagnosis.limitations) {
      lines.push(`- **[LIMITAÇÃO]** ${safe(limitation)}`);
    }
  }
  lines.push('');

  /* ---- Linha do tempo ---------------------------------------------------- */

  if (context?.timeline?.length) {
    lines.push('## Linha do tempo (CI → CD → runtime)');
    lines.push('');
    lines.push('| Horário | Fase | Fonte | Evento |');
    lines.push('| ------- | ---- | ----- | ------ |');
    for (const event of context.timeline.slice(0, 40)) {
      lines.push(
        `| ${event.timestamp ? safe(event.timestamp) : '_sem timestamp_'} | \`${event.phase}\` | ` +
          `\`${safe(event.source)}\` | ${safe(event.message).replace(/\|/g, '\\|').slice(0, 160)} |`,
      );
    }
    lines.push('');
  }

  /* ---- Origem ------------------------------------------------------------ */

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

  lines.push('## O que a IA não pode afirmar');
  lines.push('');
  for (const item of CANNOT_CLAIM) lines.push(`- ${item}`);
  lines.push('');

  lines.push(
    '> Este relatório é **informativo**. Quem aprova ou reprova o deployment é o smoke test ' +
      'determinístico (códigos HTTP e exit code) — a IA descreve, não decide.',
  );
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(
    `\`analysisId: ${safe(diagnosis.analysisId)}\` · \`requestId: ${safe(diagnosis.requestId)}\``,
  );
  lines.push('');

  return redactCredentialMaterial(lines.join('\n'));
}

/**
 * O que o material desta análise **não** permite concluir, em qualquer execução.
 *
 * Fica no relatório, e não só na documentação, porque é lido no momento em que
 * alguém está tentado a tratar o texto do modelo como veredito.
 */
export const CANNOT_CLAIM = [
  'Que o deployment passou ou falhou — isso vem do smoke test e dos exit codes dos jobs, não desta análise.',
  'Que a causa apontada é a causa raiz, quando o material mostra apenas sintomas.',
  'O que aconteceu em fontes marcadas como **ausentes** na cobertura acima.',
  'O comportamento de usuários reais: nenhum tráfego de produção foi observado.',
  'Que a correção sugerida resolve o problema — ela é um ponto de partida para investigação.',
];

function safe(value) {
  return redactSecrets(String(value ?? ''));
}
