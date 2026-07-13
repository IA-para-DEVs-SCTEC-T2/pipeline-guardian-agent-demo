import { describe, it, expect } from 'vitest';

import { analyzePipeline } from '../src/analyze-pipeline.mjs';
import { REPORT_MARKER, renderMarkdown, renderPullRequestComment } from '../src/render-report.mjs';
import { simulateFailure } from '../src/simulate-failure.mjs';

async function diagnosisFor(scenario, overrides) {
  return analyzePipeline({ source: simulateFailure(scenario, overrides), env: {} });
}

describe('renderMarkdown', () => {
  it('apresenta todas as seções exigidas', async () => {
    const { diagnosis, policy } = await diagnosisFor('test');
    const markdown = renderMarkdown(diagnosis, { policyReasons: policy.reasons });

    const sections = [
      '## Resumo',
      '## Sinal',
      '## Tipo de falha',
      '## Causa provável',
      '## Evidências',
      '## Impacto',
      '## Risco e confiança',
      '## Próximos passos',
      '## Decisão de deploy',
      '## Limitações',
      '## Origem do diagnóstico',
    ];

    for (const section of sections) {
      expect(markdown).toContain(section);
    }
  });

  it('mostra a decisão, a aprovação humana e o uso de fallback', async () => {
    const { diagnosis } = await diagnosisFor('test');
    const markdown = renderMarkdown(diagnosis);

    expect(markdown).toContain('`blocked`');
    expect(markdown).toContain('✋ necessária');
    expect(markdown).toContain('Fallback determinístico');
    expect(markdown).toContain('usedFallback: true');
  });

  it('mostra os motivos da política quando fornecidos', async () => {
    const { diagnosis, policy } = await diagnosisFor('test');
    const markdown = renderMarkdown(diagnosis, { policyReasons: policy.reasons });

    expect(markdown).toContain('Motivos da política:');
    expect(markdown).toMatch(/pipeline com comandos em falha/i);
  });

  it('não vaza segredo no relatório do cenário de segurança', async () => {
    const { diagnosis, policy } = await diagnosisFor('security');
    const markdown = renderMarkdown(diagnosis, { policyReasons: policy.reasons });

    expect(markdown).not.toMatch(/sk-proj-/);
    expect(markdown).not.toMatch(/ghp_/);
    expect(markdown).not.toMatch(/github_pat_/);
    expect(markdown).not.toMatch(/S3nh4-Sup3r-S3cr3t4/);
    expect(markdown).not.toMatch(/8f3ab1c2d4e5/);

    // O relatório reporta o achado do scanner, não o valor encontrado.
    expect(markdown).toContain('Conteúdo sensível detectado');
    expect(markdown).toContain('`security`');
    expect(markdown).toContain('🔴 alto');
  });

  it('lista as evidências com a fonte de cada trecho', async () => {
    const { diagnosis } = await diagnosisFor('lint');
    const markdown = renderMarkdown(diagnosis);

    expect(diagnosis.evidence.length).toBeGreaterThan(0);
    expect(markdown).toContain(`**${diagnosis.evidence[0].source}**`);
    expect(markdown).toContain(diagnosis.evidence[0].excerpt);
  });
});

describe('renderPullRequestComment', () => {
  it('inclui o marcador usado no upsert', async () => {
    const { diagnosis } = await diagnosisFor('build');
    const body = renderPullRequestComment(diagnosis);

    expect(body.startsWith(REPORT_MARKER)).toBe(true);
    expect(body).toContain('# 🛡️ Pipeline Guardian');
  });
});
