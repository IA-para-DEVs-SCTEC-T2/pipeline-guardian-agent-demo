import { describe, expect, it } from 'vitest';

import {
  analyzeOperational,
  buildOperationalModelRequest,
  groundInferences,
  groundObservedFacts,
} from '../src/analyze-operational.mjs';
import { buildOperationalContext } from '../src/collect-operational-context.mjs';
import { buildDeterministicOperationalDiagnosis } from '../src/operational-classifier.mjs';
import { loadFixtureContext } from '../src/operational-report.mjs';
import {
  modelOperationalDiagnosisSchema,
  operationalDiagnosisSchema,
} from '../schemas/operational-diagnosis-schema.mjs';

const NO_MODEL_ENV = {};
/** Só a chave: `OPENAI_MODEL` é opcional e o padrão é `gpt-5-mini`. */
const MODEL_ENV = { OPENAI_API_KEY: 'sk-test-0123456789abcdef' };

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
    summary: 'A rota funcional respondeu 500 enquanto o health check seguiu em 200.',
    affectedPhase: 'functional',
    observedFacts: [
      {
        id: 'F1',
        source: 'railway:runtime',
        phase: 'functional',
        timestamp: '2026-07-30T15:21:04.502Z',
        // Trecho que existe mesmo na fixture — senão a ancoragem o descartaria.
        excerpt: "falha ao gerar o relatório do álbum: Cannot read properties of undefined (reading 'quantity')",
      },
    ],
    inferences: [
      {
        statement: 'O processo está vivo e a falha é da regra de negócio.',
        supportedBy: ['F1'],
        confidence: 'high',
      },
    ],
    probableCause: 'Uma figurinha sem o campo `quantity` chega a `buildReport`.',
    causeStrength: 'direct_evidence',
    recommendedActions: ['Cobrir o caso com teste antes de reimplantar.'],
    limitations: [],
    ...overrides,
  };
}

const SUCCESS = () => loadFixtureContext('success');
const FAILURE = () => loadFixtureContext('functional-failure');

/* ------------------------------------------------------------------------- */
/* Cenário saudável completo                                                  */
/* ------------------------------------------------------------------------- */

describe('cenário saudável completo', () => {
  it('aprova, não inventa falha e lista as fontes verificadas', async () => {
    const { diagnosis } = await analyzeOperational({ context: SUCCESS(), env: NO_MODEL_ENV });

    expect(() => operationalDiagnosisSchema.parse(diagnosis)).not.toThrow();
    expect(diagnosis.technicalStatus.overall).toBe('success');
    expect(diagnosis.technicalStatus.ci).toBe('success');
    expect(diagnosis.technicalStatus.smokeTest).toBe('success');
    expect(diagnosis.affectedPhase).toBe('success');
    expect(diagnosis.probableCause).toBeNull();
    expect(diagnosis.causeStrength).toBe('unavailable');
    expect(diagnosis.correlationStatus).toBe('matched');
    expect(diagnosis.summary).toMatch(/Fontes verificadas/i);
  });

  it('não trata o ECONNREFUSED da subida como evidência de problema', () => {
    const context = SUCCESS();
    const smoke = context.textSources.find((entry) => entry.source === 'smoke:deployment');

    // O log verde TEM as linhas de erro da subida — elas não podem virar fato.
    expect(smoke.content).toContain('ECONNREFUSED');
    expect(smoke.content).toContain('HTTP 502');

    const deterministic = buildDeterministicOperationalDiagnosis({ context });
    const excerpts = deterministic.observedFacts.map((fact) => fact.excerpt).join(' ');

    expect(excerpts).not.toContain('ECONNREFUSED');
    expect(excerpts).not.toContain('HTTP 502');
  });

  it('toda inferência aponta para fatos que existem', async () => {
    const { diagnosis } = await analyzeOperational({ context: SUCCESS(), env: NO_MODEL_ENV });
    const ids = new Set(diagnosis.observedFacts.map((fact) => fact.id));

    expect(diagnosis.inferences.length).toBeGreaterThan(0);
    for (const inference of diagnosis.inferences) {
      expect(inference.supportedBy.length).toBeGreaterThan(0);
      for (const id of inference.supportedBy) {
        expect(ids.has(id), `inferência cita fato inexistente: ${id}`).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Cenário de falha funcional completo                                        */
/* ------------------------------------------------------------------------- */

describe('cenário de falha funcional completo', () => {
  it('reprova e nomeia a fase funcional', async () => {
    const { diagnosis } = await analyzeOperational({ context: FAILURE(), env: NO_MODEL_ENV });

    expect(() => operationalDiagnosisSchema.parse(diagnosis)).not.toThrow();
    expect(diagnosis.technicalStatus.overall).toBe('failure');
    expect(diagnosis.technicalStatus.ci).toBe('success');
    expect(diagnosis.technicalStatus.railwayDeployment).toBe('success');
    expect(diagnosis.technicalStatus.smokeTest).toBe('failure');
    expect(diagnosis.affectedPhase).toBe('functional');
  });

  it('distingue processo vivo de funcionalidade quebrada', async () => {
    const { diagnosis } = await analyzeOperational({ context: FAILURE(), env: NO_MODEL_ENV });

    expect(diagnosis.summary).toMatch(/processo está vivo|funcionalidade/i);

    const phases = diagnosis.observedFacts.map((fact) => fact.phase);
    // Os dois lados do contraste precisam estar no relatório.
    expect(phases).toContain('healthcheck');
    expect(phases).toContain('functional');

    const inference = diagnosis.inferences[0];
    expect(inference.statement).toMatch(/em execução|disponibilidade/i);
  });

  it('traz o erro interno da aplicação, não só o HTTP 500 visto de fora', async () => {
    const { diagnosis } = await analyzeOperational({ context: FAILURE(), env: NO_MODEL_ENV });

    const internal = diagnosis.observedFacts.filter((fact) => fact.source === 'railway:runtime');
    expect(internal.length).toBeGreaterThan(0);
    expect(diagnosis.observedFacts.map((fact) => fact.excerpt).join(' ')).toMatch(
      /Cannot read properties of undefined/,
    );
  });

  it('compara `/api/health` e `/api/report` no material coletado', () => {
    const context = FAILURE();
    const smoke = context.textSources.find((entry) => entry.source === 'smoke:deployment').content;

    expect(smoke).toMatch(/GET \/api\/health -> HTTP 200/);
    expect(smoke).toMatch(/GET \/api\/report -> HTTP 500/);
    expect(context.systemFacts.smokeTest.health.passed).toBe(true);
    expect(context.systemFacts.smokeTest.functional.passed).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Ancoragem                                                                  */
/* ------------------------------------------------------------------------- */

describe('ancoragem de fatos', () => {
  const textSources = [
    { source: 'railway:runtime', content: 'falha ao gerar o relatório do álbum: TypeError inesperado' },
  ];

  it('mantém o fato cujo trecho existe no material', () => {
    const { facts, dropped } = groundObservedFacts({
      facts: [
        { id: 'F1', source: 'railway:runtime', phase: 'functional', timestamp: null, excerpt: 'falha ao gerar o relatório do álbum' },
      ],
      textSources,
    });

    expect(dropped).toBe(0);
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe('F1');
  });

  it('rejeita evidência inventada', () => {
    const { facts, dropped } = groundObservedFacts({
      facts: [
        { id: 'F1', source: 'railway:runtime', phase: 'functional', timestamp: null, excerpt: 'FATAL: banco de dados indisponível na porta 5432' },
      ],
      textSources,
    });

    expect(facts).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('renumera os ids e mantém supportedBy apontando para o fato certo', () => {
    const { facts, idMap } = groundObservedFacts({
      facts: [
        { id: 'F1', source: 'x', phase: 'functional', timestamp: null, excerpt: 'trecho que não existe em lugar nenhum' },
        { id: 'F2', source: 'railway:runtime', phase: 'functional', timestamp: null, excerpt: 'falha ao gerar o relatório do álbum' },
      ],
      textSources,
    });

    // F2 sobreviveu e virou F1.
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe('F1');
    expect(idMap.get('F2')).toBe('F1');

    const { inferences } = groundInferences({
      inferences: [{ statement: 'algo', supportedBy: ['F2'], confidence: 'high' }],
      facts,
      idMap,
    });

    expect(inferences[0].supportedBy).toEqual(['F1']);
  });

  it('remove inferência sem nenhum fato válido', () => {
    const { inferences, dropped } = groundInferences({
      inferences: [
        { statement: 'sem apoio', supportedBy: ['F9'], confidence: 'high' },
        { statement: 'sem apoio nenhum', supportedBy: [], confidence: 'low' },
      ],
      facts: [{ id: 'F1' }],
      idMap: new Map(),
    });

    expect(inferences).toHaveLength(0);
    expect(dropped).toBe(2);
  });
});

/* ------------------------------------------------------------------------- */
/* Reconciliação com o modelo                                                 */
/* ------------------------------------------------------------------------- */

describe('com o modelo disponível', () => {
  it('usa a saída do modelo quando ela é válida e ancorada', async () => {
    const { diagnosis } = await analyzeOperational({
      context: FAILURE(),
      env: MODEL_ENV,
      client: fakeClient(modelOutput()),
    });

    expect(diagnosis.usedFallback).toBe(false);
    expect(diagnosis.summary).toMatch(/rota funcional respondeu 500/);
    expect(diagnosis.causeStrength).toBe('direct_evidence');
    expect(diagnosis.observedFacts[0].source).toBe('railway:runtime');
  });

  it('um modelo ALARMISTA não reprova um deployment saudável', async () => {
    const { diagnosis } = await analyzeOperational({
      context: SUCCESS(),
      env: MODEL_ENV,
      client: fakeClient(
        modelOutput({
          summary: 'Incidente grave: a aplicação está fora do ar!',
          affectedPhase: 'startup',
          probableCause: 'O container caiu.',
          causeStrength: 'direct_evidence',
        }),
      ),
    });

    // O fato prevalece — e a divergência aparece.
    expect(diagnosis.technicalStatus.overall).toBe('success');
    expect(diagnosis.affectedPhase).toBe('success');
    expect(diagnosis.probableCause).toBeNull();
    expect(diagnosis.causeStrength).toBe('unavailable');
    expect(diagnosis.limitations.join(' ')).toMatch(/descartada.*aprovaram esta release/i);
  });

  it('um modelo OTIMISTA não aprova um deployment quebrado', async () => {
    const { diagnosis } = await analyzeOperational({
      context: FAILURE(),
      env: MODEL_ENV,
      client: fakeClient(
        modelOutput({ summary: 'Tudo certo!', affectedPhase: 'success', probableCause: null, causeStrength: 'unavailable' }),
      ),
    });

    expect(diagnosis.technicalStatus.overall).toBe('failure');
    expect(diagnosis.affectedPhase).not.toBe('success');
    expect(diagnosis.affectedPhase).toBe('functional');
    expect(diagnosis.limitations.join(' ')).toMatch(/descartada.*reprovou esta release/i);
  });

  it('descarta fato inventado e declara a limitação', async () => {
    const { diagnosis } = await analyzeOperational({
      context: FAILURE(),
      env: MODEL_ENV,
      client: fakeClient(
        modelOutput({
          observedFacts: [
            {
              id: 'F1',
              source: 'railway:runtime',
              phase: 'functional',
              timestamp: null,
              excerpt: 'FATAL: conexão com o banco de dados recusada na porta 5432',
            },
          ],
        }),
      ),
    });

    const excerpts = diagnosis.observedFacts.map((fact) => fact.excerpt).join(' ');
    expect(excerpts).not.toContain('banco de dados recusada');
    expect(diagnosis.limitations.join(' ')).toMatch(/não foram encontrados no material coletado/i);
  });

  it('remove inferência que perdeu o fato que a sustentava', async () => {
    const { diagnosis } = await analyzeOperational({
      context: FAILURE(),
      env: MODEL_ENV,
      client: fakeClient(
        modelOutput({
          inferences: [
            { statement: 'Uma conclusão sem apoio nenhum.', supportedBy: ['F42'], confidence: 'high' },
          ],
        }),
      ),
    });

    expect(diagnosis.inferences.every((inference) => inference.statement !== 'Uma conclusão sem apoio nenhum.')).toBe(
      true,
    );
  });

  it('nunca expõe technicalStatus como campo a preencher pelo modelo', () => {
    const context = FAILURE();
    const deterministic = buildDeterministicOperationalDiagnosis({ context });
    const { payload } = buildOperationalModelRequest({ context, deterministic });
    const parsed = JSON.parse(payload);

    // O status chega ao modelo como FATO, para ser descrito...
    expect(parsed.technicalStatus.overall).toBe('failure');

    // ...e o schema de saída sequer tem o campo para ele sobrescrever. É esta
    // ausência — e não uma regra de validação — que torna impossível ao modelo
    // aprovar ou reprovar um deployment.
    const modelFields = Object.keys(modelOperationalDiagnosisSchema.shape);
    expect(modelFields).not.toContain('technicalStatus');
    expect(modelFields).not.toContain('sourceCoverage');
    expect(modelFields).not.toContain('correlationStatus');
    expect(modelFields).toContain('summary');
  });
});

/* ------------------------------------------------------------------------- */
/* Degradação                                                                 */
/* ------------------------------------------------------------------------- */

describe('fallback', () => {
  it('sem OpenAI, produz diagnóstico válido com usedFallback true', async () => {
    const { diagnosis } = await analyzeOperational({ context: FAILURE(), env: NO_MODEL_ENV });

    expect(diagnosis.usedFallback).toBe(true);
    expect(diagnosis.model).toBe('gpt-5-mini');
    expect(diagnosis.modelUsage).toBeNull();
    expect(() => operationalDiagnosisSchema.parse(diagnosis)).not.toThrow();
  });

  it('falha da OpenAI vira categoria, sem esconder a falha da release', async () => {
    const cases = [
      [Object.assign(new Error('invalid api key sk-proj-abc123defghi'), { status: 401 }), 'authentication'],
      [Object.assign(new Error('slow down'), { status: 429 }), 'rate_limit'],
      [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'network'],
      [Object.assign(new Error('deu ruim'), { code: 'ETIMEDOUT' }), 'timeout'],
    ];

    for (const [error, expected] of cases) {
      const { diagnosis } = await analyzeOperational({
        context: FAILURE(),
        env: MODEL_ENV,
        client: fakeClient(null, { throws: error }),
      });

      expect(diagnosis.modelErrorCategory).toBe(expected);
      expect(diagnosis.usedFallback).toBe(true);
      expect(diagnosis.technicalStatus.overall).toBe('failure');
      expect(diagnosis.affectedPhase).toBe('functional');
      expect(JSON.stringify(diagnosis)).not.toContain('sk-proj-abc123defghi');
    }
  });

  it('saída fora do schema cai no fallback', async () => {
    const { diagnosis } = await analyzeOperational({
      context: FAILURE(),
      env: MODEL_ENV,
      client: fakeClient({ summary: 'faltam campos', affectedPhase: 'apocalipse' }),
    });

    expect(diagnosis.usedFallback).toBe(true);
    expect(diagnosis.modelErrorCategory).toBe('invalid_output');
    expect(diagnosis.affectedPhase).toBe('functional');
  });

  it('resposta incompleta cai no fallback', async () => {
    const { diagnosis } = await analyzeOperational({
      context: FAILURE(),
      env: MODEL_ENV,
      client: fakeClient(null, { response: { status: 'incomplete', output_parsed: null } }),
    });

    expect(diagnosis.usedFallback).toBe(true);
    expect(diagnosis.modelErrorCategory).toBe('incomplete');
  });

  it('a falha da coleta do Railway não reprova um deployment saudável', async () => {
    const context = buildOperationalContext({
      metadata: { repository: 'senai/copa-figurinhas', commitSha: '4c1f9ab72e3d05b8a6c4f1e290d7b3568af02c19' },
      ciLogs: { lint: 'ok', tests: 'ok', build: 'ok', docker: 'ok' },
      railway: { metadata: null, streams: { build: [], deploy: [], runtime: [] } },
      deploymentLog: '[2026-07-30T13:00:01.000Z] health check: aprovado na tentativa 1\nSMOKE TEST RESULT: PASS',
      smokeResult: { status: 'success', checks: { health: { passed: true }, functional: { passed: true } } },
      env: {
        QUALITY_RESULT: 'success',
        TESTS_RESULT: 'success',
        BUILD_RESULT: 'success',
        DOCKER_RESULT: 'success',
      },
    });

    const { diagnosis } = await analyzeOperational({ context, env: NO_MODEL_ENV });

    expect(diagnosis.technicalStatus.overall).toBe('success');
    expect(diagnosis.affectedPhase).toBe('success');
    expect(diagnosis.sourceCoverage.railwayBuild).toBe(false);
    expect(diagnosis.limitations.join(' ')).toMatch(/Railway/i);
  });
});

/* ------------------------------------------------------------------------- */
/* Mismatch de versão                                                         */
/* ------------------------------------------------------------------------- */

describe('mismatch de SHA', () => {
  function mismatchContext() {
    return buildOperationalContext({
      metadata: { repository: 'senai/copa-figurinhas', commitSha: '4c1f9ab72e3d05b8a6c4f1e290d7b3568af02c19' },
      ciLogs: { lint: 'ok', tests: 'ok', build: 'ok', docker: 'ok' },
      railway: {
        metadata: {
          requestedCommitSha: '4c1f9ab72e3d05b8a6c4f1e290d7b3568af02c19',
          observedCommitSha: 'e82b60d5f1a94c37bd08e25a71f3c6094ab1d7e2',
          deploymentId: 'dep-outro',
          deploymentStatus: 'success',
          correlationStatus: 'mismatch',
          limitations: [],
        },
        streams: { build: [], deploy: [], runtime: [] },
      },
      deploymentLog: 'SMOKE TEST RESULT: FAIL',
      smokeResult: { status: 'failure', checks: { health: { passed: false }, functional: { passed: false } } },
      env: {
        QUALITY_RESULT: 'success',
        TESTS_RESULT: 'success',
        BUILD_RESULT: 'success',
        DOCKER_RESULT: 'success',
      },
    });
  }

  it('destaca a divergência acima de qualquer outra análise', async () => {
    const { diagnosis } = await analyzeOperational({ context: mismatchContext(), env: NO_MODEL_ENV });

    expect(diagnosis.correlationStatus).toBe('mismatch');
    expect(diagnosis.affectedPhase).toBe('version_mismatch');
    expect(diagnosis.expectedCommitSha).toMatch(/^4c1f9ab/);
    expect(diagnosis.observedCommitSha).toMatch(/^e82b60d/);
    expect(diagnosis.limitations.join(' ')).toMatch(/não.*é a versão esperada/i);
  });

  it('não afirma causa da aplicação a partir de logs de outra release', async () => {
    const { diagnosis } = await analyzeOperational({ context: mismatchContext(), env: NO_MODEL_ENV });

    expect(diagnosis.inferences[0].statement).toMatch(/outra release/i);
    expect(diagnosis.recommendedActions.join(' ')).toMatch(/qual commit está de fato em execução/i);
  });
});
