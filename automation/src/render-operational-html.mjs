/**
 * Relatório operacional em HTML — a saída principal da demonstração do Dia 1.
 *
 * Um arquivo, autônomo. **Sem** CDN, script externo, folha de estilo externa,
 * fonte externa, imagem externa ou link com credencial: o relatório é baixado
 * de um artefato do GitHub Actions e aberto localmente, muitas vezes offline, e
 * qualquer dependência de rede o transformaria numa página quebrada.
 *
 * Três decisões de apresentação que são também decisões de conteúdo:
 *
 * 1. **Rótulo textual, não cor.** `[FATO]`, `[INFERÊNCIA]`, `[RECOMENDAÇÃO]` e
 *    `[LIMITAÇÃO]` aparecem escritos. A cor reforça; ela não é a informação.
 *    Um relatório impresso em preto e branco, ou lido por quem não distingue
 *    verde de vermelho, continua legível — e a distinção entre fato e palpite é
 *    justamente a coisa que não pode se perder.
 * 2. **Toda inferência mostra os fatos que a sustentam.** Se o vínculo não
 *    couber na tela, a afirmação vira opinião com aparência de conclusão.
 * 3. **Trecho selecionado, nunca o log inteiro.** O relatório é a redução; quem
 *    quiser o log completo baixa o artefato correspondente.
 *
 * Sobre segurança: **tudo** que entra passa por `escapeHtml`. O conteúdo vem de
 * log de CI, de saída da Railway CLI e de um modelo de linguagem — três fontes
 * não confiáveis. Ver `html-escape.mjs`.
 */

import { escapeHtml, escapeTruncated } from './html-escape.mjs';
import { redactCredentialMaterial } from './redact-secrets.mjs';
import {
  CANNOT_CLAIM,
  CAUSE_STRENGTH_LABELS,
  CORRELATION_LABELS,
  COVERAGE_ROWS,
  PHASE_LABELS,
} from './render-operational-report.mjs';

const STATUS_TEXT = {
  success: 'APROVADO',
  failure: 'REPROVADO',
  unknown: 'INDETERMINADO',
};

const CONFIDENCE_TEXT = { low: 'baixa', medium: 'média', high: 'alta' };

/** Teto do trecho exibido. O relatório é a redução, não o arquivo de log. */
const MAX_EXCERPT_LENGTH = 600;
const MAX_TIMELINE_ROWS = 60;

/**
 * @param {object} diagnosis diagnóstico validado por `operationalDiagnosisSchema`
 * @param {object} [context] contexto operacional (linha do tempo)
 * @returns {string} documento HTML completo e autônomo
 */
export function renderOperationalHtml(diagnosis, context = null) {
  const status = diagnosis.technicalStatus;
  const shortSha = String(diagnosis.commitSha).slice(0, 7);

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Relatório operacional — ${escapeHtml(diagnosis.repository)} @ ${escapeHtml(shortSha)}</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#conteudo">Pular para o conteúdo</a>

<header class="hero status-${escapeHtml(status.overall)}">
  <p class="eyebrow">Relatório operacional do deployment · Dia 1</p>
  <h1>${escapeHtml(diagnosis.repository)}</h1>
  <p class="verdict">
    <span class="verdict-label">Resultado técnico:</span>
    <strong>${escapeHtml(STATUS_TEXT[status.overall] ?? 'INDETERMINADO')}</strong>
  </p>
  <dl class="meta">
    ${metaItem('Commit', shortSha)}
    ${metaItem('Ambiente', diagnosis.environment ?? 'não informado')}
    ${metaItem('Serviço', diagnosis.service ?? 'não informado')}
    ${metaItem('Deployment ID', diagnosis.deploymentId ?? 'não informado')}
    ${metaItem('Host alvo', diagnosis.targetHost)}
    ${metaItem('Análise gerada em', diagnosis.generatedAt)}
    ${metaItem('Origem do diagnóstico', diagnosis.usedFallback ? 'classificador determinístico (sem modelo)' : 'modelo, com saída validada por schema')}
    ${metaItem('usedFallback', String(diagnosis.usedFallback))}
  </dl>
</header>

<main id="conteudo">

<section aria-labelledby="gates">
  <h2 id="gates">Resultado por gate</h2>
  <table>
    <caption>Cada gate é determinístico: vem de exit code de job ou de código HTTP.</caption>
    <thead><tr><th scope="col">Gate</th><th scope="col">Resultado</th></tr></thead>
    <tbody>
      ${gateRow('CI (lint, testes, build, docker)', status.ci)}
      ${gateRow('Deployment na plataforma (Railway)', status.railwayDeployment)}
      ${gateRow('Smoke test pós-deployment', status.smokeTest)}
      ${gateRow('Geral', status.overall)}
    </tbody>
  </table>
</section>

<section aria-labelledby="cobertura">
  <h2 id="cobertura">Cobertura das fontes</h2>
  <p class="hint">O que foi efetivamente coletado nesta execução. Fonte ausente é lacuna declarada — não é ausência de problema.</p>
  <ul class="coverage">
    ${COVERAGE_ROWS.map(([key, label]) => coverageRow(label, diagnosis.sourceCoverage[key])).join('\n    ')}
  </ul>
  ${renderRailwayNotice(diagnosis)}
</section>

<section aria-labelledby="fase">
  <h2 id="fase">Fase afetada</h2>
  <p class="phase"><code>${escapeHtml(diagnosis.affectedPhase)}</code> — ${escapeHtml(PHASE_LABELS[diagnosis.affectedPhase] ?? 'não identificada')}</p>
  <p class="summary">${escapeHtml(diagnosis.summary)}</p>
</section>

<section aria-labelledby="correlacao">
  <h2 id="correlacao">Correlação da release (commit SHA)</h2>
  <dl class="meta">
    ${metaItem('Situação', `${CORRELATION_LABELS[diagnosis.correlationStatus] ?? 'não verificada'} (${diagnosis.correlationStatus})`)}
    ${metaItem('Commit esperado', diagnosis.expectedCommitSha)}
    ${metaItem('Commit observado', diagnosis.observedCommitSha ?? 'não informado pela plataforma')}
  </dl>
  ${
    diagnosis.correlationStatus === 'mismatch'
      ? `<p class="callout callout-danger"><strong>Atenção — versão divergente.</strong> O commit observado na plataforma não é o commit esperado por esta validação. Os logs desta coleta podem pertencer a outra release, e nenhuma conclusão sobre o commit em análise se sustenta sobre eles.</p>`
      : ''
  }
</section>

<section aria-labelledby="fatos">
  <h2 id="fatos">Fatos observados</h2>
  <p class="hint">Trechos que <strong>existem</strong> no material coletado. Cada um foi conferido contra a fonte antes de entrar aqui.</p>
  ${
    diagnosis.observedFacts.length === 0
      ? '<p class="empty">Nenhum fato foi coletado nesta execução.</p>'
      : `<ol class="facts">${diagnosis.observedFacts.map(renderFact).join('')}</ol>`
  }
</section>

<section aria-labelledby="inferencias">
  <h2 id="inferencias">Inferências</h2>
  <p class="hint">Afirmações <strong>deduzidas</strong> dos fatos — elas não estão literalmente no log. Cada uma aponta os fatos que a sustentam.</p>
  ${
    diagnosis.inferences.length === 0
      ? '<p class="empty">Nenhuma inferência se sustentou nos fatos coletados.</p>'
      : `<ul class="inferences">${diagnosis.inferences.map(renderInference).join('')}</ul>`
  }
</section>

<section aria-labelledby="causa">
  <h2 id="causa">Causa provável</h2>
  <p class="strength"><span class="tag tag-strength">força da afirmação</span> ${escapeHtml(CAUSE_STRENGTH_LABELS[diagnosis.causeStrength] ?? 'não informada')}</p>
  <p class="summary">${
    diagnosis.probableCause
      ? escapeHtml(diagnosis.probableCause)
      : 'Não foi possível estabelecer uma causa com o material disponível.'
  }</p>
</section>

<section aria-labelledby="recomendacoes">
  <h2 id="recomendacoes">Recomendações</h2>
  ${
    diagnosis.recommendedActions.length === 0
      ? '<p class="empty">Nenhuma ação sugerida.</p>'
      : `<ol class="actions">${diagnosis.recommendedActions
          .map((action) => `<li><span class="tag tag-action">[RECOMENDAÇÃO]</span> ${escapeHtml(action)}</li>`)
          .join('')}</ol>`
  }
</section>

<section aria-labelledby="limitacoes">
  <h2 id="limitacoes">Limitações</h2>
  ${
    diagnosis.limitations.length === 0
      ? '<p class="empty">Nenhuma limitação declarada.</p>'
      : `<ul class="limitations">${diagnosis.limitations
          .map((limitation) => `<li><span class="tag tag-limit">[LIMITAÇÃO]</span> ${escapeHtml(limitation)}</li>`)
          .join('')}</ul>`
  }
</section>

${renderTimeline(context)}

${renderEvidence(context)}

<section aria-labelledby="modelo">
  <h2 id="modelo">Chamada ao modelo</h2>
  <dl class="meta">
    ${metaItem('Fallback determinístico', diagnosis.usedFallback ? 'sim' : 'não')}
    ${metaItem('Modelo', diagnosis.model ?? 'não informado')}
    ${metaItem('Provedor', diagnosis.modelProvider ?? 'não informado')}
    ${metaItem('Latência', formatLatency(diagnosis.modelLatencyMs))}
    ${metaItem('Tokens', formatUsage(diagnosis.modelUsage))}
    ${metaItem('Id da resposta', diagnosis.modelResponseId ?? 'não informado')}
    ${metaItem('Falha da chamada', diagnosis.modelErrorCategory ?? 'nenhuma')}
  </dl>
  <p class="hint">Estes números são observabilidade — conta de luz. Não entram na decisão do CI nem na do CD.</p>
</section>

<section aria-labelledby="nao-afirma" class="disclaimer">
  <h2 id="nao-afirma">O que a IA não pode afirmar</h2>
  <ul>${CANNOT_CLAIM.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
  <p class="callout callout-info"><strong>Quem decide não é a IA.</strong> Este relatório é informativo. O deployment é aprovado ou reprovado pelo smoke test determinístico (códigos HTTP e exit code) e pelos exit codes dos jobs do CI.</p>
</section>

</main>

<footer>
  <p><code>analysisId: ${escapeHtml(diagnosis.analysisId)}</code></p>
  <p><code>requestId: ${escapeHtml(diagnosis.requestId)}</code></p>
</footer>
</body>
</html>
`;

  // Última barreira, igual à dos renderizadores em Markdown: só material de
  // credencial. Os campos não confiáveis já foram redigidos um a um.
  return redactCredentialMaterial(html);
}

/* ------------------------------------------------------------------------- */
/* Blocos                                                                     */
/* ------------------------------------------------------------------------- */

function renderFact(fact) {
  return `<li class="fact" id="fato-${escapeHtml(fact.id)}">
  <p class="fact-head">
    <span class="tag tag-fact">[FATO]</span>
    <span class="fact-id">${escapeHtml(fact.id)}</span>
    <span class="fact-meta">fonte <code>${escapeHtml(fact.source)}</code></span>
    <span class="fact-meta">fase <code>${escapeHtml(fact.phase)}</code></span>
    <span class="fact-meta">${
      fact.timestamp
        ? `horário <time datetime="${escapeHtml(fact.timestamp)}">${escapeHtml(fact.timestamp)}</time>`
        : '<em>sem timestamp registrado</em>'
    }</span>
  </p>
  <pre class="excerpt"><code>${escapeTruncated(fact.excerpt, MAX_EXCERPT_LENGTH)}</code></pre>
</li>`;
}

function renderInference(inference) {
  const support = inference.supportedBy
    .map((id) => `<a class="ref" href="#fato-${escapeHtml(id)}">${escapeHtml(id)}</a>`)
    .join(', ');

  return `<li class="inference">
  <p><span class="tag tag-inference">[INFERÊNCIA]</span> ${escapeHtml(inference.statement)}</p>
  <p class="support">Sustentada pelos fatos: ${support || '<em>nenhum</em>'} · confiança: <strong>${escapeHtml(
    CONFIDENCE_TEXT[inference.confidence] ?? inference.confidence,
  )}</strong></p>
</li>`;
}

function renderTimeline(context) {
  const events = context?.timeline ?? [];
  if (events.length === 0) return '';

  const rows = events
    .slice(0, MAX_TIMELINE_ROWS)
    .map(
      (event) => `<tr class="level-${escapeHtml(event.level)}">
    <td>${
      event.timestamp
        ? `<time datetime="${escapeHtml(event.timestamp)}">${escapeHtml(event.timestamp)}</time>`
        : '<em>sem timestamp</em>'
    }</td>
    <td><code>${escapeHtml(event.phase)}</code></td>
    <td><code>${escapeHtml(event.source)}</code></td>
    <td>${escapeHtml(event.level)}</td>
    <td>${escapeTruncated(event.message, 200)}</td>
  </tr>`,
    )
    .join('\n');

  const withoutTimestamp = events.filter((event) => !event.hasTimestamp).length;

  return `<section aria-labelledby="linha-do-tempo">
  <h2 id="linha-do-tempo">Linha do tempo — CI → CD → runtime</h2>
  <p class="hint">Ordenada por horário quando ele existe. Eventos sem horário aparecem no fim, agrupados por fase, e estão marcados como tal: nenhum timestamp foi inventado.${
    withoutTimestamp > 0 ? ` Nesta execução, ${withoutTimestamp} evento(s) não tinham horário.` : ''
  }</p>
  <div class="scroll">
  <table>
    <thead><tr><th scope="col">Horário</th><th scope="col">Fase</th><th scope="col">Fonte</th><th scope="col">Nível</th><th scope="col">Evento</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>
</section>`;
}

function renderEvidence(context) {
  const sources = context?.textSources ?? [];
  if (sources.length === 0) return '';

  const blocks = sources
    .map((entry) => {
      const excerpt = selectExcerpt(entry.content);
      return `<details>
  <summary><code>${escapeHtml(entry.source)}</code> · fase <code>${escapeHtml(entry.phase)}</code></summary>
  <pre class="excerpt"><code>${escapeTruncated(excerpt, 2400)}</code></pre>
</details>`;
    })
    .join('\n');

  return `<section aria-labelledby="evidencias">
  <h2 id="evidencias">Evidências selecionadas dos logs</h2>
  <p class="hint">Trechos, não o log completo. Os arquivos inteiros continuam disponíveis nos artefatos da execução.</p>
  ${blocks}
</section>`;
}

function renderRailwayNotice(diagnosis) {
  const coverage = diagnosis.sourceCoverage;
  const missing = !coverage.railwayBuild && !coverage.railwayDeploy && !coverage.railwayRuntime;
  if (!missing) return '';

  const noToken = diagnosis.limitations.some((limitation) => limitation.includes('RAILWAY_TOKEN'));

  return `<p class="callout callout-warn"><strong>Logs internos do Railway não coletados.</strong> ${
    noToken
      ? 'O job de coleta não recebeu <code>RAILWAY_TOKEN</code>, então build, deploy e runtime da plataforma não fazem parte deste diagnóstico.'
      : 'A coleta da plataforma não produziu logs nesta execução. Consulte as limitações para a categoria da falha.'
  } O que este relatório mostra vem do CI e do smoke test — a borda da aplicação, não o interior do container.</p>`;
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

/** Cabeça e cauda do trecho: é onde ficam o começo do processo e o erro final. */
function selectExcerpt(content, maxLines = 24) {
  const lines = String(content ?? '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');

  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(-Math.ceil(maxLines / 2));
  return [...head, `... (${lines.length - maxLines} linha(s) omitida(s))`, ...tail].join('\n');
}

function metaItem(label, value) {
  return `<div class="meta-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function gateRow(label, value) {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td><span class="badge badge-${escapeHtml(
    value,
  )}">${escapeHtml(value)}</span></td></tr>`;
}

function coverageRow(label, collected) {
  return `<li class="coverage-row"><span class="coverage-label">${escapeHtml(
    label,
  )}</span><span class="coverage-dots" aria-hidden="true"></span><span class="coverage-value coverage-${
    collected ? 'yes' : 'no'
  }">${collected ? 'coletado' : 'ausente'}</span></li>`;
}

function formatLatency(milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'não informada';
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function formatUsage(usage) {
  if (!usage) return 'não informado';
  const parts = [
    Number.isFinite(usage.inputTokens) ? `entrada ${usage.inputTokens}` : null,
    Number.isFinite(usage.outputTokens) ? `saída ${usage.outputTokens}` : null,
    Number.isFinite(usage.reasoningTokens) ? `raciocínio ${usage.reasoningTokens}` : null,
  ].filter(Boolean);

  const total = Number.isFinite(usage.totalTokens) ? String(usage.totalTokens) : 'não informado';
  return parts.length > 0 ? `${total} (${parts.join(' · ')})` : total;
}

/**
 * Estilo embutido. Tema claro, uma coluna, tipografia do sistema.
 *
 * Nenhuma fonte é baixada: `system-ui` usa o que a máquina já tem, e o relatório
 * abre igual offline. As categorias têm cor **e** rótulo textual **e** borda
 * lateral — três sinais, para que nenhum leitor dependa de um só.
 */
const STYLES = `
:root {
  --ink: #16202c; --muted: #5a6b7d; --line: #d8e0e8; --bg: #ffffff; --panel: #f5f8fb;
  --ok: #1b7a4b; --bad: #b0202f; --warn: #8a5a00; --info: #1c5f9e;
  --fact: #1c5f9e; --inference: #6b3fa0; --action: #1b7a4b; --limit: #8a5a00;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 16px; line-height: 1.6;
}
.skip {
  position: absolute; left: -9999px; top: 0; background: var(--ink); color: #fff;
  padding: .75rem 1rem; z-index: 10;
}
.skip:focus { left: 0; }
main, header, footer { max-width: 62rem; margin: 0 auto; padding: 1.5rem 1.25rem; }
.hero { border-bottom: 4px solid var(--line); }
.hero.status-success { border-bottom-color: var(--ok); }
.hero.status-failure { border-bottom-color: var(--bad); }
.hero.status-unknown { border-bottom-color: var(--warn); }
.eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: .75rem; color: var(--muted); margin: 0 0 .5rem; }
h1 { font-size: 1.75rem; margin: 0 0 .75rem; overflow-wrap: anywhere; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
.verdict { font-size: 1.1rem; margin: 0 0 1rem; }
.verdict-label { color: var(--muted); }
.status-success .verdict strong { color: var(--ok); }
.status-failure .verdict strong { color: var(--bad); }
.status-unknown .verdict strong { color: var(--warn); }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .5rem 1.5rem; margin: 0; }
.meta-item { border-left: 3px solid var(--line); padding-left: .75rem; }
dt { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.hint, .empty { color: var(--muted); font-size: .9rem; }
.summary { font-size: 1.05rem; }
.phase code { font-size: 1rem; }
code { background: var(--panel); padding: .1em .35em; border-radius: 3px; font-size: .875em; overflow-wrap: anywhere; }
pre.excerpt {
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: .75rem; overflow-x: auto; font-size: .82rem; line-height: 1.5; margin: .5rem 0 0;
}
pre.excerpt code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
caption { text-align: left; color: var(--muted); font-size: .85rem; padding-bottom: .5rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { background: var(--panel); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
.scroll { overflow-x: auto; }
.badge { font-weight: 700; font-size: .8rem; padding: .15rem .5rem; border-radius: 999px; border: 1px solid currentColor; }
.badge-success { color: var(--ok); }
.badge-failure, .badge-failed, .badge-crashed { color: var(--bad); }
.badge-unknown, .badge-not_executed, .badge-in_progress, .badge-removed { color: var(--warn); }
.tag {
  display: inline-block; font-size: .7rem; font-weight: 700; letter-spacing: .06em;
  padding: .12rem .4rem; border-radius: 3px; border: 1px solid currentColor; margin-right: .4rem;
  white-space: nowrap;
}
.tag-fact { color: var(--fact); }
.tag-inference { color: var(--inference); }
.tag-action { color: var(--action); }
.tag-limit { color: var(--limit); }
.tag-strength { color: var(--muted); }
ol, ul { padding-left: 1.25rem; }
.facts { list-style: none; padding: 0; }
.fact { border-left: 4px solid var(--fact); background: var(--panel); padding: .75rem 1rem; margin: 0 0 1rem; border-radius: 0 6px 6px 0; }
.fact-head { margin: 0; display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
.fact-id { font-weight: 700; }
.fact-meta { font-size: .8rem; color: var(--muted); }
.inferences { list-style: none; padding: 0; }
.inference { border-left: 4px solid var(--inference); padding: .5rem 1rem; margin: 0 0 .75rem; }
.inference p { margin: 0 0 .25rem; }
.support { font-size: .85rem; color: var(--muted); }
.ref { color: var(--fact); font-weight: 700; }
.actions li, .limitations li { margin-bottom: .5rem; }
.limitations { list-style: none; padding: 0; }
.limitations li { border-left: 4px solid var(--limit); padding: .35rem .75rem; }
.coverage { list-style: none; padding: 0; margin: .5rem 0; font-size: .92rem; }
.coverage-row { display: flex; align-items: baseline; gap: .4rem; padding: .15rem 0; }
.coverage-label { white-space: nowrap; }
.coverage-dots { flex: 1 1 auto; border-bottom: 1px dotted var(--line); transform: translateY(-.25em); min-width: 1rem; }
.coverage-value { font-weight: 700; white-space: nowrap; }
.coverage-yes { color: var(--ok); }
.coverage-no { color: var(--warn); }
.callout { border-radius: 6px; padding: .75rem 1rem; margin: 1rem 0; border-left: 5px solid; }
.callout-danger { border-color: var(--bad); background: #fdf1f2; }
.callout-warn { border-color: var(--warn); background: #fdf7e8; }
.callout-info { border-color: var(--info); background: #eef4fb; }
details { border: 1px solid var(--line); border-radius: 6px; padding: .5rem .75rem; margin-bottom: .5rem; }
summary { cursor: pointer; font-size: .9rem; }
.level-error td { background: #fdf1f2; }
.level-warn td { background: #fdf7e8; }
.disclaimer { background: var(--panel); border-radius: 6px; padding: 1rem 1.25rem; margin-top: 2rem; }
footer { border-top: 1px solid var(--line); color: var(--muted); font-size: .8rem; }
footer p { margin: .2rem 0; }
a:focus-visible, summary:focus-visible { outline: 3px solid var(--info); outline-offset: 2px; }
@media (max-width: 40rem) {
  h1 { font-size: 1.4rem; }
  main, header, footer { padding: 1rem .9rem; }
  .fact-head { gap: .3rem; }
}
@media print {
  .skip { display: none; }
  details { break-inside: avoid; }
  details > pre { display: block; }
}
`;
