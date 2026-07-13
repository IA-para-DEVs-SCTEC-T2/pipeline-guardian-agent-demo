import { describe, it, expect } from 'vitest';

import { collectContext } from '../src/collect-context.mjs';
import { buildDeterministicDiagnosis, classifyFailure } from '../src/deterministic-classifier.mjs';
import { SCENARIOS, simulateFailure, simulateSuccess } from '../src/simulate-failure.mjs';

/** Classifica um cenário do jeito que o agente classifica: sobre o log já mascarado de quem falhou. */
function classifyScenario(scenario) {
  const context = collectContext(simulateFailure(scenario));

  return {
    context,
    classification: classifyFailure({
      sources: context.failureSources,
      secretsDetected: context.sensitive.hasSensitiveData,
      hasFailedCommands: context.results.failedCommands.length > 0,
      hasCommands: context.commands.length > 0,
    }),
  };
}

describe('classifyFailure: um cenário para cada tipo', () => {
  for (const scenario of SCENARIOS) {
    it(`classifica o fixture "${scenario}" como ${scenario}`, () => {
      const { classification } = classifyScenario(scenario);
      expect(classification.failureType).toBe(scenario);
    });
  }
});

describe('classifyFailure: sinal e confiança', () => {
  it('dá confiança alta quando vários padrões do mesmo tipo aparecem', () => {
    const { classification } = classifyScenario('lint');

    expect(classification.confidence).toBe('high');
    expect(classification.signal).toContain('lint');
    expect(classification.matches.length).toBeGreaterThan(0);
  });

  it('dá confiança baixa quando nenhum padrão confiável aparece', () => {
    const { classification } = classifyScenario('unknown');

    expect(classification.failureType).toBe('unknown');
    expect(classification.signal).toBe('no-reliable-pattern');
    expect(classification.confidence).toBe('low');
  });

  it('dá confiança baixa quando dois tipos empatam (ambiguidade)', () => {
    const classification = classifyFailure({
      sources: [
        {
          source: 'log:ci',
          // um padrão de lint e um de dependency: empate
          content: 'no-undef em src/app.js\nERR_MODULE_NOT_FOUND ao importar zod',
        },
      ],
      hasFailedCommands: true,
    });

    expect(classification.ambiguous).toBe(true);
    expect(classification.confidence).toBe('low');
  });

  it('reconhece pipeline verde sem inventar falha', () => {
    const context = collectContext(simulateSuccess());
    const classification = classifyFailure({
      sources: context.failureSources,
      secretsDetected: context.sensitive.hasSensitiveData,
      hasFailedCommands: context.results.failedCommands.length > 0,
      hasCommands: context.commands.length > 0,
    });

    expect(classification.failureType).toBe('unknown');
    expect(classification.signal).toBe('no-failure-detected');
    expect(classification.confidence).toBe('high');
  });

  it('não inventa falha de lint quando o próprio código mencionado é o assunto do diff', () => {
    // Regressão: um diff que ADICIONA uma config de ESLint contém as strings
    // `no-unused-vars` e `no-undef`. Com o pipeline verde, isso não é falha.
    const classification = classifyFailure({
      sources: [],
      hasFailedCommands: false,
      hasCommands: true,
    });

    expect(classification.failureType).toBe('unknown');
    expect(classification.signal).toBe('no-failure-detected');
  });

  it('marca confiança baixa quando nenhum comando foi observado', () => {
    const classification = classifyFailure({ sources: [], hasFailedCommands: false, hasCommands: false });

    expect(classification.signal).toBe('no-commands-observed');
    expect(classification.confidence).toBe('low');
  });
});

describe('classifyFailure: segurança prevalece', () => {
  it('classifica como security quando o scanner encontra segredo, mesmo com outros padrões', () => {
    const classification = classifyFailure({
      sources: [{ source: 'log:test', content: 'FAIL AssertionError: expected 1 received 2' }],
      secretsDetected: true,
      hasFailedCommands: true,
    });

    expect(classification.failureType).toBe('security');
    expect(classification.riskLevel).toBe('high');
    expect(classification.confidence).toBe('high');
  });
});

describe('buildDeterministicDiagnosis', () => {
  it('produz um diagnóstico completo sem modelo', () => {
    const { context, classification } = classifyScenario('test');

    const diagnosis = buildDeterministicDiagnosis({
      classification,
      evidence: [{ source: 'log:test', excerpt: 'AssertionError: expected 33 to be 50' }],
      failedCommands: context.results.failedCommands,
      limitations: context.limitations,
    });

    expect(diagnosis.failureType).toBe('test');
    expect(diagnosis.summary).toContain('npm run test');
    expect(diagnosis.probableCause).toMatch(/teste/i);
    expect(diagnosis.nextSteps.length).toBeGreaterThan(0);
    expect(diagnosis.limitations[0]).toMatch(/determinístico/i);
  });
});
