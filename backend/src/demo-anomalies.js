/**
 * Anomalias didáticas do laboratório do Dia 2.
 *
 * Este módulo existe para **provocar** o sintoma que o detector do
 * `automation/src/day2/` deve encontrar. Ele não mede, não decide e não sabe o
 * que é uma baseline: a única coisa que faz é degradar `GET /api/report` de uma
 * forma escolhida, quando alguém pede explicitamente por ela.
 *
 * Cinco decisões que valem para quem for evoluir:
 *
 * 1. **Sem a variável, o módulo não existe.** `DEMO_ANOMALY_MODE` é lida a cada
 *    requisição e, fora do modo que cada middleware reconhece, ele chama
 *    `next()` antes de qualquer outra coisa — nem contador avança, nem log é
 *    emitido, nem timer é criado, nem erro é construído. Um atraso (ou um 500)
 *    que sobrevive à ausência da variável é um atraso que entra em produção sem
 *    que ninguém tenha pedido.
 * 2. **Um modo por vez.** `createDemoAnomaly` encadeia os cenários, mas cada um
 *    só age no seu próprio valor de `DEMO_ANOMALY_MODE`. Dois sintomas ao mesmo
 *    tempo ensinariam a ler duas anomalias onde o laboratório provoca uma, e o
 *    `firstAnomalousSignal` do detector passaria a depender da ordem do
 *    encadeamento em vez da ordem das regras.
 * 3. **Só a rota funcional.** O middleware é montado em `GET /api/report` e em
 *    lugar nenhum mais. `/api/health` precisa continuar rápido e em 200: é ele
 *    que a observação usa para saber que a aplicação subiu, e um health check
 *    lento ou reprovado transformaria qualquer cenário em falha de
 *    inicialização.
 * 4. **Cada cenário move um sinal, e só um.**
 *    - `latency`: espera antes do mesmo 200, com o mesmo corpo — a anomalia está
 *      no tempo, porque é `latencyP95Ms` que o cenário quer mover.
 *    - `error-rate`: 500 no lugar do relatório, sem atraso e sem log extra — a
 *      anomalia está em `errorRate`, e só nele. As duas linhas de log de uma
 *      requisição que falha (a do cenário e a do `requestLogger`) são as mesmas
 *      duas de uma que dá certo, de propósito: `logLinesPerRequest` não pode
 *      subir junto.
 *    - `noisy-logs`: o mesmo 200, com o mesmo corpo e no mesmo tempo — só que
 *      acompanhado de um bloco de eventos estruturados a mais. A anomalia está
 *      em `logLinesPerRequest`, e nem o relógio nem o status são tocados.
 * 5. **A falha do cenário não muda o veredito da requisição.** Se a espera ou o
 *    log falharem, o `latency` segue para o handler e o `error-rate` continua
 *    devolvendo o seu 500. O log é um efeito colateral do cenário, nunca a
 *    condição dele — um `catch` mudo em volta do `emit` é o que garante que a
 *    proporção observada seja a proporção implementada.
 */

import { HttpError } from './middleware/errorHandler.js';
import { logEvent } from './logging/structured-logger.js';

/** A variável que liga o laboratório. Sem ela, nada acontece. */
export const DEMO_ANOMALY_ENV_VAR = 'DEMO_ANOMALY_MODE';

/** Cenário de latência intermitente. */
export const LATENCY_MODE = 'latency';

/** Cenário de erro intermitente. */
export const ERROR_RATE_MODE = 'error-rate';

/** Cenário de excesso de logs. */
export const NOISY_LOGS_MODE = 'noisy-logs';

/** Os modos implementados, na ordem em que foram adicionados ao laboratório. */
export const DEMO_ANOMALY_MODES = [LATENCY_MODE, ERROR_RATE_MODE, NOISY_LOGS_MODE];

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
 * Uma requisição em cada cinco — 20% das chamadas.
 *
 * A regra do detector para `errorRate` exige **duas** condições: `observado ≥
 * 0,15` **e** `observado − baseline ≥ 0,10`. Com 30 requisições medidas, uma
 * falha em cada cinco dá 6 erros e `errorRate: 0,2`, que passa nas duas com
 * folga sobre uma baseline saudável (`errorRate: 0`). Uma em cada dez daria
 * 0,1 e não passaria em nenhuma — a proporção é escolhida por causa da conta,
 * como em `LATENCY_EVERY`.
 */
export const ERROR_RATE_EVERY = 5;

/**
 * Código do erro devolvido, e nome com que ele aparece no log.
 *
 * O nome diz `demo` na cara: quem encontrar este 500 num log às três da manhã
 * precisa saber, na própria linha, que a causa é o laboratório e não a
 * aplicação. Um `INTERNAL_ERROR` genérico aqui seria um bug fantasma versionado.
 */
export const ERROR_RATE_CODE = 'DEMO_ANOMALY_ERROR';
export const ERROR_RATE_ERROR_NAME = 'DemoAnomalyError';

/**
 * Mensagem do erro controlado. Vai para o corpo da resposta pelo `errorHandler`
 * (é um `HttpError`, logo a mensagem é publicável de propósito) e não carrega
 * nada além do que já está neste arquivo.
 */
export const ERROR_RATE_MESSAGE =
  'anomalia do laboratório do Dia 2: falha controlada em GET /api/report';

/**
 * Uma requisição em cada três, como no cenário de latência.
 *
 * A anomalia é intermitente de propósito: um serviço que despeja log em toda
 * requisição é ruído constante, e ruído constante entraria na baseline da
 * própria máquina em vez de aparecer como desvio dela.
 */
export const NOISY_LOGS_EVERY = 3;

/**
 * Eventos a mais por ativação. **Dezoito**, e o número sai de uma conta.
 *
 * A baseline saudável é `logLinesPerRequest: 2` (o `functional.report.completed`
 * da rota e o `http.request.completed` do `requestLogger`). A regra `log_volume`
 * do detector exige as duas condições de sempre — `observado ≥ baseline × 3`
 * **e** `observado − baseline ≥ 5` —, o que coloca o piso de disparo em **7**
 * linhas por requisição.
 *
 * Com um bloco a cada três requisições, o observado é `2 + bloco / 3`:
 *
 *   - 10 eventos → 5,33 linhas/req. Reprova nas duas condições, e o painel
 *     mostraria um pico visível que **não** vira anomalia. É um cenário
 *     legítimo de aula, mas não é este.
 *   - 18 eventos → 8,00 linhas/req. Passa em `≥ 6` (relativa) e em `Δ ≥ 5`
 *     (absoluta) com uma linha de margem — sobra para o caso de o coletor
 *     perder uma linha na janela medida.
 *
 * O número está aqui, sozinho, porque é ele que precisa ser recalculado se
 * algum dia a baseline da aplicação deixar de ser 2 linhas por requisição. O
 * detector não se ajusta ao cenário: é o cenário que se ajusta à regra.
 */
export const NOISY_LOGS_EXTRA_EVENTS = 18;

/**
 * Nível dos eventos extras: `info`, não `error`.
 *
 * Dois motivos, e nenhum é estético. O primeiro é de contrato: `error` vai para
 * `stderr` e é o sinal que a seleção de fatos do diagnóstico operacional trata
 * como evidência (`level` vence regex). Dezoito erros falsos por ativação
 * ensinariam o agente a ver incidente onde o laboratório provocou volume. O
 * segundo é do próprio cenário: a anomalia é **quantidade** de log, não
 * gravidade — se ela também mudasse a gravidade, moveria dois sinais.
 */
export const NOISY_LOGS_LEVEL = 'info';

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
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function errorRateModeEnabled(env = process.env) {
  return readAnomalyMode(env) === ERROR_RATE_MODE;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function noisyLogsModeEnabled(env = process.env) {
  return readAnomalyMode(env) === NOISY_LOGS_MODE;
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
 * Middleware que reprova uma requisição em cada `every` com um 500 controlado.
 *
 * Três coisas que este middleware **não** faz, e cada ausência é uma decisão:
 *
 * - **Não responde.** Ele chama `next(error)` e o `errorHandler` do
 *   `app.js` monta o 500. A resposta de erro do laboratório é byte a byte a
 *   mesma de qualquer outra falha da aplicação (`{ error: { code, message },
 *   requestId }`), porque um cenário que inventa o próprio formato de erro
 *   ensina a reconhecer o cenário, não a falha.
 * - **Não espera.** Sem `sleep`: um 500 que também demorasse moveria
 *   `latencyP95Ms` junto e o `firstAnomalousSignal` viraria `latencyP95Ms`,
 *   apontando o sintoma errado.
 * - **Não altera o relatório.** As requisições que sobram (4 em 5) devolvem o
 *   mesmo 200 com o mesmo corpo de sempre. `buildReport` sequer é alcançado nas
 *   que falham, e não é tocado nas que passam.
 *
 * O contador é do middleware, e não do processo, pelo mesmo motivo do
 * `createLatencyAnomaly`: cada roteador criado tem o seu, e um teste consegue
 * contar de 1 a 10 sem herdar o estado do teste anterior.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.log] emissor de log estruturado
 * @param {number} [options.every]
 * @returns {import('express').RequestHandler}
 */
export function createErrorRateAnomaly({
  env = process.env,
  log = logEvent,
  every = ERROR_RATE_EVERY,
} = {}) {
  let requestCount = 0;

  return function demoErrorRateAnomaly(req, res, next) {
    // Ver decisão 1: a saída antecipada vem antes do contador.
    if (!errorRateModeEnabled(env)) {
      next();
      return;
    }

    requestCount += 1;
    if (requestCount % every !== 0) {
      next();
      return;
    }

    try {
      log.emit({
        level: 'error',
        eventType: 'demo.anomaly.error-rate',
        phase: 'functional',
        // A contagem entra na mensagem pelo mesmo motivo que na latência: é ela
        // que torna a regra conferível no log — a falha aparece em 5, 10, 15… e
        // em mais nenhuma.
        message:
          `anomalia de taxa de erro do laboratório na requisição ${requestCount}: ` +
          'HTTP 500 controlado no lugar do relatório',
        fields: {
          requestId: req.id,
          path: req.originalUrl,
          statusCode: 500,
          functionalArea: 'report',
          errorName: ERROR_RATE_ERROR_NAME,
        },
      });
    } catch {
      // Ver decisão 5. Um log que falhou não muda quais requisições falham.
    }

    next(demoAnomalyError());
  };
}

/**
 * Middleware que emite um bloco de eventos estruturados a mais em uma
 * requisição em cada `every`, sem mudar mais nada.
 *
 * Quatro coisas que este middleware **não** faz, e cada ausência é uma decisão:
 *
 * - **Não espera.** Nenhum `sleep`, nenhum timer, nenhuma promessa: os
 *   `emit` são síncronos e o `next()` acontece na mesma volta do event loop.
 *   Um bloco de log que também demorasse moveria `latencyP95Ms` junto, e o
 *   `firstAnomalousSignal` deixaria de ser `logLinesPerRequest`.
 * - **Não muda o status nem o corpo.** A requisição ativada segue para o
 *   handler e devolve o mesmo 200 com o mesmo relatório. `errorRate` e
 *   `responseSizeP95Bytes` ficam onde estavam.
 * - **Não repete indefinidamente.** O laço é um `for` de tamanho fixo, com
 *   limite conhecido em tempo de compilação (`NOISY_LOGS_EXTRA_EVENTS`). Ele
 *   não olha o relógio, não se reagenda e não depende do que aconteceu na
 *   requisição anterior: são exatamente `extraEvents` eventos por ativação, ou
 *   nenhum.
 * - **Não usa `level: 'error'`.** Ver `NOISY_LOGS_LEVEL`.
 *
 * O `try` fica **dentro** do laço, e não em volta dele, por causa da palavra
 * "exatamente": com o `try` do lado de fora, um coletor que falhasse no quinto
 * evento cortaria os treze seguintes e a proporção observada deixaria de ser a
 * proporção implementada — silenciosamente, que é o pior jeito.
 *
 * O contador é do middleware, e não do processo, pelo mesmo motivo dos outros
 * dois cenários: cada roteador criado tem o seu.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.log] emissor de log estruturado
 * @param {number} [options.every]
 * @param {number} [options.extraEvents]
 * @returns {import('express').RequestHandler}
 */
export function createNoisyLogsAnomaly({
  env = process.env,
  log = logEvent,
  every = NOISY_LOGS_EVERY,
  extraEvents = NOISY_LOGS_EXTRA_EVENTS,
} = {}) {
  let requestCount = 0;

  return function demoNoisyLogsAnomaly(req, res, next) {
    // Ver decisão 1: a saída antecipada vem antes do contador.
    if (!noisyLogsModeEnabled(env)) {
      next();
      return;
    }

    requestCount += 1;
    if (requestCount % every !== 0) {
      next();
      return;
    }

    const sequence = requestCount;

    for (let index = 1; index <= extraEvents; index += 1) {
      try {
        log.emit({
          level: NOISY_LOGS_LEVEL,
          eventType: 'demo.anomaly.noisy-log',
          phase: 'functional',
          // A posição dentro do bloco entra na mensagem porque é ela que torna a
          // regra conferível no log: quem contar as linhas de um `requestId`
          // encontra `1/18` até `18/18`, e mais nada.
          message:
            `anomalia de volume de log do laboratório na requisição ${sequence}: ` +
            `evento ${index}/${extraEvents} do bloco`,
          fields: {
            // Sem o `requestId`, a observação do Dia 2 não consegue correlacionar
            // a linha com a requisição e cai na média por janela — o número final
            // seria o mesmo, mas declarado como aproximação em vez de contagem.
            requestId: req.id,
            path: req.originalUrl,
            statusCode: 200,
            functionalArea: 'report',
          },
        });
      } catch {
        // Ver decisão 5. Um log que falhou não muda o veredito da requisição —
        // e não interrompe os eventos seguintes do mesmo bloco.
      }
    }

    next();
  };
}

/**
 * Compõe os cenários disponíveis num único middleware.
 *
 * O encadeamento é seguro porque cada middleware sai antes do contador quando o
 * seu modo não é o pedido (decisão 1): com `DEMO_ANOMALY_MODE` ausente, a
 * requisição atravessa os dois sem que nenhum estado se mova.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.log]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {import('express').RequestHandler}
 */
export function createDemoAnomaly({ env = process.env, log = logEvent, sleep = defaultSleep } = {}) {
  const scenarios = [
    createLatencyAnomaly({ env, log, sleep }),
    createErrorRateAnomaly({ env, log }),
    createNoisyLogsAnomaly({ env, log }),
  ];

  return function demoAnomaly(req, res, next) {
    const step = (index) => (error) => {
      // Erro de um cenário anterior é o cenário, não engano: vai direto para o
      // `errorHandler` sem passar pelos seguintes.
      if (error) {
        next(error);
        return;
      }
      if (index >= scenarios.length) {
        next();
        return;
      }
      scenarios[index](req, res, step(index + 1));
    };

    step(0)();
  };
}

/**
 * O erro controlado do cenário `error-rate`.
 *
 * `HttpError` (e não um `Error` cru) porque o status é uma decisão, não uma
 * surpresa: o `errorHandler` devolve 500 com o código do laboratório em vez de
 * classificar isto como "erro inesperado" e registrar mais uma linha de log —
 * linha que inflaria `logLinesPerRequest` e daria ao detector um segundo sinal
 * para reclamar.
 *
 * @returns {HttpError}
 */
function demoAnomalyError() {
  const error = new HttpError(500, ERROR_RATE_CODE, ERROR_RATE_MESSAGE);
  error.name = ERROR_RATE_ERROR_NAME;
  return error;
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
