/**
 * O comando das fixtures — `npm run pipeline:fixture -- <cenário>`.
 *
 * A invariante que este arquivo protege é a mais fácil de perder numa
 * refatoração: **ter a chave no ambiente não liga o modelo no modo fixture**.
 * A máquina de quem apresenta a aula costuma ter `OPENAI_API_KEY` no `.env`, e
 * uma demonstração que sai chamando a API a cada `npm run` é uma conta e uma
 * dependência de rede que ninguém pediu.
 */

import { describe, expect, it } from 'vitest';

import {
  DAY_1_SCENARIOS,
  FIXTURE_ALIASES,
  REPORT_BASENAMES,
  inferScope,
  listFixtures,
  loadFixtureContext,
} from '../src/operational-report.mjs';
import {
  FIXTURE_MODEL_OPT_IN,
  parsePipelineArgs,
  resolveFixtureEnv,
  resolveScope,
} from '../src/pipeline-report.mjs';

/* ------------------------------------------------------------------------- */
/* Argumentos                                                                 */
/* ------------------------------------------------------------------------- */

describe('parsePipelineArgs', () => {
  it('lê o nome do cenário depois de --fixture', () => {
    expect(parsePipelineArgs(['--fixture', 'ci-lint-failure']).fixture).toBe('ci-lint-failure');
    // Sem nome, vale o cenário saudável.
    expect(parsePipelineArgs(['--fixture']).fixture).toBe('success');
    expect(parsePipelineArgs(['--fixture', '--out', '/tmp/x']).fixture).toBe('success');
  });

  it('lê escopo, diretórios e ignora o que não conhece', () => {
    const options = parsePipelineArgs(['--scope', 'ci', '--ci-dir', 'reports/input', '--out', '/tmp/o']);

    expect(options.scope).toBe('ci');
    expect(options.ciDir).toBe('reports/input');
    expect(options.outDir).toBe('/tmp/o');
    expect(options.fixture).toBeNull();
    expect(parsePipelineArgs([])).toEqual({
      fixture: null,
      scope: null,
      outDir: null,
      reportsDir: null,
      ciDir: null,
    });
  });
});

/* ------------------------------------------------------------------------- */
/* Opt-in do modelo                                                           */
/* ------------------------------------------------------------------------- */

describe('a chave sozinha não liga o modelo nas fixtures', () => {
  it('remove OPENAI_API_KEY do ambiente sem o opt-in', () => {
    const { env, note } = resolveFixtureEnv({
      env: { OPENAI_API_KEY: 'sk-test-0123456789abcdef', OPENAI_MODEL: 'gpt-5-mini' },
      fixture: true,
    });

    // Não é uma condição em volta da chamada: é a chave não existir para quem
    // chamaria.
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_MODEL).toBe('gpt-5-mini');
    expect(note).toMatch(new RegExp(FIXTURE_MODEL_OPT_IN));
  });

  it('mantém a chave com o opt-in explícito', () => {
    const { env, note } = resolveFixtureEnv({
      env: { OPENAI_API_KEY: 'sk-test-0123456789abcdef', [FIXTURE_MODEL_OPT_IN]: 'true' },
      fixture: true,
    });

    expect(env.OPENAI_API_KEY).toBe('sk-test-0123456789abcdef');
    expect(note).toBeNull();
  });

  it('só `true` conta como opt-in', () => {
    for (const value of ['1', 'yes', 'sim', 'TRUE ', '', undefined]) {
      const { env } = resolveFixtureEnv({
        env: { OPENAI_API_KEY: 'sk-test-0123456789abcdef', [FIXTURE_MODEL_OPT_IN]: value },
        fixture: true,
      });
      // `TRUE ` passa: o valor é normalizado (trim + minúsculas).
      const esperado = String(value ?? '').trim().toLowerCase() === 'true';
      expect(Boolean(env.OPENAI_API_KEY), `valor: ${String(value)}`).toBe(esperado);
    }
  });

  it('fora do modo fixture o ambiente passa intacto', () => {
    const env = { OPENAI_API_KEY: 'sk-test-0123456789abcdef' };
    expect(resolveFixtureEnv({ env, fixture: false }).env).toBe(env);
  });

  it('sem chave nenhuma, não há aviso a dar', () => {
    expect(resolveFixtureEnv({ env: {}, fixture: true }).note).toBeNull();
  });
});

/* ------------------------------------------------------------------------- */
/* Escopo                                                                     */
/* ------------------------------------------------------------------------- */

describe('resolveScope', () => {
  const comSmoke = { sourceCoverage: { smokeTest: true } };
  const semSmoke = { sourceCoverage: { smokeTest: false } };

  it('a opção explícita vence', () => {
    expect(resolveScope({ requested: 'ci', env: {}, context: comSmoke })).toBe('ci');
    expect(resolveScope({ requested: 'cd', env: {}, context: semSmoke })).toBe('cd');
  });

  it('depois a variável de ambiente', () => {
    expect(resolveScope({ env: { PIPELINE_REPORT_SCOPE: 'cd' }, context: semSmoke })).toBe('cd');
  });

  it('por último, o material coletado', () => {
    expect(resolveScope({ env: {}, context: comSmoke })).toBe('cd');
    expect(resolveScope({ env: {}, context: semSmoke })).toBe('ci');
  });

  it('valor inválido cai na dedução, não em erro', () => {
    expect(resolveScope({ requested: 'apocalipse', env: {}, context: semSmoke })).toBe('ci');
    expect(inferScope(comSmoke)).toBe('cd');
    expect(inferScope(undefined)).toBe('ci');
  });
});

/* ------------------------------------------------------------------------- */
/* Cenários                                                                   */
/* ------------------------------------------------------------------------- */

describe('os cinco cenários versionados', () => {
  it('são exatamente cinco, e todos existem no disco', () => {
    expect(DAY_1_SCENARIOS).toHaveLength(5);

    const disponiveis = listFixtures();
    for (const scenario of DAY_1_SCENARIOS) {
      expect(disponiveis, `cenário ausente: ${scenario}`).toContain(scenario);
    }
  });

  it('o nome antigo continua funcionando', () => {
    expect(FIXTURE_ALIASES['functional-failure']).toBe('cd-functional-failure');
    expect(listFixtures()).toContain('functional-failure');

    const alias = loadFixtureContext('functional-failure');
    const canonico = loadFixtureContext('cd-functional-failure');

    expect(alias.technicalStatus).toEqual(canonico.technicalStatus);
    expect(alias.metadata.commitSha).toBe(canonico.metadata.commitSha);
  });

  it('cenário inexistente erra com a lista do que existe', () => {
    expect(() => loadFixtureContext('nao-existe')).toThrow(/Disponíveis:/);
  });

  it('os cenários de CI não trazem material de deployment', () => {
    for (const scenario of ['ci-lint-failure', 'ci-tests-failure', 'ci-docker-failure']) {
      const context = loadFixtureContext(scenario);

      expect(context.sourceCoverage.smokeTest, scenario).toBe(false);
      expect(context.sourceCoverage.railwayBuild, scenario).toBe(false);
      expect(context.technicalStatus.smokeTest, scenario).toBe('not_executed');
      expect(context.technicalStatus.ci, scenario).toBe('failure');
      expect(inferScope(context)).toBe('ci');
    }
  });

  it('o relatório é gravado sob os dois nomes', () => {
    expect(REPORT_BASENAMES).toEqual(['operational-deployment-report', 'pipeline-execution-report']);
  });
});
