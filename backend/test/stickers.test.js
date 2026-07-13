import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { resetStore, getSticker, listStickers } from '../src/store/store.js';
import { buildReport, duplicateCopies } from '../src/services/report.js';

const app = createApp();

test.beforeEach(() => {
  resetStore();
});

test('GET /api/health responde ok', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('GET /api/stickers retorna o seed com duplicateCopies', async () => {
  const res = await request(app).get('/api/stickers');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 12);
  const withDupes = res.body.find((s) => s.quantity === 3);
  assert.equal(withDupes.duplicateCopies, 2);
});

test('GET /api/stickers/:id inexistente retorna 404', async () => {
  const res = await request(app).get('/api/stickers/nao-existe');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

test('POST /api/stickers válido retorna 201', async () => {
  const res = await request(app).post('/api/stickers').send({
    albumNumber: 99,
    playerName: 'Teste Jogador',
    country: 'Espanha',
    countryCode: 'es',
    position: 'forward',
    quantity: 2,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.countryCode, 'ES');
  assert.equal(res.body.duplicateCopies, 1);
});

test('POST /api/stickers inválido retorna 400', async () => {
  const res = await request(app).post('/api/stickers').send({
    albumNumber: -1,
    playerName: 'ab',
    country: '',
    countryCode: 'BRA',
    position: 'coach',
    quantity: -5,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

test('POST com albumNumber duplicado retorna 400', async () => {
  const res = await request(app).post('/api/stickers').send({
    albumNumber: 1,
    playerName: 'Outro Jogador',
    country: 'Brasil',
    countryCode: 'BR',
    position: 'defender',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'DUPLICATE_ALBUM_NUMBER');
});

test('PATCH decrement nunca fica negativo', async () => {
  const zero = listStickers().find((s) => s.quantity === 0);
  const res = await request(app)
    .patch(`/api/stickers/${zero.id}/quantity`)
    .send({ operation: 'decrement' });
  assert.equal(res.status, 200);
  assert.equal(res.body.quantity, 0);
});

test('PATCH increment soma um', async () => {
  const one = listStickers().find((s) => s.quantity === 1);
  const res = await request(app)
    .patch(`/api/stickers/${one.id}/quantity`)
    .send({ operation: 'increment' });
  assert.equal(res.status, 200);
  assert.equal(res.body.quantity, 2);
  assert.equal(res.body.duplicateCopies, 1);
});

test('PATCH com operation inválida retorna 400', async () => {
  const any = listStickers()[0];
  const res = await request(app)
    .patch(`/api/stickers/${any.id}/quantity`)
    .send({ operation: 'reset' });
  assert.equal(res.status, 400);
});

test('DELETE existente retorna 204 e remove', async () => {
  const any = listStickers()[0];
  const res = await request(app).delete(`/api/stickers/${any.id}`);
  assert.equal(res.status, 204);
  assert.equal(getSticker(any.id), null);
});

test('DELETE inexistente retorna 404', async () => {
  const res = await request(app).delete('/api/stickers/nao-existe');
  assert.equal(res.status, 404);
});

test('GET /api/report calcula percentuais e listas', async () => {
  const res = await request(app).get('/api/report');
  assert.equal(res.status, 200);
  assert.equal(res.body.totalRegistered, 12);
  // 9 figurinhas com quantity >= 1 no seed
  assert.equal(res.body.obtained, 9);
  assert.equal(res.body.missing, 3);
  assert.equal(res.body.completionPercentage, 75);
  assert.ok(Array.isArray(res.body.byCountry));
  assert.equal(res.body.missingStickers.length, 3);
});

test('unidade: duplicateCopies e buildReport', () => {
  assert.equal(duplicateCopies(0), 0);
  assert.equal(duplicateCopies(1), 0);
  assert.equal(duplicateCopies(3), 2);

  const report = buildReport([
    { id: 'a', albumNumber: 1, playerName: 'X', country: 'Brasil', countryCode: 'BR', position: 'forward', quantity: 0 },
    { id: 'b', albumNumber: 2, playerName: 'Y', country: 'Brasil', countryCode: 'BR', position: 'forward', quantity: 2 },
  ]);
  assert.equal(report.totalRegistered, 2);
  assert.equal(report.obtained, 1);
  assert.equal(report.completionPercentage, 50);
  assert.equal(report.duplicateCopies, 1);
});
