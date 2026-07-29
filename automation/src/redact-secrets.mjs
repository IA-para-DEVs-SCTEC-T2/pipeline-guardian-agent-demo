/**
 * Redação de segredos.
 *
 * Todo conteúdo (logs, diff, metadados) passa por aqui antes de ser enviado ao
 * modelo, gravado em disco ou impresso. O valor original nunca é preservado:
 * é substituído por `[REDACTED]`.
 *
 * As regras se dividem em duas famílias, e a diferença importa:
 *
 * - **Material de credencial** (`credentialMaterial: true`) — reconhecem o
 *   segredo pela *forma do próprio valor* (`sk-…`, `ghp_…`, `Bearer …`,
 *   `usuário:senha@host`). Não dependem de nome de campo e por isso não têm
 *   como confundir um rótulo de relatório com um segredo.
 * - **Regras de forma `chave: valor`** — reconhecem o segredo pelo *nome do
 *   campo* (`password`, `secret`, `token`…). São indispensáveis para
 *   `token: valor-real`, mas justamente por olharem só o nome é que podem
 *   errar: `Tokens: 1.300`, num relatório de uso da API, não é credencial
 *   nenhuma. Ver `isUsageMetric`.
 */

export const REDACTED = '[REDACTED]';

/**
 * Nome de campo que denota **contagem** de tokens, não credencial. O plural é o
 * que separa os dois mundos: `access_token` é segredo, `totalTokens` é conta.
 */
const USAGE_METRIC_KEY = /tokens$/i;

/**
 * Valor que não pode carregar segredo: número (com separador de milhar ou
 * decimal) ou o travessão que o relatório usa para "não informado".
 */
const NUMERIC_OR_PLACEHOLDER = /^(?:\d[\d.,\s]*|[—–-]|n\/d)$/;

/**
 * `Tokens: 1.300` é métrica de uso; `token: valor-real` é credencial.
 *
 * Exige as duas condições ao mesmo tempo — nome no plural **e** valor
 * exclusivamente numérico. `password: 123456` continua sendo redigido (nome no
 * singular e sem relação com contagem), e `outputTokens: abc123` também
 * (nome de métrica, mas valor que não é número).
 *
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
export function isUsageMetric(key, value) {
  return USAGE_METRIC_KEY.test(String(key)) && NUMERIC_OR_PLACEHOLDER.test(String(value).trim());
}

/**
 * Regras aplicadas em ordem. As mais estruturadas (URL, header, atribuição)
 * vêm antes das que reconhecem tokens soltos, para que o contexto ao redor do
 * segredo (nome da variável, esquema de autenticação) seja preservado.
 */
export const REDACTION_RULES = [
  {
    name: 'url-credentials',
    credentialMaterial: true,
    // proto://usuario:senha@host
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::([^\s/@]*))?@/gi,
    replace: (_match, scheme) => `${scheme}${REDACTED}@`,
  },
  {
    name: 'cookie',
    credentialMaterial: true,
    pattern: /\b(set-cookie|cookie)(\s*:\s*).*/gi,
    replace: (_match, header, separator) => `${header}${separator}${REDACTED}`,
  },
  {
    name: 'authorization-header',
    credentialMaterial: true,
    pattern: /\b(authorization\s*[:=]\s*)(bearer|basic|token)(\s+)[^\s"',]+/gi,
    replace: (_match, prefix, scheme, space) => `${prefix}${scheme}${space}${REDACTED}`,
  },
  {
    name: 'bearer-token',
    credentialMaterial: true,
    pattern: /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED}`,
  },
  {
    name: 'sensitive-json-field',
    // "password": "valor" — mantém a chave, mascara o valor.
    pattern:
      /(["'])(\w*(?:password|passwd|secret|token|api[_-]?key|apikey|credentials?)\w*)\1(\s*:\s*)(["'])([^"']*)\4/gi,
    keep: ([, key, , , value]) => isUsageMetric(key, value),
    replace: (_match, q1, key, separator, q2) => `${q1}${key}${q1}${separator}${q2}${REDACTED}${q2}`,
  },
  {
    name: 'sensitive-assignment',
    // PASSWORD=valor, OPENAI_API_KEY: valor, GITHUB_TOKEN = valor
    pattern:
      /\b(\w*(?:password|passwd|secret|token|api[_-]?key|apikey|credentials?)\w*)(\s*[:=]\s*)(["']?)([^\s"',;}]+)\3/gi,
    keep: ([key, , , value]) => isUsageMetric(key, value),
    replace: (_match, key, separator, quote) => `${key}${separator}${quote}${REDACTED}${quote}`,
  },
  {
    name: 'github-personal-access-token',
    credentialMaterial: true,
    pattern: /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'github-token',
    credentialMaterial: true,
    pattern: /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'openai-api-key',
    credentialMaterial: true,
    pattern: /\bsk-[A-Za-z0-9_-]{8,}/g,
    replace: () => REDACTED,
  },
];

/** Subconjunto que reconhece o segredo pela forma do valor. */
export const CREDENTIAL_MATERIAL_RULES = REDACTION_RULES.filter((rule) => rule.credentialMaterial);

/**
 * Mascara segredos em um texto. É a proteção completa — use sempre que o
 * conteúdo vier de fora (log, diff, saída do modelo, mensagem de erro).
 *
 * @param {string} text
 * @returns {string} texto sem valores sensíveis
 */
export function redactSecrets(text) {
  return applyRules(text, REDACTION_RULES);
}

/**
 * Mascara apenas **material de credencial**, sem as regras que olham nome de
 * campo.
 *
 * Existe para a última barreira sobre um texto que o próprio sistema compôs —
 * um relatório em Markdown, por exemplo. Ali os campos não confiáveis já foram
 * redigidos um a um, e o que sobra é rótulo escrito por nós: aplicar as regras
 * de `chave: valor` sobre isso só produziria falso positivo (`Tokens: 1.300`
 * virando `Tokens: [REDACTED]`). Uma credencial que vazasse mesmo assim ainda
 * seria pega aqui, porque `sk-…`, `ghp_…` e `Bearer …` se denunciam sozinhos.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactCredentialMaterial(text) {
  return applyRules(text, CREDENTIAL_MATERIAL_RULES);
}

/**
 * Detecta segredos sem alterar o conteúdo. Roda sobre o texto original, antes
 * da redação, e é o que dispara a classificação `security`.
 *
 * Usa as mesmas exceções da redação: uma linha de log com `Tokens: 1.300` não
 * pode reprovar um pipeline como incidente de segurança.
 *
 * @param {string} text
 * @returns {Array<{ rule: string, count: number }>}
 */
export function detectSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const findings = [];
  for (const rule of REDACTION_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let count = 0;

    for (const match of text.matchAll(pattern)) {
      if (rule.keep?.(match.slice(1))) continue;
      count += 1;
    }

    if (count > 0) findings.push({ rule: rule.name, count });
  }
  return findings;
}

/**
 * @param {string} text
 * @param {Array<object>} rules
 * @returns {string}
 */
function applyRules(text, rules) {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';

  let output = text;
  for (const rule of rules) {
    output = output.replace(rule.pattern, (...args) => {
      // `replace` entrega (match, ...grupos, offset, texto) — e, quando o padrão
      // tem grupos nomeados, um objeto a mais no fim. Nenhum destes tem.
      const groups = args.slice(1, -2);
      return rule.keep?.(groups) ? args[0] : rule.replace(...args);
    });
  }
  return output;
}

/**
 * Aplica a redação recursivamente em strings, arrays e objetos simples.
 * Usado como última barreira sobre a saída do modelo e sobre o diagnóstico
 * final, para que nenhum valor sensível chegue ao relatório.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactSecretsDeep(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactSecretsDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactSecretsDeep(entry)]),
    );
  }
  return value;
}
