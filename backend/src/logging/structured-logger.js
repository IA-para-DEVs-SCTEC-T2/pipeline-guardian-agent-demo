/**
 * Contrato central de log estruturado da aplicação.
 *
 * Uma linha JSON por evento, em `stdout` (ou `stderr` para `error`): é assim que
 * Docker, Railway e GitHub Actions coletam log — sem agente, sem arquivo e sem
 * biblioteca de observabilidade. O agente do Dia 1 lê exatamente estas linhas
 * quando busca os logs de runtime no Railway, e é por isso que o formato precisa
 * ser um contrato e não um hábito.
 *
 * Três decisões que valem para quem for evoluir:
 *
 * 1. **`schemaVersion` existe desde a primeira versão.** Um coletor que leia
 *    logs de duas releases diferentes precisa saber qual formato está lendo.
 *    Sem o campo, a primeira mudança de contrato vira um parser cheio de `if`.
 * 2. **Mensagem humana e campos estruturados são coisas separadas.** `message`
 *    é para quem lê o log com o olho; `eventType`, `phase`, `statusCode` e
 *    companhia são para quem lê com código. Enfiar dado dentro da frase é o que
 *    obriga a parsear texto depois.
 * 3. **A lista de campos é fechada.** `buildLogEvent` só deixa passar o que está
 *    em `OPTIONAL_FIELDS`. Um `res.locals` inteiro despejado no log seria a
 *    forma mais fácil de vazar header, corpo ou variável de ambiente — e o
 *    vazamento apareceria num artefato de CI meses depois.
 *
 * O que **nunca** é registrado: `Authorization`, `Cookie`, corpo de requisição,
 * corpo completo de resposta, `process.env`, token, chave, stack trace bruto.
 */

import { releaseInfo } from '../release.js';

/** Versão do contrato. Muda quando um campo obrigatório muda de forma. */
export const LOG_SCHEMA_VERSION = 1;

/** Origem do evento. A automação usa isto para separar log de aplicação de log de plataforma. */
export const LOG_SOURCE = 'application';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Fases do ciclo de vida. São as mesmas usadas pela linha do tempo operacional
 * do agente (`collect-operational-context.mjs`) — um vocabulário só.
 */
export const LOG_PHASES = ['startup', 'runtime', 'healthcheck', 'functional', 'shutdown'];

/** Eventos previstos. A lista é fechada de propósito: evento novo é decisão, não acidente. */
export const LOG_EVENT_TYPES = [
  'app.starting',
  'app.started',
  'app.shutdown.requested',
  'app.uncaught_exception',
  'app.unhandled_rejection',
  'http.request.completed',
  'health.check.completed',
  'functional.report.completed',
  'functional.report.failed',
  // Anomalias injetadas de propósito pelo laboratório do Dia 2
  // (`demo-anomalies.js`). Estão na lista pelo mesmo motivo que os outros: o
  // evento precisa ser reconhecível por quem lê o log com código. O prefixo
  // `demo.` diz, no próprio nome, que a causa é o laboratório e não a aplicação.
  'demo.anomaly.latency',
  'demo.anomaly.error-rate',
  'demo.anomaly.noisy-log',
];

/**
 * Campos opcionais aceitos, por evento. Qualquer chave fora desta lista é
 * descartada silenciosamente — o log não é lugar para dado que ninguém previu.
 */
export const OPTIONAL_FIELDS = [
  'requestId',
  'method',
  'path',
  'statusCode',
  'durationMs',
  'port',
  'frontendMounted',
  'errorName',
  'errorCategory',
  'exitCode',
  'signal',
  'functionalArea',
  'healthStatus',
];

/** Comprimento máximo de um campo de texto livre no log. */
const MAX_TEXT_LENGTH = 512;

/**
 * Query string é descartada inteira. `/api/stickers?token=abc` não deveria
 * existir, mas o log não é o lugar de descobrir isso.
 */
const QUERY_STRING = /\?.*$/;

/**
 * Material de credencial reconhecido pela forma do próprio valor. A aplicação
 * não tem o redator do `automation/` (é outro workspace, com outras
 * dependências), e duplicar as 9 regras de lá aqui seria pior: o backend só
 * precisa da rede de segurança sobre texto que ele mesmo compõe.
 */
const CREDENTIAL_PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+(?::[^\s/@]*)?@/gi,
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:authorization|cookie|set-cookie)\s*[:=]\s*\S+/gi,
];

/**
 * Atribuição cujo **nome do campo** denuncia o segredo (`password=…`,
 * `access_token: …`). Diferente das regras acima, esta não olha a forma do
 * valor — e é por isso que ela vive só aqui, no log da aplicação, onde qualquer
 * `token=` é credencial. O relatório da automação não pode usar esta regra sem
 * cuidado: lá existe `Tokens: 1.300`, que é métrica de uso, não segredo (ver
 * `automation/src/redact-secrets.mjs`).
 */
const SENSITIVE_ASSIGNMENT =
  /(\w*(?:password|passwd|senha|secret|token|api[_-]?key|apikey|credentials?)\w*)(\s*[:=]\s*)(["']?)([^\s"',;}]+)\3/gi;

export const REDACTED = '[REDACTED]';

/**
 * Última barreira sobre texto livre que vai para o log.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactLogText(value) {
  let text = String(value ?? '');
  for (const pattern of CREDENTIAL_PATTERNS) {
    text = text.replace(pattern, REDACTED);
  }
  text = text.replace(SENSITIVE_ASSIGNMENT, (_match, key, separator, quote) =>
    `${key}${separator}${quote}${REDACTED}${quote}`,
  );

  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
}

/**
 * Caminho da requisição, sem query string.
 *
 * Preserva o `path` (que identifica a rota e é o que o diagnóstico correlaciona)
 * e descarta o que vem depois do `?` — parâmetro de query é a forma clássica de
 * um token acabar dentro de um log de acesso.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function safePath(value) {
  return redactLogText(String(value ?? '').replace(QUERY_STRING, ''));
}

/**
 * Erro reduzido ao que pode ser publicado: o nome da classe e uma mensagem
 * mascarada e curta.
 *
 * O stack trace **não** entra. Ele carrega caminho absoluto do runner, nome de
 * usuário do sistema e, com alguma frequência, o valor que causou a exceção —
 * e um log de crash é justamente o que acaba anexado a um ticket público.
 * Perde-se detalhe de depuração; ganha-se um log que pode circular.
 *
 * @param {unknown} error
 * @returns {{ errorName: string, message: string }}
 */
export function describeError(error) {
  if (error instanceof Error) {
    return {
      errorName: error.name || 'Error',
      message: redactLogText(error.message || 'erro sem mensagem'),
    };
  }

  // `throw 'string'` e `Promise.reject(undefined)` são legais em JavaScript e
  // acontecem: o logger não pode quebrar justamente no evento de crash.
  return { errorName: 'NonError', message: redactLogText(error) };
}

/**
 * Monta o evento sem escrevê-lo. Separado de `emit` para que os testes possam
 * verificar a forma do objeto sem capturar `stdout`.
 *
 * @param {object} input
 * @param {string} input.eventType um de `LOG_EVENT_TYPES`
 * @param {string} input.phase uma de `LOG_PHASES`
 * @param {string} input.message mensagem humana
 * @param {string} [input.level] padrão `info`
 * @param {object} [input.fields] campos opcionais (filtrados por `OPTIONAL_FIELDS`)
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {() => Date} [input.now]
 * @returns {object} evento pronto para serializar
 */
export function buildLogEvent({
  eventType,
  phase,
  message,
  level = 'info',
  fields = {},
  env = process.env,
  now = () => new Date(),
} = {}) {
  const release = releaseInfo(env);

  const event = {
    schemaVersion: LOG_SCHEMA_VERSION,
    time: now().toISOString(),
    level: LOG_LEVELS.includes(level) ? level : 'info',
    source: LOG_SOURCE,
    service: release.service,
    environment: release.environment,
    commitSha: release.commitSha,
    eventType: LOG_EVENT_TYPES.includes(eventType) ? eventType : 'app.starting',
    phase: LOG_PHASES.includes(phase) ? phase : 'runtime',
    message: redactLogText(message),
  };

  // Lista fechada, e nesta ordem: o log fica estável entre execuções, o que
  // torna um diff de duas releases legível.
  for (const key of OPTIONAL_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    event[key] = typeof value === 'string' ? redactLogText(value) : value;
  }

  return event;
}

/**
 * Cria o emissor de logs.
 *
 * `write` é injetável para que os testes não precisem capturar `stdout` — e
 * para que `createApp` possa silenciar o log sem monkey-patch.
 *
 * @param {object} [options]
 * @param {(line: string, level: string) => void} [options.write]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {() => Date} [options.now]
 * @returns {{ emit: Function, debug: Function, info: Function, warn: Function, error: Function }}
 */
export function createStructuredLogger({ write = defaultWrite, env = process.env, now } = {}) {
  const emit = (input) => {
    const event = buildLogEvent({ ...input, env, now });
    write(`${JSON.stringify(event)}\n`, event.level);
    return event;
  };

  const at = (level) => (input) => emit({ ...input, level });

  return {
    emit,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}

/** Emissor padrão do processo. */
export const logEvent = createStructuredLogger();

/**
 * `error` vai para `stderr`; o resto, para `stdout`. As duas correntes são
 * coletadas pelo Railway e pelo Docker, e a separação é o que permite filtrar
 * ruído sem perder erro.
 */
function defaultWrite(line, level) {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(line);
}
