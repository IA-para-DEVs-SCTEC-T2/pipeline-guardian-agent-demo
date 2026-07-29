/**
 * Smoke test pós-deployment.
 *
 * Roda DEPOIS que o Railway publicou a nova versão e responde uma pergunta
 * técnica, não interpretativa: **a aplicação que está no ar atende?**
 *
 * Três propriedades que este arquivo protege:
 *
 * 1. **É determinístico.** O veredito vem de código HTTP e do corpo da resposta.
 *    Nenhuma linha aqui chama modelo, e o resultado não depende de quem lê.
 * 2. **Espera, mas não para sempre.** Tentativas e intervalo são configuráveis
 *    (`SMOKE_MAX_ATTEMPTS`, `SMOKE_INTERVAL_SECONDS`) e sempre finitos.
 * 3. **Registra tudo o que observou.** Cada tentativa vira uma linha de
 *    `reports/deployment.log`, com código HTTP e motivo — é esse log que o
 *    diagnóstico por IA vai ler depois. Log ruim, diagnóstico ruim.
 *
 * O log é mascarado antes de ser gravado: uma `APP_BASE_URL` com credencial
 * embutida não vaza para artefato nenhum.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets, redactSecretsDeep } from './redact-secrets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

/**
 * Padrões da aula. Centralizados aqui de propósito: alterar o tempo de espera
 * durante a demonstração não deve exigir procurar número mágico em YAML.
 */
export const SMOKE_DEFAULTS = {
  maxAttempts: 30,
  intervalSeconds: 10,
  requestTimeoutMs: 10_000,
};

/** Linha final do log — é por ela que o diagnóstico reconhece o veredito. */
export const VERDICT_PREFIX = 'SMOKE TEST RESULT:';

/**
 * Rotas verificadas, na ordem. `/api/health` decide se a aplicação subiu;
 * `/api/report` confirma que ela realmente responde a uma rota funcional — um
 * processo pode estar "vivo" e mesmo assim servir só o health check.
 */
export const HEALTH_PATH = '/api/health';
export const FUNCTIONAL_PATH = '/api/report';

/**
 * Lê e valida a configuração do smoke test.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ baseUrl: string, maxAttempts: number, intervalSeconds: number,
 *             requestTimeoutMs: number, expectedCommitSha: string|null,
 *             logFile: string, resultFile: string }}
 */
export function readSmokeConfig(env = process.env) {
  const raw = (env.APP_BASE_URL ?? '').trim();

  if (!raw) {
    throw new Error(
      'APP_BASE_URL não configurada. Cadastre a URL pública da aplicação como ' +
        'variável do repositório no GitHub (Settings › Secrets and variables › Actions › Variables).',
    );
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`APP_BASE_URL inválida: "${redactSecrets(raw)}". Use uma URL completa, com esquema.`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`APP_BASE_URL precisa usar http ou https (recebido: "${parsed.protocol}").`);
  }

  return {
    baseUrl: raw.replace(/\/+$/, ''),
    host: parsed.host,
    maxAttempts: positiveInt(env.SMOKE_MAX_ATTEMPTS, SMOKE_DEFAULTS.maxAttempts),
    intervalSeconds: positiveInt(env.SMOKE_INTERVAL_SECONDS, SMOKE_DEFAULTS.intervalSeconds),
    requestTimeoutMs: positiveInt(env.SMOKE_REQUEST_TIMEOUT_MS, SMOKE_DEFAULTS.requestTimeoutMs),
    expectedCommitSha: (env.SMOKE_EXPECT_COMMIT_SHA ?? '').trim() || null,
    logFile: resolve(env.SMOKE_LOG_FILE ?? join(REPO_ROOT, 'reports', 'deployment.log')),
    resultFile: resolve(env.SMOKE_RESULT_FILE ?? join(REPO_ROOT, 'reports', 'smoke-test.json')),
  };
}

/**
 * O corpo de `/api/health` está saudável?
 *
 * @param {object} input
 * @param {number} input.status código HTTP
 * @param {unknown} input.body corpo já parseado (ou null quando não era JSON)
 * @param {string|null} [input.expectedCommitSha]
 * @returns {{ ok: boolean, retryable: boolean, reason: string }}
 */
export function evaluateHealthResponse({ status, body, raw = '', expectedCommitSha = null }) {
  if (status !== 200) {
    // O corpo da resposta de erro entra no log de propósito: é ele que
    // diferencia "a plataforma respondeu que não há aplicação atrás" de "a
    // aplicação respondeu que não está saudável".
    return { ok: false, retryable: true, reason: `— esperado 200${describeBody(body, raw)}` };
  }
  if (body === null || typeof body !== 'object') {
    return { ok: false, retryable: true, reason: `— corpo não é JSON${describeBody(body, raw)}` };
  }
  if (body.status !== 'ok') {
    return {
      ok: false,
      retryable: true,
      reason: `status="${String(body.status)}" (esperado "ok")${describeBody(body, raw)}`,
    };
  }

  // Confirmação de QUAL versão está no ar. Sem `commitSha` conhecido não dá
  // para afirmar nada: o smoke test aceita e declara a limitação no log.
  if (expectedCommitSha && typeof body.commitSha === 'string' && body.commitSha !== 'unknown') {
    if (!sameCommit(body.commitSha, expectedCommitSha)) {
      return {
        ok: false,
        retryable: true,
        reason:
          `versão antiga no ar (commit ${short(body.commitSha)}, esperado ${short(expectedCommitSha)}): ` +
          'aguardando a nova release',
      };
    }
  }

  return { ok: true, retryable: false, reason: `ok version=${body.version ?? '?'} commit=${short(body.commitSha ?? '?')}` };
}

/**
 * Trecho curto do corpo da resposta, para o log. Sem ele, uma falha vira
 * "HTTP 503" e ninguém consegue distinguir as causas depois.
 *
 * @param {unknown} body corpo já parseado, ou null
 * @param {string} raw texto original da resposta
 * @returns {string} sufixo pronto para concatenar (vazio quando não há corpo)
 */
export function describeBody(body, raw = '') {
  const text = body !== null && body !== undefined ? JSON.stringify(body) : String(raw ?? '');
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return ` · corpo: ${collapsed.length > 180 ? `${collapsed.slice(0, 180)}…` : collapsed}`;
}

/**
 * A rota funcional respondeu o que se espera dela?
 *
 * @param {object} input
 * @returns {{ ok: boolean, retryable: boolean, reason: string }}
 */
export function evaluateFunctionalResponse({ status, body, raw = '' }) {
  if (status !== 200) {
    return { ok: false, retryable: true, reason: `— esperado 200${describeBody(body, raw)}` };
  }
  if (body === null || typeof body !== 'object') {
    return { ok: false, retryable: true, reason: `— corpo não é JSON${describeBody(body, raw)}` };
  }
  if (typeof body.totalRegistered !== 'number') {
    return { ok: false, retryable: false, reason: 'campo `totalRegistered` ausente no relatório' };
  }

  return { ok: true, retryable: false, reason: `totalRegistered=${body.totalRegistered}` };
}

/**
 * Uma linha de log por tentativa — com código HTTP e motivo preservados.
 *
 * @returns {string}
 */
export function formatAttemptLine({ attempt, maxAttempts, method = 'GET', path, outcome, elapsedMs }) {
  const duration = Number.isFinite(elapsedMs) ? ` em ${Math.round(elapsedMs)}ms` : '';
  return `tentativa ${attempt}/${maxAttempts} ${method} ${path} -> ${outcome}${duration}`;
}

/**
 * Executa uma verificação com repetição até o limite de tentativas.
 *
 * @param {object} input
 * @returns {Promise<{ passed: boolean, attempts: number, lastOutcome: string }>}
 */
export async function runCheck({
  name,
  path,
  config,
  evaluate,
  log,
  fetchImpl = fetch,
  sleep = defaultSleep,
}) {
  let lastOutcome = 'nenhuma tentativa executada';

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const started = Date.now();
    const response = await requestJson({
      url: `${config.baseUrl}${path}`,
      timeoutMs: config.requestTimeoutMs,
      fetchImpl,
    });
    const elapsedMs = Date.now() - started;

    let outcome;
    let done = false;
    let passed = false;

    if (response.error) {
      // Erro de transporte: não há código HTTP para registrar, e é essa a
      // diferença que o diagnóstico precisa enxergar depois — "não respondeu"
      // não é a mesma falha que "respondeu errado".
      outcome = `erro de conexão (${response.error})`;
    } else {
      const verdict = evaluate({ status: response.status, body: response.body, raw: response.raw });
      outcome = `HTTP ${response.status} ${verdict.reason}`;
      passed = verdict.ok;
      done = verdict.ok || !verdict.retryable;
    }

    lastOutcome = outcome;
    log(formatAttemptLine({ attempt, maxAttempts: config.maxAttempts, path, outcome, elapsedMs }));

    if (passed) {
      log(`${name}: aprovado na tentativa ${attempt}`);
      return { passed: true, attempts: attempt, lastOutcome };
    }

    if (done) {
      log(`${name}: reprovado na tentativa ${attempt} — ${outcome}`);
      return { passed: false, attempts: attempt, lastOutcome };
    }

    if (attempt < config.maxAttempts) {
      await sleep(config.intervalSeconds * 1000);
    }
  }

  log(`${name}: reprovado após ${config.maxAttempts} tentativas — último resultado: ${lastOutcome}`);
  return { passed: false, attempts: config.maxAttempts, lastOutcome };
}

/**
 * Smoke test completo.
 *
 * @param {object} input
 * @returns {Promise<{ result: object, logText: string }>}
 */
export async function runSmokeTest({
  config,
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = () => new Date(),
  echo = null,
} = {}) {
  const lines = [];

  // Mascarar na origem: assim o que é impresso no runner é exatamente o que vai
  // para o artefato — não existe versão "crua" do log em lugar nenhum.
  const log = (message) => {
    const line = redactSecrets(`[${now().toISOString()}] ${message}`);
    lines.push(line);
    if (echo) echo(line);
  };

  // Só o host: `URL.host` não carrega usuário nem senha da URL.
  log(`smoke-test: alvo ${config.host}`);
  log(
    `smoke-test: configuração maxAttempts=${config.maxAttempts} ` +
      `intervalSeconds=${config.intervalSeconds} requestTimeoutMs=${config.requestTimeoutMs}`,
  );
  if (config.expectedCommitSha) {
    log(`smoke-test: aguardando o commit ${short(config.expectedCommitSha)} responder`);
  }

  const health = await runCheck({
    name: 'health check',
    path: HEALTH_PATH,
    config,
    evaluate: ({ status, body }) =>
      evaluateHealthResponse({ status, body, expectedCommitSha: config.expectedCommitSha }),
    log,
    fetchImpl,
    sleep,
  });

  let functional = { passed: false, attempts: 0, lastOutcome: 'não executado' };

  if (health.passed) {
    functional = await runCheck({
      name: 'rota funcional',
      path: FUNCTIONAL_PATH,
      config,
      evaluate: evaluateFunctionalResponse,
      log,
      fetchImpl,
      sleep,
    });
  } else {
    log('rota funcional: não executada — o health check não passou');
  }

  const passed = health.passed && functional.passed;

  log(
    `smoke-test: health=${health.passed ? 'PASS' : 'FAIL'} ` +
      `funcional=${functional.passed ? 'PASS' : 'FAIL'}`,
  );
  lines.push(`${VERDICT_PREFIX} ${passed ? 'PASS' : 'FAIL'}`);
  if (echo) echo(lines[lines.length - 1]);

  const result = {
    status: passed ? 'success' : 'failure',
    targetHost: config.host,
    checks: {
      health: { path: HEALTH_PATH, passed: health.passed, attempts: health.attempts, lastOutcome: health.lastOutcome },
      functional: {
        path: FUNCTIONAL_PATH,
        passed: functional.passed,
        attempts: functional.attempts,
        lastOutcome: functional.lastOutcome,
      },
    },
    maxAttempts: config.maxAttempts,
    intervalSeconds: config.intervalSeconds,
    finishedAt: now().toISOString(),
  };

  // Nada é gravado sem passar pelo redator. `redactSecretsDeep` mascara valor a
  // valor: mascarar o JSON já serializado corromperia a estrutura (as regras de
  // header e cookie consomem até o fim da linha, aspas incluídas).
  return { result: redactSecretsDeep(result), logText: `${lines.join('\n')}\n` };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

async function requestJson({ url, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });

    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Resposta que não é JSON também é informação: a página de erro da borda
      // da plataforma ("Application failed to respond") chega assim.
      body = null;
    }

    return { status: response.status, body, raw: text.slice(0, 500) };
  } catch (error) {
    return { error: describeNetworkError(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Traduz o erro de transporte para um marcador estável, do tipo que o
 * classificador determinístico reconhece (`ECONNREFUSED`, `ENOTFOUND`, …).
 */
function describeNetworkError(error) {
  const code = error?.cause?.code ?? error?.code;
  if (code) return String(code);
  if (error?.name === 'AbortError') return 'ETIMEDOUT (timeout da requisição)';
  return redactSecrets(String(error?.message ?? error));
}

function defaultSleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function short(sha) {
  return String(sha).slice(0, 7);
}

function sameCommit(a, b) {
  const left = String(a);
  const right = String(b);
  const size = Math.min(left.length, right.length, 40);
  return left.slice(0, size) === right.slice(0, size);
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

async function main() {
  const config = readSmokeConfig(process.env);

  const { result, logText } = await runSmokeTest({
    config,
    echo: (line) => process.stdout.write(`${line}\n`),
  });

  mkdirSync(dirname(config.logFile), { recursive: true });
  writeFileSync(config.logFile, logText, 'utf8');

  mkdirSync(dirname(config.resultFile), { recursive: true });
  writeFileSync(config.resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `\n[smoke-test] resultado: ${result.status}\n` +
      `[smoke-test] log ...: ${config.logFile}\n` +
      `[smoke-test] JSON ..: ${config.resultFile}\n`,
  );

  // O gate técnico é este exit code — não a leitura que a IA fará do log.
  if (result.status !== 'success') process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[smoke-test] erro: ${redactSecrets(String(error.message))}\n`);
    process.exitCode = 1;
  });
}
