/**
 * Ponto de entrada do relatório operacional.
 *
 * Dois modos, o mesmo caminho de código:
 *
 *   node automation/src/operational-report.mjs
 *       lê o que o workflow deixou em `reports/` (artefatos do CI, coleta do
 *       Railway, log e resultado do smoke test);
 *
 *   node automation/src/operational-report.mjs --fixture success
 *       lê um cenário versionado em `samples/operational/<nome>/`.
 *
 * O modo fixture existe para a aula acontecer sem Railway, sem OpenAI e sem
 * internet — e para que os dois cenários do Dia 1 sejam reproduzíveis byte a
 * byte, o que um ambiente real nunca é. Ele passa **exatamente** pelo mesmo
 * agregador, pelo mesmo classificador e pelos mesmos renderizadores: um caminho
 * separado para a demonstração seria um caminho que ninguém testa.
 *
 * Exit code é sempre 0. Este script **não** é gate: quem aprova ou reprova é o
 * smoke test, em outro job.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { analyzeOperational } from './analyze-operational.mjs';
import {
  buildOperationalContext,
  collectOperationalContextFromDisk,
  writeOperationalContext,
} from './collect-operational-context.mjs';
import { buildPipelineExecution } from './pipeline-execution.mjs';
import { fromJsonl } from './railway-log-parser.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { renderOperationalHtml } from './render-operational-html.mjs';
import { renderOperationalReport } from './render-operational-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AUTOMATION_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(AUTOMATION_ROOT, '..');
export const FIXTURES_ROOT = join(REPO_ROOT, 'samples', 'pipeline-executions');

/**
 * Os cinco cenários do Dia 1, na ordem em que a aula os apresenta.
 *
 * A lista existe para **documentar e validar**; quem enumera o disco é
 * `listFixtures`. Uma pasta nova em `samples/pipeline-executions/` continua
 * aparecendo sozinha.
 */
export const DAY_1_SCENARIOS = [
  'success',
  'ci-lint-failure',
  'ci-tests-failure',
  'ci-docker-failure',
  'cd-functional-failure',
];

/**
 * Nomes antigos que continuam funcionando.
 *
 * `samples/operational/functional-failure/` virou
 * `samples/pipeline-executions/cd-functional-failure/` quando os cinco cenários
 * passaram a viver juntos. Quebrar `npm run operational:fixture --
 * functional-failure` quebraria a documentação impressa da turma no meio da
 * aula — o alias custa uma linha.
 */
export const FIXTURE_ALIASES = { 'functional-failure': 'cd-functional-failure' };

/** Os dois nomes de arquivo do relatório. Ver `writeOperationalReports`. */
export const REPORT_BASENAMES = ['operational-deployment-report', 'pipeline-execution-report'];

/** Arquivos que um cenário pode ter. Todos opcionais — ausência vira limitação. */
export const FIXTURE_FILES = {
  ciLogs: { lint: 'lint.log', tests: 'tests.log', build: 'build.log', docker: 'docker.log' },
  railwayStreams: {
    build: 'railway-build.jsonl',
    deploy: 'railway-deploy.jsonl',
    runtime: 'railway-runtime.jsonl',
  },
  deploymentLog: 'deployment.log',
  smokeResult: 'smoke-test.json',
  railwayMetadata: 'collection-metadata.json',
  jobResults: 'ci-results.json',
};

/**
 * Cenários disponíveis, lidos do disco (e não de uma lista fixa aqui): assim
 * criar uma pasta nova em `samples/operational/` basta para ela aparecer.
 *
 * @returns {string[]}
 */
export function listFixtures() {
  if (!existsSync(FIXTURES_ROOT)) return [];

  const directories = readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  // Os aliases entram na listagem porque a listagem é o que o erro de "cenário
  // não encontrado" imprime: esconder um nome que funciona seria dizer à pessoa
  // que ela digitou errado quando não digitou.
  const aliases = Object.keys(FIXTURE_ALIASES).filter((alias) =>
    directories.includes(FIXTURE_ALIASES[alias]),
  );

  return [...new Set([...directories, ...aliases])].sort();
}

/**
 * Carrega um cenário e monta o contexto operacional.
 *
 * @param {string} name
 * @param {object} [options]
 * @returns {object} contexto operacional
 */
export function loadFixtureContext(name, { root = FIXTURES_ROOT } = {}) {
  const resolvedName = FIXTURE_ALIASES[name] ?? name;
  const directory = join(resolve(root), resolvedName);

  if (!existsSync(directory)) {
    const available = listFixtures();
    throw new Error(
      `Cenário \`${name}\` não encontrado em ${root}.` +
        (available.length > 0 ? ` Disponíveis: ${available.join(', ')}.` : ''),
    );
  }

  const read = (file) => {
    const path = join(directory, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };

  const readJson = (file) => {
    const raw = read(file);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const ciLogs = {};
  for (const [key, file] of Object.entries(FIXTURE_FILES.ciLogs)) {
    const content = read(file);
    if (content !== null) ciLogs[key] = content;
  }

  const streams = { build: [], deploy: [], runtime: [] };
  for (const [key, file] of Object.entries(FIXTURE_FILES.railwayStreams)) {
    const content = read(file);
    if (content !== null) streams[key] = fromJsonl(content);
  }

  const railwayMetadata = readJson(FIXTURE_FILES.railwayMetadata);
  const smokeResult = readJson(FIXTURE_FILES.smokeResult);
  const jobResults = readJson(FIXTURE_FILES.jobResults) ?? {};

  return buildOperationalContext({
    metadata: {
      repository: jobResults.repository ?? 'senai/copa-figurinhas',
      commitSha: railwayMetadata?.requestedCommitSha ?? jobResults.commitSha ?? 'unknown',
      targetHost: smokeResult?.targetHost,
    },
    ciLogs,
    railway: { metadata: railwayMetadata, streams },
    deploymentLog: read(FIXTURE_FILES.deploymentLog) ?? '',
    smokeResult,
    env: {
      QUALITY_RESULT: jobResults.quality ?? '',
      TESTS_RESULT: jobResults.tests ?? '',
      BUILD_RESULT: jobResults.build ?? '',
      DOCKER_RESULT: jobResults.docker ?? '',
    },
    extraLimitations: [
      `Cenário de contingência \`${name}\`: material versionado no repositório, não uma execução real desta release.`,
    ],
  });
}

/**
 * O escopo do relatório, deduzido do material coletado.
 *
 * Sem log de smoke test não houve validação pós-deployment: o relatório é de
 * **CI**, e as etapas de CD entram como `not_reached` em vez de `unknown`. É a
 * diferença entre "não sei" e "ainda não aconteceu".
 *
 * @param {object} context
 * @returns {'ci'|'cd'}
 */
export function inferScope(context) {
  return context?.sourceCoverage?.smokeTest ? 'cd' : 'ci';
}

/**
 * Grava os relatórios — JSON, Markdown e HTML, sob **dois** nomes.
 *
 * `operational-deployment-report.*` é o nome que a documentação, os artefatos e
 * o Job Summary do pós-deployment já usam; `pipeline-execution-report.*` é o
 * nome único dos dois fluxos (CI e CD). Gravar os dois é o que permite
 * renomear sem quebrar nada que já aponta para o antigo — e o conteúdo é
 * byte a byte o mesmo, gerado uma vez só.
 *
 * O JSON traz o diagnóstico **e** a execução (`pipelineExecution`): quem já lia
 * `technicalStatus` continua lendo, e quem quer as etapas tem onde olhar.
 *
 * @param {object} input
 * @returns {{ jsonPath: string, markdownPath: string, htmlPath: string, paths: string[] }}
 */
export function writeOperationalReports({
  diagnosis,
  context,
  execution = null,
  outDir = join(REPO_ROOT, 'reports'),
  basenames = REPORT_BASENAMES,
}) {
  const directory = resolve(outDir);
  mkdirSync(directory, { recursive: true });

  const resolvedExecution =
    execution ?? buildPipelineExecution({ diagnosis, context, scope: inferScope(context) });

  const json = `${JSON.stringify({ ...diagnosis, pipelineExecution: resolvedExecution }, null, 2)}\n`;
  const markdown = renderOperationalReport(diagnosis, context, resolvedExecution);
  const html = renderOperationalHtml(diagnosis, context, resolvedExecution);

  const paths = [];
  for (const basename of basenames) {
    const jsonPath = join(directory, `${basename}.json`);
    const markdownPath = join(directory, `${basename}.md`);
    const htmlPath = join(directory, `${basename}.html`);

    writeFileSync(jsonPath, json, 'utf8');
    writeFileSync(markdownPath, markdown, 'utf8');
    writeFileSync(htmlPath, html, 'utf8');

    paths.push(jsonPath, markdownPath, htmlPath);
  }

  const [primary] = basenames;

  return {
    jsonPath: join(directory, `${primary}.json`),
    markdownPath: join(directory, `${primary}.md`),
    htmlPath: join(directory, `${primary}.html`),
    execution: resolvedExecution,
    paths,
  };
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * @param {string[]} argv
 * @returns {{ fixture: string|null, outDir: string|null, reportsDir: string|null }}
 */
export function parseArgs(argv) {
  const options = { fixture: null, outDir: null, reportsDir: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') {
      // `npm run operational:fixture -- success` entrega o nome como próximo
      // argumento; sem nome, vale o cenário saudável.
      const next = argv[index + 1];
      options.fixture = next && !next.startsWith('--') ? next : 'success';
    } else if (arg === '--out') options.outDir = argv[index + 1] ?? null;
    else if (arg === '--reports') options.reportsDir = argv[index + 1] ?? null;
  }

  return options;
}

async function main() {
  dotenv.config({ path: [join(AUTOMATION_ROOT, '.env'), join(REPO_ROOT, '.env')], quiet: true });

  const env = process.env;
  const options = parseArgs(process.argv.slice(2));
  const outDir = resolve(options.outDir ?? env.CI_OUTPUT_DIR ?? join(REPO_ROOT, 'reports'));

  const context = options.fixture
    ? loadFixtureContext(options.fixture)
    : collectOperationalContextFromDisk({
        reportsDir: resolve(options.reportsDir ?? join(REPO_ROOT, 'reports')),
        env,
      });

  const { diagnosis } = await analyzeOperational({ context, env });
  const scope = env.PIPELINE_REPORT_SCOPE || inferScope(context);
  const execution = buildPipelineExecution({ diagnosis, context, scope });

  writeOperationalContext({ context, outDir });
  const { jsonPath, markdownPath, htmlPath } = writeOperationalReports({
    diagnosis,
    context,
    execution,
    outDir,
  });

  const coverage = Object.entries(diagnosis.sourceCoverage)
    .map(([key, value]) => `${key}=${value ? 'sim' : 'não'}`)
    .join(' ');

  process.stdout.write(
    '[operational-report] relatório gerado\n' +
      `  cenário ......... ${options.fixture ?? 'execução real'}\n` +
      `  escopo .......... ${execution.scope}\n` +
      `  resultado ....... ${execution.overallStatus} ` +
      `(ci=${diagnosis.technicalStatus.ci} railway=${diagnosis.technicalStatus.railwayDeployment} ` +
      `smoke=${diagnosis.technicalStatus.smokeTest})\n` +
      `  primeira falha .. ${execution.firstFailedStage ?? 'nenhuma'}\n` +
      `  gate ............ ${execution.gate.type}=${execution.gate.status}\n` +
      `  fase afetada .... ${diagnosis.affectedPhase}\n` +
      `  correlação ...... ${diagnosis.correlationStatus} ` +
      `(esperado ${String(diagnosis.expectedCommitSha).slice(0, 7)}, ` +
      `observado ${String(diagnosis.observedCommitSha ?? 'n/d').slice(0, 7)})\n` +
      `  fatos ........... ${diagnosis.observedFacts.length}\n` +
      `  inferências ..... ${diagnosis.inferences.length}\n` +
      `  limitações ...... ${diagnosis.limitations.length}\n` +
      `  fallback ........ ${diagnosis.usedFallback}\n` +
      `  cobertura ....... ${coverage}\n` +
      `  JSON ............ ${jsonPath}\n` +
      `  Markdown ........ ${markdownPath}\n` +
      `  HTML ............ ${htmlPath}\n\n` +
      '  O relatório é INFORMATIVO. Quem reprova o deployment é o smoke test.\n',
  );

  // Exit code 0 sempre. Ver o cabeçalho do módulo.
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `[operational-report] erro: ${redactSecrets(String(error?.message ?? error))}\n`,
    );
    process.exitCode = 1;
  });
}
