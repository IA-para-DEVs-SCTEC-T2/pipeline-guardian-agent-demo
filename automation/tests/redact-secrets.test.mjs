import { describe, it, expect } from 'vitest';

import { detectSecrets, redactSecrets, redactSecretsDeep, REDACTED } from '../src/redact-secrets.mjs';
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
