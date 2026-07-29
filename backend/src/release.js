/**
 * Metadados da release — fonte única.
 *
 * `/api/health`, `/api/version` e o logger estruturado leem daqui, para que a
 * versão e o commit reportados sejam sempre os mesmos. Nada neste módulo lê
 * variável de ambiente que não esteja listada abaixo: o health check não é
 * lugar para despejar `process.env`.
 *
 * Variáveis reconhecidas (todas opcionais, todas com fallback seguro):
 *   NODE_ENV                  ambiente lógico (`development` quando ausente)
 *   APP_VERSION               versão da release; cai no `version` do package.json
 *   COMMIT_SHA                commit implantado
 *   RAILWAY_GIT_COMMIT_SHA    idem, preenchido automaticamente pelo Railway
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SERVICE_NAME = 'copa-figurinhas';

/** Usado quando não há `APP_VERSION` nem `package.json` legível. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

/** Usado quando o commit não foi informado ao processo. */
export const UNKNOWN_COMMIT = 'unknown';

/**
 * Versão declarada no `package.json` do backend. Lida uma única vez, na carga
 * do módulo — não é dado que mude durante a execução do processo.
 */
const PACKAGE_VERSION = readPackageVersion();

function readPackageVersion() {
  try {
    const raw = readFileSync(join(HERE, '..', 'package.json'), 'utf8');
    const version = JSON.parse(raw).version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    // Sem package.json legível (imagem enxuta, teste isolado): não é motivo
    // para derrubar o processo — a versão vira `UNKNOWN_VERSION`.
    return null;
  }
}

/**
 * Metadados NÃO sensíveis da release.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ service: string, environment: string, version: string, commitSha: string }}
 */
export function releaseInfo(env = process.env) {
  return {
    service: SERVICE_NAME,
    environment: env.NODE_ENV || 'development',
    version: env.APP_VERSION || PACKAGE_VERSION || UNKNOWN_VERSION,
    commitSha: env.COMMIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || UNKNOWN_COMMIT,
  };
}

/**
 * Há quantos segundos o processo está no ar.
 *
 * @returns {number} inteiro em segundos
 */
export function uptimeSeconds() {
  return Math.floor(process.uptime());
}

/**
 * `true` quando o processo roda em modo de produção.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isProduction(env = process.env) {
  return env.NODE_ENV === 'production';
}
