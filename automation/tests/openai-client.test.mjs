import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ModelCallError,
  callStructuredModel,
  classifyModelError,
  createOpenAIClient,
  readUsage,
} from '../src/openai-client.mjs';
import { resolveOpenAIConfig } from '../src/openai-config.mjs';

const KEY = 'sk-test-0123456789abcdef';
const CONFIG = resolveOpenAIConfig({ OPENAI_API_KEY: KEY });

const schema = z.object({ summary: z.string(), confidence: z.enum(['low', 'medium', 'high']) });
const OUTPUT = { summary: 'tudo certo', confidence: 'high' };

/** Cliente falso que registra o que recebeu. */
function recordingClient(response) {
  const calls = [];
  return {
    calls,
    responses: {
      parse: async (request) => {
        calls.push(request);
        return response;
      },
    },
  };
}

function call(client, overrides = {}) {
  return callStructuredModel({
    client,
    config: CONFIG,
    instructions: 'instruções',
    input: 'payload mascarado',
    schema,
    schemaName: 'teste',
    ...overrides,
  });
}

/* ------------------------------------------------------------------------- */
/* Fábrica do cliente                                                         */
/* ------------------------------------------------------------------------- */

describe('createOpenAIClient', () => {
  it('passa timeout, retries e a chave ao SDK — e nada mais', async () => {
    const received = [];
    class FakeOpenAI {
      constructor(options) {
        received.push(options);
      }
    }

    const client = await createOpenAIClient({
      env: { OPENAI_API_KEY: KEY, OPENAI_TIMEOUT_MS: '12000', OPENAI_MAX_RETRIES: '2' },
      ctor: FakeOpenAI,
    });

    expect(client).toBeInstanceOf(FakeOpenAI);
    expect(received[0]).toEqual({ apiKey: KEY, timeout: 12_000, maxRetries: 2 });
  });

  it('usa timeout e retries padrão quando as variáveis não existem', async () => {
    const received = [];
    class FakeOpenAI {
      constructor(options) {
        received.push(options);
      }
    }

    await createOpenAIClient({ env: { OPENAI_API_KEY: KEY }, ctor: FakeOpenAI });

    expect(received[0].timeout).toBe(45_000);
    expect(received[0].maxRetries).toBe(1);
  });

  it('cria um cliente novo a cada chamada (sem singleton global)', async () => {
    class FakeOpenAI {}
    const env = { OPENAI_API_KEY: KEY };

    const first = await createOpenAIClient({ env, ctor: FakeOpenAI });
    const second = await createOpenAIClient({ env, ctor: FakeOpenAI });

    expect(first).not.toBe(second);
  });
});

/* ------------------------------------------------------------------------- */
/* Chamada estruturada                                                        */
/* ------------------------------------------------------------------------- */

describe('callStructuredModel', () => {
  it('envia os parâmetros da Responses API que a automação define', async () => {
    const client = recordingClient({ id: 'resp_1', status: 'completed', output_parsed: OUTPUT });
    await call(client);

    const request = client.calls[0];
    expect(request.model).toBe('gpt-5-mini');
    expect(request.reasoning).toEqual({ effort: 'low' });
    expect(request.max_output_tokens).toBe(2000);
    expect(request.store).toBe(false);
    expect(request.instructions).toBe('instruções');
    expect(request.input).toEqual([{ role: 'user', content: 'payload mascarado' }]);
    expect(request.text.format).toBeTruthy();
  });

  it('não usa temperature, top_p nem estado entre chamadas', async () => {
    const client = recordingClient({ id: 'resp_1', status: 'completed', output_parsed: OUTPUT });
    await call(client);

    const request = client.calls[0];
    expect(request.temperature).toBeUndefined();
    expect(request.top_p).toBeUndefined();
    expect(request.previous_response_id).toBeUndefined();
    expect(request.background).toBeUndefined();
    expect(request.tools).toBeUndefined();
  });

  it('devolve a saída validada e os metadados da chamada', async () => {
    const client = recordingClient({
      id: 'resp_42',
      model: 'gpt-5-mini-2025-08-07',
      status: 'completed',
      output_parsed: OUTPUT,
      usage: {
        input_tokens: 1000,
        output_tokens: 300,
        output_tokens_details: { reasoning_tokens: 120 },
        total_tokens: 1300,
      },
    });

    const { parsed, metadata } = await call(client);

    expect(parsed).toEqual(OUTPUT);
    expect(metadata.modelProvider).toBe('openai');
    expect(metadata.model).toBe('gpt-5-mini-2025-08-07');
    expect(metadata.modelResponseId).toBe('resp_42');
    expect(metadata.modelLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metadata.modelUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 300,
      reasoningTokens: 120,
      totalTokens: 1300,
    });
  });

  it('mede a latência com o relógio injetado', async () => {
    const client = recordingClient({ id: 'r', status: 'completed', output_parsed: OUTPUT });
    const ticks = [1000, 2234];

    const { metadata } = await call(client, { clock: () => ticks.shift() ?? 2234 });

    expect(metadata.modelLatencyMs).toBe(1234);
  });

  it('descarta campos extras que o modelo tente enviar', async () => {
    const client = recordingClient({
      status: 'completed',
      output_parsed: { ...OUTPUT, deployDecision: 'eligible_for_staging' },
    });

    const { parsed } = await call(client);
    expect(parsed.deployDecision).toBeUndefined();
  });

  it('recusa resposta incompleta', async () => {
    const client = recordingClient({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_parsed: OUTPUT,
    });

    await expect(call(client)).rejects.toMatchObject({ category: 'incomplete' });
  });

  it('recusa resposta com status failed', async () => {
    const generic = recordingClient({ status: 'failed', error: { code: 'server_error' } });
    await expect(call(generic)).rejects.toMatchObject({ category: 'unknown' });

    const limited = recordingClient({ status: 'failed', error: { code: 'rate_limit_exceeded' } });
    await expect(call(limited)).rejects.toMatchObject({ category: 'rate_limit' });
  });

  it('recusa resposta sem saída estruturada (inclusive recusa do modelo)', async () => {
    const vazia = recordingClient({ status: 'completed', output_parsed: null });
    await expect(call(vazia)).rejects.toMatchObject({ category: 'invalid_output' });
  });

  it('recusa saída fora do schema', async () => {
    const client = recordingClient({
      status: 'completed',
      output_parsed: { summary: 'ok', confidence: 'altíssima' },
    });

    await expect(call(client)).rejects.toMatchObject({ category: 'invalid_output' });
  });

  it('não deixa a mensagem do erro sobreviver à tradução', async () => {
    const client = {
      responses: {
        parse: async () => {
          throw new Error('POST /v1/responses 401 authorization: Bearer sk-proj-secreto123456');
        },
      },
    };

    const error = await call(client).catch((caught) => caught);

    expect(error).toBeInstanceOf(ModelCallError);
    expect(error.message).not.toContain('sk-proj-secreto123456');
    expect(error.message).not.toContain('Bearer');
  });
});

/* ------------------------------------------------------------------------- */
/* Classificação de erro                                                      */
/* ------------------------------------------------------------------------- */

describe('classifyModelError', () => {
  it('reconhece os erros do SDK pela classe', async () => {
    const { APIConnectionError, APIConnectionTimeoutError } = await import('openai');

    expect(classifyModelError(new APIConnectionTimeoutError({ message: 'timed out' }))).toBe('timeout');
    expect(classifyModelError(new APIConnectionError({ message: 'connection error' }))).toBe('network');
  });

  it('reconhece autenticação, rate limit e timeout pelo código HTTP', async () => {
    const { AuthenticationError, RateLimitError } = await import('openai');
    const headers = new Headers();

    expect(classifyModelError(new AuthenticationError(401, undefined, 'x', headers))).toBe('authentication');
    expect(classifyModelError(new RateLimitError(429, undefined, 'x', headers))).toBe('rate_limit');
    expect(classifyModelError({ status: 403 })).toBe('authentication');
    expect(classifyModelError({ status: 408 })).toBe('timeout');
    expect(classifyModelError({ status: 503 })).toBe('network');
  });

  it('reconhece erros de socket pelo errno', () => {
    expect(classifyModelError({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyModelError({ code: 'ECONNREFUSED' })).toBe('network');
    expect(classifyModelError({ code: 'ENOTFOUND' })).toBe('network');
  });

  it('reconhece erro de schema', () => {
    const result = schema.safeParse({ summary: 1 });
    expect(classifyModelError(result.error)).toBe('invalid_output');
  });

  it('preserva a categoria de um ModelCallError', () => {
    expect(classifyModelError(new ModelCallError('incomplete'))).toBe('incomplete');
  });

  it('cai em `unknown` no que não reconhece, sem lançar', () => {
    expect(classifyModelError(new Error('deu ruim'))).toBe('unknown');
    expect(classifyModelError(null)).toBe('unknown');
    expect(classifyModelError(undefined)).toBe('unknown');
    expect(classifyModelError('texto solto')).toBe('unknown');
  });

  it('recusa categoria inventada', () => {
    expect(new ModelCallError('quota').category).toBe('unknown');
  });
});

describe('readUsage', () => {
  it('devolve null quando o SDK não informa uso', () => {
    expect(readUsage(undefined)).toBeNull();
    expect(readUsage(null)).toBeNull();
  });

  it('anula apenas o campo ausente', () => {
    expect(readUsage({ input_tokens: 10, total_tokens: 12 })).toEqual({
      inputTokens: 10,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: 12,
    });
  });
});
