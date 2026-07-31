/**
 * Diagnóstico operacional — CI, deployment e runtime em um relatório só.
 *
 * Mesma infraestrutura dos outros dois agentes, outro material: onde
 * `analyze-deployment.mjs` lê apenas o log do smoke test, este lê o contexto
 * agregado por `collect-operational-context.mjs` — logs do CI, logs internos do
 * Railway (build, deploy, runtime), log do smoke test e os fatos do sistema.
 *
 * Nada é recriado: sanitização, redação, redução de log, ancoragem de
 * evidências, cliente da OpenAI, categorização de erro e o padrão de degradação
 * vêm dos módulos que já existiam. O que é novo é o **vocabulário** (fases de
 * CI a runtime) e a **reconciliação**.
 *
 * A reconciliação é o coração do arquivo e existe por cinco regras:
 *
 *   1. `technicalStatus` **não** é produzido pelo modelo — ele sequer aparece em
 *      `modelOperationalDiagnosisSchema`.
 *   2. `affectedPhase` do modelo é conferida contra os fatos: num fluxo
 *      aprovado ela vira `success`; num reprovado ela nunca pode ser `success`.
 *   3. Fato citado que não existe no material é **removido** (`groundEvidence`).
 *   4. Inferência cujo `supportedBy` não aponta para fato sobrevivente é
 *      removida, e a remoção vira limitação declarada.
 *   5. Causa é qualificada por força (`causeStrength`), não afirmada como raiz.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  modelOperationalDiagnosisSchema,
  operationalDiagnosisSchema,
} from '../schemas/operational-diagnosis-schema.mjs';
import { groundEvidenceAgainst } from './ground-evidence.mjs';
import { callStructuredModel, classifyModelError, createOpenAIClient } from './openai-client.mjs';
import {
  PAYLOAD_LIMITS,
  TRUNCATION_LIMITATION,
  canUseModel,
  capText,
  emptyModelCallMetadata,
  resolveOpenAIConfig,
} from './openai-config.mjs';
import { buildDeterministicOperationalDiagnosis } from './operational-classifier.mjs';
import { redactSecrets, redactSecretsDeep } from './redact-secrets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(AUTOMATION_ROOT, '..');
const PROMPT_PATH = join(AUTOMATION_ROOT, 'prompts', 'operational-analysis.md');

const MAX_FACTS = 10;
const MAX_EXCERPT_LENGTH = 240;

export { canUseModel };

/**
 * Payload enviado ao modelo — bloco (F) do contexto: já mascarado, reduzido e
 * limitado em tamanho.
 *
 * `technicalStatus` entra como **fato para descrever**, não como campo a
 * preencher. É a mesma escolha de `analyze-deployment.mjs`: o modelo precisa
 * saber o resultado para explicá-lo, e não tem como sobrescrevê-lo porque o
 * schema de saída não expõe o campo.
 *
 * @param {object} input
 * @returns {{ payload: string, limitations: string[] }}
 */
export function buildOperationalModelRequest({ context, deterministic }) {
  const limitations = [];

  const textSources = context.textSources.map((entry) => {
    const capped = capText(entry.content, PAYLOAD_LIMITS.maxLogChars);
    if (capped.truncated) limitations.push(TRUNCATION_LIMITATION);
    return { source: entry.source, phase: entry.phase, content: capped.text };
  });

  const payload = {
    release: {
      repository: context.metadata.repository,
      commitSha: context.metadata.commitSha,
      deploymentId: context.metadata.deploymentId,
      service: context.metadata.service,
      environment: context.metadata.environment,
      targetHost: context.metadata.targetHost,
    },
    // Fatos do sistema. O modelo descreve; não revisa.
    technicalStatus: context.technicalStatus,
    correlation: context.correlation,
    sourceCoverage: context.sourceCoverage,
    systemFacts: context.systemFacts,
    timeline: context.timeline.slice(0, 120).map((event) => ({
      phase: event.phase,
      source: event.source,
      timestamp: event.timestamp,
      level: event.level,
      message: event.message,
    })),
    textSources,
    collectedLimitations: context.limitations,
    deterministicClassifier: {
      affectedPhase: deterministic.affectedPhase,
      note: 'Sinal auxiliar por padrões. Discorde dele se as evidências indicarem outra coisa.',
    },
  };

  const serialized = redactSecrets(JSON.stringify(payload, null, 2));
  const capped = capText(serialized, PAYLOAD_LIMITS.maxTotalChars);
  if (capped.truncated) limitations.push(TRUNCATION_LIMITATION);

  return { payload: capped.text, limitations: unique(limitations) };
}

/**
 * Chama a Responses API com saída estruturada validada por Zod.
 *
 * @param {object} input
 * @returns {Promise<{ modelDiagnosis: object, metadata: object, limitations: string[] }>}
 */
export async function analyzeOperationalWithModel({
  context,
  deterministic,
  env = process.env,
  client = null,
  config = null,
}) {
  const resolved = config ?? resolveOpenAIConfig(env);
  const openai = client ?? (await createOpenAIClient({ env, config: resolved }));
  const { payload, limitations } = buildOperationalModelRequest({ context, deterministic });

  const { parsed, metadata } = await callStructuredModel({
    client: openai,
    config: resolved,
    instructions: readFileSync(PROMPT_PATH, 'utf8'),
    input: payload,
    schema: modelOperationalDiagnosisSchema,
    schemaName: 'operational_diagnosis',
  });

  return { modelDiagnosis: parsed, metadata, limitations };
}

/**
 * Confere os fatos citados pelo modelo contra o material coletado.
 *
 * Sobrevive o fato cujo trecho **existe** no material. O resto é descartado —
 * e o descarte é contado, porque um modelo que inventou três citações precisa
 * aparecer no relatório como tal, não sumir em silêncio.
 *
 * Os `id` são reatribuídos em sequência depois da filtragem, e o mapa de
 * renomeação é devolvido para que `supportedBy` continue apontando para o fato
 * certo: sem isso, remover `F2` faria toda inferência que citava `F3` passar a
 * apontar para o fato errado.
 *
 * @param {object} input
 * @returns {{ facts: Array<object>, dropped: number, idMap: Map<string, string> }}
 */
export function groundObservedFacts({ facts = [], textSources = [] }) {
  const grounded = groundEvidenceAgainst(
    facts.map((fact) => ({ source: fact.source, excerpt: fact.excerpt, original: fact })),
    textSources,
  );

  const idMap = new Map();
  const kept = grounded.evidence.slice(0, MAX_FACTS).map((entry, index) => {
    const fact = entry.original;
    const id = `F${index + 1}`;
    idMap.set(fact.id, id);

    return {
      id,
      source: redactSecrets(String(fact.source)),
      phase: fact.phase,
      timestamp: fact.timestamp ?? null,
      excerpt: redactSecrets(String(fact.excerpt)).slice(0, MAX_EXCERPT_LENGTH),
    };
  });

  return { facts: kept, dropped: facts.length - kept.length, idMap };
}

/**
 * Mantém apenas inferências apoiadas por fatos que sobreviveram.
 *
 * Uma inferência que cita `F7` depois de `F7` ter sido descartado não é "quase
 * certa": ela perdeu a única coisa que a distinguia de um chute. Vai embora, e
 * a remoção é declarada.
 *
 * @param {object} input
 * @returns {{ inferences: Array<object>, dropped: number }}
 */
export function groundInferences({ inferences = [], facts = [], idMap = new Map() }) {
  const validIds = new Set(facts.map((fact) => fact.id));

  const kept = [];
  for (const inference of inferences) {
    const supportedBy = (inference.supportedBy ?? [])
      .map((id) => idMap.get(id) ?? id)
      .filter((id) => validIds.has(id));

    if (supportedBy.length === 0) continue;

    kept.push({
      statement: redactSecrets(String(inference.statement)),
      supportedBy: [...new Set(supportedBy)],
      confidence: inference.confidence,
    });
  }

  return { inferences: kept, dropped: inferences.length - kept.length };
}

/**
 * Funde a saída do modelo com o que foi observado.
 *
 * O modelo descreve; os fatos (status técnico, fase conciliada, evidência
 * ancorada, cobertura, correlação) continuam do sistema.
 *
 * @param {object} input
 * @returns {object}
 */
export function mergeModelOperationalDiagnosis({ modelDiagnosis, deterministic, context }) {
  const model = redactSecretsDeep(modelDiagnosis);
  const limitations = [...model.limitations];

  const { facts, dropped: droppedFacts, idMap } = groundObservedFacts({
    facts: model.observedFacts,
    textSources: context.textSources,
  });

  if (droppedFacts > 0) {
    limitations.push(
      `${droppedFacts} fato(s) citado(s) pelo modelo não foram encontrados no material coletado e foram descartados.`,
    );
  }

  const { inferences, dropped: droppedInferences } = groundInferences({
    inferences: model.inferences,
    facts,
    idMap,
  });

  if (droppedInferences > 0) {
    limitations.push(
      `${droppedInferences} inferência(s) do modelo foram removidas por não se apoiarem em nenhum fato observado válido.`,
    );
  }

  // Sem fato sobrevivente, o relatório usa os fatos do coletor: um diagnóstico
  // sem nenhuma evidência seria só uma opinião bem formatada.
  const finalFacts = facts.length > 0 ? facts : deterministic.observedFacts;
  const finalInferences = facts.length > 0 ? inferences : deterministic.inferences;

  // A fase é conciliada com o resultado técnico — o fato prevalece e a
  // divergência aparece. É o que impede um modelo otimista de aprovar um
  // deployment quebrado e um alarmista de reprovar um saudável.
  let affectedPhase = model.affectedPhase;
  const overall = context.technicalStatus.overall;

  if (overall === 'success' && affectedPhase !== 'success') {
    limitations.push(
      `Fase apontada pelo modelo (\`${affectedPhase}\`) descartada: os gates técnicos aprovaram esta release.`,
    );
    affectedPhase = 'success';
  }
  if (overall === 'failure' && affectedPhase === 'success') {
    limitations.push(
      'Fase apontada pelo modelo (`success`) descartada: um gate técnico reprovou esta release.',
    );
    affectedPhase = deterministic.affectedPhase;
  }

  // Num fluxo aprovado, não existe causa a apontar — nem se o modelo quiser.
  const probableCause = overall === 'success' ? null : model.probableCause;
  let causeStrength = overall === 'success' ? 'unavailable' : model.causeStrength;
  if (causeStrength !== 'unavailable' && !probableCause) causeStrength = 'unavailable';

  // Nem recomendação. Um modelo prestativo produz "considere monitorar X" para
  // qualquer release verde; publicar isso ensina a turma a procurar problema
  // onde os gates não encontraram nenhum.
  const recommendedActions = overall === 'success' ? [] : model.recommendedActions;
  if (overall === 'success' && model.recommendedActions.length > 0) {
    limitations.push(
      `${model.recommendedActions.length} recomendação(ões) do modelo foram descartadas: ` +
        'os gates técnicos aprovaram esta release e não há problema a corrigir.',
    );
  }

  return {
    summary: model.summary,
    affectedPhase,
    observedFacts: finalFacts,
    inferences: finalInferences,
    probableCause,
    causeStrength,
    recommendedActions,
    limitations: unique(limitations),
  };
}

/**
 * Análise ponta a ponta do fluxo operacional.
 *
 * @param {object} input
 * @param {object} input.context contexto de `buildOperationalContext`
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {object} [input.client] cliente OpenAI injetável (testes)
 * @returns {Promise<{ diagnosis: object, deterministic: object }>}
 */
export async function analyzeOperational({
  context,
  env = process.env,
  now = () => new Date(),
  client = null,
  requestId,
} = {}) {
  const deterministic = buildDeterministicOperationalDiagnosis({ context });
  const config = resolveOpenAIConfig(env);

  let core = deterministic;
  let usedFallback = true;
  let modelCall = emptyModelCallMetadata(config);
  let fallbackNote = 'Sem `OPENAI_API_KEY`: diagnóstico produzido pelo classificador determinístico.';
  let payloadLimitations = [];

  if (config.enabled) {
    try {
      const result = await analyzeOperationalWithModel({ context, deterministic, env, client, config });
      core = mergeModelOperationalDiagnosis({
        modelDiagnosis: result.modelDiagnosis,
        deterministic,
        context,
      });
      payloadLimitations = result.limitations;
      modelCall = result.metadata;
      usedFallback = false;
      fallbackNote = null;
    } catch (error) {
      // Rede, chave inválida, timeout, recusa ou saída fora do schema: a falha
      // do modelo não pode esconder — nem inventar — a falha da release. Só a
      // categoria é publicada; a mensagem bruta do SDK, nunca.
      const category = classifyModelError(error);
      fallbackNote =
        `Falha na análise com modelo (categoria: \`${category}\`): a análise com o modelo não foi ` +
        'concluída; foi utilizado o classificador determinístico.';
      modelCall = emptyModelCallMetadata(config, category);
      core = deterministic;
      usedFallback = true;
    }
  }

  const limitations = unique([
    ...core.limitations,
    ...context.limitations,
    ...payloadLimitations,
    ...config.notes,
    ...(fallbackNote ? [fallbackNote] : []),
  ]);

  const diagnosis = operationalDiagnosisSchema.parse(
    redactSecretsDeep({
      analysisId: randomUUID(),
      requestId: requestId ?? env.REQUEST_ID ?? randomUUID(),
      repository: context.metadata.repository,
      commitSha: context.metadata.commitSha,
      deploymentId: context.metadata.deploymentId,
      service: context.metadata.service,
      environment: context.metadata.environment,
      targetHost: context.metadata.targetHost,

      technicalStatus: context.technicalStatus,
      affectedPhase: core.affectedPhase,

      summary: core.summary,
      observedFacts: core.observedFacts,
      inferences: core.inferences,
      probableCause: core.probableCause,
      causeStrength: core.causeStrength,
      recommendedActions: core.recommendedActions,
      limitations,

      sourceCoverage: {
        ciLint: context.sourceCoverage.ciLint,
        ciTests: context.sourceCoverage.ciTests,
        ciBuild: context.sourceCoverage.ciBuild,
        ciDocker: context.sourceCoverage.ciDocker,
        railwayBuild: context.sourceCoverage.railwayBuild,
        railwayDeploy: context.sourceCoverage.railwayDeploy,
        railwayRuntime: context.sourceCoverage.railwayRuntime,
        smokeTest: context.sourceCoverage.smokeTest,
      },
      correlationStatus: context.correlation.status,
      expectedCommitSha: context.correlation.expectedCommitSha,
      observedCommitSha: context.correlation.observedCommitSha,

      usedFallback,
      ...modelCall,
      generatedAt: now().toISOString(),
    }),
  );

  return { diagnosis, deterministic };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
