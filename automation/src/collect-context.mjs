/**
 * Ferramentas de coleta de contexto.
 *
 * Cada função tem uma responsabilidade e pode ser usada isoladamente pelo
 * agente. `collectContext` apenas as orquestra na ordem correta:
 * ler → inspecionar → escanear → mascarar → montar evidências.
 *
 * Invariante: nada sai daqui sem passar por `redactSecrets`. A detecção de
 * segredos roda no conteúdo original; tudo o que é devolvido já está mascarado.
 */

import { detectSecrets, redactSecrets } from './redact-secrets.mjs';
import { sanitizeLog } from './sanitize-log.mjs';

const MAX_LOG_LINES = 80;
const MAX_DIFF_LINES = 200;
const MAX_EVIDENCE_ITEMS = 5;
const MAX_EXCERPT_LENGTH = 240;
/** Linhas curtas demais (ex.: "- Expected") não sustentam nada: não são evidência. */
const MIN_EXCERPT_LENGTH = 15;

const ERROR_MARKERS =
  /error|failed|failing|fail\b|✕|✗|denied|cannot|could not|not found|missing|warn|exit code|assert/i;

/**
 * Lê e normaliza os metadados do pipeline.
 *
 * @param {object} source contexto bruto da execução
 * @returns {object} metadados normalizados + limitações do que faltou
 */
export function readPipelineMetadata(source = {}) {
  const pipeline = source.pipeline ?? {};
  const limitations = [];

  const required = ['repository', 'branch', 'commitSha'];
  for (const field of required) {
    if (!pipeline[field]) {
      limitations.push(`Metadado \`${field}\` ausente no contexto do pipeline.`);
    }
  }

  const environment = normalizeEnvironment(pipeline.environment);
  if (environment === 'unknown') {
    limitations.push('Ambiente alvo do deploy não informado.');
  }

  return {
    repository: redactSecrets(pipeline.repository ?? 'unknown/unknown'),
    branch: redactSecrets(pipeline.branch ?? 'unknown'),
    commitSha: redactSecrets(pipeline.commitSha ?? 'unknown'),
    environment,
    trigger: pipeline.trigger ?? 'unknown',
    isRollback: Boolean(pipeline.isRollback),
    pullRequestNumber: pipeline.pullRequestNumber ?? null,
    workflow: pipeline.workflow ?? 'ci',
    runId: pipeline.runId ?? null,
    limitations,
  };
}

/**
 * Lê os logs dos comandos executados, mascarados e reduzidos aos trechos
 * relevantes (cabeçalho, linhas com marcadores de erro e cauda).
 *
 * @param {object} source
 * @returns {Array<object>} comandos com `log` mascarado e `rawLog` preservado
 *                          apenas para o scanner de segredos
 */
export function readCommandLogs(source = {}) {
  const commands = Array.isArray(source.commands) ? source.commands : [];

  return commands.map((command) => {
    const rawLog = sanitizeLog(typeof command.log === 'string' ? command.log : '');
    const { text, truncated } = selectRelevantLines(rawLog, MAX_LOG_LINES);

    return {
      name: command.name ?? command.command ?? 'unknown',
      command: redactSecrets(command.command ?? 'unknown'),
      exitCode: command.exitCode ?? null,
      status: commandStatus(command.exitCode),
      durationMs: command.durationMs ?? null,
      log: redactSecrets(text),
      truncated,
      rawLog,
    };
  });
}

/**
 * Lê o diff da Pull Request, mascarado e truncado.
 *
 * @param {object} source
 * @returns {{ files: Array<object>, patch: string, truncated: boolean, available: boolean, rawPatch: string }}
 */
export function readPullRequestDiff(source = {}) {
  const diff = source.diff ?? {};
  const rawPatch = sanitizeLog(typeof diff.patch === 'string' ? diff.patch : '');
  const files = Array.isArray(diff.files) ? diff.files : [];
  const { text, truncated } = selectRelevantLines(rawPatch, MAX_DIFF_LINES);

  return {
    files: files.map((file) => ({
      path: redactSecrets(file.path ?? 'unknown'),
      status: file.status ?? 'modified',
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    })),
    patch: redactSecrets(text),
    truncated,
    available: rawPatch.length > 0 || files.length > 0,
    rawPatch,
  };
}

/**
 * Deriva o status do pipeline dos códigos de saída — não de uma opinião.
 *
 * @param {Array<object>} commands
 * @returns {{ pipelineStatus: string, failedCommands: Array<object>, passedCommands: Array<object>, skippedCommands: Array<object> }}
 */
export function inspectCommandResults(commands = []) {
  const failedCommands = commands.filter((command) => command.status === 'failed');
  const passedCommands = commands.filter((command) => command.status === 'passed');
  const skippedCommands = commands.filter((command) => command.status === 'skipped');

  let pipelineStatus;
  if (commands.length === 0) pipelineStatus = 'partial';
  else if (failedCommands.length > 0) pipelineStatus = 'failed';
  else if (skippedCommands.length > 0) pipelineStatus = 'partial';
  else pipelineStatus = 'success';

  return { pipelineStatus, failedCommands, passedCommands, skippedCommands };
}

/**
 * Procura dados sensíveis no conteúdo ORIGINAL (antes da redação).
 *
 * @param {Array<{ source: string, content: string }>} sources
 * @returns {{ hasSensitiveData: boolean, findings: Array<{ source: string, rule: string, count: number }> }}
 */
export function scanForSensitiveData(sources = []) {
  const findings = [];

  for (const { source, content } of sources) {
    for (const finding of detectSecrets(content)) {
      findings.push({ source, ...finding });
    }
  }

  return { hasSensitiveData: findings.length > 0, findings };
}

/**
 * Monta a lista de evidências: trechos reais, com a fonte de onde vieram.
 * Sem evidência inventada — cada item aponta para uma linha que existe.
 *
 * @param {object} input
 * @returns {Array<{ source: string, excerpt: string }>}
 */
export function buildEvidenceList({ matches = [], commands = [], diff, sensitive } = {}) {
  const evidence = [];
  const seen = new Set();

  const push = (source, excerpt) => {
    const cleanExcerpt = redactSecrets(String(excerpt).trim()).slice(0, MAX_EXCERPT_LENGTH);
    const key = `${source}::${cleanExcerpt}`;
    if (!cleanExcerpt || seen.has(key) || evidence.length >= MAX_EVIDENCE_ITEMS) return;
    seen.add(key);
    evidence.push({ source, excerpt: cleanExcerpt });
  };

  if (sensitive?.hasSensitiveData) {
    for (const finding of sensitive.findings) {
      push(
        `scanner:${finding.source}`,
        `Conteúdo sensível detectado (regra ${finding.rule}, ${finding.count} ocorrência(s)); valor mascarado.`,
      );
    }
  }

  for (const match of matches) {
    if (match.excerpt.length < MIN_EXCERPT_LENGTH) continue;
    push(`${match.source}:${match.line}`, match.excerpt);
  }

  for (const command of commands) {
    if (command.status === 'failed') {
      push(`command:${command.name}`, `\`${command.command}\` terminou com exit code ${command.exitCode}.`);
    }
  }

  if (diff?.files?.length) {
    const summary = diff.files
      .slice(0, 5)
      .map((file) => `${file.path} (+${file.additions}/-${file.deletions})`)
      .join(', ');
    push('diff:files', `Arquivos alterados na Pull Request: ${summary}.`);
  }

  return evidence;
}

/**
 * Orquestra as ferramentas e devolve o contexto pronto para o agente.
 *
 * @param {object} source
 * @returns {object}
 */
export function collectContext(source = {}) {
  const metadata = readPipelineMetadata(source);
  const commands = readCommandLogs(source);
  const diff = readPullRequestDiff(source);
  const results = inspectCommandResults(commands);

  const sensitive = scanForSensitiveData([
    ...commands.map((command) => ({ source: `log:${command.name}`, content: command.rawLog })),
    { source: 'diff', content: diff.rawPatch },
  ]);

  const limitations = [...metadata.limitations];
  if (commands.length === 0) limitations.push('Logs de comando ausentes no contexto coletado.');
  if (!diff.available) limitations.push('Diff da Pull Request não disponível.');
  if (commands.some((command) => command.truncated) || diff.truncated) {
    limitations.push('Logs longos foram reduzidos aos trechos relevantes (cabeçalho, erros e final).');
  }

  // A partir daqui, só conteúdo mascarado circula.
  // `textSources`: tudo o que foi coletado — usado para ancorar as evidências
  // citadas pelo modelo. `failureSources`: só os logs de quem falhou — é o que
  // o classificador de padrões pode ler.
  const textSources = [
    ...commands.map((command) => ({ source: `log:${command.name}`, content: command.log })),
    { source: 'diff', content: diff.patch },
  ];

  const failureSources = commands
    .filter((command) => command.status === 'failed')
    .map((command) => ({ source: `log:${command.name}`, content: command.log }));

  return {
    metadata,
    commands: commands.map(({ rawLog: _rawLog, ...command }) => command),
    diff: { files: diff.files, patch: diff.patch, truncated: diff.truncated, available: diff.available },
    results,
    sensitive,
    textSources,
    failureSources,
    limitations,
  };
}

function commandStatus(exitCode) {
  if (exitCode === null || exitCode === undefined) return 'skipped';
  return exitCode === 0 ? 'passed' : 'failed';
}

function normalizeEnvironment(environment) {
  const value = String(environment ?? '').toLowerCase();
  if (['production', 'prod'].includes(value)) return 'production';
  if (['staging', 'stage', 'homolog'].includes(value)) return 'staging';
  if (value) return value;
  return 'unknown';
}

/**
 * Reduz um texto longo preservando o que importa: as primeiras linhas, as
 * linhas com marcadores de erro e as últimas linhas.
 */
function selectRelevantLines(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, truncated: false };

  const headSize = Math.floor(maxLines * 0.2);
  const tailSize = Math.floor(maxLines * 0.3);
  const keep = new Set();

  for (let index = 0; index < headSize; index += 1) keep.add(index);
  for (let index = lines.length - tailSize; index < lines.length; index += 1) keep.add(index);

  for (let index = 0; index < lines.length; index += 1) {
    if (keep.size >= maxLines) break;
    if (ERROR_MARKERS.test(lines[index])) keep.add(index);
  }

  const kept = [...keep].sort((a, b) => a - b);
  const output = [];
  let previous = -1;

  for (const index of kept) {
    if (previous !== -1 && index > previous + 1) {
      output.push(`... (${index - previous - 1} linha(s) omitida(s))`);
    }
    output.push(lines[index]);
    previous = index;
  }

  return { text: output.join('\n'), truncated: true };
}
