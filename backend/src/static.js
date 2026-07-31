/**
 * Entrega do frontend compilado pelo próprio Express.
 *
 * Em produção há **um container e uma aplicação**: a API e a SPA vivem no mesmo
 * domínio, e por isso o frontend chama `/api/...` em caminho relativo.
 *
 * Três invariantes que este módulo mantém:
 *
 * 1. **`/api` nunca cai no fallback da SPA.** Uma rota inexistente da API
 *    continua devolvendo o 404 em JSON da API — devolver `index.html` com
 *    status 200 esconderia o erro de quem chama a API.
 * 2. **Só `GET` recebe o `index.html`.** Um `POST` para uma rota que não existe
 *    é erro de cliente, não uma navegação de SPA.
 * 3. **Sem `dist`, o backend continua de pé.** Em desenvolvimento e nos testes
 *    o build do frontend não existe — isso não é motivo para derrubar a API.
 *    Em produção, aí sim, o aviso é explícito no log.
 *
 * O caminho é resolvido a partir da URL deste módulo (ES Modules), não do
 * diretório de onde o processo foi iniciado.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { buildLogEvent } from './logging/structured-logger.js';
import { isProduction } from './release.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `backend/src/static.js` → `<repo>/frontend/dist`. */
export const DEFAULT_FRONTEND_DIST = resolve(HERE, '..', '..', 'frontend', 'dist');

/**
 * Tudo que não começa com `/api` (nem é exatamente `/api`).
 * A negação é o que preserva o 404 em JSON da API.
 */
export const SPA_FALLBACK_PATTERN = /^\/(?!api(?:\/|$)).*/;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} caminho absoluto do diretório compilado do frontend
 */
export function resolveFrontendDist(env = process.env) {
  return env.FRONTEND_DIST ? resolve(env.FRONTEND_DIST) : DEFAULT_FRONTEND_DIST;
}

/**
 * Monta os arquivos estáticos e o fallback da SPA na aplicação.
 *
 * Deve ser chamado DEPOIS das rotas `/api` e ANTES do `notFound`.
 *
 * @param {import('express').Express} app
 * @param {object} [options]
 * @param {string} [options.dist] diretório compilado (padrão: `resolveFrontendDist`)
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(line: object) => void} [options.log] emissor de log estruturado
 * @returns {{ mounted: boolean, dist: string }}
 */
export function mountFrontend(app, { dist, env = process.env, log = writeLogLine } = {}) {
  const directory = dist ? resolve(dist) : resolveFrontendDist(env);
  const indexPath = join(directory, 'index.html');

  if (!existsSync(indexPath)) {
    // Em desenvolvimento e nos testes a ausência do `dist` é o esperado (quem
    // serve a interface é o Vite): avisar a cada execução seria só ruído. Em
    // produção, é uma configuração errada e precisa aparecer no log.
    if (isProduction(env)) {
      log(
        buildLogEvent({
          level: 'error',
          eventType: 'app.starting',
          phase: 'startup',
          env,
          message:
            `Build do frontend não encontrado em ${directory}. A API responde normalmente, ` +
            'mas nenhuma página será servida. Rode `npm run build` antes de iniciar em produção ' +
            '(na imagem Docker isso acontece no estágio de build).',
          fields: { frontendMounted: false },
        }),
      );
    }

    return { mounted: false, dist: directory };
  }

  // `index: false`: quem responde `/` é o fallback abaixo, num lugar só.
  app.use(
    express.static(directory, {
      index: false,
      // Os assets do Vite têm hash no nome; o `index.html` não pode ser cacheado.
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  app.get(SPA_FALLBACK_PATTERN, (req, res) => {
    res.sendFile(indexPath);
  });

  log(
    buildLogEvent({
      level: 'info',
      eventType: 'app.starting',
      phase: 'startup',
      env,
      message: `Frontend compilado servido a partir de ${directory}`,
      fields: { frontendMounted: true },
    }),
  );

  return { mounted: true, dist: directory };
}

function writeLogLine(line) {
  const stream = line.level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}
