/**
 * Anomalias didáticas do laboratório do Dia 2.
 *
 * Este módulo existe para **provocar** o sintoma que o detector do
 * `automation/src/day2/` deve encontrar. Ele não mede, não decide e não sabe o
 * que é uma baseline: a única coisa que faz é atrasar uma requisição em cada
 * três quando alguém pede explicitamente por isso.
 *
 * Quatro decisões que valem para quem for evoluir:
 *
 * 1. **Sem a variável, o módulo não existe.** `DEMO_ANOMALY_MODE` é lida a cada
 *    requisição e, fora do modo `latency`, o middleware chama `next()` antes de
 *    qualquer outra coisa — nem contador avança, nem log é emitido, nem timer é
 *    criado. Um atraso que sobrevive à ausência da variável é um atraso que
 *    entra em produção sem que ninguém tenha pedido.
 * 2. **Só a rota funcional.** O middleware é montado em `GET /api/report` e em
 *    lugar nenhum mais. `/api/health` precisa continuar rápido: é ele que a
 *    observação usa para saber que a aplicação subiu, e um health check lento
 *    transformaria o cenário em falha de inicialização.
 * 3. **O atraso é espera, não trabalho.** A resposta continua sendo o mesmo 200
 *    com o mesmo corpo — o relatório de negócio não é tocado. A anomalia está no
 *    tempo, e só nele, porque é exatamente um sinal (`latencyP95Ms`) que o
 *    cenário quer mover.
 * 4. **A falha do cenário não vira 500.** Se a espera ou o log falharem, a
 *    requisição segue para o handler mesmo assim. Um recurso de demonstração não
 *    tem licença para reprovar a rota que ele está demonstrando.
 */

import { logEvent } from './logging/structured-logger.js';

/** A variável que liga o laboratório. Sem ela, nada acontece. */
export const DEMO_ANOMALY_ENV_VAR = 'DEMO_ANOMALY_MODE';

/** O único cenário implementado. */
export const LATENCY_MODE = 'latency';

/**
 * Espera injetada, em milissegundos.
 *
 * 500 ms é grande o bastante para o P95 saltar bem acima da regra do detector
 * (`observado − baseline ≥ 150 ms`) e pequeno o bastante para trinta requisições
 * caberem numa demonstração ao vivo.
 */
export const LATENCY_DELAY_MS = 500;

/**
 * Uma requisição em cada três.
 *
 * Com 30 amostras, o P95 por posto mais próximo cai no índice 28 da lista
 * ordenada — dentro do terço lento. Uma requisição lenta isolada não moveria o
 * percentil; um terço delas move. A proporção é escolhida por causa da conta,
 * não por estética.
 */
export const LATENCY_EVERY = 3;

/**
 * O modo pedido no ambiente, normalizado.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} string vazia quando a variável não está definida
 */
export function readAnomalyMode(env = process.env) {
  return String(env?.[DEMO_ANOMALY_ENV_VAR] ?? '').trim().toLowerCase();
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function latencyModeEnabled(env = process.env) {
  return readAnomalyMode(env) === LATENCY_MODE;
}

/**
 * Middleware que atrasa uma requisição em cada `every`.
 *
 * O contador é do middleware, não do processo: cada roteador criado tem o seu.
 * É o que permite um teste contar de 1 a 9 sem herdar o estado de outro teste.
 *
 * `env`, `log` e `sleep` são injetáveis porque a alternativa — verificar o
 * comportamento com relógio real e variável global — trocaria um teste
 * determinístico por uma espera de meio segundo repetida a cada asserção.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.log] emissor de log estruturado
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.delayMs]
 * @param {number} [options.every]
 * @returns {import('express').RequestHandler}
 */
export function createLatencyAnomaly({
  env = process.env,
  log = logEvent,
  sleep = defaultSleep,
  delayMs = LATENCY_DELAY_MS,
  every = LATENCY_EVERY,
} = {}) {
  let requestCount = 0;

  return function demoLatencyAnomaly(req, res, next) {
    // Ver decisão 1: a saída antecipada vem antes do contador.
    if (!latencyModeEnabled(env)) {
      next();
      return;
    }

    requestCount += 1;
    if (requestCount % every !== 0) {
      next();
      return;
    }

    const sequence = requestCount;

    Promise.resolve(sleep(delayMs)).then(
      () => {
        try {
          log.emit({
            level: 'warn',
            eventType: 'demo.anomaly.latency',
            phase: 'functional',
            // A contagem entra na mensagem porque é ela que torna a regra
            // conferível no log: a espera aparece em 3, 6, 9… e em mais nenhuma.
            message:
              `anomalia de latência do laboratório na requisição ${sequence}: ` +
              `${delayMs} ms de espera antes de responder`,
            fields: {
              requestId: req.id,
              path: req.originalUrl,
              durationMs: delayMs,
              functionalArea: 'report',
              statusCode: 200,
            },
          });
        } catch {
          // Ver decisão 4. Um log que falhou não pode segurar a requisição.
        }

        next();
      },
      // Idem: espera que rejeitou é espera que não aconteceu, não é erro da rota.
      () => next(),
    );
  };
}

/**
 * Espera padrão. `unref` para que um timer pendente nunca segure o processo no
 * encerramento — a observação do Dia 2 manda `SIGTERM` e espera pouco.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
