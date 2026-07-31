/**
 * Relatório de execução do pipeline — um comando para os dois fluxos.
 *
 * Três modos, **um** caminho de código:
 *
 *   node automation/src/pipeline-report.mjs
 *       lê o que o workflow deixou em `reports/`; o escopo é deduzido do
 *       material (com smoke test → `cd`, sem → `ci`);
 *
 *   node automation/src/pipeline-report.mjs --scope ci --ci-dir reports/input
 *       o relatório gerado DENTRO do CI, quando lint, testes, build ou Docker
 *       falharam e o pós-deployment nunca vai rodar;
 *
 *   node automation/src/pipeline-report.mjs --fixture ci-lint-failure
 *       um dos cinco cenários versionados em `samples/pipeline-executions/`.
 *
 * O modo fixture existe para a aula acontecer sem Railway, sem OpenAI e sem
 * internet. Ele passa pelo **mesmo** agregador, pelo mesmo classificador e
 * pelos mesmos renderizadores — um caminho separado para a demonstração seria
 * um caminho que ninguém testa.
 *
 * ## A chave não liga sozinha
 *
 * Nas fixtures, ter `OPENAI_API_KEY` no ambiente **não** basta: é preciso
 * `PIPELINE_FIXTURE_USE_OPENAI=true`. A ordem importa — quem roda a fixture
 * está demonstrando o fluxo, não pagando por uma chamada, e o `.env` da máquina
 * de quem apresenta costuma ter a chave. Sem o opt-in, a chave é removida do
 * ambiente **antes** de chegar ao agente; não há como uma requisição escapar.
 *
 * Exit code é sempre 0. Este script **não** é gate: quem aprova ou reprova é o
 * `ci-gate` (exit codes dos jobs) e o `cd-gate` (smoke test), em outros jobs.
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { analyzeOperational } from './analyze-operational.mjs';
import { collectOperationalContextFromDisk, writeOperationalContext } from './collect-operational-context.mjs';
import {
  AUTOMATION_ROOT,
  DAY_1_SCENARIOS,
  REPO_ROOT,
  inferScope,
  listFixtures,
  loadFixtureContext,
  writeOperationalReports,
} from './operational-report.mjs';
import { buildPipelineExecution } from './pipeline-execution.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { EXECUTION_SCOPES } from '../schemas/pipeline-execution-schema.mjs';

/** Variável que autoriza a chamada real ao modelo no modo fixture. */
export const FIXTURE_MODEL_OPT_IN = 'PIPELINE_FIXTURE_USE_OPENAI';

/**
 * @param {string[]} argv
 * @returns {{ fixture: string|null, scope: string|null, outDir: string|null,
 *             reportsDir: string|null, ciDir: string|null }}
 */
export function parsePipelineArgs(argv = []) {
  const options = { fixture: null, scope: null, outDir: null, reportsDir: null, ciDir: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const value = next && !next.startsWith('--') ? next : null;

    if (arg === '--fixture') options.fixture = value ?? 'success';
    else if (arg === '--scope') options.scope = value;
    else if (arg === '--out') options.outDir = value;
    else if (arg === '--reports') options.reportsDir = value;
    else if (arg === '--ci-dir') options.ciDir = value;
  }

  return options;
}

/**
 * O ambiente que o agente pode ver.
 *
 * No modo fixture sem opt-in, `OPENAI_API_KEY` é **removida**. Não é uma
 * condição em volta da chamada: é a chave não existir para quem chamaria.
 *
 * @param {object} input
 * @returns {{ env: object, note: string|null }}
 */
export function resolveFixtureEnv({ env = {}, fixture = false } = {}) {
  if (!fixture) return { env, note: null };

  const optIn = String(env[FIXTURE_MODEL_OPT_IN] ?? '').trim().toLowerCase() === 'true';
  if (optIn) return { env, note: null };

  const { OPENAI_API_KEY: _key, ...rest } = env;

  return {
    env: rest,
    note:
      env.OPENAI_API_KEY
        ? `Cenário versionado: a chamada à OpenAI foi desligada apesar de \`OPENAI_API_KEY\` existir no ambiente. ` +
          `Use \`${FIXTURE_MODEL_OPT_IN}=true\` para habilitá-la.`
        : null,
  };
}

/**
 * Resolve o escopo do relatório: opção explícita, variável de ambiente, ou o
 * que o material coletado indica.
 *
 * @param {object} input
 * @returns {'ci'|'cd'}
 */
export function resolveScope({ requested = null, env = {}, context }) {
  const candidate = requested ?? env.PIPELINE_REPORT_SCOPE ?? null;
  if (candidate && EXECUTION_SCOPES.includes(candidate)) return candidate;
  return inferScope(context);
}

async function main() {
  dotenv.config({ path: [join(AUTOMATION_ROOT, '.env'), join(REPO_ROOT, '.env')], quiet: true });

  const options = parsePipelineArgs(process.argv.slice(2));
  const outDir = resolve(options.outDir ?? process.env.CI_OUTPUT_DIR ?? join(REPO_ROOT, 'reports'));

  if (options.fixture && !listFixtures().includes(options.fixture)) {
    process.stderr.write(
      `[pipeline-report] cenário \`${options.fixture}\` não existe. ` +
        `Disponíveis: ${listFixtures().join(', ')}.\n` +
        `[pipeline-report] cenários do Dia 1: ${DAY_1_SCENARIOS.join(', ')}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const reportsDir = resolve(options.reportsDir ?? join(REPO_ROOT, 'reports'));

  const context = options.fixture
    ? loadFixtureContext(options.fixture)
    : collectOperationalContextFromDisk({
        reportsDir,
        ciDir: options.ciDir ? resolve(options.ciDir) : null,
        env: process.env,
      });

  const { env, note } = resolveFixtureEnv({ env: process.env, fixture: Boolean(options.fixture) });
  const { diagnosis } = await analyzeOperational({ context, env });

  const scope = resolveScope({ requested: options.scope, env: process.env, context });
  const execution = buildPipelineExecution({ diagnosis, context, scope });

  writeOperationalContext({ context, outDir });
  const { paths } = writeOperationalReports({ diagnosis, context, execution, outDir });

  // Este comando anuncia o nome unificado; o alias
  // `operational-deployment-report.*` continua gravado, para a documentação e
  // as automações que já apontam para ele.
  const htmlPath = paths.find((path) => path.endsWith('pipeline-execution-report.html')) ?? paths[0];

  const stages = execution.stages
    .map((stage) => `${stage.status === 'success' ? '✓' : stage.status === 'failure' ? '✗' : stage.status === 'not_reached' ? '—' : stage.status === 'skipped' ? '○' : '?'} ${stage.label}`)
    .join('\n                    ');

  process.stdout.write(
    '[pipeline-report] relatório gerado\n' +
      `  cenário ......... ${options.fixture ?? 'execução real'}\n` +
      `  escopo .......... ${execution.scope}\n` +
      `  resultado ....... ${execution.overallStatus}\n` +
      `  primeira falha .. ${execution.firstFailedStage ?? 'nenhuma'}\n` +
      `  gate ............ ${execution.gate.type}=${execution.gate.status} (${execution.gate.determinedBy})\n` +
      `  fatos ........... ${execution.observedFacts.length}\n` +
      `  inferências ..... ${execution.inferences.length}\n` +
      `  limitações ...... ${execution.limitations.length}\n` +
      `  fallback ........ ${execution.usedFallback}\n` +
      `  etapas .......... ${stages}\n` +
      `  HTML ............ ${htmlPath}\n` +
      `  arquivos ........ ${paths.length}\n` +
      (note ? `  aviso ........... ${note}\n` : '') +
      '\n  O relatório é INFORMATIVO. Quem aprova ou reprova é o gate técnico.\n',
  );

  // Exit code 0 sempre. Ver o cabeçalho do módulo.
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[pipeline-report] erro: ${redactSecrets(String(error?.message ?? error))}\n`);
    process.exitCode = 1;
  });
}
