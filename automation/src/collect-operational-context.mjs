/**
 * Agregador de evidências operacionais — CI → CD → runtime em um contexto só.
 *
 * Junta o que hoje está espalhado em quatro lugares (artefatos do CI, logs
 * internos do Railway, log do smoke test, resultado dos jobs) e produz um
 * contexto único, sanitizado e **explicitamente separado** em seis blocos:
 *
 *   A. `systemFacts`     fatos do sistema — exit codes, resultados de job, HTTP
 *   B. `textSources`     conteúdo textual dos logs, mascarado e reduzido
 *   C. `limitations`     o que não foi possível coletar ou verificar
 *   D. `sourceCoverage`  quais fontes existem e quais faltaram
 *   E. `technicalStatus` o veredito determinístico
 *   F. `modelInput`      o recorte que o modelo pode ver
 *
 * A separação não é organização: é a garantia de que o modelo receba (F) sem
 * poder tocar em (E). `technicalStatus` é calculado aqui, a partir de código de
 * saída e código HTTP, e segue intocado até o relatório final.
 *
 * Duas regras que a montagem da linha do tempo protege:
 *
 * - **Timestamp não se fabrica.** Evento sem hora legível fica com
 *   `timestamp: null` e `hasTimestamp: false`, aparece agrupado no fim e é
 *   marcado como tal no relatório. Inventar a hora da coleta produziria uma
 *   ordem plausível e errada.
 * - **A falha da coleta do Railway não reprova nada.** `railwayDeployment`
 *   só entra no veredito quando a plataforma declarou `failed` ou `crashed`.
 *   `unknown` é ausência de informação, não má notícia.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OPERATIONAL_PHASES } from '../schemas/operational-diagnosis-schema.mjs';
import { scanForSensitiveData, selectRelevantLines } from './collect-context.mjs';
import { readRailwayEvidence } from './collect-railway-evidence.mjs';
import { redactSecrets, redactSecretsDeep } from './redact-secrets.mjs';
import { sanitizeLog } from './sanitize-log.mjs';
import { VERDICT_PREFIX } from './smoke-test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

// A lista de fases vive no schema — é ele quem valida o relatório final, e um
// segundo vocabulário aqui viraria divergência silenciosa. Reexportada para quem
// já importava daqui.
export { OPERATIONAL_PHASES };

/** Os quatro logs do CI, com a fase e o nome do job a que pertencem. */
export const CI_SOURCES = [
  { key: 'lint', file: 'lint.log', phase: 'ci_quality', job: 'quality', resultVar: 'QUALITY_RESULT' },
  { key: 'tests', file: 'tests.log', phase: 'ci_tests', job: 'tests', resultVar: 'TESTS_RESULT' },
  { key: 'build', file: 'build.log', phase: 'ci_build', job: 'build', resultVar: 'BUILD_RESULT' },
  { key: 'docker', file: 'docker.log', phase: 'ci_docker', job: 'docker-build', resultVar: 'DOCKER_RESULT' },
];

/** Teto de linhas por fonte textual, depois da redução por relevância. */
export const MAX_LINES_PER_SOURCE = 120;

/** Teto de eventos na linha do tempo — o relatório precisa caber numa tela. */
export const MAX_TIMELINE_EVENTS = 400;

const VERDICT_PATTERN = new RegExp(`^${VERDICT_PREFIX}\\s*(PASS|FAIL)\\b`, 'm');

/* ------------------------------------------------------------------------- */
/* A. Fatos do sistema                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Resultados dos jobs do CI, lidos das variáveis que o workflow injeta.
 *
 * `''` (variável ausente) vira `unknown`, não `failure`: não saber o resultado
 * de um job não é o mesmo que ele ter falhado, e tratar os dois igual faria
 * todo `workflow_dispatch` parecer um CI quebrado.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ jobs: object, status: 'success'|'failure'|'unknown', known: number }}
 */
export function readCiJobResults(env = {}) {
  const jobs = {};
  let known = 0;
  let anyFailure = false;
  let allSuccess = true;

  for (const source of CI_SOURCES) {
    const raw = String(env[source.resultVar] ?? '').trim().toLowerCase();
    const value = ['success', 'failure', 'cancelled', 'skipped'].includes(raw) ? raw : 'unknown';

    jobs[source.job] = value;

    if (value === 'unknown') {
      allSuccess = false;
      continue;
    }
    known += 1;
    if (value !== 'success') {
      allSuccess = false;
      if (value === 'failure') anyFailure = true;
    }
  }

  let status = 'unknown';
  if (anyFailure) status = 'failure';
  else if (known === CI_SOURCES.length && allSuccess) status = 'success';

  return { jobs, status, known };
}

/**
 * Resultado do smoke test, na mesma ordem de precedência de
 * `readTechnicalStatus`: arquivo de resultado, depois linha de veredito.
 *
 * A diferença é o valor de saída quando não há nada: aqui é `not_executed`, e
 * não `failure`. O agregador descreve o que existe; quem fecha o veredito é
 * `deriveTechnicalStatus`, e é lá que o fail-closed acontece.
 *
 * @param {object} input
 * @returns {{ status: string, source: string, result: object|null }}
 */
export function readSmokeTestOutcome({ resultFile = null, log = '' } = {}) {
  if (resultFile && existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
      if (parsed.status === 'success' || parsed.status === 'failure') {
        return { status: parsed.status, source: 'reports/smoke-test.json', result: parsed };
      }
    } catch {
      // Arquivo ilegível: cai para o log.
    }
  }

  const verdict = String(log ?? '').match(VERDICT_PATTERN);
  if (verdict) {
    return {
      status: verdict[1] === 'PASS' ? 'success' : 'failure',
      source: `linha \`${VERDICT_PREFIX}\` do log`,
      result: null,
    };
  }

  return { status: 'not_executed', source: 'nenhuma origem encontrada', result: null };
}

/* ------------------------------------------------------------------------- */
/* E. Status determinístico                                                   */
/* ------------------------------------------------------------------------- */

/**
 * O veredito técnico. Nenhum modelo participa desta função.
 *
 * `overall` é `failure` quando **algum fato observado** foi ruim, `success`
 * quando os dois gates que existem (CI e smoke test) passaram, e `unknown`
 * quando falta informação. A ausência de dados do Railway nunca vira `failure`
 * — do contrário, um token expirado reprovaria um deployment saudável.
 *
 * @param {object} input
 * @returns {{ ci: string, railwayDeployment: string, smokeTest: string, overall: string }}
 */
export function deriveTechnicalStatus({ ci = 'unknown', railwayDeployment = 'unknown', smokeTest = 'unknown' } = {}) {
  const badDeployment = railwayDeployment === 'failed' || railwayDeployment === 'crashed';
  const failed = ci === 'failure' || smokeTest === 'failure' || badDeployment;

  let overall = 'unknown';
  if (failed) overall = 'failure';
  else if (ci === 'success' && smokeTest === 'success') overall = 'success';

  return { ci, railwayDeployment, smokeTest, overall };
}

/* ------------------------------------------------------------------------- */
/* Linha do tempo                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Ordena a linha do tempo.
 *
 * Chave primária é o timestamp; eventos sem timestamp **não** são espalhados
 * pelo meio e vão para o fim, agrupados por fase, preservando a ordem em que
 * foram lidos. Assim a leitura continua honesta: o que tem hora está em ordem
 * cronológica real, e o que não tem está declaradamente fora dela.
 *
 * @param {Array<object>} events
 * @returns {Array<object>} nova lista, com `order` preenchido
 */
export function sortTimeline(events = []) {
  const indexed = events.map((event, index) => ({ event, index }));

  indexed.sort((left, right) => {
    const a = left.event.timestamp;
    const b = right.event.timestamp;

    if (a && b) {
      const diff = Date.parse(a) - Date.parse(b);
      if (diff !== 0) return diff;
    } else if (a && !b) {
      return -1;
    } else if (!a && b) {
      return 1;
    } else {
      // Nenhum dos dois tem hora: a fase é a única ordem defensável.
      const diff = phaseIndex(left.event.phase) - phaseIndex(right.event.phase);
      if (diff !== 0) return diff;
    }

    return left.index - right.index;
  });

  return indexed.map((entry, order) => ({ ...entry.event, order }));
}

function phaseIndex(phase) {
  const index = OPERATIONAL_PHASES.indexOf(phase);
  return index === -1 ? OPERATIONAL_PHASES.length : index;
}

/**
 * Um evento da linha do tempo, já normalizado e mascarado.
 *
 * @param {object} input
 * @returns {object}
 */
export function timelineEvent({
  source,
  phase,
  timestamp = null,
  level = 'info',
  message,
  requestId = null,
  deploymentId = null,
  commitSha = null,
}) {
  return {
    source,
    phase,
    timestamp: timestamp ?? null,
    hasTimestamp: Boolean(timestamp),
    level,
    message: redactSecrets(String(message ?? '').trim()).slice(0, 400),
    requestId: requestId ? redactSecrets(requestId) : null,
    deploymentId: deploymentId ? redactSecrets(deploymentId) : null,
    commitSha: commitSha ? redactSecrets(commitSha) : null,
  };
}

/**
 * Remove eventos repetidos.
 *
 * Um log de runtime com 200 linhas idênticas de health check não torna a
 * evidência mais forte — só empurra o que importa para fora da tela. A
 * deduplicação é por (fonte, fase, mensagem): o mesmo texto na mesma fase é o
 * mesmo fato, e o primeiro horário é o que interessa.
 *
 * @param {Array<object>} events
 * @returns {Array<object>}
 */
export function dedupeTimeline(events = []) {
  const seen = new Map();
  const kept = [];

  for (const event of events) {
    const key = `${event.source}::${event.phase}::${event.message}`;
    if (seen.has(key)) {
      seen.get(key).repeated += 1;
      continue;
    }
    const entry = { ...event, repeated: 1 };
    seen.set(key, entry);
    kept.push(entry);
  }

  return kept;
}

/* ------------------------------------------------------------------------- */
/* Agregação                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Monta o contexto operacional completo.
 *
 * Tudo entra por parâmetro (conteúdo, não caminho) para que os testes e as
 * fixtures montem cenários sem tocar em disco. Quem lê arquivo é
 * `collectOperationalContextFromDisk`.
 *
 * @param {object} input
 * @returns {object} contexto operacional
 */
export function buildOperationalContext({
  metadata = {},
  ciLogs = {},
  ciJobs = null,
  railway = { metadata: null, streams: { build: [], deploy: [], runtime: [] } },
  deploymentLog = '',
  smokeResult = null,
  env = {},
  extraLimitations = [],
} = {}) {
  const limitations = [...extraLimitations];
  const textSources = [];
  const timeline = [];

  const sourceCoverage = {
    ciLint: false,
    ciTests: false,
    ciBuild: false,
    ciDocker: false,
    ci: false,
    railwayBuild: false,
    railwayDeploy: false,
    railwayRuntime: false,
    smokeTest: false,
  };

  /* ---- CI: resultados dos jobs (fato) e logs (texto) --------------------- */

  const ci = ciJobs ?? readCiJobResults(env);

  if (ci.known === 0) {
    limitations.push(
      'Os resultados dos jobs do CI não foram informados a esta execução: o status do CI é `unknown`. ' +
        'Em disparo manual (`workflow_dispatch`) não existe uma execução de CI anterior a que se referir.',
    );
  }

  for (const source of CI_SOURCES) {
    const raw = ciLogs[source.key];

    if (typeof raw !== 'string' || raw.trim().length === 0) {
      limitations.push(
        `O log \`${source.file}\` do job \`${source.job}\` não foi coletado: o artefato do CI não estava ` +
          'disponível para esta execução.',
      );
      continue;
    }

    const { text, truncated, sensitive } = prepareText(raw, `ci:${source.key}`);
    if (truncated) {
      limitations.push(`O log \`${source.file}\` foi reduzido aos trechos relevantes (início, erros e final).`);
    }
    if (sensitive) {
      limitations.push(
        `Conteúdo sensível foi detectado em \`${source.file}\` e mascarado antes de qualquer análise.`,
      );
    }

    sourceCoverage[`ci${capitalize(source.key)}`] = true;
    sourceCoverage.ci = true;

    textSources.push({ source: `ci:${source.key}`, phase: source.phase, content: text });

    // O log do CI não tem timestamp por linha: entra na linha do tempo como um
    // evento único de resultado, e não como 500 linhas sem hora.
    timeline.push(
      timelineEvent({
        source: `ci:${source.key}`,
        phase: source.phase,
        message: `job \`${source.job}\` do CI: ${ci.jobs[source.job] ?? 'unknown'}`,
        level: ci.jobs[source.job] === 'failure' ? 'error' : 'info',
        commitSha: metadata.commitSha ?? null,
      }),
    );
  }

  /* ---- Railway: build, deploy e runtime ---------------------------------- */

  const railwayMetadata = railway?.metadata ?? null;
  const streams = railway?.streams ?? { build: [], deploy: [], runtime: [] };

  if (!railwayMetadata) {
    limitations.push(
      'Nenhum metadado de coleta do Railway foi encontrado: os logs internos da plataforma (build, deploy e ' +
        'runtime) não fazem parte deste diagnóstico.',
    );
  } else {
    limitations.push(...(railwayMetadata.limitations ?? []));
  }

  const STREAM_PHASES = { build: 'railway_build', deploy: 'railway_deploy', runtime: 'runtime' };

  for (const [stream, phase] of Object.entries(STREAM_PHASES)) {
    const events = Array.isArray(streams[stream]) ? streams[stream] : [];
    if (events.length === 0) continue;

    sourceCoverage[`railway${capitalize(stream)}`] = true;

    const joined = events.map((event) => event.raw ?? event.message ?? '').join('\n');
    const { text, truncated } = prepareText(joined, `railway:${stream}`);
    if (truncated) {
      limitations.push(`Os logs de ${stream} do Railway foram reduzidos aos trechos relevantes.`);
    }

    textSources.push({ source: `railway:${stream}`, phase, content: text });

    for (const event of events) {
      timeline.push(
        timelineEvent({
          source: `railway:${stream}`,
          // O evento da aplicação carrega a própria fase (`startup`,
          // `healthcheck`, `functional`): ela é mais precisa que a do fluxo.
          phase: phaseForRailwayEvent(event) ?? phase,
          timestamp: event.timestamp ?? null,
          level: event.level ?? 'info',
          message: event.message ?? event.raw ?? '',
          requestId: event.requestId ?? null,
          deploymentId: railwayMetadata?.deploymentId ?? null,
          commitSha: railwayMetadata?.observedCommitSha ?? null,
        }),
      );
    }
  }

  /* ---- Smoke test -------------------------------------------------------- */

  const smoke = readSmokeTestOutcome({ log: deploymentLog });
  const smokeStatus = smokeResult?.status ?? smoke.status;

  if (typeof deploymentLog === 'string' && deploymentLog.trim().length > 0) {
    sourceCoverage.smokeTest = true;

    const { text, truncated, sensitive } = prepareText(deploymentLog, 'smoke:deployment');
    if (truncated) limitations.push('O log do smoke test foi reduzido aos trechos relevantes.');
    if (sensitive) {
      limitations.push(
        'Conteúdo sensível foi detectado no log do smoke test e mascarado antes de qualquer análise.',
      );
    }

    textSources.push({ source: 'smoke:deployment', phase: 'post_deployment_validation', content: text });

    for (const line of text.split('\n')) {
      const parsed = parseSmokeLine(line);
      if (!parsed) continue;
      timeline.push(
        timelineEvent({
          source: 'smoke:deployment',
          phase: parsed.phase,
          timestamp: parsed.timestamp,
          level: parsed.level,
          message: parsed.message,
          commitSha: metadata.commitSha ?? null,
        }),
      );
    }
  } else {
    limitations.push('O log do smoke test pós-deployment não foi coletado.');
  }

  /* ---- Status determinístico -------------------------------------------- */

  const technicalStatus = deriveTechnicalStatus({
    ci: ci.status,
    railwayDeployment: railwayMetadata?.deploymentStatus ?? 'unknown',
    smokeTest: smokeStatus,
  });

  if (technicalStatus.overall === 'unknown') {
    limitations.push(
      'O resultado técnico geral é `unknown`: faltam fatos suficientes (resultado do CI e/ou do smoke test) ' +
        'para afirmar sucesso ou falha.',
    );
  }

  /* ---- Correlação da release -------------------------------------------- */

  const correlation = {
    status: railwayMetadata?.correlationStatus ?? 'unknown',
    expectedCommitSha: redactSecrets(
      railwayMetadata?.requestedCommitSha ?? metadata.commitSha ?? 'unknown',
    ),
    observedCommitSha: railwayMetadata?.observedCommitSha
      ? redactSecrets(railwayMetadata.observedCommitSha)
      : null,
  };

  if (correlation.status === 'mismatch') {
    limitations.push(
      'A versão observada na plataforma **não** é a versão esperada: os logs desta coleta podem pertencer a ' +
        'outra release. Nenhuma conclusão sobre o commit em análise deve ser tirada deles.',
    );
  }

  /* ---- Montagem final ---------------------------------------------------- */

  const orderedTimeline = sortTimeline(dedupeTimeline(timeline)).slice(0, MAX_TIMELINE_EVENTS);

  const systemFacts = {
    ciJobs: ci.jobs,
    smokeTest: {
      status: smokeStatus,
      source: smoke.source,
      health: smokeResult?.checks?.health ?? null,
      functional: smokeResult?.checks?.functional ?? null,
    },
    railwayDeployment: {
      deploymentId: railwayMetadata?.deploymentId ?? null,
      status: railwayMetadata?.deploymentStatus ?? 'unknown',
      usedFallbackCommand: railwayMetadata?.usedFallbackCommand ?? false,
      cliErrorCategory: railwayMetadata?.cliErrorCategory ?? null,
    },
    eventsWithoutTimestamp: orderedTimeline.filter((event) => !event.hasTimestamp).length,
  };

  const context = {
    schemaVersion: 1,
    metadata: {
      repository: redactSecrets(metadata.repository ?? 'unknown/unknown'),
      commitSha: redactSecrets(metadata.commitSha ?? 'unknown'),
      deploymentId: railwayMetadata?.deploymentId ? redactSecrets(railwayMetadata.deploymentId) : null,
      service: railwayMetadata?.service ? redactSecrets(railwayMetadata.service) : null,
      environment: railwayMetadata?.environment ? redactSecrets(railwayMetadata.environment) : null,
      targetHost: redactSecrets(metadata.targetHost ?? smokeResult?.targetHost ?? 'unknown'),
    },
    technicalStatus,
    correlation,
    sourceCoverage,
    systemFacts,
    timeline: orderedTimeline,
    textSources,
    limitations: unique(limitations),
  };

  return redactSecretsDeep(context);
}

/**
 * Monta o contexto lendo os arquivos que o workflow deixou no disco.
 *
 * @param {object} input
 * @returns {object}
 */
export function collectOperationalContextFromDisk({
  reportsDir = join(REPO_ROOT, 'reports'),
  ciDir = null,
  railwayDir = null,
  env = process.env,
  metadata = {},
} = {}) {
  const reports = resolve(reportsDir);
  const ciEvidenceDir = resolve(ciDir ?? join(reports, 'evidence', 'ci'));
  const railwayEvidenceDir = resolve(railwayDir ?? join(reports, 'railway'));

  const ciLogs = {};
  for (const source of CI_SOURCES) {
    const path = join(ciEvidenceDir, source.file);
    if (existsSync(path)) ciLogs[source.key] = readFileSync(path, 'utf8');
  }

  const railway = readRailwayEvidence(railwayEvidenceDir);

  const deploymentLogPath = join(reports, 'deployment.log');
  const deploymentLog = existsSync(deploymentLogPath) ? readFileSync(deploymentLogPath, 'utf8') : '';

  const smokeResultPath = join(reports, 'smoke-test.json');
  let smokeResult = null;
  if (existsSync(smokeResultPath)) {
    try {
      smokeResult = JSON.parse(readFileSync(smokeResultPath, 'utf8'));
    } catch {
      smokeResult = null;
    }
  }

  return buildOperationalContext({
    metadata: {
      repository: env.GITHUB_REPOSITORY,
      commitSha: env.EXPECTED_COMMIT_SHA || env.GITHUB_SHA,
      targetHost: metadata.targetHost,
      ...metadata,
    },
    ciLogs,
    railway: { metadata: railway.metadata, streams: railway.streams },
    deploymentLog,
    smokeResult,
    env,
  });
}

/**
 * Grava `operational-context.json` e `operational-timeline.json`.
 *
 * @param {object} input
 * @returns {{ contextPath: string, timelinePath: string }}
 */
export function writeOperationalContext({ context, outDir = join(REPO_ROOT, 'reports') }) {
  const directory = resolve(outDir);
  mkdirSync(directory, { recursive: true });

  const contextPath = join(directory, 'operational-context.json');
  const timelinePath = join(directory, 'operational-timeline.json');

  writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8');
  writeFileSync(
    timelinePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        commitSha: context.metadata.commitSha,
        deploymentId: context.metadata.deploymentId,
        eventsWithoutTimestamp: context.systemFacts.eventsWithoutTimestamp,
        events: context.timeline,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { contextPath, timelinePath };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Sanitiza, escaneia no ORIGINAL, reduz e mascara — nessa ordem, sempre.
 */
function prepareText(raw, sourceName) {
  const clean = sanitizeLog(String(raw ?? ''));
  const sensitive = scanForSensitiveData([{ source: sourceName, content: clean }]).hasSensitiveData;
  const { text, truncated } = selectRelevantLines(clean, MAX_LINES_PER_SOURCE);

  return { text: redactSecrets(text), truncated, sensitive };
}

/**
 * A fase de um evento vindo do Railway.
 *
 * Quando a linha é um evento do contrato da aplicação, a fase declarada por ela
 * (`startup`, `healthcheck`, `functional`) é mais precisa que a do fluxo em que
 * foi coletada — é exatamente para isso que o campo existe na Parte 1.
 */
function phaseForRailwayEvent(event) {
  const eventType = event?.eventType;
  if (typeof eventType !== 'string') return null;

  if (eventType.startsWith('app.')) {
    return eventType === 'app.shutdown.requested' ||
      eventType === 'app.uncaught_exception' ||
      eventType === 'app.unhandled_rejection'
      ? 'runtime'
      : 'startup';
  }
  if (eventType.startsWith('health.')) return 'healthcheck';
  if (eventType.startsWith('functional.')) return 'functional';
  return null;
}

/** Reconhece uma linha do log do smoke test e extrai hora, fase e severidade. */
function parseSmokeLine(line) {
  const match = String(line).match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*(.*)$/);
  if (!match) {
    // A linha de veredito não tem timestamp — e não recebe um inventado.
    if (line.startsWith(VERDICT_PREFIX)) {
      return {
        timestamp: null,
        phase: 'post_deployment_validation',
        level: line.includes('FAIL') ? 'error' : 'info',
        message: line.trim(),
      };
    }
    return null;
  }

  const [, timestamp, message] = match;
  const failed = /reprovado|erro de conexão|FAIL/i.test(message);

  let phase = 'post_deployment_validation';
  if (/\/api\/health|health check/i.test(message)) phase = 'healthcheck';
  else if (/\/api\/report|rota funcional/i.test(message)) phase = 'functional';

  return {
    timestamp: Number.isNaN(Date.parse(timestamp)) ? null : new Date(timestamp).toISOString(),
    phase,
    level: failed ? 'error' : 'info',
    message: message.trim(),
  };
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
