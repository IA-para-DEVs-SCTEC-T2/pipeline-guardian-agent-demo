/**
 * Dia 3 — os painéis. JSON, Markdown e HTML autônomo.
 *
 * O HTML segue a mesma linha do relatório operacional do Dia 1 e pelos mesmos
 * motivos:
 *
 * - **Autônomo.** Sem CDN, sem biblioteca de gráficos, sem fonte externa. Os
 *   gráficos são SVG escrito à mão: um `<polyline>` e alguns `<circle>` fazem
 *   uma série temporal de dez pontos, e o arquivo continua abrindo offline,
 *   num notebook emprestado, no meio da aula.
 * - **Nunca só cor.** Cada faixa de risco tem cor, ícone (●, ▲, ■) e texto. Um
 *   relatório impresso em preto e branco continua legível.
 * - **Tudo escapado.** Texto de modelo é conteúdo não confiável, mesmo quando o
 *   schema o validou: schema garante forma, não intenção. Ver `html-escape.mjs`.
 *
 * E uma decisão que é de conteúdo, não de layout: **fato, interpretação,
 * hipótese e causa confirmada aparecem rotulados**, com a última sempre
 * declarada como ausente. Num laboratório preditivo é fácil ler uma
 * probabilidade alta como diagnóstico; o painel existe em parte para impedir
 * essa leitura.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { escapeHtml } from '../html-escape.mjs';
import { redactCredentialMaterial } from '../redact-secrets.mjs';
import { RISK_BANDS } from './evaluate.mjs';
import { BASELINE, FEATURE_LABELS, FEATURE_NAMES, HORIZON_WINDOWS, TARGET_NAME } from './features.mjs';

/** Rótulo de cada faixa, na ordem do menor risco para o maior. */
const BAND_LABELS = Object.fromEntries(RISK_BANDS.map((band) => [band.id, band.label]));
const BAND_ICONS = Object.fromEntries(RISK_BANDS.map((band) => [band.id, band.icon]));

const OUTCOME_LABELS = Object.freeze({
  true_positive: 'Verdadeiro positivo (TP) — o modelo previu falha e a falha veio',
  false_positive: 'Falso positivo (FP) — o modelo previu falha que não veio',
  true_negative: 'Verdadeiro negativo (TN) — o modelo não previu falha e não houve falha',
  false_negative: 'Falso negativo (FN) — o modelo não previu a falha que veio',
});

const CHART = Object.freeze({ width: 720, height: 178, left: 58, right: 18, top: 20, bottom: 42 });

/* ------------------------------------------------------------------------- */
/* Escrita                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Grava os três formatos de um relatório de previsão.
 *
 * @param {object} input
 * @param {object} input.report validado por `predictionReportSchema`
 * @param {string} input.outDir
 * @returns {{ json: string, markdown: string, html: string }}
 */
export function writePredictionReports({ report, outDir }) {
  const paths = {
    json: join(outDir, 'prediction.json'),
    markdown: join(outDir, 'prediction-report.md'),
    html: join(outDir, 'prediction-report.html'),
  };

  writeFile(paths.json, `${JSON.stringify(report, null, 2)}\n`);
  writeFile(paths.markdown, renderPredictionMarkdown(report));
  writeFile(paths.html, renderPredictionHtml(report));

  return paths;
}

/**
 * Grava os artefatos do treino.
 *
 * @param {object} input
 * @param {object} input.summary
 * @param {object} input.model modelo serializado
 * @param {string} input.outDir
 * @returns {{ summary: string, model: string, evaluation: string }}
 */
export function writeTrainingArtifacts({ summary, model, outDir }) {
  const paths = {
    summary: join(outDir, 'training-summary.json'),
    model: join(outDir, 'model.json'),
    evaluation: join(outDir, 'model-evaluation.html'),
  };

  writeFile(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);
  writeFile(paths.model, `${JSON.stringify(model, null, 2)}\n`);
  writeFile(paths.evaluation, renderModelEvaluationHtml(summary));

  return paths;
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/* ------------------------------------------------------------------------- */
/* Markdown                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} report
 * @returns {string}
 */
export function renderPredictionMarkdown(report) {
  const current = report.predictions[report.currentWindowIndex];
  const lines = [];

  lines.push(`# ${report.title}`, '', report.description, '');
  lines.push(
    `- **Alvo:** \`${report.target}\` (falha nas próximas ${report.predictionHorizonWindows} janelas)`,
    `- **Probabilidade na janela ${report.currentWindowIndex}:** ${percent(report.failureProbability)}`,
    `- **Limiar de decisão:** ${percent(report.threshold)}`,
    `- **Faixa:** ${BAND_ICONS[report.riskBand]} ${BAND_LABELS[report.riskBand]}`,
    `- **Previsão do modelo:** ${report.predictedFailure ? 'falha provável' : 'sem falha prevista'}`,
    `- **Primeira janela acima do limiar:** ${report.firstPredictedFailureWindow ?? 'nenhuma'}`,
    `- **Origem da explicação:** ${report.explanation.origin === 'openai' ? 'OpenAI (saída validada por schema)' : 'fallback determinístico'}`,
    '',
  );

  lines.push('## Janelas observadas', '');
  lines.push('| Janela | Latência p95 (ms) | Taxa de erro | Logs/req | Degradadas seguidas | Probabilidade | Faixa |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | :--- |');
  for (const entry of report.predictions) {
    lines.push(
      `| ${entry.windowIndex} | ${entry.window.latencyP95Ms} | ${entry.window.errorRate} | ` +
        `${entry.window.logLinesPerRequest} | ${entry.features.consecutiveDegradedWindows} | ` +
        `${percent(entry.failureProbability)} | ${BAND_ICONS[entry.riskBand]} ${BAND_LABELS[entry.riskBand]} |`,
    );
  }
  lines.push('');

  lines.push(`## Fatores de risco na janela ${report.currentWindowIndex}`, '');
  lines.push('| Feature | Valor | Peso | Valor padronizado | Contribuição |');
  lines.push('| :--- | ---: | ---: | ---: | ---: |');
  for (const factor of current.topFactors) {
    lines.push(
      `| \`${factor.feature}\` | ${round(factor.rawValue)} | ${round(factor.weight)} | ` +
        `${round(factor.standardizedValue)} | ${signed(factor.contribution)} |`,
    );
  }
  lines.push('', '> Contribuição = `peso × valor padronizado`. É uma aproximação linear no logit, não uma fatia da probabilidade.', '');

  if (report.outcome.revealed) {
    lines.push('## Desfecho', '');
    lines.push(
      `- **Houve falha no horizonte:** ${report.outcome.actualFailure ? 'sim' : 'não'}`,
      `- **Primeira janela em falha:** ${report.outcome.firstActualFailureWindow ?? 'nenhuma'}`,
      `- **Primeira janela com probabilidade ≥ ${percent(report.threshold)}:** ${report.firstPredictedFailureWindow ?? 'nenhuma'}`,
      `- **Antecedência do modelo:** ${formatLead(report.outcome.leadTimeWindows)}`,
      `- **Resultado no ponto de decisão:** ${report.outcome.decisionOutcome ? OUTCOME_LABELS[report.outcome.decisionOutcome] : 'não aplicável'}`,
      '',
    );
  }

  if (report.mitigation) {
    lines.push('## Mitigação simulada', '');
    lines.push(
      `- **Janela de intervenção:** ${report.mitigation.interventionWindowIndex}`,
      `- **Decaimento por janela:** ${report.mitigation.decayPerWindow}`,
      `- **Probabilidade na última janela:** ${percent(report.mitigation.baselineProbability)} → ${percent(report.mitigation.mitigatedProbability)}`,
      `- **Pico de probabilidade:** ${percent(report.mitigation.baselineMaxProbability)} → ${percent(report.mitigation.mitigatedMaxProbability)}`,
      '',
    );
  }

  lines.push('## Explicação', '');
  lines.push(`**[RESUMO]** ${report.explanation.summary}`, '');
  lines.push('**[FATOS]**', '');
  report.explanation.evidence.forEach((item) => lines.push(`- ${item}`));
  lines.push('', '**[INTERPRETAÇÃO]**', '', report.explanation.interpretation, '');
  lines.push('**[CAUSA CONFIRMADA]**', '', 'Nenhuma. Este laboratório observa correlação entre séries de métricas; ele não instrumenta código nem infraestrutura.', '');
  lines.push('**[RECOMENDAÇÕES]**', '');
  report.explanation.recommendedActions.forEach((item) => lines.push(`- ${item}`));
  lines.push('', '**[LIMITAÇÕES]**', '');
  report.explanation.limitations.forEach((item) => lines.push(`- ${item}`));
  report.limitations.forEach((item) => lines.push(`- ${item}`));
  lines.push('');

  lines.push('## Avaliação do modelo (conjunto de teste)', '');
  lines.push(
    `- Acurácia: ${percent(report.modelMetrics.accuracy)}`,
    `- Precisão: ${percent(report.modelMetrics.precision)}`,
    `- Recall: ${percent(report.modelMetrics.recall)}`,
    `- F1: ${percent(report.modelMetrics.f1Score)}`,
    `- Exemplos: ${report.modelMetrics.examples} (${report.modelMetrics.positiveExamples} positivos, ${report.modelMetrics.negativeExamples} negativos)`,
    '',
    `_Gerado em ${report.generatedAt}. Baseline do laboratório: ${report.baseline.latencyP95Ms} ms, ` +
      `erro ${report.baseline.errorRate}, ${report.baseline.logLinesPerRequest} linhas de log por requisição._`,
    '',
  );

  // Última barreira, com as regras que só reconhecem material de credencial:
  // aplicar `chave: valor` sobre um Markdown pronto mascararia rótulos nossos.
  return redactCredentialMaterial(lines.join('\n'));
}

/* ------------------------------------------------------------------------- */
/* HTML — painel de previsão                                                   */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} report
 * @returns {string} documento HTML completo e autônomo
 */
export function renderPredictionHtml(report) {
  const current = report.predictions[report.currentWindowIndex];
  const probabilities = report.predictions.map((entry) => entry.failureProbability);
  const indexes = report.predictions.map((entry) => entry.windowIndex);

  const markers = [];
  if (report.firstPredictedFailureWindow !== null) {
    markers.push({ index: report.firstPredictedFailureWindow, label: '1º alerta', kind: 'alert' });
  }
  if (report.outcome.revealed && report.outcome.firstActualFailureWindow !== null) {
    markers.push({ index: report.outcome.firstActualFailureWindow, label: 'falha real', kind: 'failure' });
  }

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(report.title)} — previsão de falha (Dia 3)</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#conteudo">Pular para o conteúdo</a>

<header class="hero band-${escapeHtml(report.riskBand)}">
  <p class="eyebrow">Laboratório preditivo · Dia 3 · dados sintéticos</p>
  <h1>${escapeHtml(report.title)}</h1>
  <p class="lead">${escapeHtml(report.description)}</p>

  <div class="gauge">
    <p class="probability"><span class="probability-value">${percent(report.failureProbability)}</span>
      <span class="probability-label">de probabilidade de falha nas próximas ${report.predictionHorizonWindows} janelas</span></p>
    ${renderGauge(report.failureProbability, report.threshold)}
    <p class="band"><span class="band-icon" aria-hidden="true">${BAND_ICONS[report.riskBand]}</span>
      <strong>${escapeHtml(BAND_LABELS[report.riskBand])}</strong>
      — limiar de decisão: ${percent(report.threshold)}</p>
    <p class="verdict">Previsão do modelo na janela ${report.currentWindowIndex}:
      <strong>${report.predictedFailure ? 'falha provável' : 'sem falha prevista'}</strong></p>
  </div>

  <dl class="meta">
    ${metaItem('Alvo', report.target)}
    ${metaItem('Horizonte', `${report.predictionHorizonWindows} janelas`)}
    ${metaItem('Janela atual', String(report.currentWindowIndex))}
    ${metaItem('1ª janela acima do limiar', report.firstPredictedFailureWindow === null ? 'nenhuma' : String(report.firstPredictedFailureWindow))}
    ${metaItem('Origem da explicação', report.explanation.origin === 'openai' ? 'OpenAI (saída validada por schema)' : 'fallback determinístico (sem modelo)')}
    ${metaItem('Gerado em', report.generatedAt)}
  </dl>
</header>

<main id="conteudo">

<section aria-labelledby="linha-do-tempo">
  <h2 id="linha-do-tempo">Linha temporal</h2>
  <p class="hint">Quatro séries sobre o mesmo eixo de janelas. As marcações verticais indicam o primeiro alarme do modelo${
    report.outcome.revealed ? ' e a primeira falha real' : ' — o desfecho só é marcado depois da revelação'
  }.</p>

  ${chart({
    id: 'prob',
    title: 'Probabilidade de falha por janela',
    values: probabilities,
    indexes,
    max: 1,
    threshold: report.threshold,
    thresholdLabel: `limiar ${percent(report.threshold)}`,
    markers,
    format: (value) => percent(value),
    bands: report.predictions.map((entry) => entry.riskBand),
  })}

  ${chart({
    id: 'lat',
    title: 'Latência p95 (ms)',
    values: report.predictions.map((entry) => entry.window.latencyP95Ms),
    indexes,
    threshold: 1500,
    thresholdLabel: 'limite de falha: 1500 ms',
    markers,
    format: (value) => `${value} ms`,
  })}

  ${chart({
    id: 'err',
    title: 'Taxa de erro',
    values: report.predictions.map((entry) => entry.window.errorRate),
    indexes,
    threshold: 0.5,
    thresholdLabel: 'limite de falha: 0,50',
    markers,
    format: (value) => value.toFixed(2),
  })}

  ${chart({
    id: 'log',
    title: 'Linhas de log por requisição',
    values: report.predictions.map((entry) => entry.window.logLinesPerRequest),
    indexes,
    threshold: null,
    markers,
    format: (value) => String(value),
  })}
</section>

${renderOutcomeSection(report)}

${renderMitigationSection(report)}

<section aria-labelledby="fatores">
  <h2 id="fatores">Fatores de risco na janela ${report.currentWindowIndex}</h2>
  <p class="hint">Contribuição = <code>peso × valor padronizado</code>. É uma aproximação linear no logit: as contribuições somam o <code>z</code>, não a probabilidade.</p>
  <ul class="factors">
    ${current.topFactors.map(renderFactor).join('\n    ')}
  </ul>
</section>

<section aria-labelledby="janelas">
  <h2 id="janelas">Janelas analisadas</h2>
  <div class="scroll">
  <table>
    <caption>Cada linha é uma janela de observação. A probabilidade usa apenas passado e presente.</caption>
    <thead><tr>
      <th scope="col">Janela</th><th scope="col">Latência p95</th><th scope="col">Taxa de erro</th>
      <th scope="col">Logs/req</th><th scope="col">Degradadas seguidas</th>
      <th scope="col">Probabilidade</th><th scope="col">Faixa</th>${
        report.outcome.revealed ? '<th scope="col">Falha no horizonte</th>' : ''
      }
    </tr></thead>
    <tbody>
      ${report.predictions.map((entry) => renderWindowRow(entry, report)).join('\n      ')}
    </tbody>
  </table>
  </div>
</section>

<section aria-labelledby="explicacao" class="explanation">
  <h2 id="explicacao">Explicação</h2>
  <p class="origin">${
    report.explanation.origin === 'openai'
      ? 'Texto gerado por modelo de linguagem, com a saída validada por schema. Os números não passaram por ele.'
      : 'Texto gerado pelo fallback determinístico, a partir dos mesmos números. Nenhuma chamada de rede foi feita.'
  }</p>

  <h3><span class="tag tag-summary">resumo</span></h3>
  <p class="summary">${escapeHtml(report.explanation.summary)}</p>

  <h3><span class="tag tag-fact">fatos observados</span></h3>
  <ul class="facts">${report.explanation.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>

  <h3><span class="tag tag-inference">interpretação e hipóteses</span></h3>
  <p>${escapeHtml(report.explanation.interpretation)}</p>

  <h3><span class="tag tag-cause">causa confirmada</span></h3>
  <p class="callout callout-info"><strong>Nenhuma.</strong> Este laboratório observa correlação entre séries de métricas. Ele não instrumenta código, configuração nem infraestrutura, e por isso nenhuma afirmação aqui é causa comprovada.</p>

  <h3><span class="tag tag-action">recomendações</span></h3>
  <ol class="actions">${report.explanation.recommendedActions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>

  <h3><span class="tag tag-limit">limitações</span></h3>
  <ul class="limitations">${[...report.explanation.limitations, ...report.limitations]
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('')}</ul>
</section>

<section aria-labelledby="modelo">
  <h2 id="modelo">Avaliação do modelo (conjunto de teste)</h2>
  <ul class="metrics">
    ${metricCard('Acurácia', percent(report.modelMetrics.accuracy))}
    ${metricCard('Precisão', percent(report.modelMetrics.precision))}
    ${metricCard('Recall', percent(report.modelMetrics.recall))}
    ${metricCard('F1', percent(report.modelMetrics.f1Score))}
  </ul>
  <p class="hint">${report.modelMetrics.examples} exemplos no teste — ${report.modelMetrics.positiveExamples} positivos e ${report.modelMetrics.negativeExamples} negativos. Recall abaixo de 100% quer dizer que existem falhas que este modelo não antecipa.</p>
</section>

</main>

<footer>
  <p><strong>Dados sintéticos.</strong> As sequências deste laboratório são geradas por um gerador determinístico com semente fixa. Nenhum número aqui foi medido em um sistema real.</p>
  <p>Baseline do laboratório: latência p95 ${report.baseline.latencyP95Ms} ms · taxa de erro ${report.baseline.errorRate} · ${report.baseline.logLinesPerRequest} linhas de log por requisição.</p>
  <p>A probabilidade, o limiar e os fatores de risco são calculados pela regressão logística. A IA generativa escreve apenas o texto explicativo.</p>
</footer>
</body>
</html>
`;
}

function renderOutcomeSection(report) {
  if (!report.outcome.revealed) {
    return `<section aria-labelledby="desfecho">
  <h2 id="desfecho">Desfecho</h2>
  <p class="callout callout-warn"><strong>Ainda não revelado.</strong> Este relatório mostra a sequência até a janela de decisão e a previsão do modelo. O que aconteceu depois só aparece com <code>npm run day3:challenge:reveal -- ${escapeHtml(report.id)}</code>.</p>
</section>`;
  }

  const outcome = report.outcome;
  return `<section aria-labelledby="desfecho">
  <h2 id="desfecho">Desfecho</h2>
  <dl class="meta">
    ${metaItem('Houve falha no horizonte', outcome.actualFailure ? 'sim' : 'não')}
    ${metaItem('Primeira janela em falha', outcome.firstActualFailureWindow === null ? 'nenhuma' : String(outcome.firstActualFailureWindow))}
    ${metaItem(`Primeira janela ≥ ${percent(report.threshold)}`, report.firstPredictedFailureWindow === null ? 'nenhuma' : String(report.firstPredictedFailureWindow))}
    ${metaItem('Antecedência do modelo', formatLead(outcome.leadTimeWindows))}
  </dl>
  <p class="outcome outcome-${escapeHtml(outcome.decisionOutcome ?? 'none')}">
    <strong>No ponto de decisão:</strong> ${escapeHtml(outcome.decisionOutcome ? OUTCOME_LABELS[outcome.decisionOutcome] : 'não aplicável — a janela de decisão não tem horizonte completo')}
  </p>
</section>`;
}

function renderMitigationSection(report) {
  if (!report.mitigation) return '';

  const mitigation = report.mitigation;
  const indexes = mitigation.comparison.map((row) => row.windowIndex);

  return `<section aria-labelledby="mitigacao">
  <h2 id="mitigacao">Mitigação simulada</h2>
  <p class="hint">A partir da janela ${mitigation.interventionWindowIndex}, cada métrica decai em direção à baseline (fator ${mitigation.decayPerWindow} por janela). As features são recalculadas do zero e o modelo é consultado de novo — nenhuma probabilidade foi ajustada à mão.</p>

  <ul class="metrics">
    ${metricCard('Probabilidade final (original)', percent(mitigation.baselineProbability))}
    ${metricCard('Probabilidade final (mitigada)', percent(mitigation.mitigatedProbability))}
    ${metricCard('Pico original', percent(mitigation.baselineMaxProbability))}
    ${metricCard('Pico mitigado', percent(mitigation.mitigatedMaxProbability))}
  </ul>

  ${chart({
    id: 'mit-prob',
    title: 'Probabilidade — original × mitigada',
    values: mitigation.comparison.map((row) => row.baselineProbability),
    secondValues: mitigation.comparison.map((row) => row.mitigatedProbability),
    seriesLabels: ['original', 'mitigada'],
    indexes,
    max: 1,
    threshold: report.threshold,
    thresholdLabel: `limiar ${percent(report.threshold)}`,
    markers: [{ index: mitigation.interventionWindowIndex, label: 'intervenção', kind: 'alert' }],
    format: (value) => percent(value),
  })}

  ${chart({
    id: 'mit-lat',
    title: 'Latência p95 (ms) — original × mitigada',
    values: mitigation.comparison.map((row) => row.baselineLatencyP95Ms),
    secondValues: mitigation.comparison.map((row) => row.mitigatedLatencyP95Ms),
    seriesLabels: ['original', 'mitigada'],
    indexes,
    threshold: 1500,
    thresholdLabel: 'limite de falha: 1500 ms',
    markers: [{ index: mitigation.interventionWindowIndex, label: 'intervenção', kind: 'alert' }],
    format: (value) => `${value} ms`,
  })}

  <div class="scroll">
  <table>
    <caption>Comparação janela a janela. As colunas "mitigada" só divergem depois da janela de intervenção.</caption>
    <thead><tr>
      <th scope="col">Janela</th>
      <th scope="col">Latência orig.</th><th scope="col">Latência mit.</th>
      <th scope="col">Erro orig.</th><th scope="col">Erro mit.</th>
      <th scope="col">Logs orig.</th><th scope="col">Logs mit.</th>
      <th scope="col">Prob. orig.</th><th scope="col">Prob. mit.</th>
    </tr></thead>
    <tbody>
      ${mitigation.comparison
        .map(
          (row) => `<tr><th scope="row">${row.windowIndex}</th>` +
            `<td>${row.baselineLatencyP95Ms}</td><td>${row.mitigatedLatencyP95Ms}</td>` +
            `<td>${row.baselineErrorRate}</td><td>${row.mitigatedErrorRate}</td>` +
            `<td>${row.baselineLogLinesPerRequest}</td><td>${row.mitigatedLogLinesPerRequest}</td>` +
            `<td>${percent(row.baselineProbability)}</td><td>${percent(row.mitigatedProbability)}</td></tr>`,
        )
        .join('\n      ')}
    </tbody>
  </table>
  </div>
</section>`;
}

function renderWindowRow(entry, report) {
  const flags = [];
  if (entry.windowIndex === report.currentWindowIndex) flags.push('janela atual');
  if (entry.windowIndex === report.firstPredictedFailureWindow) flags.push('1º alerta');
  if (report.outcome.revealed && entry.isFailureWindow) flags.push('janela em falha');

  return `<tr class="band-row-${escapeHtml(entry.riskBand)}">
        <th scope="row">${entry.windowIndex}${flags.length > 0 ? ` <span class="flag">${escapeHtml(flags.join(' · '))}</span>` : ''}</th>
        <td>${entry.window.latencyP95Ms} ms</td>
        <td>${entry.window.errorRate}</td>
        <td>${entry.window.logLinesPerRequest}</td>
        <td>${entry.features.consecutiveDegradedWindows}</td>
        <td><strong>${percent(entry.failureProbability)}</strong></td>
        <td><span class="band-icon" aria-hidden="true">${BAND_ICONS[entry.riskBand]}</span> ${escapeHtml(BAND_LABELS[entry.riskBand])}</td>
        ${
          report.outcome.revealed
            ? `<td>${entry.actualFailureWithinHorizon === null ? 'horizonte incompleto' : entry.actualFailureWithinHorizon ? 'sim' : 'não'}</td>`
            : ''
        }
      </tr>`;
}

function renderFactor(factor) {
  const width = Math.min(100, Math.abs(factor.contribution) * 40);
  return `<li class="factor factor-${escapeHtml(factor.direction)}">
      <p class="factor-head"><code>${escapeHtml(factor.feature)}</code>
        <span class="factor-arrow" aria-hidden="true">${factor.direction === 'increases' ? '▲' : '▼'}</span>
        <span class="factor-direction">${factor.direction === 'increases' ? 'aumenta o risco' : 'reduz o risco'}</span></p>
      <p class="factor-meaning">${escapeHtml(FEATURE_LABELS[factor.feature] ?? factor.feature)}</p>
      <p class="factor-numbers">valor <strong>${round(factor.rawValue)}</strong> ·
        padronizado <strong>${round(factor.standardizedValue)}</strong> ·
        peso <strong>${round(factor.weight)}</strong> ·
        contribuição <strong>${signed(factor.contribution)}</strong></p>
      <div class="bar" role="presentation"><span style="width:${width.toFixed(1)}%"></span></div>
    </li>`;
}

/* ------------------------------------------------------------------------- */
/* HTML — painel de avaliação do modelo                                        */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} summary `training-summary.json`
 * @returns {string}
 */
export function renderModelEvaluationHtml(summary) {
  const matrix = summary.evaluation.test.confusionMatrix;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Avaliação do modelo preditivo — Dia 3</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#conteudo">Pular para o conteúdo</a>

<header class="hero">
  <p class="eyebrow">Laboratório preditivo · Dia 3</p>
  <h1>Avaliação do modelo</h1>
  <p class="lead">Regressão logística treinada sobre janelas de métricas sintéticas para prever falha nas próximas ${summary.target.horizonWindows} janelas.</p>
  <p class="callout callout-warn"><strong>Dados sintéticos.</strong> As ${summary.sequences.total} sequências vêm de um gerador determinístico com semente <code>${escapeHtml(String(summary.seed))}</code>. As métricas abaixo medem o modelo neste laboratório — não a confiabilidade de uma previsão sobre um sistema real.</p>
</header>

<main id="conteudo">

<section aria-labelledby="alvo">
  <h2 id="alvo">Alvo e horizonte</h2>
  <dl class="meta">
    ${metaItem('Alvo', summary.target.name)}
    ${metaItem('Horizonte', `${summary.target.horizonWindows} janelas`)}
    ${metaItem('Limiar de decisão', percent(summary.threshold))}
    ${metaItem('Baseline — latência p95', `${summary.baseline.latencyP95Ms} ms`)}
    ${metaItem('Baseline — taxa de erro', String(summary.baseline.errorRate))}
    ${metaItem('Baseline — logs por requisição', String(summary.baseline.logLinesPerRequest))}
  </dl>
  <p class="hint">Uma janela é <strong>falha</strong> quando <code>errorRate ≥ ${summary.target.failureThresholds.errorRate}</code>, <code>latencyP95Ms ≥ ${summary.target.failureThresholds.latencyP95Ms}</code> ou <code>healthFailure = true</code>. O rótulo de uma janela olha <strong>apenas</strong> as ${summary.target.horizonWindows} janelas seguintes.</p>
</section>

<section aria-labelledby="divisao">
  <h2 id="divisao">Divisão treino/teste</h2>
  <ul class="metrics">
    ${metricCard('Sequências de treino', String(summary.sequences.train))}
    ${metricCard('Sequências de teste', String(summary.sequences.test))}
    ${metricCard('Exemplos de treino', String(summary.evaluation.train.examples))}
    ${metricCard('Exemplos de teste', String(summary.evaluation.test.examples))}
  </ul>
  <p class="hint">${escapeHtml(summary.split.strategy)}</p>
  <details>
    <summary>Identificadores das sequências de teste (${summary.sequences.testIds.length})</summary>
    <p class="ids">${summary.sequences.testIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(' ')}</p>
  </details>
  <details>
    <summary>Identificadores das sequências de treino (${summary.sequences.trainIds.length})</summary>
    <p class="ids">${summary.sequences.trainIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(' ')}</p>
  </details>
</section>

<section aria-labelledby="metricas">
  <h2 id="metricas">Métricas no conjunto de teste</h2>
  <ul class="metrics">
    ${metricCard('Acurácia', percent(summary.evaluation.test.accuracy))}
    ${metricCard('Precisão', percent(summary.evaluation.test.precision))}
    ${metricCard('Recall', percent(summary.evaluation.test.recall))}
    ${metricCard('F1', percent(summary.evaluation.test.f1Score))}
  </ul>

  <div class="scroll">
  <table class="matrix">
    <caption>Matriz de confusão no limiar de ${percent(summary.threshold)}.</caption>
    <thead><tr><th scope="col"></th><th scope="col">Falhou (real)</th><th scope="col">Não falhou (real)</th></tr></thead>
    <tbody>
      <tr><th scope="row">Previsto: falha</th>
        <td class="cell-ok"><strong>${matrix.truePositives}</strong><span>TP</span></td>
        <td class="cell-bad"><strong>${matrix.falsePositives}</strong><span>FP</span></td></tr>
      <tr><th scope="row">Previsto: sem falha</th>
        <td class="cell-bad"><strong>${matrix.falseNegatives}</strong><span>FN</span></td>
        <td class="cell-ok"><strong>${matrix.trueNegatives}</strong><span>TN</span></td></tr>
    </tbody>
  </table>
  </div>
  <p class="hint">${summary.evaluation.test.examples} exemplos: ${summary.evaluation.test.positiveExamples} positivos e ${summary.evaluation.test.negativeExamples} negativos.</p>
</section>

<section aria-labelledby="distribuicao">
  <h2 id="distribuicao">Distribuição das probabilidades por classe real</h2>
  <p class="hint">Um positivo previsto com 72% e outro com 99% contam igual na matriz de confusão, e não significam a mesma coisa. É isto que o histograma mostra.</p>
  ${renderDistribution(summary.evaluation.test.distribution, summary.threshold)}
</section>

<section aria-labelledby="pesos">
  <h2 id="pesos">Pesos do modelo (espaço padronizado)</h2>
  <p class="hint">Os pesos se aplicam a valores padronizados, então são comparáveis entre si. Peso positivo empurra o risco para cima.</p>
  <div class="scroll">
  <table>
    <thead><tr><th scope="col">Feature</th><th scope="col">Significado</th><th scope="col">Peso</th><th scope="col">Média (treino)</th><th scope="col">Desvio (treino)</th></tr></thead>
    <tbody>
      ${summary.weights
        .map(
          (entry, index) => `<tr>
        <th scope="row"><code>${escapeHtml(entry.feature)}</code></th>
        <td>${escapeHtml(FEATURE_LABELS[entry.feature] ?? '')}</td>
        <td><strong>${signed(entry.weight)}</strong></td>
        <td>${round(summary.scaler.mean[index])}</td>
        <td>${round(summary.scaler.std[index])}</td>
      </tr>`,
        )
        .join('\n      ')}
      <tr><th scope="row"><code>bias</code></th><td>Deslocamento do logit (a taxa-base do conjunto)</td><td><strong>${signed(summary.bias)}</strong></td><td>—</td><td>—</td></tr>
    </tbody>
  </table>
  </div>
</section>

<section aria-labelledby="features">
  <h2 id="features">Features usadas</h2>
  <ol class="features">
    ${FEATURE_NAMES.map((name) => `<li><code>${escapeHtml(name)}</code> — ${escapeHtml(FEATURE_LABELS[name])}</li>`).join('\n    ')}
  </ol>
  <p class="hint">Nenhuma feature olha o futuro, e o padrão que gerou a sequência nunca entra como feature.</p>
</section>

<section aria-labelledby="treino">
  <h2 id="treino">Treino</h2>
  <dl class="meta">
    ${metaItem('Taxa de aprendizado', String(summary.hyperparameters.learningRate))}
    ${metaItem('Iterações máximas', String(summary.hyperparameters.maxIterations))}
    ${metaItem('Regularização L2', String(summary.hyperparameters.lambda))}
    ${metaItem('Inicialização', String(summary.hyperparameters.initialization))}
    ${metaItem('Iterações executadas', String(summary.training.iterations))}
    ${metaItem('Loss inicial → final', `${round(summary.training.initialLoss)} → ${round(summary.training.finalLoss)}`)}
  </dl>
</section>

<section aria-labelledby="limitacoes">
  <h2 id="limitacoes">Limitações</h2>
  <ul class="limitations">${summary.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
</section>

</main>

<footer>
  <p>Gerado em ${escapeHtml(summary.generatedAt)} · semente <code>${escapeHtml(String(summary.seed))}</code> · alvo <code>${escapeHtml(summary.target.name)}</code>.</p>
  <p>Reproduzir: <code>npm run day3:prepare</code>. A mesma semente produz o mesmo modelo.</p>
</footer>
</body>
</html>
`;
}

function renderDistribution(bins, threshold) {
  const max = Math.max(1, ...bins.map((bin) => Math.max(bin.positives, bin.negatives)));
  const rows = bins
    .map((bin) => {
      const above = bin.from >= threshold;
      return `<tr class="${above ? 'bin-above' : ''}">
        <th scope="row">${bin.from.toFixed(1)}–${bin.to.toFixed(1)}${above ? ' <span class="flag">≥ limiar</span>' : ''}</th>
        <td><div class="bar bar-pos" role="presentation"><span style="width:${((bin.positives / max) * 100).toFixed(1)}%"></span></div> ${bin.positives}</td>
        <td><div class="bar bar-neg" role="presentation"><span style="width:${((bin.negatives / max) * 100).toFixed(1)}%"></span></div> ${bin.negatives}</td>
      </tr>`;
    })
    .join('\n      ');

  return `<div class="scroll"><table>
    <thead><tr><th scope="col">Faixa de probabilidade</th><th scope="col">Falharam (positivos)</th><th scope="col">Não falharam (negativos)</th></tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table></div>`;
}

/* ------------------------------------------------------------------------- */
/* SVG                                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Um gráfico de linha em SVG inline.
 *
 * Sem biblioteca: uma `<polyline>`, alguns `<circle>` e três linhas de grade
 * resolvem uma série de dez pontos. O `<title>`/`<desc>` e a tabela logo abaixo
 * cobrem quem usa leitor de tela; a forma dos marcadores cobre quem não
 * distingue as cores.
 *
 * @param {object} input
 * @returns {string}
 */
export function chart({
  id,
  title,
  values,
  secondValues = null,
  seriesLabels = null,
  indexes,
  max = null,
  threshold = null,
  thresholdLabel = '',
  markers = [],
  format = (value) => String(value),
  bands = null,
}) {
  const all = secondValues ? [...values, ...secondValues] : [...values];
  if (threshold !== null) all.push(threshold);
  const top = max ?? niceCeiling(Math.max(...all, 1));
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;

  const x = (position) =>
    values.length === 1
      ? CHART.left + plotWidth / 2
      : CHART.left + (position * plotWidth) / (values.length - 1);
  const y = (value) => CHART.top + (1 - Math.min(1, Math.max(0, value / top))) * plotHeight;

  const gridValues = [0, top / 2, top];
  const grid = gridValues
    .map(
      (value) =>
        `<line x1="${CHART.left}" y1="${y(value).toFixed(1)}" x2="${CHART.width - CHART.right}" y2="${y(value).toFixed(1)}" class="grid"/>` +
        `<text x="${CHART.left - 8}" y="${(y(value) + 4).toFixed(1)}" class="axis" text-anchor="end">${escapeHtml(format(value))}</text>`,
    )
    .join('');

  const thresholdLine =
    threshold === null || threshold > top
      ? ''
      : `<line x1="${CHART.left}" y1="${y(threshold).toFixed(1)}" x2="${CHART.width - CHART.right}" y2="${y(threshold).toFixed(1)}" class="threshold"/>` +
        `<text x="${CHART.width - CHART.right}" y="${(y(threshold) - 6).toFixed(1)}" class="axis threshold-label" text-anchor="end">${escapeHtml(thresholdLabel)}</text>`;

  // O rótulo de um marcador na primeira ou na última janela sairia do viewBox se
  // fosse sempre centralizado: perto das bordas ele ancora para dentro.
  const markerLines = markers
    .filter((marker) => marker.index >= 0 && marker.index < values.length)
    .map((marker) => {
      const position = x(marker.index);
      const anchor =
        position <= CHART.left + 40 ? 'start' : position >= CHART.width - CHART.right - 40 ? 'end' : 'middle';
      return (
        `<line x1="${position.toFixed(1)}" y1="${CHART.top}" x2="${position.toFixed(1)}" y2="${CHART.top + plotHeight}" class="marker marker-${escapeHtml(marker.kind)}"/>` +
        `<text x="${position.toFixed(1)}" y="${CHART.top - 6}" class="axis marker-label marker-${escapeHtml(marker.kind)}" text-anchor="${anchor}">${escapeHtml(marker.label)}</text>`
      );
    })
    .join('');

  const line = (series, className) =>
    `<polyline class="${className}" points="${series.map((value, position) => `${x(position).toFixed(1)},${y(value).toFixed(1)}`).join(' ')}"/>`;

  const dots = values
    .map((value, position) => {
      const band = bands ? bands[position] : null;
      return marker(x(position), y(value), band);
    })
    .join('');

  const secondDots = secondValues
    ? secondValues.map((value, position) => `<circle cx="${x(position).toFixed(1)}" cy="${y(value).toFixed(1)}" r="3.5" class="dot dot-secondary"/>`).join('')
    : '';

  const axis = indexes
    .map(
      (windowIndex, position) =>
        `<text x="${x(position).toFixed(1)}" y="${CHART.height - 20}" class="axis" text-anchor="middle">${escapeHtml(String(windowIndex))}</text>`,
    )
    .join('');

  const legend = seriesLabels
    ? `<p class="legend"><span class="legend-primary">━ ${escapeHtml(seriesLabels[0])}</span> <span class="legend-secondary">┅ ${escapeHtml(seriesLabels[1])}</span></p>`
    : '';

  const description = values
    .map((value, position) => `janela ${indexes[position]}: ${format(value)}`)
    .join('; ');

  return `<figure class="chart">
  <figcaption>${escapeHtml(title)}</figcaption>
  ${legend}  <svg viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-labelledby="t-${escapeHtml(id)} d-${escapeHtml(id)}" preserveAspectRatio="xMidYMid meet">
    <title id="t-${escapeHtml(id)}">${escapeHtml(title)}</title>
    <desc id="d-${escapeHtml(id)}">${escapeHtml(description)}</desc>
    ${grid}
    ${thresholdLine}
    ${markerLines}
    ${secondValues ? line(secondValues, 'series series-secondary') : ''}
    ${line(values, 'series series-primary')}
    ${secondDots}
    ${dots}
    ${axis}
    <text x="${CHART.width / 2}" y="${CHART.height - 5}" class="axis axis-title" text-anchor="middle">janela</text>
  </svg>
</figure>`;
}

/**
 * O marcador de um ponto: **forma** por faixa de risco, não só cor.
 *
 * Círculo = risco baixo, triângulo = atenção, quadrado = falha provável. Quem
 * imprime em preto e branco continua conseguindo ler o gráfico.
 */
function marker(cx, cy, band) {
  const x = cx.toFixed(1);
  const y = cy.toFixed(1);

  if (band === 'likely') {
    return `<rect x="${(cx - 4).toFixed(1)}" y="${(cy - 4).toFixed(1)}" width="8" height="8" class="dot dot-likely"/>`;
  }
  if (band === 'attention') {
    return `<polygon points="${x},${(cy - 5).toFixed(1)} ${(cx + 4.5).toFixed(1)},${(cy + 3.5).toFixed(1)} ${(cx - 4.5).toFixed(1)},${(cy + 3.5).toFixed(1)}" class="dot dot-attention"/>`;
  }
  return `<circle cx="${x}" cy="${y}" r="4" class="dot dot-${band ? escapeHtml(band) : 'plain'}"/>`;
}

/** Um teto "redondo" para o eixo, para a grade não cair em número quebrado. */
function niceCeiling(value) {
  if (value <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                  */
/* ------------------------------------------------------------------------- */

function renderGauge(probability, threshold) {
  const width = 720;
  const height = 46;
  const bandStops = [0, 0.4, 0.7, 1];

  const segments = bandStops
    .slice(0, -1)
    .map(
      (from, index) =>
        `<rect x="${(from * width).toFixed(1)}" y="14" width="${((bandStops[index + 1] - from) * width).toFixed(1)}" height="16" class="gauge-band gauge-band-${RISK_BANDS[index].id}"/>`,
    )
    .join('');

  const pointer = (probability * width).toFixed(1);
  const thresholdX = (threshold * width).toFixed(1);

  return `<svg class="gauge-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Probabilidade de ${percent(probability)} contra o limiar de ${percent(threshold)}" preserveAspectRatio="none">
      ${segments}
      <line x1="${thresholdX}" y1="8" x2="${thresholdX}" y2="36" class="gauge-threshold"/>
      <polygon points="${pointer},10 ${(Number(pointer) + 7).toFixed(1)},0 ${(Number(pointer) - 7).toFixed(1)},0" class="gauge-pointer"/>
      <text x="4" y="44" class="axis">0%</text>
      <text x="${thresholdX}" y="44" class="axis" text-anchor="middle">limiar ${percent(threshold)}</text>
      <text x="${width - 4}" y="44" class="axis" text-anchor="end">100%</text>
    </svg>`;
}

function metaItem(label, value) {
  return `<div class="meta-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function metricCard(label, value) {
  return `<li class="metric"><span class="metric-label">${escapeHtml(label)}</span><strong class="metric-value">${escapeHtml(value)}</strong></li>`;
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function round(value) {
  if (!Number.isFinite(Number(value))) return '—';
  return String(Math.round(Number(value) * 1000) / 1000);
}

function signed(value) {
  const rounded = Math.round(Number(value) * 1000) / 1000;
  return rounded >= 0 ? `+${rounded}` : String(rounded);
}

function formatLead(windows) {
  if (windows === null || windows === undefined) return 'não aplicável';
  if (windows > 0) return `${windows} janela(s) de antecedência`;
  if (windows === 0) return 'nenhuma — o alarme veio na mesma janela da falha';
  return `${Math.abs(windows)} janela(s) de atraso`;
}

/** A baseline exportada para quem monta o relatório. */
export const REPORT_BASELINE = BASELINE;
export const REPORT_TARGET = { name: TARGET_NAME, horizonWindows: HORIZON_WINDOWS };

/**
 * Estilo embutido. Tema claro, uma coluna, tipografia do sistema — o mesmo
 * critério do relatório do Dia 1: nenhuma fonte é baixada e o arquivo abre
 * igual offline.
 */
const STYLES = `
:root {
  --ink: #16202c; --muted: #5a6b7d; --line: #d8e0e8; --bg: #ffffff; --panel: #f5f8fb;
  --ok: #1b7a4b; --bad: #b0202f; --warn: #8a5a00; --info: #1c5f9e;
  --low: #1b7a4b; --attention: #8a5a00; --likely: #b0202f;
  --fact: #1c5f9e; --inference: #6b3fa0; --action: #1b7a4b; --limit: #8a5a00;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px; line-height: 1.6;
}
.skip { position: absolute; left: -9999px; top: 0; background: var(--ink); color: #fff; padding: .75rem 1rem; z-index: 10; }
.skip:focus { left: 0; }
main, header, footer { max-width: 62rem; margin: 0 auto; padding: 1.5rem 1.25rem; }
.hero { border-bottom: 4px solid var(--line); }
.hero.band-low { border-bottom-color: var(--low); }
.hero.band-attention { border-bottom-color: var(--attention); }
.hero.band-likely { border-bottom-color: var(--likely); }
.eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: .75rem; color: var(--muted); margin: 0 0 .5rem; }
h1 { font-size: 1.75rem; margin: 0 0 .5rem; overflow-wrap: anywhere; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
h3 { font-size: .95rem; margin: 1.5rem 0 .35rem; }
.lead { color: var(--muted); margin: 0 0 1rem; }
.gauge { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.25rem; margin: 0 0 1.25rem; }
.probability { margin: 0 0 .5rem; }
.probability-value { font-size: 2.6rem; font-weight: 800; line-height: 1; }
.probability-label { color: var(--muted); font-size: .9rem; display: block; }
.gauge-svg { width: 100%; height: 46px; display: block; margin: .75rem 0 .25rem; }
.gauge-band-low { fill: #d6ecdf; }
.gauge-band-attention { fill: #fbeecd; }
.gauge-band-likely { fill: #f7d7da; }
.gauge-threshold { stroke: var(--ink); stroke-width: 2; stroke-dasharray: 3 3; }
.gauge-pointer { fill: var(--ink); }
.band { margin: .5rem 0 .25rem; }
.band-icon { font-weight: 700; }
.hero.band-low .band strong { color: var(--low); }
.hero.band-attention .band strong { color: var(--attention); }
.hero.band-likely .band strong { color: var(--likely); }
.verdict { margin: 0; font-size: .95rem; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .5rem 1.5rem; margin: 0; }
.meta-item { border-left: 3px solid var(--line); padding-left: .75rem; }
dt { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.hint { color: var(--muted); font-size: .9rem; }
.summary { font-size: 1.05rem; }
code { background: var(--panel); padding: .1em .35em; border-radius: 3px; font-size: .875em; overflow-wrap: anywhere; }
.chart { margin: 1.25rem 0; }
.chart figcaption { font-weight: 700; font-size: .9rem; margin-bottom: .25rem; }
.chart svg { width: 100%; height: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.legend { font-size: .8rem; color: var(--muted); margin: 0 0 .25rem; }
.legend-secondary { margin-left: .75rem; }
.grid { stroke: #c9d4de; stroke-width: 1; }
.axis { font-size: 11px; fill: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.axis-title { font-size: 10px; letter-spacing: .08em; }
.threshold { stroke: var(--ink); stroke-width: 2; stroke-dasharray: 5 4; }
.threshold-label { fill: var(--ink); font-weight: 700; }
.marker { stroke-width: 2; stroke-dasharray: 2 3; }
.marker-alert { stroke: var(--info); }
.marker-failure { stroke: var(--bad); }
.marker-label { font-weight: 700; font-size: 10px; }
.marker-label.marker-alert { fill: var(--info); }
.marker-label.marker-failure { fill: var(--bad); }
.series { fill: none; stroke-width: 2.5; }
.series-primary { stroke: var(--ink); }
.series-secondary { stroke: var(--ok); stroke-dasharray: 6 4; }
.dot { stroke: #fff; stroke-width: 1.5; }
.dot-plain, .dot-low { fill: var(--low); }
.dot-attention { fill: var(--attention); }
.dot-likely { fill: var(--likely); }
.dot-secondary { fill: var(--ok); }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
caption { text-align: left; color: var(--muted); font-size: .85rem; padding-bottom: .5rem; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { background: var(--panel); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
.scroll { overflow-x: auto; }
.band-row-likely th, .band-row-likely td { background: #fdf1f2; }
.band-row-attention th, .band-row-attention td { background: #fdf7e8; }
.flag { font-size: .68rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--info); border: 1px solid currentColor; border-radius: 3px; padding: 0 .3rem; white-space: nowrap; }
.matrix td { text-align: center; font-size: 1.1rem; }
.matrix td span { display: block; font-size: .7rem; color: var(--muted); letter-spacing: .08em; }
.cell-ok { background: #eef7f1; }
.cell-bad { background: #fdf1f2; }
.bin-above th { font-weight: 700; }
.metrics { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .75rem; margin: 1rem 0; }
.metric { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: .6rem .8rem; }
.metric-label { display: block; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.metric-value { font-size: 1.4rem; }
.factors { list-style: none; padding: 0; }
.factor { border-left: 4px solid var(--line); background: var(--panel); padding: .6rem .9rem; margin: 0 0 .75rem; border-radius: 0 6px 6px 0; }
.factor-increases { border-left-color: var(--likely); }
.factor-decreases { border-left-color: var(--low); }
.factor p { margin: 0 0 .2rem; }
.factor-head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
.factor-arrow { font-weight: 700; }
.factor-increases .factor-arrow, .factor-increases .factor-direction { color: var(--likely); }
.factor-decreases .factor-arrow, .factor-decreases .factor-direction { color: var(--low); }
.factor-direction { font-size: .8rem; font-weight: 700; letter-spacing: .04em; }
.factor-meaning { color: var(--muted); font-size: .88rem; }
.factor-numbers { font-size: .82rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.bar { background: #e4ebf1; border-radius: 3px; height: 8px; overflow: hidden; min-width: 4rem; display: inline-block; width: 100%; max-width: 16rem; }
.bar span { display: block; height: 100%; background: var(--info); }
.bar-pos span { background: var(--likely); }
.bar-neg span { background: var(--low); }
.tag { display: inline-block; font-size: .7rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: .12rem .4rem; border-radius: 3px; border: 1px solid currentColor; }
.tag-summary { color: var(--ink); }
.tag-fact { color: var(--fact); }
.tag-inference { color: var(--inference); }
.tag-cause { color: var(--muted); }
.tag-action { color: var(--action); }
.tag-limit { color: var(--limit); }
.explanation { border: 1px solid var(--line); border-radius: 8px; padding: .5rem 1.25rem 1.25rem; background: var(--panel); }
.explanation h2 { border-bottom-color: var(--line); }
.origin { font-size: .85rem; color: var(--muted); }
ol, ul { padding-left: 1.25rem; }
.limitations { list-style: none; padding: 0; }
.limitations li { border-left: 4px solid var(--limit); padding: .3rem .75rem; margin-bottom: .4rem; }
.features li { margin-bottom: .3rem; }
.ids code { display: inline-block; margin: .1rem .15rem; }
.callout { border-radius: 6px; padding: .75rem 1rem; margin: 1rem 0; border-left: 5px solid; }
.callout-warn { border-color: var(--warn); background: #fdf7e8; }
.callout-info { border-color: var(--info); background: #eef4fb; }
.outcome { border-left: 5px solid var(--muted); padding: .6rem 1rem; background: var(--panel); border-radius: 0 6px 6px 0; }
.outcome-true_positive, .outcome-true_negative { border-left-color: var(--ok); }
.outcome-false_positive, .outcome-false_negative { border-left-color: var(--bad); }
details { border: 1px solid var(--line); border-radius: 6px; padding: .5rem .75rem; margin-bottom: .5rem; }
summary { cursor: pointer; font-size: .9rem; }
footer { border-top: 1px solid var(--line); color: var(--muted); font-size: .82rem; }
footer p { margin: .25rem 0; }
a:focus-visible, summary:focus-visible { outline: 3px solid var(--info); outline-offset: 2px; }
@media (max-width: 40rem) {
  h1 { font-size: 1.4rem; }
  main, header, footer { padding: 1rem .9rem; }
  .probability-value { font-size: 2rem; }
}
@media print {
  .skip { display: none; }
  details { break-inside: avoid; }
  .chart, .factor, section { break-inside: avoid; }
}
`;
