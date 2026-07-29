/**
 * Cliente OpenAI compartilhado pelos dois diagnósticos (pipeline e deployment).
 *
 * Existe para que não haja duas configurações divergentes da mesma chamada: uma
 * fábrica, um caminho de chamada, uma tradução de erro. Se o timeout mudar, ele
 * muda para os dois agentes ao mesmo tempo.
 *
 * O que este módulo garante:
 *
 * - **Responses API com saída estruturada.** `responses.parse` + `zodTextFormat`
 *   + validação Zod do nosso lado. Não migrar para Chat Completions.
 * - **Requisição independente e sem estado.** `store: false`, sem
 *   `previous_response_id`, sem background mode, sem ferramentas externas.
 * - **Erro vira categoria, não texto bruto.** Nada de mensagem do SDK, header,
 *   corpo de requisição ou stack trace circulando — é por aí que uma
 *   credencial acabaria dentro de um relatório.
 * - **Fábrica, não singleton.** Cada análise cria seu cliente e os testes
 *   injetam o deles. Um cliente global tornaria o isolamento impossível.
 */

import {
  MODEL_PROVIDER,
  MODEL_ERROR_CATEGORIES,
  resolveOpenAIConfig,
} from './openai-config.mjs';

/**
 * Falha da chamada ao modelo, reduzida a uma categoria segura.
 * A mensagem original **não** é preservada, de propósito.
 */
export class ModelCallError extends Error {
  /**
   * @param {string} category uma de `MODEL_ERROR_CATEGORIES`
   */
  constructor(category) {
    const safe = MODEL_ERROR_CATEGORIES.includes(category) ? category : 'unknown';
    super(`falha na chamada ao modelo (${safe})`);
    this.name = 'ModelCallError';
    this.category = safe;
  }
}

/**
 * Traduz qualquer erro em uma categoria segura.
 *
 * A ordem importa: o que é específico (nossa própria exceção, erro de schema,
 * classe do SDK) vem antes do que é genérico (código HTTP, `errno`).
 *
 * @param {unknown} error
 * @returns {string} categoria em `MODEL_ERROR_CATEGORIES`
 */
export function classifyModelError(error) {
  if (error instanceof ModelCallError) return error.category;

  // Saída que não passou no schema — inclusive a recusa do modelo, que chega
  // aqui como resposta sem `output_parsed`.
  if (error?.name === 'ZodError' || Array.isArray(error?.issues)) return 'invalid_output';

  const className = error?.constructor?.name ?? '';
  if (className === 'APIConnectionTimeoutError' || className === 'APIUserAbortError') return 'timeout';
  if (className === 'APIConnectionError') return 'network';

  const status = Number(error?.status);
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  // A API indisponível e a rede quebrada são indistinguíveis daqui: em ambos os
  // casos a requisição não chegou a produzir resposta útil.
  if (status >= 500) return 'network';

  const code = String(error?.code ?? '');
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) {
    return 'timeout';
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH'].includes(code)) {
    return 'network';
  }

  return 'unknown';
}

/**
 * Cria um cliente OpenAI configurado.
 *
 * A chave vai direto do ambiente para o SDK: não passa pela configuração, não é
 * registrada e não é devolvida.
 *
 * @param {object} [input]
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {object} [input.config] configuração já resolvida
 * @param {Function} [input.ctor] construtor injetável (testes)
 * @returns {Promise<object>} cliente pronto para uso
 */
export async function createOpenAIClient({ env = process.env, config = null, ctor = null } = {}) {
  const resolved = config ?? resolveOpenAIConfig(env);
  const OpenAI = ctor ?? (await import('openai')).default;

  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    timeout: resolved.timeoutMs,
    maxRetries: resolved.maxRetries,
  });
}

/**
 * Faz uma chamada estruturada à Responses API e devolve a saída já validada.
 *
 * Qualquer desvio — status diferente de `completed`, ausência de
 * `output_parsed`, schema reprovado, erro de rede — vira `ModelCallError`. Quem
 * chama decide o que fazer com isso; nos dois agentes, a decisão é sempre a
 * mesma: cair no classificador determinístico.
 *
 * @param {object} input
 * @param {object} input.client cliente OpenAI (real ou injetado)
 * @param {object} input.config configuração resolvida
 * @param {string} input.instructions prompt de sistema
 * @param {string} input.input payload do usuário, já mascarado e limitado
 * @param {object} input.schema schema Zod da saída
 * @param {string} input.schemaName nome do schema no structured output
 * @param {() => number} [input.clock] relógio injetável (testes)
 * @returns {Promise<{ parsed: object, metadata: object }>}
 */
export async function callStructuredModel({
  client,
  config,
  instructions,
  input,
  schema,
  schemaName,
  clock = () => Date.now(),
}) {
  const { zodTextFormat } = await import('openai/helpers/zod');
  const startedAt = clock();

  let response;
  try {
    response = await client.responses.parse({
      model: config.model,
      instructions,
      input: [{ role: 'user', content: input }],
      // `gpt-5-mini` é um modelo de raciocínio: o esforço é o botão de custo e
      // latência. `temperature`/`top_p` ficam de fora — não há justificativa
      // técnica para ajustá-los aqui.
      reasoning: { effort: config.reasoningEffort },
      max_output_tokens: config.maxOutputTokens,
      // Sem estado do lado da plataforma. Ver `resolveOpenAIConfig`.
      store: config.store,
      text: { format: zodTextFormat(schema, schemaName) },
    });
  } catch (error) {
    throw new ModelCallError(classifyModelError(error));
  }

  const metadata = {
    modelProvider: MODEL_PROVIDER,
    // O modelo que respondeu, quando informado (pode vir com a data da versão);
    // na falta dele, o que foi pedido.
    model: readModelName(response) ?? config.model,
    modelResponseId: readResponseId(response),
    modelLatencyMs: Math.max(0, Math.round(clock() - startedAt)),
    modelUsage: readUsage(response?.usage),
    modelErrorCategory: null,
  };

  if (response?.status === 'incomplete') throw new ModelCallError('incomplete');
  if (response?.status === 'failed') {
    throw new ModelCallError(response?.error?.code === 'rate_limit_exceeded' ? 'rate_limit' : 'unknown');
  }
  if (response?.status && response.status !== 'completed') throw new ModelCallError('unknown');

  const parsed = response?.output_parsed;
  // Sem saída estruturada: pode ser recusa do modelo ou resposta vazia. Nos dois
  // casos não há o que analisar.
  if (parsed === null || parsed === undefined) throw new ModelCallError('invalid_output');

  // Valida de novo do nosso lado: nunca confiar na forma do que veio da rede.
  const result = schema.safeParse(parsed);
  if (!result.success) throw new ModelCallError('invalid_output');

  return { parsed: result.data, metadata };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Uso de tokens, quando o SDK informar. Campo ausente vira `null` — um detalhe
 * de observabilidade que falta não pode derrubar um diagnóstico válido.
 *
 * @param {object|null|undefined} usage
 * @returns {object|null}
 */
export function readUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  return {
    inputTokens: readCount(usage.input_tokens),
    outputTokens: readCount(usage.output_tokens),
    reasoningTokens: readCount(usage.output_tokens_details?.reasoning_tokens),
    totalTokens: readCount(usage.total_tokens),
  };
}

function readCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function readModelName(response) {
  const model = response?.model;
  return typeof model === 'string' && model.trim().length > 0 ? model.trim() : null;
}

function readResponseId(response) {
  const id = response?.id;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}
