/**
 * Redação de segredos.
 *
 * Todo conteúdo (logs, diff, metadados) passa por aqui antes de ser enviado ao
 * modelo, gravado em disco ou impresso. O valor original nunca é preservado:
 * é substituído por `[REDACTED]`.
 */

export const REDACTED = '[REDACTED]';

/**
 * Regras aplicadas em ordem. As mais estruturadas (URL, header, atribuição)
 * vêm antes das que reconhecem tokens soltos, para que o contexto ao redor do
 * segredo (nome da variável, esquema de autenticação) seja preservado.
 */
export const REDACTION_RULES = [
  {
    name: 'url-credentials',
    // proto://usuario:senha@host
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::([^\s/@]*))?@/gi,
    replace: (_match, scheme) => `${scheme}${REDACTED}@`,
  },
  {
    name: 'cookie',
    pattern: /\b(set-cookie|cookie)(\s*:\s*).*/gi,
    replace: (_match, header, separator) => `${header}${separator}${REDACTED}`,
  },
  {
    name: 'authorization-header',
    pattern: /\b(authorization\s*[:=]\s*)(bearer|basic|token)(\s+)[^\s"',]+/gi,
    replace: (_match, prefix, scheme, space) => `${prefix}${scheme}${space}${REDACTED}`,
  },
  {
    name: 'bearer-token',
    pattern: /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED}`,
  },
  {
    name: 'sensitive-json-field',
    // "password": "valor" — mantém a chave, mascara o valor.
    pattern:
      /(["'])(\w*(?:password|passwd|secret|token|api[_-]?key|apikey|credentials?)\w*)\1(\s*:\s*)(["'])[^"']*\4/gi,
    replace: (_match, q1, key, separator, q2) => `${q1}${key}${q1}${separator}${q2}${REDACTED}${q2}`,
  },
  {
    name: 'sensitive-assignment',
    // PASSWORD=valor, OPENAI_API_KEY: valor, GITHUB_TOKEN = valor
    pattern:
      /\b(\w*(?:password|passwd|secret|token|api[_-]?key|apikey|credentials?)\w*)(\s*[:=]\s*)(["']?)([^\s"',;}]+)\3/gi,
    replace: (_match, key, separator, quote) => `${key}${separator}${quote}${REDACTED}${quote}`,
  },
  {
    name: 'github-personal-access-token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'openai-api-key',
    pattern: /\bsk-[A-Za-z0-9_-]{8,}/g,
    replace: () => REDACTED,
  },
];

/**
 * Mascara segredos em um texto.
 *
 * @param {string} text
 * @returns {string} texto sem valores sensíveis
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';

  let output = text;
  for (const rule of REDACTION_RULES) {
    output = output.replace(rule.pattern, rule.replace);
  }
  return output;
}

/**
 * Detecta segredos sem alterar o conteúdo. Roda sobre o texto original, antes
 * da redação, e é o que dispara a classificação `security`.
 *
 * @param {string} text
 * @returns {Array<{ rule: string, count: number }>}
 */
export function detectSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const findings = [];
  for (const rule of REDACTION_RULES) {
    const matches = text.match(new RegExp(rule.pattern.source, rule.pattern.flags));
    if (matches && matches.length > 0) {
      findings.push({ rule: rule.name, count: matches.length });
    }
  }
  return findings;
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
