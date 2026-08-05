/**
 * Relatório do laboratório de anomalias — JSON, Markdown e painel HTML.
 *
 * O HTML é a saída principal do Dia 2: um arquivo autônomo, sem CDN, sem script
 * externo, sem folha de estilo externa, sem fonte externa e sem biblioteca de
 * gráficos. A faixa das trinta requisições é feita com `div` e altura em
 * porcentagem — o que uma biblioteca de gráficos faria em trinta requisições de
 * rede e duzentos kilobytes, e que deixaria de funcionar no primeiro
 * laboratório aberto sem internet.
 *
 * Quatro decisões de apresentação que são também decisões de conteúdo:
 *
 * 1. **O status é texto antes de ser cor.** "ANOMALIA DETECTADA" está escrito no
 *    banner, e cada cartão diz por extenso `dentro da baseline` ou
 *    `variação relativa alta, diferença absoluta pequena`. Um painel impresso em
 *    preto e branco, ou lido por quem não distingue verde de vermelho, continua
 *    completo.
 * 2. **Cada cartão mostra a conta.** Baseline, observado, diferença, a regra
 *    literal e as duas condições avaliadas em separado. Sem isso o painel diria
 *    *que* houve anomalia sem deixar ninguém conferir *por que* — e a coisa que
 *    este laboratório ensina é a conferência.
 * 3. **A faixa e a tabela são a mesma informação, em duas leituras.** A faixa dá
 *    a forma (patamar uniforme? pico isolado?); a tabela dá o número. Cada barra
 *    é uma âncora para a linha correspondente, o que dispensa JavaScript: um
 *    clique leva ao registro exato.
 * 4. **Tudo que entra passa por `escapeHtml`.** Log da aplicação e texto de
 *    modelo são duas fontes não confiáveis, e o painel é um arquivo que alguém
 *    abre no navegador. Ver `html-escape.mjs`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { escapeHtml, escapeTruncated } from '../html-escape.mjs';
import { redactCredentialMaterial, redactSecretsDeep } from '../redact-secrets.mjs';
import { GATE_RESULTS } from './detect.mjs';
import { anomalyEvidenceSchema, anomalyExplanationSchema } from './explain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

/** Diretório dos artefatos do Dia 2. */
export const DAY2_REPORT_DIR = join(REPO_ROOT, 'reports', 'day-2');

/** Os quatro sinais, na ordem dos cartões — a mesma ordem do detector. */
const SIGNAL_HINTS = {
  latency: 'Percentil 95 da duração, por posto mais próximo sobre as amostras medidas.',
  error_rate: 'Fração de requisições com código HTTP ≥ 400 ou sem resposta.',
  log_volume: 'Linhas de log estruturado emitidas por requisição, correlacionadas por `requestId`.',
  payload_size: 'Percentil 95 do tamanho do corpo da resposta, em bytes recebidos.',
};

/** Uma amostra medida. */
export const sampleSchema = z.object({
  sequence: z.number().int().positive(),
  statusCode: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  responseSizeBytes: z.number().int().nonnegative(),
  logLineCount: z.number().nonnegative(),
  requestId: z.string().min(1),
});

/** Os quatro sinais decisórios, mais o contexto. */
export const signalsSchema = z.object({
  latencyP95Ms: z.number().nonnegative(),
  errorRate: z.number().min(0).max(1),
  logLinesPerRequest: z.number().nonnegative(),
  responseSizeP95Bytes: z.number().int().nonnegative(),
});

/** `reports/day-2/baseline.json`. */
export const baselineSchema = signalsSchema.extend({
  sampleCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  commitSha: z.string().min(1),
});

const conditionSchema = z.object({ text: z.string(), met: z.boolean() });

export const evaluationSchema = z.object({
  id: z.string().min(1),
  signal: z.string().min(1),
  anomalyType: z.string().min(1),
  label: z.string().min(1),
  unit: z.string(),
  decimals: z.number().int().nonnegative(),
  baselineValue: z.number(),
  observedValue: z.number(),
  difference: z.number(),
  ratio: z.number().nullable(),
  conditions: z.array(conditionSchema),
  rule: z.string().min(1),
  triggered: z.boolean(),
  status: z.string().min(1),
  statusText: z.string().min(1),
});

/**
 * O veredito. Note que ele é gravado **inteiro**, com as regras que não
 * dispararam: um relatório que só listasse o que falhou não permitiria conferir
 * o que passou.
 */
export const detectionSchema = z.object({
  anomalyDetected: z.boolean(),
  anomalyTypes: z.array(z.string()),
  firstAnomalousSignal: z.string().nullable(),
  gateResult: z.enum(GATE_RESULTS),
  triggeredRules: z.array(evaluationSchema),
  evaluations: z.array(evaluationSchema),
});

/** O relatório completo. A ordem das chaves é a ordem do painel. */
export const anomalyReportSchema = z.object({
  scope: z.literal('day-2-anomaly-lab'),
  generatedAt: z.string().datetime(),
  commitSha: z.string().min(1),
  observation: z.object({
    port: z.number().int().positive(),
    path: z.string().min(1),
    warmupRequests: z.number().int().nonnegative(),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
    logCorrelation: z.enum(['request_id', 'window_average']),
  }),
  baseline: baselineSchema,
  observed: signalsSchema.extend({
    sampleCount: z.number().int().nonnegative(),
    requestCount: z.number().int().nonnegative(),
  }),
  detection: detectionSchema,
  samples: z.array(sampleSchema),
  evidence: z.array(anomalyEvidenceSchema),
  explanation: anomalyExplanationSchema,
  usedFallback: z.boolean(),
  modelProvider: z.string().min(1),
  model: z.string().min(1),
  modelResponseId: z.string().min(1).nullable(),
  modelLatencyMs: z.number().int().nonnegative().nullable(),
  modelUsage: z
    .object({
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
      reasoningTokens: z.number().int().nonnegative().nullable(),
      totalTokens: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  modelErrorCategory: z.string().nullable(),
  limitations: z.array(z.string()),
});

/**
 * Monta e valida o relatório.
 *
 * A redação corre sobre o objeto inteiro antes da validação: o que não passar
 * pela máscara não chega ao disco.
 *
 * @param {object} input
 * @returns {object} relatório validado
 */
export function buildAnomalyReport({
  observation,
  baseline,
  detection,
  evidence,
  explanation,
  usedFallback,
  modelCall,
  fallbackNote = null,
  commitSha = 'unknown',
  now = () => new Date(),
}) {
  const limitations = unique([
    ...explanation.limitations,
    ...(observation.limitations ?? []),
    ...(fallbackNote ? [fallbackNote] : []),
  ]);

  return anomalyReportSchema.parse(
    redactSecretsDeep({
      scope: 'day-2-anomaly-lab',
      generatedAt: now().toISOString(),
      commitSha,
      observation: {
        port: observation.port,
        path: observation.path,
        warmupRequests: observation.warmupRequests,
        startedAt: observation.startedAt,
        finishedAt: observation.finishedAt,
        logCorrelation: observation.logCorrelation,
      },
      baseline,
      observed: observation.summary,
      detection,
      samples: observation.samples,
      evidence,
      explanation,
      usedFallback,
      ...modelCall,
      limitations,
    }),
  );
}

/**
 * Grava os três arquivos.
 *
 * @param {object} input
 * @returns {{ jsonPath: string, markdownPath: string, htmlPath: string }}
 */
export function writeAnomalyReports({ report, outDir = DAY2_REPORT_DIR }) {
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, 'anomaly-report.json');
  const markdownPath = join(outDir, 'anomaly-report.md');
  const htmlPath = join(outDir, 'anomaly-report.html');

  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderAnomalyMarkdown(report), 'utf8');
  writeFileSync(htmlPath, renderAnomalyHtml(report), 'utf8');

  return { jsonPath, markdownPath, htmlPath };
}

/**
 * Grava `reports/day-2/baseline.json`.
 *
 * @param {object} input
 * @returns {{ path: string, baseline: object }}
 */
export function writeBaseline({ summary, commitSha = 'unknown', outDir = DAY2_REPORT_DIR, now = () => new Date() }) {
  mkdirSync(outDir, { recursive: true });

  const baseline = baselineSchema.parse({
    sampleCount: summary.sampleCount,
    latencyP95Ms: summary.latencyP95Ms,
    errorRate: summary.errorRate,
    logLinesPerRequest: summary.logLinesPerRequest,
    responseSizeP95Bytes: summary.responseSizeP95Bytes,
    createdAt: now().toISOString(),
    commitSha,
  });

  const path = join(outDir, 'baseline.json');
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');

  return { path, baseline };
}

/* ------------------------------------------------------------------------- */
/* Formatação de valores                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Formata o valor de um sinal na unidade que faz sentido lê-lo.
 *
 * `errorRate` vira porcentagem porque `0,1667` não é lido por ninguém como "uma
 * requisição em seis"; bytes ganham separador de milhar pelo mesmo motivo.
 *
 * @param {object} evaluation
 * @param {number} value
 * @returns {string}
 */
export function formatSignalValue(evaluation, value) {
  const number = Number(value) || 0;

  if (evaluation.id === 'error_rate') {
    return `${formatNumber(number * 100, 2)}%`;
  }
  if (evaluation.id === 'payload_size') {
    return `${formatNumber(Math.round(number), 0)} bytes`;
  }
  if (evaluation.id === 'latency') {
    return `${formatNumber(number, 2)} ms`;
  }
  return formatNumber(number, 2);
}

/**
 * A diferença, com sinal explícito. `+` importa: sem ele, "0,02" numa linha
 * chamada "diferença" pode ser lido como queda.
 *
 * @param {object} evaluation
 * @returns {string}
 */
export function formatDifference(evaluation) {
  const value = Number(evaluation.difference) || 0;
  const sign = value > 0 ? '+' : '';

  if (evaluation.id === 'error_rate') {
    return `${sign}${formatNumber(value * 100, 2)} p.p.`;
  }
  return `${sign}${formatSignalValue(evaluation, value)}`;
}

function formatNumber(value, digits) {
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value) || 0);
}

/* ------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * O mesmo conteúdo do painel, em texto — para Job Summary, colagem em ticket e
 * leitura no terminal.
 *
 * Fecha com `redactCredentialMaterial`, nunca com `redactSecrets`: os campos já
 * foram redigidos um a um, e aplicar a regra de `chave: valor` sobre o Markdown
 * pronto faria o relatório mascarar os próprios rótulos de consumo de tokens.
 * Ver `redact-secrets.mjs`.
 *
 * @param {object} report
 * @returns {string}
 */
export function renderAnomalyMarkdown(report) {
  const { detection, explanation } = report;
  const banner = detection.anomalyDetected ? 'ANOMALIA DETECTADA' : 'NORMAL';

  const lines = [
    '# Laboratório de anomalias — Dia 2',
    '',
    `**Resultado:** ${banner} (\`gateResult: ${detection.gateResult}\`)`,
    '',
    `- Commit: \`${report.commitSha}\``,
    `- Rota observada: \`${report.observation.path}\` na porta ${report.observation.port}`,
    `- Requisições medidas: ${report.observed.requestCount} (aquecimento descartado: ${report.observation.warmupRequests})`,
    `- Sinal que disparou primeiro: ${detection.firstAnomalousSignal ? `\`${detection.firstAnomalousSignal}\`` : '—'}`,
    `- Origem da explicação: ${report.usedFallback ? 'gerador determinístico (sem modelo)' : 'modelo, com saída validada por schema'}`,
    `- Gerado em: ${report.generatedAt}`,
    '',
    '## Sinais',
    '',
    '| Sinal | Baseline | Observado | Diferença | Regra | Status |',
    '| --- | --- | --- | --- | --- | --- |',
    ...detection.evaluations.map(
      (item) =>
        `| ${item.label} | ${formatSignalValue(item, item.baselineValue)} | ` +
        `${formatSignalValue(item, item.observedValue)} | ${formatDifference(item)} | ` +
        `${item.rule} | ${item.triggered ? '**ANOMALIA**' : item.statusText} |`,
    ),
    '',
    '## Amostras',
    '',
    '| # | HTTP | Duração (ms) | Resposta (bytes) | Linhas de log |',
    '| --- | --- | --- | --- | --- |',
    ...report.samples.map(
      (sample) =>
        `| ${sample.sequence} | ${sample.statusCode === 0 ? 'sem resposta' : sample.statusCode} | ` +
        `${formatNumber(sample.durationMs, 2)} | ${formatNumber(sample.responseSizeBytes, 0)} | ${sample.logLineCount} |`,
    ),
    '',
    '## Evidências do log',
    '',
    ...(report.evidence.length > 0
      ? report.evidence.flatMap((item) => [`- **${item.source}**`, '', '  ```json', `  ${item.excerpt}`, '  ```', ''])
      : ['_Nenhuma linha de log foi coletada._', '']),
    '## Explicação',
    '',
    explanation.summary,
    '',
    explanation.interpretation,
    '',
    '## Causa provável',
    '',
    explanation.probableCause ?? '_Não se aplica: nenhuma regra de anomalia disparou._',
    '',
    '## Ações recomendadas',
    '',
    ...(explanation.recommendedActions.length > 0
      ? explanation.recommendedActions.map((action, index) => `${index + 1}. ${action}`)
      : ['_Nenhuma. A execução está dentro da baseline._']),
    '',
    '## Limitações',
    '',
    ...report.limitations.map((limitation) => `- ${limitation}`),
    '',
    '---',
    '',
    `Modelo: \`${report.model}\` · Fallback: \`${report.usedFallback}\`` +
      `${report.modelErrorCategory ? ` · Falha da chamada: \`${report.modelErrorCategory}\`` : ''}` +
      ` · Tokens: ${report.modelUsage?.totalTokens ?? 'n/d'}`,
    '',
    'O detector é determinístico. O modelo explica o resultado; ele não o decide.',
    '',
  ];

  return redactCredentialMaterial(lines.join('\n'));
}

/* ------------------------------------------------------------------------- */
/* HTML                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * O painel. Um arquivo, autônomo, sem dependência de rede.
 *
 * @param {object} report
 * @returns {string} documento HTML completo
 */
export function renderAnomalyHtml(report) {
  const { detection, explanation } = report;
  const anomaly = detection.anomalyDetected;
  const banner = anomaly ? 'ANOMALIA DETECTADA' : 'NORMAL';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Laboratório de anomalias — Dia 2 · ${escapeHtml(report.commitSha.slice(0, 7))}</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#conteudo">Pular para o conteúdo</a>

<header class="hero ${anomaly ? 'is-anomaly' : 'is-normal'}">
  <p class="eyebrow">Detecção visual de anomalias · Dia 2</p>
  <p class="banner" role="status">${escapeHtml(banner)}</p>
  <p class="banner-hint">${
    anomaly
      ? `Primeiro sinal a disparar: <code>${escapeHtml(detection.firstAnomalousSignal ?? '—')}</code> · ${detection.anomalyTypes.length} de 4 sinais fora da baseline`
      : 'Nenhuma das quatro regras foi satisfeita nas duas condições exigidas.'
  }</p>
  <dl class="meta">
    ${metaItem('Resultado do gate', detection.gateResult)}
    ${metaItem('Commit', report.commitSha.slice(0, 7))}
    ${metaItem('Rota observada', `${report.observation.path} :${report.observation.port}`)}
    ${metaItem('Requisições medidas', String(report.observed.requestCount))}
    ${metaItem('Aquecimento descartado', String(report.observation.warmupRequests))}
    ${metaItem('Correlação do log', report.observation.logCorrelation === 'request_id' ? 'por requestId' : 'média da janela')}
    ${metaItem('Origem da explicação', report.usedFallback ? 'gerador determinístico' : 'modelo (saída validada)')}
    ${metaItem('Gerado em', report.generatedAt)}
  </dl>
</header>

<main id="conteudo">

<section aria-labelledby="sinais">
  <h2 id="sinais">Os quatro sinais</h2>
  <p class="hint">Cada regra exige <strong>duas</strong> condições ao mesmo tempo: variação relativa <em>e</em> diferença absoluta. Satisfazer só uma delas não é anomalia — e o cartão mostra qual das duas não fechou.</p>
  <div class="cards">
    ${detection.evaluations.map(renderCard).join('\n    ')}
  </div>
</section>

<section aria-labelledby="faixa">
  <h2 id="faixa">As ${report.samples.length} requisições medidas</h2>
  <p class="hint">Altura proporcional à duração. Passe o cursor sobre uma barra para ver o código HTTP e a duração; clique para ir até a linha correspondente na tabela.</p>
  ${renderStrip(report)}
  <details class="table-wrap">
    <summary>Tabela completa das amostras</summary>
    <table>
      <caption>Uma linha por requisição medida. O aquecimento não aparece aqui: ele foi descartado antes da medição.</caption>
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">HTTP</th>
          <th scope="col">Duração (ms)</th>
          <th scope="col">Resposta (bytes)</th>
          <th scope="col">Linhas de log</th>
        </tr>
      </thead>
      <tbody>
        ${report.samples.map(renderSampleRow).join('\n        ')}
      </tbody>
    </table>
  </details>
</section>

<section aria-labelledby="evidencias">
  <h2 id="evidencias">Evidências do log <span class="tag">[FATO]</span></h2>
  <p class="hint">Linhas do log estruturado da aplicação, como foram emitidas. Prioridade para o que a própria aplicação marcou como <code>error</code> ou <code>warn</code>.</p>
  ${
    report.evidence.length > 0
      ? `<ol class="evidence">${report.evidence
          .map(
            (item) =>
              `<li><span class="source">${escapeHtml(item.source)}</span><pre>${escapeTruncated(item.excerpt, 400)}</pre></li>`,
          )
          .join('')}</ol>`
      : '<p class="empty">Nenhuma linha de log foi coletada nesta observação.</p>'
  }
</section>

<section aria-labelledby="explicacao">
  <h2 id="explicacao">Explicação <span class="tag">[${report.usedFallback ? 'DETERMINÍSTICO' : 'MODELO'}]</span></h2>
  <p class="origin">${
    report.usedFallback
      ? 'Produzida pelo gerador determinístico, a partir das mesmas regras que produziram o veredito.'
      : `Produzida por <code>${escapeHtml(report.model)}</code>, com saída validada por schema e evidências conferidas contra o material coletado.`
  }</p>
  <p class="lead">${escapeHtml(explanation.summary)}</p>
  <p>${escapeHtml(explanation.interpretation)}</p>
</section>

<section aria-labelledby="causa">
  <h2 id="causa">Causa provável <span class="tag">[INFERÊNCIA]</span></h2>
  ${
    explanation.probableCause
      ? `<p>${escapeHtml(explanation.probableCause)}</p>`
      : '<p class="empty">Não se aplica: nenhuma regra de anomalia disparou, e uma execução dentro da baseline não tem causa a explicar.</p>'
  }
</section>

<section aria-labelledby="acoes">
  <h2 id="acoes">Ações recomendadas <span class="tag">[RECOMENDAÇÃO]</span></h2>
  ${
    explanation.recommendedActions.length > 0
      ? `<ol class="actions">${explanation.recommendedActions.map((action) => `<li>${escapeHtml(action)}</li>`).join('')}</ol>`
      : '<p class="empty">Nenhuma. A execução está dentro da baseline.</p>'
  }
</section>

<section aria-labelledby="limitacoes">
  <h2 id="limitacoes">Limitações <span class="tag">[LIMITAÇÃO]</span></h2>
  <ul class="limitations">
    ${report.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join('\n    ')}
  </ul>
</section>

</main>

<footer>
  <p>Modelo: <code>${escapeHtml(report.model)}</code> · Fallback: <code>${escapeHtml(String(report.usedFallback))}</code>${
    report.modelErrorCategory ? ` · Falha da chamada: <code>${escapeHtml(report.modelErrorCategory)}</code>` : ''
  } · Tokens: ${escapeHtml(String(report.modelUsage?.totalTokens ?? 'n/d'))}</p>
  <p><strong>O detector é determinístico.</strong> O modelo explica o resultado; ele não o decide. Nenhum dos cinco campos do veredito é escrito pelo modelo.</p>
</footer>
</body>
</html>
`;
}

/**
 * Um cartão: baseline, observado, diferença, regra e status textual.
 *
 * @param {object} evaluation
 * @returns {string}
 */
function renderCard(evaluation) {
  return `<article class="card status-${escapeHtml(evaluation.status)}">
      <h3>${escapeHtml(evaluation.label)}</h3>
      <p class="signal-key"><code>${escapeHtml(evaluation.signal)}</code></p>
      <dl class="values">
        <div><dt>Baseline</dt><dd>${escapeHtml(formatSignalValue(evaluation, evaluation.baselineValue))}</dd></div>
        <div><dt>Observado</dt><dd class="observed">${escapeHtml(formatSignalValue(evaluation, evaluation.observedValue))}</dd></div>
        <div><dt>Diferença</dt><dd>${escapeHtml(formatDifference(evaluation))}</dd></div>
        <div><dt>Proporção</dt><dd>${evaluation.ratio === null ? '—' : `${escapeHtml(String(evaluation.ratio))}×`}</dd></div>
      </dl>
      <p class="rule-label">Regra</p>
      <ul class="conditions">
        ${evaluation.conditions
          .map(
            (condition) =>
              `<li class="${condition.met ? 'met' : 'unmet'}"><span aria-hidden="true">${condition.met ? '✓' : '✗'}</span> ${escapeHtml(stripBold(condition.text))} <em>(${condition.met ? 'satisfeita' : 'não satisfeita'})</em></li>`,
          )
          .join('\n        ')}
      </ul>
      <p class="status-text">${escapeHtml(evaluation.statusText.toUpperCase())}</p>
      <p class="hint small">${escapeHtml(SIGNAL_HINTS[evaluation.id] ?? '')}</p>
    </article>`;
}

/**
 * A faixa visual. Sem biblioteca: altura em porcentagem sobre a maior duração da
 * própria execução, com uma linha tracejada no valor do P95.
 *
 * @param {object} report
 * @returns {string}
 */
function renderStrip(report) {
  const durations = report.samples.map((sample) => Number(sample.durationMs) || 0);
  const max = Math.max(...durations, 1);
  const p95 = Number(report.observed.latencyP95Ms) || 0;
  const p95Percent = clampPercent((p95 / max) * 100);

  const bars = report.samples
    .map((sample) => {
      const height = clampPercent((Number(sample.durationMs) / max) * 100);
      const error = sample.statusCode === 0 || sample.statusCode >= 400;
      const title =
        `#${sample.sequence} · HTTP ${sample.statusCode === 0 ? 'sem resposta' : sample.statusCode} · ` +
        `${formatNumber(sample.durationMs, 2)} ms · ${formatNumber(sample.responseSizeBytes, 0)} bytes`;

      return `<a class="bar${error ? ' bar-error' : ''}" href="#amostra-${sample.sequence}" style="height:${height}%" title="${escapeHtml(title)}"><span class="sr">${escapeHtml(title)}</span></a>`;
    })
    .join('');

  return `<div class="strip-wrap">
    <div class="strip" role="img" aria-label="Duração de cada uma das ${report.samples.length} requisições medidas">
      <div class="p95-line" style="bottom:${p95Percent}%"><span>P95 = ${escapeHtml(formatNumber(p95, 2))} ms</span></div>
      ${bars}
    </div>
    <p class="strip-legend"><span class="swatch"></span> requisição com resposta 2xx/3xx · <span class="swatch swatch-error"></span> requisição com erro (HTTP ≥ 400 ou sem resposta) · escala relativa ao maior valor desta execução (${escapeHtml(formatNumber(max, 2))} ms)</p>
  </div>`;
}

function renderSampleRow(sample) {
  const error = sample.statusCode === 0 || sample.statusCode >= 400;
  return `<tr id="amostra-${sample.sequence}"${error ? ' class="row-error"' : ''}>
          <th scope="row">${sample.sequence}</th>
          <td>${sample.statusCode === 0 ? 'sem resposta' : sample.statusCode}</td>
          <td>${escapeHtml(formatNumber(sample.durationMs, 2))}</td>
          <td>${escapeHtml(formatNumber(sample.responseSizeBytes, 0))}</td>
          <td>${escapeHtml(String(sample.logLineCount))}</td>
        </tr>`;
}

function metaItem(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function stripBold(text) {
  return String(text).replace(/\*\*/g, '');
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 2;
  return Math.min(100, Math.max(2, Math.round(value * 100) / 100));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const STYLES = `
:root {
  --ink: #14171f;
  --muted: #5c6472;
  --line: #dfe3ea;
  --bg: #f4f6fa;
  --card: #ffffff;
  --ok: #1f7a4d;
  --ok-soft: #e6f5ed;
  --warn: #8a5b00;
  --warn-soft: #fdf3e0;
  --bad: #b3261e;
  --bad-soft: #fdeceb;
  --accent: #2c4bd0;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 0 4rem;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 1rem; top: 1rem; background: #fff; padding: .5rem 1rem; z-index: 10; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
main, .hero { max-width: 1080px; margin: 0 auto; padding: 0 1.25rem; }
.hero { padding-top: 2.5rem; padding-bottom: 2rem; }
.eyebrow { margin: 0; text-transform: uppercase; letter-spacing: .12em; font-size: .72rem; color: var(--muted); }
.banner {
  margin: .5rem 0 .35rem;
  font-size: clamp(1.7rem, 5vw, 2.6rem);
  font-weight: 800;
  letter-spacing: -.01em;
  padding: .6rem 1.1rem;
  border-radius: 12px;
  display: inline-block;
  border: 2px solid;
}
.is-normal .banner { color: var(--ok); background: var(--ok-soft); border-color: var(--ok); }
.is-anomaly .banner { color: var(--bad); background: var(--bad-soft); border-color: var(--bad); }
.banner-hint { margin: .25rem 0 1.25rem; color: var(--muted); }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: .75rem 1.25rem; margin: 0; }
.meta dt { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.meta dd { margin: .1rem 0 0; font-weight: 600; word-break: break-word; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1.5rem; margin: 0 0 1.25rem; }
h2 { margin: 0 0 .4rem; font-size: 1.2rem; }
h3 { margin: 0 0 .1rem; font-size: 1rem; }
.tag { font-size: .68rem; letter-spacing: .08em; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: .15rem .5rem; vertical-align: middle; }
.hint { color: var(--muted); margin: 0 0 1rem; font-size: .9rem; }
.hint.small { font-size: .78rem; margin: .6rem 0 0; }
.empty { color: var(--muted); font-style: italic; margin: 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; background: #eef1f6; padding: .1rem .3rem; border-radius: 4px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
.card { border: 1px solid var(--line); border-left: 5px solid var(--line); border-radius: 10px; padding: 1rem; background: #fff; }
.card.status-normal { border-left-color: var(--ok); }
.card.status-relative_only, .card.status-absolute_only { border-left-color: var(--warn); }
.card.status-anomaly { border-left-color: var(--bad); background: var(--bad-soft); }
.signal-key { margin: 0 0 .75rem; }
.values { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem .75rem; margin: 0 0 .9rem; }
.values dt { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.values dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.values .observed { font-size: 1.15rem; }
.rule-label { margin: 0 0 .3rem; font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.conditions { list-style: none; margin: 0 0 .8rem; padding: 0; font-size: .84rem; }
.conditions li { padding: .15rem 0; }
.conditions .met { color: var(--bad); font-weight: 600; }
.conditions .unmet { color: var(--muted); }
.card.status-normal .conditions .met { color: var(--warn); }
.conditions em { font-style: normal; opacity: .8; }
.status-text { margin: 0; font-size: .78rem; font-weight: 800; letter-spacing: .05em; }
.card.status-normal .status-text { color: var(--ok); }
.card.status-relative_only .status-text, .card.status-absolute_only .status-text { color: var(--warn); }
.card.status-anomaly .status-text { color: var(--bad); }
.strip-wrap { margin: 0 0 1rem; }
.strip {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 190px;
  padding: .5rem;
  background: linear-gradient(#fbfcfe, #f1f4f9);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.bar { flex: 1 1 0; min-width: 6px; background: var(--accent); border-radius: 3px 3px 0 0; opacity: .85; display: block; }
.bar:hover, .bar:focus { opacity: 1; outline: 2px solid var(--ink); outline-offset: 1px; }
.bar-error { background: var(--bad); }
.p95-line { position: absolute; left: .5rem; right: .5rem; border-top: 2px dashed var(--muted); pointer-events: none; }
.p95-line span { position: absolute; right: 0; top: -1.35rem; font-size: .7rem; color: var(--muted); background: #fff; padding: 0 .35rem; border-radius: 4px; }
.strip-legend { margin: .5rem 0 0; font-size: .78rem; color: var(--muted); }
.swatch { display: inline-block; width: .7rem; height: .7rem; background: var(--accent); border-radius: 2px; vertical-align: baseline; }
.swatch-error { background: var(--bad); }
.table-wrap summary { cursor: pointer; font-weight: 600; font-size: .9rem; }
table { width: 100%; border-collapse: collapse; margin-top: .75rem; font-size: .88rem; }
caption { caption-side: top; text-align: left; color: var(--muted); font-size: .8rem; padding-bottom: .5rem; }
th, td { border-bottom: 1px solid var(--line); padding: .4rem .5rem; text-align: right; font-variant-numeric: tabular-nums; }
th[scope="col"] { text-align: right; color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; }
th[scope="row"] { text-align: left; }
tr:target { background: #fff6cc; }
tr.row-error td, tr.row-error th { color: var(--bad); font-weight: 600; }
.evidence { margin: 0; padding-left: 1.25rem; }
.evidence li { margin-bottom: .85rem; }
.evidence .source { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
pre { margin: .3rem 0 0; padding: .65rem .8rem; background: #12151c; color: #e7ebf3; border-radius: 8px; overflow-x: auto; font-size: .78rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.origin { color: var(--muted); font-size: .85rem; margin: 0 0 .8rem; }
.lead { font-size: 1.05rem; font-weight: 600; margin: 0 0 .6rem; }
.actions, .limitations { margin: 0; padding-left: 1.25rem; }
.actions li, .limitations li { margin-bottom: .4rem; }
footer { max-width: 1080px; margin: 0 auto; padding: 0 1.25rem; color: var(--muted); font-size: .82rem; }
footer p { margin: .3rem 0; }
@media print {
  body { background: #fff; }
  section { break-inside: avoid; }
}
`;
