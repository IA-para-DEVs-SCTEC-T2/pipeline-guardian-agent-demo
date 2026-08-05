import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectAnomalies } from '../src/day2/detect.mjs';
import {
  EXPLANATION_FIELDS,
  buildAnomalyEvidence,
  explainAnomaly,
  pickExplanationFields,
} from '../src/day2/explain.mjs';
import { renderAnomalyHtml, renderAnomalyMarkdown } from '../src/day2/report.mjs';
import { BASELINE_PATH, parseArgs, readBaseline, runCheck } from '../src/day2/run.mjs';

/* ------------------------------------------------------------------------- */
/* Cenário                                                                    */
/* ------------------------------------------------------------------------- */

const BASELINE = {
  sampleCount: 30,
  latencyP95Ms: 8,
  errorRate: 0,
  logLinesPerRequest: 2,
  responseSizeP95Bytes: 3820,
  createdAt: '2026-08-01T12:00:00.000Z',
  commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const NO_MODEL_ENV = {};
/** Só a chave: `OPENAI_MODEL` é opcional e o padrão vive em `openai-config.mjs`. */
const MODEL_ENV = { OPENAI_API_KEY: 'sk-test-0123456789abcdef' };

/**
 * Observação falsa, com a mesma forma que `observeApplication` devolve.
 *
 * @param {object} [input]
 */
function fakeObservation({ durationMs = 4, responseSizeBytes = 3820, statusCode = 200, logMessage = 'GET /api/report 200', logLevel = 'info' } = {}) {
  const samples = Array.from({ length: 30 }, (_, index) => ({
    sequence: index + 1,
    statusCode,
    durationMs,
    responseSizeBytes,
    logLineCount: 2,
    requestId: `day2-${index + 1}-uuid`,
  }));

  const logEvents = samples.flatMap((sample) => [
    {
      schemaVersion: 1,
      time: '2026-08-05T10:00:00.000Z',
      level: logLevel,
      eventType: 'functional.report.completed',
      phase: 'functional',
      message: logMessage,
      requestId: sample.requestId,
      statusCode,
    },
    {
      schemaVersion: 1,
      time: '2026-08-05T10:00:00.001Z',
      level: 'info',
      eventType: 'http.request.completed',
      phase: 'functional',
      message: `GET /api/report ${statusCode}`,
      requestId: sample.requestId,
      statusCode,
      durationMs,
    },
  ]);

  return {
    samples,
    summary: {
      sampleCount: 30,
      requestCount: 30,
      latencyP95Ms: durationMs,
      errorRate: statusCode >= 400 ? 1 : 0,
      logLinesPerRequest: 2,
      responseSizeP95Bytes: responseSizeBytes,
    },
    logEvents,
    logCorrelation: 'request_id',
    noiseLines: [],
    warmupRequests: 5,
    startedAt: '2026-08-05T10:00:00.000Z',
    finishedAt: '2026-08-05T10:00:02.000Z',
    port: 3102,
    path: '/api/report',
    limitations: [],
  };
}

/** Cliente OpenAI falso: devolve o que o teste mandar, sem tocar a rede. */
function fakeClient(output, { throws = null, response = null } = {}) {
  return {
    responses: {
      parse: async () => {
        if (throws) throw throws;
        return response ?? { status: 'completed', output_parsed: output, id: 'resp_1', model: 'gpt-5-mini' };
      },
    },
  };
}

const MODEL_OUTPUT = {
  summary: 'A latência observada está muito acima da baseline.',
  evidence: [{ source: 'log:application', excerpt: 'GET /api/report 200' }],
  interpretation: 'O patamar é uniforme nas trinta requisições.',
  probableCause: 'Espera artificial introduzida na rota.',
  recommendedActions: ['Revisar a rota `GET /api/report`.'],
  limitations: ['A observação não mede concorrência.'],
};

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'day2-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** Executa o laboratório inteiro, sem subir processo nem tocar a rede. */
function check({ observation = fakeObservation(), env = NO_MODEL_ENV, client = null, baseline = BASELINE } = {}) {
  const outDir = tempDir();
  return runCheck({
    baseline,
    outDir,
    observe: async () => observation,
    env,
    client,
    commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    now: () => new Date('2026-08-05T10:00:03.000Z'),
  }).then((result) => ({ ...result, outDir }));
}

/* ------------------------------------------------------------------------- */
/* A IA não decide                                                            */
/* ------------------------------------------------------------------------- */

describe('a IA explica, não decide', () => {
  it('o veredito do modelo é ignorado: os cinco campos vêm do detector', async () => {
    // O modelo devolve os campos proibidos junto com a explicação.
    const rebelde = {
      ...MODEL_OUTPUT,
      anomalyDetected: false,
      anomalyTypes: [],
      firstAnomalousSignal: null,
      gateResult: 'pass',
      triggeredRules: [],
    };

    const { report } = await check({
      observation: fakeObservation({ durationMs: 600 }),
      env: MODEL_ENV,
      client: fakeClient(rebelde),
    });

    // O detector viu 600 ms contra uma baseline de 8 ms.
    expect(report.usedFallback).toBe(false);
    expect(report.detection.anomalyDetected).toBe(true);
    expect(report.detection.gateResult).toBe('anomaly');
    expect(report.detection.anomalyTypes).toEqual(['latency']);
    expect(report.detection.firstAnomalousSignal).toBe('latencyP95Ms');
    expect(report.detection.triggeredRules).toHaveLength(1);
  });

  it('os campos proibidos não sobrevivem na explicação publicada', async () => {
    const { report } = await check({
      observation: fakeObservation({ durationMs: 600 }),
      env: MODEL_ENV,
      client: fakeClient({ ...MODEL_OUTPUT, gateResult: 'pass', anomalyDetected: false }),
    });

    expect(Object.keys(report.explanation).sort()).toEqual([...EXPLANATION_FIELDS].sort());
    expect(report.explanation).not.toHaveProperty('gateResult');
    expect(report.explanation).not.toHaveProperty('anomalyDetected');
  });

  it('pickExplanationFields copia só os seis campos permitidos', () => {
    const picked = pickExplanationFields({
      ...MODEL_OUTPUT,
      anomalyDetected: true,
      gateResult: 'anomaly',
      triggeredRules: [{ id: 'latency' }],
      firstAnomalousSignal: 'errorRate',
      anomalyTypes: ['latency'],
      qualquerCoisa: 42,
    });

    expect(Object.keys(picked).sort()).toEqual([...EXPLANATION_FIELDS].sort());
  });

  it('o detector roda antes da chamada ao modelo', async () => {
    // Se o modelo falhar, o veredito continua exatamente o mesmo.
    const observation = fakeObservation({ durationMs: 600 });
    const comModelo = await check({ observation, env: MODEL_ENV, client: fakeClient(MODEL_OUTPUT) });
    const semModelo = await check({ observation, env: NO_MODEL_ENV });

    expect(semModelo.report.detection).toEqual(comModelo.report.detection);
    expect(semModelo.report.usedFallback).toBe(true);
    expect(comModelo.report.usedFallback).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Fallback                                                                   */
/* ------------------------------------------------------------------------- */

describe('fallback determinístico', () => {
  it('sem OPENAI_API_KEY, o relatório sai completo', async () => {
    const { report } = await check({ observation: fakeObservation({ durationMs: 600 }) });

    expect(report.usedFallback).toBe(true);
    expect(report.modelErrorCategory).toBeNull();
    expect(report.explanation.summary).toContain('Anomalia detectada');
    expect(report.explanation.interpretation.length).toBeGreaterThan(0);
    expect(report.explanation.probableCause).toContain('Hipótese');
    expect(report.explanation.recommendedActions.length).toBeGreaterThan(0);
    expect(report.limitations.join(' ')).toContain('Sem `OPENAI_API_KEY`');
  });

  it('erro do modelo vira categoria, nunca a mensagem do SDK', async () => {
    const erro = Object.assign(new Error('Incorrect API key provided: sk-segredo-de-verdade'), { status: 401 });

    const { report } = await check({
      observation: fakeObservation({ durationMs: 600 }),
      env: MODEL_ENV,
      client: fakeClient(null, { throws: erro }),
    });

    expect(report.usedFallback).toBe(true);
    expect(report.modelErrorCategory).toBe('authentication');
    expect(JSON.stringify(report)).not.toContain('Incorrect API key');
    expect(JSON.stringify(report)).not.toContain('sk-segredo-de-verdade');
  });

  it('saída fora do schema cai no fallback', async () => {
    const { report } = await check({
      observation: fakeObservation({ durationMs: 600 }),
      env: MODEL_ENV,
      client: fakeClient({ summary: 'só isso' }),
    });

    expect(report.usedFallback).toBe(true);
    expect(report.modelErrorCategory).toBe('invalid_output');
  });

  it('explainAnomaly não toca a rede sem chave', async () => {
    const detection = detectAnomalies(BASELINE, { ...BASELINE, latencyP95Ms: 600 });
    const explodir = { responses: { parse: async () => { throw new Error('não deveria ser chamado'); } } };

    const result = await explainAnomaly({
      baseline: BASELINE,
      observed: { ...BASELINE, latencyP95Ms: 600 },
      detection,
      env: NO_MODEL_ENV,
      client: explodir,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.explanation.summary).toContain('Anomalia detectada');
  });
});

/* ------------------------------------------------------------------------- */
/* Execução normal não inventa problema                                       */
/* ------------------------------------------------------------------------- */

describe('execução dentro da baseline', () => {
  it('não gera causa nem recomendação no fallback', async () => {
    const { report } = await check();

    expect(report.detection.anomalyDetected).toBe(false);
    expect(report.explanation.probableCause).toBeNull();
    expect(report.explanation.recommendedActions).toEqual([]);
  });

  it('descarta causa e recomendação vindas do modelo, e declara o descarte', async () => {
    const { report } = await check({
      env: MODEL_ENV,
      client: fakeClient({
        ...MODEL_OUTPUT,
        summary: 'Tudo dentro do esperado.',
        probableCause: 'Talvez valha a pena monitorar a latência.',
        recommendedActions: ['Considere continuar monitorando.'],
      }),
    });

    expect(report.usedFallback).toBe(false);
    expect(report.explanation.probableCause).toBeNull();
    expect(report.explanation.recommendedActions).toEqual([]);
    expect(report.limitations.join(' ')).toContain('foram descartadas');
  });
});

/* ------------------------------------------------------------------------- */
/* Evidências                                                                 */
/* ------------------------------------------------------------------------- */

describe('evidências', () => {
  it('publica no máximo cinco e prioriza o que a aplicação marcou como erro', () => {
    const observation = fakeObservation();
    const comErro = {
      ...observation,
      logEvents: [
        { level: 'info', message: 'normal 1', requestId: 'day2-1-uuid' },
        { level: 'error', message: 'falha ao gerar o relatório do álbum', requestId: 'day2-2-uuid' },
        { level: 'warn', message: 'aviso qualquer', requestId: 'day2-3-uuid' },
        ...observation.logEvents,
      ],
    };

    const evidence = buildAnomalyEvidence({ logEvents: comErro.logEvents, samples: comErro.samples });

    expect(evidence).toHaveLength(5);
    expect(evidence[0].source).toBe('log:application:error');
    expect(evidence[0].excerpt).toContain('falha ao gerar o relatório');
    expect(evidence[1].source).toBe('log:application:warn');
  });

  it('descarta citação do modelo que não existe no material coletado', async () => {
    const { report } = await check({
      observation: fakeObservation({ durationMs: 600 }),
      env: MODEL_ENV,
      client: fakeClient({
        ...MODEL_OUTPUT,
        evidence: [{ source: 'log:application', excerpt: 'ERRO CATASTRÓFICO NO BANCO DE DADOS ORACLE' }],
      }),
    });

    expect(JSON.stringify(report.evidence)).not.toContain('ORACLE');
    expect(report.limitations.join(' ')).toContain('não foram encontradas no material coletado');
  });
});

/* ------------------------------------------------------------------------- */
/* Artefatos                                                                  */
/* ------------------------------------------------------------------------- */

describe('artefatos gravados', () => {
  it('grava os três arquivos em reports/day-2', async () => {
    const { paths, outDir } = await check();

    expect(paths.jsonPath).toBe(join(outDir, 'anomaly-report.json'));
    expect(paths.markdownPath).toBe(join(outDir, 'anomaly-report.md'));
    expect(paths.htmlPath).toBe(join(outDir, 'anomaly-report.html'));

    const json = JSON.parse(readFileSync(paths.jsonPath, 'utf8'));
    expect(json.scope).toBe('day-2-anomaly-lab');
    expect(json.samples).toHaveLength(30);
    expect(json.detection.evaluations).toHaveLength(4);
  });

  it('o painel traz banner, quatro cartões, faixa, tabela e as seções obrigatórias', async () => {
    const { paths } = await check({ observation: fakeObservation({ durationMs: 600 }) });
    const html = readFileSync(paths.htmlPath, 'utf8');

    expect(html).toContain('ANOMALIA DETECTADA');

    // Quatro cartões, um por sinal, cada um com baseline, observado, diferença,
    // regra e status textual.
    for (const signal of ['latencyP95Ms', 'errorRate', 'logLinesPerRequest', 'responseSizeP95Bytes']) {
      expect(html).toContain(signal);
    }
    expect(html.match(/class="card /g)).toHaveLength(4);
    expect(html).toContain('<dt>Baseline</dt>');
    expect(html).toContain('<dt>Observado</dt>');
    expect(html).toContain('<dt>Diferença</dt>');
    expect(html).toContain('DENTRO DA BASELINE');
    expect(html).toContain('ANOMALIA DETECTADA');

    // Faixa com uma barra por requisição e a tabela correspondente.
    expect(html.match(/class="bar"/g)).toHaveLength(30);
    expect(html).toContain('id="amostra-30"');
    expect(html).toContain('title="#1 · HTTP 200 · 600,00 ms');

    // Seções 6 a 10.
    expect(html).toContain('Evidências do log');
    expect(html).toContain('Explicação');
    expect(html).toContain('Causa provável');
    expect(html).toContain('Ações recomendadas');
    expect(html).toContain('Limitações');
  });

  it('o painel é autônomo: nada de rede, nada de biblioteca de gráficos', async () => {
    const { paths } = await check();
    const html = readFileSync(paths.htmlPath, 'utf8');

    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/cdn|chart\.js|d3|plotly/i);
  });

  it('o Markdown traz o banner e a tabela dos quatro sinais', async () => {
    const { paths } = await check();
    const markdown = readFileSync(paths.markdownPath, 'utf8');

    expect(markdown).toContain('**Resultado:** NORMAL');
    expect(markdown).toContain('| Sinal | Baseline | Observado | Diferença | Regra | Status |');
    expect(markdown).toContain('O detector é determinístico.');
  });

  it('o rótulo de consumo de tokens não é mascarado no Markdown', async () => {
    // A regra `token: valor` do redator abre exceção para nome no plural com
    // valor numérico. Ver `redact-secrets.mjs`.
    const { report } = await check({
      env: MODEL_ENV,
      client: fakeClient(MODEL_OUTPUT, {
        response: {
          status: 'completed',
          output_parsed: MODEL_OUTPUT,
          id: 'resp_1',
          model: 'gpt-5-mini',
          usage: { input_tokens: 900, output_tokens: 400, total_tokens: 1300 },
        },
      }),
    });

    expect(renderAnomalyMarkdown(report)).toContain('Tokens: 1300');
  });
});

/* ------------------------------------------------------------------------- */
/* Segurança                                                                  */
/* ------------------------------------------------------------------------- */

describe('escape de HTML', () => {
  it('log com marcação não vira HTML executável', async () => {
    const { paths } = await check({
      observation: fakeObservation({ logMessage: '<script>alert(1)</script> "aspas" \'simples\'' }),
    });
    const html = readFileSync(paths.htmlPath, 'utf8');

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('texto do modelo com marcação também é escapado', async () => {
    const { report } = await check({
      observation: fakeObservation({ durationMs: 600 }),
      env: MODEL_ENV,
      client: fakeClient({
        ...MODEL_OUTPUT,
        summary: '<img src=x onerror="alert(1)">',
        recommendedActions: ['<b>negrito</b>'],
      }),
    });

    const html = renderAnomalyHtml(report);

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>negrito</b>');
    expect(html).toContain('&lt;img src&#61;x');
  });
});

describe('ausência de segredos', () => {
  it('segredo no log da aplicação é mascarado nos três artefatos', async () => {
    const { paths } = await check({
      observation: fakeObservation({
        logMessage: 'falha ao chamar serviço com OPENAI_API_KEY=sk-vazou0123456789abcdef e Authorization: Bearer abcdef0123456789',
      }),
    });

    for (const path of [paths.jsonPath, paths.markdownPath, paths.htmlPath]) {
      const content = readFileSync(path, 'utf8');
      expect(content).not.toContain('sk-vazou0123456789abcdef');
      expect(content).not.toContain('Bearer abcdef0123456789');
      expect(content).toContain('[REDACTED]');
    }
  });

  it('segredo devolvido pelo modelo é mascarado antes de chegar ao relatório', async () => {
    const { report } = await check({
      observation: fakeObservation({ durationMs: 600 }),
      env: MODEL_ENV,
      client: fakeClient({
        ...MODEL_OUTPUT,
        probableCause: 'A chave ghp_abcdefghij0123456789 aparece na configuração.',
      }),
    });

    expect(JSON.stringify(report)).not.toContain('ghp_abcdefghij0123456789');
    expect(report.explanation.probableCause).toContain('[REDACTED]');
  });

  it('a chave da OpenAI não é gravada em lugar nenhum do relatório', async () => {
    const { paths } = await check({ env: MODEL_ENV, client: fakeClient(MODEL_OUTPUT) });

    for (const path of [paths.jsonPath, paths.markdownPath, paths.htmlPath]) {
      expect(readFileSync(path, 'utf8')).not.toContain(MODEL_ENV.OPENAI_API_KEY);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

describe('CLI', () => {
  it('parseArgs distingue os dois modos e mantém o gate como opt-in', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'check', port: 3102, requests: 30, warmup: 5, failOnAnomaly: false });
    expect(parseArgs(['--baseline']).mode).toBe('baseline');
    expect(parseArgs(['--fail-on-anomaly']).failOnAnomaly).toBe(true);
    expect(parseArgs(['--port', '4000', '--requests', '10'])).toMatchObject({ port: 4000, requests: 10 });
  });

  it('a baseline padrão fica em reports/day-2', () => {
    expect(BASELINE_PATH).toMatch(/reports[/\\]day-2[/\\]baseline\.json$/);
  });

  it('baseline ausente é erro com instrução, não comparação inventada', () => {
    expect(() => readBaseline(join(tempDir(), 'nao-existe.json'))).toThrow(/npm run day2:baseline/);
  });

  it('baseline corrompida ou incompleta é recusada', () => {
    const dir = tempDir();

    const quebrada = join(dir, 'quebrada.json');
    writeFileSync(quebrada, '{ isto não é json', 'utf8');
    expect(() => readBaseline(quebrada)).toThrow(/não é JSON válido/);

    const incompleta = join(dir, 'incompleta.json');
    writeFileSync(incompleta, JSON.stringify({ latencyP95Ms: 8 }), 'utf8');
    expect(() => readBaseline(incompleta)).toThrow(/formato esperado/);
  });

  it('lê uma baseline válida', () => {
    const dir = tempDir();
    const path = join(dir, 'baseline.json');
    writeFileSync(path, JSON.stringify(BASELINE), 'utf8');

    expect(readBaseline(path)).toEqual(BASELINE);
  });
});
