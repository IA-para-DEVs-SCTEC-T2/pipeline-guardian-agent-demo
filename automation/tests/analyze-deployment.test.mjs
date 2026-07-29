import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  analyzeDeployment,
  buildDeploymentModelPayload,
  canUseModel,
  collectDeploymentContext,
  readTechnicalStatus,
  writeDeploymentReports,
} from '../src/analyze-deployment.mjs';
import { classifyDeployment } from '../src/deployment-classifier.mjs';
import { deploymentDiagnosisSchema } from '../schemas/deployment-diagnosis-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, '..', '..', 'samples', 'deployment');

const sample = (name) => readFileSync(join(SAMPLES, `${name}.log`), 'utf8');

const NO_MODEL_ENV = {};
/** Só a chave: `OPENAI_MODEL` é opcional e o padrão é `gpt-5-mini`. */
const MODEL_ENV = { OPENAI_API_KEY: 'sk-test-0123456789abcdef' };

const METADATA = {
  repository: 'senai/copa-figurinhas',
  commitSha: 'b71d004aa9f21c3d5e7',
  targetHost: 'copa-figurinhas-production.up.railway.app',
};

/** Cliente OpenAI falso: devolve o que o teste mandar, sem tocar a rede. */
function fakeClient(output, { throws = null, response = null } = {}) {
  return {
    responses: {
      parse: async () => {
        if (throws) throw throws;
        return response ?? { status: 'completed', output_parsed: output };
      },
    },
  };
}

function modelOutput(overrides = {}) {
  return {
    summary: 'A aplicação respondeu, mas nunca ficou saudável.',
    failureType: 'healthcheck',
    // Trecho que existe mesmo no log — senão a ancoragem o descartaria.
    evidence: [{ source: 'log:deployment', excerpt: 'health check: reprovado após 30 tentativas' }],
    probableCause: 'A aplicação iniciou, mas não concluiu o aquecimento.',
    confidence: 'medium',
    nextSteps: ['Consultar os logs de inicialização no Railway.'],
    limitations: [],
    ...overrides,
  };
}

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'deployment-guardian-'));
  tempDirs.push(dir);
  return dir;
}

/* ------------------------------------------------------------------------- */
/* Fallback determinístico                                                    */
/* ------------------------------------------------------------------------- */

describe('canUseModel', () => {
  it('exige apenas a chave — o modelo tem padrão', () => {
    expect(canUseModel({})).toBe(false);
    expect(canUseModel({ OPENAI_MODEL: 'gpt-x' })).toBe(false);
    expect(canUseModel({ OPENAI_API_KEY: 'sk-x' })).toBe(true);
    expect(canUseModel(MODEL_ENV)).toBe(true);
  });
});

describe('deployment bem-sucedido', () => {
  it('diagnostica sucesso sem procurar falha no log verde', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('success'),
      status: 'success',
      metadata: METADATA,
      env: NO_MODEL_ENV,
    });

    expect(() => deploymentDiagnosisSchema.parse(diagnosis)).not.toThrow();
    expect(diagnosis.stage).toBe('post_deployment_validation');
    expect(diagnosis.status).toBe('success');
    expect(diagnosis.failureType).toBe('success');
    expect(diagnosis.probableCause).toBeNull();
    expect(diagnosis.usedFallback).toBe(true);
  });

  it('não se deixa levar pelas linhas de erro das primeiras tentativas', async () => {
    // O log verde contém ECONNREFUSED e HTTP 502 antes de subir. Nada disso
    // pode virar falha: o resultado técnico foi aprovação.
    expect(sample('success')).toContain('ECONNREFUSED');
    expect(sample('success')).toContain('HTTP 502');

    const { diagnosis } = await analyzeDeployment({
      log: sample('success'),
      status: 'success',
      metadata: METADATA,
      env: NO_MODEL_ENV,
    });

    expect(diagnosis.failureType).toBe('success');
  });
});

describe('falha de health check', () => {
  it('classifica como healthcheck e declara confiança média', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('healthcheck-failure'),
      status: 'failure',
      metadata: METADATA,
      env: NO_MODEL_ENV,
    });

    expect(diagnosis.status).toBe('failure');
    expect(diagnosis.failureType).toBe('healthcheck');
    expect(diagnosis.confidence).toBe('medium');
    expect(diagnosis.evidence.length).toBeGreaterThan(0);
    expect(diagnosis.nextSteps.join(' ')).toMatch(/Railway|PORT|\/api\/health/);
  });

  it('declara que o log do smoke test não é o log da plataforma', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('healthcheck-failure'),
      status: 'failure',
      metadata: METADATA,
      env: NO_MODEL_ENV,
    });

    expect(diagnosis.limitations.join(' ')).toMatch(/não incluem o log interno da plataforma/i);
  });
});

describe('distinção entre os cenários de falha', () => {
  it('separa startup, environment e healthcheck', async () => {
    const cases = [
      ['startup-failure', 'startup'],
      ['environment-failure', 'environment'],
      ['healthcheck-failure', 'healthcheck'],
    ];

    for (const [fixture, expected] of cases) {
      const { diagnosis } = await analyzeDeployment({
        log: sample(fixture),
        status: 'failure',
        metadata: METADATA,
        env: NO_MODEL_ENV,
      });

      expect(diagnosis.failureType).toBe(expected);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Modelo                                                                     */
/* ------------------------------------------------------------------------- */

describe('com o modelo disponível', () => {
  it('usa a saída do modelo quando ela é válida e ancorada', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('healthcheck-failure'),
      status: 'failure',
      metadata: METADATA,
      env: MODEL_ENV,
      client: fakeClient(modelOutput()),
    });

    expect(diagnosis.usedFallback).toBe(false);
    expect(diagnosis.summary).toBe('A aplicação respondeu, mas nunca ficou saudável.');
    expect(diagnosis.probableCause).toBe('A aplicação iniciou, mas não concluiu o aquecimento.');
  });

  it('descarta evidência que não existe no log e declara a limitação', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('healthcheck-failure'),
      status: 'failure',
      metadata: METADATA,
      env: MODEL_ENV,
      client: fakeClient(
        modelOutput({
          evidence: [
            { source: 'log:deployment', excerpt: 'FATAL: banco de dados indisponível na porta 5432' },
          ],
        }),
      ),
    });

    const excerpts = diagnosis.evidence.map((item) => item.excerpt).join(' ');
    expect(excerpts).not.toContain('banco de dados indisponível');
    expect(diagnosis.limitations.join(' ')).toMatch(/não foram encontradas no log coletado/i);
  });

  it('cai no fallback quando o modelo falha, sem esconder a falha do deployment', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('startup-failure'),
      status: 'failure',
      metadata: METADATA,
      env: MODEL_ENV,
      client: fakeClient(null, { throws: new Error('502 Bad Gateway da API') }),
    });

    expect(diagnosis.usedFallback).toBe(true);
    expect(diagnosis.status).toBe('failure');
    expect(diagnosis.failureType).toBe('startup');
    expect(diagnosis.limitations.join(' ')).toMatch(/Falha na análise com modelo/i);
  });

  it('não deixa o modelo declarar sucesso quando o smoke test reprovou', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('healthcheck-failure'),
      status: 'failure',
      metadata: METADATA,
      env: MODEL_ENV,
      client: fakeClient(modelOutput({ failureType: 'success', summary: 'Tudo certo!' })),
    });

    expect(diagnosis.status).toBe('failure');
    expect(diagnosis.failureType).not.toBe('success');
    expect(diagnosis.limitations.join(' ')).toMatch(/descartada.*smoke test reprovou/i);
  });

  it('não deixa o modelo inventar falha quando o smoke test aprovou', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('success'),
      status: 'success',
      metadata: METADATA,
      env: MODEL_ENV,
      client: fakeClient(modelOutput({ failureType: 'network' })),
    });

    expect(diagnosis.status).toBe('success');
    expect(diagnosis.failureType).toBe('success');
    expect(diagnosis.limitations.join(' ')).toMatch(/descartada.*smoke test aprovou/i);
  });
});

describe('metadados observáveis da chamada', () => {
  function fullResponse(output) {
    return {
      id: 'resp_deploy_1',
      model: 'gpt-5-mini-2025-08-07',
      status: 'completed',
      output_parsed: output,
      usage: {
        input_tokens: 900,
        output_tokens: 240,
        output_tokens_details: { reasoning_tokens: 64 },
        total_tokens: 1140,
      },
    };
  }

  it('registra modelo, id, latência e uso quando a chamada conclui', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('healthcheck-failure'),
      status: 'failure',
      metadata: METADATA,
      env: MODEL_ENV,
      client: fakeClient(null, { response: fullResponse(modelOutput()) }),
    });

    expect(diagnosis.usedFallback).toBe(false);
    expect(diagnosis.modelProvider).toBe('openai');
    expect(diagnosis.model).toBe('gpt-5-mini-2025-08-07');
    expect(diagnosis.modelResponseId).toBe('resp_deploy_1');
    expect(diagnosis.modelUsage.totalTokens).toBe(1140);
    expect(diagnosis.modelErrorCategory).toBeNull();
    expect(() => deploymentDiagnosisSchema.parse(diagnosis)).not.toThrow();
  });

  it('usa `gpt-5-mini` como padrão, mesmo sem chave', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('success'),
      status: 'success',
      metadata: METADATA,
      env: NO_MODEL_ENV,
    });

    expect(diagnosis.model).toBe('gpt-5-mini');
    expect(diagnosis.usedFallback).toBe(true);
    expect(diagnosis.modelUsage).toBeNull();
  });

  it('classifica a falha da chamada sem publicar a mensagem bruta', async () => {
    const cases = [
      [Object.assign(new Error('invalid api key sk-proj-abc123defghi'), { status: 401 }), 'authentication'],
      [Object.assign(new Error('slow down'), { status: 429 }), 'rate_limit'],
      [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'network'],
      [Object.assign(new Error('deu ruim'), { code: 'ETIMEDOUT' }), 'timeout'],
    ];

    for (const [error, expected] of cases) {
      const { diagnosis } = await analyzeDeployment({
        log: sample('startup-failure'),
        status: 'failure',
        metadata: METADATA,
        env: MODEL_ENV,
        client: fakeClient(null, { throws: error }),
      });

      expect(diagnosis.modelErrorCategory).toBe(expected);
      expect(diagnosis.usedFallback).toBe(true);
      // A falha do modelo não muda o que o smoke test observou.
      expect(diagnosis.status).toBe('failure');
      expect(diagnosis.failureType).toBe('startup');
      expect(JSON.stringify(diagnosis)).not.toContain('sk-proj-abc123defghi');
    }
  });

  it('trata resposta incompleta e resposta sem saída estruturada como falha do modelo', async () => {
    const incomplete = await analyzeDeployment({
      log: sample('healthcheck-failure'),
      status: 'failure',
      metadata: METADATA,
      env: MODEL_ENV,
      client: fakeClient(null, {
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output_parsed: null,
        },
      }),
    });

    expect(incomplete.diagnosis.usedFallback).toBe(true);
    expect(incomplete.diagnosis.modelErrorCategory).toBe('incomplete');

    const semSaida = await analyzeDeployment({
      log: sample('healthcheck-failure'),
      status: 'failure',
      metadata: METADATA,
      env: MODEL_ENV,
      client: fakeClient(null, { response: { status: 'completed', output_parsed: null } }),
    });

    expect(semSaida.diagnosis.usedFallback).toBe(true);
    expect(semSaida.diagnosis.modelErrorCategory).toBe('invalid_output');

    const foraDoSchema = await analyzeDeployment({
      log: sample('healthcheck-failure'),
      status: 'failure',
      metadata: METADATA,
      env: MODEL_ENV,
      client: fakeClient({ summary: 'sem os demais campos', failureType: 'apocalipse' }),
    });

    expect(foraDoSchema.diagnosis.usedFallback).toBe(true);
    expect(foraDoSchema.diagnosis.modelErrorCategory).toBe('invalid_output');
    expect(foraDoSchema.diagnosis.failureType).toBe('healthcheck');
  });
});

/* ------------------------------------------------------------------------- */
/* Segredos                                                                   */
/* ------------------------------------------------------------------------- */

describe('sanitização de segredos', () => {
  const LEAKY_LOG = [
    '[2026-07-29T14:00:00.000Z] smoke-test: alvo app.exemplo.dev',
    '[2026-07-29T14:00:01.000Z] tentativa 1/30 GET /api/health -> HTTP 503 — esperado 200 · corpo: {"reason":"missing required environment variable: X"}',
    '[2026-07-29T14:00:02.000Z] debug: authorization: Bearer ghp_abcdefghijklmnop1234567890',
    '[2026-07-29T14:00:03.000Z] debug: OPENAI_API_KEY=sk-proj-super-secreto-1234567890',
    '[2026-07-29T14:00:04.000Z] health check: reprovado após 30 tentativas',
    'SMOKE TEST RESULT: FAIL',
  ].join('\n');

  it('mascara o segredo antes de qualquer coisa circular', () => {
    const context = collectDeploymentContext({ log: LEAKY_LOG, status: 'failure' });

    expect(context.log).not.toContain('ghp_abcdefghijklmnop1234567890');
    expect(context.log).not.toContain('sk-proj-super-secreto-1234567890');
    expect(context.log).toContain('[REDACTED]');
    expect(context.sensitive.hasSensitiveData).toBe(true);
  });

  it('não envia conteúdo não mascarado ao modelo', () => {
    const context = collectDeploymentContext({ log: LEAKY_LOG, status: 'failure' });
    const classification = classifyDeployment({ log: context.log, status: 'failure' });
    const payload = buildDeploymentModelPayload({ context, classification });

    expect(payload).not.toContain('ghp_abcdefghijklmnop1234567890');
    expect(payload).not.toContain('sk-proj-super-secreto-1234567890');
  });

  it('não grava segredo no relatório', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: LEAKY_LOG,
      status: 'failure',
      metadata: METADATA,
      env: NO_MODEL_ENV,
    });

    const serialized = JSON.stringify(diagnosis);
    expect(serialized).not.toContain('ghp_abcdefghijklmnop1234567890');
    expect(serialized).not.toContain('sk-proj-super-secreto-1234567890');
  });

  it('nunca expõe `status` ao modelo como algo a decidir', () => {
    const context = collectDeploymentContext({ log: sample('healthcheck-failure'), status: 'failure' });
    const classification = classifyDeployment({ log: context.log, status: 'failure' });
    const payload = JSON.parse(buildDeploymentModelPayload({ context, classification }));

    // O status chega como FATO (`technicalStatus`), e o schema do modelo não
    // tem campo `status` para ele sobrescrever.
    expect(payload.deployment.technicalStatus).toBe('failure');
  });
});

/* ------------------------------------------------------------------------- */
/* Resultado técnico                                                          */
/* ------------------------------------------------------------------------- */

describe('readTechnicalStatus', () => {
  it('prefere o parâmetro explícito', () => {
    const result = readTechnicalStatus({ explicit: 'success', log: 'SMOKE TEST RESULT: FAIL' });
    expect(result.status).toBe('success');
  });

  it('lê o resultado do smoke test quando existe', () => {
    const dir = tempDir();
    const file = join(dir, 'smoke-test.json');
    writeFileSync(file, JSON.stringify({ status: 'success' }), 'utf8');

    const result = readTechnicalStatus({ resultFile: file, log: '' });
    expect(result.status).toBe('success');
    expect(result.source).toMatch(/smoke test/i);
  });

  it('cai na linha de veredito do log', () => {
    const result = readTechnicalStatus({ log: sample('healthcheck-failure') });
    expect(result.status).toBe('failure');
    expect(result.source).toMatch(/veredito/i);

    expect(readTechnicalStatus({ log: sample('success') }).status).toBe('success');
  });

  it('assume failure quando não há origem confiável (fail-closed)', () => {
    const result = readTechnicalStatus({ log: 'log sem veredito nenhum' });

    expect(result.status).toBe('failure');
    expect(result.limitation).toMatch(/não confirmar sucesso é mais seguro/i);
  });
});

/* ------------------------------------------------------------------------- */
/* Relatórios                                                                 */
/* ------------------------------------------------------------------------- */

describe('writeDeploymentReports', () => {
  it('gera JSON válido e Markdown legível', async () => {
    const { diagnosis } = await analyzeDeployment({
      log: sample('healthcheck-failure'),
      status: 'failure',
      metadata: METADATA,
      env: NO_MODEL_ENV,
    });

    const outDir = tempDir();
    const { jsonPath, markdownPath } = writeDeploymentReports({ diagnosis, outDir });

    const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(() => deploymentDiagnosisSchema.parse(json)).not.toThrow();

    const markdown = readFileSync(markdownPath, 'utf8');
    expect(markdown).toContain('# 🚦 Validação pós-deployment');
    expect(markdown).toContain('## Etapa afetada');
    expect(markdown).toContain('## Evidências');
    expect(markdown).toContain('## Causa provável');
    expect(markdown).toContain('## Confiança');
    expect(markdown).toContain('## Próximos passos');
    expect(markdown).toContain('## Limitações');
    expect(markdown).toContain('a IA descreve, não decide');
  });
});
