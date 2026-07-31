/**
 * O modelo unificado de execução — etapas, primeira falha e as duas formas do
 * relatório (resumo curto no verde, explicação detalhada no vermelho).
 *
 * O que estes testes protegem, acima de tudo: **o modelo de linguagem não
 * decide nada aqui**. Ele pode escrever o texto; a etapa que esse texto
 * descreve, o resultado geral e a decisão do gate saem de regras que não olham
 * para a saída dele. Um modelo otimista não aprova uma execução quebrada e um
 * alarmista não reprova uma saudável.
 */

import { describe, expect, it } from 'vitest';

import { analyzeOperational } from '../src/analyze-operational.mjs';
import { buildOperationalContext } from '../src/collect-operational-context.mjs';
import { loadFixtureContext } from '../src/operational-report.mjs';
import {
  buildPipelineExecution,
  buildStages,
  determineFirstFailedStage,
  normalizeJobResult,
  shortenToTwoSentences,
} from '../src/pipeline-execution.mjs';
import {
  PIPELINE_STAGES,
  STAGE_IDS,
  STAGE_STATUSES,
  pipelineExecutionSchema,
} from '../schemas/pipeline-execution-schema.mjs';

const NO_MODEL_ENV = {};
const MODEL_ENV = { OPENAI_API_KEY: 'sk-test-0123456789abcdef' };

/** Cliente OpenAI falso — nenhum teste desta suíte toca a rede. */
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

/** Uma execução completa a partir de um cenário versionado. */
async function runScenario(name, { env = NO_MODEL_ENV, client = null, scope } = {}) {
  const context = loadFixtureContext(name);
  const { diagnosis } = await analyzeOperational({ context, env, client });
  const resolvedScope = scope ?? (context.sourceCoverage.smokeTest ? 'cd' : 'ci');

  return { context, diagnosis, execution: buildPipelineExecution({ diagnosis, context, scope: resolvedScope }) };
}

function statusOf(execution, stage) {
  return execution.stages.find((entry) => entry.stage === stage)?.status;
}

/* ------------------------------------------------------------------------- */
/* 1–10 · Modelo de execução                                                  */
/* ------------------------------------------------------------------------- */

describe('modelo de execução', () => {
  it('1. aceita os cinco status permitidos e nenhum outro', () => {
    expect(STAGE_STATUSES).toEqual(['success', 'failure', 'skipped', 'not_reached', 'unknown']);

    for (const status of STAGE_STATUSES) {
      const stages = PIPELINE_STAGES.map((entry) => ({ ...entry, status, evidenceIds: [], note: null }));
      expect(() => stageArraySchema(stages)).not.toThrow();
    }

    const invalid = PIPELINE_STAGES.map((entry) => ({
      ...entry,
      status: 'cancelled',
      evidenceIds: [],
      note: null,
    }));
    expect(() => stageArraySchema(invalid)).toThrow();
  });

  it('2. mantém as etapas na ordem real do pipeline', () => {
    expect(STAGE_IDS).toEqual([
      'ci_quality',
      'ci_tests',
      'ci_build',
      'ci_docker',
      'ci_gate',
      'railway_build',
      'railway_deploy',
      'startup',
      'healthcheck',
      'functional',
      'smoke_test',
      'cd_gate',
    ]);
  });

  it('3. aponta ci_quality quando o lint reprova', async () => {
    const { execution } = await runScenario('ci-lint-failure');
    expect(execution.firstFailedStage).toBe('ci_quality');
  });

  it('4. aponta ci_tests quando a suíte reprova', async () => {
    const { execution } = await runScenario('ci-tests-failure');
    expect(execution.firstFailedStage).toBe('ci_tests');
  });

  it('5. aponta ci_docker quando a imagem não é construída', async () => {
    const { execution } = await runScenario('ci-docker-failure');
    expect(execution.firstFailedStage).toBe('ci_docker');
  });

  it('6. aponta functional quando a rota de negócio reprova', async () => {
    const { execution } = await runScenario('cd-functional-failure');
    expect(execution.firstFailedStage).toBe('functional');
  });

  it('7. não trata `skipped` como falha', () => {
    const stages = stagesWith({ ci_quality: 'skipped', ci_tests: 'skipped' });
    expect(determineFirstFailedStage(stages, { overallStatus: 'unknown' })).toBeNull();
  });

  it('8. não trata `not_reached` como falha', () => {
    const stages = stagesWith({ railway_build: 'not_reached', smoke_test: 'not_reached' });
    expect(determineFirstFailedStage(stages, { overallStatus: 'unknown' })).toBeNull();
  });

  it('9. não trata `unknown` automaticamente como falha', () => {
    const stages = stagesWith({ startup: 'unknown', healthcheck: 'unknown' });

    expect(determineFirstFailedStage(stages, { overallStatus: 'unknown' })).toBeNull();
    // Com o resultado técnico reprovado e nenhuma etapa responsabilizável, a
    // resposta é `unknown` — nunca uma etapa sorteada.
    expect(determineFirstFailedStage(stages, { overallStatus: 'failure' })).toBe('unknown');
  });

  it('10. devolve null quando nada falhou', async () => {
    const { execution } = await runScenario('success');

    expect(execution.overallStatus).toBe('success');
    expect(execution.firstFailedStage).toBeNull();
  });

  it('percorre a ordem: a primeira falha vence a segunda', () => {
    const stages = stagesWith({ ci_tests: 'failure', functional: 'failure' });
    expect(determineFirstFailedStage(stages, { overallStatus: 'failure' })).toBe('ci_tests');
  });

  it('normaliza `cancelled` para `not_reached`, nunca para falha', () => {
    expect(normalizeJobResult('cancelled')).toBe('not_reached');
    expect(normalizeJobResult('skipped')).toBe('skipped');
    expect(normalizeJobResult('success')).toBe('success');
    expect(normalizeJobResult('failure')).toBe('failure');
    expect(normalizeJobResult('')).toBe('unknown');
    expect(normalizeJobResult(undefined)).toBe('unknown');
    expect(normalizeJobResult('qualquer coisa')).toBe('unknown');
  });
});

/* ------------------------------------------------------------------------- */
/* 11–16 · Relatório saudável                                                 */
/* ------------------------------------------------------------------------- */

describe('relatório de execução saudável', () => {
  it('11. traz a linha do tempo completa, toda verde', async () => {
    const { execution } = await runScenario('success');

    expect(execution.stages).toHaveLength(PIPELINE_STAGES.length);
    for (const stage of execution.stages) {
      expect(stage.status, `etapa ${stage.stage}`).toBe('success');
    }
  });

  it('12. produz um resumo curto — no máximo duas frases', async () => {
    const { execution } = await runScenario('success');

    expect(execution.successSummary).toBeTruthy();
    expect(execution.successSummary.length).toBeLessThanOrEqual(320);
    expect(execution.successSummary.split(/[.!?]+\s/).length).toBeLessThanOrEqual(2);
  });

  it('13. não produz explicação de falha', async () => {
    const { execution } = await runScenario('success');
    expect(execution.failureExplanation).toBeNull();
  });

  it('14. não aponta causa provável', async () => {
    const { diagnosis } = await runScenario('success');

    expect(diagnosis.probableCause).toBeNull();
    expect(diagnosis.causeStrength).toBe('unavailable');
  });

  it('15. não recomenda ação nenhuma', async () => {
    const { diagnosis } = await runScenario('success');
    expect(diagnosis.recommendedActions).toEqual([]);
  });

  it('16. não inventa risco: nenhum vocabulário de alerta no resumo', async () => {
    const { execution } = await runScenario('success');

    for (const term of ['risco', 'atenção', 'alerta', 'problema', 'instável', 'degrada']) {
      expect(execution.successSummary.toLowerCase(), `resumo verde citou "${term}"`).not.toContain(term);
    }
  });

  it('uma fonte opcional ausente não transforma execução saudável em falha', async () => {
    const context = buildOperationalContext({
      metadata: { repository: 'senai/copa-figurinhas', commitSha: '4c1f9ab72e3d05b8a6c4f1e290d7b3568af02c19' },
      ciLogs: { lint: 'ok', tests: 'ok', build: 'ok', docker: 'ok' },
      // Sem nenhum log do Railway: a coleta opcional não aconteceu.
      railway: { metadata: null, streams: { build: [], deploy: [], runtime: [] } },
      deploymentLog: '[2026-07-30T13:00:01.000Z] health check: aprovado na tentativa 1\nSMOKE TEST RESULT: PASS',
      smokeResult: {
        status: 'success',
        checks: { health: { passed: true, attempts: 1 }, functional: { passed: true, attempts: 1 } },
      },
      env: { QUALITY_RESULT: 'success', TESTS_RESULT: 'success', BUILD_RESULT: 'success', DOCKER_RESULT: 'success' },
    });

    const { diagnosis } = await analyzeOperational({ context, env: NO_MODEL_ENV });
    const execution = buildPipelineExecution({ diagnosis, context, scope: 'cd' });

    expect(execution.overallStatus).toBe('success');
    expect(execution.firstFailedStage).toBeNull();
    expect(execution.gate.status).toBe('approved');
    // A ausência vira limitação declarada, não etapa reprovada.
    expect(execution.limitations.join(' ')).toMatch(/Railway/i);
    expect(statusOf(execution, 'healthcheck')).toBe('success');
  });

  it('encurta um resumo longo sem cortar no meio da frase', () => {
    const long = `${'Primeira frase. '}${'Segunda frase. '}${'Terceira frase que não deveria aparecer. '}`;
    expect(shortenToTwoSentences(long)).toBe('Primeira frase. Segunda frase.');
    expect(shortenToTwoSentences(`${'x'.repeat(500)}.`)).toHaveLength(320);
  });
});

/* ------------------------------------------------------------------------- */
/* 17–24 · Relatório com falha                                                */
/* ------------------------------------------------------------------------- */

describe('relatório de execução com falha', () => {
  it('17. destaca a primeira falha e só ela', async () => {
    const { execution } = await runScenario('cd-functional-failure');

    expect(execution.firstFailedStage).toBe('functional');
    expect(execution.failureExplanation.stage).toBe('functional');
    expect(execution.failureExplanation.label).toBe('Rota funcional');
  });

  it('18. marca corretamente as etapas anteriores e posteriores', async () => {
    const { execution } = await runScenario('cd-functional-failure');

    expect(statusOf(execution, 'ci_quality')).toBe('success');
    expect(statusOf(execution, 'ci_gate')).toBe('success');
    expect(statusOf(execution, 'startup')).toBe('success');
    expect(statusOf(execution, 'healthcheck')).toBe('success');
    expect(statusOf(execution, 'functional')).toBe('failure');
    expect(statusOf(execution, 'smoke_test')).toBe('failure');
    expect(statusOf(execution, 'cd_gate')).toBe('failure');
  });

  it('19. produz a explicação da falha', async () => {
    const { execution } = await runScenario('cd-functional-failure');
    const explanation = execution.failureExplanation;

    expect(explanation.whatHappened.length).toBeGreaterThan(0);
    expect(explanation.confidence).toMatch(/^(low|medium|high)$/);
  });

  it('20. ancora as evidências: todo id citado existe entre os fatos', async () => {
    const { execution } = await runScenario('cd-functional-failure');
    const ids = new Set(execution.observedFacts.map((fact) => fact.id));

    expect(execution.failureExplanation.evidenceIds.length).toBeGreaterThan(0);
    for (const id of execution.failureExplanation.evidenceIds) {
      expect(ids.has(id), `evidência inexistente: ${id}`).toBe(true);
    }
  });

  it('21. separa causa provável de fato, com a força declarada', async () => {
    const { execution } = await runScenario('cd-functional-failure');
    const explanation = execution.failureExplanation;

    expect(explanation.probableCause).toBeTruthy();
    // O classificador determinístico nunca emite `direct_evidence`: padrão
    // sustenta hipótese, não causa comprovada.
    expect(explanation.causeStrength).not.toBe('direct_evidence');
    expect(explanation.probableCause).not.toBe(explanation.whatHappened);
  });

  it('22. traz ações recomendadas específicas ao erro observado', async () => {
    const { execution } = await runScenario('cd-functional-failure');
    const actions = execution.failureExplanation.recommendedActions;

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.join(' ')).toMatch(/functional\.report\.failed|\/api\/report/);
  });

  it('22b. nunca recomenda rollback automático, autocorreção ou mudança de infra sem revisão', async () => {
    for (const scenario of ['ci-lint-failure', 'ci-tests-failure', 'ci-docker-failure', 'cd-functional-failure']) {
      const { execution } = await runScenario(scenario);
      const actions = execution.failureExplanation.recommendedActions.join(' ').toLowerCase();

      for (const forbidden of ['rollback automático', 'autocorreção', 'corrigir automaticamente', 'reimplantar automaticamente']) {
        expect(actions, `${scenario} recomendou: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('23. declara as limitações da explicação', async () => {
    const { execution } = await runScenario('cd-functional-failure');
    expect(execution.failureExplanation.limitations.length).toBeGreaterThan(0);
  });

  it('24. fecha o gate certo, por regra determinística', async () => {
    const { execution } = await runScenario('cd-functional-failure');

    expect(execution.gate).toEqual({ type: 'cd', status: 'rejected', determinedBy: 'deterministic' });
  });

  it('não trata as etapas não alcançadas como falhas independentes', async () => {
    const { execution } = await runScenario('ci-lint-failure');
    const explanation = execution.failureExplanation;

    // Uma falha, sete etapas que nunca começaram.
    const failures = execution.stages.filter((stage) => stage.status === 'failure');
    expect(failures.map((stage) => stage.stage)).toEqual(['ci_quality', 'ci_gate']);
    expect(explanation.notReachedStages).toContain('Railway Build');
    expect(explanation.notReachedStages).toContain('Smoke test');
  });

  it('a explicação cobre só a falha principal — não há uma por etapa', async () => {
    const { execution } = await runScenario('ci-docker-failure');

    expect(execution.failureExplanation).not.toBeNull();
    expect(execution.failureExplanation.stage).toBe('ci_docker');
    // As etapas saudáveis anteriores não ganham texto nenhum.
    for (const stage of execution.stages) {
      expect(stage.note).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------------- */
/* 25–32 · IA e fallback                                                      */
/* ------------------------------------------------------------------------- */

describe('a IA explica; ela não decide', () => {
  /** Saída do modelo que existe de verdade na fixture de falha funcional. */
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
          excerpt: "falha ao gerar o relatório do álbum: Cannot read properties of undefined (reading 'quantity')",
        },
      ],
      inferences: [
        { statement: 'O processo está vivo e a falha é da regra de negócio.', supportedBy: ['F1'], confidence: 'high' },
      ],
      probableCause: 'Uma figurinha sem o campo `quantity` chega a `buildReport`.',
      causeStrength: 'direct_evidence',
      recommendedActions: ['Cobrir o caso com teste antes de reimplantar.'],
      limitations: [],
      ...overrides,
    };
  }

  it('25. o modelo não altera o status das etapas', async () => {
    const { execution } = await runScenario('cd-functional-failure', {
      env: MODEL_ENV,
      client: fakeClient(modelOutput({ summary: 'Está tudo perfeito.', affectedPhase: 'success' })),
    });

    expect(execution.overallStatus).toBe('failure');
    expect(statusOf(execution, 'healthcheck')).toBe('success');
    expect(statusOf(execution, 'functional')).toBe('failure');
    expect(statusOf(execution, 'cd_gate')).toBe('failure');
  });

  it('26. o modelo não altera a primeira etapa que falhou', async () => {
    const otimista = await runScenario('cd-functional-failure', {
      env: MODEL_ENV,
      client: fakeClient(modelOutput({ affectedPhase: 'success' })),
    });
    const desviado = await runScenario('cd-functional-failure', {
      env: MODEL_ENV,
      client: fakeClient(modelOutput({ affectedPhase: 'ci_quality' })),
    });
    const semModelo = await runScenario('cd-functional-failure');

    expect(otimista.execution.firstFailedStage).toBe('functional');
    expect(desviado.execution.firstFailedStage).toBe('functional');
    expect(semModelo.execution.firstFailedStage).toBe('functional');
  });

  it('27. um modelo OTIMISTA não aprova uma execução com falha', async () => {
    const { execution } = await runScenario('cd-functional-failure', {
      env: MODEL_ENV,
      client: fakeClient(
        modelOutput({
          summary: 'Deployment concluído com sucesso, nenhuma ação necessária.',
          affectedPhase: 'success',
          probableCause: null,
          causeStrength: 'unavailable',
          recommendedActions: [],
        }),
      ),
    });

    expect(execution.overallStatus).toBe('failure');
    expect(execution.gate.status).toBe('rejected');
    expect(execution.gate.determinedBy).toBe('deterministic');
    expect(execution.successSummary).toBeNull();
    expect(execution.failureExplanation).not.toBeNull();
  });

  it('28. um modelo ALARMISTA não reprova uma execução saudável', async () => {
    const { execution } = await runScenario('success', {
      env: MODEL_ENV,
      client: fakeClient(
        modelOutput({
          summary: 'Incidente grave: a aplicação está fora do ar!',
          affectedPhase: 'startup',
          probableCause: 'O container caiu.',
          causeStrength: 'direct_evidence',
          recommendedActions: ['Fazer rollback imediatamente.'],
        }),
      ),
    });

    expect(execution.overallStatus).toBe('success');
    expect(execution.gate.status).toBe('approved');
    expect(execution.firstFailedStage).toBeNull();
    expect(execution.failureExplanation).toBeNull();
    expect(statusOf(execution, 'startup')).toBe('success');
    expect(execution.limitations.join(' ')).toMatch(/descartada.*aprovaram esta release/i);
    expect(execution.limitations.join(' ')).toMatch(/recomendaç.*descartadas/i);
  });

  it('29. evidência inventada é removida da execução', async () => {
    const { execution } = await runScenario('cd-functional-failure', {
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

    expect(JSON.stringify(execution.observedFacts)).not.toContain('banco de dados recusada');
    expect(execution.limitations.join(' ')).toMatch(/não foram encontrados no material coletado/i);
  });

  it('30. evidenceId inexistente não sobrevive na explicação', async () => {
    const { execution } = await runScenario('cd-functional-failure', {
      env: MODEL_ENV,
      client: fakeClient(
        modelOutput({
          inferences: [{ statement: 'Conclusão sem apoio.', supportedBy: ['F42'], confidence: 'high' }],
        }),
      ),
    });

    const ids = new Set(execution.observedFacts.map((fact) => fact.id));
    for (const inference of execution.inferences) {
      for (const id of inference.supportedBy) expect(ids.has(id)).toBe(true);
    }
    for (const id of execution.failureExplanation.evidenceIds) expect(ids.has(id)).toBe(true);
  });

  it('31. falha da OpenAI ativa o fallback sem esconder a falha técnica', async () => {
    const { execution } = await runScenario('cd-functional-failure', {
      env: MODEL_ENV,
      client: fakeClient(null, {
        throws: Object.assign(new Error('invalid api key sk-proj-abc123defghi'), { status: 401 }),
      }),
    });

    expect(execution.usedFallback).toBe(true);
    expect(execution.overallStatus).toBe('failure');
    expect(execution.firstFailedStage).toBe('functional');
    expect(execution.gate.status).toBe('rejected');
    expect(JSON.stringify(execution)).not.toContain('sk-proj-abc123defghi');
  });

  it('32. ausência da chave ativa o fallback e a estrutura é a mesma', async () => {
    const comModelo = await runScenario('cd-functional-failure', {
      env: MODEL_ENV,
      client: fakeClient(modelOutput()),
    });
    const semModelo = await runScenario('cd-functional-failure');

    expect(semModelo.execution.usedFallback).toBe(true);
    expect(comModelo.execution.usedFallback).toBe(false);

    // Mesmos campos, mesma etapa, mesmo gate: o que muda é a qualidade do
    // texto, nunca a decisão.
    expect(Object.keys(semModelo.execution.failureExplanation).sort()).toEqual(
      Object.keys(comModelo.execution.failureExplanation).sort(),
    );
    expect(semModelo.execution.firstFailedStage).toBe(comModelo.execution.firstFailedStage);
    expect(semModelo.execution.gate).toEqual(comModelo.execution.gate);
  });
});

/* ------------------------------------------------------------------------- */
/* 33–40 · Os cinco cenários                                                  */
/* ------------------------------------------------------------------------- */

describe('os cinco cenários do Dia 1', () => {
  it('33. success — tudo verde, sem causa nem recomendação inventada', async () => {
    const { execution } = await runScenario('success');

    expect(() => pipelineExecutionSchema.parse(execution)).not.toThrow();
    expect(execution.overallStatus).toBe('success');
    expect(execution.firstFailedStage).toBeNull();
    expect(execution.failureExplanation).toBeNull();
    expect(execution.successSummary).toBeTruthy();
    expect(execution.gate).toEqual({ type: 'cd', status: 'approved', determinedBy: 'deterministic' });
  });

  it('34. ci-lint-failure — análise estática reprovada, com arquivo e regra', async () => {
    const { execution } = await runScenario('ci-lint-failure');

    expect(execution.scope).toBe('ci');
    expect(execution.firstFailedStage).toBe('ci_quality');
    expect(execution.gate).toEqual({ type: 'ci', status: 'rejected', determinedBy: 'deterministic' });

    const evidence = execution.observedFacts.map((fact) => fact.excerpt).join(' ');
    expect(evidence).toContain('no-unused-vars');
    expect(evidence).toContain('totalDuplicates');
    expect(execution.failureExplanation.recommendedActions.join(' ')).toMatch(/npm run lint/);
  });

  it('35. ci-tests-failure — expectativa e valor observado no relatório', async () => {
    const { execution } = await runScenario('ci-tests-failure');

    expect(execution.firstFailedStage).toBe('ci_tests');
    // Lint aprovado e comportamento reprovado: a distinção do cenário.
    expect(statusOf(execution, 'ci_quality')).toBe('success');
    expect(statusOf(execution, 'ci_tests')).toBe('failure');

    const evidence = execution.observedFacts.map((fact) => fact.excerpt).join(' ');
    expect(evidence).toMatch(/expected 3 to be 4/);
    expect(evidence).toMatch(/report\.test\.js/);
  });

  it('36. ci-docker-failure — imagem não criada e o caminho ausente citado', async () => {
    const { execution } = await runScenario('ci-docker-failure');

    expect(execution.firstFailedStage).toBe('ci_docker');
    expect(statusOf(execution, 'ci_build')).toBe('success');

    const evidence = execution.observedFacts.map((fact) => fact.excerpt).join(' ');
    expect(evidence).toContain('/app/frontend/build');
    expect(evidence).toMatch(/not found/i);
    expect(execution.failureExplanation.recommendedActions.join(' ')).toMatch(/docker build/i);
  });

  it('37. cd-functional-failure — processo vivo, funcionalidade quebrada', async () => {
    const { execution } = await runScenario('cd-functional-failure');

    expect(execution.firstFailedStage).toBe('functional');
    expect(execution.failureExplanation.whatHappened).toMatch(/processo está vivo|funcionalidade/i);

    const evidence = execution.observedFacts.map((fact) => fact.excerpt).join(' ');
    // Evidência interna (o erro da aplicação) e externa (o smoke test).
    expect(evidence).toMatch(/Cannot read properties of undefined/);
    expect(execution.observedFacts.some((fact) => fact.source.startsWith('railway:'))).toBe(true);
    expect(execution.observedFacts.some((fact) => fact.phase === 'healthcheck')).toBe(true);
  });

  it('38. health 200 e functional 500 são etapas distintas', async () => {
    const { execution, context } = await runScenario('cd-functional-failure');

    expect(context.systemFacts.smokeTest.health.passed).toBe(true);
    expect(context.systemFacts.smokeTest.functional.passed).toBe(false);
    expect(statusOf(execution, 'healthcheck')).toBe('success');
    expect(statusOf(execution, 'functional')).toBe('failure');
  });

  it('39. falha de CI não produz etapa de CD alguma', async () => {
    for (const scenario of ['ci-lint-failure', 'ci-tests-failure', 'ci-docker-failure']) {
      const { execution } = await runScenario(scenario);

      for (const stage of ['railway_build', 'railway_deploy', 'startup', 'healthcheck', 'functional', 'smoke_test', 'cd_gate']) {
        expect(statusOf(execution, stage), `${scenario}/${stage}`).toBe('not_reached');
      }
      expect(execution.gate.type).toBe('ci');
    }
  });

  it('40. falha de CD acontece com o CI aprovado', async () => {
    const { execution } = await runScenario('cd-functional-failure');

    for (const stage of ['ci_quality', 'ci_tests', 'ci_build', 'ci_docker', 'ci_gate']) {
      expect(statusOf(execution, stage), stage).toBe('success');
    }
    expect(execution.gate.type).toBe('cd');
    expect(execution.gate.status).toBe('rejected');
  });
});

/* ------------------------------------------------------------------------- */
/* Correlação de versão                                                       */
/* ------------------------------------------------------------------------- */

describe('mismatch de versão vence toda outra fase', () => {
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
      smokeResult: {
        status: 'failure',
        checks: { health: { passed: false, attempts: 30 }, functional: { passed: false, attempts: 0 } },
      },
      env: { QUALITY_RESULT: 'success', TESTS_RESULT: 'success', BUILD_RESULT: 'success', DOCKER_RESULT: 'success' },
    });
  }

  it('não atribui nenhuma etapa de CD ao commit em análise', async () => {
    const context = mismatchContext();
    const { diagnosis } = await analyzeOperational({ context, env: NO_MODEL_ENV });
    const execution = buildPipelineExecution({ diagnosis, context, scope: 'cd' });

    expect(execution.correlationStatus).toBe('mismatch');
    // Os logs são de outra release: `unknown`, não `failure`.
    for (const stage of ['railway_build', 'startup', 'healthcheck', 'functional', 'smoke_test']) {
      expect(statusOf(execution, stage), stage).toBe('unknown');
    }
    expect(execution.firstFailedStage).toBe('unknown');
    expect(execution.limitations.join(' ')).toMatch(/não.*é a versão esperada/i);
  });
});

/* ------------------------------------------------------------------------- */
/* Nada do Dia 2 nem do Dia 3                                                 */
/* ------------------------------------------------------------------------- */

describe('escopo do Dia 1', () => {
  it('56. nenhum termo de anomalia ou previsão aparece na saída', async () => {
    const outputs = [];
    for (const scenario of ['success', 'ci-lint-failure', 'ci-tests-failure', 'ci-docker-failure', 'cd-functional-failure']) {
      const { execution } = await runScenario(scenario);
      outputs.push(JSON.stringify(execution).toLowerCase());
    }

    const forbidden = [
      'anomal',
      'baseline',
      'z-score',
      'zscore',
      'desvio-padrão',
      'média móvel',
      'mediana móvel',
      'tendência',
      'previsão',
      'preditiv',
      'probabilidade de falha',
      'rollback automático',
      '[anomalia]',
      '[previsão]',
      '[risco futuro]',
      '[tendência]',
    ];

    for (const output of outputs) {
      for (const term of forbidden) {
        expect(output, `saída do Dia 1 citou "${term}"`).not.toContain(term);
      }
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

/** Uma lista de etapas com `unknown` por padrão e os overrides pedidos. */
function stagesWith(overrides = {}) {
  return PIPELINE_STAGES.map((entry) => ({
    ...entry,
    status: overrides[entry.stage] ?? 'unknown',
    evidenceIds: [],
    note: null,
  }));
}

/** Valida uma lista de etapas isoladamente, sem montar a execução inteira. */
function stageArraySchema(stages) {
  return pipelineExecutionSchema.shape.stages.parse(stages);
}

/** `buildStages` é exportado e usado diretamente pelos renderizadores. */
describe('buildStages', () => {
  it('preenche as evidências de cada etapa a partir da fase do fato', async () => {
    const context = loadFixtureContext('cd-functional-failure');
    const { diagnosis } = await analyzeOperational({ context, env: NO_MODEL_ENV });
    const stages = buildStages({ context, diagnosis, scope: 'cd' });

    const functional = stages.find((stage) => stage.stage === 'functional');
    expect(functional.evidenceIds.length).toBeGreaterThan(0);
    for (const id of functional.evidenceIds) {
      const fact = diagnosis.observedFacts.find((entry) => entry.id === id);
      expect(['functional', 'runtime']).toContain(fact.phase);
    }
  });
});
