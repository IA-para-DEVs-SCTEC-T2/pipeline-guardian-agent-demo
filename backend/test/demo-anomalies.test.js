import { randomUUID } from 'node:crypto';

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createApp } from '../src/app.js';
import {
  DEMO_ANOMALY_ENV_VAR,
  ERROR_RATE_CODE,
  ERROR_RATE_ERROR_NAME,
  ERROR_RATE_EVERY,
  ERROR_RATE_MESSAGE,
  ERROR_RATE_MODE,
  LATENCY_DELAY_MS,
  LATENCY_EVERY,
  LATENCY_MODE,
  NOISY_LOGS_EVERY,
  NOISY_LOGS_EXTRA_EVENTS,
  NOISY_LOGS_LEVEL,
  NOISY_LOGS_MODE,
  createDemoAnomaly,
  createErrorRateAnomaly,
  createLatencyAnomaly,
  createNoisyLogsAnomaly,
  errorRateModeEnabled,
  latencyModeEnabled,
  noisyLogsModeEnabled,
} from '../src/demo-anomalies.js';
import { LOG_EVENT_TYPES } from '../src/logging/structured-logger.js';
import { HttpError } from '../src/middleware/errorHandler.js';
import { createReportRouter } from '../src/routes/report.js';

/**
 * O middleware é exercitado com espera e log falsos: o que importa verificar é
 * **quais** requisições esperam, não quanto tempo o relógio da máquina levou
 * para contar meio segundo trinta vezes.
 */
function harness({ env = { [DEMO_ANOMALY_ENV_VAR]: LATENCY_MODE } } = {}) {
  const sleeps = [];
  const events = [];

  const middleware = createLatencyAnomaly({
    env,
    log: { emit: (event) => events.push(event) },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  /** Executa uma requisição e devolve `true` se ela seguiu sem esperar. */
  const run = async (sequence) => {
    let immediate = false;
    let continued = false;

    const done = new Promise((resolve) => {
      middleware({ id: `req-${sequence}`, originalUrl: '/api/report' }, {}, () => {
        continued = true;
        resolve();
      });
    });

    immediate = continued;
    await done;

    return { immediate };
  };

  return { run, sleeps, events };
}

describe('createLatencyAnomaly: proporção de uma em cada três', () => {
  it('deixa passar duas requisições e atrasa a terceira', async () => {
    const lab = harness();

    const results = [];
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      results.push(await lab.run(sequence));
    }

    // 1, 2, 4, 5, 7 e 8 seguem sem tocar no relógio.
    expect(results.map((result) => result.immediate)).toEqual([
      true, true, false,
      true, true, false,
      true, true, false,
    ]);

    // Uma espera para cada terceira requisição, sempre do mesmo tamanho.
    expect(lab.sleeps).toEqual([LATENCY_DELAY_MS, LATENCY_DELAY_MS, LATENCY_DELAY_MS]);
    expect(lab.sleeps).toHaveLength(9 / LATENCY_EVERY);
  });

  it('registra o evento estruturado `demo.anomaly.latency` só nas atrasadas', async () => {
    const lab = harness();

    for (let sequence = 1; sequence <= 6; sequence += 1) {
      await lab.run(sequence);
    }

    expect(lab.events).toHaveLength(2);

    const [event] = lab.events;
    expect(event.eventType).toBe('demo.anomaly.latency');
    expect(event.phase).toBe('functional');
    expect(event.level).toBe('warn');
    expect(event.fields.durationMs).toBe(LATENCY_DELAY_MS);
    expect(event.fields.functionalArea).toBe('report');
    expect(event.fields.requestId).toBe('req-3');

    // O evento precisa ser reconhecido pelo contrato de log; sem isso ele seria
    // silenciosamente reescrito como `app.starting` na emissão real.
    expect(LOG_EVENT_TYPES).toContain('demo.anomaly.latency');
  });
});

describe('createLatencyAnomaly: sem a variável não existe atraso', () => {
  it('não espera, não conta e não registra evento com o ambiente limpo', async () => {
    const lab = harness({ env: {} });

    const results = [];
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      results.push(await lab.run(sequence));
    }

    expect(results.every((result) => result.immediate)).toBe(true);
    expect(lab.sleeps).toEqual([]);
    expect(lab.events).toEqual([]);
  });

  it('ignora um modo que não é o de latência', async () => {
    const lab = harness({ env: { [DEMO_ANOMALY_ENV_VAR]: 'payload' } });

    for (let sequence = 1; sequence <= 6; sequence += 1) {
      await lab.run(sequence);
    }

    expect(lab.sleeps).toEqual([]);
  });

  it('reconhece o modo apenas pelo valor exato, sem diferenciar caixa ou espaço', () => {
    expect(latencyModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: 'latency' })).toBe(true);
    expect(latencyModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: ' Latency ' })).toBe(true);
    expect(latencyModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: 'latency-extra' })).toBe(false);
    expect(latencyModeEnabled({})).toBe(false);
  });
});

describe('GET /api/report com o cenário ligado', () => {
  const original = process.env[DEMO_ANOMALY_ENV_VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[DEMO_ANOMALY_ENV_VAR];
    else process.env[DEMO_ANOMALY_ENV_VAR] = original;
  });

  it('responde 200 com o mesmo relatório na requisição rápida e na atrasada', async () => {
    // Aplicação mínima, com espera falsa: aqui o que se verifica é o 200 e o
    // corpo, não a duração.
    const app = express();
    app.use('/api/report', createReportRouter({
      log: { emit: () => {} },
      demoAnomaly: createLatencyAnomaly({
        env: { [DEMO_ANOMALY_ENV_VAR]: LATENCY_MODE },
        log: { emit: () => {} },
        sleep: () => Promise.resolve(),
      }),
    }));

    const bodies = [];
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const res = await request(app).get('/api/report');
      expect(res.status).toBe(200);
      bodies.push(res.body);
    }

    // Ver decisão 3 de `demo-anomalies.js`: a anomalia é tempo, não conteúdo.
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0].totalRegistered).toBeGreaterThan(0);
  });

  it('atrasa a terceira requisição de verdade e não toca em /api/health', async () => {
    process.env[DEMO_ANOMALY_ENV_VAR] = LATENCY_MODE;
    const app = createApp({ serveFrontend: false });

    const durations = [];
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const startedAt = Date.now();
      const res = await request(app).get('/api/report');
      durations.push(Date.now() - startedAt);
      expect(res.status).toBe(200);
    }

    expect(durations[0]).toBeLessThan(LATENCY_DELAY_MS / 2);
    expect(durations[1]).toBeLessThan(LATENCY_DELAY_MS / 2);
    // Margem para baixo: o timer do Node acorda perto de 500 ms, não em 500 ms.
    expect(durations[2]).toBeGreaterThanOrEqual(LATENCY_DELAY_MS - 50);

    // O health check é o que a observação usa para saber que a aplicação subiu.
    // Se o cenário o atrasasse, o laboratório viraria falha de inicialização.
    const startedAt = Date.now();
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
    }
    expect(Date.now() - startedAt).toBeLessThan(LATENCY_DELAY_MS / 2);
  }, 10_000);

  it('não atrasa nada quando a variável não está definida', async () => {
    delete process.env[DEMO_ANOMALY_ENV_VAR];
    const app = createApp({ serveFrontend: false });

    const startedAt = Date.now();
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      const res = await request(app).get('/api/report');
      expect(res.status).toBe(200);
    }

    expect(Date.now() - startedAt).toBeLessThan(LATENCY_DELAY_MS / 2);
  });
});

/* ------------------------------------------------------------------------- */
/* Cenário `error-rate`                                                       */
/* ------------------------------------------------------------------------- */

/**
 * O middleware de erro é síncrono: ele decide, registra e chama `next(error)`
 * sem tocar no relógio. O harness captura exatamente o que foi entregue ao
 * `next` — que é a única coisa que o `errorHandler` vai enxergar.
 */
function errorHarness({ env = { [DEMO_ANOMALY_ENV_VAR]: ERROR_RATE_MODE } } = {}) {
  const events = [];

  const middleware = createErrorRateAnomaly({
    env,
    log: { emit: (event) => events.push(event) },
  });

  const run = (sequence) =>
    new Promise((resolve) => {
      middleware(
        { id: `req-${sequence}`, originalUrl: '/api/report' },
        {},
        (error) => resolve({ error: error ?? null }),
      );
    });

  return { run, events };
}

describe('createErrorRateAnomaly: proporção de uma em cada cinco', () => {
  it('deixa passar quatro requisições e reprova a quinta', async () => {
    const lab = errorHarness();

    const results = [];
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      results.push(await lab.run(sequence));
    }

    expect(results.map((result) => result.error !== null)).toEqual([
      false, false, false, false, true,
      false, false, false, false, true,
    ]);

    // ~20%. É esta fração que faz `observado ≥ 0,15` disparar no detector do
    // Dia 2 — uma em cada dez daria 0,10 e não passaria em nenhuma das duas
    // condições da regra.
    const failed = results.filter((result) => result.error !== null).length;
    expect(failed / results.length).toBe(1 / ERROR_RATE_EVERY);
  });

  it('reprova com o erro controlado que o `errorHandler` traduz em 500', async () => {
    const lab = errorHarness();

    let failure = null;
    for (let sequence = 1; sequence <= ERROR_RATE_EVERY; sequence += 1) {
      failure = (await lab.run(sequence)).error;
    }

    // `HttpError` e não `Error` cru: o status é decisão do cenário, não uma
    // surpresa classificada como "erro inesperado" pelo handler.
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure.status).toBe(500);
    expect(failure.code).toBe(ERROR_RATE_CODE);
    expect(failure.name).toBe(ERROR_RATE_ERROR_NAME);
    expect(failure.message).toBe(ERROR_RATE_MESSAGE);
  });

  it('registra o evento estruturado `demo.anomaly.error-rate` só nas reprovadas', async () => {
    const lab = errorHarness();

    for (let sequence = 1; sequence <= 10; sequence += 1) {
      await lab.run(sequence);
    }

    // Uma linha por requisição reprovada, e só uma: uma segunda linha aqui
    // faria `logLinesPerRequest` subir junto e daria ao detector um segundo
    // sinal para reclamar num cenário que provoca um.
    expect(lab.events).toHaveLength(10 / ERROR_RATE_EVERY);

    const [event] = lab.events;
    expect(event.eventType).toBe('demo.anomaly.error-rate');
    expect(event.phase).toBe('functional');
    expect(event.level).toBe('error');
    expect(event.fields.statusCode).toBe(500);
    expect(event.fields.functionalArea).toBe('report');
    expect(event.fields.errorName).toBe(ERROR_RATE_ERROR_NAME);
    expect(event.fields.requestId).toBe('req-5');

    // Sem estar no contrato, o evento seria silenciosamente reescrito como
    // `app.starting` na emissão real — e o log do laboratório mentiria.
    expect(LOG_EVENT_TYPES).toContain('demo.anomaly.error-rate');
  });

  it('continua reprovando na proporção certa se o log falhar', async () => {
    const middleware = createErrorRateAnomaly({
      env: { [DEMO_ANOMALY_ENV_VAR]: ERROR_RATE_MODE },
      log: {
        emit: () => {
          throw new Error('coletor de log indisponível');
        },
      },
    });

    const failures = [];
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      await new Promise((resolve) => {
        middleware({ id: `req-${sequence}` }, {}, (error) => {
          failures.push(error ?? null);
          resolve();
        });
      });
    }

    expect(failures.filter((error) => error !== null)).toHaveLength(2);
  });
});

describe('createErrorRateAnomaly: sem a variável não existe erro', () => {
  it('não conta, não registra e não reprova com o ambiente limpo', async () => {
    const lab = errorHarness({ env: {} });

    const results = [];
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      results.push(await lab.run(sequence));
    }

    expect(results.every((result) => result.error === null)).toBe(true);
    expect(lab.events).toEqual([]);
  });

  it('ignora um modo que não é o de erro', async () => {
    const lab = errorHarness({ env: { [DEMO_ANOMALY_ENV_VAR]: LATENCY_MODE } });

    const results = [];
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      results.push(await lab.run(sequence));
    }

    expect(results.every((result) => result.error === null)).toBe(true);
  });

  it('reconhece o modo apenas pelo valor exato, sem diferenciar caixa ou espaço', () => {
    expect(errorRateModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: 'error-rate' })).toBe(true);
    expect(errorRateModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: ' Error-Rate ' })).toBe(true);
    expect(errorRateModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: 'error_rate' })).toBe(false);
    expect(errorRateModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: 'error-rate-extra' })).toBe(false);
    expect(errorRateModeEnabled({})).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Cenário `noisy-logs`                                                       */
/* ------------------------------------------------------------------------- */

/**
 * O middleware de volume de log é síncrono de ponta a ponta: sem `sleep`, sem
 * timer e sem promessa. O harness aproveita isso para verificar, na mesma volta
 * do event loop, **quantos** eventos cada requisição produziu e se ela seguiu
 * adiante sem esperar por nada.
 */
function noisyHarness({ env = { [DEMO_ANOMALY_ENV_VAR]: NOISY_LOGS_MODE }, log } = {}) {
  const events = [];

  const middleware = createNoisyLogsAnomaly({
    env,
    log: log ?? { emit: (event) => events.push(event) },
  });

  /** Executa uma requisição e devolve quantos eventos ela emitiu. */
  const run = (sequence) => {
    const before = events.length;
    let continued = false;
    let failure = null;

    middleware({ id: `req-${sequence}`, originalUrl: '/api/report' }, {}, (error) => {
      continued = true;
      failure = error ?? null;
    });

    // Lido **depois** da chamada e sem `await`: se o middleware tivesse
    // agendado qualquer coisa, `continued` ainda seria `false` aqui.
    return { synchronous: continued, error: failure, emitted: events.length - before };
  };

  return { run, events };
}

describe('createNoisyLogsAnomaly: um bloco em cada três requisições', () => {
  it('emite o bloco só na terceira, e sempre do mesmo tamanho', () => {
    const lab = noisyHarness();

    const results = [];
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      results.push(lab.run(sequence));
    }

    expect(results.map((result) => result.emitted)).toEqual([
      0, 0, NOISY_LOGS_EXTRA_EVENTS,
      0, 0, NOISY_LOGS_EXTRA_EVENTS,
      0, 0, NOISY_LOGS_EXTRA_EVENTS,
    ]);

    // "Exatamente 18 por ativação" é o requisito, e ele é conferido no total:
    // três ativações em nove requisições, nem uma linha a mais.
    expect(lab.events).toHaveLength((9 / NOISY_LOGS_EVERY) * NOISY_LOGS_EXTRA_EVENTS);
  });

  it('não espera, não reprova e não muda o veredito da requisição', () => {
    const lab = noisyHarness();

    const results = [];
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      results.push(lab.run(sequence));
    }

    // Sem atraso: o `next` já tinha sido chamado quando o harness olhou. Um
    // bloco de log que demorasse moveria `latencyP95Ms` junto e o
    // `firstAnomalousSignal` deixaria de ser `logLinesPerRequest`.
    expect(results.every((result) => result.synchronous)).toBe(true);
    expect(results.every((result) => result.error === null)).toBe(true);
  });

  it('registra `demo.anomaly.noisy-log` com o `requestId` da requisição que o provocou', () => {
    const lab = noisyHarness();

    for (let sequence = 1; sequence <= NOISY_LOGS_EVERY; sequence += 1) {
      lab.run(sequence);
    }

    expect(lab.events).toHaveLength(NOISY_LOGS_EXTRA_EVENTS);

    for (const event of lab.events) {
      expect(event.eventType).toBe('demo.anomaly.noisy-log');
      expect(event.phase).toBe('functional');
      // Volume não é gravidade: `error` iria para `stderr` e viraria evidência
      // de incidente na seleção de fatos do diagnóstico operacional.
      expect(event.level).toBe(NOISY_LOGS_LEVEL);
      expect(event.level).not.toBe('error');
      // Sem o `requestId`, a observação do Dia 2 cai na média por janela e
      // declara o número como aproximação em vez de contagem.
      expect(event.fields.requestId).toBe(`req-${NOISY_LOGS_EVERY}`);
      expect(event.fields.path).toBe('/api/report');
      expect(event.fields.statusCode).toBe(200);
      expect(event.fields.functionalArea).toBe('report');
    }

    // A numeração do bloco é o que torna a regra conferível no log.
    expect(lab.events[0].message).toContain(`evento 1/${NOISY_LOGS_EXTRA_EVENTS}`);
    expect(lab.events.at(-1).message).toContain(
      `evento ${NOISY_LOGS_EXTRA_EVENTS}/${NOISY_LOGS_EXTRA_EVENTS}`,
    );

    // Sem estar no contrato, o evento seria silenciosamente reescrito como
    // `app.starting` na emissão real — e o log do laboratório mentiria.
    expect(LOG_EVENT_TYPES).toContain('demo.anomaly.noisy-log');
  });

  it('tenta o bloco inteiro mesmo se o coletor falhar no meio', () => {
    let attempts = 0;
    const lab = noisyHarness({
      log: {
        emit: () => {
          attempts += 1;
          if (attempts === 5) throw new Error('coletor de log indisponível');
        },
      },
    });

    let result = null;
    for (let sequence = 1; sequence <= NOISY_LOGS_EVERY; sequence += 1) {
      result = lab.run(sequence);
    }

    // O `try` está dentro do laço: a falha do quinto evento não corta os treze
    // seguintes, e a proporção observada continua sendo a implementada.
    expect(attempts).toBe(NOISY_LOGS_EXTRA_EVENTS);
    expect(result.synchronous).toBe(true);
    expect(result.error).toBe(null);
  });

  it('conta o bloco por instância, e o laço é sempre finito', () => {
    // Duas instâncias, dois contadores: um roteador novo não herda o estado do
    // anterior. E o número de eventos é o mesmo em qualquer ativação — o laço
    // tem tamanho fixo, não depende do contador nem do relógio.
    const first = noisyHarness();
    const second = noisyHarness();

    for (let sequence = 1; sequence <= 30; sequence += 1) first.run(sequence);
    second.run(1);
    second.run(2);
    const activation = second.run(3);

    expect(first.events).toHaveLength((30 / NOISY_LOGS_EVERY) * NOISY_LOGS_EXTRA_EVENTS);
    expect(activation.emitted).toBe(NOISY_LOGS_EXTRA_EVENTS);
    expect(second.events).toHaveLength(NOISY_LOGS_EXTRA_EVENTS);
  });
});

describe('createNoisyLogsAnomaly: sem a variável não existe log extra', () => {
  it('não conta e não registra nada com o ambiente limpo', () => {
    const lab = noisyHarness({ env: {} });

    const results = [];
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      results.push(lab.run(sequence));
    }

    expect(results.every((result) => result.synchronous)).toBe(true);
    expect(results.every((result) => result.emitted === 0)).toBe(true);
    expect(lab.events).toEqual([]);
  });

  it('ignora um modo que não é o de volume de log', () => {
    for (const mode of [LATENCY_MODE, ERROR_RATE_MODE, 'payload']) {
      const lab = noisyHarness({ env: { [DEMO_ANOMALY_ENV_VAR]: mode } });
      for (let sequence = 1; sequence <= 9; sequence += 1) lab.run(sequence);
      expect(lab.events).toEqual([]);
    }
  });

  it('reconhece o modo apenas pelo valor exato, sem diferenciar caixa ou espaço', () => {
    expect(noisyLogsModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: 'noisy-logs' })).toBe(true);
    expect(noisyLogsModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: ' Noisy-Logs ' })).toBe(true);
    // O modo é plural; o evento emitido é que é singular.
    expect(noisyLogsModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: 'noisy-log' })).toBe(false);
    expect(noisyLogsModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: 'noisy_logs' })).toBe(false);
    expect(noisyLogsModeEnabled({ [DEMO_ANOMALY_ENV_VAR]: 'noisy-logs-extra' })).toBe(false);
    expect(noisyLogsModeEnabled({})).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Composição: um modo por vez                                                */
/* ------------------------------------------------------------------------- */

/**
 * @param {string|null} mode valor de `DEMO_ANOMALY_MODE`, ou `null` para ausente
 */
function composedHarness(mode) {
  const sleeps = [];
  const events = [];

  const middleware = createDemoAnomaly({
    env: mode === null ? {} : { [DEMO_ANOMALY_ENV_VAR]: mode },
    log: { emit: (event) => events.push(event) },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  const run = (sequence) =>
    new Promise((resolve) => {
      middleware(
        { id: `req-${sequence}`, originalUrl: '/api/report' },
        {},
        (error) => resolve({ error: error ?? null }),
      );
    });

  return { run, sleeps, events };
}

describe('createDemoAnomaly: um cenário de cada vez', () => {
  it('no modo `error-rate`, reprova sem nunca esperar', async () => {
    const lab = composedHarness(ERROR_RATE_MODE);

    const results = [];
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      results.push(await lab.run(sequence));
    }

    expect(results.filter((result) => result.error !== null)).toHaveLength(2);
    // Um 500 que também demorasse moveria `latencyP95Ms` junto, e o
    // `firstAnomalousSignal` do detector apontaria o sintoma errado.
    expect(lab.sleeps).toEqual([]);
    expect(lab.events.map((event) => event.eventType)).toEqual([
      'demo.anomaly.error-rate',
      'demo.anomaly.error-rate',
    ]);
  });

  it('no modo `latency`, espera sem nunca reprovar', async () => {
    const lab = composedHarness(LATENCY_MODE);

    const results = [];
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      results.push(await lab.run(sequence));
    }

    expect(results.every((result) => result.error === null)).toBe(true);
    expect(lab.sleeps).toHaveLength(3);
    expect(lab.events.every((event) => event.eventType === 'demo.anomaly.latency')).toBe(true);
  });

  it('no modo `noisy-logs`, fala sem esperar e sem reprovar', async () => {
    const lab = composedHarness(NOISY_LOGS_MODE);

    const results = [];
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      results.push(await lab.run(sequence));
    }

    expect(results.every((result) => result.error === null)).toBe(true);
    expect(lab.sleeps).toEqual([]);
    expect(lab.events).toHaveLength((9 / NOISY_LOGS_EVERY) * NOISY_LOGS_EXTRA_EVENTS);
    expect(lab.events.every((event) => event.eventType === 'demo.anomaly.noisy-log')).toBe(true);
  });

  it('sem a variável, atravessa os três cenários sem mover nada', async () => {
    const lab = composedHarness(null);

    const results = [];
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      results.push(await lab.run(sequence));
    }

    expect(results.every((result) => result.error === null)).toBe(true);
    expect(lab.sleeps).toEqual([]);
    expect(lab.events).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Integração: a aplicação inteira com o cenário ligado                       */
/* ------------------------------------------------------------------------- */

describe('GET /api/report com o cenário de erro intermitente', () => {
  const original = process.env[DEMO_ANOMALY_ENV_VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[DEMO_ANOMALY_ENV_VAR];
    else process.env[DEMO_ANOMALY_ENV_VAR] = original;
  });

  it('devolve 500 em ~20% das trinta requisições e 200 no resto', async () => {
    process.env[DEMO_ANOMALY_ENV_VAR] = ERROR_RATE_MODE;
    const app = createApp({ serveFrontend: false });

    const responses = [];
    for (let sequence = 1; sequence <= 30; sequence += 1) {
      responses.push(await request(app).get('/api/report'));
    }

    const failed = responses.filter((res) => res.status === 500);
    const ok = responses.filter((res) => res.status === 200);

    // Qualquer janela de trinta requisições consecutivas contém exatamente seis
    // múltiplos de cinco. A asserção não depende de onde estava o contador do
    // roteador (que é do módulo) quando este teste começou.
    expect(failed).toHaveLength(30 / ERROR_RATE_EVERY);
    expect(ok).toHaveLength(30 - 30 / ERROR_RATE_EVERY);

    // É este 0,2 que o detector do Dia 2 compara com `observado ≥ 0,15` e com
    // `observado − baseline ≥ 0,10`.
    expect(failed.length / responses.length).toBe(0.2);
  });

  it('usa a resposta de erro padronizada da aplicação, com o código do laboratório', async () => {
    process.env[DEMO_ANOMALY_ENV_VAR] = ERROR_RATE_MODE;
    const app = createApp({ serveFrontend: false });

    const bodies = [];
    for (let sequence = 1; sequence <= ERROR_RATE_EVERY * 2; sequence += 1) {
      const res = await request(app).get('/api/report');
      if (res.status === 500) bodies.push(res.body);
    }

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.error.code).toBe(ERROR_RATE_CODE);
      expect(body.error.message).toBe(ERROR_RATE_MESSAGE);
      expect(typeof body.requestId).toBe('string');
    }
  });

  it('mantém o mesmo relatório nas requisições que passam', async () => {
    process.env[DEMO_ANOMALY_ENV_VAR] = ERROR_RATE_MODE;
    const app = createApp({ serveFrontend: false });

    const bodies = [];
    for (let sequence = 1; sequence <= ERROR_RATE_EVERY * 2; sequence += 1) {
      const res = await request(app).get('/api/report');
      if (res.status === 200) bodies.push(res.body);
    }

    // O cenário move `errorRate`, e só ele: o corpo das que passam é o mesmo de
    // sempre, e o `responseSizeP95Bytes` observado não muda por causa disso.
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
    expect(bodies[0].totalRegistered).toBeGreaterThan(0);
  });

  it('não reprova /api/health em nenhuma requisição', async () => {
    process.env[DEMO_ANOMALY_ENV_VAR] = ERROR_RATE_MODE;
    const app = createApp({ serveFrontend: false });

    // O health check é o que a observação usa para saber que a aplicação subiu.
    // Um 500 aqui transformaria o cenário em falha de inicialização.
    for (let sequence = 1; sequence <= ERROR_RATE_EVERY * 3; sequence += 1) {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
    }
  });

  it('não reprova nada quando a variável não está definida', async () => {
    delete process.env[DEMO_ANOMALY_ENV_VAR];
    const app = createApp({ serveFrontend: false });

    for (let sequence = 1; sequence <= ERROR_RATE_EVERY * 3; sequence += 1) {
      const res = await request(app).get('/api/report');
      expect(res.status).toBe(200);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Integração: o cenário de excesso de logs na aplicação inteira              */
/* ------------------------------------------------------------------------- */

/**
 * Executa `fn` capturando o `stdout` do processo e devolve os eventos
 * estruturados que saíram por lá.
 *
 * A captura é do `stdout` de verdade, com o logger de verdade, porque é
 * exatamente isso que a observação do Dia 2 lê: um teste com emissor injetado
 * verificaria o que o middleware *pediu* para registrar, não o que a aplicação
 * de fato imprimiu — e é na diferença entre as duas coisas que mora o filtro de
 * `LOG_EVENT_TYPES`.
 *
 * @param {() => Promise<void>} fn
 * @returns {Promise<Array<object>>}
 */
async function captureStructuredLog(fn) {
  const chunks = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });

  try {
    await fn();
    // `http.request.completed` sai no evento `finish` da resposta, que ocorre
    // depois de o cliente já ter o corpo. Sem esta folga, a última linha de cada
    // requisição pode não ter sido escrita ainda — é o mesmo motivo do
    // `DEFAULT_DRAIN_MS` da observação.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    spy.mockRestore();
  }

  return chunks
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

describe('GET /api/report com o cenário de excesso de logs', () => {
  const original = process.env[DEMO_ANOMALY_ENV_VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[DEMO_ANOMALY_ENV_VAR];
    else process.env[DEMO_ANOMALY_ENV_VAR] = original;
  });

  /**
   * Trinta requisições com `x-request-id` próprio — a mesma correlação por
   * identificador que o `attachLogCounts` do Dia 2 usa.
   *
   * @param {number} count
   * @returns {Promise<{ events: Array<object>, ids: string[] }>}
   */
  async function measure(count) {
    const app = createApp({ serveFrontend: false });
    const ids = Array.from({ length: count }, (_, index) => `noisy-test-${index + 1}-${randomUUID()}`);

    const events = await captureStructuredLog(async () => {
      for (const id of ids) {
        const res = await request(app).get('/api/report').set('x-request-id', id);
        expect(res.status).toBe(200);
      }
    });

    return { events, ids };
  }

  /** Linhas de log por `requestId`, na ordem em que as requisições foram feitas. */
  function linesPerRequest(events, ids) {
    const counts = new Map(ids.map((id) => [id, { total: 0, noisy: 0 }]));

    for (const event of events) {
      const entry = counts.get(event.requestId);
      if (!entry) continue;
      entry.total += 1;
      if (event.eventType === 'demo.anomaly.noisy-log') entry.noisy += 1;
    }

    return ids.map((id) => counts.get(id));
  }

  it('leva `logLinesPerRequest` de 2 para 8 — acima do piso de disparo do detector', async () => {
    process.env[DEMO_ANOMALY_ENV_VAR] = NOISY_LOGS_MODE;
    const { events, ids } = await measure(30);

    const counts = linesPerRequest(events, ids);
    const observed = counts.reduce((total, entry) => total + entry.total, 0) / ids.length;

    // Esta é a conta de `summarizeSamples`, feita sobre o log de verdade. A
    // regra `log_volume` exige `observado ≥ baseline × 3` (≥ 6) **e**
    // `observado − baseline ≥ 5` (≥ 7) sobre a baseline saudável de 2 linhas.
    expect(observed).toBe(8);
    expect(observed).toBeGreaterThanOrEqual(2 * 3);
    expect(observed - 2).toBeGreaterThanOrEqual(5);
  }, 20_000);

  it('emite exatamente 18 eventos a mais em uma requisição em cada três', async () => {
    process.env[DEMO_ANOMALY_ENV_VAR] = NOISY_LOGS_MODE;
    const { events, ids } = await measure(30);

    const counts = linesPerRequest(events, ids);

    // Qualquer janela de trinta requisições consecutivas contém exatamente dez
    // múltiplos de três. A asserção não depende de onde estava o contador do
    // roteador (que é do módulo) quando este teste começou.
    expect(counts.filter((entry) => entry.noisy === NOISY_LOGS_EXTRA_EVENTS)).toHaveLength(
      30 / NOISY_LOGS_EVERY,
    );
    expect(counts.filter((entry) => entry.noisy === 0)).toHaveLength(30 - 30 / NOISY_LOGS_EVERY);

    // As duas linhas de sempre continuam lá, e nenhuma outra aparece: a
    // requisição ativada tem 2 + 18, a normal tem 2.
    expect(counts.every((entry) => entry.total === entry.noisy + 2)).toBe(true);

    // O evento chegou ao `stdout` com o tipo declarado — prova de que ele está
    // em `LOG_EVENT_TYPES` e não foi reescrito como `app.starting`.
    const noisy = events.filter((event) => event.eventType === 'demo.anomaly.noisy-log');
    expect(noisy).toHaveLength((30 / NOISY_LOGS_EVERY) * NOISY_LOGS_EXTRA_EVENTS);
    expect(noisy.every((event) => event.level === NOISY_LOGS_LEVEL)).toBe(true);
    expect(noisy.every((event) => event.phase === 'functional')).toBe(true);
    expect(noisy.every((event) => event.statusCode === 200)).toBe(true);
  }, 20_000);

  it('mantém 200 e o mesmo relatório em todas as requisições', async () => {
    process.env[DEMO_ANOMALY_ENV_VAR] = NOISY_LOGS_MODE;
    const app = createApp({ serveFrontend: false });

    const bodies = [];
    for (let sequence = 1; sequence <= NOISY_LOGS_EVERY * 2; sequence += 1) {
      const res = await request(app).get('/api/report');
      expect(res.status).toBe(200);
      bodies.push(res.body);
    }

    // O cenário move `logLinesPerRequest`, e só ele: nem `errorRate` (todas em
    // 200) nem `responseSizeP95Bytes` (mesmo corpo) se mexem.
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
    expect(bodies[0].totalRegistered).toBeGreaterThan(0);
  });

  it('não fala nada a mais em /api/health', async () => {
    process.env[DEMO_ANOMALY_ENV_VAR] = NOISY_LOGS_MODE;
    const app = createApp({ serveFrontend: false });

    const events = await captureStructuredLog(async () => {
      for (let sequence = 1; sequence <= NOISY_LOGS_EVERY * 3; sequence += 1) {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
      }
    });

    // O health check é o que a observação usa para saber que a aplicação subiu,
    // e é ele que o `waitForHealth` repete até responder. Um bloco de log aqui
    // entraria na janela de aquecimento e no ruído de subida.
    expect(events.filter((event) => event.eventType === 'demo.anomaly.noisy-log')).toEqual([]);
  });

  it('não emite nenhuma linha a mais quando a variável não está definida', async () => {
    delete process.env[DEMO_ANOMALY_ENV_VAR];
    const { events, ids } = await measure(9);

    const counts = linesPerRequest(events, ids);

    expect(events.filter((event) => event.eventType === 'demo.anomaly.noisy-log')).toEqual([]);
    // Duas linhas por requisição: a baseline da aplicação, intacta.
    expect(counts.every((entry) => entry.total === 2)).toBe(true);
  });
});
