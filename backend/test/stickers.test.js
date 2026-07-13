import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { resetStore, getSticker, listStickers } from '../src/store/store.js';

const app = createApp();

beforeEach(() => {
  resetStore();
});

describe('GET /api/health', () => {
  it('responde ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /api/stickers', () => {
  it('retorna o seed com duplicateCopies calculado', async () => {
    const res = await request(app).get('/api/stickers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(12);
    const withDupes = res.body.find((s) => s.quantity === 3);
    expect(withDupes.duplicateCopies).toBe(2);
  });
});

describe('GET /api/stickers/:id', () => {
  it('retorna a figurinha existente', async () => {
    const [first] = listStickers();
    const res = await request(app).get(`/api/stickers/${first.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(first.id);
    expect(res.body.albumNumber).toBe(first.albumNumber);
  });

  it('recurso inexistente retorna 404', async () => {
    const res = await request(app).get('/api/stickers/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/stickers', () => {
  it('cria uma figurinha válida e retorna 201', async () => {
    const res = await request(app).post('/api/stickers').send({
      albumNumber: 99,
      playerName: 'Teste Jogador',
      country: 'Espanha',
      countryCode: 'es',
      position: 'forward',
      quantity: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body.countryCode).toBe('ES');
    expect(res.body.duplicateCopies).toBe(1);
  });

  it('nome inválido (menos de 3 caracteres) retorna 400', async () => {
    const res = await request(app).post('/api/stickers').send({
      albumNumber: 100,
      playerName: 'ab',
      country: 'Espanha',
      countryCode: 'ES',
      position: 'forward',
      quantity: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('posição inválida retorna 400', async () => {
    const res = await request(app).post('/api/stickers').send({
      albumNumber: 101,
      playerName: 'Jogador Válido',
      country: 'Espanha',
      countryCode: 'ES',
      position: 'coach',
      quantity: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('quantidade negativa retorna 400', async () => {
    const res = await request(app).post('/api/stickers').send({
      albumNumber: 102,
      playerName: 'Jogador Válido',
      country: 'Espanha',
      countryCode: 'ES',
      position: 'forward',
      quantity: -5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('albumNumber duplicado retorna 400', async () => {
    const res = await request(app).post('/api/stickers').send({
      albumNumber: 1,
      playerName: 'Outro Jogador',
      country: 'Brasil',
      countryCode: 'BR',
      position: 'defender',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DUPLICATE_ALBUM_NUMBER');
  });
});

describe('PATCH /api/stickers/:id/quantity', () => {
  it('incrementa a quantidade em um', async () => {
    const one = listStickers().find((s) => s.quantity === 1);
    const res = await request(app)
      .patch(`/api/stickers/${one.id}/quantity`)
      .send({ operation: 'increment' });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(2);
    expect(res.body.duplicateCopies).toBe(1);
  });

  it('decrementa a quantidade em um', async () => {
    const two = listStickers().find((s) => s.quantity === 2);
    const res = await request(app)
      .patch(`/api/stickers/${two.id}/quantity`)
      .send({ operation: 'decrement' });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(1);
  });

  it('tentativa de decrementar abaixo de zero nunca fica negativo', async () => {
    const zero = listStickers().find((s) => s.quantity === 0);
    const res = await request(app)
      .patch(`/api/stickers/${zero.id}/quantity`)
      .send({ operation: 'decrement' });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBe(0);
  });

  it('operation inválida retorna 400', async () => {
    const any = listStickers()[0];
    const res = await request(app)
      .patch(`/api/stickers/${any.id}/quantity`)
      .send({ operation: 'reset' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('recurso inexistente retorna 404', async () => {
    const res = await request(app)
      .patch('/api/stickers/nao-existe/quantity')
      .send({ operation: 'increment' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/stickers/:id', () => {
  it('exclui uma figurinha existente e retorna 204', async () => {
    const any = listStickers()[0];
    const res = await request(app).delete(`/api/stickers/${any.id}`);
    expect(res.status).toBe(204);
    expect(getSticker(any.id)).toBeNull();
  });

  it('recurso inexistente retorna 404', async () => {
    const res = await request(app).delete('/api/stickers/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/report', () => {
  it('calcula percentuais e listas do relatório', async () => {
    const res = await request(app).get('/api/report');
    expect(res.status).toBe(200);
    expect(res.body.totalRegistered).toBe(12);
    // 9 figurinhas com quantity >= 1 no seed
    expect(res.body.obtained).toBe(9);
    expect(res.body.missing).toBe(3);
    expect(res.body.completionPercentage).toBe(75);
    expect(Array.isArray(res.body.byCountry)).toBe(true);
    expect(res.body.missingStickers).toHaveLength(3);
  });
});
