import { describe, it, expect } from 'vitest';

import {
  detectSecrets,
  isUsageMetric,
  redactCredentialMaterial,
  redactSecrets,
  redactSecretsDeep,
  REDACTED,
} from '../src/redact-secrets.mjs';
import { readFixtureLog } from '../src/simulate-failure.mjs';

describe('redactSecrets: categorias de segredo', () => {
  const cases = [
    {
      name: 'OPENAI_API_KEY',
      input: 'OPENAI_API_KEY=sk-proj-9xTgQwErTyUiOpAsDfGhJkLzXcVbNm1234567890',
      secret: 'sk-proj-9xTgQwErTyUiOpAsDfGhJkLzXcVbNm1234567890',
      keeps: 'OPENAI_API_KEY',
    },
    {
      name: 'Authorization Bearer',
      input: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      secret: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      keeps: 'Bearer',
    },
    {
      name: 'token ghp_',
      input: 'git push https://ghp_9AbCdEfGhIjKlMnOpQrStUvWxYz012345@github.com/senai/copa.git',
      secret: 'ghp_9AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      keeps: 'github.com',
    },
    {
      name: 'token github_pat_',
      input: 'usando github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ para publicar',
      secret: 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ',
      keeps: 'para publicar',
    },
    {
      name: 'valor iniciado por sk-',
      input: 'chave carregada: sk-abcdef1234567890',
      secret: 'sk-abcdef1234567890',
      keeps: 'chave carregada',
    },
    {
      name: 'variável PASSWORD',
      input: 'DEPLOY_PASSWORD=Trof3u-Copa-2026!',
      secret: 'Trof3u-Copa-2026!',
      keeps: 'DEPLOY_PASSWORD',
    },
    {
      name: 'variável SECRET',
      input: 'APP_SECRET = s3cr3t-v4lue',
      secret: 's3cr3t-v4lue',
      keeps: 'APP_SECRET',
    },
    {
      name: 'variável TOKEN',
      input: '"GITHUB_TOKEN": "abc123def456"',
      secret: 'abc123def456',
      keeps: 'GITHUB_TOKEN',
    },
    {
      name: 'credencial em URL',
      input: 'npm publish --registry https://ci-bot:S3nh4-Sup3r@registry.internal.example.com',
      secret: 'S3nh4-Sup3r',
      keeps: 'registry.internal.example.com',
    },
    {
      name: 'cookie',
      input: 'Set-Cookie: session_id=8f3ab1c2d4e5f6a7b8c9; Path=/; HttpOnly',
      secret: '8f3ab1c2d4e5f6a7b8c9',
      keeps: 'Set-Cookie',
    },
  ];

  for (const { name, input, secret, keeps } of cases) {
    it(`mascara ${name} e preserva o contexto ao redor`, () => {
      const output = redactSecrets(input);

      expect(output).not.toContain(secret);
      expect(output).toContain(REDACTED);
      expect(output).toContain(keeps);
    });
  }

  it('não altera texto sem segredos', () => {
    const input = 'npm run test\n Tests 20 passed (20)';
    expect(redactSecrets(input)).toBe(input);
  });

  it('é idempotente: redigir duas vezes não muda o resultado', () => {
    const once = redactSecrets('OPENAI_API_KEY=sk-abcdef1234567890');
    expect(redactSecrets(once)).toBe(once);
  });
});

describe('métrica de uso não é credencial', () => {
  // Regressão: o relatório escreve `Tokens: 1.300` para o consumo da chamada à
  // OpenAI. A regra de `token: valor` mascarava o número, e o relatório perdia
  // justamente a informação que ele existe para dar.
  const preservados = [
    'Tokens: 1.300',
    'Tokens: —',
    '- Tokens: 1.300 (entrada 1.000 · saída 300 · raciocínio 120)',
    'entrada 1.000',
    'saída 300',
    'raciocínio 120',
    'inputTokens: 1000',
    'outputTokens: 300',
    'reasoningTokens: 120',
    'totalTokens: 1300',
    '"totalTokens": "1300"',
    'total_tokens=1300',
  ];

  for (const input of preservados) {
    it(`preserva \`${input}\``, () => {
      expect(redactSecrets(input)).toBe(input);
      expect(redactSecrets(input)).not.toContain(REDACTED);
    });
  }

  const redigidos = [
    ['OPENAI_API_KEY=sk-segredo-de-verdade-123456', 'sk-segredo-de-verdade-123456'],
    ['GITHUB_TOKEN=ghp_segredoDeVerdade1234567890', 'ghp_segredoDeVerdade1234567890'],
    ['AUTH_TOKEN=valor-secreto-real', 'valor-secreto-real'],
    ['access_token: 9f8e7d6c5b4a3210', '9f8e7d6c5b4a3210'],
    ['Authorization: Bearer segredo-de-verdade', 'segredo-de-verdade'],
    ['token: segredo-real', 'segredo-real'],
    ['tokens: segredo-real-nao-numerico', 'segredo-real-nao-numerico'],
    // Nome no singular: continua sendo credencial, mesmo com valor numérico.
    ['token: 123456', '123456'],
    ['password: 123456', '123456'],
  ];

  for (const [input, secret] of redigidos) {
    it(`continua redigindo \`${input}\``, () => {
      const output = redactSecrets(input);

      expect(output).not.toContain(secret);
      expect(output).toContain(REDACTED);
    });
  }

  it('exige nome no plural E valor numérico para abrir exceção', () => {
    expect(isUsageMetric('Tokens', '1.300')).toBe(true);
    expect(isUsageMetric('totalTokens', '1300')).toBe(true);
    expect(isUsageMetric('Tokens', '—')).toBe(true);
    expect(isUsageMetric('token', '1300')).toBe(false);
    expect(isUsageMetric('access_token', '1300')).toBe(false);
    expect(isUsageMetric('Tokens', 'ghp_abc123')).toBe(false);
    expect(isUsageMetric('password', '123456')).toBe(false);
  });

  it('não acusa incidente de segurança por causa de uma métrica de uso', () => {
    // Um log que imprime `Tokens: 1.300` não pode reprovar o pipeline como
    // vazamento de credencial.
    expect(detectSecrets('uso da chamada — Tokens: 1.300')).toEqual([]);
    expect(detectSecrets('token: segredo-real').length).toBeGreaterThan(0);
  });
});

describe('redactCredentialMaterial: a última barreira', () => {
  it('pega segredo pela forma do valor', () => {
    const cases = [
      ['chave: sk-abcdef1234567890', 'sk-abcdef1234567890'],
      ['push com ghp_9AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'ghp_9AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
      ['usando github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ', 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ'],
      ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9', 'eyJhbGciOiJIUzI1NiJ9'],
      ['https://ci-bot:S3nh4-Sup3r@registry.exemplo.com', 'S3nh4-Sup3r'],
      ['Set-Cookie: session_id=8f3ab1c2d4e5f6a7b8c9', '8f3ab1c2d4e5f6a7b8c9'],
    ];

    for (const [input, secret] of cases) {
      const output = redactCredentialMaterial(input);
      expect(output).not.toContain(secret);
      expect(output).toContain(REDACTED);
    }
  });

  it('não toca em rótulo de relatório', () => {
    const markdown = '- Tokens: 1.300 (entrada 1.000 · saída 300 · raciocínio 120)';
    expect(redactCredentialMaterial(markdown)).toBe(markdown);
  });
});

describe('redactSecrets: fixture de segurança', () => {
  const raw = readFixtureLog('security');

  it('remove todos os valores sensíveis do log', () => {
    const output = redactSecrets(raw);

    expect(output).not.toMatch(/sk-proj-/);
    expect(output).not.toMatch(/ghp_/);
    expect(output).not.toMatch(/S3nh4-Sup3r-S3cr3t4/);
    expect(output).not.toMatch(/8f3ab1c2d4e5/);
    expect(output).toContain(REDACTED);
  });

  it('preserva os sinais que sustentam a classificação `security`', () => {
    const output = redactSecrets(raw);

    expect(output).toContain('segredo detectado');
    expect(output).toContain('token detectado');
    expect(output).toContain('credencial detectada');
  });
});

describe('detectSecrets', () => {
  it('encontra segredos no conteúdo original', () => {
    const findings = detectSecrets(readFixtureLog('security'));
    const rules = findings.map((finding) => finding.rule);

    expect(findings.length).toBeGreaterThan(0);
    expect(rules).toContain('url-credentials');
    expect(rules).toContain('cookie');
  });

  it('não acusa segredo em log limpo', () => {
    expect(detectSecrets(readFixtureLog('test'))).toEqual([]);
  });
});

describe('redactSecretsDeep', () => {
  it('percorre strings, arrays e objetos aninhados', () => {
    const output = redactSecretsDeep({
      summary: 'vazou ghp_9AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      evidence: [{ source: 'log:scan', excerpt: 'OPENAI_API_KEY=sk-abcdef1234567890' }],
      usedFallback: false,
      count: 3,
    });

    expect(output.summary).not.toContain('ghp_');
    expect(output.evidence[0].excerpt).not.toContain('sk-abcdef');
    expect(output.usedFallback).toBe(false);
    expect(output.count).toBe(3);
  });
});
