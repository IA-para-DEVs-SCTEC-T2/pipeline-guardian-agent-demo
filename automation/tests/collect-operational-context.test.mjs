import { describe, expect, it } from 'vitest';

import {
  buildOperationalContext,
  dedupeTimeline,
  deriveTechnicalStatus,
  readCiJobResults,
  readSmokeTestOutcome,
  sortTimeline,
  timelineEvent,
} from '../src/collect-operational-context.mjs';

const SHA = '4c1f9ab72e3d05b8a6c4f1e290d7b3568af02c19';

const GREEN_CI = {
  QUALITY_RESULT: 'success',
  TESTS_RESULT: 'success',
  BUILD_RESULT: 'success',
  DOCKER_RESULT: 'success',
};

/* ------------------------------------------------------------------------- */
/* Fatos do sistema                                                           */
/* ------------------------------------------------------------------------- */

describe('readCiJobResults', () => {
  it('lê os quatro jobs e conclui sucesso', () => {
    const result = readCiJobResults(GREEN_CI);

    expect(result.status).toBe('success');
    expect(result.known).toBe(4);
    expect(result.jobs).toEqual({
      quality: 'success',
      tests: 'success',
      build: 'success',
      'docker-build': 'success',
    });
  });

  it('uma falha reprova o conjunto', () => {
    expect(readCiJobResults({ ...GREEN_CI, TESTS_RESULT: 'failure' }).status).toBe('failure');
  });

  it('variável ausente vira unknown, nunca failure', () => {
    const result = readCiJobResults({});

    expect(result.status).toBe('unknown');
    expect(result.known).toBe(0);
    expect(Object.values(result.jobs).every((value) => value === 'unknown')).toBe(true);
  });

  it('resultado parcial não vira sucesso', () => {
    expect(readCiJobResults({ QUALITY_RESULT: 'success' }).status).toBe('unknown');
  });
});

describe('deriveTechnicalStatus', () => {
  it('aprova quando CI e smoke test passaram', () => {
    expect(deriveTechnicalStatus({ ci: 'success', smokeTest: 'success' }).overall).toBe('success');
  });

  it('reprova quando o smoke test falhou', () => {
    expect(deriveTechnicalStatus({ ci: 'success', smokeTest: 'failure' }).overall).toBe('failure');
  });

  it('reprova quando o CI falhou', () => {
    expect(deriveTechnicalStatus({ ci: 'failure', smokeTest: 'success' }).overall).toBe('failure');
  });

  it('reprova quando a plataforma declarou falha ou crash', () => {
    expect(deriveTechnicalStatus({ ci: 'success', smokeTest: 'success', railwayDeployment: 'failed' }).overall).toBe(
      'failure',
    );
    expect(deriveTechnicalStatus({ ci: 'success', smokeTest: 'success', railwayDeployment: 'crashed' }).overall).toBe(
      'failure',
    );
  });

  it('a AUSÊNCIA de dados do Railway não reprova um deployment saudável', () => {
    // Invariante 7 do Dia 1: falha na coleta não pode virar reprovação.
    const status = deriveTechnicalStatus({ ci: 'success', smokeTest: 'success', railwayDeployment: 'unknown' });
    expect(status.overall).toBe('success');
  });

  it('sem fatos suficientes, o resultado é unknown — não sucesso', () => {
    expect(deriveTechnicalStatus({}).overall).toBe('unknown');
    expect(deriveTechnicalStatus({ ci: 'unknown', smokeTest: 'success' }).overall).toBe('unknown');
  });
});

describe('readSmokeTestOutcome', () => {
  it('lê o veredito do log', () => {
    expect(readSmokeTestOutcome({ log: 'linha\nSMOKE TEST RESULT: PASS' }).status).toBe('success');
    expect(readSmokeTestOutcome({ log: 'linha\nSMOKE TEST RESULT: FAIL' }).status).toBe('failure');
  });

  it('sem origem, declara not_executed em vez de inventar resultado', () => {
    expect(readSmokeTestOutcome({ log: 'sem veredito' }).status).toBe('not_executed');
  });
});

/* ------------------------------------------------------------------------- */
/* Linha do tempo                                                             */
/* ------------------------------------------------------------------------- */

describe('ordenação da linha do tempo', () => {
  const event = (overrides) =>
    timelineEvent({ source: 's', phase: 'runtime', message: 'm', ...overrides });

  it('ordena por timestamp crescente', () => {
    const sorted = sortTimeline([
      event({ timestamp: '2026-07-30T13:00:03.000Z', message: 'terceiro' }),
      event({ timestamp: '2026-07-30T13:00:01.000Z', message: 'primeiro' }),
      event({ timestamp: '2026-07-30T13:00:02.000Z', message: 'segundo' }),
    ]);

    expect(sorted.map((entry) => entry.message)).toEqual(['primeiro', 'segundo', 'terceiro']);
    expect(sorted.map((entry) => entry.order)).toEqual([0, 1, 2]);
  });

  it('manda eventos sem timestamp para o fim e os identifica', () => {
    const sorted = sortTimeline([
      event({ timestamp: null, message: 'sem hora', phase: 'ci_tests' }),
      event({ timestamp: '2026-07-30T13:00:01.000Z', message: 'com hora' }),
    ]);

    expect(sorted[0].message).toBe('com hora');
    expect(sorted[0].hasTimestamp).toBe(true);
    expect(sorted[1].message).toBe('sem hora');
    expect(sorted[1].hasTimestamp).toBe(false);
    expect(sorted[1].timestamp).toBeNull();
  });

  it('entre eventos sem timestamp, ordena por fase', () => {
    const sorted = sortTimeline([
      event({ timestamp: null, phase: 'runtime', message: 'runtime' }),
      event({ timestamp: null, phase: 'ci_quality', message: 'lint' }),
      event({ timestamp: null, phase: 'railway_build', message: 'build' }),
    ]);

    expect(sorted.map((entry) => entry.message)).toEqual(['lint', 'build', 'runtime']);
  });

  it('preserva a origem de cada evento', () => {
    const sorted = sortTimeline([
      event({ source: 'railway:runtime', timestamp: '2026-07-30T13:00:01.000Z' }),
      event({ source: 'smoke:deployment', timestamp: '2026-07-30T13:00:02.000Z' }),
    ]);

    expect(sorted.map((entry) => entry.source)).toEqual(['railway:runtime', 'smoke:deployment']);
  });
});

describe('deduplicação de evidências', () => {
  it('colapsa eventos idênticos e conta as repetições', () => {
    const repeated = Array.from({ length: 30 }, () =>
      timelineEvent({ source: 'smoke:deployment', phase: 'healthcheck', message: 'HTTP 503 degraded' }),
    );

    const deduped = dedupeTimeline(repeated);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].repeated).toBe(30);
  });

  it('não colapsa mensagens diferentes nem fontes diferentes', () => {
    const deduped = dedupeTimeline([
      timelineEvent({ source: 'a', phase: 'runtime', message: 'x' }),
      timelineEvent({ source: 'b', phase: 'runtime', message: 'x' }),
      timelineEvent({ source: 'a', phase: 'runtime', message: 'y' }),
    ]);

    expect(deduped).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------------- */
/* Agregação                                                                  */
/* ------------------------------------------------------------------------- */

describe('buildOperationalContext', () => {
  const railwayMetadata = {
    requestedCommitSha: SHA,
    observedCommitSha: SHA,
    deploymentId: 'dep-1',
    deploymentStatus: 'success',
    service: 'copa-figurinhas',
    environment: 'production',
    correlationStatus: 'matched',
    limitations: [],
  };

  it('separa fatos, texto, limitações, cobertura e status', () => {
    const context = buildOperationalContext({
      metadata: { repository: 'senai/copa-figurinhas', commitSha: SHA },
      ciLogs: { lint: 'sem erros', tests: '76 passed', build: 'built in 1.4s', docker: 'DONE' },
      railway: { metadata: railwayMetadata, streams: { build: [], deploy: [], runtime: [] } },
      deploymentLog: '[2026-07-30T13:00:01.000Z] health check: aprovado\nSMOKE TEST RESULT: PASS',
      env: GREEN_CI,
    });

    expect(context.technicalStatus.overall).toBe('success');
    expect(context.systemFacts.ciJobs.tests).toBe('success');
    expect(context.textSources.map((entry) => entry.source)).toContain('ci:tests');
    expect(context.sourceCoverage.ciLint).toBe(true);
    expect(context.sourceCoverage.smokeTest).toBe(true);
    expect(Array.isArray(context.limitations)).toBe(true);
  });

  it('declara limitação para cada artefato de CI ausente', () => {
    const context = buildOperationalContext({
      metadata: { commitSha: SHA },
      ciLogs: { lint: 'ok' },
      railway: { metadata: railwayMetadata, streams: { build: [], deploy: [], runtime: [] } },
      deploymentLog: 'SMOKE TEST RESULT: PASS',
      env: GREEN_CI,
    });

    const joined = context.limitations.join(' ');
    expect(joined).toMatch(/tests\.log/);
    expect(joined).toMatch(/build\.log/);
    expect(joined).toMatch(/docker\.log/);
    expect(context.sourceCoverage.ciTests).toBe(false);
  });

  it('declara a ausência do CI anterior em disparo manual', () => {
    const context = buildOperationalContext({
      metadata: { commitSha: SHA },
      ciLogs: {},
      railway: { metadata: railwayMetadata, streams: { build: [], deploy: [], runtime: [] } },
      deploymentLog: 'SMOKE TEST RESULT: PASS',
      env: {},
    });

    expect(context.technicalStatus.ci).toBe('unknown');
    expect(context.limitations.join(' ')).toMatch(/workflow_dispatch/);
  });

  it('declara a ausência da coleta do Railway sem reprovar nada', () => {
    const context = buildOperationalContext({
      metadata: { commitSha: SHA },
      ciLogs: { lint: 'ok', tests: 'ok', build: 'ok', docker: 'ok' },
      railway: { metadata: null, streams: { build: [], deploy: [], runtime: [] } },
      deploymentLog: 'SMOKE TEST RESULT: PASS',
      env: GREEN_CI,
    });

    expect(context.technicalStatus.overall).toBe('success');
    expect(context.technicalStatus.railwayDeployment).toBe('unknown');
    expect(context.limitations.join(' ')).toMatch(/Nenhum metadado de coleta do Railway/i);
  });

  it('destaca mismatch de SHA como limitação explícita', () => {
    const context = buildOperationalContext({
      metadata: { commitSha: SHA },
      ciLogs: {},
      railway: {
        metadata: { ...railwayMetadata, correlationStatus: 'mismatch', observedCommitSha: 'aaaaaaa1111' },
        streams: { build: [], deploy: [], runtime: [] },
      },
      deploymentLog: 'SMOKE TEST RESULT: PASS',
      env: GREEN_CI,
    });

    expect(context.correlation.status).toBe('mismatch');
    expect(context.limitations.join(' ')).toMatch(/não.*é a versão esperada/i);
  });

  it('usa a fase declarada pelo evento da aplicação, não a do fluxo', () => {
    const context = buildOperationalContext({
      metadata: { commitSha: SHA },
      ciLogs: {},
      railway: {
        metadata: railwayMetadata,
        streams: {
          build: [],
          deploy: [],
          runtime: [
            {
              timestamp: '2026-07-30T13:00:05.000Z',
              level: 'error',
              message: 'falha ao gerar o relatório',
              raw: 'falha ao gerar o relatório',
              eventType: 'functional.report.failed',
              requestId: 'req-1',
            },
          ],
        },
      },
      deploymentLog: 'SMOKE TEST RESULT: FAIL',
      env: GREEN_CI,
    });

    const event = context.timeline.find((entry) => entry.source === 'railway:runtime');
    expect(event.phase).toBe('functional');
    expect(event.requestId).toBe('req-1');
  });

  it('sanitiza segredo antes de qualquer persistência', () => {
    const context = buildOperationalContext({
      metadata: { commitSha: SHA },
      ciLogs: {
        tests: [
          'Authorization: Bearer ghp_abcdefghijklmnop1234567890',
          'OPENAI_API_KEY=sk-proj-super-secreto-1234567890',
          'DATABASE_URL=postgres://app:senha123@db:5432/x',
          'Cookie: session=valor-secreto-aqui',
          'password=hunter2seguro',
          'github_pat_11ABCDEFG0abcdefghijklmnop',
          'access_token=abcdefghij1234567890',
        ].join('\n'),
      },
      railway: { metadata: railwayMetadata, streams: { build: [], deploy: [], runtime: [] } },
      deploymentLog: 'SMOKE TEST RESULT: FAIL',
      env: GREEN_CI,
    });

    const serialized = JSON.stringify(context);
    for (const secret of [
      'ghp_abcdefghijklmnop1234567890',
      'sk-proj-super-secreto-1234567890',
      'senha123',
      'valor-secreto-aqui',
      'hunter2seguro',
      'github_pat_11ABCDEFG0abcdefghijklmnop',
      'abcdefghij1234567890',
    ]) {
      expect(serialized, `vazou: ${secret}`).not.toContain(secret);
    }
    expect(serialized).toContain('[REDACTED]');
    expect(context.limitations.join(' ')).toMatch(/Conteúdo sensível/i);
  });

  it('conta os eventos sem timestamp', () => {
    const context = buildOperationalContext({
      metadata: { commitSha: SHA },
      ciLogs: { lint: 'ok', tests: 'ok' },
      railway: { metadata: railwayMetadata, streams: { build: [], deploy: [], runtime: [] } },
      deploymentLog: 'SMOKE TEST RESULT: PASS',
      env: GREEN_CI,
    });

    // Os resultados dos jobs do CI não têm hora — e isso é declarado.
    expect(context.systemFacts.eventsWithoutTimestamp).toBeGreaterThan(0);
  });
});
