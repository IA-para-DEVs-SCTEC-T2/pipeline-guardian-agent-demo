/**
 * Explicação da anomalia — Dia 2.
 *
 * A detecção já aconteceu (`simple-anomaly-detector.mjs`). Este módulo pega o
 * resultado pronto e produz **texto**: resumo, evidências, causa provável,
 * ações e limitações.
 *
 * Reusa a infraestrutura do Dia 1 em vez de recriá-la — `openai-config`,
 * `openai-client`, `redact-secrets`, `sanitize-log` e `ground-evidence`. Não
 * existe um segundo cliente OpenAI neste repositório, e não deve passar a
 * existir: timeout, `store: false`, tradução de erro em categoria e validação
 * por schema já estão resolvidos em um lugar só.
 *
 * Duas invariantes:
 *
 * 1. **O modelo não recebe campo que possa virar decisão.** `anomalyDetected`,
 *    `anomalyType`, `firstAnomalousSignal` e `gateResult` entram no payload
 *    como fato para ser explicado, e o schema de saída (`modelExplanationSchema`)
 *    sequer os expõe. Não há como uma resposta do modelo mudar o veredito:
 *    quem monta o relatório final copia a detecção, não a explicação.
 * 2. **Sem chave, ou com qualquer falha da chamada, a explicação continua
 *    existindo.** O fallback determinístico é montado a partir dos mesmos
 *    números e é sempre a resposta quando o modelo não pôde responder.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { groundEvidenceAgainst } from './ground-evidence.mjs';
import { callStructuredModel, classifyModelError, createOpenAIClient } from './openai-client.mjs';
import {
  PAYLOAD_LIMITS,
  TRUNCATION_LIMITATION,
  capText,
  emptyModelCallMetadata,
  resolveOpenAIConfig,
} from './openai-config.mjs';
import { redactSecrets, redactSecretsDeep } from './redact-secrets.mjs';
import { sanitizeLog } from './sanitize-log.mjs';
import { SIGNAL_LABELS, THRESHOLDS } from './simple-anomaly-detector.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = resolve(HERE, '..');
const PROMPT_PATH = join(AUTOMATION_ROOT, 'prompts', 'simple-anomaly-explanation.md');

/** Teto de trechos de log enviados ao modelo. */
export const MAX_LOG_EXCERPTS = 5;

/** Teto de caracteres por trecho. */
export const MAX_EXCERPT_LENGTH = 240;

/**
 * O recorte que o modelo pode produzir.
 *
 * Sem `.optional()` e sem `.default()` — o structured output da OpenAI exige
 * JSON Schema estrito. `probableCause` é anulável porque "não há causa a
 * apontar" precisa ser dizível (e é a resposta correta quando não houve
 * anomalia).
 */
export const modelExplanationSchema = z.object({
  summary: z.string(),
  evidence: z.array(z.string()),
  probableCause: z.string().nullable(),
  recommendedActions: z.array(z.string()),
  limitations: z.array(z.string()),
});

/** Limitação declarada em toda execução do laboratório. */
export const LAB_LIMITATION =
  'A medição é de laboratório: 30 requisições sequenciais na máquina local, sem tráfego concorrente ' +
  'e sem rede externa. Ela mostra mudança de comportamento, não capacidade em produção.';

/**
 * Normaliza os trechos de log: sanitiza, mascara, corta e limita a quantidade.
 *
 * A partir daqui só circula conteúdo mascarado.
 *
 * @param {Array<string|{ source?: string, excerpt?: string, text?: string }>} excerpts
 * @returns {Array<{ source: string, excerpt: string }>}
 */
export function prepareLogExcerpts(excerpts = []) {
  const prepared = [];
  const seen = new Set();

  for (const entry of excerpts) {
    const source = typeof entry === 'string' ? 'log:aplicação' : String(entry.source ?? 'log:aplicação');
    const raw = typeof entry === 'string' ? entry : String(entry.excerpt ?? entry.text ?? '');
    const clean = redactSecrets(sanitizeLog(raw).trim()).slice(0, MAX_EXCERPT_LENGTH);

    const key = `${source}::${clean}`;
    if (clean.length === 0 || seen.has(key)) continue;

    seen.add(key);
    prepared.push({ source, excerpt: clean });
    if (prepared.length >= MAX_LOG_EXCERPTS) break;
  }

  return prepared;
}

/**
 * Payload enviado ao modelo: já mascarado, restrito e limitado em tamanho.
 *
 * @param {object} input
 * @param {object} input.detection resultado determinístico
 * @param {Array<{ source: string, excerpt: string }>} [input.excerpts]
 * @param {object} [input.context] métricas contextuais (não decidem nada)
 * @returns {{ payload: string, limitations: string[] }}
 */
export function buildExplanationRequest({ detection, excerpts = [], context = {} }) {
  const limitations = [];

  const payload = {
    route: detection.route ?? '/api/report',
    // Fato já decidido. O modelo descreve; não revisa. Ver o cabeçalho.
    deterministicResult: {
      anomalyDetected: detection.anomalyDetected,
      anomalyType: detection.anomalyType,
      firstAnomalousSignal: detection.firstAnomalousSignal,
      gateResult: detection.gateResult,
      triggeredRules: detection.triggeredRules,
    },
    baseline: detection.baseline,
    observed: detection.observed,
    signals: detection.evaluations?.map((evaluation) => ({
      signal: evaluation.signal,
      label: evaluation.label,
      baseline: evaluation.baseline,
      observed: evaluation.observed,
      difference: evaluation.difference,
      ratio: evaluation.ratio,
      ratioRule: evaluation.ratioRule,
      absoluteRule: evaluation.absoluteRule,
      triggered: evaluation.triggered,
    })) ?? [],
    contextMetrics: {
      note: 'Contexto. Não decidem a presença de anomalia.',
      ...context,
    },
    logExcerpts: excerpts,
  };

  const serialized = redactSecrets(JSON.stringify(payload, null, 2));
  const capped = capText(serialized, PAYLOAD_LIMITS.maxTotalChars);
  if (capped.truncated) limitations.push(TRUNCATION_LIMITATION);

  return { payload: capped.text, limitations };
}

/**
 * Explicação determinística — a que existe sem modelo nenhum.
 *
 * É montada dos mesmos números da detecção. Não é um texto de desculpa: é a
 * resposta padrão do laboratório, e o aluno consegue fazer o dia inteiro sem
 * chave nenhuma.
 *
 * @param {object} input
 * @param {object} input.detection
 * @param {Array<{ source: string, excerpt: string }>} [input.excerpts]
 * @returns {object} explicação no formato de `modelExplanationSchema`
 */
export function buildDeterministicExplanation({ detection, excerpts = [] }) {
  const evidence = (detection.evaluations ?? []).map(
    (evaluation) =>
      `${evaluation.label}: baseline ${evaluation.baseline}, observado ${evaluation.observed} ` +
      `(diferença ${evaluation.difference}; ${evaluation.ratio === null ? 'razão indefinida' : `razão ${evaluation.ratio}x`}).`,
  );

  for (const excerpt of excerpts.slice(0, MAX_LOG_EXCERPTS)) {
    evidence.push(`${excerpt.source}: ${excerpt.excerpt}`);
  }

  if (!detection.anomalyDetected) {
    return {
      summary:
        'Nenhuma regra foi acionada: os dois sinais observados ficaram dentro dos limites da baseline. ' +
        'O comportamento medido é compatível com o normal.',
      evidence,
      // Sem anomalia não há causa nem ação. Um texto prestativo aqui ensinaria
      // a procurar problema onde as regras não encontraram nenhum.
      probableCause: null,
      recommendedActions: [],
      limitations: [LAB_LIMITATION],
    };
  }

  const signal = detection.firstAnomalousSignal;
  const evaluation = (detection.evaluations ?? []).find((item) => item.signal === signal) ?? null;
  const threshold = THRESHOLDS[signal] ?? { ratio: 3, absolute: 0, unit: '' };
  const label = SIGNAL_LABELS[signal] ?? signal;

  return {
    summary:
      `Anomalia de \`${detection.anomalyType}\` detectada em \`${signal}\` (${label}): ` +
      `a baseline é ${evaluation?.baseline ?? '—'} e o valor observado é ${evaluation?.observed ?? '—'}, ` +
      `acima do limite relativo (${threshold.ratio}× a baseline) e do limite absoluto ` +
      `(${threshold.absolute} ${threshold.unit}).`,
    evidence,
    probableCause: PROBABLE_CAUSE_BY_TYPE[detection.anomalyType] ?? null,
    recommendedActions: RECOMMENDED_ACTIONS_BY_TYPE[detection.anomalyType] ?? [],
    limitations: [
      LAB_LIMITATION,
      'Explicação gerada por regras, sem modelo de linguagem: ela descreve a comparação que disparou a ' +
        'regra, não a alteração de código que a causou.',
    ],
  };
}

/** Hipóteses padrão do fallback. Declaradas como hipótese, nunca como certeza. */
const PROBABLE_CAUSE_BY_TYPE = {
  latency:
    'Hipótese: algo no caminho de `GET /api/report` passou a esperar — espera artificial, chamada externa ' +
    'lenta ou trabalho síncrono novo antes da resposta. A distribuição intermitente (parte das requisições ' +
    'rápidas, parte lentas) aponta para uma condição que só vale para algumas requisições.',
  'log-volume':
    'Hipótese: a rota passou a emitir linhas de log adicionais por requisição — log de depuração esquecido, ' +
    'emissão dentro de um laço ou mudança do nível de log.',
};

const RECOMMENDED_ACTIONS_BY_TYPE = {
  latency: [
    'Confirmar a medição: rodar `npm run anomaly:check` outra vez e verificar se o p95 se mantém no mesmo patamar.',
    'Comparar `latencyMinMs` e `latencyMaxMs` com a baseline para saber se todas as requisições ficaram lentas ou só parte delas.',
    'Procurar, no caminho de `GET /api/report`, espera explícita (`setTimeout`, `await` novo) ou trabalho síncrono adicionado recentemente.',
    'Remover ou corrigir a alteração e medir de novo até `anomalyDetected` voltar a ser `false`.',
  ],
  'log-volume': [
    'Confirmar a medição: rodar `npm run anomaly:check` outra vez e verificar se as linhas por requisição se mantêm.',
    'Listar os `eventType` presentes no log da rota e identificar qual deles aparece em excesso.',
    'Procurar emissão de log dentro de laço ou log de depuração deixado no caminho da requisição.',
    'Remover as linhas excedentes e medir de novo até `anomalyDetected` voltar a ser `false`.',
  ],
};

/**
 * Chama o modelo com saída estruturada validada por Zod.
 *
 * @param {object} input
 * @returns {Promise<{ explanation: object, metadata: object, limitations: string[] }>}
 */
export async function explainWithModel({
  detection,
  excerpts = [],
  context = {},
  env = process.env,
  client = null,
  config = null,
}) {
  const resolved = config ?? resolveOpenAIConfig(env);
  const openai = client ?? (await createOpenAIClient({ env, config: resolved }));
  const { payload, limitations } = buildExplanationRequest({ detection, excerpts, context });

  const { parsed, metadata } = await callStructuredModel({
    client: openai,
    config: resolved,
    instructions: readFileSync(PROMPT_PATH, 'utf8'),
    input: payload,
    schema: modelExplanationSchema,
    schemaName: 'anomaly_explanation',
  });

  return { explanation: parsed, metadata, limitations };
}

/**
 * Funde a saída do modelo com o que é fato.
 *
 * O texto é do modelo; as evidências passam pela ancoragem do Dia 1 (o que não
 * existe no material coletado é descartado) e a ausência de causa/ação em
 * execução sem anomalia é imposta aqui — um modelo prestativo produz
 * "considere monitorar X" para qualquer medição verde.
 *
 * @param {object} input
 * @returns {object} explicação
 */
export function mergeModelExplanation({ detection, explanation, excerpts = [], deterministic }) {
  const model = redactSecretsDeep(explanation);
  const limitations = [...model.limitations, LAB_LIMITATION];

  // Ancoragem: o material é o que foi realmente enviado — os trechos de log e a
  // comparação numérica. O que o modelo citar fora disso não sustenta nada.
  const material = [
    ...excerpts.map((excerpt) => ({ source: excerpt.source, content: excerpt.excerpt })),
    { source: 'medição', content: JSON.stringify({ baseline: detection.baseline, observed: detection.observed, evaluations: detection.evaluations }) },
    { source: 'regras', content: (detection.triggeredRules ?? []).join('\n') },
  ];

  const grounded = groundEvidenceAgainst(
    model.evidence.map((item) => ({ source: 'modelo', excerpt: item })),
    material,
  );

  if (grounded.dropped > 0) {
    limitations.push(
      `${grounded.dropped} evidência(s) citada(s) pelo modelo não foram encontradas no material coletado e ` +
        'foram descartadas.',
    );
  }

  const evidence = grounded.evidence.length > 0
    ? grounded.evidence.map((item) => item.excerpt)
    : deterministic.evidence;

  let probableCause = model.probableCause;
  let recommendedActions = model.recommendedActions;

  if (!detection.anomalyDetected && (probableCause || recommendedActions.length > 0)) {
    // Mesma regra do Dia 1 para execução verde: sucesso não gera causa nem
    // recomendação, e a saída descartada vira limitação declarada.
    limitations.push(
      'Causa provável e ações sugeridas pelo modelo foram descartadas: nenhuma regra foi acionada, ' +
        'e uma medição dentro da baseline não tem causa a apontar.',
    );
    probableCause = null;
    recommendedActions = [];
  }

  return {
    summary: model.summary,
    evidence,
    probableCause,
    recommendedActions,
    limitations: unique(limitations),
  };
}

/**
 * Explica a detecção — com modelo quando houver chave, por regras quando não.
 *
 * @param {object} input
 * @param {object} input.detection resultado determinístico
 * @param {Array} [input.excerpts] trechos de log (crus ou já preparados)
 * @param {object} [input.context] métricas contextuais
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {object} [input.client] cliente OpenAI injetável (testes)
 * @returns {Promise<{ explanation: object, source: 'openai'|'fallback',
 *                     sourceLabel: string, usedFallback: boolean,
 *                     modelCall: object, excerpts: Array }>}
 */
export async function explainAnomaly({
  detection,
  excerpts = [],
  context = {},
  env = process.env,
  client = null,
} = {}) {
  const prepared = prepareLogExcerpts(excerpts);
  const deterministic = buildDeterministicExplanation({ detection, excerpts: prepared });
  const config = resolveOpenAIConfig(env);

  if (!config.enabled) {
    return {
      explanation: withNotes(deterministic, config.notes),
      source: 'fallback',
      sourceLabel: 'fallback determinístico — OPENAI_API_KEY não configurada',
      usedFallback: true,
      modelCall: emptyModelCallMetadata(config),
      excerpts: prepared,
    };
  }

  try {
    const result = await explainWithModel({ detection, excerpts: prepared, context, env, client, config });
    const merged = mergeModelExplanation({
      detection,
      explanation: result.explanation,
      excerpts: prepared,
      deterministic,
    });

    return {
      explanation: withNotes(
        { ...merged, limitations: unique([...merged.limitations, ...result.limitations]) },
        config.notes,
      ),
      source: 'openai',
      sourceLabel: 'OpenAI',
      usedFallback: false,
      modelCall: result.metadata,
      excerpts: prepared,
    };
  } catch (error) {
    // Rede, chave inválida, timeout, recusa ou saída fora do schema: a falha do
    // modelo não pode apagar a detecção. Só a categoria é publicada.
    const category = classifyModelError(error);

    return {
      explanation: withNotes(
        {
          ...deterministic,
          limitations: [
            ...deterministic.limitations,
            `A chamada ao modelo não foi concluída (categoria: \`${category}\`); a explicação abaixo é a determinística.`,
          ],
        },
        config.notes,
      ),
      source: 'fallback',
      sourceLabel: `fallback determinístico — falha na chamada ao modelo (categoria: ${category})`,
      usedFallback: true,
      modelCall: emptyModelCallMetadata(config, category),
      excerpts: prepared,
    };
  }
}

/**
 * @param {object} explanation
 * @param {string[]} notes
 * @returns {object}
 */
function withNotes(explanation, notes = []) {
  if (notes.length === 0) return explanation;
  return { ...explanation, limitations: unique([...explanation.limitations, ...notes]) };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
