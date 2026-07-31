/**
 * O relatório HTML nas suas duas formas — compacto no verde, detalhado no
 * vermelho — e a segurança que vale para as duas.
 *
 * Todo conteúdo daqui é **não confiável**: log de CI, saída da Railway CLI,
 * mensagem de erro da aplicação e texto de um modelo de linguagem. O arquivo é
 * baixado de um artefato e aberto num navegador; um `<script>` que sobrevive ao
 * escape é código executando na máquina de quem foi ler o relatório.
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyzeOperational } from '../src/analyze-operational.mjs';
import { loadFixtureContext, writeOperationalReports } from '../src/operational-report.mjs';
import { buildPipelineExecution } from '../src/pipeline-execution.mjs';
import { renderOperationalHtml } from '../src/render-operational-html.mjs';
import { renderOperationalReport } from '../src/render-operational-report.mjs';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-report-'));
  tempDirs.push(dir);
  return dir;
}

/** Diagnóstico + execução de um cenário versionado, sem tocar a rede. */
async function build(scenario, { scope } = {}) {
  const context = loadFixtureContext(scenario);
  const { diagnosis } = await analyzeOperational({ context, env: {} });
  const resolvedScope = scope ?? (context.sourceCoverage.smokeTest ? 'cd' : 'ci');
  const execution = buildPipelineExecution({ diagnosis, context, scope: resolvedScope });

  return { context, diagnosis, execution };
}

async function html(scenario, options) {
  const { diagnosis, context, execution } = await build(scenario, options);
  return renderOperationalHtml(diagnosis, context, execution);
}

/* ------------------------------------------------------------------------- */
/* 48–52 · Segurança                                                          */
/* ------------------------------------------------------------------------- */

describe('escape e injeção no relatório de execução', () => {
  /** Uma execução com carga hostil em todo campo de texto que o modelo produz. */
  async function poisoned(payload) {
    const { diagnosis, context, execution } = await build('cd-functional-failure');

    return renderOperationalHtml(diagnosis, context, {
      ...execution,
      failureExplanation: {
        ...execution.failureExplanation,
        label: payload,
        whatHappened: payload,
        probableCause: payload,
        recommendedActions: [payload],
        limitations: [payload],
        notReachedStages: [payload],
      },
      stages: execution.stages.map((stage) => ({ ...stage, label: payload })),
    });
  }

  const PAYLOADS = [
    '<script>alert("xss")</script>',
    '"><script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    "<svg/onload=alert('xss')>",
    '<iframe src="javascript:alert(1)"></iframe>',
    '</title><script>alert(1)</script>',
    '<style>body{display:none}</style>',
    '<a href="javascript:alert(1)">clique</a>',
    '\'"--></style></script><script>alert(1)</script>',
    '</summary></details><script>alert(1)</script>',
    '</li></ol><script>alert(1)</script>',
  ];

  it('48. escapa todo campo da linha do tempo e da explicação', async () => {
    for (const payload of PAYLOADS) {
      const output = await poisoned(payload);

      expect(output.match(/<script/g), `payload passou: ${payload}`).toBeNull();
      expect(output).not.toContain('<iframe');
      expect(output).not.toContain('href="javascript:');
      expect(output).toContain('&lt;');
    }
  });

  it('49. nenhum payload vira script executável', async () => {
    const output = await poisoned('<script>alert("xss")</script>');

    // A única `<style>` é a nossa, no `<head>`.
    expect((output.match(/<style>/g) ?? []).length).toBe(1);
    expect(output).not.toContain('<script>alert');
  });

  it('50. atributos maliciosos não escapam do contexto', async () => {
    const output = await poisoned('" onmouseover="alert(1)');

    expect(output).not.toContain('onmouseover="alert(1)"');
    expect(output).toContain('&quot;');
  });

  it('51. nenhum segredo aparece no HTML nem no Markdown', async () => {
    const { diagnosis, context, execution } = await build('cd-functional-failure');

    const secrets = [
      'sk-proj-super-secreto-1234567890',
      'ghp_abcdefghijklmnop1234567890',
      'github_pat_11ABCDEFG0abcdefghijklmnop',
      'postgres://app:senha123@db.interno:5432/x',
    ];

    const envenenado = {
      ...execution,
      failureExplanation: {
        ...execution.failureExplanation,
        whatHappened: secrets.join(' '),
        probableCause: `Authorization: Bearer ${secrets[1]}`,
        recommendedActions: secrets.map((secret) => `use ${secret}`),
        limitations: [`vazou ${secrets[0]}`],
      },
    };

    const output = renderOperationalHtml(diagnosis, context, envenenado);
    const markdown = renderOperationalReport(diagnosis, context, envenenado);

    for (const secret of [
      'sk-proj-super-secreto-1234567890',
      'ghp_abcdefghijklmnop1234567890',
      'github_pat_11ABCDEFG0abcdefghijklmnop',
      'senha123',
    ]) {
      expect(output, `vazou no HTML: ${secret}`).not.toContain(secret);
      expect(markdown, `vazou no Markdown: ${secret}`).not.toContain(secret);
    }
  });

  it('52. string longa é truncada sem quebrar o documento', async () => {
    const { diagnosis, context, execution } = await build('cd-functional-failure');

    const output = renderOperationalHtml(diagnosis, context, {
      ...execution,
      failureExplanation: {
        ...execution.failureExplanation,
        whatHappened: 'x'.repeat(50_000),
        recommendedActions: ['y'.repeat(50_000)],
      },
    });

    expect(output).toContain('</html>');
    expect(output.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('é autônomo: sem CDN, script, fonte ou imagem externa', async () => {
    const output = await html('cd-functional-failure');

    expect(output).not.toMatch(/<script/i);
    expect(output).not.toMatch(/https?:\/\/[^"'\s]*\.(?:js|css|woff2?|png|jpg|svg)/i);
    expect(output).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
    expect(output).not.toMatch(/@import/i);
    expect(output).not.toMatch(/<img\s/i);
  });
});

/* ------------------------------------------------------------------------- */
/* 53 · Status não depende de cor                                             */
/* ------------------------------------------------------------------------- */

describe('a situação de cada etapa é legível sem cor', () => {
  it('53. cada etapa traz símbolo, texto e nome', async () => {
    const output = await html('ci-lint-failure');

    // Símbolo + texto, sempre juntos.
    for (const [symbol, text] of [
      ['✗', 'FAILURE'],
      ['✓', 'SUCCESS'],
      ['—', 'NOT REACHED'],
    ]) {
      expect(output, `símbolo ausente: ${symbol}`).toContain(symbol);
      expect(output, `texto ausente: ${text}`).toContain(text);
    }

    expect(output).toContain('Lint');
    expect(output).toContain('CD Gate');
    // O símbolo é decorativo; o texto é a informação.
    expect(output).toContain('class="stage-symbol" aria-hidden="true"');
  });

  it('53b. os cinco status têm símbolo e texto próprios no Markdown', async () => {
    const { diagnosis, context, execution } = await build('ci-lint-failure');

    const todos = {
      ...execution,
      stages: execution.stages.map((stage, index) => ({
        ...stage,
        status: ['success', 'failure', 'skipped', 'not_reached', 'unknown'][index % 5],
      })),
    };

    const markdown = renderOperationalReport(diagnosis, context, todos);

    for (const marker of ['✓ SUCCESS', '✗ FAILURE', '○ SKIPPED', '— NOT REACHED', '? UNKNOWN']) {
      expect(markdown, `marcador ausente: ${marker}`).toContain(marker);
    }
  });

  it('marca visualmente a primeira falha', async () => {
    const output = await html('cd-functional-failure');

    expect(output).toContain('stage-first-failure');
    expect(output).toContain('primeira falha');
  });
});

/* ------------------------------------------------------------------------- */
/* 54–55 · As duas formas do relatório                                        */
/* ------------------------------------------------------------------------- */

describe('54. execução saudável gera relatório compacto', () => {
  it('mostra cabeçalho, linha do tempo, resumo, cobertura, limitações e gate', async () => {
    const output = await html('success');

    for (const section of [
      'Linha do tempo da execução',
      'Resumo',
      'Cobertura das fontes',
      'Limitações',
      'CD Gate',
    ]) {
      expect(output, `seção ausente: ${section}`).toContain(section);
    }
  });

  it('não abre seção de causa provável nem de recomendações', async () => {
    const output = await html('success');

    expect(output).not.toContain('<h2 id="causa">');
    expect(output).not.toContain('<h2 id="recomendacoes">');
    expect(output).not.toContain('Explicação da falha');
  });

  it('recolhe fatos, inferências e linha do tempo detalhada', async () => {
    const output = await html('success');

    // Recolhido, não removido: a evidência continua a um clique.
    expect(output).toContain('fato(s) coletado(s) nesta execução');
    expect(output).toContain('inferência(s)');
    expect(output).toContain('evento(s) registrado(s)');
  });

  it('não inventa risco no texto do resumo', async () => {
    const { diagnosis, context, execution } = await build('success');
    const output = renderOperationalHtml(diagnosis, context, execution);

    // Só o parágrafo do resumo: o texto fixo da seção fala sobre não procurar
    // risco, e reprová-lo por citar a palavra seria reprovar a própria regra.
    const start = output.indexOf('<h2 id="resumo">');
    const paragrafo = output.slice(output.indexOf('<p class="summary">', start), output.indexOf('</p>', start));

    expect(paragrafo).toContain(execution.successSummary.slice(0, 40));
    for (const term of ['risco', 'alerta', 'instável', 'degrada', 'atenção']) {
      expect(paragrafo.toLowerCase(), `resumo verde citou "${term}"`).not.toContain(term);
    }
  });
});

describe('55. execução com falha gera relatório detalhado', () => {
  it('traz todas as seções obrigatórias da explicação', async () => {
    const output = await html('cd-functional-failure');

    for (const section of [
      'Linha do tempo da execução',
      'Explicação da falha',
      'Etapa afetada',
      'O que aconteceu',
      'Evidências',
      'Causa provável',
      'Ações recomendadas',
      'Confiança',
      'Limitações desta explicação',
      'Etapas não alcançadas',
    ]) {
      expect(output, `seção ausente: ${section}`).toContain(section);
    }
  });

  it('usa os rótulos textuais obrigatórios', async () => {
    const output = await html('cd-functional-failure');

    for (const label of ['[FATO]', '[EXPLICAÇÃO]', '[CAUSA PROVÁVEL]', '[AÇÃO RECOMENDADA]', '[LIMITAÇÃO]']) {
      expect(output, `rótulo ausente: ${label}`).toContain(label);
    }
  });

  it('não usa rótulos dos Dias 2 e 3', async () => {
    for (const scenario of ['success', 'ci-lint-failure', 'ci-tests-failure', 'ci-docker-failure', 'cd-functional-failure']) {
      const output = await html(scenario);

      for (const label of ['[ANOMALIA]', '[PREVISÃO]', '[RISCO FUTURO]', '[TENDÊNCIA]']) {
        expect(output, `${scenario} usou o rótulo ${label}`).not.toContain(label);
      }
    }
  });

  it('liga as evidências da explicação aos fatos observados', async () => {
    const { diagnosis, context, execution } = await build('cd-functional-failure');
    const output = renderOperationalHtml(diagnosis, context, execution);

    const ids = execution.failureExplanation.evidenceIds;
    expect(ids.length).toBeGreaterThan(0);

    for (const id of ids) {
      // O link existe na explicação e a âncora existe entre os fatos.
      expect(output, `link ausente para ${id}`).toContain(`href="#fato-${id}"`);
      expect(output, `âncora ausente para ${id}`).toContain(`id="fato-${id}"`);
    }
  });

  it('declara a decisão determinística do gate', async () => {
    const output = await html('cd-functional-failure');

    expect(output).toContain('decisão determinística, sem participação da análise por IA');
    expect(output).toContain('❌ reprovado');
  });

  it('o relatório de falha de CI mostra as etapas de CD como não alcançadas', async () => {
    const output = await html('ci-docker-failure');

    expect(output).toContain('NOT REACHED');
    expect(output).toContain('nunca começaram');
    expect(output).toContain('Não são falhas independentes');
  });
});

/* ------------------------------------------------------------------------- */
/* Geração dos arquivos                                                       */
/* ------------------------------------------------------------------------- */

describe('geração dos arquivos do relatório', () => {
  it('grava os dois nomes, com conteúdo idêntico', async () => {
    const { diagnosis, context, execution } = await build('cd-functional-failure');
    const outDir = tempDir();

    const { paths } = writeOperationalReports({ diagnosis, context, execution, outDir });

    expect(paths).toHaveLength(6);
    for (const path of paths) expect(existsSync(path)).toBe(true);

    for (const extension of ['json', 'md', 'html']) {
      const antigo = readFileSync(join(outDir, `operational-deployment-report.${extension}`), 'utf8');
      const novo = readFileSync(join(outDir, `pipeline-execution-report.${extension}`), 'utf8');
      expect(novo, `divergência em .${extension}`).toBe(antigo);
    }
  });

  it('o JSON carrega o diagnóstico e a execução', async () => {
    const { diagnosis, context, execution } = await build('ci-tests-failure');
    const outDir = tempDir();

    writeOperationalReports({ diagnosis, context, execution, outDir });
    const json = JSON.parse(readFileSync(join(outDir, 'pipeline-execution-report.json'), 'utf8'));

    expect(json.technicalStatus.ci).toBe('failure');
    expect(json.pipelineExecution.firstFailedStage).toBe('ci_tests');
    expect(json.pipelineExecution.gate).toEqual({
      type: 'ci',
      status: 'rejected',
      determinedBy: 'deterministic',
    });
  });

  it('constrói a execução sozinho quando não recebe uma pronta', async () => {
    const { diagnosis, context } = await build('success');
    const outDir = tempDir();

    const { execution } = writeOperationalReports({ diagnosis, context, outDir });

    expect(execution.scope).toBe('cd');
    expect(execution.overallStatus).toBe('success');
  });
});
