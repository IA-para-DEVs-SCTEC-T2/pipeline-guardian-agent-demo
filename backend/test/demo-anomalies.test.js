import { describe, it, expect, afterEach } from 'vitest';
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
  createDemoAnomaly,
  createErrorRateAnomaly,
  createLatencyAnomaly,
  errorRateModeEnabled,
  latencyModeEnabled,
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

  it('sem a variável, atravessa os dois cenários sem mover nada', async () => {
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
