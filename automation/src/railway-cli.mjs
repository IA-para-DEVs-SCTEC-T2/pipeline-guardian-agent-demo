/**
 * Camada fina sobre a Railway CLI.
 *
 * Existe para que `collect-railway-evidence.mjs` cuide de **evidência** e este
 * módulo cuide de **processo**: invocar um binário externo, com timeout, sem
 * shell, sem interatividade, e traduzir a falha em categoria.
 *
 * Quatro regras que este arquivo protege:
 *
 * 1. **Versão fixada, nunca `latest`.** Uma CLI que muda de flag entre duas
 *    execuções transforma "a coleta falhou" num mistério — e a aula acontece
 *    numa data específica, não na data em que a CLI foi escrita.
 * 2. **Sem shell.** `execFile`, argumentos em array. Nome de serviço com espaço
 *    ou aspas é dado, não comando.
 * 3. **O token só existe no ambiente do filho.** Não vai para argumento (que
 *    apareceria em `ps` e em qualquer log de comando), não é devolvido, não é
 *    registrado. `describeInvocation` mostra o comando **sem** o ambiente.
 * 4. **Nunca lança.** Toda invocação devolve um resultado; quem chama decide.
 *    Uma exceção aqui viraria falha do workflow, e a coleta do Railway não pode
 *    reprovar um deployment saudável.
 */

import { execFile } from 'node:child_process';

/**
 * Versão EXATA da Railway CLI usada pelo workflow.
 *
 * Escolhida em 30/07/2026 como a última publicada da linha 5.x no npm
 * (`npm view @railway/cli versions`). Para atualizar: rode o comando, escolha a
 * nova versão, teste `railway --version` e `railway logs --help` no runner, e
 * ajuste **aqui e em `docs/railway-setup.md`** — os dois falam da mesma decisão.
 */
export const RAILWAY_CLI_VERSION = '5.30.1';

/** Pacote npm da CLI. */
export const RAILWAY_CLI_PACKAGE = '@railway/cli';

/** Binário invocado. Sobrescrevível para testes e para instalação local. */
export const DEFAULT_RAILWAY_BIN = 'railway';

/** Teto de cada invocação. A coleta inteira é best-effort e precisa terminar. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Teto do que uma única invocação pode devolver. A CLI pode despejar milhares de
 * linhas; cortar aqui evita carregar dezenas de MB na memória antes de sanitizar.
 */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Categorias seguras de falha da CLI.
 *
 * Mesma ideia de `MODEL_ERROR_CATEGORIES`: o relatório recebe o **nome** do que
 * aconteceu, nunca o `stderr` bruto — que pode carregar a URL da API com token
 * em query, o e-mail da conta ou o id do projeto.
 */
export const CLI_ERROR_CATEGORIES = [
  'not_installed',
  'authentication',
  'not_found',
  'timeout',
  'unsupported_command',
  'invalid_output',
  'unknown',
];

/**
 * Traduz uma falha de invocação em categoria.
 *
 * Recebe o `stderr` para **classificar**, e o descarta em seguida: nada do texto
 * original sobrevive a esta função.
 *
 * @param {object} input
 * @param {Error|null} [input.error] erro do `execFile`
 * @param {number|null} [input.code] código de saída
 * @param {string} [input.stderr] usado só para classificar
 * @returns {string} categoria em `CLI_ERROR_CATEGORIES`
 */
export function classifyCliError({ error = null, code = null, stderr = '' } = {}) {
  if (error?.code === 'ENOENT') return 'not_installed';
  if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') return 'timeout';

  const text = String(stderr ?? '').toLowerCase();

  if (/unauthor|not logged in|invalid token|forbidden|401|403/.test(text)) return 'authentication';
  if (/unrecognized|unexpected argument|unknown (?:flag|option|subcommand)|usage:/.test(text)) {
    return 'unsupported_command';
  }
  if (/not found|no such|does not exist|no deployments|no service/.test(text)) return 'not_found';
  if (/timed out|timeout/.test(text)) return 'timeout';

  return code === null ? 'unknown' : 'unknown';
}

/**
 * Descrição publicável de uma invocação: o comando e os argumentos, sem
 * ambiente e sem token.
 *
 * @param {string[]} args
 * @param {string} [bin]
 * @returns {string}
 */
export function describeInvocation(args, bin = DEFAULT_RAILWAY_BIN) {
  return [bin, ...args].join(' ');
}

/**
 * Executa a Railway CLI uma vez.
 *
 * @param {object} input
 * @param {string[]} input.args argumentos, já separados
 * @param {NodeJS.ProcessEnv} [input.env] ambiente do processo pai
 * @param {string} [input.bin]
 * @param {number} [input.timeoutMs]
 * @param {Function} [input.execFileImpl] injetável nos testes
 * @returns {Promise<{ ok: boolean, stdout: string, code: number|null,
 *                     errorCategory: string|null, command: string }>}
 */
export async function runRailwayCommand({
  args,
  env = process.env,
  bin = env.RAILWAY_CLI_BIN || DEFAULT_RAILWAY_BIN,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  execFileImpl = execFile,
} = {}) {
  const command = describeInvocation(args, bin);

  // O ambiente do filho é montado explicitamente. Herdar `process.env` inteiro
  // entregaria à CLI todo secret que por acaso estivesse no job.
  const childEnv = {
    PATH: env.PATH,
    HOME: env.HOME,
    // A CLI usa isto para autenticar. É a única variável sensível repassada.
    RAILWAY_TOKEN: env.RAILWAY_TOKEN,
    // Sem cor e sem TTY: a saída precisa ser texto puro para ser parseável.
    NO_COLOR: '1',
    CI: 'true',
    TERM: 'dumb',
  };

  return new Promise((resolvePromise) => {
    execFileImpl(
      bin,
      args,
      {
        env: childEnv,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        // Nunca `shell: true`. Ver o cabeçalho do módulo.
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolvePromise({
            ok: false,
            stdout: '',
            code: typeof error.code === 'number' ? error.code : null,
            errorCategory: classifyCliError({ error, code: error.code, stderr }),
            command,
          });
          return;
        }

        resolvePromise({
          ok: true,
          stdout: String(stdout ?? ''),
          code: 0,
          errorCategory: null,
          command,
        });
      },
    );
  });
}

/**
 * Tenta uma lista de invocações em ordem e devolve a primeira que funcionar.
 *
 * A CLI mudou de flags entre versões maiores e pode mudar de novo. Em vez de
 * apostar numa forma só, o coletor declara as alternativas em ordem de
 * preferência: a primeira é a desejada, as seguintes são degradações
 * conhecidas. O resultado registra **qual** foi usada, para que o relatório
 * possa dizer "veio do fallback `--latest`" em vez de fingir precisão.
 *
 * @param {object} input
 * @param {Array<{ args: string[], label: string, fallback?: boolean }>} input.candidates
 * @param {Function} [input.run] injetável nos testes
 * @param {object} [input.options] repassado para cada invocação
 * @returns {Promise<{ ok: boolean, stdout: string, used: object|null,
 *                     attempts: Array<object>, errorCategory: string|null }>}
 */
export async function runFirstSupported({ candidates = [], run = runRailwayCommand, options = {} }) {
  const attempts = [];

  for (const candidate of candidates) {
    const result = await run({ ...options, args: candidate.args });
    attempts.push({
      label: candidate.label,
      command: result.command,
      ok: result.ok,
      errorCategory: result.errorCategory,
    });

    if (result.ok) {
      return {
        ok: true,
        stdout: result.stdout,
        used: candidate,
        attempts,
        errorCategory: null,
      };
    }

    // Binário ausente ou credencial recusada não melhoram na próxima tentativa:
    // insistir só gastaria tempo do job e poluiria o log com o mesmo erro.
    if (result.errorCategory === 'not_installed' || result.errorCategory === 'authentication') {
      return { ok: false, stdout: '', used: null, attempts, errorCategory: result.errorCategory };
    }
  }

  return {
    ok: false,
    stdout: '',
    used: null,
    attempts,
    errorCategory: attempts.at(-1)?.errorCategory ?? 'unknown',
  };
}
