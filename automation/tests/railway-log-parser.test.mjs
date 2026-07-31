import { describe, expect, it } from 'vitest';

import {
  fromJsonl,
  normalizeTimestamp,
  parseRailwayLogLine,
  parseRailwayLogStream,
  toJsonl,
} from '../src/railway-log-parser.mjs';

describe('linhas JSON da Railway CLI', () => {
  it('lê timestamp, mensagem e severidade', () => {
    const event = parseRailwayLogLine(
      JSON.stringify({ timestamp: '2026-07-30T13:00:41.900Z', severity: 'info', message: 'Build succeeded' }),
    );

    expect(event.timestamp).toBe('2026-07-30T13:00:41.900Z');
    expect(event.level).toBe('info');
    expect(event.message).toBe('Build succeeded');
    expect(event.structured).toBe(true);
  });

  it('aceita os nomes alternativos já vistos na CLI', () => {
    const event = parseRailwayLogLine(JSON.stringify({ ts: 1785502841900, msg: 'deploy ok', level: 'INFO' }));

    expect(event.message).toBe('deploy ok');
    expect(event.level).toBe('info');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserva eventType e requestId do contrato da aplicação', () => {
    const inner = {
      schemaVersion: 1,
      time: '2026-07-30T15:21:04.502Z',
      level: 'error',
      eventType: 'functional.report.failed',
      phase: 'functional',
      message: 'falha ao gerar o relatório',
      requestId: 'a47f0b93-2d18-4c6e-95a1-08b7e3f2c604',
    };

    const event = parseRailwayLogLine(JSON.stringify(inner));

    expect(event.eventType).toBe('functional.report.failed');
    expect(event.requestId).toBe('a47f0b93-2d18-4c6e-95a1-08b7e3f2c604');
    expect(event.level).toBe('error');
    expect(event.timestamp).toBe('2026-07-30T15:21:04.502Z');
  });

  it('lê JSON da aplicação prefixado por timestamp da plataforma', () => {
    const inner = JSON.stringify({ eventType: 'app.started', message: 'ouvindo na porta 8080', level: 'info' });
    const event = parseRailwayLogLine(`2026-07-30T13:00:45.902Z ${inner}`);

    expect(event.eventType).toBe('app.started');
    expect(event.message).toBe('ouvindo na porta 8080');
    // O timestamp externo é usado quando o interno não existe.
    expect(event.timestamp).toBe('2026-07-30T13:00:45.902Z');
  });
});

describe('linhas não estruturadas', () => {
  it('extrai o timestamp do início da linha', () => {
    const event = parseRailwayLogLine('[2026-07-30T13:00:04.480Z] #5 [deps 4/6] RUN npm ci');

    expect(event.timestamp).toBe('2026-07-30T13:00:04.480Z');
    expect(event.message).toBe('#5 [deps 4/6] RUN npm ci');
    expect(event.structured).toBe(false);
  });

  it('não fabrica timestamp quando a linha não tem hora', () => {
    const event = parseRailwayLogLine('npm ERR! code ELIFECYCLE');

    expect(event.timestamp).toBeNull();
    expect(event.level).toBe('error');
    expect(event.message).toBe('npm ERR! code ELIFECYCLE');
  });

  it('deriva a severidade de marcadores no texto', () => {
    expect(parseRailwayLogLine('Build succeeded').level).toBe('info');
    expect(parseRailwayLogLine('deprecated package foo@1.0').level).toBe('warn');
    expect(parseRailwayLogLine('FATAL: container exited').level).toBe('error');
  });

  it('ignora linha vazia', () => {
    expect(parseRailwayLogLine('')).toBeNull();
    expect(parseRailwayLogLine('   ')).toBeNull();
  });

  it('não quebra com JSON malformado', () => {
    const event = parseRailwayLogLine('{"message": "sem fechar');
    expect(event.structured).toBe(false);
    expect(event.message).toBe('{"message": "sem fechar');
  });
});

describe('normalizeTimestamp', () => {
  it('aceita ISO, epoch em segundos, milissegundos e nanossegundos', () => {
    expect(normalizeTimestamp('2026-07-30T13:00:00.000Z')).toBe('2026-07-30T13:00:00.000Z');
    expect(normalizeTimestamp('1785502800')).toMatch(/^\d{4}-/);
    expect(normalizeTimestamp('1785502800000')).toMatch(/^\d{4}-/);
    expect(normalizeTimestamp('1785502800000000000')).toMatch(/^\d{4}-/);
  });

  it('devolve null para o que não é data — nunca "agora"', () => {
    expect(normalizeTimestamp('nunca')).toBeNull();
    expect(normalizeTimestamp('')).toBeNull();
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeTimestamp(undefined)).toBeNull();
  });
});

describe('parseRailwayLogStream', () => {
  it('respeita o limite de linhas e preserva as últimas', () => {
    const text = Array.from({ length: 500 }, (_, index) => `linha ${index}`).join('\n');
    const { events, truncated, totalLines } = parseRailwayLogStream(text, { maxLines: 300 });

    expect(totalLines).toBe(500);
    expect(events).toHaveLength(300);
    expect(truncated).toBe(true);
    // O que interessa num log de runtime é o fim.
    expect(events.at(-1).message).toBe('linha 499');
    expect(events[0].message).toBe('linha 200');
  });

  it('não marca truncamento quando cabe no limite', () => {
    const { events, truncated } = parseRailwayLogStream('a\nb\nc', { maxLines: 300 });
    expect(events).toHaveLength(3);
    expect(truncated).toBe(false);
  });

  it('remove ANSI e caracteres de controle antes de parsear', () => {
    const { events } = parseRailwayLogStream('[32mBuild succeeded[0m');
    expect(events[0].message).toBe('Build succeeded');
  });
});

describe('JSONL de ida e volta', () => {
  it('serializa e lê de volta sem perder campo', () => {
    const { events } = parseRailwayLogStream('[2026-07-30T13:00:00.000Z] Build succeeded');
    const restored = fromJsonl(toJsonl(events));

    expect(restored).toHaveLength(1);
    expect(restored[0].message).toBe('Build succeeded');
    expect(restored[0].timestamp).toBe('2026-07-30T13:00:00.000Z');
  });

  it('descarta linha corrompida em vez de derrubar a leitura', () => {
    const restored = fromJsonl('{"message":"ok"}\n{"quebrad\n{"message":"tambem ok"}');
    expect(restored.map((event) => event.message)).toEqual(['ok', 'tambem ok']);
  });

  it('devolve string vazia para lista vazia', () => {
    expect(toJsonl([])).toBe('');
    expect(fromJsonl('')).toEqual([]);
  });
});
