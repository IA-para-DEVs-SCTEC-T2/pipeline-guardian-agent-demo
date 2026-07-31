/**
 * A execução do pipeline vista **por etapa** — o modelo unificado do Dia 1.
 *
 * Este módulo responde três perguntas, e só elas:
 *
 *   1. Em que situação está cada etapa? (`deriveStageStatuses`)
 *   2. Qual foi a **primeira** etapa a falhar? (`determineFirstFailedStage`)
 *   3. O que se explica sobre ela — ou, num fluxo verde, o que se resume?
 *      (`buildPipelineExecution`)
 *
 * Nenhuma linha aqui chama modelo. A entrada é o contexto agregado
 * (`collect-operational-context.mjs`) e o diagnóstico já conciliado
 * (`analyze-operational.mjs`); a saída é uma projeção determinística deles. O
 * modelo pode ter escrito o texto de `whatHappened`, mas **qual** etapa esse
 * texto descreve é decidido aqui, a partir dos fatos.
 *
 * ## Precedência para nomear a primeira falha
 *
 * A ordem abaixo é a mesma de `operational-classifier.mjs`, aplicada agora ao
 * vocabulário de etapas. Cada degrau existe por um motivo:
 *
 *   1. **Correlação quebrada vence tudo.** Com `mismatch`, os logs de runtime
 *      pertencem a outra release: nenhuma etapa de CD é atribuída ao commit em
 *      análise, todas viram `unknown`, e a primeira falha fica `unknown`. Eleger
 *      uma etapa a partir de log de outro commit seria diagnosticar o software
 *      errado.
 *   2. **Falha do CI vence falha de deployment.** Se o pipeline reprovou, o que
 *      está no ar não é este commit — as etapas de CD viram `not_reached`.
 *   3. **A ordem real do pipeline decide o resto.** `determineFirstFailedStage`
 *      percorre `PIPELINE_STAGES` e devolve a primeira `failure`.
 *   4. **A fase apontada pelo classificador entra como união, nunca como
 *      substituição.** O smoke test enxerga a borda da aplicação; o
 *      classificador, lendo os logs internos, às vezes reconhece uma etapa mais
 *      cedo (o container que nem subiu, por exemplo). Marcar essa etapa também
 *      como `failure` faz a primeira falha ser a mais precoce das duas — e
 *      nunca faz uma etapa observada como saudável virar falha, porque a união
 *      só acrescenta.
 *
 * ## `not_reached` não é `failure`
 *
 * É a distinção que o dia inteiro depende. Uma etapa que nunca começou porque
 * uma anterior reprovou não é uma segunda falha: contá-la assim transformaria
 * um problema em dez e esconderia qual deles precisa ser corrigido.
 * `determineFirstFailedStage` ignora `skipped`, `not_reached` e `unknown`.
 */

import { randomUUID } from 'node:crypto';

import {
  EXECUTION_SCOPES,
  PIPELINE_STAGES,
  STAGE_BY_ID,
  pipelineExecutionSchema,
} from '../schemas/pipeline-execution-schema.mjs';
import { classifyOperationalPhase } from './operational-classifier.mjs';
import { redactSecrets } from './redact-secrets.mjs';

/**
 * Fase do diagnóstico → etapa da execução.
 *
 * Nem toda fase é uma etapa: `success`, `unknown` e `version_mismatch` não
 * nomeiam nada que o pipeline executou, e por isso mapeiam para `null`.
 * `environment` cai em `startup` (a variável falta **no processo subindo**) e
 * `network` cai em `smoke_test` (quem não obteve resposta foi o verificador,
 * não a aplicação — dizer o contrário afirmaria algo que não se observou).
 */
export const PHASE_TO_STAGE = {
  ci_quality: 'ci_quality',
  ci_tests: 'ci_tests',
  ci_build: 'ci_build',
  ci_docker: 'ci_docker',
  railway_build: 'railway_build',
  railway_deploy: 'railway_deploy',
  deployment: 'railway_deploy',
  startup: 'startup',
  environment: 'startup',
  network: 'smoke_test',
  healthcheck: 'healthcheck',
  functional: 'functional',
  runtime: 'functional',
  post_deployment_validation: 'smoke_test',
  version_mismatch: null,
  success: null,
  unknown: null,
};

/** Força da causa → confiança da explicação. Uma escala derivada da outra. */
export const CONFIDENCE_BY_CAUSE_STRENGTH = {
  direct_evidence: 'high',
  probable: 'medium',
  weak_hypothesis: 'low',
  unavailable: 'low',
};

/** Teto do resumo de sucesso: duas frases, e nunca mais que isto. */
export const MAX_SUCCESS_SUMMARY_LENGTH = 320;

/** Marcadores de que o processo chegou a atender, nos logs internos da plataforma. */
const PROCESS_STARTED = /"eventType":"app\.started"|ouvindo na porta|Deployment successful|Healthcheck succeeded/i;

/** Marcadores de erro no log de build da plataforma. */
const BUILD_ERROR = /error|failed|exit code [1-9]/i;

/**
 * `needs.<job>.result` do GitHub Actions → situação da etapa.
 *
 * `cancelled` vira `not_reached`, e não `failure`: um job interrompido não
 * produziu veredito, e tratar interrupção como reprovação faria toda execução
 * cancelada pela concorrência do workflow virar um pipeline quebrado.
 *
 * Tudo o que não é reconhecido vira `unknown` — que **não** é falha.
 *
 * @param {unknown} result
 * @returns {string} um valor de `STAGE_STATUSES`
 */
export function normalizeJobResult(result) {
  const value = String(result ?? '').trim().toLowerCase();
  if (value === 'success') return 'success';
  if (value === 'failure') return 'failure';
  if (value === 'skipped') return 'skipped';
  if (value === 'cancelled') return 'not_reached';
  return 'unknown';
}

/**
 * Situação de cada etapa, a partir dos fatos do sistema.
 *
 * Nenhum campo aqui vem do modelo: resultados de job, códigos HTTP registrados
 * pelo smoke test, status do deployment na plataforma e cobertura das fontes.
 *
 * @param {object} input
 * @param {object} input.context contexto de `buildOperationalContext`
 * @param {'ci'|'cd'} [input.scope]
 * @returns {Record<string, string>} etapa → situação
 */
export function deriveStageStatuses({ context, scope = 'cd' } = {}) {
  const jobs = context?.systemFacts?.ciJobs ?? {};
  const coverage = context?.sourceCoverage ?? {};
  const smoke = context?.systemFacts?.smokeTest ?? {};
  const railway = context?.systemFacts?.railwayDeployment ?? {};
  const smokeStatus = context?.technicalStatus?.smokeTest ?? 'unknown';
  const mismatch = context?.correlation?.status === 'mismatch';

  const statuses = {
    ci_quality: normalizeJobResult(jobs.quality),
    ci_tests: normalizeJobResult(jobs.tests),
    ci_build: normalizeJobResult(jobs.build),
    ci_docker: normalizeJobResult(jobs['docker-build']),
  };

  const ciValues = [statuses.ci_quality, statuses.ci_tests, statuses.ci_build, statuses.ci_docker];
  const ciFailed = ciValues.includes('failure');

  // O gate do CI reproduz exatamente a condição do job `ci-gate` do workflow:
  // tudo verde aprova, qualquer reprovação reprova, e o resto é indeterminado.
  if (ciFailed) statuses.ci_gate = 'failure';
  else if (ciValues.every((value) => value === 'success')) statuses.ci_gate = 'success';
  else statuses.ci_gate = 'unknown';

  const cdStages = ['railway_build', 'railway_deploy', 'startup', 'healthcheck', 'functional', 'smoke_test', 'cd_gate'];

  // Relatório de CI: o deployment ainda não aconteceu. As etapas existem para
  // que a linha do tempo mostre onde o fluxo parou — e todas como `not_reached`,
  // que é a verdade: nenhuma delas começou.
  if (scope === 'ci') {
    for (const stage of cdStages) statuses[stage] = 'not_reached';
    return statuses;
  }

  // Degrau 2: CI reprovado. Nada de CD chegou a rodar para este commit.
  if (ciFailed) {
    for (const stage of cdStages) statuses[stage] = 'not_reached';
    return statuses;
  }

  // Degrau 1: correlação quebrada. Os logs são de outra release; nenhuma
  // afirmação sobre as etapas de CD deste commit se sustenta neles.
  if (mismatch) {
    for (const stage of cdStages) statuses[stage] = 'unknown';
    return statuses;
  }

  const healthPassed = smoke.health?.passed === true;
  const healthFailed = smoke.health?.passed === false;
  const functionalPassed = smoke.functional?.passed === true;
  const functionalRan = Number(smoke.functional?.attempts ?? 0) > 0;
  const railwayFailed = railway.status === 'failed' || railway.status === 'crashed';
  const railwayBuildLog = textFor(context, 'railway:build');
  const failedInBuild = railwayFailed && BUILD_ERROR.test(railwayBuildLog);

  // Uma resposta 200 em `/api/health` é prova direta de que a imagem foi
  // construída, implantada e o processo subiu: sem isso não haveria a quem
  // responder. Vale mais que a ausência dos logs internos da plataforma.
  const deploymentReached = healthPassed || railway.status === 'success';
  const processStarted = deploymentReached || PROCESS_STARTED.test(textFor(context, 'railway:deploy'));

  statuses.railway_build = failedInBuild
    ? 'failure'
    : deploymentReached || coverage.railwayBuild
      ? 'success'
      : 'unknown';

  statuses.railway_deploy = failedInBuild
    ? 'not_reached'
    : railwayFailed
      ? 'failure'
      : deploymentReached || coverage.railwayDeploy
        ? 'success'
        : 'unknown';

  statuses.startup = failedInBuild
    ? 'not_reached'
    : processStarted
      ? 'success'
      : railwayFailed
        ? 'failure'
        : 'unknown';

  statuses.healthcheck = healthPassed
    ? 'success'
    : healthFailed
      ? 'failure'
      : smokeStatus === 'not_executed'
        ? 'not_reached'
        : 'unknown';

  // O smoke test só consulta a rota funcional quando o health passa. Sem
  // tentativa registrada, a etapa não foi alcançada — não foi reprovada.
  statuses.functional = functionalPassed
    ? 'success'
    : functionalRan
      ? 'failure'
      : smoke.functional
        ? 'not_reached'
        : smokeStatus === 'success'
          ? 'success'
          : 'not_reached';

  statuses.smoke_test =
    smokeStatus === 'success'
      ? 'success'
      : smokeStatus === 'failure'
        ? 'failure'
        : smokeStatus === 'not_executed'
          ? 'not_reached'
          : 'unknown';

  // O `cd-gate` do workflow lê **apenas** o resultado do smoke test. Esta linha
  // é a mesma regra, e não pode crescer: qualquer outra entrada aqui seria a IA
  // (ou a plataforma) participando de uma decisão que não é dela.
  statuses.cd_gate =
    smokeStatus === 'success' ? 'success' : smokeStatus === 'failure' ? 'failure' : 'not_reached';

  return statuses;
}

/**
 * A primeira etapa que falhou — determinada por regra, nunca pelo modelo.
 *
 * Percorre as etapas na ordem real do pipeline e devolve a primeira com
 * `failure`. `skipped`, `not_reached` e `unknown` **não** contam como falha.
 *
 * @param {Array<{ stage: string, status: string }>} stages
 * @param {object} [options]
 * @param {string} [options.overallStatus]
 * @returns {string|null} identificador da etapa, `'unknown'` ou `null`
 */
export function determineFirstFailedStage(stages = [], { overallStatus = 'unknown' } = {}) {
  const byId = new Map(stages.map((entry) => [entry.stage, entry.status]));

  for (const { stage } of PIPELINE_STAGES) {
    if (byId.get(stage) === 'failure') return stage;
  }

  // Sem nenhuma falha: `null` quando o resultado técnico é sucesso, e
  // `'unknown'` quando ele é falha mas nenhuma etapa pôde ser responsabilizada.
  // Eleger uma etapa arbitrária para não devolver `unknown` seria apontar um
  // culpado sorteado.
  if (overallStatus === 'failure') return 'unknown';
  return null;
}

/**
 * Monta a lista de etapas, já com evidências e nota de contexto.
 *
 * @param {object} input
 * @returns {Array<object>}
 */
export function buildStages({ context, diagnosis, scope = 'cd' }) {
  const statuses = deriveStageStatuses({ context, scope });

  // Degrau 4 da precedência: a fase apontada pelo classificador determinístico
  // entra como UNIÃO. Ela nunca transforma uma etapa observada como saudável em
  // falha — só acrescenta a etapa que os logs internos acusam e que a
  // observação externa não alcançava.
  const { affectedPhase } = classifyOperationalPhase({ context });
  const affectedStage = PHASE_TO_STAGE[affectedPhase] ?? null;
  const overall = context?.technicalStatus?.overall ?? 'unknown';

  if (
    affectedStage &&
    overall === 'failure' &&
    statuses[affectedStage] !== 'failure' &&
    statuses[affectedStage] !== 'not_reached'
  ) {
    statuses[affectedStage] = 'failure';
  }

  const facts = diagnosis?.observedFacts ?? [];

  return PIPELINE_STAGES.map((entry) => ({
    stage: entry.stage,
    label: entry.label,
    phase: entry.phase,
    scope: entry.scope,
    status: statuses[entry.stage] ?? 'unknown',
    evidenceIds: facts
      .filter((fact) => PHASE_TO_STAGE[fact.phase] === entry.stage)
      .map((fact) => fact.id),
    note: null,
  }));
}

/**
 * Reduz um texto a no máximo duas frases e a um teto de caracteres.
 *
 * Usado só no caminho de sucesso: uma execução saudável não precisa de análise,
 * precisa de confirmação. O corte é por frase para não interromper no meio de
 * uma, e o teto de caracteres é o cinto para a frase única e gigante.
 *
 * @param {unknown} text
 * @param {number} [maxLength]
 * @returns {string}
 */
export function shortenToTwoSentences(text, maxLength = MAX_SUCCESS_SUMMARY_LENGTH) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return '';

  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clean];
  const kept = sentences.slice(0, 2).join('').trim();

  return kept.length > maxLength ? `${kept.slice(0, maxLength - 1).trimEnd()}…` : kept;
}

/**
 * A explicação da falha principal.
 *
 * Recebe o texto já conciliado do diagnóstico — que pode ter vindo do modelo ou
 * do classificador determinístico, com a mesma estrutura nos dois casos — e o
 * amarra à etapa que **o sistema** elegeu. O modelo explica a etapa que lhe é
 * dada; ele não escolhe qual.
 *
 * @param {object} input
 * @returns {object|null}
 */
export function buildFailureExplanation({ diagnosis, stages, firstFailedStage }) {
  if (!firstFailedStage) return null;

  const entry = STAGE_BY_ID.get(firstFailedStage) ?? null;
  const stageEntry = stages.find((item) => item.stage === firstFailedStage) ?? null;

  // Evidência da etapa afetada; sem nenhuma, vale toda a evidência ancorada —
  // um relatório de falha sem citação seria opinião bem formatada.
  const scoped = stageEntry?.evidenceIds ?? [];
  const evidenceIds = scoped.length > 0 ? scoped : (diagnosis.observedFacts ?? []).map((fact) => fact.id);

  const index = PIPELINE_STAGES.findIndex((item) => item.stage === firstFailedStage);
  const notReachedStages =
    index === -1
      ? []
      : stages
          .slice(index + 1)
          .filter((item) => item.status === 'not_reached')
          .map((item) => item.label);

  return {
    stage: firstFailedStage,
    label: entry?.label ?? 'Etapa não identificada',
    phase: diagnosis.affectedPhase,
    whatHappened: diagnosis.summary,
    probableCause: diagnosis.probableCause ?? null,
    causeStrength: diagnosis.causeStrength,
    recommendedActions: diagnosis.recommendedActions ?? [],
    confidence: CONFIDENCE_BY_CAUSE_STRENGTH[diagnosis.causeStrength] ?? 'low',
    evidenceIds,
    limitations: diagnosis.limitations ?? [],
    notReachedStages,
  };
}

/**
 * A execução completa, validada pelo schema.
 *
 * @param {object} input
 * @param {object} input.diagnosis diagnóstico de `analyzeOperational`
 * @param {object} input.context contexto de `buildOperationalContext`
 * @param {'ci'|'cd'} [input.scope]
 * @returns {object} objeto validado por `pipelineExecutionSchema`
 */
export function buildPipelineExecution({ diagnosis, context, scope = 'cd', now = () => new Date() }) {
  const resolvedScope = EXECUTION_SCOPES.includes(scope) ? scope : 'cd';

  // Num relatório de CI, o resultado geral é o do CI: usar o `overall` do
  // diagnóstico faria um CI verde aparecer como `unknown` só porque ainda não
  // houve smoke test — e um CI verde é um fato, não uma dúvida.
  const overallStatus =
    resolvedScope === 'ci' ? context.technicalStatus.ci : context.technicalStatus.overall;

  const stages = buildStages({ context, diagnosis, scope: resolvedScope });
  const firstFailedStage = determineFirstFailedStage(stages, { overallStatus });

  const isFailure = overallStatus === 'failure';

  const gateStage = resolvedScope === 'ci' ? 'ci_gate' : 'cd_gate';
  const gateStatus = stages.find((item) => item.stage === gateStage)?.status ?? 'unknown';

  return pipelineExecutionSchema.parse({
    executionId: randomUUID(),
    scope: resolvedScope,
    repository: diagnosis.repository,
    commitSha: diagnosis.commitSha,
    environment: diagnosis.environment ?? null,

    overallStatus,
    firstFailedStage,
    stages,

    // Falha e sucesso são exclusivos por construção, e não por convenção: um
    // relatório com os dois preenchidos diria duas coisas ao mesmo tempo.
    failureExplanation: isFailure
      ? buildFailureExplanation({ diagnosis, stages, firstFailedStage })
      : null,
    successSummary:
      overallStatus === 'success' ? shortenToTwoSentences(diagnosis.summary) || null : null,

    observedFacts: diagnosis.observedFacts,
    inferences: diagnosis.inferences,

    sourceCoverage: diagnosis.sourceCoverage,
    correlationStatus: diagnosis.correlationStatus,
    expectedCommitSha: diagnosis.expectedCommitSha,
    observedCommitSha: diagnosis.observedCommitSha,

    gate: {
      type: resolvedScope,
      status: GATE_STATUS_BY_STAGE[gateStatus] ?? 'unknown',
      determinedBy: 'deterministic',
    },

    usedFallback: diagnosis.usedFallback,
    limitations: diagnosis.limitations,
    generatedAt: diagnosis.generatedAt ?? now().toISOString(),
  });
}

/** Situação da etapa de gate → vocabulário do gate. */
const GATE_STATUS_BY_STAGE = {
  success: 'approved',
  failure: 'rejected',
  not_reached: 'not_reached',
  skipped: 'not_reached',
  unknown: 'unknown',
};

function textFor(context, source) {
  return redactSecrets(
    String(context?.textSources?.find((entry) => entry.source === source)?.content ?? ''),
  );
}
