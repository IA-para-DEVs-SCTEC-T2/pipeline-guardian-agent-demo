import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PORT,
  attachLogCounts,
  isErrorSample,
  nearestRankPercentile,
  observeApplication,
  parseLogLines,
  summarizeSamples,
  terminateChild,
} from '../src/day2/observe.mjs';

/* ------------------------------------------------------------------------- */
/* Duplos de teste                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Processo filho falso. `kill` emite `exit` de forma síncrona para que o teste
 * não dependa do agendador — o processo real emite de forma assíncrona, e é por
 * isso que `terminateChild` espera pelo evento em vez de presumir.
 */
function createFakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signalsReceived = [];

  const stream = () => {
    const emitter = new EventEmitter();
    emitter.setEncoding = () => {};
    return emitter;
  };

  child.stdout = stream();
  child.stderr = stream();

  child.kill = (signal) => {
    child.signalsReceived.push(signal);
    if (child.exitCode === null) {
      child.exitCode = 0;
      child.emit('exit', 0, signal);
    }
    return true;
  };

  return child;
}

/** Uma linha de log estruturado, como a aplicação a emite. */
function logLine(fields) {
  return `${JSON.stringify({
    schemaVersion: 1,
    time: new Date().toISOString(),
    level: 'info',
    source: 'application',
    service: 'copa-figurinhas',
    ...fields,
  })}\n`;
}

/**
 * Cenário completo: `spawn` falso, requisições falsas e o log que a aplicação
 * teria emitido para cada uma delas.
 */
function scenario({
  durationMs = () => 4,
  statusCode = () => 200,
  responseSizeBytes = () => 3820,
  logLinesFor = () => 2,
  failOnMeasured = false,
  healthOk = true,
} = {}) {
  const child = createFakeChild();
  const requests = [];

  const requestFn = async ({ url, requestId }) => {
    requests.push({ url, requestId });

    if (url.endsWith('/api/health')) {
      return healthOk
        ? { statusCode: 200, durationMs: 1, responseSizeBytes: 120, requestId }
        : { statusCode: 0, durationMs: 1, responseSizeBytes: 0, requestId };
    }

    const measured = requestId.startsWith('day2-');
    if (measured && failOnMeasured) throw new Error('falha simulada durante a medição');

    const sequence = measured ? Number(requestId.split('-')[1]) : 0;
    for (let index = 0; index < logLinesFor(sequence); index += 1) {
      const line = logLine({
        eventType: index === 0 ? 'functional.report.completed' : 'http.request.completed',
        phase: 'functional',
        message: 'GET /api/report 200',
        requestId,
        statusCode: statusCode(sequence),
      });
      // Erro vai para `stderr`, como no logger real.
      if (statusCode(sequence) >= 500) child.stderr.emit('data', line);
      else child.stdout.emit('data', line);
    }

    return {
      statusCode: statusCode(sequence),
      durationMs: durationMs(sequence),
      responseSizeBytes: responseSizeBytes(sequence),
      requestId,
    };
  };

  return {
    child,
    requests,
    options: {
      spawnFn: () => child,
      requestFn,
      sleep: async () => {},
      serverPath: '/caminho/irrelevante/server.js',
    },
  };
}

/* ------------------------------------------------------------------------- */
/* P95                                                                        */
/* ------------------------------------------------------------------------- */

describe('nearestRankPercentile', () => {
  it('usa o posto mais próximo: index = ceil(n * 0.95) - 1', () => {
    // 30 valores → ceil(28.5) - 1 = 28 → o 29º valor ordenado.
    const values = Array.from({ length: 30 }, (_, index) => index + 1);
    expect(nearestRankPercentile(values)).toBe(29);
  });

  it('não interpola: o valor devolvido foi realmente medido', () => {
    const values = [1, 2, 3, 100];
    // ceil(4 * 0.95) - 1 = 3 → o maior.
    expect(nearestRankPercentile(values)).toBe(100);
    expect(values).toContain(nearestRankPercentile(values));
  });

  it('ordena antes de indexar', () => {
    const ordered = Array.from({ length: 30 }, (_, index) => index + 1);
    const shuffled = [...ordered].reverse();
    expect(nearestRankPercentile(shuffled)).toBe(nearestRankPercentile(ordered));
  });

  it('devolve 0 sem valores e ignora o que não é número', () => {
    expect(nearestRankPercentile([])).toBe(0);
    expect(nearestRankPercentile([undefined, NaN, null])).toBe(0);
    expect(nearestRankPercentile([5, NaN, 5])).toBe(5);
  });

  it('uma única requisição lenta em 30 não move o P95', () => {
    const rapidas = Array.from({ length: 29 }, () => 4);
    expect(nearestRankPercentile([...rapidas, 50])).toBe(4);
  });
});

/* ------------------------------------------------------------------------- */
/* Sinais                                                                     */
/* ------------------------------------------------------------------------- */

describe('summarizeSamples', () => {
  const sample = (overrides) => ({
    sequence: 1,
    statusCode: 200,
    durationMs: 4,
    responseSizeBytes: 3820,
    logLineCount: 2,
    requestId: 'r-1',
    ...overrides,
  });

  it('produz os quatro sinais e o contexto', () => {
    const samples = Array.from({ length: 30 }, (_, index) =>
      sample({ sequence: index + 1, requestId: `r-${index + 1}` }),
    );

    expect(summarizeSamples(samples)).toEqual({
      sampleCount: 30,
      requestCount: 30,
      latencyP95Ms: 4,
      errorRate: 0,
      logLinesPerRequest: 2,
      responseSizeP95Bytes: 3820,
    });
  });

  it('errorRate conta 4xx, 5xx e ausência de resposta', () => {
    const samples = [
      sample({ statusCode: 200 }),
      sample({ statusCode: 500 }),
      sample({ statusCode: 404 }),
      sample({ statusCode: 0 }),
    ];

    expect(summarizeSamples(samples).errorRate).toBe(0.75);
    expect(isErrorSample({ statusCode: 302 })).toBe(false);
    expect(isErrorSample({ statusCode: 0 })).toBe(true);
    expect(isErrorSample({})).toBe(true);
  });

  it('logLinesPerRequest é a média por requisição', () => {
    const samples = [sample({ logLineCount: 2 }), sample({ logLineCount: 2 }), sample({ logLineCount: 8 })];
    expect(summarizeSamples(samples).logLinesPerRequest).toBe(4);
  });

  it('responseSizeP95Bytes usa o mesmo posto e sai inteiro', () => {
    const samples = Array.from({ length: 30 }, (_, index) =>
      sample({ responseSizeBytes: (index + 1) * 100 }),
    );
    expect(summarizeSamples(samples).responseSizeP95Bytes).toBe(2900);
  });

  it('sem amostras, todos os sinais são zero', () => {
    expect(summarizeSamples([])).toEqual({
      sampleCount: 0,
      requestCount: 0,
      latencyP95Ms: 0,
      errorRate: 0,
      logLinesPerRequest: 0,
      responseSizeP95Bytes: 0,
    });
  });
});

/* ------------------------------------------------------------------------- */
/* Leitura do log                                                             */
/* ------------------------------------------------------------------------- */

describe('parseLogLines', () => {
  it('interpreta apenas linhas JSON válidas e separa o ruído', () => {
    const text = [
      '(node:1) ExperimentalWarning: alguma coisa',
      JSON.stringify({ eventType: 'app.started', requestId: 'a' }),
      '{ isto não fecha',
      '',
      JSON.stringify([1, 2, 3]),
      JSON.stringify({ eventType: 'http.request.completed', requestId: 'b' }),
    ].join('\n');

    const { events, noiseLines } = parseLogLines(text);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.requestId)).toEqual(['a', 'b']);
    // Aviso do runtime, JSON partido e array: nenhum é evento.
    expect(noiseLines).toHaveLength(3);
  });

  it('tolera entrada vazia ou ausente', () => {
    expect(parseLogLines('')).toEqual({ events: [], noiseLines: [] });
    expect(parseLogLines(undefined)).toEqual({ events: [], noiseLines: [] });
  });
});

describe('attachLogCounts', () => {
  const samples = [
    { sequence: 1, requestId: 'a' },
    { sequence: 2, requestId: 'b' },
  ];

  it('correlaciona pelo requestId quando todas as amostras casam', () => {
    const events = [
      { requestId: 'a' },
      { requestId: 'a' },
      { requestId: 'b' },
      { requestId: 'b' },
      { requestId: 'b' },
    ];

    const result = attachLogCounts(samples, events);

    expect(result.strategy).toBe('request_id');
    expect(result.samples.map((item) => item.logLineCount)).toEqual([2, 3]);
  });

  it('cai para a média da janela quando alguma amostra não casa', () => {
    const events = [{ requestId: 'a' }, { requestId: 'a' }, { requestId: 'z' }];
    const result = attachLogCounts(samples, events);

    expect(result.strategy).toBe('window_average');
    expect(result.matched).toBe(1);
    expect(result.samples.map((item) => item.logLineCount)).toEqual([1.5, 1.5]);
  });
});

/* ------------------------------------------------------------------------- */
/* Execução                                                                   */
/* ------------------------------------------------------------------------- */

describe('observeApplication', () => {
  it('descarta o aquecimento e mede exatamente o número pedido', async () => {
    const { options, requests } = scenario();

    const observation = await observeApplication({
      ...options,
      warmupRequests: 5,
      measuredRequests: 30,
    });

    expect(observation.samples).toHaveLength(30);
    expect(observation.samples[0].sequence).toBe(1);
    expect(observation.samples[29].sequence).toBe(30);
    expect(observation.warmupRequests).toBe(5);

    // 1 health check + 5 de aquecimento + 30 medidas.
    expect(requests).toHaveLength(36);
    expect(requests.filter((item) => item.requestId.startsWith('warmup-'))).toHaveLength(5);

    // O log do aquecimento fica fora da janela: 30 requisições × 2 linhas.
    expect(observation.logEvents).toHaveLength(60);
    expect(observation.logCorrelation).toBe('request_id');
    expect(observation.summary.logLinesPerRequest).toBe(2);
  });

  it('cada amostra tem a forma combinada', async () => {
    const { options } = scenario();
    const observation = await observeApplication({ ...options, measuredRequests: 3, warmupRequests: 1 });

    expect(observation.samples[0]).toEqual({
      sequence: 1,
      statusCode: 200,
      durationMs: 4,
      responseSizeBytes: 3820,
      logLineCount: 2,
      requestId: expect.stringMatching(/^day2-1-/),
    });
  });

  it('separa a janela medida por corrente: log de erro no stderr não desalinha a contagem', async () => {
    // O aquecimento erra (log em `stderr`), a medição não (log em `stdout`).
    const { options } = scenario({
      statusCode: (sequence) => (sequence === 0 ? 500 : 200),
      logLinesFor: () => 2,
    });

    const observation = await observeApplication({ ...options, measuredRequests: 4, warmupRequests: 2 });

    // 4 requisições × 2 linhas — nenhuma linha do aquecimento entrou.
    expect(observation.logEvents).toHaveLength(8);
    expect(observation.summary.logLinesPerRequest).toBe(2);
    expect(observation.logEvents.every((event) => event.requestId.startsWith('day2-'))).toBe(true);
  });

  it('encerra o processo filho ao terminar', async () => {
    const { options, child } = scenario();
    await observeApplication({ ...options, measuredRequests: 2, warmupRequests: 1 });

    expect(child.signalsReceived).toEqual(['SIGTERM']);
    expect(child.exitCode).toBe(0);
  });

  it('encerra o processo filho mesmo quando a medição falha', async () => {
    const { options, child } = scenario({ failOnMeasured: true });

    await expect(
      observeApplication({ ...options, measuredRequests: 2, warmupRequests: 1 }),
    ).rejects.toThrow('falha simulada');

    // O `finally` roda. É a diferença entre um laboratório reexecutável e um
    // `EADDRINUSE` na segunda tentativa.
    expect(child.signalsReceived).toEqual(['SIGTERM']);
  });

  it('encerra o processo filho quando a aplicação nunca fica pronta', async () => {
    const { options, child } = scenario({ healthOk: false });

    await expect(
      observeApplication({ ...options, readyTimeoutMs: 5, measuredRequests: 1, warmupRequests: 0 }),
    ).rejects.toThrow(/health check/);

    expect(child.signalsReceived).toEqual(['SIGTERM']);
  });

  it('declara limitação quando o log não pôde ser correlacionado', async () => {
    const { options } = scenario({ logLinesFor: () => 0 });
    const observation = await observeApplication({ ...options, measuredRequests: 3, warmupRequests: 1 });

    expect(observation.logCorrelation).toBe('window_average');
    expect(observation.limitations.join(' ')).toContain('`logLinesPerRequest` é a média da janela');
  });

  it('usa a porta 3102 por padrão', () => {
    expect(DEFAULT_PORT).toBe(3102);
  });
});

describe('terminateChild', () => {
  it('recorre ao SIGKILL quando o encerramento controlado não responde', async () => {
    const teimoso = createFakeChild();
    teimoso.kill = (signal) => {
      teimoso.signalsReceived.push(signal);
      if (signal === 'SIGKILL') {
        teimoso.exitCode = 137;
        teimoso.emit('exit', 137, signal);
      }
      return true;
    };

    const result = await terminateChild(teimoso, { killTimeoutMs: 1, sleep: async () => {} });

    expect(teimoso.signalsReceived).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result.forced).toBe(true);
  });

  it('não sinaliza um processo que já saiu', async () => {
    const morto = createFakeChild();
    morto.exitCode = 0;

    await terminateChild(morto, { sleep: async () => {} });

    expect(morto.signalsReceived).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Integração: a aplicação de verdade                                         */
/* ------------------------------------------------------------------------- */

describe('observeApplication contra o backend real', () => {
  it('sobe, mede, correlaciona pelo requestId e encerra o processo', async () => {
    // Porta própria do teste: não colide com o 3102 do laboratório nem com o
    // 3001 de desenvolvimento.
    const port = 3199;

    const observation = await observeApplication({
      port,
      warmupRequests: 2,
      measuredRequests: 6,
    });

    expect(observation.samples).toHaveLength(6);
    expect(observation.samples.every((sample) => sample.statusCode === 200)).toBe(true);
    expect(observation.samples.every((sample) => sample.responseSizeBytes > 0)).toBe(true);

    // Duas linhas por requisição: `functional.report.completed` (da rota) e
    // `http.request.completed` (do middleware). É o contrato do log estruturado.
    expect(observation.logCorrelation).toBe('request_id');
    expect(observation.summary.logLinesPerRequest).toBe(2);
    expect(observation.summary.errorRate).toBe(0);
    expect(observation.summary.latencyP95Ms).toBeGreaterThan(0);

    // O processo morreu: a porta não responde mais.
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  }, 40_000);
});
