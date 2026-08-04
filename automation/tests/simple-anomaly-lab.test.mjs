/**
 * Testes do laboratório: ciclo de vida do processo filho, contagem de linhas,
 * cenários offline e as duas invariantes do dia — a IA não decide, e sem chave
 * o relatório continua existindo.
 *
 * Nenhum teste aqui sobe a aplicação de verdade nem toca a rede: o processo
 * filho e o `fetch` são injetados.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { detectAnomaly } from '../src/simple-anomaly-detector.mjs';
import {
  buildDeterministicExplanation,
  explainAnomaly,
  mergeModelExplanation,
  prepareLogExcerpts,
} from '../src/simple-anomaly-explainer.mjs';
import {
  LabError,
  buildChildEnv,
  measureApplication,
  parseLabArgs,
  runFixture,
  selectLogExcerpts,
} from '../src/simple-anomaly-lab.mjs';
import { buildAnomalyReport, renderAnomalyHtml, renderAnomalyMarkdown } from '../src/simple-anomaly-report.mjs';

const temporaryDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'anomaly-lab-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length > 0) rmSync(temporaryDirs.pop(), { recursive: true, force: true });
});

/** Silencia a saída dos comandos durante os testes. */
const quiet = { write: () => {} };

/** Processo filho falso: streams reais, `kill` observável. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.signals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal);
    child.killed = true;
    child.exitCode = 0;
    setImmediate(() => child.emit('exit', 0));
    return true;
  };
  return child;
}

/**
 * `fetch` falso que também escreve, no `stdout` do processo falso, as linhas de
 * log que a aplicação real escreveria.
 */
function fakeFetch({ child, linesPerRequest = 2, durationMs = 3 }) {
  return async (url, init = {}) => {
    if (String(url).includes('/api/health')) {
      child.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, eventType: 'health.check.completed', phase: 'healthcheck' })}\n`,
      );
      return { ok: true, status: 200, text: async () => '{}' };
    }

    const requestId = init.headers?.['x-request-id'] ?? 'sem-id';
    for (let index = 1; index < linesPerRequest; index += 1) {
      child.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, eventType: 'functional.report.completed', phase: 'functional', requestId })}\n`,
      );
    }
    child.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, eventType: 'http.request.completed', phase: 'functional', requestId, statusCode: 200, durationMs })}\n`,
    );

    return { ok: true, status: 200, text: async () => '{}' };
  };
}

describe('parseLabArgs', () => {
  it('lê comando, alvo e opções', () => {
    const options = parseLabArgs(['check', '--baseline', 'reports/day-2/baseline.json', '--port', '3999']);

    expect(options.command).toBe('check');
    expect(options.baselinePath).toBe('reports/day-2/baseline.json');
    expect(options.port).toBe(3999);
  });

  it('não confunde o valor de uma opção com o alvo do comando', () => {
    const options = parseLabArgs(['demo', 'latency', '--out', 'saida']);

    expect(options.command).toBe('demo');
    expect(options.target).toBe('latency');
    expect(options.outDir).toBe('saida');
  });

  it('reconhece `--fail-on-anomaly`', () => {
    expect(parseLabArgs(['check', '--fail-on-anomaly']).failOnAnomaly).toBe(true);
    expect(parseLabArgs(['check']).failOnAnomaly).toBe(false);
  });
});

describe('ambiente do processo filho', () => {
  it('não repassa a chave da OpenAI nem o PORT do ambiente', () => {
    const childEnv = buildChildEnv({
      port: 3102,
      mode: 'latency',
      env: { PATH: '/usr/bin', PORT: '3001', OPENAI_API_KEY: 'sk-do-ambiente-0123456789', NODE_ENV: 'production' },
    });

    expect(childEnv.PORT).toBe('3102');
    expect(childEnv.DEMO_ANOMALY_MODE).toBe('latency');
    expect(childEnv.NODE_ENV).toBe('development');
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
  });
});

describe('measureApplication', () => {
  it('descarta o aquecimento e conta só as linhas das requisições medidas', async () => {
    const child = fakeChild();

    const measurement = await measureApplication({
      requests: 6,
      warmup: 2,
      spawnFn: () => child,
      fetchImpl: fakeFetch({ child }),
      checkPort: async () => {},
      out: quiet,
    });

    expect(measurement.samples).toHaveLength(6);
    // 2 linhas por requisição medida; o aquecimento e o health check ficam de fora.
    expect(measurement.logLines).toHaveLength(12);
    expect(measurement.allLogLines.length).toBeGreaterThan(12);
    expect(measurement.drained).toBe(true);
  });

  it('encerra o processo filho quando a medição termina', async () => {
    const child = fakeChild();

    await measureApplication({
      requests: 2,
      warmup: 0,
      spawnFn: () => child,
      fetchImpl: fakeFetch({ child }),
      checkPort: async () => {},
      out: quiet,
    });

    expect(child.signals).toContain('SIGTERM');
  });

  it('encerra o processo filho mesmo quando a aplicação nunca responde', async () => {
    const child = fakeChild();

    await expect(
      measureApplication({
        requests: 2,
        warmup: 0,
        spawnFn: () => child,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
        checkPort: async () => {},
        healthTimeoutMs: 300,
        out: quiet,
      }),
    ).rejects.toBeInstanceOf(LabError);

    // O `finally` é a razão de este teste existir.
    expect(child.signals).toContain('SIGTERM');
  });

  it('encerra o processo filho quando uma requisição medida explode', async () => {
    const child = fakeChild();
    let calls = 0;

    await expect(
      measureApplication({
        requests: 3,
        warmup: 0,
        spawnFn: () => child,
        fetchImpl: async (url, init) => {
          calls += 1;
          if (calls > 2) throw Object.assign(new Error('falha inesperada'), { fatal: true });
          return fakeFetch({ child })(url, init);
        },
        checkPort: async () => {},
        drainTimeoutMs: 200,
        out: {
          write: () => {
            throw new LabError('falha ao imprimir');
          },
        },
      }),
    ).rejects.toBeTruthy();

    expect(child.signals).toContain('SIGTERM');
  });

  it('avisa com mensagem clara quando a porta está ocupada', async () => {
    await expect(
      measureApplication({
        checkPort: async (port) => {
          throw new LabError(`A porta ${port} já está em uso.`);
        },
        spawnFn: () => {
          throw new Error('não deveria subir a aplicação');
        },
        out: quiet,
      }),
    ).rejects.toThrow(/já está em uso/);
  });
});

describe('selectLogExcerpts', () => {
  const logLines = [
    { eventType: 'http.request.completed', requestId: 'lab-0001', durationMs: 3, statusCode: 200 },
    { eventType: 'functional.report.completed', requestId: 'lab-0001', statusCode: 200 },
    { eventType: 'http.request.completed', requestId: 'lab-0003', durationMs: 511, statusCode: 200 },
    { eventType: 'demo.anomaly.noisy-log', requestId: 'lab-0003', message: 'linha 1/18' },
  ];

  it('resume a distribuição de eventType e cita as pontas da latência', () => {
    const excerpts = selectLogExcerpts({ logLines, sampleCount: 2 });

    expect(excerpts[0].source).toBe('medição:distribuição de eventType');
    expect(excerpts[0].excerpt).toContain('demo.anomaly.noisy-log=1');
    expect(excerpts[1].excerpt).toContain('511');
    expect(excerpts[2].excerpt).toContain('"durationMs":3');
    expect(excerpts.length).toBeLessThanOrEqual(5);
  });
});

/* ------------------------------------------------------------------------- */
/* A IA explica, não decide                                                   */
/* ------------------------------------------------------------------------- */

/** Cliente OpenAI falso: devolve o que o teste mandar, sem tocar a rede. */
function fakeClient(output, { throws = null } = {}) {
  return {
    responses: {
      parse: async () => {
        if (throws) throw throws;
        return { status: 'completed', output_parsed: output, id: 'resp_teste', model: 'gpt-5-mini' };
      },
    },
  };
}

const MODEL_ENV = { OPENAI_API_KEY: 'sk-test-0123456789abcdef' };

const LATENCY_DETECTION = detectAnomaly({
  baseline: { latencyP95Ms: 4, logLinesPerRequest: 2 },
  observed: { latencyP95Ms: 508, logLinesPerRequest: 2 },
});

describe('a IA não altera o resultado determinístico', () => {
  it('mesmo quando a saída do modelo contradiz a detecção', async () => {
    const explained = await explainAnomaly({
      detection: LATENCY_DETECTION,
      excerpts: [],
      env: MODEL_ENV,
      client: fakeClient({
        summary: 'Está tudo bem, não há anomalia nenhuma.',
        evidence: [],
        probableCause: null,
        recommendedActions: [],
        limitations: [],
        // Campos que tentariam decidir: o schema sequer os expõe.
        anomalyDetected: false,
        anomalyType: null,
        gateResult: 'pass',
      }),
    });

    const report = buildAnomalyReport({
      detection: LATENCY_DETECTION,
      observation: { route: '/api/report', sampleCount: 30, context: {} },
      baseline: { sampleCount: 30 },
      explanation: explained.explanation,
      explanationSource: explained,
      excerpts: explained.excerpts,
    });

    expect(explained.usedFallback).toBe(false);
    expect(report.anomalyDetected).toBe(true);
    expect(report.anomalyType).toBe('latency');
    expect(report.firstAnomalousSignal).toBe('latencyP95Ms');
    expect(report.gateResult).toBe('fail');
    // A tentativa do modelo não aparece em lugar nenhum do relatório.
    expect(JSON.stringify(report)).not.toContain('"anomalyDetected": false');
  });

  it('descarta causa e ações quando nenhuma regra foi acionada', () => {
    const green = detectAnomaly({
      baseline: { latencyP95Ms: 4, logLinesPerRequest: 2 },
      observed: { latencyP95Ms: 5, logLinesPerRequest: 2 },
    });

    const merged = mergeModelExplanation({
      detection: green,
      explanation: {
        summary: 'Tudo dentro da baseline.',
        evidence: [],
        probableCause: 'Talvez o cache esteja frio.',
        recommendedActions: ['Considere monitorar a rota.'],
        limitations: [],
      },
      excerpts: [],
      deterministic: buildDeterministicExplanation({ detection: green }),
    });

    expect(merged.probableCause).toBeNull();
    expect(merged.recommendedActions).toEqual([]);
    expect(merged.limitations.join(' ')).toContain('descartadas');
  });

  it('descarta evidência que não existe no material coletado', () => {
    const excerpts = prepareLogExcerpts([
      { source: 'log:teste', excerpt: 'GET /api/report 200 durationMs 511.7 requestId lab-0003' },
    ]);

    const merged = mergeModelExplanation({
      detection: LATENCY_DETECTION,
      explanation: {
        summary: 'Latência alta.',
        evidence: [
          'GET /api/report 200 durationMs 511.7 requestId lab-0003',
          'ERRO: banco de dados indisponível na linha 42 do arquivo inventado.js',
        ],
        probableCause: 'Espera artificial.',
        recommendedActions: ['Investigar.'],
        limitations: [],
      },
      excerpts,
      deterministic: buildDeterministicExplanation({ detection: LATENCY_DETECTION, excerpts }),
    });

    expect(merged.evidence).toHaveLength(1);
    expect(merged.limitations.join(' ')).toContain('não foram encontradas no material coletado');
  });
});

describe('sem OPENAI_API_KEY', () => {
  it('o relatório continua sendo gerado, com explicação determinística', async () => {
    const explained = await explainAnomaly({ detection: LATENCY_DETECTION, env: {} });

    expect(explained.usedFallback).toBe(true);
    expect(explained.source).toBe('fallback');
    expect(explained.sourceLabel).toBe('fallback determinístico — OPENAI_API_KEY não configurada');
    expect(explained.explanation.summary).toContain('latency');
    expect(explained.explanation.recommendedActions.length).toBeGreaterThan(0);
  });

  it('a falha da chamada ao modelo vira categoria, não texto do SDK', async () => {
    const explained = await explainAnomaly({
      detection: LATENCY_DETECTION,
      env: MODEL_ENV,
      client: fakeClient(null, {
        throws: Object.assign(new Error('401 Unauthorized em https://api.openai.com?key=sk-vazada'), {
          status: 401,
        }),
      }),
    });

    expect(explained.usedFallback).toBe(true);
    expect(explained.sourceLabel).toContain('authentication');
    expect(JSON.stringify(explained)).not.toContain('sk-vazada');
  });
});

describe('nenhum segredo nos relatórios', () => {
  it('mascara chave e senha vindas do log e do texto do modelo', () => {
    const excerpts = prepareLogExcerpts([
      { source: 'log:aplicação', excerpt: 'GET /api/report 200 Authorization: Bearer sk-live-0123456789abcdef' },
    ]);

    const report = buildAnomalyReport({
      detection: LATENCY_DETECTION,
      observation: { route: '/api/report', sampleCount: 30, context: { requestCount: 30 } },
      baseline: { sampleCount: 30, createdAt: '2026-08-04T12:00:00.000Z', commitSha: 'abc1234' },
      explanation: {
        summary: 'A aplicação registrou password: hunter2 no log.',
        evidence: ['ghp_0123456789abcdefghij apareceu na linha 3'],
        probableCause: null,
        recommendedActions: [],
        limitations: [],
      },
      explanationSource: { source: 'fallback', sourceLabel: 'fallback determinístico', usedFallback: true, modelCall: {} },
      excerpts,
    });

    const rendered = [JSON.stringify(report), renderAnomalyMarkdown(report), renderAnomalyHtml(report)].join('\n');

    expect(rendered).not.toContain('sk-live-0123456789abcdef');
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('ghp_0123456789abcdefghij');
    expect(rendered).toContain('[REDACTED]');
  });

  it('escapa o conteúdo não confiável no HTML', () => {
    const report = buildAnomalyReport({
      detection: LATENCY_DETECTION,
      observation: { route: '/api/report', sampleCount: 30, context: {} },
      baseline: { sampleCount: 30 },
      explanation: {
        summary: '<script>alert(1)</script>',
        evidence: [],
        probableCause: null,
        recommendedActions: [],
        limitations: [],
      },
      explanationSource: { source: 'fallback', sourceLabel: 'fallback', usedFallback: true, modelCall: {} },
      excerpts: [{ source: 'log', excerpt: '<img src=x onerror=alert(1)>' }],
    });

    const html = renderAnomalyHtml(report);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('onerror=alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

/* ------------------------------------------------------------------------- */
/* Cenários offline                                                           */
/* ------------------------------------------------------------------------- */

describe('fixtures', () => {
  const cases = [
    { scenario: 'normal', anomalyDetected: false, anomalyType: null, signal: null, gate: 'pass' },
    { scenario: 'latency', anomalyDetected: true, anomalyType: 'latency', signal: 'latencyP95Ms', gate: 'fail' },
    {
      scenario: 'noisy-logs',
      anomalyDetected: true,
      anomalyType: 'log-volume',
      signal: 'logLinesPerRequest',
      gate: 'fail',
    },
  ];

  for (const expected of cases) {
    it(`\`${expected.scenario}\` produz o resultado esperado, offline`, async () => {
      const outDir = makeTempDir();

      const { report, paths } = await runFixture({
        scenario: expected.scenario,
        outDir,
        // A chave existe no ambiente e mesmo assim o modelo não é chamado.
        env: MODEL_ENV,
        client: {
          responses: {
            parse: async () => {
              throw new Error('a fixture não pode chamar a OpenAI');
            },
          },
        },
        out: quiet,
      });

      expect(report.anomalyDetected).toBe(expected.anomalyDetected);
      expect(report.anomalyType).toBe(expected.anomalyType);
      expect(report.firstAnomalousSignal).toBe(expected.signal);
      expect(report.gateResult).toBe(expected.gate);
      expect(report.usedFallback).toBe(true);
      expect(paths).toHaveLength(3);

      const written = JSON.parse(readFileSync(paths[0], 'utf8'));
      expect(written.anomalyDetected).toBe(expected.anomalyDetected);
      expect(readFileSync(paths[1], 'utf8')).toContain('## 5. Regra aplicada');
      expect(readFileSync(paths[2], 'utf8')).toContain('<!doctype html>');
    });
  }

  it('recusa cenário desconhecido com mensagem de laboratório', async () => {
    await expect(runFixture({ scenario: 'inventado', out: quiet })).rejects.toBeInstanceOf(LabError);
  });
});
