/**
 * Configuração da integração com a OpenAI — um lugar só.
 *
 * Este módulo é **puro**: não importa o SDK, não abre rede, não lê arquivo. Ele
 * traduz variáveis de ambiente em uma configuração validada, e é isso.
 *
 * Duas decisões que valem para quem for evoluir:
 *
 *   1. **`gpt-5-mini` aparece aqui e em nenhum outro lugar do código.** Os
 *      workflows passam `OPENAI_MODEL` vazio quando a variável não existe no
 *      GitHub; quem resolve o padrão é `resolveOpenAIConfig`, nunca o YAML.
 *      Dois padrões em dois arquivos seriam duas verdades diferentes.
 *   2. **Valor inválido não vira comportamento imprevisível.** Um
 *      `OPENAI_MAX_OUTPUT_TOKENS=abc` cai no padrão e declara isso em `notes`,
 *      que o agente publica como limitação do diagnóstico. Falhar em silêncio
 *      ou aceitar lixo seriam as duas formas de esconder o problema.
 *
 * A chave **nunca** entra no objeto devolvido: ela vai direto do `env` para o
 * construtor do SDK (`openai-client.mjs`). O que sai daqui pode ser impresso,
 * gravado em relatório e publicado em Job Summary sem risco.
 */

/** Modelo padrão da automação. Única ocorrência da string no código. */
export const DEFAULT_MODEL = 'gpt-5-mini';

/** Provedor registrado nos relatórios. */
export const MODEL_PROVIDER = 'openai';

/**
 * Esforço de raciocínio aceito. É o recorte suportado pela família `gpt-5` que
 * esta automação usa — um valor fora daqui cai no padrão em vez de ser enviado
 * à API e devolver erro em tempo de execução.
 */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

export const DEFAULTS = {
  reasoningEffort: 'low',
  maxOutputTokens: 2000,
  timeoutMs: 45_000,
  maxRetries: 1,
};

/** Limites defensivos. Fora deles, o valor é ignorado e o padrão prevalece. */
export const LIMITS = {
  maxOutputTokens: { min: 256, max: 32_000 },
  timeoutMs: { min: 1_000, max: 300_000 },
  maxRetries: { min: 0, max: 3 },
};

/**
 * Teto do que pode ser enviado ao modelo, em caracteres.
 *
 * A seleção de linhas relevantes (`selectRelevantLines`) já reduz o log por
 * número de linhas; isto é o cinto sobre o suspensório, para o caso de uma
 * linha única e gigante (JSON minificado, stack trace em uma linha só). O
 * repositório inteiro nunca é enviado — só o que estes limites deixam passar.
 */
export const PAYLOAD_LIMITS = {
  /** Por log de etapa (um comando do pipeline, o log do smoke test). */
  maxLogChars: 12_000,
  /** Diff da Pull Request. */
  maxDiffChars: 24_000,
  /** Payload final, já serializado. */
  maxTotalChars: 60_000,
};

/** Limitação declarada quando algo foi cortado antes da análise. */
export const TRUNCATION_LIMITATION = 'Parte dos logs foi truncada antes da análise.';

/**
 * Categorias seguras de falha da chamada ao modelo.
 *
 * Nomeiam o que aconteceu **sem** carregar mensagem bruta, header, corpo de
 * requisição ou identificador da conta — nada que possa arrastar credencial
 * para dentro de um relatório.
 */
export const MODEL_ERROR_CATEGORIES = [
  'authentication',
  'rate_limit',
  'timeout',
  'network',
  'invalid_output',
  'incomplete',
  'unknown',
];

/**
 * Resolve a configuração da OpenAI a partir do ambiente.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   enabled: boolean,
 *   model: string,
 *   reasoningEffort: string,
 *   maxOutputTokens: number,
 *   timeoutMs: number,
 *   maxRetries: number,
 *   store: false,
 *   notes: string[],
 * }} configuração validada, **sem** a chave
 */
export function resolveOpenAIConfig(env = process.env) {
  const notes = [];

  return {
    // Só a chave liga o modelo. `OPENAI_MODEL` é opcional — sem ela vale o padrão.
    enabled: readString(env.OPENAI_API_KEY).length > 0,
    model: readString(env.OPENAI_MODEL) || DEFAULT_MODEL,
    reasoningEffort: readEnum(env.OPENAI_REASONING_EFFORT, {
      allowed: REASONING_EFFORTS,
      fallback: DEFAULTS.reasoningEffort,
      name: 'OPENAI_REASONING_EFFORT',
      notes,
    }),
    maxOutputTokens: readInteger(env.OPENAI_MAX_OUTPUT_TOKENS, {
      ...LIMITS.maxOutputTokens,
      fallback: DEFAULTS.maxOutputTokens,
      name: 'OPENAI_MAX_OUTPUT_TOKENS',
      notes,
    }),
    timeoutMs: readInteger(env.OPENAI_TIMEOUT_MS, {
      ...LIMITS.timeoutMs,
      fallback: DEFAULTS.timeoutMs,
      name: 'OPENAI_TIMEOUT_MS',
      notes,
    }),
    maxRetries: readInteger(env.OPENAI_MAX_RETRIES, {
      ...LIMITS.maxRetries,
      fallback: DEFAULTS.maxRetries,
      name: 'OPENAI_MAX_RETRIES',
      notes,
    }),
    // Sempre `false`, sem variável de ambiente para afrouxar: cada diagnóstico
    // é uma requisição independente e sem estado. Ver `docs/day-1-lab.md`.
    store: false,
    notes,
  };
}

/**
 * O agente pode usar o modelo?
 *
 * Depende **apenas** de `OPENAI_API_KEY`. Antes exigia também `OPENAI_MODEL`;
 * com o padrão centralizado, exigir a segunda variável só criaria uma forma a
 * mais de o modelo ficar desligado sem querer.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function canUseModel(env = process.env) {
  return resolveOpenAIConfig(env).enabled;
}

/**
 * Metadados da chamada quando ela não aconteceu (sem chave) ou não concluiu.
 * O modelo declarado é o que **seria** usado — informação de configuração, não
 * de execução.
 *
 * @param {object} config configuração resolvida
 * @param {string|null} [errorCategory]
 * @returns {object}
 */
export function emptyModelCallMetadata(config, errorCategory = null) {
  return {
    modelProvider: MODEL_PROVIDER,
    model: config.model,
    modelResponseId: null,
    modelLatencyMs: null,
    modelUsage: null,
    modelErrorCategory: errorCategory,
  };
}

/**
 * Corta um texto no limite, deixando marcado o que foi cortado.
 *
 * A redação de segredos roda **antes** do corte, nunca depois: cortar só remove
 * conteúdo, então não há como o corte revelar o que a máscara escondeu.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
export function capText(text, maxChars) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= maxChars) return { text: value, truncated: false };

  const omitted = value.length - maxChars;
  return {
    text: `${value.slice(0, maxChars)}\n... [truncado: ${omitted} caractere(s) omitido(s)]`,
    truncated: true,
  };
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readEnum(value, { allowed, fallback, name, notes }) {
  const raw = readString(value);
  if (raw.length === 0) return fallback;
  if (allowed.includes(raw)) return raw;

  // O valor recusado não é ecoado: veio do ambiente e pode ser qualquer coisa.
  notes.push(
    `\`${name}\` com valor não suportado; usado o padrão \`${fallback}\` ` +
      `(aceitos: ${allowed.map((item) => `\`${item}\``).join(', ')}).`,
  );
  return fallback;
}

function readInteger(value, { min, max, fallback, name, notes }) {
  const raw = readString(value);
  if (raw.length === 0) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    notes.push(
      `\`${name}\` inválido (esperado inteiro entre ${min} e ${max}); usado o padrão \`${fallback}\`.`,
    );
    return fallback;
  }

  return parsed;
}
