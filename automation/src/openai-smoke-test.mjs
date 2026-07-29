/**
 * Smoke test da integração com a OpenAI — a única coisa neste repositório que
 * gasta token de propósito.
 *
 * Responde a uma pergunta que nenhum mock responde: *a chave, o modelo e a
 * saída estruturada funcionam de verdade, agora, com esta configuração?*
 *
 * Por isso é **opt-in duplo**: precisa de `OPENAI_API_KEY` **e** de
 * `OPENAI_LIVE_TEST=true`. Sem as duas, o script recusa a chamada e explica
 * como habilitá-la. Não roda em `npm test`, não roda em `npm run ci`, não roda
 * em Pull Request — o custo de uma chamada real por execução de CI seria pago
 * em toda PR, para responder algo que os mocks já respondem.
 *
 *   OPENAI_LIVE_TEST=true npm run openai:smoke
 *
 * O que é impresso: conexão, modelo pedido, modelo que respondeu, status,
 * latência, tokens e se o schema validou. O que **não** é impresso: a chave,
 * headers, o objeto de erro do SDK.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

import { callStructuredModel, classifyModelError, createOpenAIClient } from './openai-client.mjs';
import { formatLatency, formatUsage } from './render-model-call.mjs';
import { resolveOpenAIConfig } from './openai-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOMATION_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(AUTOMATION_ROOT, '..');

/**
 * Schema mínimo: o objetivo é provar que a saída estruturada volta validada,
 * não gerar análise. Menos campos, menos tokens.
 */
export const smokeSchema = z.object({
  status: z.enum(['ok']),
  detectedFailureType: z.enum(['healthcheck', 'startup', 'network', 'unknown']),
});

const INSTRUCTIONS = [
  'Você é um verificador de conectividade. Responda apenas com o objeto estruturado pedido.',
  'Use `status: "ok"`. Em `detectedFailureType`, classifique a única linha de log recebida.',
].join('\n');

/**
 * Payload mínimo e sanitizado: uma linha de log sintética, sem nada real do
 * repositório, da aplicação ou do ambiente.
 */
const INPUT = 'log: GET /api/health -> HTTP 503 (health check reprovado na tentativa 30 de 30)';

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function checkLiveTestGuard(env) {
  if (env.OPENAI_LIVE_TEST !== 'true') {
    return {
      allowed: false,
      reason: [
        'chamada real não habilitada.',
        '',
        '  Este script consome tokens de verdade. Para executá-lo:',
        '',
        '    OPENAI_LIVE_TEST=true npm run openai:smoke',
        '',
        '  A chave deve estar em `automation/.env` (ou `.env`) como OPENAI_API_KEY,',
        '  nunca em linha de comando, em código ou em arquivo versionado.',
      ].join('\n'),
    };
  }

  if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY.trim().length === 0) {
    return {
      allowed: false,
      reason: [
        'OPENAI_API_KEY ausente.',
        '',
        '  Defina a chave em `automation/.env` (arquivo ignorado pelo git):',
        '',
        '    OPENAI_API_KEY=<sua chave>',
      ].join('\n'),
    };
  }

  return { allowed: true, reason: null };
}

async function main() {
  dotenv.config({ path: [join(AUTOMATION_ROOT, '.env'), join(REPO_ROOT, '.env')], quiet: true });

  const env = process.env;
  const guard = checkLiveTestGuard(env);

  if (!guard.allowed) {
    process.stderr.write(`[openai-smoke] ${guard.reason}\n`);
    process.exitCode = 1;
    return;
  }

  const config = resolveOpenAIConfig(env);
  for (const note of config.notes) {
    process.stdout.write(`[openai-smoke] aviso de configuração: ${note}\n`);
  }

  const client = await createOpenAIClient({ env, config });

  let result;
  try {
    result = await callStructuredModel({
      client,
      config,
      instructions: INSTRUCTIONS,
      input: INPUT,
      schema: smokeSchema,
      schemaName: 'openai_smoke_test',
    });
  } catch (error) {
    // Só a categoria: o objeto de erro do SDK carrega requisição e headers.
    process.stderr.write(
      `[openai-smoke] conexão: falhou\n` +
        `  categoria .......... ${classifyModelError(error)}\n` +
        `  modelo solicitado .. ${config.model}\n` +
        '\n  Verifique a chave, o nome do modelo e o acesso da conta a ele.\n',
    );
    process.exitCode = 1;
    return;
  }

  const { metadata } = result;

  process.stdout.write(
    '[openai-smoke] conexão: ok\n' +
      `  modelo solicitado .. ${config.model}\n` +
      `  modelo retornado ... ${metadata.model}\n` +
      '  status ............. completed\n' +
      `  latência ........... ${formatLatency(metadata.modelLatencyMs)}\n` +
      `  tokens ............. ${formatUsage(metadata.modelUsage)}\n` +
      '  schema ............. válido\n' +
      `  raciocínio ......... ${config.reasoningEffort}\n` +
      `  store .............. ${config.store}\n`,
  );
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    // Nem aqui o erro bruto é impresso.
    process.stderr.write(`[openai-smoke] erro inesperado (${classifyModelError(error)}).\n`);
    process.exitCode = 1;
  });
}
