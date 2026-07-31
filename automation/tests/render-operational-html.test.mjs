import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyzeOperational } from '../src/analyze-operational.mjs';
import { escapeHtml, escapeTruncated, slug } from '../src/html-escape.mjs';
import { loadFixtureContext, writeOperationalReports } from '../src/operational-report.mjs';
import { renderOperationalHtml } from '../src/render-operational-html.mjs';
import { renderOperationalReport } from '../src/render-operational-report.mjs';
import { operationalDiagnosisSchema } from '../schemas/operational-diagnosis-schema.mjs';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'operational-report-'));
  tempDirs.push(dir);
  return dir;
}

/** Diagnóstico mínimo válido, para exercitar o renderizador isoladamente. */
function diagnosis(overrides = {}) {
  return operationalDiagnosisSchema.parse({
    analysisId: '1b3f9c2e-0d47-4a58-9e61-7c0824fb5a13',
    requestId: 'req-1',
    repository: 'senai/copa-figurinhas',
    commitSha: '4c1f9ab72e3d05b8a6c4f1e290d7b3568af02c19',
    deploymentId: 'dep-1',
    service: 'copa-figurinhas',
    environment: 'production',
    targetHost: 'copa-figurinhas-production.up.railway.app',
    technicalStatus: { overall: 'failure', ci: 'success', railwayDeployment: 'success', smokeTest: 'failure' },
    affectedPhase: 'functional',
    summary: 'Resumo.',
    observedFacts: [
      { id: 'F1', source: 'railway:runtime', phase: 'functional', timestamp: '2026-07-30T15:21:04.502Z', excerpt: 'erro' },
    ],
    inferences: [{ statement: 'Uma inferência.', supportedBy: ['F1'], confidence: 'high' }],
    probableCause: 'Uma causa.',
    causeStrength: 'probable',
    recommendedActions: ['Uma ação.'],
    limitations: ['Uma limitação.'],
    sourceCoverage: {
      ciLint: true,
      ciTests: true,
      ciBuild: true,
      ciDocker: true,
      railwayBuild: false,
      railwayDeploy: false,
      railwayRuntime: false,
      smokeTest: true,
    },
    correlationStatus: 'matched',
    expectedCommitSha: '4c1f9ab72e3d05b8a6c4f1e290d7b3568af02c19',
    observedCommitSha: '4c1f9ab72e3d05b8a6c4f1e290d7b3568af02c19',
    usedFallback: true,
    modelProvider: 'openai',
    model: 'gpt-5-mini',
    modelResponseId: null,
    modelLatencyMs: null,
    modelUsage: null,
    modelErrorCategory: null,
    generatedAt: '2026-07-30T15:22:00.000Z',
    ...overrides,
  });
}

/* ------------------------------------------------------------------------- */
/* Escape                                                                     */
/* ------------------------------------------------------------------------- */

describe('escapeHtml', () => {
  it('escapa os sete caracteres perigosos', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"aspas"')).toBe('&quot;aspas&quot;');
    expect(escapeHtml("'simples'")).toBe('&#39;simples&#39;');
    expect(escapeHtml('`crase`')).toBe('&#96;crase&#96;');
    expect(escapeHtml('a=b')).toBe('a&#61;b');
  });

  it('trata null e undefined como string vazia', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('corta antes de escapar, sem partir entidade ao meio', () => {
    const output = escapeTruncated('&&&&&&&&&&', 3);
    expect(output).toBe('&amp;&amp;&amp;…');
    expect(output).not.toMatch(/&am(?!p;)/);
  });

  it('slug só produz caracteres seguros para atributo', () => {
    expect(slug('Fase Afetada — runtime!')).toMatch(/^[a-z0-9-]+$/);
    expect(slug('')).toBe('secao');
    expect(slug('<script>alert(1)</script>')).toMatch(/^[a-z0-9-]+$/);
  });
});

/* ------------------------------------------------------------------------- */
/* Injeção de HTML                                                            */
/* ------------------------------------------------------------------------- */

describe('injeção de HTML', () => {
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
  ];

  it('neutraliza payload em todo campo de texto', () => {
    for (const payload of PAYLOADS) {
      const html = renderOperationalHtml(
        diagnosis({
          summary: payload,
          probableCause: payload,
          repository: payload,
          environment: payload,
          service: payload,
          targetHost: payload,
          deploymentId: payload,
          recommendedActions: [payload],
          limitations: [payload],
          observedFacts: [
            { id: 'F1', source: payload, phase: 'functional', timestamp: null, excerpt: payload },
          ],
          inferences: [{ statement: payload, supportedBy: ['F1'], confidence: 'high' }],
        }),
      );

      // Nenhuma tag executável nasce do conteúdo. A única `<style>` é a nossa,
      // no `<head>`, e o documento não tem `<script>` nenhum.
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<img src=x onerror');
      expect(html).not.toContain('<svg/onload');
      expect(html).not.toContain('<iframe');
      expect(html).not.toContain('href="javascript:');
      expect(html.match(/<script/g)).toBeNull();
      expect(html).toContain('&lt;');
    }
  });

  it('escapa payload vindo da linha do tempo e das evidências', () => {
    const html = renderOperationalHtml(diagnosis(), {
      timeline: [
        {
          source: '<script>a</script>',
          phase: 'runtime',
          timestamp: null,
          hasTimestamp: false,
          level: '"><script>b</script>',
          message: '<img src=x onerror=alert(1)>',
        },
      ],
      textSources: [
        { source: '</pre><script>c</script>', phase: 'runtime', content: '<script>d</script>' },
      ],
    });

    expect(html.match(/<script/g)).toBeNull();
    expect(html).not.toContain('onerror=alert');
  });

  it('escapa também no atributo datetime da linha do tempo', () => {
    const html = renderOperationalHtml(diagnosis(), {
      timeline: [
        {
          source: 's',
          phase: 'runtime',
          timestamp: '2026-01-01" onmouseover="alert(1)',
          hasTimestamp: true,
          level: 'info',
          message: 'm',
        },
      ],
      textSources: [],
    });

    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain('&quot;');
  });
});

/* ------------------------------------------------------------------------- */
/* Segredos                                                                   */
/* ------------------------------------------------------------------------- */

describe('segredos no relatório', () => {
  const SECRETS = [
    'sk-proj-super-secreto-1234567890',
    'ghp_abcdefghijklmnop1234567890',
    'github_pat_11ABCDEFG0abcdefghijklmnop',
    'Bearer abcdefghijklmnop1234',
    'postgres://app:senha123@db.interno:5432/x',
  ];

  it('nenhum valor sensível chega ao HTML nem ao Markdown', () => {
    const poisoned = diagnosis({
      summary: SECRETS.join(' '),
      probableCause: `Cookie: session=${SECRETS[1]}`,
      limitations: SECRETS.map((secret) => `vazou ${secret}`),
      recommendedActions: [`use ${SECRETS[0]}`],
      observedFacts: [
        { id: 'F1', source: 'railway:runtime', phase: 'functional', timestamp: null, excerpt: SECRETS.join(' | ') },
      ],
    });

    const html = renderOperationalHtml(poisoned);
    const markdown = renderOperationalReport(poisoned);

    for (const secret of ['sk-proj-super-secreto-1234567890', 'ghp_abcdefghijklmnop1234567890', 'github_pat_11ABCDEFG0abcdefghijklmnop', 'senha123']) {
      expect(html, `vazou no HTML: ${secret}`).not.toContain(secret);
      expect(markdown, `vazou no Markdown: ${secret}`).not.toContain(secret);
    }
    expect(html).toContain('[REDACTED]');
  });

  it('preserva o rótulo de consumo de tokens, que não é credencial', () => {
    const markdown = renderOperationalReport(
      diagnosis({
        usedFallback: false,
        modelUsage: { inputTokens: 1000, outputTokens: 300, reasoningTokens: 120, totalTokens: 1300 },
        modelLatencyMs: 1200,
        modelResponseId: 'resp_abc',
      }),
    );

    expect(markdown).toMatch(/Tokens: 1\.300/);
    expect(markdown).not.toMatch(/Tokens: \[REDACTED\]/);
  });
});

/* ------------------------------------------------------------------------- */
/* Estrutura e acessibilidade                                                 */
/* ------------------------------------------------------------------------- */

describe('estrutura do HTML', () => {
  const html = () => renderOperationalHtml(diagnosis(), loadFixtureContext('functional-failure'));

  it('é autônomo: sem CDN, script, fonte ou imagem externa', () => {
    const output = html();

    expect(output).not.toMatch(/<script/i);
    expect(output).not.toMatch(/https?:\/\/[^"'\s]*\.(?:js|css|woff2?|png|jpg|svg)/i);
    expect(output).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
    expect(output).not.toMatch(/@import/i);
    expect(output).not.toMatch(/<img\s/i);
    expect(output).toContain('<style>');
  });

  it('traz todas as seções obrigatórias', () => {
    const output = html();

    for (const section of [
      'Resultado por gate',
      'Cobertura das fontes',
      'Fase afetada',
      'Correlação da release',
      'Fatos observados',
      'Inferências',
      'Causa provável',
      'Recomendações',
      'Limitações',
      'Linha do tempo',
      'Evidências selecionadas',
      'Chamada ao modelo',
      'O que a IA não pode afirmar',
    ]) {
      expect(output, `seção ausente: ${section}`).toContain(section);
    }
  });

  it('usa rótulos textuais, não só cor', () => {
    const output = html();

    expect(output).toContain('[FATO]');
    expect(output).toContain('[INFERÊNCIA]');
    expect(output).toContain('[RECOMENDAÇÃO]');
    expect(output).toContain('[LIMITAÇÃO]');
  });

  it('mostra id, fonte, fase e trecho de cada fato', () => {
    const output = renderOperationalHtml(diagnosis());

    expect(output).toContain('id="fato-F1"');
    expect(output).toContain('railway:runtime');
    expect(output).toContain('functional');
    expect(output).toContain('2026-07-30T15:21:04.502Z');
  });

  it('marca o fato sem timestamp em vez de inventar um', () => {
    const output = renderOperationalHtml(
      diagnosis({
        observedFacts: [
          { id: 'F1', source: 'ci:tests', phase: 'ci_tests', timestamp: null, excerpt: 'algo' },
        ],
      }),
    );

    expect(output).toContain('sem timestamp registrado');
  });

  it('liga cada inferência aos fatos que a sustentam', () => {
    const output = renderOperationalHtml(diagnosis());
    expect(output).toContain('href="#fato-F1"');
    expect(output).toContain('Sustentada pelos fatos');
  });

  it('mostra a cobertura fonte a fonte', () => {
    const output = html();

    for (const label of ['CI lint', 'CI tests', 'CI build', 'Docker', 'Railway build', 'Railway deploy', 'Railway runtime', 'Smoke test']) {
      expect(output, `cobertura ausente: ${label}`).toContain(label);
    }
    expect(output).toContain('coletado');
    expect(output).toContain('ausente');
  });

  it('avisa quando o Railway não foi coletado por falta de token', () => {
    const output = renderOperationalHtml(
      diagnosis({
        limitations: [
          'Os logos internos do Railway não foram coletados: `RAILWAY_TOKEN` não está configurado neste job.',
        ],
      }),
    );

    expect(output).toContain('Logs internos do Railway não coletados');
    expect(output).toContain('RAILWAY_TOKEN');
  });

  it('destaca o mismatch de SHA', () => {
    const output = renderOperationalHtml(
      diagnosis({ correlationStatus: 'mismatch', observedCommitSha: 'e82b60d5f1a94c37bd08e25a71f3c6094ab1d7e2' }),
    );

    expect(output).toContain('versão divergente');
    expect(output).toContain('e82b60d');
  });

  it('é acessível e responsivo no básico', () => {
    const output = html();

    expect(output).toContain('lang="pt-BR"');
    expect(output).toContain('name="viewport"');
    expect(output).toContain('aria-labelledby');
    expect(output).toContain('<caption>');
    expect(output).toContain('scope="col"');
    expect(output).toContain('class="skip"');
    expect(output).toContain('overflow-x: auto');
  });

  it('não despeja o log completo — só trechos', () => {
    const enorme = Array.from({ length: 2000 }, (_, i) => `linha ${i}`).join('\n');
    const output = renderOperationalHtml(diagnosis(), {
      timeline: [],
      textSources: [{ source: 'ci:tests', phase: 'ci_tests', content: enorme }],
    });

    expect(output).not.toContain('linha 900');
    expect(output).toContain('linha(s) omitida(s)');
  });

  it('trunca string muito longa sem quebrar o documento', () => {
    const output = renderOperationalHtml(
      diagnosis({
        observedFacts: [
          { id: 'F1', source: 'ci:tests', phase: 'ci_tests', timestamp: null, excerpt: 'x'.repeat(50_000) },
        ],
      }),
    );

    expect(output.length).toBeLessThan(200_000);
    expect(output).toContain('</html>');
  });
});

describe('campos opcionais ausentes', () => {
  it('renderiza sem deployment, serviço, ambiente, causa nem metadados do modelo', () => {
    const output = renderOperationalHtml(
      diagnosis({
        deploymentId: null,
        service: null,
        environment: null,
        observedCommitSha: null,
        probableCause: null,
        causeStrength: 'unavailable',
        observedFacts: [],
        inferences: [],
        recommendedActions: [],
        limitations: [],
        modelProvider: undefined,
        model: undefined,
        modelResponseId: undefined,
        modelLatencyMs: undefined,
        modelUsage: undefined,
        modelErrorCategory: undefined,
      }),
    );

    expect(output).toContain('não informado');
    expect(output).toContain('Nenhum fato foi coletado');
    expect(output).toContain('Nenhuma inferência se sustentou');
    expect(output).toContain('Não foi possível estabelecer uma causa');
    expect(output).toContain('</html>');
    expect(output).not.toContain('undefined');
  });

  it('renderiza sem contexto (sem linha do tempo nem evidências)', () => {
    const output = renderOperationalHtml(diagnosis(), null);

    expect(output).toContain('</html>');
    expect(output).not.toContain('Linha do tempo');
    expect(output).not.toContain('Evidências selecionadas');
  });
});

/* ------------------------------------------------------------------------- */
/* Geração dos três arquivos                                                  */
/* ------------------------------------------------------------------------- */

describe('geração dos relatórios', () => {
  it('grava JSON, Markdown e HTML válidos para o cenário saudável', async () => {
    const context = loadFixtureContext('success');
    const { diagnosis: result } = await analyzeOperational({ context, env: {} });

    const outDir = tempDir();
    const { jsonPath, markdownPath, htmlPath } = writeOperationalReports({
      diagnosis: result,
      context,
      outDir,
    });

    const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(() => operationalDiagnosisSchema.parse(json)).not.toThrow();
    expect(json.technicalStatus.overall).toBe('success');

    const markdown = readFileSync(markdownPath, 'utf8');
    expect(markdown).toContain('# 🛰️ Relatório operacional do deployment');
    expect(markdown).toContain('## Fatos observados');
    expect(markdown).toContain('## Inferências');
    expect(markdown).toContain('[FATO]');
    expect(markdown).toContain('a IA descreve, não decide');

    const html = readFileSync(htmlPath, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('APROVADO');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('grava os três para o cenário de falha funcional', async () => {
    const context = loadFixtureContext('functional-failure');
    const { diagnosis: result } = await analyzeOperational({ context, env: {} });

    const outDir = tempDir();
    const { htmlPath, jsonPath } = writeOperationalReports({ diagnosis: result, context, outDir });

    const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(json.technicalStatus.overall).toBe('failure');
    expect(json.affectedPhase).toBe('functional');

    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('REPROVADO');
    expect(html).toContain('[FATO]');
  });
});
