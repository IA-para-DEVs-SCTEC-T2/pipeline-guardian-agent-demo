import { describe, it, expect } from 'vitest';

import {
  DEPLOY_DECISIONS,
  FAILURE_TYPES,
  diagnosisSchema,
  modelDiagnosisSchema,
} from '../schemas/diagnosis-schema.mjs';

/** Diagnóstico mínimo válido, usado como base nos testes. */
function validDiagnosis(overrides = {}) {
  return {
    analysisId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    requestId: 'req-1',
    repository: 'senai/copa-figurinhas',
    branch: 'feat/ordenar-figurinhas',
    commitSha: 'c0f4a17b93e2d5486ab1e77c2d9f4b6a0e3c81df',
    pipelineStatus: 'failed',
    summary: 'Testes falharam.',
    signal: 'test:AssertionError',
    failureType: 'test',
    probableCause: 'Um teste comparou 33 com 50.',
    evidence: [{ source: 'log:test', excerpt: 'AssertionError: expected 33 to be 50' }],
    impact: 'Entrega bloqueada.',
    riskLevel: 'medium',
    confidence: 'high',
    nextSteps: ['Rodar npm run test.'],
    deployDecision: 'blocked',
    requiresHumanApproval: true,
    limitations: [],
    usedFallback: true,
    generatedAt: '2026-07-13T12:00:00.000Z',
    ...overrides,
  };
}

describe('diagnosisSchema', () => {
  it('aceita um diagnóstico completo', () => {
    const parsed = diagnosisSchema.parse(validDiagnosis());
    expect(parsed.failureType).toBe('test');
    expect(parsed.deployDecision).toBe('blocked');
  });

  it('exige todos os campos do contrato', () => {
    const expected = [
      'analysisId',
      'requestId',
      'repository',
      'branch',
      'commitSha',
      'pipelineStatus',
      'summary',
      'signal',
      'failureType',
      'probableCause',
      'evidence',
      'impact',
      'riskLevel',
      'confidence',
      'nextSteps',
      'deployDecision',
      'requiresHumanApproval',
      'limitations',
      'usedFallback',
      'generatedAt',
    ];

    expect(Object.keys(diagnosisSchema.shape)).toEqual(expected);
  });

  it('rejeita failureType fora do enum', () => {
    const result = diagnosisSchema.safeParse(validDiagnosis({ failureType: 'flaky' }));
    expect(result.success).toBe(false);
  });

  it('rejeita deployDecision fora do enum', () => {
    const result = diagnosisSchema.safeParse(validDiagnosis({ deployDecision: 'deploy_now' }));
    expect(result.success).toBe(false);
  });

  it('rejeita pipelineStatus fora do enum', () => {
    const result = diagnosisSchema.safeParse(validDiagnosis({ pipelineStatus: 'red' }));
    expect(result.success).toBe(false);
  });

  it('rejeita campo obrigatório ausente', () => {
    const { summary: _summary, ...withoutSummary } = validDiagnosis();
    expect(diagnosisSchema.safeParse(withoutSummary).success).toBe(false);
  });

  it('rejeita generatedAt que não é data ISO', () => {
    const result = diagnosisSchema.safeParse(validDiagnosis({ generatedAt: 'ontem' }));
    expect(result.success).toBe(false);
  });

  it('rejeita evidência sem fonte', () => {
    const result = diagnosisSchema.safeParse(
      validDiagnosis({ evidence: [{ excerpt: 'sem fonte' }] }),
    );
    expect(result.success).toBe(false);
  });

  it('cobre os oito tipos de falha e as três decisões', () => {
    expect(FAILURE_TYPES).toHaveLength(8);
    expect(DEPLOY_DECISIONS).toEqual(['eligible_for_staging', 'blocked', 'requires_human_approval']);
  });
});

describe('modelDiagnosisSchema', () => {
  it('não expõe ao modelo os campos de decisão de deploy', () => {
    const keys = Object.keys(modelDiagnosisSchema.shape);

    expect(keys).not.toContain('deployDecision');
    expect(keys).not.toContain('requiresHumanApproval');
    expect(keys).not.toContain('pipelineStatus');
    expect(keys).not.toContain('usedFallback');
  });

  it('descarta campos extras que o modelo tente enviar', () => {
    const parsed = modelDiagnosisSchema.parse({
      summary: 'x',
      signal: 'test:FAIL',
      failureType: 'test',
      probableCause: 'y',
      evidence: [],
      impact: 'z',
      riskLevel: 'low',
      confidence: 'high',
      nextSteps: [],
      limitations: [],
      deployDecision: 'eligible_for_staging',
    });

    expect(parsed.deployDecision).toBeUndefined();
  });
});
