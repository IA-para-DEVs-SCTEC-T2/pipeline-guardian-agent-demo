import { describe, expect, it } from 'vitest';

import {
  DEFAULTS,
  DEFAULT_MODEL,
  PAYLOAD_LIMITS,
  REASONING_EFFORTS,
  canUseModel,
  capText,
  emptyModelCallMetadata,
  resolveOpenAIConfig,
} from '../src/openai-config.mjs';

const KEY = 'sk-test-0123456789abcdef';

describe('modelo padrão', () => {
  it('usa `gpt-5-mini` quando OPENAI_MODEL não existe', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5-mini');
    expect(resolveOpenAIConfig({}).model).toBe('gpt-5-mini');
    expect(resolveOpenAIConfig({ OPENAI_API_KEY: KEY }).model).toBe('gpt-5-mini');
  });

  it('aceita o override por OPENAI_MODEL', () => {
    expect(resolveOpenAIConfig({ OPENAI_MODEL: 'gpt-5' }).model).toBe('gpt-5');
  });

  it('trata variável vazia ou só com espaços como ausente', () => {
    expect(resolveOpenAIConfig({ OPENAI_MODEL: '' }).model).toBe('gpt-5-mini');
    expect(resolveOpenAIConfig({ OPENAI_MODEL: '   ' }).model).toBe('gpt-5-mini');
  });
});

describe('habilitação do modelo', () => {
  it('depende apenas de OPENAI_API_KEY', () => {
    expect(resolveOpenAIConfig({}).enabled).toBe(false);
    expect(resolveOpenAIConfig({ OPENAI_MODEL: 'gpt-5-mini' }).enabled).toBe(false);
    expect(resolveOpenAIConfig({ OPENAI_API_KEY: KEY }).enabled).toBe(true);
    expect(canUseModel({ OPENAI_API_KEY: KEY })).toBe(true);
  });

  it('não considera chave em branco', () => {
    expect(resolveOpenAIConfig({ OPENAI_API_KEY: '   ' }).enabled).toBe(false);
  });
});

describe('padrões e limites', () => {
  it('aplica os padrões da automação', () => {
    const config = resolveOpenAIConfig({ OPENAI_API_KEY: KEY });

    expect(config.reasoningEffort).toBe('low');
    expect(config.maxOutputTokens).toBe(2000);
    expect(config.timeoutMs).toBe(45_000);
    expect(config.maxRetries).toBe(1);
    expect(config.store).toBe(false);
    expect(config.notes).toEqual([]);
  });

  it('aceita valores válidos', () => {
    const config = resolveOpenAIConfig({
      OPENAI_API_KEY: KEY,
      OPENAI_REASONING_EFFORT: 'medium',
      OPENAI_MAX_OUTPUT_TOKENS: '4000',
      OPENAI_TIMEOUT_MS: '20000',
      OPENAI_MAX_RETRIES: '0',
    });

    expect(config.reasoningEffort).toBe('medium');
    expect(config.maxOutputTokens).toBe(4000);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.maxRetries).toBe(0);
    expect(config.notes).toEqual([]);
  });

  it('só aceita os esforços de raciocínio suportados', () => {
    expect(REASONING_EFFORTS).toEqual(['minimal', 'low', 'medium', 'high']);

    const config = resolveOpenAIConfig({ OPENAI_REASONING_EFFORT: 'turbo' });
    expect(config.reasoningEffort).toBe(DEFAULTS.reasoningEffort);
    expect(config.notes.join(' ')).toMatch(/OPENAI_REASONING_EFFORT/);
  });

  it('cai no padrão quando o número é inválido, e diz isso', () => {
    const cases = [
      ['OPENAI_MAX_OUTPUT_TOKENS', 'muitos', 'maxOutputTokens', DEFAULTS.maxOutputTokens],
      ['OPENAI_MAX_OUTPUT_TOKENS', '-5', 'maxOutputTokens', DEFAULTS.maxOutputTokens],
      ['OPENAI_MAX_OUTPUT_TOKENS', '10', 'maxOutputTokens', DEFAULTS.maxOutputTokens],
      ['OPENAI_MAX_OUTPUT_TOKENS', '999999', 'maxOutputTokens', DEFAULTS.maxOutputTokens],
      ['OPENAI_MAX_OUTPUT_TOKENS', '2000.5', 'maxOutputTokens', DEFAULTS.maxOutputTokens],
      ['OPENAI_TIMEOUT_MS', '0', 'timeoutMs', DEFAULTS.timeoutMs],
      ['OPENAI_TIMEOUT_MS', 'já', 'timeoutMs', DEFAULTS.timeoutMs],
      ['OPENAI_MAX_RETRIES', '99', 'maxRetries', DEFAULTS.maxRetries],
      ['OPENAI_MAX_RETRIES', '-1', 'maxRetries', DEFAULTS.maxRetries],
    ];

    for (const [variable, value, field, expected] of cases) {
      const config = resolveOpenAIConfig({ OPENAI_API_KEY: KEY, [variable]: value });

      expect(config[field]).toBe(expected);
      expect(config.notes.join(' ')).toContain(variable);
    }
  });

  it('não ecoa o valor recusado na limitação', () => {
    const config = resolveOpenAIConfig({ OPENAI_MAX_OUTPUT_TOKENS: 'ghp_naoDeveriaAparecer12345' });
    expect(config.notes.join(' ')).not.toContain('ghp_naoDeveriaAparecer12345');
  });
});

describe('a chave nunca entra na configuração', () => {
  it('não devolve OPENAI_API_KEY em campo nenhum', () => {
    const config = resolveOpenAIConfig({ OPENAI_API_KEY: KEY, OPENAI_MODEL: 'gpt-5-mini' });

    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(Object.keys(config)).not.toContain('apiKey');
    expect(Object.keys(config)).not.toContain('OPENAI_API_KEY');
  });

  it('nem nos metadados publicados no relatório', () => {
    const config = resolveOpenAIConfig({ OPENAI_API_KEY: KEY });
    const metadata = emptyModelCallMetadata(config, 'timeout');

    expect(JSON.stringify(metadata)).not.toContain(KEY);
    expect(metadata).toEqual({
      modelProvider: 'openai',
      model: 'gpt-5-mini',
      modelResponseId: null,
      modelLatencyMs: null,
      modelUsage: null,
      modelErrorCategory: 'timeout',
    });
  });
});

describe('capText', () => {
  it('não mexe no que cabe', () => {
    expect(capText('curto', 100)).toEqual({ text: 'curto', truncated: false });
  });

  it('corta e marca o que sobrou de fora', () => {
    const { text, truncated } = capText('x'.repeat(500), 100);

    expect(truncated).toBe(true);
    expect(text).toContain('400 caractere(s) omitido(s)');
    expect(text.length).toBeLessThan(200);
  });

  it('tolera entrada que não é texto', () => {
    expect(capText(undefined, 10)).toEqual({ text: '', truncated: false });
    expect(capText(null, 10)).toEqual({ text: '', truncated: false });
  });

  it('mantém limites defensivos coerentes', () => {
    expect(PAYLOAD_LIMITS.maxLogChars).toBeLessThan(PAYLOAD_LIMITS.maxTotalChars);
    expect(PAYLOAD_LIMITS.maxDiffChars).toBeLessThan(PAYLOAD_LIMITS.maxTotalChars);
  });
});
