import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';

import { createApp } from '../src/app.js';
import {
  LOG_EVENT_TYPES,
  LOG_LEVELS,
  LOG_PHASES,
  LOG_SCHEMA_VERSION,
  buildLogEvent,
  createStructuredLogger,
  describeError,
  redactLogText,
  safePath,
} from '../src/logging/structured-logger.js';
import { createRequestLogger, levelFor, phaseFor } from '../src/middleware/logger.js';
import { createHealthRouter } from '../src/routes/health.js';
import { createReportRouter } from '../src/routes/report.js';
import { requestId } from '../src/middleware/requestId.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { startServer } from '../src/server.js';

const ENV = {
  NODE_ENV: 'production',
  APP_VERSION: '1.2.3',
  COMMIT_SHA: '9f3ac21aa0d4c7e1b2',
};

/** Emissor que guarda os eventos em memória, sem tocar em stdout. */
function recorder() {
  const lines = [];
  const logger = createStructuredLogger({ write: (line) => lines.push(line), env: ENV });
  return {
    logger,
    lines,
    events: () => lines.map((line) => JSON.parse(line)),
  };
}

const REQUIRED_FIELDS = [
  'schemaVersion',
  'time',
  'level',
  'source',
  'service',
  'environment',
  'commitSha',
  'eventType',
  'phase',
  'message',
];

/* ------------------------------------------------------------------------- */
/* Formato do evento                                                          */
/* ------------------------------------------------------------------------- */

describe('contrato do evento', () => {
  it('traz todos os campos obrigatórios', () => {
    const event = buildLogEvent({
      eventType: 'app.started',
      phase: 'startup',
      message: 'ouvindo',
      env: ENV,
    });

    for (const field of REQUIRED_FIELDS) {
      expect(event[field], `campo ausente: ${field}`).toBeDefined();
    }

    expect(event.schemaVersion).toBe(LOG_SCHEMA_VERSION);
    expect(event.source).toBe('application');
    expect(event.service).toBe('copa-figurinhas');
    expect(event.environment).toBe('production');
    expect(event.commitSha).toBe('9f3ac21aa0d4c7e1b2');
    expect(() => new Date(event.time).toISOString()).not.toThrow();
  });

  it('emite uma única linha JSON por evento, sem quebra interna', () => {
    const { logger, lines } = recorder();

    logger.emit({ eventType: 'app.started', phase: 'startup', message: 'linha 1\nlinha 2' });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    // A quebra de linha da mensagem vai escapada dentro do JSON: a linha física
    // continua sendo uma só, que é o que o coletor da plataforma consome.
    expect(lines[0].trimEnd().includes('\n')).toBe(false);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(JSON.parse(lines[0]).message).toBe('linha 1\nlinha 2');
  });

  it('separa mensagem humana de campo estruturado', () => {
    const event = buildLogEvent({
      eventType: 'http.request.completed',
      phase: 'runtime',
      message: 'GET /api/report 200',
      fields: { statusCode: 200, durationMs: 24.36, method: 'GET', path: '/api/report' },
      env: ENV,
    });

    expect(event.message).toBe('GET /api/report 200');
    expect(event.statusCode).toBe(200);
    expect(event.durationMs).toBe(24.36);
    expect(event.method).toBe('GET');
    expect(event.path).toBe('/api/report');
  });

  it('descarta campo que não está na lista fechada', () => {
    const event = buildLogEvent({
      eventType: 'http.request.completed',
      phase: 'runtime',
      message: 'ok',
      fields: {
        requestId: 'req-1',
        authorization: 'Bearer segredo',
        headers: { cookie: 'session=abc' },
        body: { password: '123456' },
        env: process.env,
      },
      env: ENV,
    });

    expect(event.requestId).toBe('req-1');
    expect(event.authorization).toBeUndefined();
    expect(event.headers).toBeUndefined();
    expect(event.body).toBeUndefined();
    expect(event.env).toBeUndefined();
  });

  it('normaliza nível, eventType e phase desconhecidos em vez de propagá-los', () => {
    const event = buildLogEvent({
      eventType: 'evento.inventado',
      phase: 'fase-inventada',
      level: 'catastrófico',
      message: 'x',
      env: ENV,
    });

    expect(LOG_EVENT_TYPES).toContain(event.eventType);
    expect(LOG_PHASES).toContain(event.phase);
    expect(LOG_LEVELS).toContain(event.level);
  });
});

/* ------------------------------------------------------------------------- */
/* Severidade                                                                 */
/* ------------------------------------------------------------------------- */

describe('níveis de severidade', () => {
  it('mapeia 2xx para info, 4xx para warn e 5xx para error', () => {
    expect(levelFor(200)).toBe('info');
    expect(levelFor(204)).toBe('info');
    expect(levelFor(301)).toBe('info');
    expect(levelFor(400)).toBe('warn');
    expect(levelFor(404)).toBe('warn');
    expect(levelFor(500)).toBe('error');
    expect(levelFor(503)).toBe('error');
  });

  it('manda `error` para stderr e o resto para stdout', () => {
    const streams = [];
    const logger = createStructuredLogger({
      write: (_line, level) => streams.push(level),
      env: ENV,
    });

    logger.info({ eventType: 'app.started', phase: 'startup', message: 'a' });
    logger.warn({ eventType: 'http.request.completed', phase: 'runtime', message: 'b' });
    logger.error({ eventType: 'app.uncaught_exception', phase: 'shutdown', message: 'c' });

    expect(streams).toEqual(['info', 'warn', 'error']);
  });

  it('classifica a fase pelo caminho da requisição', () => {
    expect(phaseFor('/api/health')).toBe('healthcheck');
    expect(phaseFor('/api/report')).toBe('functional');
    expect(phaseFor('/api/report?x=1')).toBe('functional');
    expect(phaseFor('/api/stickers')).toBe('runtime');
    expect(phaseFor('/')).toBe('runtime');
  });
});

/* ------------------------------------------------------------------------- */
/* Segredos                                                                   */
/* ------------------------------------------------------------------------- */

describe('nada de header, credencial ou query string', () => {
  const LEAKY = [
    'Authorization: Bearer ghp_abcdefghijklmnop1234567890',
    'Cookie: session=abc123; token=xyz',
    'chave sk-proj-super-secreta-1234567890',
    'github_pat_11ABCDEFG0abcdefghijklmnop',
    'postgres://usuario:senha@db.interno:5432/app',
  ];

  it('mascara material de credencial na mensagem', () => {
    for (const text of LEAKY) {
      const masked = redactLogText(text);
      expect(masked).toContain('[REDACTED]');
      expect(masked).not.toContain('ghp_abcdefghijklmnop1234567890');
      expect(masked).not.toContain('sk-proj-super-secreta-1234567890');
      expect(masked).not.toContain('github_pat_11ABCDEFG0abcdefghijklmnop');
      expect(masked).not.toContain('senha@db.interno');
      expect(masked).not.toContain('session=abc123');
    }
  });

  it('descarta a query string do path preservando a rota', () => {
    expect(safePath('/api/stickers?access_token=abc123&password=hunter2')).toBe('/api/stickers');
    expect(safePath('/api/report')).toBe('/api/report');
  });

  it('limita o tamanho do texto livre', () => {
    const event = buildLogEvent({
      eventType: 'app.started',
      phase: 'startup',
      message: 'x'.repeat(5000),
      env: ENV,
    });

    expect(event.message.length).toBeLessThanOrEqual(513);
    expect(event.message.endsWith('…')).toBe(true);
  });

  it('não deixa segredo passar por um campo estruturado de texto', () => {
    const event = buildLogEvent({
      eventType: 'app.uncaught_exception',
      phase: 'shutdown',
      message: 'falhou',
      fields: { errorName: 'Error', errorCategory: 'token sk-proj-abcdefghij1234' },
      env: ENV,
    });

    expect(JSON.stringify(event)).not.toContain('sk-proj-abcdefghij1234');
  });
});

/* ------------------------------------------------------------------------- */
/* Erros                                                                      */
/* ------------------------------------------------------------------------- */

describe('sanitização de mensagens de erro', () => {
  it('preserva o nome do erro e mascara a mensagem — sem stack trace', () => {
    const error = new TypeError('falha ao conectar em postgres://app:senha123@db:5432/x');
    const described = describeError(error);

    expect(described.errorName).toBe('TypeError');
    expect(described.message).toContain('[REDACTED]');
    expect(described.message).not.toContain('senha123');
    expect(described).not.toHaveProperty('stack');
    expect(JSON.stringify(described)).not.toContain('at Object');
  });

  it('não quebra com valor lançado que não é Error', () => {
    expect(describeError('só uma string').errorName).toBe('NonError');
    expect(describeError(undefined).errorName).toBe('NonError');
    expect(describeError(null).message).toBe('');
  });

  it('não esconde o erro: ele continua na mensagem do evento', () => {
    const { logger, events } = recorder();
    const described = describeError(new RangeError('índice fora do intervalo'));

    logger.error({
      eventType: 'app.uncaught_exception',
      phase: 'shutdown',
      message: `falha fatal: ${described.message}`,
      fields: { errorName: described.errorName, exitCode: 1 },
    });

    const [event] = events();
    expect(event.message).toContain('índice fora do intervalo');
    expect(event.errorName).toBe('RangeError');
    expect(event.exitCode).toBe(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Ciclo de vida do processo                                                  */
/* ------------------------------------------------------------------------- */

describe('eventos de startup e shutdown', () => {
  /** Processo falso: registra os handlers e nunca sai de verdade. */
  function fakeProcess() {
    const handlers = new Map();
    const exits = [];
    return {
      on: (event, handler) => handlers.set(event, handler),
      exit: (code) => exits.push(code),
      emit: (event, payload) => handlers.get(event)?.(payload),
      has: (event) => handlers.has(event),
      exits,
    };
  }

  /** Servidor falso: `listen` chama o callback na hora, sem abrir porta. */
  function fakeApp() {
    return {
      locals: { frontend: { mounted: true } },
      listen: (_port, ready) => {
        ready();
        return { close: (done) => done() };
      },
    };
  }

  it('emite app.starting e app.started, nessa ordem', () => {
    const { logger, events } = recorder();

    startServer({
      port: 8080,
      log: logger,
      processRef: fakeProcess(),
      createServer: fakeApp,
    });

    const emitted = events();
    expect(emitted[0].eventType).toBe('app.starting');
    expect(emitted[0].phase).toBe('startup');
    expect(emitted[0].port).toBe(8080);

    expect(emitted[1].eventType).toBe('app.started');
    expect(emitted[1].port).toBe(8080);
    expect(emitted[1].frontendMounted).toBe(true);
  });

  it('registra o sinal recebido e encerra com código 0', () => {
    const { logger, events } = recorder();
    const proc = fakeProcess();

    startServer({ port: 8080, log: logger, processRef: proc, createServer: fakeApp });
    proc.emit('SIGTERM');

    const shutdown = events().find((event) => event.eventType === 'app.shutdown.requested');
    expect(shutdown.signal).toBe('SIGTERM');
    expect(shutdown.phase).toBe('shutdown');
    expect(proc.exits).toEqual([0]);
  });

  it('trata SIGINT do mesmo jeito', () => {
    const { logger, events } = recorder();
    const proc = fakeProcess();

    startServer({ port: 8080, log: logger, processRef: proc, createServer: fakeApp });
    proc.emit('SIGINT');

    expect(events().find((event) => event.eventType === 'app.shutdown.requested').signal).toBe('SIGINT');
  });

  it('encerra com código diferente de zero em exceção não capturada', () => {
    const { logger, events } = recorder();
    const proc = fakeProcess();

    startServer({ port: 8080, log: logger, processRef: proc, createServer: fakeApp });
    proc.emit('uncaughtException', new Error('estado corrompido'));

    const fatal = events().find((event) => event.eventType === 'app.uncaught_exception');
    expect(fatal.level).toBe('error');
    expect(fatal.message).toContain('estado corrompido');
    expect(fatal.exitCode).toBe(1);
    // Não transformar exceção fatal em continuidade silenciosa.
    expect(proc.exits).toEqual([1]);
  });

  it('trata rejeição não tratada como falha fatal', () => {
    const { logger, events } = recorder();
    const proc = fakeProcess();

    startServer({ port: 8080, log: logger, processRef: proc, createServer: fakeApp });
    proc.emit('unhandledRejection', new Error('promise solta'));

    const fatal = events().find((event) => event.eventType === 'app.unhandled_rejection');
    expect(fatal.level).toBe('error');
    expect(proc.exits).toEqual([1]);
  });

  it('registra os quatro manipuladores de ciclo de vida', () => {
    const { logger } = recorder();
    const proc = fakeProcess();

    startServer({ log: logger, processRef: proc, createServer: fakeApp });

    for (const signal of ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection']) {
      expect(proc.has(signal), `handler ausente: ${signal}`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Eventos HTTP                                                               */
/* ------------------------------------------------------------------------- */

describe('eventos HTTP 2xx, 4xx e 5xx', () => {
  /** Aplicação mínima com rotas que devolvem cada família de status. */
  function appWith(logger) {
    const app = express();
    app.use(requestId);
    app.use(createRequestLogger({ log: logger }));
    app.use('/api/health', createHealthRouter({ log: logger }));
    app.use('/api/report', createReportRouter({ log: logger }));
    app.get('/api/quebrado', () => {
      throw new Error('falha interna com token sk-proj-naodeveaparecer123');
    });
    app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
    app.use(errorHandler);
    return app;
  }

  it('registra 200 como info, com requestId, path, statusCode e durationMs', async () => {
    const { logger, events } = recorder();
    const response = await request(appWith(logger)).get('/api/report');

    expect(response.status).toBe(200);

    const http = events().find((event) => event.eventType === 'http.request.completed');
    expect(http.level).toBe('info');
    expect(http.statusCode).toBe(200);
    expect(http.method).toBe('GET');
    expect(http.path).toBe('/api/report');
    expect(http.phase).toBe('functional');
    expect(typeof http.durationMs).toBe('number');
    expect(http.requestId).toEqual(expect.any(String));
    expect(http.commitSha).toBe('9f3ac21aa0d4c7e1b2');
  });

  it('registra 404 como warn', async () => {
    const { logger, events } = recorder();
    await request(appWith(logger)).get('/api/rota-que-nao-existe');

    const http = events().find((event) => event.eventType === 'http.request.completed');
    expect(http.level).toBe('warn');
    expect(http.statusCode).toBe(404);
  });

  it('registra 500 como error, sem vazar o segredo da mensagem', async () => {
    const { logger, events, lines } = recorder();
    await request(appWith(logger)).get('/api/quebrado');

    const http = events().find((event) => event.eventType === 'http.request.completed');
    expect(http.level).toBe('error');
    expect(http.statusCode).toBe(500);
    expect(lines.join('')).not.toContain('sk-proj-naodeveaparecer123');
  });

  it('emite health.check.completed além da linha de requisição', async () => {
    const { logger, events } = recorder();
    await request(appWith(logger)).get('/api/health');

    const health = events().find((event) => event.eventType === 'health.check.completed');
    expect(health.phase).toBe('healthcheck');
    expect(health.healthStatus).toBe('ok');
    expect(health.statusCode).toBe(200);
  });

  it('emite functional.report.completed na rota funcional', async () => {
    const { logger, events } = recorder();
    await request(appWith(logger)).get('/api/report');

    const functional = events().find((event) => event.eventType === 'functional.report.completed');
    expect(functional.phase).toBe('functional');
    expect(functional.functionalArea).toBe('report');
  });

  it('emite functional.report.failed quando a regra de negócio quebra', async () => {
    const { logger, events, lines } = recorder();

    const app = express();
    app.use(requestId);
    app.use(createRequestLogger({ log: logger }));
    app.use(
      '/api/report',
      createReportRouter({
        log: logger,
        build: () => {
          throw new TypeError('duplicateCopies recebeu undefined (senha=hunter2)');
        },
      }),
    );
    app.use(errorHandler);

    const response = await request(app).get('/api/report');

    // Processo vivo, funcionalidade quebrada — a distinção do cenário 2.
    expect(response.status).toBe(500);

    const failed = events().find((event) => event.eventType === 'functional.report.failed');
    expect(failed.level).toBe('error');
    expect(failed.phase).toBe('functional');
    expect(failed.functionalArea).toBe('report');
    expect(failed.errorName).toBe('TypeError');
    expect(failed.message).toContain('duplicateCopies recebeu undefined');
    expect(lines.join('')).not.toContain('hunter2');

    // E o erro não foi engolido: o middleware de erro respondeu o 500 padrão.
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('nunca registra Authorization, Cookie nem corpo da requisição', async () => {
    const { logger, lines } = recorder();

    await request(appWith(logger))
      .get('/api/report?access_token=abc123secreto')
      .set('Authorization', 'Bearer ghp_abcdefghijklmnop1234567890')
      .set('Cookie', 'session=valor-super-secreto');

    const output = lines.join('');
    expect(output).not.toContain('ghp_abcdefghijklmnop1234567890');
    expect(output).not.toContain('valor-super-secreto');
    expect(output).not.toContain('Bearer ');
  });
});

/* ------------------------------------------------------------------------- */
/* Compatibilidade                                                            */
/* ------------------------------------------------------------------------- */

describe('compatibilidade com a aplicação real', () => {
  it('createApp continua montando as rotas e o log padrão não quebra nada', async () => {
    const app = createApp({ serveFrontend: false });

    const [health, report] = await Promise.all([
      request(app).get('/api/health'),
      request(app).get('/api/report'),
    ]);

    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(report.status).toBe(200);
    expect(typeof report.body.totalRegistered).toBe('number');
  });
});
