/**
 * Normalização de logs vindos do Railway.
 *
 * O material chega em três formas, e o parser precisa das três:
 *
 * 1. **JSON por linha da própria CLI** (`railway logs --json`) — objeto com
 *    `timestamp`/`message`/`severity` e nomes que variam entre versões.
 * 2. **JSON da aplicação** — o contrato de
 *    `backend/src/logging/structured-logger.js`, que passa inteiro pelo Railway
 *    e chega aqui como uma linha JSON dentro de outra.
 * 3. **Texto puro** — o log de build (`docker build`, `npm ci`) e qualquer
 *    coisa que a plataforma imprima sem estrutura.
 *
 * Duas invariantes:
 *
 * - **Timestamp não se inventa.** Linha sem hora legível vira
 *   `timestamp: null`, e a linha do tempo a marca como "sem timestamp". Chutar
 *   a hora da coleta faria eventos aparecerem em ordem errada com aparência de
 *   precisão.
 * - **A linha original é preservada em `raw`.** É `raw` que vira citação no
 *   relatório e é contra `raw` que a ancoragem de evidências confere. Um
 *   trecho reescrito pelo parser não sustentaria nada.
 */

import { sanitizeLog } from './sanitize-log.mjs';

/** Níveis normalizados. Qualquer coisa fora daqui vira `info`. */
export const RAILWAY_LEVELS = ['debug', 'info', 'warn', 'error'];

/** Nomes de campo de hora já vistos em respostas da CLI, em ordem de preferência. */
const TIME_KEYS = ['timestamp', 'time', 'ts', 'createdAt', 'time_stamp'];

/** Idem para a mensagem. */
const MESSAGE_KEYS = ['message', 'msg', 'log', 'line', 'text'];

/** Idem para a severidade. */
const LEVEL_KEYS = ['severity', 'level', 'logLevel', 'log_level'];

/** ISO-8601 no começo da linha, com ou sem colchetes. */
const LEADING_TIMESTAMP = /^\s*\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s*/;

/**
 * Marcadores de erro em log não estruturado.
 *
 * `ERR!` está aqui separado do resto: é como o npm marca falha (`npm ERR! code
 * ELIFECYCLE`), e `\berror\b` não o alcança. Como o log de build do Railway é
 * majoritariamente saída de `npm ci` e `docker build`, deixá-lo de fora faria o
 * parser classificar como `info` justamente a linha que interessa.
 */
const ERROR_MARKERS = /\b(error|erro|fatal|failed|failure|exception|panic|traceback)\b|ERR!/i;
const WARN_MARKERS = /\b(warn|warning|deprecat)/i;

/**
 * Uma linha do Railway, normalizada.
 *
 * @typedef {object} RailwayLogEvent
 * @property {string|null} timestamp ISO-8601, ou `null` quando não havia hora
 * @property {string} level
 * @property {string} message mensagem legível
 * @property {string} raw linha original (sanitizada, ainda não mascarada)
 * @property {boolean} structured a linha já vinha como JSON?
 * @property {string|null} eventType `eventType` do contrato da aplicação, quando houver
 * @property {string|null} requestId
 */

/**
 * Normaliza uma linha.
 *
 * @param {string} line
 * @returns {RailwayLogEvent|null} `null` para linha vazia
 */
export function parseRailwayLogLine(line) {
  const raw = String(line ?? '').replace(/\r$/, '');
  if (raw.trim().length === 0) return null;

  const parsed = tryParseJson(raw);
  if (parsed) return fromJson(parsed, raw);

  // Texto puro: a CLI às vezes prefixa a hora antes de um JSON da aplicação.
  const match = raw.match(LEADING_TIMESTAMP);
  if (match) {
    const rest = raw.slice(match[0].length);
    const nested = tryParseJson(rest);
    if (nested) {
      const event = fromJson(nested, raw);
      return { ...event, timestamp: event.timestamp ?? normalizeTimestamp(match[1]) };
    }

    return {
      timestamp: normalizeTimestamp(match[1]),
      level: levelFromText(rest),
      message: rest.trim(),
      raw,
      structured: false,
      eventType: null,
      requestId: null,
    };
  }

  return {
    timestamp: null,
    level: levelFromText(raw),
    message: raw.trim(),
    raw,
    structured: false,
    eventType: null,
    requestId: null,
  };
}

/**
 * Normaliza um fluxo inteiro, com teto de linhas.
 *
 * O corte preserva as **últimas** linhas, não as primeiras: num log de runtime,
 * o que interessa é o que aconteceu por último. (No log de build vale o
 * contrário, mas quem escolhe é `selectRelevantLines`, aplicado depois pelo
 * agregador — aqui só se limita o volume.)
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxLines]
 * @returns {{ events: RailwayLogEvent[], truncated: boolean, totalLines: number }}
 */
export function parseRailwayLogStream(text, { maxLines = 300 } = {}) {
  const clean = sanitizeLog(String(text ?? ''));
  const lines = clean.split('\n');

  const events = [];
  for (const line of lines) {
    const event = parseRailwayLogLine(line);
    if (event) events.push(event);
  }

  const truncated = events.length > maxLines;
  return {
    events: truncated ? events.slice(-maxLines) : events,
    truncated,
    totalLines: events.length,
  };
}

/**
 * Serializa os eventos em JSONL — uma linha JSON por evento, que é o formato
 * gravado em `reports/railway/*.jsonl`.
 *
 * @param {RailwayLogEvent[]} events
 * @returns {string}
 */
export function toJsonl(events = []) {
  return events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '');
}

/**
 * Lê de volta um arquivo JSONL. Linha corrompida é descartada — um arquivo
 * truncado no meio não pode derrubar a análise.
 *
 * @param {string} text
 * @returns {RailwayLogEvent[]}
 */
export function fromJsonl(text) {
  const events = [];
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim().length === 0) continue;
    const parsed = tryParseJson(line);
    if (parsed && typeof parsed === 'object') events.push(parsed);
  }
  return events;
}

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function fromJson(parsed, raw) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      timestamp: null,
      level: levelFromText(raw),
      message: String(parsed),
      raw,
      structured: false,
      eventType: null,
      requestId: null,
    };
  }

  const message = firstString(parsed, MESSAGE_KEYS) ?? raw.trim();

  return {
    timestamp: normalizeTimestamp(firstString(parsed, TIME_KEYS)),
    level: normalizeLevel(firstString(parsed, LEVEL_KEYS)) ?? levelFromText(message),
    message,
    raw,
    structured: true,
    // Só o contrato da nossa aplicação tem estes dois; log de plataforma não.
    eventType: typeof parsed.eventType === 'string' ? parsed.eventType : null,
    requestId: typeof parsed.requestId === 'string' ? parsed.requestId : null,
  };
}

function tryParseJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/**
 * Converte para ISO-8601 quando a data é reconhecível; devolve `null` quando
 * não é. Nunca substitui por "agora".
 *
 * @param {string|null} value
 * @returns {string|null}
 */
export function normalizeTimestamp(value) {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (text.length === 0) return null;

  // Epoch em segundos, milissegundos ou nanossegundos (a CLI já usou os três).
  if (/^\d+$/.test(text)) {
    const digits = text.length;
    const number = Number(text);
    if (!Number.isFinite(number)) return null;
    const millis = digits >= 19 ? number / 1e6 : digits >= 16 ? number / 1e3 : digits >= 13 ? number : number * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const date = new Date(text.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeLevel(value) {
  if (!value) return null;
  const text = String(value).toLowerCase();
  if (/(^|\W)(err|error|fatal|critical|severe)/.test(text)) return 'error';
  if (/(^|\W)(warn|warning)/.test(text)) return 'warn';
  if (/(^|\W)(debug|trace|verbose)/.test(text)) return 'debug';
  if (/(^|\W)(info|notice|log|default)/.test(text)) return 'info';
  return null;
}

function levelFromText(text) {
  if (ERROR_MARKERS.test(text)) return 'error';
  if (WARN_MARKERS.test(text)) return 'warn';
  return 'info';
}
