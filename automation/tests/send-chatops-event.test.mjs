import { describe, expect, it, vi } from 'vitest';

import {
  buildTransportPayload,
  resolveBranch,
  sendChatOpsEvent,
  signPayload,
} from '../src/send-chatops-event.mjs';

/**
 * Vetor compartilhado com `chatops/tests/test_security.py`.
 *
 * As duas pontas assinam `timestamp.corpo_bruto`. Se Node e Python divergirem
 * na montagem dessa mensagem, o sintoma em produção é um 401 opaco no CI —
 * então a divergência precisa aparecer aqui, como teste vermelho.
 */
const VETOR = {
  secret: 'segredo-de-teste',
  timestamp: '1700000000',
  rawBody: '{"event_type":"pipeline_diagnosis"}',
  assinatura: 'sha256=cb12782065cc82a42dd562e1a0d1196b30afdcc44e15ecf989972021e78a1b39',
};

const diagnosis = {
  analysisId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  requestId: '9f8e7d6c-5b4a-4938-9271-0a1b2c3d4e5f',
  repository: 'senai/copa-figurinhas',
  branch: 'feat/ordenar-figurinhas',
  commitSha: 'c0f4a17b93e2d5486ab1e77c2d9f4b6a0e3c81df',
  pipelineStatus: 'failed',
  summary: 'Pipeline falhou em `npm run test`.',
  signal: 'test:AssertionError',
  failureType: 'test',
  probableCause: 'Um teste automatizado falhou.',
  evidence: [{ source: 'log:test:17', excerpt: 'AssertionError: expected 3 to be 2' }],
  impact: 'Entrega bloqueada.',
  riskLevel: 'medium',
  confidence: 'high',
  nextSteps: ['Reproduzir com `npm run test`.'],
  deployDecision: 'blocked',
  requiresHumanApproval: true,
  limitations: [],
  usedFallback: true,
  generatedAt: '2026-07-14T13:05:22.481Z',
};

const env = {
  GITHUB_REPOSITORY: 'senai/copa-figurinhas',
  GITHUB_SHA: 'c0f4a17b93e2d5486ab1e77c2d9f4b6a0e3c81df',
  GITHUB_RUN_ID: '17293847561',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_HEAD_REF: 'feat/ordenar-figurinhas',
  GITHUB_REF_NAME: '42/merge',
  CHATOPS_TARGET: 'test',
};

describe('assinatura', () => {
  it('assina `timestamp.corpo_bruto` com HMAC SHA-256', () => {
    expect(signPayload(VETOR)).toBe(VETOR.assinatura);
  });

  it('muda a assinatura quando o corpo muda', () => {
    const outro = signPayload({ ...VETOR, rawBody: '{"event_type":"outra_coisa"}' });
    expect(outro).not.toBe(VETOR.assinatura);
  });

  it('muda a assinatura quando o timestamp muda', () => {
    expect(signPayload({ ...VETOR, timestamp: '1700000001' })).not.toBe(VETOR.assinatura);
  });
});

describe('resolveBranch', () => {
  it('prefere GITHUB_HEAD_REF: em PR, GITHUB_REF_NAME vira `<numero>/merge`', () => {
    expect(resolveBranch(env)).toBe('feat/ordenar-figurinhas');
  });

  it('cai para GITHUB_REF_NAME fora de Pull Request', () => {
    expect(resolveBranch({ GITHUB_REF_NAME: 'main' })).toBe('main');
  });

  it('não inventa branch quando não há contexto', () => {
    expect(resolveBranch({})).toBe('unknown');
  });
});

describe('buildTransportPayload', () => {
  it('monta o envelope a partir do contexto do GitHub Actions', () => {
    const payload = buildTransportPayload({ diagnosis, env });

    expect(payload).toMatchObject({
      event_type: 'pipeline_diagnosis',
      source: 'github_actions',
      repository: 'senai/copa-figurinhas',
      branch: 'feat/ordenar-figurinhas',
      commit_sha: 'c0f4a17b93e2d5486ab1e77c2d9f4b6a0e3c81df',
      run_id: '17293847561',
      run_url: 'https://github.com/senai/copa-figurinhas/actions/runs/17293847561',
      target: 'test',
    });
  });

  it('transporta o diagnóstico do Guardian sem traduzir campo nenhum', () => {
    const payload = buildTransportPayload({ diagnosis, env });
    expect(payload.diagnosis).toEqual(diagnosis);
  });

  it('não carrega URL de webhook do Discord', () => {
    const payload = buildTransportPayload({ diagnosis, env });
    expect(JSON.stringify(payload)).not.toContain('discord.com');
  });
});

describe('sendChatOpsEvent', () => {
  function fakeFetch(response) {
    return vi.fn().mockResolvedValue(response);
  }

  const ok = {
    ok: true,
    status: 202,
    json: async () => ({ status: 'accepted', request_id: 'req-1', message_id: 'msg-1' }),
  };

  it('envia ao endpoint com os headers de segurança', async () => {
    const fetchImpl = fakeFetch(ok);

    const resultado = await sendChatOpsEvent({
      payload: buildTransportPayload({ diagnosis, env }),
      endpointUrl: 'https://chatops.exemplo.dev/',
      secret: 'segredo',
      token: 'token',
      now: () => 1700000000,
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://chatops.exemplo.dev/webhooks/github-actions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer token');
    expect(init.headers['X-ChatOps-Timestamp']).toBe('1700000000');
    expect(init.headers['X-ChatOps-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(resultado).toEqual({ status: 202, requestId: 'req-1', messageId: 'msg-1' });
  });

  it('assina exatamente os bytes que envia', async () => {
    const fetchImpl = fakeFetch(ok);
    const payload = buildTransportPayload({ diagnosis, env });

    await sendChatOpsEvent({
      payload,
      endpointUrl: 'https://chatops.exemplo.dev',
      secret: 'segredo',
      token: 'token',
      now: () => 1700000000,
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0];
    const esperada = signPayload({ secret: 'segredo', timestamp: '1700000000', rawBody: init.body });

    // Se o corpo fosse reserializado entre assinar e enviar, esta igualdade cairia.
    expect(init.headers['X-ChatOps-Signature']).toBe(esperada);
  });

  it('falha com mensagem segura quando o backend recusa o evento', async () => {
    const fetchImpl = fakeFetch({
      ok: false,
      status: 401,
      json: async () => ({ status: 'rejected', message: 'Assinatura inválida.' }),
    });

    await expect(
      sendChatOpsEvent({
        payload: buildTransportPayload({ diagnosis, env }),
        endpointUrl: 'https://chatops.exemplo.dev',
        secret: 'segredo',
        token: 'token',
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('não vaza o token nem o segredo na mensagem de erro', async () => {
    const fetchImpl = fakeFetch({
      ok: false,
      status: 500,
      json: async () => ({ message: 'erro interno' }),
    });

    const erro = await sendChatOpsEvent({
      payload: buildTransportPayload({ diagnosis, env }),
      endpointUrl: 'https://chatops.exemplo.dev',
      secret: 'segredo-que-nao-pode-vazar',
      token: 'token-que-nao-pode-vazar',
      fetchImpl,
    }).catch((error) => error);

    expect(erro.message).not.toContain('segredo-que-nao-pode-vazar');
    expect(erro.message).not.toContain('token-que-nao-pode-vazar');
  });

  it('propaga falha de rede sem expor o endpoint interno', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      sendChatOpsEvent({
        payload: buildTransportPayload({ diagnosis, env }),
        endpointUrl: 'https://chatops.exemplo.dev',
        secret: 'segredo',
        token: 'token',
        fetchImpl,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
