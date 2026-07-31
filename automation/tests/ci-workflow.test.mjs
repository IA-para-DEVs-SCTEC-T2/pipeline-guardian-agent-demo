/**
 * Testes sobre o **desenho** do workflow de CI.
 *
 * `operational-workflow.test.mjs` faz isso para o pós-deployment; este arquivo
 * faz para o CI, e pelo mesmo motivo: as invariantes que mais importam vivem em
 * YAML, não em módulo. Um `needs:` a mais no `ci-gate`, um secret copiado para
 * o job errado numa refatoração, um `if:` que deixa de ser `always()` — nada
 * disso apareceria em teste de unidade nenhum, e cada um transformaria a
 * explicação por IA em condição de aprovação.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const CI_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const POST_DEPLOY_PATH = join(REPO_ROOT, '.github', 'workflows', 'post-deploy.yml');

const raw = readFileSync(CI_PATH, 'utf8');
const workflow = yaml.load(raw);
const postDeploy = yaml.load(readFileSync(POST_DEPLOY_PATH, 'utf8'));

/** Texto de um job inteiro, para procurar secrets e condições nele. */
function jobText(name) {
  const jobs = Object.keys(workflow.jobs);
  const index = jobs.indexOf(name);
  const start = raw.indexOf(`\n  ${name}:\n`);
  const nextJob = jobs[index + 1];
  const end = nextJob === undefined ? raw.length : raw.indexOf(`\n  ${nextJob}:\n`);
  return raw.slice(start, end === -1 ? raw.length : end);
}

/** O job sem as linhas de comentário — as proibições são sobre o que executa. */
function jobCode(name) {
  return jobText(name)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/* ------------------------------------------------------------------------- */
/* 41–42 · O relatório sai mesmo quando o CI falha                            */
/* ------------------------------------------------------------------------- */

describe('relatório de execução dentro do CI', () => {
  it('41. o job de diagnóstico roda com `if: always()`', () => {
    // `true` porque o YAML avalia `${{ always() }}` e o js-yaml carrega o
    // resultado da expressão como string; o que importa é a condição existir.
    expect(workflow.jobs.diagnose.if).toBeDefined();
    expect(String(workflow.jobs.diagnose.if)).toContain('always()');

    const text = jobText('diagnose');
    // E o step que gera o relatório também: é justamente quando um passo
    // anterior falhou que o relatório vale mais.
    const step = text.slice(text.indexOf('Gerar relatório de execução do pipeline'));
    expect(step.slice(0, 200)).toContain('if: ${{ always() }}');
  });

  it('41b. o relatório é gerado com lint, testes, build ou Docker reprovados', () => {
    const text = jobText('diagnose');

    // O job só depende dos quatro jobs técnicos, e `always()` faz o download
    // dos artefatos e a geração acontecerem em qualquer resultado deles.
    expect(workflow.jobs.diagnose.needs).toEqual(['quality', 'tests', 'build', 'docker-build']);
    expect(text).toContain('node automation/src/pipeline-report.mjs --scope ci --ci-dir reports/input');
  });

  it('42. usa os resultados REAIS de cada job, não a conclusão global', () => {
    const text = jobText('diagnose');

    expect(text).toContain('QUALITY_RESULT: ${{ needs.quality.result }}');
    expect(text).toContain('TESTS_RESULT: ${{ needs.tests.result }}');
    expect(text).toContain('BUILD_RESULT: ${{ needs.build.result }}');
    expect(text).toContain('DOCKER_RESULT: ${{ needs.docker-build.result }}');

    // Nenhuma derivação a partir da conclusão do workflow inteiro: ela apagaria
    // a diferença entre "o lint reprovou" e "o Docker reprovou".
    expect(jobCode('diagnose')).not.toContain('github.event.workflow_run.conclusion');
  });

  it('publica o artefato com o nome previsível e retém por 30 dias', () => {
    const text = jobText('publish-pipeline-report');

    expect(text).toContain('name: pipeline-execution-report-${{ needs.diagnose.outputs.short_sha }}');
    expect(text).toContain('reports/pipeline-execution-report.html');
    expect(text).toContain('retention-days: 30');
  });

  it('o Job Summary é curto e aponta para o artefato', () => {
    const text = jobText('publish-pipeline-report');

    expect(text).toContain('steps.upload.outputs.artifact-url');
    expect(text).toContain('Baixar o relatório HTML');
    // O relatório inteiro NÃO vai para o Summary.
    expect(text).not.toContain('cat reports/pipeline-execution-report.md');
    expect(text).not.toContain('cat reports/pipeline-execution-report.html');
  });

  it('artefato ausente vira mensagem declarada, nunca aprovação', () => {
    const text = jobText('publish-pipeline-report');

    expect(text).toContain('O relatório não foi gerado nesta execução.');
    expect(text).toContain("hashFiles('reports/pipeline-execution-report.html') != ''");
  });

  it('não executa nada vindo dos artefatos baixados', () => {
    const code = jobCode('diagnose');

    expect(code).not.toMatch(/\b(?:source|eval|bash)\s+reports\/input/);
    expect(code).not.toMatch(/cat reports\/input/);
  });
});

/* ------------------------------------------------------------------------- */
/* 43–45 · Os gates continuam determinísticos                                 */
/* ------------------------------------------------------------------------- */

describe('ci-gate é independente da IA', () => {
  const gate = () => workflow.jobs['ci-gate'];

  it('43. decide pelos quatro jobs técnicos e por nada mais', () => {
    const text = jobText('ci-gate');

    for (const job of ['quality', 'tests', 'build', 'docker-build']) {
      expect(text).toContain(`[ "\${{ needs.${job}.result }}" != "success" ]`);
    }
    // O resultado do diagnóstico é impresso como informação e nunca entra na
    // condição.
    expect(text).not.toContain('[ "${{ needs.diagnose.result }}" != "success" ]');
  });

  it('44. nenhum campo do relatório entra na decisão', () => {
    const text = jobText('ci-gate');

    for (const field of [
      'summary',
      'probableCause',
      'confidence',
      'usedFallback',
      'affectedPhase',
      'recommendedActions',
      'firstFailedStage',
      'failureExplanation',
      'successSummary',
    ]) {
      expect(text, `ci-gate não pode ler ${field}`).not.toContain(field);
    }
    expect(text).not.toContain('pipeline-execution-report');
  });

  it('45. o job que publica o relatório não é dependência do gate', () => {
    // Publicar um relatório não pode transformar um CI reprovado em aprovado —
    // nem o contrário.
    expect(gate().needs).not.toContain('publish-pipeline-report');
    expect(gate().needs).toEqual(['quality', 'tests', 'build', 'docker-build', 'diagnose']);
    expect(workflow.jobs['publish-pipeline-report']['continue-on-error']).toBe(true);
    expect(workflow.jobs.diagnose['continue-on-error']).toBe(true);
  });

  it('45b. o cd-gate do pós-deployment continua dependendo só do smoke test', () => {
    expect(postDeploy.jobs['cd-gate'].needs).toEqual(['post-deploy-smoke-test']);
  });

  it('os jobs técnicos não têm continue-on-error', () => {
    for (const job of ['quality', 'tests', 'build', 'docker-build', 'ci-gate']) {
      expect(workflow.jobs[job]['continue-on-error']).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 46–47 · Distribuição dos secrets                                           */
/* ------------------------------------------------------------------------- */

describe('secrets continuam isolados', () => {
  it('46. OPENAI_API_KEY existe apenas no job de diagnóstico', () => {
    for (const job of Object.keys(workflow.jobs)) {
      const usa = jobText(job).includes('secrets.OPENAI_API_KEY');
      expect(usa, `OPENAI_API_KEY não deveria aparecer em ${job}`).toBe(job === 'diagnose');
    }
  });

  it('46b. RAILWAY_TOKEN não aparece em lugar nenhum do CI', () => {
    // O container da aplicação e o CI não falam com a API da plataforma.
    expect(raw).not.toContain('RAILWAY_TOKEN');
  });

  it('46c. o job que publica o relatório não recebe secret nenhum', () => {
    expect(jobText('publish-pipeline-report')).not.toContain('secrets.');
    expect(jobText('ci-gate')).not.toContain('secrets.');
  });

  it('47. Pull Request de fork não recebe a chave', () => {
    const text = jobText('diagnose');

    // A condição aparece nos DOIS steps que usam a chave.
    const ocorrencias = text.match(/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/g) ?? [];
    expect(ocorrencias.length).toBeGreaterThanOrEqual(2);

    const semCondicao = text.match(/OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/g) ?? [];
    expect(semCondicao, 'a chave não pode ser entregue sem condição').toHaveLength(0);
  });

  it('não usa pull_request_target nem persiste credenciais no checkout', () => {
    const code = raw
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    expect(code).not.toContain('pull_request_target');

    const total = (code.match(/uses: actions\/checkout@/g) ?? []).length;
    const seguros = code.match(/uses: actions\/checkout@v\d+\n(?:.*\n)*?.*persist-credentials: false/g) ?? [];
    expect(total).toBeGreaterThan(0);
    expect(seguros).toHaveLength(total);
  });

  it('não faz commit, push, merge nem tag', () => {
    const code = raw
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    for (const forbidden of ['git push', 'git commit', 'git merge', 'git tag', 'gh pr merge', 'gh release create']) {
      expect(code, `o workflow não pode executar: ${forbidden}`).not.toContain(forbidden);
    }
  });
});
