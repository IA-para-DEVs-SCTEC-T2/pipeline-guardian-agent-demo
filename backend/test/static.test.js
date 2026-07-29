import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { SPA_FALLBACK_PATTERN } from '../src/static.js';

/**
 * Fixture mínima no lugar do build real do Vite: o que está sob teste é o
 * roteamento (quem recebe `index.html` e quem não recebe), não o bundler.
 * Assim os testes do backend não dependem de um `npm run build` lento.
 */
const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';
const APP_JS = 'console.log("bundle");\n';

const distDir = mkdtempSync(join(tmpdir(), 'copa-dist-'));
mkdirSync(join(distDir, 'assets'), { recursive: true });
writeFileSync(join(distDir, 'index.html'), INDEX_HTML, 'utf8');
writeFileSync(join(distDir, 'assets', 'app-abc123.js'), APP_JS, 'utf8');

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

const app = createApp({ frontendDist: distDir, log: () => {} });

describe('frontend compilado servido pelo Express', () => {
  it('monta o diretório informado', () => {
    expect(app.locals.frontend.mounted).toBe(true);
    expect(app.locals.frontend.dist).toBe(distDir);
  });

  it('serve o index.html na raiz', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('id="root"');
  });

  it('serve os assets estáticos', async () => {
    const res = await request(app).get('/assets/app-abc123.js');

    expect(res.status).toBe(200);
    expect(res.text).toContain('bundle');
  });
});

describe('fallback da SPA', () => {
  it('devolve o index.html em rotas do frontend (refresh não quebra)', async () => {
    for (const path of ['/album', '/relatorio', '/figurinhas/42/detalhe']) {
      const res = await request(app).get(path);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('id="root"');
    }
  });

  it('NÃO intercepta rotas da API: rota inexistente continua respondendo JSON', async () => {
    const res = await request(app).get('/api/rota-que-nao-existe');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.text).not.toContain('id="root"');
  });

  it('NÃO intercepta `/api` sem barra', async () => {
    const res = await request(app).get('/api');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('preserva as rotas reais da API', async () => {
    const health = await request(app).get('/api/health');
    const report = await request(app).get('/api/report');

    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(report.status).toBe(200);
    expect(typeof report.body.totalRegistered).toBe('number');
  });

  it('só se aplica a GET: método sem rota continua em 404 da API', async () => {
    const res = await request(app).post('/rota-inexistente').send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('SPA_FALLBACK_PATTERN', () => {
  it('casa com rotas do frontend e ignora as da API', () => {
    for (const path of ['/', '/album', '/apiario', '/relatorio/2026']) {
      expect(SPA_FALLBACK_PATTERN.test(path)).toBe(true);
    }
    for (const path of ['/api', '/api/', '/api/health', '/api/stickers/1']) {
      expect(SPA_FALLBACK_PATTERN.test(path)).toBe(false);
    }
  });
});

describe('sem o build do frontend', () => {
  const missing = join(distDir, 'nao-existe');
  const emptyApp = createApp({ frontendDist: missing, log: () => {} });

  it('não monta nada e não derruba a API', async () => {
    expect(emptyApp.locals.frontend.mounted).toBe(false);

    const res = await request(emptyApp).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('responde 404 em JSON no lugar do index.html', async () => {
    const res = await request(emptyApp).get('/album');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('registra a falta do build no log quando NODE_ENV=production', () => {
    const lines = [];
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      createApp({ frontendDist: missing, log: (line) => lines.push(line) });
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
    expect(lines[0].message).toContain('Build do frontend não encontrado');
    expect(lines[0].message).toContain(missing);
  });

  it('fica em silêncio fora de produção', () => {
    const lines = [];
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    try {
      createApp({ frontendDist: missing, log: (line) => lines.push(line) });
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }

    expect(lines).toHaveLength(0);
  });
});
