/**
 * Entrypoint do job `diagnose` do CI.
 *
 * Diferente de `analyze-pipeline.mjs --fixture` (cenário simulado) ou do modo
 * real de `collectLiveSource` (reexecuta os comandos), aqui os comandos já
 * rodaram em jobs separados (`quality`, `tests`, `build`). Este script só lê
 * os logs já produzidos — baixados como artefato para `reports/input/` — e o
 * resultado de cada job (`needs.<job>.result`), sem rodar nada de novo.
 *
 * Mantém o restante do pipeline do agente (mascaramento, classificador,
 * modelo opcional, política de deploy, schema) inalterado: só a coleta muda.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzePipeline, REPO_ROOT, writeReports } from './analyze-pipeline.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { diffFiles } from './simulate-failure.mjs';
import { isPullRequestCommentEnabled, upsertPullRequestComment } from './upsert-pr-comment.mjs';

/** `needs.<job>.result` do GitHub Actions → exit code equivalente. */
function exitCodeFromJobResult(result) {
  if (result === 'success') return 0;
  if (result === 'failure') return 1;
  // 'cancelled' ou 'skipped': o comando não chegou a concluir.
  return null;
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function buildCommand({ name, command, resultEnvVar, logFile, inputDir, env }) {
  return {
    name,
    command,
    exitCode: exitCodeFromJobResult(env[resultEnvVar]),
    log: readIfExists(join(inputDir, logFile)),
  };
}

export function buildCiSource({ inputDir, env = process.env }) {
  const commands = [
    buildCommand({
      name: 'lint',
      command: 'npm run lint',
      resultEnvVar: 'QUALITY_RESULT',
      logFile: 'lint.log',
      inputDir,
      env,
    }),
    buildCommand({
      name: 'test',
      command: 'npm run test',
      resultEnvVar: 'TESTS_RESULT',
      logFile: 'tests.log',
      inputDir,
      env,
    }),
    buildCommand({
      name: 'build',
      command: 'npm run build',
      resultEnvVar: 'BUILD_RESULT',
      logFile: 'build.log',
      inputDir,
      env,
    }),
  ];

  const patch = readIfExists(join(inputDir, 'pr.diff'));
  const pullRequestNumber = env.PR_NUMBER ? Number(env.PR_NUMBER) : null;

  return {
    pipeline: {
      repository: env.GITHUB_REPOSITORY ?? 'unknown/unknown',
      branch: env.GITHUB_REF_NAME ?? 'unknown',
      commitSha: env.GITHUB_SHA ?? 'unknown',
      environment: env.DEPLOY_ENVIRONMENT ?? 'staging',
      trigger: env.GITHUB_EVENT_NAME ?? 'unknown',
      isRollback: env.DEPLOY_ROLLBACK === 'true',
      pullRequestNumber,
      workflow: env.GITHUB_WORKFLOW ?? 'ci',
      runId: env.GITHUB_RUN_ID ?? null,
    },
    commands,
    diff: { files: diffFiles(patch), patch },
  };
}

async function main() {
  const env = process.env;
  const inputDir = resolve(env.CI_INPUT_DIR ?? join(REPO_ROOT, 'reports', 'input'));
  const outDir = resolve(env.CI_OUTPUT_DIR ?? join(REPO_ROOT, 'reports'));

  const source = buildCiSource({ inputDir, env });
  const { diagnosis, policy } = await analyzePipeline({ source });
  const { jsonPath, markdownPath } = writeReports({ diagnosis, policy, outDir });

  process.stdout.write(
    `[pipeline-guardian] diagnóstico gerado — status: ${diagnosis.pipelineStatus}, decisão: ${diagnosis.deployDecision}\n` +
      `[pipeline-guardian] ${jsonPath}\n[pipeline-guardian] ${markdownPath}\n`,
  );

  // O comentário de PR é um efeito colateral secundário: o diagnóstico já foi
  // gravado e publicado como artefato antes desta chamada. Uma falha aqui
  // (ex.: PR de fork com GITHUB_TOKEN restrito a leitura) não deve derrubar o
  // job inteiro nem seu exit code.
  try {
    const commentResult = await upsertPullRequestComment({
      diagnosis,
      repository: diagnosis.repository,
      pullRequestNumber: source.pipeline.pullRequestNumber,
      token: env.GITHUB_TOKEN,
      dryRun: !isPullRequestCommentEnabled(env),
      outFile: join(outDir, 'pr-comment.md'),
    });

    process.stdout.write(
      `[pipeline-guardian] comentário de PR: ${commentResult.action} — ${commentResult.reason ?? commentResult.url}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[pipeline-guardian] não foi possível publicar o comentário de PR: ${redactSecrets(String(error.message))}\n`,
    );
  }

  // O diagnóstico é informativo: quem decide o resultado do pipeline é o
  // job `ci-gate`, a partir dos resultados brutos de quality/tests/build.
  // O job `diagnose` não falha por causa da decisão de deploy.
}

// `buildCiSource` é reusado pelo deploy assistido (`deploy-assessment.mjs`):
// importar este módulo não pode disparar o diagnóstico.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `[pipeline-guardian] erro no diagnose: ${redactSecrets(String(error.stack ?? error.message))}\n`,
    );
    process.exitCode = 1;
  });
}
