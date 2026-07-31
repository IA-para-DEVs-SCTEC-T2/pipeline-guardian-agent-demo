/**
 * Testes sobre o **desenho** do fluxo, não sobre um módulo.
 *
 * Duas coisas que só se verificam olhando o YAML e a lista de cenários:
 *
 * 1. O `cd-gate` decide sozinho, a partir do smoke test. Essa é a invariante
 *    central do Dia 1, e ela vive num arquivo de workflow — não num módulo que
 *    algum teste de unidade cobriria. Um `needs:` a mais no lugar errado
 *    passaria despercebido em toda a suíte, e é exatamente a mudança que
 *    transformaria a IA em condição de aprovação.
 * 2. Os secrets chegam a um job cada. Um `RAILWAY_TOKEN` copiado para o job de
 *    diagnóstico durante uma refatoração é o tipo de erro que ninguém enxerga
 *    lendo o diff.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { listFixtures, parseArgs } from '../src/operational-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'post-deploy.yml');

const workflow = yaml.load(readFileSync(WORKFLOW_PATH, 'utf8'));
const raw = readFileSync(WORKFLOW_PATH, 'utf8');

/**
 * O YAML sem as linhas de comentário.
 *
 * As proibições ("não usa `pull_request_target`", "não faz `git push`") são
 * sobre o que o workflow **executa**. Os comentários deste arquivo explicam
 * justamente por que essas coisas não são feitas, e citá-las é o comportamento
 * desejado — procurar a string no arquivo inteiro reprovaria a documentação.
 */
const code = raw
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** Texto de um job inteiro, para procurar secrets nele. */
function jobText(name) {
  const jobs = Object.keys(workflow.jobs);
  const index = jobs.indexOf(name);
  const start = raw.indexOf(`\n  ${name}:\n`);
  const nextJob = jobs[index + 1];
  const end = nextJob === undefined ? raw.length : raw.indexOf(`\n  ${nextJob}:\n`);
  return raw.slice(start, end === -1 ? raw.length : end);
}

/* ------------------------------------------------------------------------- */
/* CD Gate                                                                    */
/* ------------------------------------------------------------------------- */

describe('cd-gate é independente da IA', () => {
  const gate = workflow.jobs['cd-gate'];

  it('depende APENAS do smoke test', () => {
    expect(gate.needs).toEqual(['post-deploy-smoke-test']);
  });

  it('não depende do diagnóstico nem dos jobs de coleta', () => {
    const needs = [].concat(gate.needs);

    for (const job of [
      'operational-deployment-diagnosis',
      'collect-railway-evidence',
      'collect-ci-evidence',
      'publish-operational-report',
    ]) {
      expect(needs, `cd-gate não pode depender de ${job}`).not.toContain(job);
    }
  });

  it('decide pelo resultado do smoke test e por nada mais', () => {
    const text = jobText('cd-gate');

    expect(text).toContain("needs.post-deploy-smoke-test.result }}\" != \"success\"");
    // Nenhum campo do relatório entra na condição.
    for (const field of ['summary', 'probableCause', 'confidence', 'usedFallback', 'affectedPhase', 'recommendedActions']) {
      expect(text, `cd-gate não pode ler ${field}`).not.toContain(field);
    }
    expect(text).not.toContain('operational-deployment-report');
  });

  it('não recebe secret nenhum', () => {
    expect(jobText('cd-gate')).not.toContain('secrets.');
  });
});

/* ------------------------------------------------------------------------- */
/* Distribuição dos secrets                                                   */
/* ------------------------------------------------------------------------- */

describe('cada secret em um job só', () => {
  it('RAILWAY_TOKEN existe apenas no job de coleta do Railway', () => {
    for (const job of Object.keys(workflow.jobs)) {
      const text = jobText(job);
      const usa = text.includes('secrets.RAILWAY_TOKEN');
      expect(usa, `RAILWAY_TOKEN não deveria aparecer em ${job}`).toBe(job === 'collect-railway-evidence');
    }
  });

  it('OPENAI_API_KEY existe apenas no job de diagnóstico', () => {
    for (const job of Object.keys(workflow.jobs)) {
      const text = jobText(job);
      const usa = text.includes('secrets.OPENAI_API_KEY');
      expect(usa, `OPENAI_API_KEY não deveria aparecer em ${job}`).toBe(
        job === 'operational-deployment-diagnosis',
      );
    }
  });

  it('os gates técnicos não recebem secret externo', () => {
    for (const job of ['post-deploy-smoke-test', 'cd-gate', 'collect-ci-evidence', 'publish-operational-report']) {
      const text = jobText(job);
      expect(text, `${job} não pode ver OPENAI_API_KEY`).not.toContain('secrets.OPENAI_API_KEY');
      expect(text, `${job} não pode ver RAILWAY_TOKEN`).not.toContain('secrets.RAILWAY_TOKEN');
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Segurança do gatilho                                                       */
/* ------------------------------------------------------------------------- */

describe('segurança do workflow_run', () => {
  it('não usa pull_request_target', () => {
    expect(code).not.toContain('pull_request_target');
  });

  it('mantém o gatilho workflow_run restrito à main', () => {
    // A troca por `deployment_status` é evolução futura documentada, não desta
    // entrega: mudar o gatilho muda a superfície de segurança.
    expect(workflow.on.workflow_run.branches).toEqual(['main']);
    expect(workflow.on.workflow_run.workflows).toEqual(['CI']);
    expect(workflow.on).not.toHaveProperty('deployment_status');
  });

  it('usa permissão mínima e só concede `actions: read` a quem baixa artefatos', () => {
    expect(workflow.permissions).toEqual({ contents: read() });

    expect(workflow.jobs['collect-ci-evidence'].permissions).toEqual({
      contents: read(),
      actions: read(),
    });

    for (const job of ['post-deploy-smoke-test', 'collect-railway-evidence', 'cd-gate']) {
      expect(workflow.jobs[job].permissions).toBeUndefined();
    }
  });

  it('todo checkout é do SHA aprovado e sem credenciais persistidas', () => {
    const checkouts = code.match(/uses: actions\/checkout@v\d+\n(?:.*\n)*?.*persist-credentials: false/g) ?? [];
    const total = (code.match(/uses: actions\/checkout@/g) ?? []).length;

    expect(total).toBeGreaterThan(0);
    expect(checkouts).toHaveLength(total);
    expect(code).not.toMatch(/ref: \$\{\{ github\.event\.pull_request\.head/);
  });

  it('entrega a chave da OpenAI só em origem confiável', () => {
    const text = jobText('operational-deployment-diagnosis');

    expect(text).toContain("github.event.workflow_run.event == 'push'");
    expect(text).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(text).toContain("github.event.workflow_run.conclusion == 'success'");
  });

  it('a coleta do Railway não pode reprovar o workflow', () => {
    expect(workflow.jobs['collect-railway-evidence']['continue-on-error']).toBe(true);
    expect(workflow.jobs['operational-deployment-diagnosis']['continue-on-error']).toBe(true);
  });

  it('o smoke test continua sendo o único job sem continue-on-error entre os que validam', () => {
    expect(workflow.jobs['post-deploy-smoke-test']['continue-on-error']).toBeUndefined();
    expect(workflow.jobs['cd-gate']['continue-on-error']).toBeUndefined();
  });

  it('não faz commit, push, merge nem tag', () => {
    for (const forbidden of ['git push', 'git commit', 'git merge', 'git tag', 'gh pr merge', 'gh release create']) {
      expect(code, `o workflow não pode executar: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('baixa artefatos do CI por run-id, nunca da "última execução"', () => {
    const text = jobText('collect-ci-evidence');

    expect(text).toContain('run-id: ${{ needs.resolve-context.outputs.ci_run_id }}');
    expect(text).toContain('github-token: ${{ github.token }}');
    expect(text).not.toMatch(/latest.*run/i);
  });

  it('não executa nada vindo dos artefatos baixados', () => {
    const text = jobText('collect-ci-evidence');

    // Só `ls`. Nada de `cat`, `source`, `bash` ou `node` sobre o que foi baixado.
    expect(text).not.toMatch(/\b(?:source|eval|bash)\s+reports\/evidence/);
    expect(text).not.toMatch(/cat reports\/evidence/);
    expect(text).toContain('ls -l reports/evidence/ci');
  });
});

/** `on:` vira `true` no YAML 1.1; `read` não sofre disso, mas fica explícito. */
function read() {
  return 'read';
}

/* ------------------------------------------------------------------------- */
/* Publicação                                                                 */
/* ------------------------------------------------------------------------- */

describe('publicação do relatório', () => {
  it('nomeia o artefato com o short sha e retém por 30 dias', () => {
    const text = jobText('publish-operational-report');

    expect(text).toContain('name: operational-deployment-report-${{ needs.resolve-context.outputs.short_sha }}');
    expect(text).toContain('retention-days: 30');
    expect(text).toContain('operational-deployment-report.html');
  });

  it('usa a URL devolvida pelo upload para o link do Job Summary', () => {
    const text = jobText('publish-operational-report');

    expect(text).toContain('steps.upload.outputs.artifact-url');
    expect(text).toContain('Baixar o relatório HTML');
  });

  it('o Job Summary é curto: não despeja o relatório inteiro', () => {
    const text = jobText('publish-operational-report');

    expect(text).not.toContain('cat reports/operational-deployment-report.md');
    expect(text).toContain('Resultado técnico');
    expect(text).toContain('Cobertura das fontes');
    expect(text).toContain('informativa');
  });
});

/* ------------------------------------------------------------------------- */
/* Cenários                                                                   */
/* ------------------------------------------------------------------------- */

describe('cenários de contingência', () => {
  it('os dois cenários do Dia 1 existem', () => {
    const fixtures = listFixtures();
    expect(fixtures).toContain('success');
    expect(fixtures).toContain('functional-failure');
  });

  it('parseArgs lê o nome do cenário depois de --fixture', () => {
    expect(parseArgs(['--fixture', 'success']).fixture).toBe('success');
    expect(parseArgs(['--fixture', 'functional-failure']).fixture).toBe('functional-failure');
    // Sem nome, vale o cenário saudável.
    expect(parseArgs(['--fixture']).fixture).toBe('success');
    expect(parseArgs(['--fixture', '--out', '/tmp/x']).fixture).toBe('success');
    expect(parseArgs(['--out', '/tmp/x']).outDir).toBe('/tmp/x');
    expect(parseArgs([]).fixture).toBeNull();
  });
});
