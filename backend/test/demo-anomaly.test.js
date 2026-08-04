/**
 * Modos de demonstração do Dia 2.
 *
 * O teste mais importante deste arquivo é o primeiro: **sem
 * `DEMO_ANOMALY_MODE`, nada muda**. Se ligar o Dia 2 alterasse o comportamento
 * padrão, a baseline medida deixaria de descrever o normal — e o laboratório
 * inteiro estaria comparando duas coisas diferentes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import {
  DEMO_EVERY_NTH_REQUEST,
  DEMO_LATENCY_MS,
  DEMO_NOISY_LOG_EVENT,
  DEMO_NOISY_LOG_LINES,
  createDemoAnomalyMiddleware,
  isDemoTarget,
  resolveDemoMode,
} from '../src/demo-anomaly.js';
import { LOG_EVENT_TYPES, buildLogEvent } from '../src/logging/structured-logger.js';

const original = process.env.DEMO_ANOMALY_MODE;

afterEach(() => {
  if (original === undefined) delete process.env.DEMO_ANOMALY_MODE;
  else process.env.DEMO_ANOMALY_MODE = original;
});

/** Emissor de log falso: guarda os eventos em vez de escrever em stdout. */
function fakeLog() {
  const events = [];
  return { events, emit: (event) => events.push(event) };
}

/** Executa o middleware como o Express executaria. */
function run(middleware, { method = 'GET', url = '/api/report', id = 'req-1' } = {}) {
  return new Promise((resolve, reject) => {
    middleware({ method, url, originalUrl: url, id }, {}, (error) => (error ? reject(error) : resolve()));
  });
}

describe('resolveDemoMode', () => {
  it('devolve `none` sem a variável, com valor vazio ou com valor desconhecido', () => {
    expect(resolveDemoMode({})).toBe('none');
    expect(resolveDemoMode({ DEMO_ANOMALY_MODE: '' })).toBe('none');
    expect(resolveDemoMode({ DEMO_ANOMALY_MODE: 'chaos' })).toBe('none');
    expect(resolveDemoMode({ DEMO_ANOMALY_MODE: 'none' })).toBe('none');
  });

  it('reconhece os dois modos, sem depender da caixa', () => {
    expect(resolveDemoMode({ DEMO_ANOMALY_MODE: 'latency' })).toBe('latency');
    expect(resolveDemoMode({ DEMO_ANOMALY_MODE: 'NOISY-LOGS' })).toBe('noisy-logs');
  });
});

describe('isDemoTarget', () => {
  it('só `GET /api/report`', () => {
    expect(isDemoTarget({ method: 'GET', originalUrl: '/api/report' })).toBe(true);
    expect(isDemoTarget({ method: 'GET', originalUrl: '/api/report?x=1' })).toBe(true);
    expect(isDemoTarget({ method: 'POST', originalUrl: '/api/report' })).toBe(false);
    expect(isDemoTarget({ method: 'GET', originalUrl: '/api/health' })).toBe(false);
    expect(isDemoTarget({ method: 'GET', originalUrl: '/api/stickers' })).toBe(false);
  });
});

describe('sem DEMO_ANOMALY_MODE o comportamento é o do Dia 1', () => {
  it('a rota responde 200 sem atraso e sem linha extra', async () => {
    delete process.env.DEMO_ANOMALY_MODE;
    const app = createApp({ serveFrontend: false });

    const startedAt = Date.now();
    const response = await request(app).get('/api/report');

    expect(response.status).toBe(200);
    expect(response.body.totalRegistered).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(DEMO_LATENCY_MS);
  });

  it('o middleware desligado não conta, não espera e não registra nada', async () => {
    const log = fakeLog();
    const sleep = vi.fn();
    const middleware = createDemoAnomalyMiddleware({ mode: 'none', log, sleep });

    for (let index = 0; index < 6; index += 1) await run(middleware);

    expect(sleep).not.toHaveBeenCalled();
    expect(log.events).toHaveLength(0);
  });
});

describe('modo latency', () => {
  it('espera 500 ms a cada terceira requisição da rota', async () => {
    const sleep = vi.fn(async () => {});
    const middleware = createDemoAnomalyMiddleware({ mode: 'latency', sleep, log: fakeLog() });

    for (let index = 0; index < 6; index += 1) await run(middleware);

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(DEMO_LATENCY_MS);
  });

  it('não toca em `/api/health` nem em outras rotas', async () => {
    const sleep = vi.fn(async () => {});
    const middleware = createDemoAnomalyMiddleware({ mode: 'latency', sleep, log: fakeLog() });

    for (let index = 0; index < 9; index += 1) await run(middleware, { url: '/api/health' });
    for (let index = 0; index < 9; index += 1) await run(middleware, { url: '/api/stickers' });

    expect(sleep).not.toHaveBeenCalled();
  });

  it('a resposta continua 200 e o health check continua rápido', async () => {
    process.env.DEMO_ANOMALY_MODE = 'latency';
    const app = createApp({ serveFrontend: false });

    await request(app).get('/api/report');
    await request(app).get('/api/report');

    const startedAt = Date.now();
    const slow = await request(app).get('/api/report');
    const elapsed = Date.now() - startedAt;

    expect(slow.status).toBe(200);
    expect(slow.body.totalRegistered).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(DEMO_LATENCY_MS - 50);

    const healthStartedAt = Date.now();
    const health = await request(app).get('/api/health');

    expect(health.status).toBe(200);
    expect(Date.now() - healthStartedAt).toBeLessThan(DEMO_LATENCY_MS);
  });
});

describe('modo noisy-logs', () => {
  it('emite 18 linhas a cada terceira requisição, com o requestId da requisição', async () => {
    const log = fakeLog();
    const middleware = createDemoAnomalyMiddleware({ mode: 'noisy-logs', log });

    await run(middleware, { id: 'lab-0001' });
    await run(middleware, { id: 'lab-0002' });
    expect(log.events).toHaveLength(0);

    await run(middleware, { id: 'lab-0003' });

    expect(log.events).toHaveLength(DEMO_NOISY_LOG_LINES);
    expect(log.events.every((event) => event.eventType === DEMO_NOISY_LOG_EVENT)).toBe(true);
    expect(log.events.every((event) => event.fields.requestId === 'lab-0003')).toBe(true);
  });

  it('18 linhas a cada três requisições dão +6 por requisição — acima das duas regras', async () => {
    const log = fakeLog();
    const middleware = createDemoAnomalyMiddleware({ mode: 'noisy-logs', log });

    for (let index = 1; index <= 30; index += 1) await run(middleware, { id: `lab-${index}` });

    // 2 linhas normais + as extras, divididas pelas 30 requisições.
    const perRequest = (30 * 2 + log.events.length) / 30;

    expect(log.events).toHaveLength((30 / DEMO_EVERY_NTH_REQUEST) * DEMO_NOISY_LOG_LINES);
    expect(perRequest).toBeGreaterThanOrEqual(2 * 3);
    expect(perRequest - 2).toBeGreaterThanOrEqual(5);
  });

  it('o evento está na lista fechada do logger e sobrevive a `buildLogEvent`', () => {
    expect(LOG_EVENT_TYPES).toContain(DEMO_NOISY_LOG_EVENT);

    const event = buildLogEvent({
      eventType: DEMO_NOISY_LOG_EVENT,
      phase: 'runtime',
      message: 'linha de depuração 1/18',
      fields: { requestId: 'lab-0003', functionalArea: 'report' },
    });

    expect(event.eventType).toBe(DEMO_NOISY_LOG_EVENT);
    expect(event.requestId).toBe('lab-0003');
  });

  it('a resposta continua 200 e as demais rotas não mudam', async () => {
    process.env.DEMO_ANOMALY_MODE = 'noisy-logs';
    const app = createApp({ serveFrontend: false });

    for (let index = 0; index < 3; index += 1) {
      const response = await request(app).get('/api/report');
      expect(response.status).toBe(200);
    }

    const stickers = await request(app).get('/api/stickers');
    expect(stickers.status).toBe(200);
  });
});
