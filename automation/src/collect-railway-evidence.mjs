/**
 * Coleta dos logs internos do Railway — build, deploy e runtime.
 *
 * É a peça que responde o que o smoke test nunca conseguiu responder: o que
 * aconteceu **dentro** da plataforma. Até aqui todo diagnóstico do projeto
 * declarava a mesma limitação ("os logs são do smoke test, executado de fora");
 * este módulo é o que permite retirá-la quando a coleta funciona — e mantê-la,
 * explicitamente, quando não funciona.
 *
 * Cinco decisões que valem para quem for evoluir:
 *
 * 1. **Best-effort, sempre exit 0.** Sem token, com CLI ausente, com erro de
 *    autenticação ou com deployment não encontrado, o coletor produz
 *    `collection-metadata.json` declarando o que faltou e termina bem. A coleta
 *    do Railway **não pode reprovar um deployment saudável** — quem reprova é o
 *    smoke test, em outro job.
 * 2. **O bruto nunca sai do `$RUNNER_TEMP`.** A saída da CLI é escrita em
 *    diretório temporário, sanitizada e mascarada, e só então copiada para
 *    `reports/`. Os arquivos brutos são apagados no fim. Nada de `tee`: `tee`
 *    imprime no terminal do Actions ao mesmo tempo em que grava, e o terminal do
 *    Actions vira log público da execução.
 * 3. **O deployment mais recente não é presumido o correto.** Entre o CI e este
 *    job pode ter entrado outro deploy. A correlação usa o SHA quando a
 *    plataforma o fornece e, quando não fornece, declara `partial` em vez de
 *    afirmar correspondência.
 * 4. **Erro da CLI vira categoria.** `stderr` bruto pode carregar URL com
 *    token, e-mail da conta ou id de projeto — nada disso entra em relatório.
 * 5. **O token só existe no ambiente do processo filho.** Ver `railway-cli.mjs`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { scanForSensitiveData } from './collect-context.mjs';
import { parseRailwayLogStream, toJsonl } from './railway-log-parser.mjs';
import { runFirstSupported, runRailwayCommand, RAILWAY_CLI_VERSION } from './railway-cli.mjs';
import { redactSecrets, redactSecretsDeep } from './redact-secrets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(AUTOMATION_ROOT, '..');

/** Teto por fluxo. 300 linhas cobrem um build inteiro e um crash com folga. */
export const MAX_LINES_PER_STREAM = 300;

/**
 * Teto do material sanitizado somado, em caracteres.
 *
 * ~120 KB é o que o enunciado do laboratório pede e é confortavelmente acima do
 * que o modelo recebe (o payload é limitado de novo, e bem antes disso, em
 * `PAYLOAD_LIMITS`). O corte aqui protege o artefato e a memória do runner.
 */
export const MAX_TOTAL_CHARS = 120 * 1024;

/** Estados de correlação entre o commit esperado e o que a plataforma implantou. */
export const CORRELATION_STATUSES = ['matched', 'partial', 'mismatch', 'unknown'];

/**
 * Os três fluxos coletados, cada um com suas alternativas de invocação em ordem
 * de preferência.
 *
 * `byDeployment` é sempre a primeira opção: é a única que garante que os logs
 * são **daquele** deployment. `--latest` entra só como fallback declarado — ele
 * devolve o log do último deploy, que pode não ser o commit em análise, e por
 * isso qualquer uso dele vira limitação no relatório.
 *
 * @param {object} input
 * @returns {Array<{ args: string[], label: string, fallback?: boolean }>}
 */
export function logCandidates({ stream, deploymentId = null, service = null }) {
  const serviceArgs = service ? ['--service', service] : [];
  const streamFlag = { build: ['--build'], deploy: ['--deployment'], runtime: [] }[stream] ?? [];

  const candidates = [];

  if (deploymentId) {
    candidates.push({
      label: `${stream}:by-deployment`,
      args: ['logs', ...streamFlag, '--deployment-id', deploymentId, '--json'],
    });
    candidates.push({
      label: `${stream}:by-deployment-positional`,
      args: ['logs', deploymentId, ...streamFlag, '--json'],
    });
  }

  candidates.push({
    label: `${stream}:service-json`,
    args: ['logs', ...streamFlag, ...serviceArgs, '--json'],
    fallback: true,
  });
  candidates.push({
    label: `${stream}:service-plain`,
    args: ['logs', ...streamFlag, ...serviceArgs],
    fallback: true,
  });

  return candidates;
}

/** Alternativas para listar deployments. */
export function deploymentListCandidates({ service = null } = {}) {
  const serviceArgs = service ? ['--service', service] : [];
  return [
    { label: 'deployments:list-json', args: ['deployment', 'list', '--json', ...serviceArgs] },
    { label: 'deployments:plural-json', args: ['deployments', '--json', ...serviceArgs] },
    { label: 'deployments:status-json', args: ['status', '--json'] },
  ];
}

/**
 * Extrai a lista de deployments de qualquer uma das formas de saída conhecidas.
 *
 * A CLI já devolveu array na raiz, `{ deployments: [...] }` e um objeto de
 * status com o serviço aninhado. Em vez de um `if` por versão, procura-se o
 * primeiro array de objetos que pareça deployment.
 *
 * @param {string} stdout
 * @returns {{ deployments: Array<object>, parsed: boolean }}
 */
export function extractDeployments(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return { deployments: [], parsed: false };
  }

  const found = [];

  const visit = (node, depth = 0) => {
    if (depth > 6 || node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (looksLikeDeployment(item)) found.push(item);
        else visit(item, depth + 1);
      }
      return;
    }

    if (looksLikeDeployment(node)) found.push(node);
    for (const value of Object.values(node)) visit(value, depth + 1);
  };

  visit(data);
  return { deployments: found, parsed: true };
}

function looksLikeDeployment(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  const hasId = keys.some((key) => /^(id|deploymentId)$/i.test(key));
  const hasSignal = keys.some((key) => /(status|state|meta|commit|createdAt)/i.test(key));
  return hasId && hasSignal;
}

/**
 * Lê o SHA de um deployment, olhando os nomes já vistos na API/CLI.
 *
 * @param {object} deployment
 * @returns {string|null}
 */
export function readDeploymentSha(deployment = {}) {
  const candidates = [
    deployment.commitSha,
    deployment.commitHash,
    deployment.sha,
    deployment.meta?.commitSha,
    deployment.meta?.commitHash,
    deployment.metadata?.commitSha,
    deployment.snapshot?.commitSha,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim())) return value.trim().toLowerCase();
  }
  return null;
}

/**
 * Dois SHAs se referem ao mesmo commit?
 *
 * Aceita abreviação: o Railway às vezes devolve 7 ou 12 caracteres onde o
 * GitHub deu 40. Exige **no mínimo 7** de prefixo comum — abaixo disso a
 * colisão deixa de ser improvável o bastante para sustentar uma afirmação.
 *
 * @param {string|null} left
 * @param {string|null} right
 * @returns {boolean}
 */
export function sameCommit(left, right) {
  if (!left || !right) return false;
  const a = String(left).trim().toLowerCase();
  const b = String(right).trim().toLowerCase();
  const size = Math.min(a.length, b.length, 40);
  if (size < 7) return false;
  return a.slice(0, size) === b.slice(0, size);
}

/**
 * Escolhe o deployment correspondente ao commit esperado.
 *
 * A ordem importa e é o coração da Parte 2:
 *
 *   1. algum deployment declara o SHA esperado → `matched`;
 *   2. há SHA declarado, e nenhum bate → `mismatch` (a versão no ar não é a
 *      esperada, e isso precisa gritar no relatório);
 *   3. nenhum deployment declara SHA → `partial`, usando o mais recente como
 *      **hipótese** apoiada por id, branch e horário — nunca como certeza;
 *   4. lista vazia ou ilegível → `unknown`.
 *
 * @param {object} input
 * @returns {{ deployment: object|null, correlationStatus: string,
 *             observedCommitSha: string|null, limitations: string[] }}
 */
export function correlateDeployment({ deployments = [], expectedCommitSha = null } = {}) {
  const limitations = [];

  if (deployments.length === 0) {
    return {
      deployment: null,
      correlationStatus: 'unknown',
      observedCommitSha: null,
      limitations: [
        'Nenhum deployment foi listado pela Railway CLI: não foi possível correlacionar a release observada com o commit esperado.',
      ],
    };
  }

  const withSha = deployments
    .map((deployment) => ({ deployment, sha: readDeploymentSha(deployment) }))
    .filter((entry) => entry.sha !== null);

  if (expectedCommitSha && withSha.length > 0) {
    const match = withSha.find((entry) => sameCommit(entry.sha, expectedCommitSha));
    if (match) {
      return {
        deployment: match.deployment,
        correlationStatus: 'matched',
        observedCommitSha: match.sha,
        limitations,
      };
    }

    // O mais recente COM sha é a melhor descrição do que está no ar.
    const newest = withSha[0];
    return {
      deployment: newest.deployment,
      correlationStatus: 'mismatch',
      observedCommitSha: newest.sha,
      limitations: [
        `O deployment observado na plataforma (commit \`${short(newest.sha)}\`) não é o commit esperado ` +
          `(\`${short(expectedCommitSha)}\`). Os logs coletados podem ser de outra release.`,
      ],
    };
  }

  const newest = deployments[0];
  const observed = readDeploymentSha(newest);

  if (!expectedCommitSha) {
    limitations.push(
      'Nenhum commit esperado foi informado à coleta: a correspondência entre os logs e a release em análise não pôde ser verificada.',
    );
  } else {
    limitations.push(
      'O Railway não informou o commit dos deployments listados: a correlação usa deployment ID, branch e horário como evidência auxiliar e é **parcial**.',
    );
  }

  return {
    deployment: newest,
    correlationStatus: 'partial',
    observedCommitSha: observed,
    limitations,
  };
}

/** Identificador do deployment, sob qualquer um dos nomes usados pela CLI. */
export function readDeploymentId(deployment = {}) {
  for (const key of ['id', 'deploymentId', 'deployment_id']) {
    const value = deployment?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Status do deployment, normalizado para o vocabulário do relatório. */
export function readDeploymentStatus(deployment = {}) {
  const raw = String(deployment?.status ?? deployment?.state ?? '').toUpperCase();
  if (!raw) return 'unknown';
  if (/SUCCESS|DEPLOYED|COMPLETE/.test(raw)) return 'success';
  if (/CRASH/.test(raw)) return 'crashed';
  if (/FAIL|ERROR/.test(raw)) return 'failed';
  if (/BUILD|DEPLOY|INITIAL|QUEUE|WAIT/.test(raw)) return 'in_progress';
  if (/REMOV|SKIP|CANCEL/.test(raw)) return 'removed';
  return 'unknown';
}

/**
 * Coleta completa.
 *
 * Tudo é injetável (`run`, `now`) para que os testes exercitem token ausente,
 * CLI quebrada, mismatch de SHA e truncamento sem tocar a rede nem instalar
 * binário nenhum.
 *
 * @param {object} input
 * @returns {Promise<{ metadata: object, streams: object, log: string[] }>}
 */
export async function collectRailwayEvidence({
  env = process.env,
  run = runRailwayCommand,
  now = () => new Date(),
  maxLinesPerStream = MAX_LINES_PER_STREAM,
  maxTotalChars = MAX_TOTAL_CHARS,
  /**
   * Opt-in explícito para tocar a plataforma.
   *
   * Os testes injetam `run` e não passam por aqui; a proteção existe para a
   * linha de comando, onde um `npm run railway:collect` distraído chamaria a
   * API de verdade. O workflow declara `RAILWAY_LIVE_TEST: "true"` de propósito:
   * lá a chamada real é o objetivo, e a declaração deixa isso explícito no YAML
   * em vez de implícito no código.
   */
  requireLiveOptIn = true,
} = {}) {
  const log = [];
  const limitations = [];
  const record = (message) => log.push(redactSecrets(`[${now().toISOString()}] ${message}`));

  const project = readVar(env.RAILWAY_PROJECT);
  const service = readVar(env.RAILWAY_SERVICE);
  const environment = readVar(env.RAILWAY_ENVIRONMENT);
  const expectedCommitSha = readVar(env.EXPECTED_COMMIT_SHA) || readVar(env.GITHUB_SHA);

  const sourceCoverage = { railway: false, railwayBuild: false, railwayDeploy: false, railwayRuntime: false };
  const streams = { build: [], deploy: [], runtime: [] };

  const baseMetadata = () => ({
    schemaVersion: 1,
    collectedAt: now().toISOString(),
    cliVersion: RAILWAY_CLI_VERSION,
    requestedCommitSha: expectedCommitSha ?? null,
    observedCommitSha: null,
    deploymentId: null,
    deploymentStatus: 'unknown',
    service: service ?? null,
    environment: environment ?? null,
    project: project ?? null,
    correlationStatus: 'unknown',
    usedFallbackCommand: false,
    cliErrorCategory: null,
    sourceCoverage,
    limitations,
  });

  record('coleta do Railway iniciada');

  // ---- Sem opt-in: não toca a plataforma ----------------------------------
  if (requireLiveOptIn && readVar(env.RAILWAY_LIVE_TEST) !== 'true') {
    record('RAILWAY_LIVE_TEST diferente de "true": coleta real não executada');
    limitations.push(
      'Os logs internos do Railway não foram coletados: a coleta real exige `RAILWAY_LIVE_TEST=true` ' +
        '(opt-in explícito). O diagnóstico usa apenas as evidências do CI e do smoke test.',
    );

    return { metadata: redactSecretsDeep(baseMetadata()), streams, log };
  }

  // ---- Sem token: encerra bem, declarando a ausência -----------------------
  //
  // Este é o caminho da maioria das execuções em sala de aula (fork sem secret),
  // e ele precisa ser um caminho de primeira classe, não um erro tolerado.
  if (!readVar(env.RAILWAY_TOKEN)) {
    record('RAILWAY_TOKEN ausente: coleta da plataforma não executada');
    limitations.push(
      'Os logs internos do Railway (build, deploy e runtime) não foram coletados: `RAILWAY_TOKEN` não está ' +
        'configurado neste job. O diagnóstico usa apenas as evidências do CI e do smoke test.',
    );

    return { metadata: redactSecretsDeep(baseMetadata()), streams, log };
  }

  record(`Railway CLI fixada na versão ${RAILWAY_CLI_VERSION}`);

  // ---- Vínculo não interativo ---------------------------------------------
  if (project) {
    const linkArgs = ['link', '--project', project];
    if (environment) linkArgs.push('--environment', environment);
    if (service) linkArgs.push('--service', service);

    const linked = await run({ args: linkArgs, env });
    record(
      linked.ok
        ? 'projeto vinculado de forma não interativa'
        : `vínculo do projeto não concluído (categoria: ${linked.errorCategory})`,
    );
    if (!linked.ok && linked.errorCategory === 'not_installed') {
      limitations.push(
        'A Railway CLI não está disponível no runner: nenhum log interno da plataforma foi coletado.',
      );
      const metadata = baseMetadata();
      metadata.cliErrorCategory = 'not_installed';
      return { metadata: redactSecretsDeep(metadata), streams, log };
    }
  } else {
    limitations.push(
      '`RAILWAY_PROJECT` não informado: a coleta dependeu do vínculo já existente no ambiente do runner.',
    );
  }

  // ---- Lista de deployments ------------------------------------------------
  const listing = await runFirstSupported({
    candidates: deploymentListCandidates({ service }),
    run,
    options: { env },
  });

  let correlation = { deployment: null, correlationStatus: 'unknown', observedCommitSha: null, limitations: [] };

  if (listing.ok) {
    const { deployments, parsed } = extractDeployments(listing.stdout);
    record(`lista de deployments obtida (${listing.used.label}): ${deployments.length} encontrado(s)`);

    if (!parsed) {
      limitations.push(
        'A lista de deployments não veio em JSON válido: a correlação com o commit esperado não pôde ser verificada.',
      );
    }

    correlation = correlateDeployment({ deployments, expectedCommitSha });
  } else {
    record(`lista de deployments indisponível (categoria: ${listing.errorCategory})`);
    limitations.push(
      `Não foi possível listar os deployments do Railway (categoria: \`${listing.errorCategory}\`): ` +
        'a release observada não pôde ser correlacionada com o commit esperado.',
    );
    correlation = correlateDeployment({ deployments: [], expectedCommitSha });
  }

  limitations.push(...correlation.limitations);

  const deploymentId = correlation.deployment ? readDeploymentId(correlation.deployment) : null;
  const deploymentStatus = correlation.deployment ? readDeploymentStatus(correlation.deployment) : 'unknown';

  if (deploymentId) record(`deployment correlacionado: ${deploymentId} (${correlation.correlationStatus})`);
  else record(`nenhum deployment identificado (${correlation.correlationStatus})`);

  // ---- Os três fluxos de log ----------------------------------------------
  let usedFallbackCommand = false;
  let charBudget = maxTotalChars;
  let cliErrorCategory = null;

  for (const stream of ['build', 'deploy', 'runtime']) {
    const result = await runFirstSupported({
      candidates: logCandidates({ stream, deploymentId, service }),
      run,
      options: { env },
    });

    if (!result.ok) {
      cliErrorCategory = cliErrorCategory ?? result.errorCategory;
      record(`logs de ${stream}: indisponíveis (categoria: ${result.errorCategory})`);
      limitations.push(
        `Os logs de ${STREAM_LABELS[stream]} do Railway não foram coletados (categoria: \`${result.errorCategory}\`).`,
      );
      continue;
    }

    if (result.used.fallback) {
      usedFallbackCommand = true;
      limitations.push(
        `Os logs de ${STREAM_LABELS[stream]} foram obtidos pelo comando de contingência (\`${result.used.label}\`), ` +
          'que retorna o deployment mais recente do serviço: não há garantia de que sejam do commit em análise.',
      );
    }

    const { events, truncated, totalLines } = parseRailwayLogStream(result.stdout, {
      maxLines: maxLinesPerStream,
    });

    // A detecção roda no material ORIGINAL; a partir daqui só circula mascarado.
    const sensitive = scanForSensitiveData([
      { source: `railway:${stream}`, content: events.map((event) => event.raw).join('\n') },
    ]);
    if (sensitive.hasSensitiveData) {
      limitations.push(
        `Conteúdo sensível foi detectado nos logs de ${STREAM_LABELS[stream]} e mascarado antes de qualquer ` +
          'análise. Revise a origem: um segredo não deveria aparecer em log de plataforma.',
      );
    }

    const masked = events.map((event) => redactSecretsDeep(event));
    const { kept, spent, capped } = applyCharBudget(masked, charBudget);
    charBudget -= spent;

    streams[stream] = kept;
    sourceCoverage[`railway${capitalize(stream)}`] = kept.length > 0;
    sourceCoverage.railway = sourceCoverage.railway || kept.length > 0;

    record(`logs de ${stream}: ${kept.length} linha(s) coletada(s) de ${totalLines}`);

    if (truncated) {
      limitations.push(
        `Os logs de ${STREAM_LABELS[stream]} foram limitados às últimas ${maxLinesPerStream} linhas ` +
          `(de ${totalLines} disponíveis).`,
      );
    }
    if (capped) {
      limitations.push(
        `Os logs de ${STREAM_LABELS[stream]} foram cortados pelo teto total de ${Math.round(maxTotalChars / 1024)} KB ` +
          'de material sanitizado.',
      );
    }
  }

  const metadata = baseMetadata();
  metadata.observedCommitSha = correlation.observedCommitSha;
  metadata.deploymentId = deploymentId;
  metadata.deploymentStatus = deploymentStatus;
  metadata.correlationStatus = correlation.correlationStatus;
  metadata.usedFallbackCommand = usedFallbackCommand;
  metadata.cliErrorCategory = cliErrorCategory;
  metadata.limitations = unique(limitations);

  record('coleta do Railway concluída');

  return { metadata: redactSecretsDeep(metadata), streams, log };
}

/**
 * Grava o resultado da coleta em `reports/railway/`.
 *
 * Só recebe material já mascarado — a gravação não é o lugar de decidir sobre
 * segredo, e um `writeFileSync` que também redigisse seria um convite a esquecer
 * a redação em algum outro caminho.
 *
 * @param {object} input
 * @returns {{ outDir: string, files: string[] }}
 */
export function writeRailwayEvidence({ metadata, streams, log, outDir }) {
  const directory = resolve(outDir ?? join(REPO_ROOT, 'reports', 'railway'));
  mkdirSync(directory, { recursive: true });

  const files = [];
  const write = (name, content) => {
    const path = join(directory, name);
    writeFileSync(path, content, 'utf8');
    files.push(path);
  };

  write('collection-metadata.json', `${JSON.stringify(metadata, null, 2)}\n`);
  write('build.jsonl', toJsonl(streams.build ?? []));
  write('deploy.jsonl', toJsonl(streams.deploy ?? []));
  write('runtime.jsonl', toJsonl(streams.runtime ?? []));
  write('collection.log', `${(log ?? []).join('\n')}\n`);

  return { outDir: directory, files };
}

/**
 * Lê de volta o que a coleta gravou. Usado pelo agregador e pelas fixtures.
 *
 * Ausência de arquivo não é erro: é cobertura zero, declarada como tal.
 *
 * @param {string} directory
 * @returns {{ metadata: object|null, streams: object, available: boolean }}
 */
export function readRailwayEvidence(directory) {
  const base = resolve(directory);
  const metadataPath = join(base, 'collection-metadata.json');

  const streams = { build: [], deploy: [], runtime: [] };
  let metadata = null;

  if (existsSync(metadataPath)) {
    try {
      metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    } catch {
      metadata = null;
    }
  }

  for (const stream of ['build', 'deploy', 'runtime']) {
    const path = join(base, `${stream}.jsonl`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        streams[stream].push(JSON.parse(line));
      } catch {
        // Linha corrompida (arquivo truncado): descartada em silêncio.
      }
    }
  }

  return { metadata, streams, available: metadata !== null };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

const STREAM_LABELS = { build: 'build', deploy: 'deploy/inicialização', runtime: 'runtime' };

/**
 * Corta a lista quando o orçamento de caracteres acaba.
 *
 * @param {Array<object>} events
 * @param {number} budget
 * @returns {{ kept: Array<object>, spent: number, capped: boolean }}
 */
export function applyCharBudget(events, budget) {
  const kept = [];
  let spent = 0;

  for (const event of events) {
    const size = JSON.stringify(event).length;
    if (spent + size > budget) return { kept, spent, capped: true };
    kept.push(event);
    spent += size;
  }

  return { kept, spent, capped: false };
}

function readVar(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : null;
}

function short(sha) {
  return String(sha ?? '').slice(0, 7);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/* ------------------------------------------------------------------------- */
/* CLI                                                                        */
/* ------------------------------------------------------------------------- */

async function main() {
  dotenv.config({ path: [join(AUTOMATION_ROOT, '.env'), join(REPO_ROOT, '.env')], quiet: true });

  const env = process.env;

  // Diretório temporário do runner. O bruto da CLI vive só aqui e é apagado
  // antes de o processo terminar — inclusive quando algo dá errado no meio.
  const scratch = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'railway-raw-'));

  try {
    const { metadata, streams, log } = await collectRailwayEvidence({ env });
    const outDir = env.RAILWAY_OUTPUT_DIR
      ? resolve(env.RAILWAY_OUTPUT_DIR)
      : join(REPO_ROOT, 'reports', 'railway');

    const { files } = writeRailwayEvidence({ metadata, streams, log, outDir });

    // Só o resumo vai para o terminal do Actions. Nenhuma linha de log da
    // plataforma é impressa aqui: o terminal do Actions é público na execução.
    process.stdout.write(
      '[railway-evidence] coleta concluída\n' +
        `  CLI ............. ${metadata.cliVersion}\n` +
        `  cobertura ....... build=${metadata.sourceCoverage.railwayBuild} ` +
        `deploy=${metadata.sourceCoverage.railwayDeploy} runtime=${metadata.sourceCoverage.railwayRuntime}\n` +
        `  deployment ...... ${metadata.deploymentId ?? 'n/d'} (${metadata.deploymentStatus})\n` +
        `  correlação ...... ${metadata.correlationStatus}\n` +
        `  esperado ........ ${metadata.requestedCommitSha ?? 'n/d'}\n` +
        `  observado ....... ${metadata.observedCommitSha ?? 'n/d'}\n` +
        `  limitações ...... ${metadata.limitations.length}\n` +
        `  arquivos ........ ${files.length}\n\n` +
        '  A coleta é best-effort: a ausência de logs da plataforma não reprova o deployment.\n',
    );
  } finally {
    // Sempre: nenhum arquivo bruto sobrevive à execução.
    rmSync(scratch, { recursive: true, force: true });
  }

  // Exit 0 sempre. Ver o cabeçalho do módulo.
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    // Nem uma falha inesperada do coletor pode reprovar o workflow: a mensagem
    // é mascarada, o exit code continua 0 e a ausência vira limitação no
    // agregador (que não encontrará `collection-metadata.json`).
    process.stderr.write(
      `[railway-evidence] coleta interrompida: ${redactSecrets(String(error?.message ?? error))}\n`,
    );
  });
}
