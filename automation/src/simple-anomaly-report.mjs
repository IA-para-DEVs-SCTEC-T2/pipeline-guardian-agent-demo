/**
 * Relatório da detecção de anomalia — Dia 2.
 *
 * Um relatório, três formatos (JSON, Markdown e HTML autônomo) e **nove
 * seções**, sempre as mesmas e sempre nesta ordem:
 *
 *   1. Resultado          6. Evidências dos logs
 *   2. Sinal analisado    7. Explicação
 *   3. Baseline           8. Ações recomendadas
 *   4. Valor observado    9. Limitações
 *   5. Regra aplicada
 *
 * A ordem é a da aula: primeiro o veredito, depois **o que** foi medido, com o
 * **que** foi comparado, por **qual** regra — e só então o texto. Quem lê chega
 * na explicação já sabendo a conta; se a explicação discordar dos números, o
 * erro fica visível na mesma página.
 *
 * Aqui não se decide nada. Os números chegam prontos do detector e o texto,
 * pronto do explicador. Este módulo formata.
 *
 * Sobre segurança, vale a ordem do Dia 1: cada campo não confiável é redigido
 * ao ser inserido e o Markdown final passa pela barreira que reconhece material
 * de credencial. No HTML, **tudo** passa por `escapeHtml` — trecho de log e
 * texto de modelo são as duas fontes não confiáveis, e o HTML é um arquivo que
 * alguém abre no navegador.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { escapeHtml } from './html-escape.mjs';
import { redactCredentialMaterial, redactSecrets, redactSecretsDeep } from './redact-secrets.mjs';
import { SIGNAL_LABELS, THRESHOLDS } from './simple-anomaly-detector.mjs';

/** Versão do formato do relatório. */
export const ANOMALY_REPORT_VERSION = 1;

/** Nome-base dos arquivos gravados. */
export const REPORT_BASENAME = 'anomaly-report';

const RESULT_LABELS = {
  true: '🔴 anomalia detectada',
  false: '🟢 comportamento dentro da baseline',
};

const TYPE_LABELS = {
  latency: 'latência (`latency`)',
  'log-volume': 'volume de log (`log-volume`)',
};

/**
 * Monta o objeto do relatório.
 *
 * Os quatro campos da decisão ficam no topo, sem aninhamento: é o que se lê
 * primeiro num `cat` e o que uma correção precisa ver virar `false`.
 *
 * @param {object} input
 * @param {object} input.detection resultado determinístico
 * @param {object} input.observation observação medida
 * @param {object} input.baseline baseline carregada
 * @param {object} input.explanation explicação (modelo ou fallback)
 * @param {object} input.explanationSource `{ source, sourceLabel, usedFallback, modelCall }`
 * @param {Array<{ source: string, excerpt: string }>} [input.excerpts]
 * @param {string} [input.scenario] rótulo do cenário (`baseline`, `check`, `demo:latency`, `fixture:normal`)
 * @param {() => Date} [input.now]
 * @returns {object}
 */
export function buildAnomalyReport({
  detection,
  observation,
  baseline,
  explanation,
  explanationSource,
  excerpts = [],
  scenario = 'check',
  now = () => new Date(),
}) {
  return {
    reportVersion: ANOMALY_REPORT_VERSION,
    scenario,
    route: observation?.route ?? baseline?.route ?? '/api/report',
    generatedAt: now().toISOString(),

    // A decisão, no topo e sem aninhamento.
    anomalyDetected: detection.anomalyDetected,
    anomalyType: detection.anomalyType,
    firstAnomalousSignal: detection.firstAnomalousSignal,
    gateResult: detection.gateResult,
    triggeredRules: detection.triggeredRules,

    baseline: {
      latencyP95Ms: detection.baseline.latencyP95Ms,
      logLinesPerRequest: detection.baseline.logLinesPerRequest,
      sampleCount: baseline?.sampleCount ?? null,
      createdAt: baseline?.createdAt ?? null,
      commitSha: baseline?.commitSha ?? null,
    },
    observed: {
      latencyP95Ms: detection.observed.latencyP95Ms,
      logLinesPerRequest: detection.observed.logLinesPerRequest,
      sampleCount: observation?.sampleCount ?? null,
      // Contexto exibido, nunca decisório.
      context: observation?.context ?? {},
    },
    signals: detection.evaluations ?? [],
    // Texto de modelo e trecho de log são as duas fontes não confiáveis do
    // relatório, e o JSON é publicado igual aos outros dois formatos: a máscara
    // entra aqui, no objeto, e não só na renderização.
    logExcerpts: redactSecretsDeep(excerpts),

    explanation: redactSecretsDeep(explanation),
    explanationSource: explanationSource.source,
    explanationSourceLabel: explanationSource.sourceLabel,
    usedFallback: explanationSource.usedFallback,
    ...(explanationSource.modelCall ?? {}),
  };
}

/* ------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} report
 * @returns {string} Markdown
 */
export function renderAnomalyMarkdown(report) {
  const lines = [];
  const detected = report.anomalyDetected;

  lines.push('# 🔎 Detecção de anomalia — Dia 2');
  lines.push('');
  lines.push(
    `Rota \`${safe(report.route)}\` · cenário \`${safe(report.scenario)}\` · gerado em ${safe(report.generatedAt)}`,
  );
  lines.push('');

  lines.push('## 1. Resultado');
  lines.push('');
  lines.push(`**${RESULT_LABELS[String(detected)]}**`);
  lines.push('');
  lines.push(`- \`anomalyDetected\`: \`${detected}\``);
  lines.push(`- \`anomalyType\`: ${report.anomalyType ? TYPE_LABELS[report.anomalyType] ?? `\`${safe(report.anomalyType)}\`` : '`null`'}`);
  lines.push(`- \`firstAnomalousSignal\`: ${report.firstAnomalousSignal ? `\`${safe(report.firstAnomalousSignal)}\`` : '`null`'}`);
  lines.push(`- \`gateResult\`: \`${safe(report.gateResult)}\``);
  lines.push('');

  lines.push('## 2. Sinal analisado');
  lines.push('');
  lines.push('_Só estes dois decidem. O resto é contexto._');
  lines.push('');
  lines.push('| Sinal | Baseline | Observado | Diferença | Razão | Disparou |');
  lines.push('| --- | ---: | ---: | ---: | ---: | :---: |');
  for (const signal of report.signals) {
    lines.push(
      `| \`${safe(signal.signal)}\` — ${safe(signal.label ?? SIGNAL_LABELS[signal.signal] ?? '')} | ` +
        `${signal.baseline} | ${signal.observed} | ${signal.difference} | ` +
        `${signal.ratio === null ? '—' : `${signal.ratio}x`} | ${signal.triggered ? '✅' : '—'} |`,
    );
  }
  lines.push('');

  lines.push('## 3. Baseline');
  lines.push('');
  lines.push('_O comportamento normal, medido antes da mudança._');
  lines.push('');
  lines.push(`- latência p95: **${report.baseline.latencyP95Ms} ms**`);
  lines.push(`- linhas de log por requisição: **${report.baseline.logLinesPerRequest}**`);
  lines.push(`- amostras: ${report.baseline.sampleCount ?? 'n/d'}`);
  lines.push(`- medida em: ${safe(report.baseline.createdAt ?? 'n/d')}`);
  lines.push(`- commit: \`${safe(report.baseline.commitSha ?? 'n/d')}\``);
  lines.push('');

  lines.push('## 4. Valor observado');
  lines.push('');
  lines.push(`- latência p95: **${report.observed.latencyP95Ms} ms**`);
  lines.push(`- linhas de log por requisição: **${report.observed.logLinesPerRequest}**`);
  lines.push(`- amostras: ${report.observed.sampleCount ?? 'n/d'}`);
  lines.push('');
  lines.push('Contexto (não decide nada):');
  lines.push('');
  for (const [key, value] of Object.entries(report.observed.context ?? {})) {
    lines.push(`- \`${safe(key)}\`: ${safe(formatValue(value))}`);
  }
  lines.push('');

  lines.push('## 5. Regra aplicada');
  lines.push('');
  lines.push('_Cada sinal só dispara com as **duas** condições ao mesmo tempo._');
  lines.push('');
  for (const signal of report.signals) {
    const threshold = THRESHOLDS[signal.signal] ?? {};
    lines.push(`- \`${safe(signal.signal)}\` (limites: ${threshold.ratio}× e ${threshold.absolute} ${threshold.unit ?? ''})`);
    lines.push(`  - ${mark(signal.ratioRule?.satisfied)} \`${safe(signal.ratioRule?.text ?? '')}\``);
    lines.push(`  - ${mark(signal.absoluteRule?.satisfied)} \`${safe(signal.absoluteRule?.text ?? '')}\``);
  }
  lines.push('');
  if (report.triggeredRules.length > 0) {
    lines.push('Regras acionadas:');
    lines.push('');
    for (const rule of report.triggeredRules) lines.push(`- \`${safe(rule)}\``);
  } else {
    lines.push('_Nenhuma regra foi acionada._');
  }
  lines.push('');

  lines.push('## 6. Evidências dos logs');
  lines.push('');
  if (report.logExcerpts.length === 0) {
    lines.push('_Nenhum trecho de log foi coletado._');
  } else {
    for (const excerpt of report.logExcerpts) {
      lines.push(`- **${safe(excerpt.source)}**`);
      lines.push('');
      lines.push('  ```text');
      lines.push(`  ${safe(excerpt.excerpt)}`);
      lines.push('  ```');
    }
  }
  lines.push('');

  lines.push('## 7. Explicação');
  lines.push('');
  lines.push(`_Origem: **${safe(report.explanationSourceLabel)}**._`);
  lines.push('');
  lines.push(safe(report.explanation.summary));
  lines.push('');
  if (report.explanation.evidence.length > 0) {
    lines.push('Evidências citadas:');
    lines.push('');
    for (const item of report.explanation.evidence) lines.push(`- ${safe(item)}`);
    lines.push('');
  }
  lines.push('**Causa provável** _(hipótese, não fato observado)_:');
  lines.push('');
  lines.push(
    report.explanation.probableCause
      ? safe(report.explanation.probableCause)
      : '_Nenhuma causa a apontar._',
  );
  lines.push('');

  lines.push('## 8. Ações recomendadas');
  lines.push('');
  if (report.explanation.recommendedActions.length === 0) {
    lines.push('_Nenhuma ação recomendada._');
  } else {
    report.explanation.recommendedActions.forEach((action, index) =>
      lines.push(`${index + 1}. ${safe(action)}`),
    );
  }
  lines.push('');

  lines.push('## 9. Limitações');
  lines.push('');
  if (report.explanation.limitations.length === 0) {
    lines.push('_Nenhuma limitação declarada._');
  } else {
    for (const limitation of report.explanation.limitations) lines.push(`- ${safe(limitation)}`);
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(
    '> A detecção é **determinística**: `anomalyDetected`, `anomalyType`, `firstAnomalousSignal` e ' +
      '`gateResult` vêm das regras acima. A IA explica o resultado — não o decide.',
  );
  lines.push('');

  // Última barreira: só material de credencial. Ver o cabeçalho do módulo.
  return redactCredentialMaterial(lines.join('\n'));
}

/* ------------------------------------------------------------------------- */
/* HTML                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * HTML autônomo — sem CSS externo, sem script, sem fonte remota. É um arquivo
 * que o aluno abre com dois cliques e continua funcionando offline.
 *
 * @param {object} input
 * @returns {string}
 */
export function renderAnomalyHtml(input) {
  // Redação antes do escape, e sobre o objeto inteiro: `escapeHtml` impede que
  // um trecho de log vire markup, não que um segredo vire texto na tela. Quem
  // chamar este renderizador com um relatório não redigido continua protegido.
  const report = redactSecretsDeep(input);
  const detected = report.anomalyDetected;
  const badgeClass = detected ? 'badge badge-alert' : 'badge badge-ok';

  const signalRows = report.signals
    .map(
      (signal) =>
        `<tr>
          <td><code>${escapeHtml(signal.signal)}</code><br><small>${escapeHtml(signal.label ?? '')}</small></td>
          <td class="num">${escapeHtml(signal.baseline)}</td>
          <td class="num">${escapeHtml(signal.observed)}</td>
          <td class="num">${escapeHtml(signal.difference)}</td>
          <td class="num">${signal.ratio === null ? '—' : `${escapeHtml(signal.ratio)}x`}</td>
          <td class="center">${signal.triggered ? '🔴' : '—'}</td>
        </tr>`,
    )
    .join('\n');

  const ruleItems = report.signals
    .map((signal) => {
      const threshold = THRESHOLDS[signal.signal] ?? {};
      return `<li><code>${escapeHtml(signal.signal)}</code>
        <span class="muted">(limites: ${escapeHtml(threshold.ratio)}× e ${escapeHtml(threshold.absolute)} ${escapeHtml(threshold.unit ?? '')})</span>
        <ul>
          <li>${signal.ratioRule?.satisfied ? '✅' : '⬜'} <code>${escapeHtml(signal.ratioRule?.text ?? '')}</code></li>
          <li>${signal.absoluteRule?.satisfied ? '✅' : '⬜'} <code>${escapeHtml(signal.absoluteRule?.text ?? '')}</code></li>
        </ul>
      </li>`;
    })
    .join('\n');

  const excerpts = report.logExcerpts.length === 0
    ? '<p class="muted">Nenhum trecho de log foi coletado.</p>'
    : report.logExcerpts
        .map(
          (excerpt) =>
            `<figure><figcaption>${escapeHtml(excerpt.source)}</figcaption><pre>${escapeHtml(excerpt.excerpt)}</pre></figure>`,
        )
        .join('\n');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Detecção de anomalia — ${escapeHtml(report.route)}</title>
<style>
  :root { color-scheme: light dark; --line: #d8dee9; --muted: #5b6673; --ok: #1a7f45; --alert: #b3261e; }
  * { box-sizing: border-box; }
  body { margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 60rem; font: 16px/1.6 system-ui, sans-serif; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  h2 { font-size: 1.1rem; margin-top: 2.25rem; border-bottom: 1px solid var(--line); padding-bottom: .35rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0; }
  th, td { border: 1px solid var(--line); padding: .45rem .6rem; text-align: left; vertical-align: top; }
  th { background: rgba(127,127,127,.12); }
  td.num, th.num { text-align: right; }
  td.center { text-align: center; }
  pre { background: rgba(127,127,127,.12); padding: .7rem; overflow-x: auto; border-radius: 6px; }
  figure { margin: .75rem 0; }
  figcaption { font-size: .85rem; color: var(--muted); margin-bottom: .2rem; }
  .badge { display: inline-block; padding: .3rem .7rem; border-radius: 999px; font-weight: 600; color: #fff; }
  .badge-ok { background: var(--ok); }
  .badge-alert { background: var(--alert); }
  .muted { color: var(--muted); }
  .note { border-left: 3px solid var(--line); padding: .4rem .9rem; color: var(--muted); }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; margin: .4rem 0; }
  dt { color: var(--muted); }
</style>
</head>
<body>
<h1>🔎 Detecção de anomalia — Dia 2</h1>
<p class="muted">Rota <code>${escapeHtml(report.route)}</code> · cenário <code>${escapeHtml(report.scenario)}</code> · gerado em ${escapeHtml(report.generatedAt)}</p>

<h2>1. Resultado</h2>
<p><span class="${badgeClass}">${detected ? 'anomalia detectada' : 'dentro da baseline'}</span></p>
<dl>
  <dt><code>anomalyDetected</code></dt><dd><code>${escapeHtml(report.anomalyDetected)}</code></dd>
  <dt><code>anomalyType</code></dt><dd><code>${escapeHtml(report.anomalyType ?? 'null')}</code></dd>
  <dt><code>firstAnomalousSignal</code></dt><dd><code>${escapeHtml(report.firstAnomalousSignal ?? 'null')}</code></dd>
  <dt><code>gateResult</code></dt><dd><code>${escapeHtml(report.gateResult)}</code></dd>
</dl>

<h2>2. Sinal analisado</h2>
<p class="muted">Só estes dois decidem. O resto é contexto.</p>
<table>
  <thead><tr><th>Sinal</th><th class="num">Baseline</th><th class="num">Observado</th><th class="num">Diferença</th><th class="num">Razão</th><th>Disparou</th></tr></thead>
  <tbody>
${signalRows}
  </tbody>
</table>

<h2>3. Baseline</h2>
<dl>
  <dt>latência p95</dt><dd><strong>${escapeHtml(report.baseline.latencyP95Ms)} ms</strong></dd>
  <dt>linhas por requisição</dt><dd><strong>${escapeHtml(report.baseline.logLinesPerRequest)}</strong></dd>
  <dt>amostras</dt><dd>${escapeHtml(report.baseline.sampleCount ?? 'n/d')}</dd>
  <dt>medida em</dt><dd>${escapeHtml(report.baseline.createdAt ?? 'n/d')}</dd>
  <dt>commit</dt><dd><code>${escapeHtml(report.baseline.commitSha ?? 'n/d')}</code></dd>
</dl>

<h2>4. Valor observado</h2>
<dl>
  <dt>latência p95</dt><dd><strong>${escapeHtml(report.observed.latencyP95Ms)} ms</strong></dd>
  <dt>linhas por requisição</dt><dd><strong>${escapeHtml(report.observed.logLinesPerRequest)}</strong></dd>
  <dt>amostras</dt><dd>${escapeHtml(report.observed.sampleCount ?? 'n/d')}</dd>
</dl>
<p class="muted">Contexto (não decide nada):</p>
<dl>
${Object.entries(report.observed.context ?? {})
  .map(([key, value]) => `  <dt><code>${escapeHtml(key)}</code></dt><dd>${escapeHtml(formatValue(value))}</dd>`)
  .join('\n')}
</dl>

<h2>5. Regra aplicada</h2>
<p class="muted">Cada sinal só dispara com as <strong>duas</strong> condições ao mesmo tempo.</p>
<ul>
${ruleItems}
</ul>

<h2>6. Evidências dos logs</h2>
${excerpts}

<h2>7. Explicação</h2>
<p class="muted">Origem: <strong>${escapeHtml(report.explanationSourceLabel)}</strong></p>
<p>${escapeHtml(report.explanation.summary)}</p>
${listOrNote(report.explanation.evidence, 'Nenhuma evidência citada.')}
<p><strong>Causa provável</strong> <span class="muted">(hipótese, não fato observado)</span></p>
<p>${report.explanation.probableCause ? escapeHtml(report.explanation.probableCause) : '<span class="muted">Nenhuma causa a apontar.</span>'}</p>

<h2>8. Ações recomendadas</h2>
${report.explanation.recommendedActions.length === 0
    ? '<p class="muted">Nenhuma ação recomendada.</p>'
    : `<ol>${report.explanation.recommendedActions.map((action) => `<li>${escapeHtml(action)}</li>`).join('')}</ol>`}

<h2>9. Limitações</h2>
${listOrNote(report.explanation.limitations, 'Nenhuma limitação declarada.')}

<p class="note">A detecção é <strong>determinística</strong>: <code>anomalyDetected</code>, <code>anomalyType</code>,
<code>firstAnomalousSignal</code> e <code>gateResult</code> vêm das regras acima. A IA explica o resultado — não o decide.</p>
</body>
</html>
`;
}

/* ------------------------------------------------------------------------- */
/* Escrita                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Grava `anomaly-report.json`, `.md` e `.html`.
 *
 * @param {object} input
 * @param {object} input.report
 * @param {string} input.outDir
 * @returns {{ paths: string[], markdown: string, html: string }}
 */
export function writeAnomalyReports({ report, outDir }) {
  mkdirSync(outDir, { recursive: true });

  const markdown = renderAnomalyMarkdown(report);
  const html = renderAnomalyHtml(report);

  const jsonPath = join(outDir, `${REPORT_BASENAME}.json`);
  const markdownPath = join(outDir, `${REPORT_BASENAME}.md`);
  const htmlPath = join(outDir, `${REPORT_BASENAME}.html`);

  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, markdown, 'utf8');
  writeFileSync(htmlPath, html, 'utf8');

  return { paths: [jsonPath, markdownPath, htmlPath], markdown, html };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

/** Redação completa de um campo não confiável, na hora de inseri-lo. */
function safe(value) {
  return redactSecrets(String(value ?? ''));
}

function mark(satisfied) {
  return satisfied ? '✅' : '⬜';
}

function formatValue(value) {
  if (value === null || value === undefined) return 'n/d';
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => `${key}=${entry}`)
      .join(', ');
  }
  return String(value);
}

function listOrNote(items, emptyNote) {
  if (!items || items.length === 0) return `<p class="muted">${escapeHtml(emptyNote)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}
