/**
 * Testes da anomalia controlada de latência em GET /api/report.
 *
 * Regras verificadas:
 *  - exatamente 1 em cada 4 requisições recebe latência extra
 *  - a latência fica entre LATENCY_MIN_MS e LATENCY_MAX_MS (600–850 ms)
 *  - a rota continua devolvendo HTTP 200 quando a latência é injectada
 *  - um evento estruturado `anomaly.latency.injected` é emitido
 *  - a rota continua devolvendo HTTP 200 nas requisições sem latência
 *  - /api/health não é afectado
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

import { createReportRouter, resolveLatency, resetRequestCount } from '../src/routes/report.js';
import { createHealthRouter } from '../src/routes/health.js';
import { requestId } from '../src/middleware/requestId.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createStructuredLogger } from '../src/logging/structured-logger.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const ENV = { NODE_ENV: 'test', APP_VERSION: '0.0.0', COMMIT_SHA: 'test' };

function recorder() {
  const lines = [];
  const logger = createStructuredLogger({ write: (line) => lines.push(line), env: ENV });
  return {
    logger,
    events: () => lines.map((line) => JSON.parse(line)),
  };
}

/**
 * Monta uma aplicação mínima com a rota de report e de health.
 * `sleep` é substituído por um stub para evitar esperas reais nos testes.
 */
function buildApp({ log, sleepStub = vi.fn().mockResolvedValue(undefined), randomFn } = {}) {
  const app = express();
  app.use(requestId);
  app.use(
    '/api/report',
    createReportRouter({
      log,
      sleep: sleepStub,
      ...(randomFn ? { random: randomFn } : {}),
    }),
  );
  app.use('/api/health', createHealthRouter({ log }));
  app.use(errorHandler);
  return { app, sleepStub };
}

/* ------------------------------------------------------------------ */
/* resolveLatency — unit tests                                          */
/* ------------------------------------------------------------------ */

describe('resolveLatency', () => {
  it('devolve 0 para requisições que não são múltiplo de 4', () => {
    expect(resolveLatency(1)).toBe(0);
    expect(resolveLatency(2)).toBe(0);
    expect(resolveLatency(3)).toBe(0);
    expect(resolveLatency(5)).toBe(0);
    expect(resolveLatency(6)).toBe(0);
    expect(resolveLatency(7)).toBe(0);
  });

  it('devolve valor entre 600 e 850 ms para múltiplos de 4', () => {
    for (let n = 4; n <= 40; n += 4) {
      const ms = resolveLatency(n);
      expect(ms, `count=${n}`).toBeGreaterThanOrEqual(600);
      expect(ms, `count=${n}`).toBeLessThanOrEqual(850);
    }
  });

  it('usa a função random injectada', () => {
    // random() retorna 0 → mínimo de 600 ms
    expect(resolveLatency(4, () => 0)).toBe(600);
    // random() retorna 0.999... → próximo do máximo (850)
    // Math.random() nunca retorna 1.0 exactamente, então 0.9999 é o caso de borda real
    const nearMax = resolveLatency(4, () => 0.9999);
    expect(nearMax).toBeGreaterThanOrEqual(849);
    expect(nearMax).toBeLessThanOrEqual(850);
  });

  it('exactamente 1 em cada 4 dos primeiros 100 conta é anomalia', () => {
    const anomalias = Array.from({ length: 100 }, (_, i) => resolveLatency(i + 1));
    const total = anomalias.filter((ms) => ms > 0).length;
    expect(total).toBe(25); // 100 / 4
  });
});

/* ------------------------------------------------------------------ */
/* Comportamento HTTP                                                   */
/* ------------------------------------------------------------------ */

describe('GET /api/report — latência não quebra o status', () => {
  let log;
  let sleepStub;
  let app;

  beforeEach(() => {
    resetRequestCount();
    const rec = recorder();
    log = rec.logger;
    sleepStub = vi.fn().mockResolvedValue(undefined);
    // Forçar random = 0 para resultados determinísticos
    ({ app } = buildApp({ log, sleepStub, randomFn: () => 0 }));
  });

  it('as três primeiras requisições devolvem 200 sem chamar sleep', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/report');
      expect(res.status).toBe(200);
    }
    expect(sleepStub).not.toHaveBeenCalled();
  });

  it('a quarta requisição devolve 200 e chama sleep com latência entre 600-850 ms', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await request(app).get('/api/report');
      expect(res.status).toBe(200);
    }
    expect(sleepStub).toHaveBeenCalledTimes(1);
    const [ms] = sleepStub.mock.calls[0];
    expect(ms).toBeGreaterThanOrEqual(600);
    expect(ms).toBeLessThanOrEqual(850);
  });

  it('a oitava requisição também chama sleep e continua respondendo 200', async () => {
    for (let i = 0; i < 8; i++) {
      const res = await request(app).get('/api/report');
      expect(res.status).toBe(200);
    }
    expect(sleepStub).toHaveBeenCalledTimes(2);
  });

  it('em 12 requisições, sleep é chamado exactamente 3 vezes', async () => {
    for (let i = 0; i < 12; i++) {
      await request(app).get('/api/report');
    }
    expect(sleepStub).toHaveBeenCalledTimes(3);
  });
});

/* ------------------------------------------------------------------ */
/* Evento estruturado                                                   */
/* ------------------------------------------------------------------ */

describe('anomaly.latency.injected — log estruturado', () => {
  it('emite o evento quando a latência é injectada', async () => {
    resetRequestCount();
    const { logger, events } = recorder();
    const sleepStub = vi.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ log: logger, sleepStub, randomFn: () => 0 });

    // Faz 4 requisições — a última é a que dispara a anomalia
    for (let i = 0; i < 4; i++) {
      await request(app).get('/api/report');
    }

    const anomalyEvents = events().filter((e) => e.eventType === 'anomaly.latency.injected');
    expect(anomalyEvents).toHaveLength(1);

    const ev = anomalyEvents[0];
    expect(ev.level).toBe('warn');
    expect(ev.phase).toBe('functional');
    expect(ev.injectLatencyMs).toBeGreaterThanOrEqual(600);
    expect(ev.injectLatencyMs).toBeLessThanOrEqual(850);
    expect(ev.functionalArea).toBe('report');
    expect(ev.requestId).toBeDefined();
  });

  it('não emite o evento nas requisições sem latência', async () => {
    resetRequestCount();
    const { logger, events } = recorder();
    const sleepStub = vi.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ log: logger, sleepStub });

    // Somente as 3 primeiras — nenhuma é múltiplo de 4
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/report');
    }

    const anomalyEvents = events().filter((e) => e.eventType === 'anomaly.latency.injected');
    expect(anomalyEvents).toHaveLength(0);
  });

  it('ainda emite functional.report.completed na requisição com latência', async () => {
    resetRequestCount();
    const { logger, events } = recorder();
    const sleepStub = vi.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ log: logger, sleepStub });

    for (let i = 0; i < 4; i++) {
      await request(app).get('/api/report');
    }

    const completed = events().filter((e) => e.eventType === 'functional.report.completed');
    expect(completed).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ */
/* /api/health inalterado                                               */
/* ------------------------------------------------------------------ */

describe('/api/health não é afectado pela anomalia', () => {
  it('devolve 200 com status ok independentemente do contador de report', async () => {
    resetRequestCount();
    const { logger } = recorder();
    const sleepStub = vi.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ log: logger, sleepStub });

    // Faz 4 requisições de report para potencialmente activar contadores
    for (let i = 0; i < 4; i++) {
      await request(app).get('/api/report');
    }

    // Health deve continuar 100% intacto
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(sleepStub).toHaveBeenCalledTimes(1); // só o report chamou sleep
  });

  it('sleep nunca é chamado em requisições de health', async () => {
    resetRequestCount();
    const { logger } = recorder();
    const sleepStub = vi.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ log: logger, sleepStub });

    for (let i = 0; i < 8; i++) {
      await request(app).get('/api/health');
    }

    expect(sleepStub).not.toHaveBeenCalled();
  });
});
