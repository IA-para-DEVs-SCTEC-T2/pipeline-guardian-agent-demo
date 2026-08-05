/**
 * Explicação da observação — a camada de IA do Dia 2.
 *
 * Reusa a infraestrutura do Dia 1 inteira: `openai-config` (uma configuração),
 * `openai-client` (um cliente, uma chamada, erro virando categoria),
 * `redact-secrets` (nada circula sem máscara), `ground-evidence` (citação
 * inventada é descartada) e Zod. O que é novo aqui é o vocabulário — sinais,
 * baseline, regras — e nada mais.
 *
 * Quatro invariantes, e a primeira é a razão de este arquivo existir separado:
 *
 * 1. **O modelo explica um veredito; ele não o produz.**
 *    `modelAnomalyExplanationSchema` sequer expõe `anomalyDetected`,
 *    `anomalyTypes`, `firstAnomalousSignal`, `gateResult` ou `triggeredRules`.
 *    E, porque um modelo pode responder qualquer coisa apesar do schema,
 *    `pickExplanationFields` copia **só** os seis campos permitidos, por nome:
 *    o que vier a mais não é rejeitado com erro, é ignorado. Ausência de porta é
 *    mais forte que porta trancada.
 * 2. **Sem chave, o laboratório continua funcionando.** Sem `OPENAI_API_KEY`,
 *    com erro de rede, 401, 429, timeout ou saída fora do schema, a explicação
 *    vem do gerador determinístico e o relatório sai igual, com
 *    `usedFallback: true`. O painel nunca fica sem texto.
 * 3. **Execução normal não gera causa nem recomendação.** `probableCause` é
 *    `null` e `recommendedActions` é `[]` quando `gateResult` é `pass` — no
 *    fallback e também quando o modelo responde outra coisa (a saída descartada
 *    vira limitação declarada). Um modelo prestativo produz "considere monitorar
 *    a latência" para qualquer execução verde, e publicar isso ensina a procurar
 *    problema onde as regras não encontraram nenhum.
 * 4. **Evidência é conferida contra o material.** O que o modelo cita e não
 *    existe no que ele recebeu é descartado, e a evidência do coletor prevalece.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { groundEvidenceAgainst } from '../ground-evidence.mjs';
import { callStructuredModel, classifyModelError, createOpenAIClient } from '../openai-client.mjs';
import {
  PAYLOAD_LIMITS,
  TRUNCATION_LIMITATION,
  capText,
  emptyModelCallMetadata,
  resolveOpenAIConfig,
} from '../openai-config.mjs';
import { redactSecrets, redactSecretsDeep } from '../redact-secrets.mjs';
import { SIGNAL_STATUS_LABELS } from './detect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = resolve(HERE, '..', '..');
const PROMPT_PATH = join(AUTOMATION_ROOT, 'prompts', 'day-2-anomaly-explanation.md');

/** Teto de evidências publicadas e enviadas ao modelo. */
export const MAX_EVIDENCE_ITEMS = 5;

/** Teto do trecho citado. O relatório é a redução, não o arquivo de log. */
const MAX_EXCERPT_LENGTH = 320;

/**
 * Os **únicos** campos que o modelo pode produzir.
 *
 * Esta lista é o contrato da invariante 1. Acrescentar um nome aqui é decidir
 * que o modelo passa a opinar sobre mais uma coisa — não é ajuste de formato.
 */
export const EXPLANATION_FIELDS = [
  'summary',
  'evidence',
  'interpretation',
  'probableCause',
  'recommendedActions',
  'limitations',
];

/**
 * Limitação estrutural da observação. Vale para **toda** execução, verde ou
 * vermelha: trinta requisições sequenciais de um cliente só contra uma instância
 * local não são medição de carga, e não dizer isso transformaria uma amostra em
 * uma promessa.
 */
export const OBSERVATION_LIMITATION =
  'A observação é de requisições sequenciais feitas por um único cliente contra uma instância local ' +
  'recém-iniciada: ela não mede concorrência, carga sustentada nem o comportamento sob tráfego real.';

/** Um trecho concreto do material observado. Mesma forma do Dia 1. */
export const anomalyEvidenceSchema = z.object({
  source: z.string(),
  excerpt: z.string(),
});

/**
 * O recorte que o modelo pode produzir.
 *
 * Sem `.optional()` e sem `.default()`: o structured output da OpenAI exige JSON
 * Schema estrito, com todas as propriedades obrigatórias.
 */
export const modelAnomalyExplanationSchema = z.object({
  summary: z.string(),
  evidence: z.array(anomalyEvidenceSchema),
  interpretation: z.string(),
  probableCause: z.string().nullable(),
  recommendedActions: z.array(z.string()),
  limitations: z.array(z.string()),
});

/** A explicação publicada, venha do modelo ou do fallback. */
export const anomalyExplanationSchema = modelAnomalyExplanationSchema;

/**
 * Copia **apenas** os seis campos permitidos.
 *
 * É aqui que a invariante 1 é aplicada de fato. Um modelo que devolvesse
 * `"gateResult": "pass"` junto com a explicação teria esse campo simplesmente
 * não copiado — sem erro, sem exceção e sem chance de o valor vazar para o
 * relatório por um espalhamento de objeto distraído mais adiante.
 *
 * @param {object} input
 * @returns {object} objeto com exatamente `EXPLANATION_FIELDS`
 */
export function pickExplanationFields(input = {}) {
  return {
    summary: asText(input.summary),
    evidence: asEvidenceList(input.evidence),
    interpretation: asText(input.interpretation),
    probableCause: typeof input.probableCause === 'string' && input.probableCause.trim().length > 0
      ? input.probableCause.trim()
      : null,
    recommendedActions: asTextList(input.recommendedActions),
    limitations: asTextList(input.limitations),
  };
}

/* ------------------------------------------------------------------------- */
/* Evidências                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Seleciona até cinco linhas do log estruturado.
 *
 * A ordem de prioridade segue a regra do Dia 1: **`level` vence regex**. O nível
 * foi atribuído na origem, pelo próprio código da aplicação, e não depende de a
 * mensagem estar em português nem de o texto casar com um padrão. Só depois do
 * que a aplicação classificou como problema é que entram as linhas
 * representativas — a requisição mais lenta e a maior resposta —, que existem
 * para que uma execução saudável também tenha evidência concreta em vez de um
 * painel com a seção vazia.
 *
 * @param {object} input
 * @param {Array<object>} input.logEvents eventos já interpretados
 * @param {Array<object>} [input.samples] amostras medidas
 * @returns {Array<{ source: string, excerpt: string }>}
 */
export function buildAnomalyEvidence({ logEvents = [], samples = [] } = {}) {
  const evidence = [];
  const seen = new Set();

  const push = (source, value) => {
    if (evidence.length >= MAX_EVIDENCE_ITEMS) return;
    const clean = redactSecrets(String(value ?? '').trim()).slice(0, MAX_EXCERPT_LENGTH);
    if (clean.length === 0 || seen.has(clean)) return;
    seen.add(clean);
    evidence.push({ source, excerpt: clean });
  };

  const line = (event) => JSON.stringify(event);

  // 1. O que a aplicação marcou como erro. 2. O que ela marcou como aviso.
  for (const level of ['error', 'warn']) {
    for (const event of logEvents.filter((item) => item?.level === level)) {
      push(`log:application:${level}`, line(event));
    }
  }

  // 3. As requisições que definem os sinais: a mais lenta e a maior resposta.
  const byRequestId = new Map(
    logEvents
      .filter((event) => typeof event?.requestId === 'string')
      .map((event) => [event.requestId, event]),
  );

  for (const sample of representativeSamples(samples)) {
    const event = byRequestId.get(sample.requestId);
    if (event) push('log:application:representative', line(event));
  }

  // 4. O que sobrar, na ordem em que a aplicação emitiu.
  for (const event of logEvents) {
    push('log:application', line(event));
  }

  return evidence;
}

/**
 * A requisição mais lenta e a de maior resposta — nesta ordem, sem repetir.
 *
 * @param {Array<object>} samples
 * @returns {Array<object>}
 */
export function representativeSamples(samples = []) {
  if (samples.length === 0) return [];

  const slowest = [...samples].sort((a, b) => Number(b.durationMs) - Number(a.durationMs))[0];
  const largest = [...samples].sort(
    (a, b) => Number(b.responseSizeBytes) - Number(a.responseSizeBytes),
  )[0];

  return largest && largest.requestId !== slowest.requestId ? [slowest, largest] : [slowest];
}

/* ------------------------------------------------------------------------- */
/* Explicação determinística                                                  */
/* ------------------------------------------------------------------------- */

/** Hipótese associada a cada tipo de anomalia. Hipótese, não causa confirmada. */
const CAUSE_HYPOTHESES = {
  latency:
    'trabalho adicional no caminho da requisição (espera artificial, operação síncrona custosa ou ' +
    'chamada bloqueante introduzida na rota observada)',
  error_rate:
    'a rota observada passou a falhar de forma sistemática — exceção na regra de negócio ou ' +
    'dependência interna indisponível',
  log_volume:
    'log emitido dentro de um laço ou em nível mais verboso do que o previsto para a rota',
  payload_size:
    'a resposta passou a carregar dados além do necessário — campo agregado, coleção não paginada ' +
    'ou objeto interno serializado por engano',
};

/** Ação associada a cada tipo. Acionável, na ordem de execução. */
const ACTIONS = {
  latency: [
    'Comparar a duração das 30 amostras no painel: um patamar uniforme indica trabalho adicional em toda requisição; picos isolados indicam contenção pontual.',
    'Revisar o que a rota `GET /api/report` passou a executar desde a coleta da baseline.',
  ],
  error_rate: [
    'Ler as linhas de log com `level: "error"` listadas nas evidências e identificar o `errorName`.',
    'Reproduzir a requisição isoladamente com `curl` e confirmar o código HTTP.',
  ],
  log_volume: [
    'Localizar a emissão de log dentro do caminho da rota observada e verificar se ela está em um laço.',
    'Confirmar se o nível de log da rota mudou desde a coleta da baseline.',
  ],
  payload_size: [
    'Comparar o corpo da resposta atual com o tamanho da baseline registrado no painel.',
    'Verificar quais campos foram acrescentados ao relatório e se todos precisam trafegar.',
  ],
};

/**
 * A explicação quando o modelo não é usado — sem chave, ou porque a chamada
 * falhou.
 *
 * Não é uma versão degradada com aviso: é um texto completo, derivado das mesmas
 * regras que produziram o veredito. Quem apresenta a aula sem chave vê o mesmo
 * painel de quem apresenta com ela.
 *
 * @param {object} input
 * @returns {object} explicação nos seis campos
 */
export function buildDeterministicExplanation({ detection, evidence = [], extraLimitations = [] }) {
  const limitations = unique([OBSERVATION_LIMITATION, ...extraLimitations]);

  const readings = detection.evaluations
    .map(
      (item) =>
        `${item.label}: baseline ${formatValue(item)} → observado ${formatValue(item, 'observedValue')} ` +
        `(${SIGNAL_STATUS_LABELS[item.status]})`,
    )
    .join('; ');

  if (!detection.anomalyDetected) {
    return {
      summary:
        'Os quatro sinais observados permanecem dentro da baseline: nenhuma regra de anomalia foi ' +
        'satisfeita nas duas condições exigidas.',
      evidence,
      interpretation: `Leitura dos sinais — ${readings}.`,
      // Invariante 3.
      probableCause: null,
      recommendedActions: [],
      limitations,
    };
  }

  const labels = detection.triggeredRules.map((rule) => rule.label);
  const hypotheses = detection.triggeredRules
    .map((rule) => CAUSE_HYPOTHESES[rule.anomalyType])
    .filter(Boolean);

  return {
    summary:
      `Anomalia detectada em ${labels.length} de 4 sinais (${labels.join(', ')}). ` +
      `O primeiro sinal a disparar foi \`${detection.firstAnomalousSignal}\`.`,
    evidence,
    interpretation:
      `Leitura dos sinais — ${readings}. ` +
      detection.triggeredRules
        .map(
          (rule) =>
            `A regra de ${rule.label.toLowerCase()} disparou porque as duas condições foram satisfeitas: ` +
            `${rule.conditions.map((condition) => stripMarkdown(condition.text)).join(' e ')}.`,
        )
        .join(' '),
    // Hipótese, declarada como hipótese: o classificador determinístico
    // reconhece padrão, e padrão sustenta suspeita, não causa raiz.
    probableCause: `Hipótese a partir do padrão dos sinais (não confirmada pelos dados coletados): ${hypotheses.join('; ')}.`,
    recommendedActions: unique(
      detection.triggeredRules.flatMap((rule) => ACTIONS[rule.anomalyType] ?? []),
    ),
    limitations: unique([
      ...limitations,
      'Explicação produzida pelo gerador determinístico: ela descreve qual regra disparou e propõe uma ' +
        'hipótese a partir do padrão, sem análise do código que produziu o comportamento.',
    ]),
  };
}

/* ------------------------------------------------------------------------- */
/* Chamada ao modelo                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Payload enviado ao modelo: já mascarado, restrito ao necessário e limitado.
 *
 * O veredito vai junto — como **fato**, para ser explicado. O prompt é explícito
 * quanto a isso, e o schema garante que a opinião do modelo sobre ele não teria
 * onde caber.
 *
 * @param {object} input
 * @returns {{ payload: string, textSources: Array<object>, limitations: string[] }}
 */
export function buildExplanationPayload({ baseline, observed, detection, evidence = [], observationLimitations = [] }) {
  const limitations = [];

  const body = {
    baseline: pickSignals(baseline),
    observed: pickSignals(observed),
    // Fato consumado. Ver invariante 1.
    deterministicResult: {
      anomalyDetected: detection.anomalyDetected,
      anomalyTypes: detection.anomalyTypes,
      firstAnomalousSignal: detection.firstAnomalousSignal,
      gateResult: detection.gateResult,
      note: 'Decisão já tomada por regras determinísticas. Explique-a; não a revise.',
    },
    ruleEvaluations: detection.evaluations.map((item) => ({
      signal: item.signal,
      label: item.label,
      baselineValue: item.baselineValue,
      observedValue: item.observedValue,
      difference: item.difference,
      ratio: item.ratio,
      conditions: item.conditions,
      triggered: item.triggered,
      status: item.status,
    })),
    logEvidence: evidence,
    collectedLimitations: unique([OBSERVATION_LIMITATION, ...observationLimitations]),
  };

  const serialized = redactSecrets(JSON.stringify(body, null, 2));
  const capped = capText(serialized, PAYLOAD_LIMITS.maxTotalChars);
  if (capped.truncated) limitations.push(TRUNCATION_LIMITATION);

  // O que o modelo pode citar é exatamente o que ele recebeu — nem mais.
  const textSources = [
    { source: 'payload', content: serialized },
    ...evidence.map((item) => ({ source: item.source, content: item.excerpt })),
  ];

  return { payload: capped.text, textSources, limitations };
}

/**
 * Funde a saída do modelo com o que foi observado.
 *
 * O modelo descreve; o veredito, a evidência ancorada e as limitações da coleta
 * continuam do sistema.
 *
 * @param {object} input
 * @returns {object} explicação nos seis campos
 */
export function mergeModelExplanation({ modelOutput, deterministic, detection, textSources }) {
  // Máscara sobre tudo o que veio da rede, e só os seis campos permitidos.
  const model = pickExplanationFields(redactSecretsDeep(modelOutput));
  const limitations = [...model.limitations, ...deterministic.limitations];

  const { evidence, grounded } = groundEvidenceAgainst(model.evidence, textSources);
  if (!grounded) {
    limitations.push(
      'Evidências citadas pelo modelo não foram encontradas no material coletado; usadas as evidências do coletor.',
    );
  }

  let { probableCause, recommendedActions } = model;

  // Invariante 3: execução normal não gera causa nem recomendação, venha de
  // onde vier o texto.
  if (detection.gateResult === 'pass') {
    if (probableCause !== null || recommendedActions.length > 0) {
      limitations.push(
        'Causa provável e recomendações produzidas pelo modelo foram descartadas: nenhuma regra de ' +
          'anomalia disparou, e uma execução dentro da baseline não tem causa a explicar.',
      );
    }
    probableCause = null;
    recommendedActions = [];
  }

  return {
    summary: model.summary || deterministic.summary,
    evidence: evidence.length > 0 ? evidence : deterministic.evidence,
    interpretation: model.interpretation || deterministic.interpretation,
    probableCause,
    recommendedActions,
    limitations: unique(limitations),
  };
}

/**
 * Explica a observação — com o modelo quando há chave, com as regras quando não.
 *
 * @param {object} input
 * @param {object} input.baseline sinais de referência
 * @param {object} input.observed sinais observados
 * @param {object} input.detection saída de `detectAnomalies`
 * @param {Array<object>} [input.evidence]
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {object} [input.client] cliente OpenAI injetável (testes)
 * @returns {Promise<{ explanation: object, usedFallback: boolean, modelCall: object, fallbackNote: string|null }>}
 */
export async function explainAnomaly({
  baseline,
  observed,
  detection,
  evidence = [],
  observationLimitations = [],
  env = process.env,
  client = null,
  readPrompt = () => readFileSync(PROMPT_PATH, 'utf8'),
} = {}) {
  const config = resolveOpenAIConfig(env);
  const deterministic = buildDeterministicExplanation({
    detection,
    evidence,
    extraLimitations: observationLimitations,
  });

  if (!config.enabled) {
    return {
      explanation: withNotes(deterministic, config.notes),
      usedFallback: true,
      modelCall: emptyModelCallMetadata(config),
      fallbackNote: 'Sem `OPENAI_API_KEY`: explicação produzida pelo gerador determinístico.',
    };
  }

  const { payload, textSources, limitations } = buildExplanationPayload({
    baseline,
    observed,
    detection,
    evidence,
    observationLimitations,
  });

  try {
    const openai = client ?? (await createOpenAIClient({ env, config }));
    const { parsed, metadata } = await callStructuredModel({
      client: openai,
      config,
      instructions: readPrompt(),
      input: payload,
      schema: modelAnomalyExplanationSchema,
      schemaName: 'anomaly_explanation',
    });

    const explanation = mergeModelExplanation({
      modelOutput: parsed,
      deterministic,
      detection,
      textSources,
    });

    return {
      explanation: withNotes(explanation, [...config.notes, ...limitations]),
      usedFallback: false,
      modelCall: metadata,
      fallbackNote: null,
    };
  } catch (error) {
    // Rede, chave inválida, timeout, recusa ou saída fora do schema: a falha do
    // modelo não pode esconder a anomalia. Só a categoria é publicada; a
    // mensagem bruta do SDK, nunca.
    const category = classifyModelError(error);
    return {
      explanation: withNotes(deterministic, config.notes),
      usedFallback: true,
      modelCall: emptyModelCallMetadata(config, category),
      fallbackNote:
        `Falha na chamada ao modelo (categoria: \`${category}\`): explicação produzida pelo ` +
        'gerador determinístico.',
    };
  }
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function withNotes(explanation, notes = []) {
  const extra = notes.filter(Boolean);
  if (extra.length === 0) return explanation;
  return { ...explanation, limitations: unique([...explanation.limitations, ...extra]) };
}

function pickSignals(input = {}) {
  return {
    latencyP95Ms: Number(input.latencyP95Ms) || 0,
    errorRate: Number(input.errorRate) || 0,
    logLinesPerRequest: Number(input.logLinesPerRequest) || 0,
    responseSizeP95Bytes: Number(input.responseSizeP95Bytes) || 0,
    requestCount: Number(input.requestCount ?? input.sampleCount) || 0,
  };
}

function formatValue(evaluation, key = 'baselineValue') {
  const value = evaluation[key];
  const text = evaluation.decimals === 0 ? String(Math.round(value)) : String(value);
  return evaluation.unit ? `${text} ${evaluation.unit}` : text;
}

function stripMarkdown(text) {
  return String(text).replace(/\*\*/g, '');
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asTextList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(asText).filter((item) => item.length > 0);
}

function asEvidenceList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({ source: asText(item.source), excerpt: asText(item.excerpt) }))
    .filter((item) => item.excerpt.length > 0);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
