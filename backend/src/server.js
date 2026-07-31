/**
 * Inicialização do servidor HTTP.
 *
 * Separado de `app.js` (que só cria e configura a aplicação) para permitir
 * testar a API sem abrir porta de rede.
 *
 * Aqui vive o **ciclo de vida do processo** — e é ele que o diagnóstico
 * operacional do Dia 1 lê no log da plataforma para responder três perguntas
 * que a resposta HTTP sozinha não responde:
 *
 *   app.starting              o processo começou a subir?
 *   app.started               ele chegou a ouvir na porta?
 *   app.shutdown.requested    quem pediu para ele parar, e com qual sinal?
 *   app.uncaught_exception    ele morreu por quê?
 *   app.unhandled_rejection   idem, pelo caminho das Promises.
 *
 * Sem `app.started` no log, "o smoke test não obteve resposta" e "o processo
 * nunca subiu" são indistinguíveis de fora.
 */

import { createApp } from './app.js';
import { describeError, logEvent } from './logging/structured-logger.js';

// Em produção quem define a porta é a plataforma (Railway, Docker); 3001 é o
// padrão de desenvolvimento.
const PORT = Number(process.env.PORT) || 3001;

/** Tempo máximo do encerramento controlado. Sempre finito — ver `requestShutdown`. */
export const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10_000;

/**
 * Registra os manipuladores de ciclo de vida e sobe o servidor.
 *
 * Exportada e com tudo injetável porque um teste que precisasse abrir porta,
 * derrubar o processo de verdade e capturar `stdout` não seria um teste — seria
 * um experimento.
 *
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {object} [options.log] emissor injetável
 * @param {NodeJS.Process} [options.processRef] processo injetável (testes)
 * @param {Function} [options.createServer] fábrica da aplicação
 * @returns {{ server: object, requestShutdown: Function, handleFatal: Function }}
 */
export function startServer({
  port = PORT,
  log = logEvent,
  processRef = process,
  createServer = createApp,
  gracePeriodMs = SHUTDOWN_GRACE_MS,
} = {}) {
  log.emit({
    eventType: 'app.starting',
    phase: 'startup',
    message: 'iniciando a aplicação',
    fields: { port },
  });

  const app = createServer();
  const server = app.listen(port, () => {
    log.emit({
      eventType: 'app.started',
      phase: 'startup',
      message: `CopaFigurinhas ouvindo na porta ${port}`,
      fields: { port, frontendMounted: app.locals.frontend.mounted },
    });
  });

  /**
   * Encerramento controlado.
   *
   * Para de aceitar conexões novas, deixa as em andamento terminarem — e força a
   * saída depois de `gracePeriodMs`. O timer é o ponto importante: sem ele, uma
   * conexão keep-alive pendurada segura o processo indefinidamente, o Railway
   * acaba matando o container com SIGKILL e o log não registra nada. Espera
   * finita, sempre.
   */
  const requestShutdown = (signal) => {
    log.emit({
      eventType: 'app.shutdown.requested',
      phase: 'shutdown',
      message: `sinal ${signal} recebido: encerrando de forma controlada`,
      fields: { signal, exitCode: 0 },
    });

    const forced = setTimeout(() => processRef.exit(0), gracePeriodMs);
    // O timer não pode manter o event loop vivo sozinho: se tudo já fechou, o
    // processo deve sair na hora, não daqui a 10 segundos.
    forced.unref?.();

    server.close(() => {
      clearTimeout(forced);
      processRef.exit(0);
    });
  };

  /**
   * Falha fatal.
   *
   * Registra uma versão sanitizada do erro e **encerra com código diferente de
   * zero**. Nada de `try`/`catch` global que devolva o processo ao event loop:
   * depois de uma exceção não capturada o estado da aplicação é desconhecido, e
   * seguir servindo requisições nesse estado é pior do que reiniciar. O código
   * de saída é o que faz a plataforma reiniciar o container e o que aparece no
   * log de deploy do Railway.
   */
  const handleFatal = (eventType, error) => {
    const described = describeError(error);

    log.emit({
      level: 'error',
      eventType,
      phase: 'shutdown',
      message: `falha fatal: ${described.message}`,
      fields: { errorName: described.errorName, exitCode: 1 },
    });

    processRef.exit(1);
  };

  processRef.on('SIGTERM', () => requestShutdown('SIGTERM'));
  processRef.on('SIGINT', () => requestShutdown('SIGINT'));
  processRef.on('uncaughtException', (error) => handleFatal('app.uncaught_exception', error));
  processRef.on('unhandledRejection', (reason) => handleFatal('app.unhandled_rejection', reason));

  return { server, requestShutdown, handleFatal };
}

// Só sobe a porta quando este arquivo é o ponto de entrada do processo.
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  startServer();
}
