import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, it, expect } from 'vitest';

import { analyzePipeline, canUseModel, buildModelPayload, writeReports } from '../src/analyze-pipeline.mjs';
import { collectContext } from '../src/collect-context.mjs';
import { classifyFailure } from '../src/deterministic-classifier.mjs';
import { diagnosisSchema } from '../schemas/diagnosis-schema.mjs';
import { simulateFailure, simulateSuccess } from '../src/simulate-failure.mjs';

const NO_KEY_ENV = {};
const MODEL_ENV = { OPENAI_API_KEY: 'sk-test-0123456789abcdef', OPENAI_MODEL: 'gpt-4.1-mini' };

/** Cliente OpenAI falso: devolve o que o teste mandar, sem tocar a rede. */
function fakeClient(output, { throws = null } = {}) {
  return {
    responses: {
      parse: async () => {
        if (throws) throw throws;
        return { status: 'completed', output_parsed: output };
      },
    },
  };
}

function modelOutput(overrides = {}) {
  return {
    summary: 'O teste de percentual de conclusão falhou.',
    signal: 'test:AssertionError',
    failureType: 'test',
    probableCause: 'A condição de "obtida" passou a exigir quantity > 1.',
    evidence: [{ source: 'log:test', excerpt: 'AssertionError: expected 33 to be 50 // Object.is equality' }],
    impact: 'A Pull Request não pode ser mesclada.',
    riskLevel: 'medium',
    confidence: 'high',
    nextSteps: ['Corrigir a comparação em buildReport.'],
    limitations: [],
    ...overrides,
  };
}

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function tempOutDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-guardian-'));
  tempDirs.push(dir);
  return dir;
}

describe('canUseModel', () => {
  it('exige chave E modelo', () => {
    expect(canUseModel({})).toBe(false);
    expect(canUseModel({ OPENAI_API_KEY: 'sk-x' })).toBe(false);
    expect(canUseModel({ OPENAI_MODEL: 'gpt-4.1-mini' })).toBe(false);
    expect(canUseModel(MODEL_ENV)).toBe(true);
  });
});

describe('fallback sem OPENAI_API_KEY', () => {
  it('gera diagnóstico válido, marcado como fallback', async () => {
    const { diagnosis } = await analyzePipeline({ source: simulateFailure('test'), env: NO_KEY_ENV });

    expect(() => diagnosisSchema.parse(diagnosis)).not.toThrow();
    expect(diagnosis.usedFallback).toBe(true);
    expect(diagnosis.failureType).toBe('test');
    expect(diagnosis.pipelineStatus).toBe('failed');
    expect(diagnosis.deployDecision).toBe('blocked');
    expect(diagnosis.limitations.join(' ')).toMatch(/OPENAI_API_KEY/);
  });

  it('cai no fallback quando o modelo lança erro', async () => {
    const { diagnosis } = await analyzePipeline({
      source: simulateFailure('build'),
      env: MODEL_ENV,
      client: fakeClient(null, { throws: new Error('connection refused') }),
    });

    expect(diagnosis.usedFallback).toBe(true);
    expect(diagnosis.failureType).toBe('build');
    expect(diagnosis.limitations.join(' ')).toMatch(/connection refused/);
    expect(() => diagnosisSchema.parse(diagnosis)).not.toThrow();
  });

  it('cai no fallback quando a saída do modelo é inválida', async () => {
    const { diagnosis } = await analyzePipeline({
      source: simulateFailure('lint'),
      env: MODEL_ENV,
      client: fakeClient({ summary: 'saída fora do schema', failureType: 'flaky' }),
    });

    expect(diagnosis.usedFallback).toBe(true);
    expect(diagnosis.failureType).toBe('lint');
    expect(() => diagnosisSchema.parse(diagnosis)).not.toThrow();
  });
});

describe('análise com modelo', () => {
  it('usa a saída do modelo e não marca fallback', async () => {
    const { diagnosis } = await analyzePipeline({
      source: simulateFailure('test'),
      env: MODEL_ENV,
      client: fakeClient(modelOutput()),
    });

    expect(diagnosis.usedFallback).toBe(false);
    expect(diagnosis.summary).toBe('O teste de percentual de conclusão falhou.');
    expect(diagnosis.probableCause).toMatch(/quantity > 1/);
  });

  it('a política sobrescreve a recomendação insegura do modelo', async () => {
    // O modelo diz "risco baixo, pode seguir"; o pipeline está vermelho por teste.
    const { diagnosis } = await analyzePipeline({
      source: simulateFailure('test'),
      env: MODEL_ENV,
      client: fakeClient(modelOutput({ riskLevel: 'low', confidence: 'high' })),
    });

    expect(diagnosis.deployDecision).toBe('blocked');
    expect(diagnosis.requiresHumanApproval).toBe(true);
  });

  it('descarta evidência que não existe no material coletado', async () => {
    const { diagnosis } = await analyzePipeline({
      source: simulateFailure('test'),
      env: MODEL_ENV,
      client: fakeClient(
        modelOutput({
          evidence: [{ source: 'log:test', excerpt: 'TypeError: cannot read property foo of undefined' }],
        }),
      ),
    });

    const excerpts = diagnosis.evidence.map((item) => item.excerpt).join(' ');
    expect(excerpts).not.toMatch(/cannot read property foo/);
    expect(diagnosis.limitations.join(' ')).toMatch(/não foram encontradas/i);
  });

  it('mascara segredo que venha na saída do modelo', async () => {
    const { diagnosis } = await analyzePipeline({
      source: simulateFailure('test'),
      env: MODEL_ENV,
      client: fakeClient(
        modelOutput({ summary: 'Vazou o token ghp_9AbCdEfGhIjKlMnOpQrStUvWxYz012345 no log.' }),
      ),
    });

    expect(JSON.stringify(diagnosis)).not.toContain('ghp_9AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    expect(diagnosis.summary).toContain('[REDACTED]');
  });

  it('sobrescreve o tipo para security quando o scanner acha segredo', async () => {
    const { diagnosis } = await analyzePipeline({
      source: simulateFailure('security'),
      env: MODEL_ENV,
      client: fakeClient(modelOutput({ failureType: 'lint', riskLevel: 'low' })),
    });

    expect(diagnosis.failureType).toBe('security');
    expect(diagnosis.riskLevel).toBe('high');
    expect(diagnosis.deployDecision).toBe('blocked');
  });
});

describe('payload enviado ao modelo', () => {
  it('vai mascarado e sem o log dos comandos que passaram', () => {
    const source = simulateFailure('security');
    const context = collectContext(source);
    const classification = classifyFailure({
      sources: context.failureSources,
      secretsDetected: context.sensitive.hasSensitiveData,
      hasFailedCommands: true,
    });

    const payload = buildModelPayload({ context, classification });

    expect(payload).not.toMatch(/sk-proj-/);
    expect(payload).not.toMatch(/ghp_/);
    expect(payload).not.toMatch(/S3nh4-Sup3r-S3cr3t4/);
    expect(payload).toContain('[REDACTED]');
    expect(payload).toContain('segredo detectado');
  });
});

describe('política de staging ponta a ponta', () => {
  it('libera pipeline verde em staging', async () => {
    const { diagnosis } = await analyzePipeline({ source: simulateSuccess(), env: NO_KEY_ENV });

    expect(diagnosis.pipelineStatus).toBe('success');
    expect(diagnosis.deployDecision).toBe('eligible_for_staging');
    expect(diagnosis.requiresHumanApproval).toBe(false);
  });

  it('não bloqueia um pipeline verde cujo diff apenas MENCIONA padrões de erro', async () => {
    // Regressão encontrada no modo real: o diff que adiciona uma config de
    // ESLint contém "no-unused-vars", "no-undef" e "ESLint". O classificador
    // lia o diff e reprovava um pipeline que passou.
    const source = simulateSuccess();
    source.diff.patch += [
      '',
      'diff --git a/eslint.config.js b/eslint.config.js',
      '+++ b/eslint.config.js',
      "+      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],",
      "+      'no-undef': 'error',",
      '+    // regras do ESLint para o novo workspace',
      '',
    ].join('\n');

    const { diagnosis } = await analyzePipeline({ source, env: NO_KEY_ENV });

    expect(diagnosis.pipelineStatus).toBe('success');
    expect(diagnosis.failureType).toBe('unknown');
    expect(diagnosis.signal).toBe('no-failure-detected');
    expect(diagnosis.deployDecision).toBe('eligible_for_staging');
  });

  it('exige aprovação humana no mesmo pipeline verde em production', async () => {
    const { diagnosis } = await analyzePipeline({
      source: simulateSuccess({ environment: 'production' }),
      env: NO_KEY_ENV,
    });

    expect(diagnosis.deployDecision).toBe('requires_human_approval');
    expect(diagnosis.requiresHumanApproval).toBe(true);
  });

  it('exige aprovação humana em rollback de production', async () => {
    const { diagnosis } = await analyzePipeline({
      source: simulateSuccess({ environment: 'production', isRollback: true }),
      env: NO_KEY_ENV,
    });

    expect(diagnosis.deployDecision).toBe('requires_human_approval');
  });
});

describe('writeReports', () => {
  it('grava diagnosis.json e diagnosis.md', async () => {
    const outDir = tempOutDir();
    const { diagnosis, policy } = await analyzePipeline({
      source: simulateFailure('test'),
      env: NO_KEY_ENV,
    });

    const { jsonPath, markdownPath } = writeReports({ diagnosis, policy, outDir });

    const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const markdown = readFileSync(markdownPath, 'utf8');

    expect(() => diagnosisSchema.parse(json)).not.toThrow();
    expect(markdown).toContain('# 🛡️ Pipeline Guardian');
    expect(markdown).toContain('## Decisão de deploy');
  });
});
