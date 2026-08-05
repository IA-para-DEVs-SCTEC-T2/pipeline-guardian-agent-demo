import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createApp } from '../src/app.js';
import {
  DEMO_ANOMALY_ENV_VAR,
  LATENCY_DELAY_MS,
  LATENCY_EVERY,
  LATENCY_MODE,
  createLatencyAnomaly,
  latencyModeEnabled,
} from '../src/demo-anomalies.js';
import { LOG_EVENT_TYPES } from '../src/logging/structured-logger.js';
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
