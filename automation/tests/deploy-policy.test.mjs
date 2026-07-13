import { describe, it, expect } from 'vitest';

import { applyDeployPolicy, findRelevantLimitations } from '../src/deploy-policy.mjs';

/** Diagnóstico "limpo": pipeline verde, sem falha, confiança alta. */
function greenDiagnosis(overrides = {}) {
  return {
    summary: 'Pipeline verde.',
    signal: 'no-failure-detected',
    failureType: 'unknown',
    probableCause: 'Nenhuma falha observada.',
    evidence: [],
    impact: 'Nenhum.',
    riskLevel: 'low',
    confidence: 'high',
    nextSteps: [],
    limitations: [],
    ...overrides,
  };
}

const greenResults = { pipelineStatus: 'success', failedCommands: [], passedCommands: [], skippedCommands: [] };
const redResults = { pipelineStatus: 'failed', failedCommands: [{ command: 'npm run test' }], passedCommands: [], skippedCommands: [] };

function policyFor(diagnosis, metadata, results = greenResults, sensitive = { hasSensitiveData: false, findings: [] }) {
  return applyDeployPolicy({ diagnosis, metadata, results, sensitive });
}

describe('política: staging com todos os gates aprovados', () => {
  it('libera para staging', () => {
    const policy = policyFor(greenDiagnosis(), { environment: 'staging', isRollback: false });

    expect(policy.deployDecision).toBe('eligible_for_staging');
    expect(policy.requiresHumanApproval).toBe(false);
    expect(policy.riskLevel).toBe('low');
  });
});

describe('política: production', () => {
  it('exige aprovação humana mesmo com pipeline verde', () => {
    const policy = policyFor(greenDiagnosis(), { environment: 'production', isRollback: false });

    expect(policy.deployDecision).toBe('requires_human_approval');
    expect(policy.requiresHumanApproval).toBe(true);
  });

  it('exige aprovação humana em rollback de production', () => {
    const policy = policyFor(greenDiagnosis(), { environment: 'production', isRollback: true });

    expect(policy.deployDecision).toBe('requires_human_approval');
    expect(policy.reasons.join(' ')).toMatch(/rollback/i);
  });

  it('exige aprovação humana em ambiente não reconhecido', () => {
    const policy = policyFor(greenDiagnosis(), { environment: 'unknown', isRollback: false });

    expect(policy.deployDecision).toBe('requires_human_approval');
  });
});

describe('política: gates de bloqueio', () => {
  const blocking = ['lint', 'test', 'build', 'permission', 'security'];

  for (const failureType of blocking) {
    it(`bloqueia quando a falha é de ${failureType}`, () => {
      const policy = policyFor(
        greenDiagnosis({ failureType, confidence: 'high' }),
        { environment: 'staging', isRollback: false },
        redResults,
      );

      expect(policy.deployDecision).toBe('blocked');
      expect(policy.requiresHumanApproval).toBe(true);
    });
  }

  it('bloqueia e eleva o risco para high quando há segredo detectado', () => {
    const policy = policyFor(
      greenDiagnosis({ failureType: 'security', riskLevel: 'low', confidence: 'high' }),
      { environment: 'staging', isRollback: false },
      redResults,
      { hasSensitiveData: true, findings: [{ source: 'log:scan', rule: 'openai-api-key', count: 1 }] },
    );

    expect(policy.deployDecision).toBe('blocked');
    expect(policy.riskLevel).toBe('high');
    expect(policy.reasons.join(' ')).toMatch(/sensível/i);
  });

  it('bloqueia quando a confiança é baixa, mesmo em staging e com falha não bloqueante', () => {
    const policy = policyFor(
      greenDiagnosis({ failureType: 'unknown', confidence: 'low' }),
      { environment: 'staging', isRollback: false },
    );

    expect(policy.deployDecision).toBe('blocked');
    expect(policy.reasons.join(' ')).toMatch(/confiança baixa/i);
  });

  it('bloqueia quando há limitação relevante na análise', () => {
    const policy = policyFor(
      greenDiagnosis({ limitations: ['Logs de comando ausentes no contexto coletado.'] }),
      { environment: 'staging', isRollback: false },
    );

    expect(policy.deployDecision).toBe('blocked');
    expect(policy.reasons.join(' ')).toMatch(/limitações relevantes/i);
  });

  it('bloqueia quando o pipeline está vermelho, mesmo com tipo não bloqueante', () => {
    const policy = policyFor(
      greenDiagnosis({ failureType: 'dependency', confidence: 'high' }),
      { environment: 'staging', isRollback: false },
      redResults,
    );

    expect(policy.deployDecision).toBe('blocked');
  });

  it('bloqueio prevalece sobre production: nunca vira apenas "aprovação humana"', () => {
    const policy = policyFor(
      greenDiagnosis({ failureType: 'test', confidence: 'high' }),
      { environment: 'production', isRollback: false },
      redResults,
    );

    expect(policy.deployDecision).toBe('blocked');
  });
});

describe('política: risco só escala, nunca reduz', () => {
  it('mantém o risco alto apontado pelo diagnóstico', () => {
    const policy = policyFor(
      greenDiagnosis({ riskLevel: 'high' }),
      { environment: 'staging', isRollback: false },
    );

    expect(policy.riskLevel).toBe('high');
  });
});

describe('findRelevantLimitations', () => {
  it('reconhece limitações que indicam falta de evidência', () => {
    const relevant = findRelevantLimitations([
      'Diff da Pull Request não disponível.',
      'Logs de comando ausentes no contexto coletado.',
      'Diagnóstico gerado pelo classificador determinístico, por correspondência de padrões nos logs.',
    ]);

    expect(relevant).toHaveLength(2);
  });

  it('não trata a nota de fallback como limitação bloqueante', () => {
    const relevant = findRelevantLimitations([
      'Diagnóstico gerado pelo classificador determinístico, por correspondência de padrões nos logs.',
      'Logs longos foram reduzidos aos trechos relevantes (cabeçalho, erros e final).',
    ]);

    expect(relevant).toEqual([]);
  });
});
