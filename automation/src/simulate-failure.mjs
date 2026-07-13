/**
 * Simulação de execuções de pipeline a partir dos fixtures.
 *
 * Produz o mesmo formato de contexto que o modo real (`--fixture` vs. execução
 * de comandos), para que o agente não saiba a diferença — e para que os testes
 * sejam determinísticos, sem rede e sem CI de verdade.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures');

export const SCENARIOS = [
  'lint',
  'test',
  'dependency',
  'build',
  'environment',
  'permission',
  'security',
  'unknown',
];

/**
 * Quais comandos rodaram, em que ordem e qual falhou — o log do fixture é
 * anexado ao comando que falhou.
 */
const SCENARIO_PIPELINES = {
  lint: {
    failing: { name: 'lint', command: 'npm run lint', exitCode: 1, durationMs: 4210 },
    passed: [{ name: 'install', command: 'npm ci', exitCode: 0, durationMs: 18400 }],
    skipped: [
      { name: 'test', command: 'npm run test' },
      { name: 'build', command: 'npm run build' },
    ],
  },
  test: {
    failing: { name: 'test', command: 'npm run test', exitCode: 1, durationMs: 9130 },
    passed: [
      { name: 'install', command: 'npm ci', exitCode: 0, durationMs: 17900 },
      { name: 'lint', command: 'npm run lint', exitCode: 0, durationMs: 3980 },
    ],
    skipped: [{ name: 'build', command: 'npm run build' }],
  },
  dependency: {
    failing: { name: 'smoke', command: 'node backend/src/server.js', exitCode: 1, durationMs: 620 },
    passed: [{ name: 'install', command: 'npm ci --omit=dev', exitCode: 0, durationMs: 12300 }],
    skipped: [{ name: 'build', command: 'npm run build' }],
  },
  build: {
    failing: { name: 'build', command: 'npm run build', exitCode: 1, durationMs: 5040 },
    passed: [
      { name: 'install', command: 'npm ci', exitCode: 0, durationMs: 18100 },
      { name: 'lint', command: 'npm run lint', exitCode: 0, durationMs: 4020 },
      { name: 'test', command: 'npm run test', exitCode: 0, durationMs: 8870 },
    ],
    skipped: [],
  },
  environment: {
    failing: { name: 'smoke', command: 'node backend/src/server.js', exitCode: 1, durationMs: 540 },
    passed: [
      { name: 'install', command: 'npm ci', exitCode: 0, durationMs: 17600 },
      { name: 'lint', command: 'npm run lint', exitCode: 0, durationMs: 3910 },
      { name: 'test', command: 'npm run test', exitCode: 0, durationMs: 8650 },
      { name: 'build', command: 'npm run build', exitCode: 0, durationMs: 5120 },
    ],
    skipped: [],
  },
  permission: {
    failing: { name: 'install', command: 'npm ci --workspaces', exitCode: 243, durationMs: 2100 },
    passed: [],
    skipped: [
      { name: 'lint', command: 'npm run lint' },
      { name: 'test', command: 'npm run test' },
      { name: 'build', command: 'npm run build' },
    ],
  },
  security: {
    failing: { name: 'secret-scan', command: 'npm run scan:secrets', exitCode: 1, durationMs: 1480 },
    passed: [{ name: 'install', command: 'npm ci', exitCode: 0, durationMs: 18200 }],
    skipped: [
      { name: 'lint', command: 'npm run lint' },
      { name: 'test', command: 'npm run test' },
      { name: 'build', command: 'npm run build' },
    ],
  },
  unknown: {
    failing: { name: 'ci', command: 'npm run ci', exitCode: 137, durationMs: 24830 },
    passed: [{ name: 'install', command: 'npm ci', exitCode: 0, durationMs: 19100 }],
    skipped: [],
  },
};

const BASE_PIPELINE = {
  repository: 'senai/copa-figurinhas',
  branch: 'feat/ordenar-figurinhas',
  commitSha: 'c0f4a17b93e2d5486ab1e77c2d9f4b6a0e3c81df',
  environment: 'staging',
  trigger: 'pull_request',
  isRollback: false,
  pullRequestNumber: 42,
  workflow: 'ci',
  runId: '17734920881',
};

/**
 * Lê um log de fixture.
 *
 * @param {string} scenario
 * @returns {string}
 */
export function readFixtureLog(scenario) {
  const path = join(FIXTURES_DIR, 'logs', `${scenario}.log`);
  if (!existsSync(path)) {
    throw new Error(`Fixture de log não encontrado para o cenário "${scenario}": ${path}`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * Lê o diff do cenário; cai no diff padrão quando não houver um específico.
 *
 * @param {string} scenario
 * @returns {string}
 */
export function readFixtureDiff(scenario) {
  const specific = join(FIXTURES_DIR, 'diffs', `${scenario}.diff`);
  const path = existsSync(specific) ? specific : join(FIXTURES_DIR, 'diffs', 'default.diff');
  return readFileSync(path, 'utf8');
}

/**
 * Monta o contexto de execução de um cenário.
 *
 * @param {string} scenario um de `SCENARIOS`
 * @param {object} [overrides] sobrescreve campos do pipeline (ex.: environment)
 * @returns {{ pipeline: object, commands: Array<object>, diff: object }}
 */
export function simulateFailure(scenario, overrides = {}) {
  if (!SCENARIOS.includes(scenario)) {
    throw new Error(
      `Cenário desconhecido: "${scenario}". Disponíveis: ${SCENARIOS.join(', ')}.`,
    );
  }

  const plan = SCENARIO_PIPELINES[scenario];
  const log = readFixtureLog(scenario);
  const patch = readFixtureDiff(scenario);

  const commands = [
    ...plan.passed.map((command) => ({ ...command, log: `${command.command}: OK\n` })),
    { ...plan.failing, log },
    ...plan.skipped.map((command) => ({ ...command, exitCode: null, log: '' })),
  ];

  return {
    pipeline: { ...BASE_PIPELINE, ...overrides },
    commands,
    diff: {
      files: diffFiles(patch),
      patch,
    },
  };
}

/**
 * Simula um pipeline verde (todos os comandos passaram) — o caminho feliz da
 * política de deploy.
 *
 * @param {object} [overrides]
 * @returns {{ pipeline: object, commands: Array<object>, diff: object }}
 */
export function simulateSuccess(overrides = {}) {
  const patch = readFixtureDiff('default');
  const commands = [
    { name: 'install', command: 'npm ci', exitCode: 0, durationMs: 18000, log: 'added 512 packages\n' },
    { name: 'lint', command: 'npm run lint', exitCode: 0, durationMs: 3900, log: 'sem problemas\n' },
    { name: 'test', command: 'npm run test', exitCode: 0, durationMs: 8800, log: 'Tests 20 passed (20)\n' },
    { name: 'build', command: 'npm run build', exitCode: 0, durationMs: 5100, log: 'built in 1.20s\n' },
  ];

  return {
    pipeline: { ...BASE_PIPELINE, ...overrides },
    commands,
    diff: { files: diffFiles(patch), patch },
  };
}

/**
 * Extrai a lista de arquivos alterados de um patch unificado.
 *
 * @param {string} patch
 * @returns {Array<{ path: string, status: string, additions: number, deletions: number }>}
 */
export function diffFiles(patch) {
  const files = [];
  let current = null;

  for (const line of patch.split('\n')) {
    const header = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
    if (header) {
      current = { path: header[2], status: 'modified', additions: 0, deletions: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1;
  }

  return files;
}
