import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { releaseInfo, SERVICE_NAME, UNKNOWN_COMMIT, UNKNOWN_VERSION } from '../src/release.js';

// Sem frontend montado: estes testes são sobre a API, não sobre arquivos estáticos.
const app = createApp({ serveFrontend: false });

const TOUCHED = ['NODE_ENV', 'APP_VERSION', 'COMMIT_SHA', 'RAILWAY_GIT_COMMIT_SHA'];
const original = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of TOUCHED) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe('GET /api/health', () => {
  it('responde 200 com os metadados da release', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_VERSION = '1.4.2';
    process.env.COMMIT_SHA = 'abc1234';

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe(SERVICE_NAME);
    expect(res.body.environment).toBe('production');
    expect(res.body.version).toBe('1.4.2');
    expect(res.body.commitSha).toBe('abc1234');
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(() => new Date(res.body.timestamp).toISOString()).not.toThrow();
  });

  it('usa fallback seguro quando versão e commit não são informados', async () => {
    delete process.env.APP_VERSION;
    delete process.env.COMMIT_SHA;
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    delete process.env.NODE_ENV;

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.commitSha).toBe(UNKNOWN_COMMIT);
    expect(res.body.environment).toBe('development');
    // Sem APP_VERSION cai no `version` do package.json do backend.
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.body.version).not.toBe(UNKNOWN_VERSION);
  });

  it('não expõe segredos nem o ambiente inteiro', async () => {
    process.env.APP_VERSION = '1.0.0';

    const res = await request(app).get('/api/health');
    const keys = Object.keys(res.body).sort();

    expect(keys).toEqual([
      'commitSha',
      'environment',
      'requestId',
      'service',
      'status',
      'timestamp',
      'uptimeSeconds',
      'version',
    ]);

    const body = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ['token', 'secret', 'password', 'api_key', 'apikey', 'authorization']) {
      expect(body).not.toContain(forbidden);
    }
  });
});

describe('GET /api/version', () => {
  it('devolve apenas metadados não sensíveis da release', async () => {
    process.env.APP_VERSION = '2.0.0';
    process.env.COMMIT_SHA = 'deadbeef';
    process.env.NODE_ENV = 'production';

    const res = await request(app).get('/api/version');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'commitSha',
      'environment',
      'requestId',
      'service',
      'version',
    ]);
    expect(res.body.version).toBe('2.0.0');
    expect(res.body.commitSha).toBe('deadbeef');
  });

  it('não diverge de /api/health: as duas rotas leem a mesma origem', async () => {
    process.env.APP_VERSION = '3.1.4';
    process.env.COMMIT_SHA = 'cafe123';

    const [health, version] = await Promise.all([
      request(app).get('/api/health'),
      request(app).get('/api/version'),
    ]);

    for (const field of ['service', 'environment', 'version', 'commitSha']) {
      expect(version.body[field]).toBe(health.body[field]);
    }
  });
});

describe('releaseInfo', () => {
  it('prefere COMMIT_SHA a RAILWAY_GIT_COMMIT_SHA', () => {
    const info = releaseInfo({ COMMIT_SHA: 'meu-sha', RAILWAY_GIT_COMMIT_SHA: 'sha-do-railway' });
    expect(info.commitSha).toBe('meu-sha');
  });

  it('aceita o commit preenchido pelo Railway quando COMMIT_SHA não existe', () => {
    const info = releaseInfo({ RAILWAY_GIT_COMMIT_SHA: 'sha-do-railway' });
    expect(info.commitSha).toBe('sha-do-railway');
  });

  it('nunca devolve undefined em nenhum campo', () => {
    const info = releaseInfo({});
    expect(Object.values(info).every((value) => typeof value === 'string' && value.length > 0)).toBe(true);
  });
});
