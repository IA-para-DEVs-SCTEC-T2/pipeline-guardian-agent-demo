import { describe, it, expect } from 'vitest';

import {
  assessDeployReadiness,
  buildDeploymentManifest,
  buildGateResults,
  deriveAgentRecommendation,
  policyOverrodeAgent,
} from '../src/deploy-assessment.mjs';

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* ------------------------------------------------------------------------- */

const LINT_OK = 'eslint . --max-warnings=0\nAll files pass linting checks.\n';
const TEST_OK = 'Test Files  4 passed (4)\nTests  27 passed (27)\n';
const BUILD_OK = 'vite build\ndist/index.html  0.42 kB\nbuilt in 1.20s\n';

const TEST_FAILED = [
  'FAIL backend/test/report.test.js > duplicateCopies',
  'AssertionError: expected 2 to be 3',
  '- Expected: 3',
  '+ Received: 2',
  'Tests  1 failed | 26 passed (27)',
].join('\n');

const PATCH = [
  'diff --git a/backend/src/services/report.js b/backend/src/services/report.js',
  '--- a/backend/src/services/report.js',
  '+++ b/backend/src/services/report.js',
  '@@ -10,7 +10,7 @@',
  '-  return Math.max(quantity - 1, 0);',
  '+  return quantity;',
].join('\n');

function command(name, exitCode, log) {
  return { name, command: `npm run ${name}`, exitCode, log };
}

const GREEN_COMMANDS = [
  command('lint', 0, LINT_OK),
  command('test', 0, TEST_OK),
  command('build', 0, BUILD_OK),
];

const RED_COMMANDS = [
  command('lint', 0, LINT_OK),
  command('test', 1, TEST_FAILED),
  command('build', 0, BUILD_OK),
];

function sourceFor(commands, environment = 'staging') {
  return {
    pipeline: {
      repository: 'senai/copa-figurinhas',
      branch: 'main',
      commitSha: 'a1b2c3d4e5f6',
      environment,
      trigger: 'workflow_dispatch',
      workflow: 'deploy-assisted',
      runId: '4242',
      isRollback: false,
      pullRequestNumber: null,
    },
    commands,
    diff: {
      files: [{ path: 'backend/src/services/report.js', status: 'modified', additions: 1, deletions: 1 }],
      patch: PATCH,
    },
  };
}

/** Sem chaves: o agente cai no classificador determinístico. */
const NO_MODEL_ENV = {};

/** Com chaves + cliente injetado: o "modelo" devolve exatamente o que o teste mandar. */
const MODEL_ENV = { OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-test' };

/**
 * Cliente OpenAI falso. `evidence` cita uma linha que existe mesmo nos logs —
 * do contrário `groundEvidence` a descartaria e a limitação resultante viraria
 * um segundo motivo de bloqueio, embaralhando o que cada teste quer provar.
 */
function fakeModel(diagnosis) {
  return {
    responses: {
      parse: async () => ({
        status: 'completed',
        output_parsed: {
          summary: 'Análise do modelo.',
          signal: 'model-signal',
          probableCause: 'Causa apontada pelo modelo.',
          evidence: [{ source: 'log:lint', excerpt: 'All files pass linting checks.' }],
          impact: 'Impacto descrito pelo modelo.',
          nextSteps: ['Passo sugerido pelo modelo.'],
          limitations: [],
          ...diagnosis,
        },
      }),
    },
  };
}

function assess({ commands, environment, releaseVersion = 'v1.4.0', env = NO_MODEL_ENV, client = null }) {
  return assessDeployReadiness({
    source: sourceFor(commands, environment),
    environment,
    releaseVersion,
    env,
    client,
  });
}

/* ------------------------------------------------------------------------- */
/* Cenários                                                                   */
/* ------------------------------------------------------------------------- */

describe('staging com todos os gates aprovados', () => {
  it('recomenda e libera para staging, sem aprovação humana', async () => {
    const { assessment } = await assess({ commands: GREEN_COMMANDS, environment: 'staging' });

    expect(assessment.gateResults).toEqual({ lint: 'passed', test: 'passed', build: 'passed' });
    expect(assessment.agentRecommendation).toBe('eligible_for_staging');
    expect(assessment.policyDecision).toBe('eligible_for_staging');
    expect(assessment.requiresHumanApproval).toBe(false);
    expect(assessment.policyOverrodeAgent).toBe(false);
    expect(assessment.releaseVersion).toBe('v1.4.0');
  });
});

describe('staging com teste falhando', () => {
  it('bloqueia a promoção', async () => {
    const { assessment } = await assess({ commands: RED_COMMANDS, environment: 'staging' });

    expect(assessment.gateResults.test).toBe('failed');
    expect(assessment.agentRecommendation).toBe('not_ready');
    expect(assessment.policyDecision).toBe('blocked');
    expect(assessment.requiresHumanApproval).toBe(true);
    expect(assessment.policyReasons.join(' ')).toMatch(/test|vermelho/i);

    // Agente e política concordaram — não houve sobrescrita a reportar.
    expect(assessment.policyOverrodeAgent).toBe(false);
  });
});

describe('production com todos os gates aprovados', () => {
  it('o agente atesta prontidão técnica, mas a política exige aprovação humana', async () => {
    const { assessment } = await assess({ commands: GREEN_COMMANDS, environment: 'production' });

    expect(assessment.gateResults).toEqual({ lint: 'passed', test: 'passed', build: 'passed' });
    expect(assessment.agentRecommendation).toBe('technically_ready');
    expect(assessment.policyDecision).toBe('requires_human_approval');
    expect(assessment.requiresHumanApproval).toBe(true);

    // `technically_ready` + `requires_human_approval` é CONCORDÂNCIA: os dois
    // dizem "não promova sem uma pessoa". Vocabulário diferente, veredito igual.
    expect(assessment.policyOverrodeAgent).toBe(false);
  });
});

describe('policyOverrodeAgent', () => {
  it('só acusa sobrescrita quando o agente pediu mais do que a política concedeu', () => {
    // Concordâncias — cada um no seu vocabulário.
    expect(policyOverrodeAgent('eligible_for_staging', 'eligible_for_staging')).toBe(false);
    expect(policyOverrodeAgent('technically_ready', 'requires_human_approval')).toBe(false);
    expect(policyOverrodeAgent('not_ready', 'blocked')).toBe(false);

    // O agente quis promover mais do que a política permite.
    expect(policyOverrodeAgent('eligible_for_staging', 'blocked')).toBe(true);
    expect(policyOverrodeAgent('eligible_for_staging', 'requires_human_approval')).toBe(true);
    expect(policyOverrodeAgent('technically_ready', 'blocked')).toBe(true);
  });
});

describe('production sempre exige aprovação humana', () => {
  it('nunca produz eligible_for_staging, mesmo com o modelo declarando tudo verde', async () => {
    const { assessment } = await assess({
      commands: GREEN_COMMANDS,
      environment: 'production',
      env: MODEL_ENV,
      client: fakeModel({ failureType: 'unknown', riskLevel: 'low', confidence: 'high' }),
    });

    expect(assessment.usedFallback).toBe(false);
    expect(assessment.agentRecommendation).not.toBe('eligible_for_staging');
    expect(assessment.policyDecision).toBe('requires_human_approval');
    expect(assessment.requiresHumanApproval).toBe(true);
    expect(assessment.policyReasons.join(' ')).toMatch(/aprovação humana/i);
  });
});

describe('risco alto', () => {
  it('bloqueia mesmo com o pipeline verde e sem falha bloqueante', async () => {
    const { assessment } = await assess({
      commands: GREEN_COMMANDS,
      environment: 'staging',
      env: MODEL_ENV,
      client: fakeModel({ failureType: 'dependency', riskLevel: 'high', confidence: 'high' }),
    });

    expect(assessment.riskLevel).toBe('high');
    expect(assessment.agentRecommendation).toBe('not_ready');
    expect(assessment.policyDecision).toBe('blocked');
    expect(assessment.policyReasons.join(' ')).toMatch(/risco alto/i);
  });
});

describe('confiança baixa', () => {
  it('bloqueia: não se promove o que não se entende', async () => {
    const { assessment } = await assess({
      commands: GREEN_COMMANDS,
      environment: 'staging',
      env: MODEL_ENV,
      client: fakeModel({ failureType: 'unknown', riskLevel: 'low', confidence: 'low' }),
    });

    expect(assessment.agentRecommendation).toBe('not_ready');
    expect(assessment.policyDecision).toBe('blocked');
    expect(assessment.policyReasons.join(' ')).toMatch(/confiança baixa/i);
  });
});

describe('contexto insuficiente', () => {
  it('bloqueia quando não há logs de comando para avaliar', async () => {
    const { assessment } = await assess({ commands: [], environment: 'staging' });

    expect(assessment.gateResults).toEqual({ lint: 'skipped', test: 'skipped', build: 'skipped' });
    expect(assessment.policyDecision).toBe('blocked');
  });
});

describe('a política sobrescreve recomendação insegura do modelo', () => {
  it('modelo descreve pipeline vermelho como saudável; a política bloqueia assim mesmo', async () => {
    // O modelo "erra para o lado perigoso": ignora o teste que falhou e devolve
    // risco baixo e confiança alta. A recomendação do agente sai insegura — e é
    // justamente esse o cenário que a política existe para interceptar.
    const { assessment } = await assess({
      commands: RED_COMMANDS,
      environment: 'staging',
      env: MODEL_ENV,
      client: fakeModel({ failureType: 'unknown', riskLevel: 'low', confidence: 'high' }),
    });

    expect(assessment.agentRecommendation).toBe('eligible_for_staging');

    // A política olha o exit code, não a opinião do modelo.
    expect(assessment.policyDecision).toBe('blocked');
    expect(assessment.requiresHumanApproval).toBe(true);
    expect(assessment.policyOverrodeAgent).toBe(true);
    expect(assessment.policyReasons.join(' ')).toMatch(/vermelho/i);
  });

  it('a decisão insegura não vaza para o manifesto de deploy', async () => {
    const { assessment } = await assess({
      commands: RED_COMMANDS,
      environment: 'staging',
      env: MODEL_ENV,
      client: fakeModel({ failureType: 'unknown', riskLevel: 'low', confidence: 'high' }),
    });

    expect(() => buildDeploymentManifest({ assessment })).toThrow(/recusado/i);
  });
});

/* ------------------------------------------------------------------------- */
/* Unidades                                                                   */
/* ------------------------------------------------------------------------- */

describe('buildGateResults', () => {
  it('trata comando não observado como skipped, nunca como passed', () => {
    expect(buildGateResults([{ name: 'lint', status: 'passed' }])).toEqual({
      lint: 'passed',
      test: 'skipped',
      build: 'skipped',
    });
  });
});

describe('deriveAgentRecommendation', () => {
  const healthy = { failureType: 'unknown', riskLevel: 'low', confidence: 'high' };

  it('não emite eligible_for_staging para production', () => {
    expect(deriveAgentRecommendation({ diagnosis: healthy, environment: 'production' })).toBe(
      'technically_ready',
    );
  });

  it('emite not_ready quando o tipo de falha é bloqueante', () => {
    expect(
      deriveAgentRecommendation({ diagnosis: { ...healthy, failureType: 'build' }, environment: 'staging' }),
    ).toBe('not_ready');
  });
});

describe('buildDeploymentManifest', () => {
  const base = {
    assessmentId: '00000000-0000-4000-8000-000000000000',
    repository: 'senai/copa-figurinhas',
    commitSha: 'a1b2c3d4e5f6',
    releaseVersion: 'v1.4.0',
    summary: 'ok',
    gateResults: { lint: 'passed', test: 'passed', build: 'passed' },
    evidence: [],
    riskLevel: 'low',
    confidence: 'high',
    nextSteps: [],
    policyOverrodeAgent: false,
    policyReasons: [],
    limitations: [],
    usedFallback: true,
    generatedAt: new Date().toISOString(),
  };

  it('registra status simulated e não exige aprovação em staging', () => {
    const manifest = buildDeploymentManifest({
      assessment: {
        ...base,
        environment: 'staging',
        agentRecommendation: 'eligible_for_staging',
        policyDecision: 'eligible_for_staging',
        requiresHumanApproval: false,
      },
    });

    expect(manifest.status).toBe('simulated');
    expect(manifest.approvalRequired).toBe(false);
  });

  it('registra approvalRequired: true em production', () => {
    const manifest = buildDeploymentManifest({
      assessment: {
        ...base,
        environment: 'production',
        agentRecommendation: 'technically_ready',
        policyDecision: 'requires_human_approval',
        requiresHumanApproval: true,
      },
      runId: '4242',
    });

    expect(manifest.status).toBe('simulated');
    expect(manifest.approvalRequired).toBe(true);
    expect(manifest.runId).toBe('4242');
  });

  it('recusa produzir manifesto de production a partir de uma decisão de staging', () => {
    expect(() =>
      buildDeploymentManifest({
        assessment: {
          ...base,
          environment: 'production',
          agentRecommendation: 'eligible_for_staging',
          policyDecision: 'eligible_for_staging',
          requiresHumanApproval: false,
        },
      }),
    ).toThrow(/recusado/i);
  });
});
