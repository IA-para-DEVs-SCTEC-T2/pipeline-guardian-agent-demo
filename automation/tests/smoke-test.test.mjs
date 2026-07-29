import { describe, expect, it } from 'vitest';

import {
  describeBody,
  evaluateFunctionalResponse,
  evaluateHealthResponse,
  formatAttemptLine,
  HEALTH_PATH,
  readSmokeConfig,
  runCheck,
  runSmokeTest,
  SMOKE_DEFAULTS,
  VERDICT_PREFIX,
} from '../src/smoke-test.mjs';

const BASE = { APP_BASE_URL: 'https://copa.exemplo.dev' };

/** Sem espera real: os testes não podem depender do relógio. */
const noSleep = async () => {};

/**
 * `fetch` falso, roteirizado por resposta. Cada item é `{ status, body }` ou
 * `{ error }`; a última resposta se repete se as tentativas continuarem.
 */
function scriptedFetch(script) {
  let index = 0;
  return async () => {
    const step = script[Math.min(index, script.length - 1)];
    index += 1;

    if (step.error) {
      const error = new Error('falha de rede');
      error.cause = { code: step.error };
      throw error;
    }

    return {
      status: step.status,
      text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {})),
    };
  };
}

const HEALTHY = { status: 200, body: { status: 'ok', version: '1.0.0', commitSha: 'abc1234' } };
const REPORT_OK = { status: 200, body: { totalRegistered: 12 } };

/* ------------------------------------------------------------------------- */
/* Configuração                                                               */
/* ------------------------------------------------------------------------- */

describe('readSmokeConfig', () => {
  it('exige APP_BASE_URL', () => {
    expect(() => readSmokeConfig({})).toThrow(/APP_BASE_URL não configurada/i);
  });

  it('recusa URL malformada ou com esquema não HTTP', () => {
    expect(() => readSmokeConfig({ APP_BASE_URL: 'copa.exemplo.dev' })).toThrow(/inválida/i);
    expect(() => readSmokeConfig({ APP_BASE_URL: 'ftp://copa.exemplo.dev' })).toThrow(/http ou https/i);
  });

  it('aplica os padrões da aula e remove a barra final', () => {
    const config = readSmokeConfig({ APP_BASE_URL: 'https://copa.exemplo.dev/' });

    expect(config.baseUrl).toBe('https://copa.exemplo.dev');
    expect(config.host).toBe('copa.exemplo.dev');
    expect(config.maxAttempts).toBe(SMOKE_DEFAULTS.maxAttempts);
    expect(config.intervalSeconds).toBe(SMOKE_DEFAULTS.intervalSeconds);
  });

  it('aceita sobrescrita numérica e ignora valores inválidos', () => {
    const config = readSmokeConfig({ ...BASE, SMOKE_MAX_ATTEMPTS: '5', SMOKE_INTERVAL_SECONDS: 'dez' });

    expect(config.maxAttempts).toBe(5);
    expect(config.intervalSeconds).toBe(SMOKE_DEFAULTS.intervalSeconds);
  });
});

/* ------------------------------------------------------------------------- */
/* Avaliação das respostas                                                    */
/* ------------------------------------------------------------------------- */

describe('evaluateHealthResponse', () => {
  it('aprova 200 com status ok', () => {
    expect(evaluateHealthResponse(HEALTHY).ok).toBe(true);
  });

  it('reprova código diferente de 200 e preserva o corpo no motivo', () => {
    const verdict = evaluateHealthResponse({
      status: 503,
      body: { status: 'degraded', reason: 'warmup pending' },
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.retryable).toBe(true);
    expect(verdict.reason).toContain('esperado 200');
    expect(verdict.reason).toContain('warmup pending');
  });

  it('reprova 200 com status diferente de ok', () => {
    const verdict = evaluateHealthResponse({ status: 200, body: { status: 'degraded' } });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('status="degraded"');
  });

  it('reprova corpo que não é JSON e registra o texto recebido', () => {
    const verdict = evaluateHealthResponse({
      status: 502,
      body: null,
      raw: 'Application failed to respond',
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('Application failed to respond');
  });

  it('espera a nova versão quando o commit esperado é informado', () => {
    const stale = evaluateHealthResponse({ ...HEALTHY, expectedCommitSha: 'def5678' });
    expect(stale.ok).toBe(false);
    expect(stale.retryable).toBe(true);
    expect(stale.reason).toMatch(/versão antiga no ar/i);

    const fresh = evaluateHealthResponse({ ...HEALTHY, expectedCommitSha: 'abc1234ffff' });
    expect(fresh.ok).toBe(true);
  });

  it('aceita quando a aplicação não sabe informar o commit', () => {
    const verdict = evaluateHealthResponse({
      status: 200,
      body: { status: 'ok', commitSha: 'unknown' },
      expectedCommitSha: 'abc1234',
    });

    expect(verdict.ok).toBe(true);
  });
});

describe('evaluateFunctionalResponse', () => {
  it('aprova o relatório com totalRegistered', () => {
    const verdict = evaluateFunctionalResponse(REPORT_OK);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain('totalRegistered=12');
  });

  it('não repete tentativa quando o contrato da resposta está errado', () => {
    const verdict = evaluateFunctionalResponse({ status: 200, body: { algoOutro: true } });

    expect(verdict.ok).toBe(false);
    expect(verdict.retryable).toBe(false);
  });
});

describe('describeBody', () => {
  it('trunca corpos longos', () => {
    const long = describeBody(null, 'x'.repeat(500));
    expect(long.length).toBeLessThan(220);
    expect(long).toContain('…');
  });

  it('devolve vazio quando não há corpo', () => {
    expect(describeBody(null, '')).toBe('');
  });
});

/* ------------------------------------------------------------------------- */
/* Execução                                                                   */
/* ------------------------------------------------------------------------- */

describe('formatAttemptLine', () => {
  it('registra tentativa, rota e resultado', () => {
    const line = formatAttemptLine({
      attempt: 3,
      maxAttempts: 30,
      path: HEALTH_PATH,
      outcome: 'HTTP 503 — esperado 200',
      elapsedMs: 94.4,
    });

    expect(line).toBe('tentativa 3/30 GET /api/health -> HTTP 503 — esperado 200 em 94ms');
  });
});

describe('runCheck', () => {
  it('repete até o limite e registra cada tentativa', async () => {
    const lines = [];
    const config = readSmokeConfig({ ...BASE, SMOKE_MAX_ATTEMPTS: '4' });

    const result = await runCheck({
      name: 'health check',
      path: HEALTH_PATH,
      config,
      evaluate: evaluateHealthResponse,
      log: (line) => lines.push(line),
      fetchImpl: scriptedFetch([{ error: 'ECONNREFUSED' }]),
      sleep: noSleep,
    });

    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(4);
    expect(lines.filter((line) => line.startsWith('tentativa'))).toHaveLength(4);
    expect(lines.at(-1)).toMatch(/reprovado após 4 tentativas/);
  });

  it('para na primeira tentativa bem-sucedida', async () => {
    const lines = [];
    const config = readSmokeConfig({ ...BASE, SMOKE_MAX_ATTEMPTS: '10' });

    const result = await runCheck({
      name: 'health check',
      path: HEALTH_PATH,
      config,
      evaluate: evaluateHealthResponse,
      log: (line) => lines.push(line),
      fetchImpl: scriptedFetch([{ error: 'ECONNREFUSED' }, { status: 502, body: 'Application failed to respond' }, HEALTHY]),
      sleep: noSleep,
    });

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(3);
  });
});

describe('runSmokeTest', () => {
  const config = readSmokeConfig({ ...BASE, SMOKE_MAX_ATTEMPTS: '3' });

  it('aprova quando health e rota funcional respondem', async () => {
    const { result, logText } = await runSmokeTest({
      config,
      fetchImpl: scriptedFetch([HEALTHY, REPORT_OK]),
      sleep: noSleep,
    });

    expect(result.status).toBe('success');
    expect(result.checks.health.passed).toBe(true);
    expect(result.checks.functional.passed).toBe(true);
    expect(logText).toContain(`${VERDICT_PREFIX} PASS`);
  });

  it('reprova e não executa a rota funcional quando o health check falha', async () => {
    const { result, logText } = await runSmokeTest({
      config,
      fetchImpl: scriptedFetch([{ status: 503, body: { status: 'degraded' } }]),
      sleep: noSleep,
    });

    expect(result.status).toBe('failure');
    expect(result.checks.functional.passed).toBe(false);
    expect(logText).toContain('rota funcional: não executada');
    expect(logText).toContain(`${VERDICT_PREFIX} FAIL`);
  });

  it('é determinístico: a mesma sequência de respostas produz o mesmo veredito', async () => {
    const script = [{ error: 'ECONNREFUSED' }, { status: 503, body: { status: 'degraded' } }];

    const first = await runSmokeTest({ config, fetchImpl: scriptedFetch(script), sleep: noSleep });
    const second = await runSmokeTest({ config, fetchImpl: scriptedFetch(script), sleep: noSleep });

    expect(first.result.status).toBe(second.result.status);
    expect(first.result.checks.health.attempts).toBe(second.result.checks.health.attempts);
  });

  it('mascara segredo antes de o log ir para o disco', async () => {
    const { logText } = await runSmokeTest({
      config,
      fetchImpl: scriptedFetch([
        { status: 500, body: { erro: 'authorization: Bearer ghp_abcdefghij1234567890' } },
      ]),
      sleep: noSleep,
    });

    expect(logText).not.toContain('ghp_abcdefghij1234567890');
    expect(logText).toContain('[REDACTED]');
  });
});
