import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { predictionReportSchema } from '../schemas/day-3-prediction-schema.mjs';
import { FEATURE_NAMES } from '../src/day3/features.mjs';
import { findDefinition } from '../src/day3/predict.mjs';
import { renderModelEvaluationHtml, renderPredictionHtml, renderPredictionMarkdown } from '../src/day3/report.mjs';
import { buildPredictionReport, prepare, runScenario } from '../src/day3/run.mjs';

const outDir = mkdtempSync(join(tmpdir(), 'day3-report-'));
const { model, summary } = prepare({ outDir });

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

/** Um cliente que devolve o texto pedido, para exercitar o caminho do modelo. */
function clientReturning(text) {
  return {
    responses: {
      parse: async () => ({
        status: 'completed',
        id: 'resp_teste',
        model: 'gpt-5-mini',
        output_parsed: {
          summary: text,
          evidence: [text],
          interpretation: text,
          recommendedActions: [text],
          limitations: [text],
        },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    },
  };
}

async function reportWithText(text) {
  const definition = findDefinition('scenarios', 'latency-growth');
  return buildPredictionReport({
    kind: 'scenario',
    id: definition.id,
    title: definition.title,
    description: definition.description,
    model,
    summary,
    windows: definition.windows,
    revealed: true,
    env: { OPENAI_API_KEY: 'sk-teste-nao-usada' },
    client: clientReturning(text),
  });
}

describe('artefatos do treino', () => {
  it('grava model.json, training-summary.json e model-evaluation.html', () => {
    const summaryOnDisk = JSON.parse(readFileSync(join(outDir, 'training-summary.json'), 'utf8'));
    const modelOnDisk = JSON.parse(readFileSync(join(outDir, 'model.json'), 'utf8'));
    const html = readFileSync(join(outDir, 'model-evaluation.html'), 'utf8');

    expect(modelOnDisk.featureNames).toEqual([...FEATURE_NAMES]);
    expect(summaryOnDisk.sequences.trainIds.length).toBe(summaryOnDisk.sequences.train);
    expect(summaryOnDisk.sequences.testIds.length).toBe(summaryOnDisk.sequences.test);
    expect(html).toContain('<!doctype html>');
  });

  it('o painel de avaliação mostra tudo o que a aula precisa discutir', () => {
    const html = renderModelEvaluationHtml(summary);

    expect(html).toContain('Sequências de treino');
    expect(html).toContain('Sequências de teste');
    expect(html).toContain('Matriz de confusão');
    expect(html).toMatch(/>TP</);
    expect(html).toMatch(/>FN</);
    expect(html).toMatch(/Acurácia/);
    expect(html).toMatch(/Precisão/);
    expect(html).toMatch(/Recall/);
    expect(html).toMatch(/>F1</);
    expect(html).toContain('failureWithinNext2Windows');
    expect(html).toContain('Dados sintéticos');
    expect(html).toContain('Pesos do modelo');
    expect(html).toContain('Distribuição das probabilidades');
    for (const feature of FEATURE_NAMES) expect(html).toContain(feature);
  });

  it('não é servido por CDN nem depende de rede', () => {
    const html = renderModelEvaluationHtml(summary);
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe('relatório de previsão', () => {
  it('grava os três formatos e valida contra o schema', async () => {
    const { report, paths } = await runScenario({
      id: 'transient-spike',
      model,
      summary,
      outDir,
      env: {},
    });

    expect(() => predictionReportSchema.parse(report)).not.toThrow();
    expect(paths.json).toMatch(/scenarios\/transient-spike\/prediction\.json$/);
    expect(readFileSync(paths.markdown, 'utf8')).toContain('# ');
    expect(readFileSync(paths.html, 'utf8')).toContain('<!doctype html>');
  });

  it('o painel traz os treze blocos exigidos', async () => {
    const { report } = await runScenario({ id: 'latency-growth', model, summary, outDir, env: {} });
    const html = renderPredictionHtml(report);

    expect(html).toContain(report.title);
    expect(html).toContain('de probabilidade de falha');
    expect(html).toContain('limiar 70.0%');
    expect(html).toContain('Falha provável — mitigar');
    expect(html).toContain('Latência p95 (ms)');
    expect(html).toContain('Taxa de erro');
    expect(html).toContain('Linhas de log por requisição');
    expect(html).toContain('Probabilidade de falha por janela');
    expect(html).toContain('1º alerta');
    expect(html).toContain('falha real');
    expect(html).toContain('Fatores de risco');
    expect(html).toContain('Janelas analisadas');
    expect(html).toContain('fatos observados');
    expect(html).toContain('interpretação e hipóteses');
    expect(html).toContain('causa confirmada');
    expect(html).toContain('recomendações');
    expect(html).toContain('limitações');
    expect(html).toContain('Dados sintéticos');
  });

  it('não depende só de cor: cada faixa tem ícone e texto', async () => {
    const { report } = await runScenario({ id: 'latency-growth', model, summary, outDir, env: {} });
    const html = renderPredictionHtml(report);

    expect(html).toContain('■');
    expect(html).toContain('Risco baixo — observar');
    expect(html).toContain('Falha provável — mitigar');
    // O marcador do ponto no gráfico muda de forma, não só de cor.
    expect(html).toContain('class="dot dot-likely"');
    expect(html).toContain('<rect');
  });

  it('o SVG é acessível: título, descrição e role', async () => {
    const { report } = await runScenario({ id: 'error-growth', model, summary, outDir, env: {} });
    const html = renderPredictionHtml(report);

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-labelledby="t-prob d-prob"');
    expect(html).toMatch(/<desc id="d-prob">janela 0:/);
  });

  it('o Markdown separa fato, interpretação, causa e limitação', async () => {
    const { report } = await runScenario({ id: 'latency-growth', model, summary, outDir, env: {} });
    const markdown = renderPredictionMarkdown(report);

    expect(markdown).toContain('**[FATOS]**');
    expect(markdown).toContain('**[INTERPRETAÇÃO]**');
    expect(markdown).toContain('**[CAUSA CONFIRMADA]**');
    expect(markdown).toContain('Nenhuma.');
    expect(markdown).toContain('**[LIMITAÇÕES]**');
  });
});

describe('conteúdo não confiável', () => {
  it('escapa HTML vindo do texto do modelo', async () => {
    const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const report = await reportWithText(payload);
    const html = renderPredictionHtml(report);

    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('onerror=alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });

  it('escapa aspas e crase, que fecham atributo', async () => {
    const report = await reportWithText('" onmouseover="alert(1)` `');
    const html = renderPredictionHtml(report);

    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#96;');
  });

  it('mascara segredo devolvido pelo modelo, nos três formatos', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123';
    const report = await reportWithText(`A chave é ${secret} e o token é ghp_abcdefghijklmnopqrst.`);

    const serialized = JSON.stringify(report);
    const html = renderPredictionHtml(report);
    const markdown = renderPredictionMarkdown(report);

    for (const output of [serialized, html, markdown]) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain('ghp_abcdefghijklmnopqrst');
      expect(output).toContain('[REDACTED]');
    }
  });

  it('nenhum relatório carrega variável de ambiente', async () => {
    const { report } = await runScenario({
      id: 'latency-growth',
      model,
      summary,
      outDir,
      env: { OPENAI_API_KEY: 'sk-nunca-deveria-aparecer', SECRET_TOKEN: 'valor-secreto' },
      client: clientReturning('Texto normal, sem segredo.'),
    });

    const serialized = JSON.stringify(report) + renderPredictionHtml(report) + renderPredictionMarkdown(report);
    expect(serialized).not.toContain('sk-nunca-deveria-aparecer');
    expect(serialized).not.toContain('valor-secreto');
    expect(serialized).not.toContain('OPENAI_API_KEY');
  });
});

describe('números publicados', () => {
  it('nenhum relatório contém NaN, Infinity ou undefined', async () => {
    for (const id of ['latency-growth', 'error-growth', 'log-growth', 'transient-spike']) {
      const { report, paths } = await runScenario({ id, model, summary, outDir, env: {} });
      const files = [paths.json, paths.markdown, paths.html].map((path) => readFileSync(path, 'utf8'));

      for (const content of [JSON.stringify(report), ...files]) {
        expect(content).not.toMatch(/\bNaN\b/);
        expect(content).not.toMatch(/\bInfinity\b/);
        expect(content).not.toMatch(/\bundefined\b/);
      }
    }
  });

  it('o campo `origin` declara de onde veio a explicação', async () => {
    const fallback = await runScenario({ id: 'log-growth', model, summary, outDir, env: {} });
    expect(fallback.report.explanation.origin).toBe('fallback');
    expect(renderPredictionHtml(fallback.report)).toContain('fallback determinístico');

    const fromModel = await reportWithText('Texto do modelo.');
    expect(fromModel.explanation.origin).toBe('openai');
    expect(renderPredictionHtml(fromModel)).toContain('validada por schema');
  });
});
