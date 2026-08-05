import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { summarizeSamples } from '../src/day2/observe.mjs';
import {
  DEMO_ANOMALY_ENV_VAR,
  SCENARIOS,
  SCENARIO_MODES,
  parseArgs,
  resolveScenario,
  runScenario,
} from '../src/day2/scenario.mjs';

/* ------------------------------------------------------------------------- */
/* Cenário                                                                    */
/* ------------------------------------------------------------------------- */

/** A mesma baseline que uma máquina saudável produz: milissegundos de latência. */
const BASELINE = {
  sampleCount: 30,
  latencyP95Ms: 5.26,
  errorRate: 0,
  logLinesPerRequest: 2,
  responseSizeP95Bytes: 1968,
  createdAt: '2026-08-05T13:13:02.284Z',
  commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const FAST_MS = 4.9;
const SLOW_MS = 505.4;

/**
 * Trinta amostras com o efeito que `backend/src/demo-anomalies.js` produz: uma
 * requisição em cada três espera 500 ms, e é ela que carrega a linha de log
 * `demo.anomaly.latency` a mais.
 *
 * O `summary` sai de `summarizeSamples` — a função de verdade — para que o teste
 * verifique a conta do P95 sobre a proporção real, e não um número escolhido à
 * mão que sempre confirmaria a expectativa.
 */
function latencyObservation() {
  const samples = Array.from({ length: 30 }, (_, index) => {
    const sequence = index + 1;
    const delayed = sequence % 3 === 0;

    return {
      sequence,
      statusCode: 200,
      durationMs: delayed ? SLOW_MS : FAST_MS,
      responseSizeBytes: 1968,
      logLineCount: delayed ? 3 : 2,
      requestId: `day2-${sequence}-uuid`,
    };
  });

  return {
    samples,
    summary: summarizeSamples(samples),
    logEvents: samples.flatMap((sample) => [
      {
        schemaVersion: 1,
        time: '2026-08-05T10:00:00.000Z',
        level: 'info',
        eventType: 'functional.report.completed',
        phase: 'functional',
        message: 'relatório do álbum gerado',
        requestId: sample.requestId,
        statusCode: 200,
      },
      ...(sample.durationMs === SLOW_MS
        ? [
            {
              schemaVersion: 1,
              time: '2026-08-05T10:00:00.001Z',
              level: 'warn',
              eventType: 'demo.anomaly.latency',
              phase: 'functional',
              message: `anomalia de latência do laboratório na requisição ${sample.sequence}: 500 ms de espera antes de responder`,
              requestId: sample.requestId,
              durationMs: 500,
              statusCode: 200,
            },
          ]
        : []),
    ]),
    logCorrelation: 'request_id',
    noiseLines: [],
    warmupRequests: 5,
    startedAt: '2026-08-05T10:00:00.000Z',
    finishedAt: '2026-08-05T10:00:20.000Z',
    port: 3102,
    path: '/api/report',
    limitations: [],
  };
}

/** Corpo da resposta de erro padronizada — muito menor que o relatório. */
const ERROR_BYTES = 118;

/**
 * Trinta amostras com o efeito que o modo `error-rate` produz: uma requisição em
 * cada cinco devolve 500 no lugar do relatório, **sem** demorar mais e **sem**
 * produzir uma linha de log a mais.
 *
 * As duas ausências são o desenho do cenário, não descuido do fixture: a
 * requisição reprovada troca `functional.report.completed` por
 * `demo.anomaly.error-rate` e mantém o `http.request.completed` do
 * `requestLogger` — duas linhas, como qualquer outra. Se este fixture
 * inventasse uma terceira, o teste passaria a confirmar um comportamento que o
 * backend não tem.
 */
function errorRateObservation() {
  const samples = Array.from({ length: 30 }, (_, index) => {
    const sequence = index + 1;
    const failed = sequence % 5 === 0;

    return {
      sequence,
      statusCode: failed ? 500 : 200,
      durationMs: FAST_MS,
      responseSizeBytes: failed ? ERROR_BYTES : 1968,
      logLineCount: 2,
      requestId: `day2-${sequence}-uuid`,
    };
  });

  return {
    samples,
    summary: summarizeSamples(samples),
    logEvents: samples.flatMap((sample) =>
      sample.statusCode === 500
        ? [
            {
              schemaVersion: 1,
              time: '2026-08-05T10:00:00.001Z',
              level: 'error',
              eventType: 'demo.anomaly.error-rate',
              phase: 'functional',
              message:
                `anomalia de taxa de erro do laboratório na requisição ${sample.sequence}: ` +
                'HTTP 500 controlado no lugar do relatório',
              requestId: sample.requestId,
              statusCode: 500,
              errorName: 'DemoAnomalyError',
            },
          ]
        : [
            {
              schemaVersion: 1,
              time: '2026-08-05T10:00:00.000Z',
              level: 'info',
              eventType: 'functional.report.completed',
              phase: 'functional',
              message: 'relatório do álbum gerado',
              requestId: sample.requestId,
              statusCode: 200,
            },
          ],
    ),
    logCorrelation: 'request_id',
    noiseLines: [],
    warmupRequests: 5,
    startedAt: '2026-08-05T10:00:00.000Z',
    finishedAt: '2026-08-05T10:00:20.000Z',
    port: 3102,
    path: '/api/report',
    limitations: [],
  };
}

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'day2-scenario-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

/**
 * Roda o cenário sem processo, sem rede e sem modelo: `observe` é injetada e o
 * ambiente entregue à explicação não tem chave, o que força o gerador
 * determinístico.
 */
async function run({ mode = 'latency', observation = latencyObservation(), outDir = tempDir() } = {}) {
  const calls = [];

  const result = await runScenario({
    mode,
    baseline: BASELINE,
    outDir,
    env: {},
    observe: async (input) => {
      calls.push(input);
      return observation;
    },
    now: () => new Date('2026-08-05T13:30:00.000Z'),
  });

  return { ...result, calls, outDir };
}

/* ------------------------------------------------------------------------- */
/* Cenários disponíveis                                                       */
/* ------------------------------------------------------------------------- */

describe('resolveScenario', () => {
  it('conhece os cenários que o backend sabe provocar', () => {
    expect(SCENARIO_MODES).toEqual(['latency', 'error-rate']);
    expect(SCENARIOS.latency.expectedSignal).toBe('latencyP95Ms');
    expect(SCENARIOS['error-rate'].expectedSignal).toBe('errorRate');
  });

  it('mantém o modo do laboratório separado do tipo publicado pelo detector', () => {
    // `error-rate` é o que vai para `DEMO_ANOMALY_MODE`; `error_rate` é o que o
    // `detect.mjs` publica. São dois vocabulários, e o cenário não renomeia
    // regra de detector para ficar parecido consigo mesmo.
    expect(SCENARIOS['error-rate'].envValue).toBe('error-rate');
    expect(SCENARIOS['error-rate'].expectedAnomalyType).toBe('error_rate');
  });

  it('aceita o modo com espaço e caixa diferentes', () => {
    expect(resolveScenario(' Latency ').mode).toBe('latency');
    expect(resolveScenario(' Error-Rate ').mode).toBe('error-rate');
  });

  it('recusa um modo desconhecido dizendo o que existe', () => {
    expect(() => resolveScenario('payload')).toThrow(/desconhecido.*latency, error-rate/s);
    expect(() => resolveScenario('')).toThrow(/day2:scenario -- latency/);
    // O sublinhado do detector não é um modo do laboratório.
    expect(() => resolveScenario('error_rate')).toThrow(/desconhecido/);
  });
});

describe('parseArgs', () => {
  it('lê o modo posicional e as opções', () => {
    const options = parseArgs(['latency', '--port', '3199', '--requests', '12']);
    expect(options.mode).toBe('latency');
    expect(options.port).toBe(3199);
    expect(options.requests).toBe(12);
  });

  it('deixa o modo vazio quando não foi informado', () => {
    expect(parseArgs([]).mode).toBe('');
  });
});

/* ------------------------------------------------------------------------- */
/* Execução                                                                   */
/* ------------------------------------------------------------------------- */

describe('runScenario: latência intermitente', () => {
  it('entrega `DEMO_ANOMALY_MODE=latency` ao backend observado', async () => {
    const { calls } = await run();

    expect(calls).toHaveLength(1);
    expect(calls[0].env).toEqual({ [DEMO_ANOMALY_ENV_VAR]: 'latency' });
  });

  it('detecta a anomalia com `latencyP95Ms` como primeiro sinal', async () => {
    const { detection, reproduced } = await run();

    expect(detection.anomalyDetected).toBe(true);
    expect(detection.gateResult).toBe('anomaly');
    expect(detection.firstAnomalousSignal).toBe('latencyP95Ms');
    expect(detection.anomalyTypes).toEqual(['latency']);
    expect(reproduced).toBe(true);
  });

  it('move o P95 com uma requisição lenta em cada três, e só o P95', async () => {
    const { report } = await run();

    // Com 30 amostras o P95 cai no índice 28 da lista ordenada — dentro do
    // terço lento. É essa conta que faz a proporção de 1 em 3 ser suficiente.
    expect(report.observed.latencyP95Ms).toBe(SLOW_MS);
    expect(report.observed.errorRate).toBe(0);
    expect(report.observed.responseSizeP95Bytes).toBe(1968);

    // A linha de log a mais existe (2 → 2.33) e **não** dispara o sinal de
    // volume: um cenário de latência que também acusasse ruído de log estaria
    // ensinando a ler duas anomalias onde há uma.
    expect(report.observed.logLinesPerRequest).toBe(2.33);
    const logVolume = detectionOf(report, 'logLinesPerRequest');
    expect(logVolume.triggered).toBe(false);
  });

  it('todas as trinta requisições continuam em 200', async () => {
    const { report } = await run();

    expect(report.samples).toHaveLength(30);
    expect(report.samples.every((sample) => sample.statusCode === 200)).toBe(true);
    expect(report.observed.errorRate).toBe(0);
  });

  it('publica JSON, Markdown e painel HTML no diretório pedido', async () => {
    const { paths, outDir } = await run();

    expect(paths.jsonPath).toBe(join(outDir, 'anomaly-report.json'));
    expect(paths.markdownPath).toBe(join(outDir, 'anomaly-report.md'));
    expect(paths.htmlPath).toBe(join(outDir, 'anomaly-report.html'));

    const written = JSON.parse(readFileSync(paths.jsonPath, 'utf8'));
    expect(written.detection.firstAnomalousSignal).toBe('latencyP95Ms');
    expect(written.scope).toBe('day-2-anomaly-lab');

    const html = readFileSync(paths.htmlPath, 'utf8');
    expect(html).toContain('<!doctype html>');

    // Sem chave no ambiente, a explicação é a determinística — nenhuma chamada
    // de rede acontece nos testes.
    expect(written.usedFallback).toBe(true);
    expect(written.explanation.summary.length).toBeGreaterThan(0);
  });
});

describe('runScenario: erro intermitente', () => {
  const runErrorRate = (extra = {}) =>
    run({ mode: 'error-rate', observation: errorRateObservation(), ...extra });

  it('entrega `DEMO_ANOMALY_MODE=error-rate` ao backend observado', async () => {
    const { calls } = await runErrorRate();

    expect(calls).toHaveLength(1);
    expect(calls[0].env).toEqual({ [DEMO_ANOMALY_ENV_VAR]: 'error-rate' });
  });

  it('detecta a anomalia com `errorRate` como primeiro sinal', async () => {
    const { detection, reproduced } = await runErrorRate();

    expect(detection.anomalyDetected).toBe(true);
    expect(detection.gateResult).toBe('anomaly');
    expect(detection.firstAnomalousSignal).toBe('errorRate');
    expect(detection.anomalyTypes).toEqual(['error_rate']);
    expect(reproduced).toBe(true);
  });

  it('move `errorRate` para 20%, e só ele', async () => {
    const { report } = await runErrorRate();

    // Seis falhas em trinta requisições: passa em `observado ≥ 0,15` e em
    // `observado − baseline ≥ 0,10` sobre uma baseline saudável (`0`).
    expect(report.observed.errorRate).toBe(0.2);
    expect(report.baseline.errorRate).toBe(0);

    // O 500 não demora e não fala: os outros três sinais ficam onde estavam.
    expect(report.observed.latencyP95Ms).toBe(FAST_MS);
    expect(report.observed.logLinesPerRequest).toBe(2);
    expect(report.observed.responseSizeP95Bytes).toBe(1968);

    for (const signal of ['latencyP95Ms', 'logLinesPerRequest', 'responseSizeP95Bytes']) {
      expect(detectionOf(report, signal).triggered).toBe(false);
    }
  });

  it('mantém o P95 de resposta no corpo do relatório, não no corpo do erro', async () => {
    const { report } = await runErrorRate();

    // A resposta de erro é pequena, e com 30 amostras o P95 cai no índice 28 da
    // lista ordenada — bem acima das seis menores. Um cenário de erro que
    // também derrubasse `responseSizeP95Bytes` estaria movendo dois sinais.
    const failed = report.samples.filter((sample) => sample.statusCode === 500);
    expect(failed).toHaveLength(6);
    expect(failed.every((sample) => sample.responseSizeBytes === ERROR_BYTES)).toBe(true);
    expect(report.observed.responseSizeP95Bytes).toBe(1968);
  });

  it('publica o painel com o sinal de erro como primeiro', async () => {
    const { paths, outDir } = await runErrorRate();

    expect(paths.jsonPath).toBe(join(outDir, 'anomaly-report.json'));

    const written = JSON.parse(readFileSync(paths.jsonPath, 'utf8'));
    expect(written.detection.firstAnomalousSignal).toBe('errorRate');
    expect(written.detection.anomalyTypes).toEqual(['error_rate']);
    expect(written.scope).toBe('day-2-anomaly-lab');

    const html = readFileSync(paths.htmlPath, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Taxa de erro');

    // Sem chave no ambiente, a explicação é a determinística — nenhuma chamada
    // de rede acontece nos testes.
    expect(written.usedFallback).toBe(true);
    expect(written.explanation.summary.length).toBeGreaterThan(0);
  });
});

function detectionOf(report, signal) {
  return report.detection.evaluations.find((evaluation) => evaluation.signal === signal);
}
