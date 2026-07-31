import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyCharBudget,
  collectRailwayEvidence,
  correlateDeployment,
  extractDeployments,
  readDeploymentId,
  readDeploymentSha,
  readDeploymentStatus,
  readRailwayEvidence,
  sameCommit,
  writeRailwayEvidence,
} from '../src/collect-railway-evidence.mjs';
import { classifyCliError, describeInvocation, runFirstSupported } from '../src/railway-cli.mjs';

const SHA = '4c1f9ab72e3d05b8a6c4f1e290d7b3568af02c19';
const OTHER_SHA = 'e82b60d5f1a94c37bd08e25a71f3c6094ab1d7e2';

const BASE_ENV = {
  RAILWAY_TOKEN: 'railway-token-de-teste',
  RAILWAY_PROJECT: 'copa-figurinhas',
  RAILWAY_SERVICE: 'copa-figurinhas',
  RAILWAY_ENVIRONMENT: 'production',
  EXPECTED_COMMIT_SHA: SHA,
  // Opt-in explícito. Os testes injetam CLI falsa e nunca tocam a rede — mas o
  // caminho exercitado precisa ser o mesmo do workflow, incluindo esta porta.
  RAILWAY_LIVE_TEST: 'true',
};

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'railway-evidence-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * CLI falsa. `responder` recebe os argumentos e devolve `{ ok, stdout }` — os
 * testes nunca instalam binário nem tocam a rede.
 */
function fakeCli(responder) {
  return async ({ args }) => {
    const result = responder(args) ?? { ok: false, errorCategory: 'unsupported_command' };
    return {
      ok: Boolean(result.ok),
      stdout: result.stdout ?? '',
      code: result.ok ? 0 : 1,
      errorCategory: result.ok ? null : (result.errorCategory ?? 'unknown'),
      command: describeInvocation(args),
    };
  };
}

const DEPLOYMENTS = (sha) =>
  JSON.stringify([
    { id: 'dep-novo', status: 'SUCCESS', createdAt: '2026-07-30T13:00:00Z', meta: { commitSha: sha } },
    { id: 'dep-antigo', status: 'SUCCESS', createdAt: '2026-07-29T10:00:00Z', meta: { commitSha: 'aaaaaaa1111' } },
  ]);

const LOG_LINE = (message) => JSON.stringify({ timestamp: '2026-07-30T13:00:41.900Z', message });

/* ------------------------------------------------------------------------- */
/* Correlação                                                                 */
/* ------------------------------------------------------------------------- */

describe('correlação de SHA', () => {
  it('reconhece SHA completo idêntico', () => {
    const { deployments } = extractDeployments(DEPLOYMENTS(SHA));
    const result = correlateDeployment({ deployments, expectedCommitSha: SHA });

    expect(result.correlationStatus).toBe('matched');
    expect(result.observedCommitSha).toBe(SHA);
    expect(readDeploymentId(result.deployment)).toBe('dep-novo');
  });

  it('reconhece abreviação válida do SHA', () => {
    const { deployments } = extractDeployments(DEPLOYMENTS(SHA.slice(0, 12)));
    const result = correlateDeployment({ deployments, expectedCommitSha: SHA });

    expect(result.correlationStatus).toBe('matched');
    expect(result.observedCommitSha).toBe(SHA.slice(0, 12));
  });

  it('marca mismatch quando o SHA declarado é de outro commit', () => {
    const { deployments } = extractDeployments(DEPLOYMENTS(OTHER_SHA));
    const result = correlateDeployment({ deployments, expectedCommitSha: SHA });

    expect(result.correlationStatus).toBe('mismatch');
    expect(result.observedCommitSha).toBe(OTHER_SHA);
    expect(result.limitations.join(' ')).toMatch(/não é o commit esperado/i);
  });

  it('declara correlação parcial quando a plataforma não informa SHA', () => {
    const { deployments } = extractDeployments(
      JSON.stringify([{ id: 'dep-1', status: 'SUCCESS', createdAt: '2026-07-30T13:00:00Z' }]),
    );
    const result = correlateDeployment({ deployments, expectedCommitSha: SHA });

    expect(result.correlationStatus).toBe('partial');
    expect(result.observedCommitSha).toBeNull();
    expect(result.limitations.join(' ')).toMatch(/parcial/i);
    // Não presume que o mais recente seja o correto — usa como hipótese.
    expect(readDeploymentId(result.deployment)).toBe('dep-1');
  });

  it('declara unknown quando nenhum deployment foi encontrado', () => {
    const result = correlateDeployment({ deployments: [], expectedCommitSha: SHA });

    expect(result.correlationStatus).toBe('unknown');
    expect(result.deployment).toBeNull();
    expect(result.limitations.join(' ')).toMatch(/Nenhum deployment foi listado/i);
  });

  it('exige ao menos 7 caracteres de prefixo comum', () => {
    expect(sameCommit(SHA, SHA)).toBe(true);
    expect(sameCommit(SHA, SHA.slice(0, 7))).toBe(true);
    expect(sameCommit(SHA, SHA.slice(0, 6))).toBe(false);
    expect(sameCommit(SHA, OTHER_SHA)).toBe(false);
    expect(sameCommit(null, SHA)).toBe(false);
  });
});

describe('leitura de campos do deployment', () => {
  it('encontra o SHA sob qualquer um dos nomes usados', () => {
    expect(readDeploymentSha({ commitSha: SHA })).toBe(SHA);
    expect(readDeploymentSha({ meta: { commitHash: SHA } })).toBe(SHA);
    expect(readDeploymentSha({ snapshot: { commitSha: SHA } })).toBe(SHA);
    expect(readDeploymentSha({ commitSha: 'não-é-sha' })).toBeNull();
    expect(readDeploymentSha({})).toBeNull();
  });

  it('normaliza o status da plataforma', () => {
    expect(readDeploymentStatus({ status: 'SUCCESS' })).toBe('success');
    expect(readDeploymentStatus({ status: 'CRASHED' })).toBe('crashed');
    expect(readDeploymentStatus({ status: 'FAILED' })).toBe('failed');
    expect(readDeploymentStatus({ status: 'BUILDING' })).toBe('in_progress');
    expect(readDeploymentStatus({})).toBe('unknown');
  });

  it('extrai deployments de array na raiz, objeto aninhado e status', () => {
    expect(extractDeployments(DEPLOYMENTS(SHA)).deployments).toHaveLength(2);
    expect(
      extractDeployments(JSON.stringify({ deployments: [{ id: 'a', status: 'SUCCESS' }] })).deployments,
    ).toHaveLength(1);
    expect(extractDeployments('não é json').parsed).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Token ausente e falhas da CLI                                              */
/* ------------------------------------------------------------------------- */

describe('sem opt-in explícito', () => {
  it('não toca a plataforma quando RAILWAY_LIVE_TEST não é "true"', async () => {
    let chamou = false;

    const { metadata } = await collectRailwayEvidence({
      // Token presente e tudo configurado — falta só o opt-in.
      env: { ...BASE_ENV, RAILWAY_LIVE_TEST: '' },
      run: async () => {
        chamou = true;
        return { ok: true, stdout: '', code: 0, errorCategory: null, command: '' };
      },
    });

    expect(chamou).toBe(false);
    expect(metadata.sourceCoverage.railway).toBe(false);
    expect(metadata.limitations.join(' ')).toMatch(/RAILWAY_LIVE_TEST=true/);
  });

  it('nem com o valor errado', async () => {
    let chamou = false;

    await collectRailwayEvidence({
      env: { ...BASE_ENV, RAILWAY_LIVE_TEST: 'sim' },
      run: async () => {
        chamou = true;
        return { ok: true, stdout: '', code: 0, errorCategory: null, command: '' };
      },
    });

    expect(chamou).toBe(false);
  });
});

describe('sem RAILWAY_TOKEN', () => {
  it('não falha, declara a limitação e zera a cobertura', async () => {
    let chamou = false;
    const { metadata, streams } = await collectRailwayEvidence({
      env: { ...BASE_ENV, RAILWAY_TOKEN: '' },
      run: async () => {
        chamou = true;
        return { ok: true, stdout: '', code: 0, errorCategory: null, command: '' };
      },
    });

    expect(chamou).toBe(false);
    expect(metadata.sourceCoverage.railway).toBe(false);
    expect(metadata.limitations.join(' ')).toMatch(/RAILWAY_TOKEN/);
    expect(streams.build).toEqual([]);
    expect(streams.deploy).toEqual([]);
    expect(streams.runtime).toEqual([]);
  });
});

describe('falha da Railway CLI', () => {
  it('categoriza o erro sem publicar o stderr bruto', async () => {
    const { metadata } = await collectRailwayEvidence({
      env: BASE_ENV,
      run: fakeCli(() => ({
        ok: false,
        errorCategory: classifyCliError({
          stderr: 'Unauthorized: token sk-proj-vazado-1234567890 rejeitado por api.railway.app',
        }),
      })),
    });

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('sk-proj-vazado-1234567890');
    expect(serialized).not.toContain('api.railway.app');
    expect(metadata.sourceCoverage.railway).toBe(false);
    expect(metadata.limitations.length).toBeGreaterThan(0);
  });

  it('reconhece CLI ausente e para cedo', async () => {
    const { metadata } = await collectRailwayEvidence({
      env: BASE_ENV,
      run: fakeCli(() => ({ ok: false, errorCategory: 'not_installed' })),
    });

    expect(metadata.cliErrorCategory).toBe('not_installed');
    expect(metadata.limitations.join(' ')).toMatch(/CLI não está disponível/i);
  });

  it('classifica as categorias sem carregar a mensagem', () => {
    expect(classifyCliError({ error: { code: 'ENOENT' } })).toBe('not_installed');
    expect(classifyCliError({ stderr: 'Unauthorized' })).toBe('authentication');
    expect(classifyCliError({ stderr: 'unrecognized subcommand' })).toBe('unsupported_command');
    expect(classifyCliError({ stderr: 'deployment not found' })).toBe('not_found');
    expect(classifyCliError({ error: { killed: true } })).toBe('timeout');
    expect(classifyCliError({ stderr: 'algo estranho' })).toBe('unknown');
  });

  it('não insiste depois de erro de autenticação', async () => {
    let tentativas = 0;
    const result = await runFirstSupported({
      candidates: [{ label: 'a', args: ['1'] }, { label: 'b', args: ['2'] }, { label: 'c', args: ['3'] }],
      run: async ({ args }) => {
        tentativas += 1;
        return { ok: false, stdout: '', code: 1, errorCategory: 'authentication', command: String(args) };
      },
    });

    expect(tentativas).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.errorCategory).toBe('authentication');
  });

  it('cai para a próxima alternativa quando um comando não é suportado', async () => {
    const result = await runFirstSupported({
      candidates: [{ label: 'novo', args: ['novo'] }, { label: 'antigo', args: ['antigo'] }],
      run: async ({ args }) =>
        args[0] === 'novo'
          ? { ok: false, stdout: '', code: 1, errorCategory: 'unsupported_command', command: '' }
          : { ok: true, stdout: 'funcionou', code: 0, errorCategory: null, command: '' },
    });

    expect(result.ok).toBe(true);
    expect(result.used.label).toBe('antigo');
    expect(result.attempts).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------- */
/* Coleta completa                                                            */
/* ------------------------------------------------------------------------- */

describe('coleta bem-sucedida', () => {
  const responder = (args) => {
    if (args[0] === 'link') return { ok: true, stdout: '' };
    if (args[0] === 'deployment' || args[0] === 'deployments' || args[0] === 'status') {
      return { ok: true, stdout: DEPLOYMENTS(SHA) };
    }
    if (args[0] === 'logs') {
      const stream = args.includes('--build') ? 'build' : args.includes('--deployment') ? 'deploy' : 'runtime';
      return { ok: true, stdout: [LOG_LINE(`linha de ${stream} 1`), LOG_LINE(`linha de ${stream} 2`)].join('\n') };
    }
    return { ok: false, errorCategory: 'unsupported_command' };
  };

  it('coleta os três fluxos e correlaciona o deployment', async () => {
    const { metadata, streams, log } = await collectRailwayEvidence({ env: BASE_ENV, run: fakeCli(responder) });

    expect(metadata.correlationStatus).toBe('matched');
    expect(metadata.deploymentId).toBe('dep-novo');
    expect(metadata.deploymentStatus).toBe('success');
    expect(metadata.sourceCoverage).toMatchObject({
      railway: true,
      railwayBuild: true,
      railwayDeploy: true,
      railwayRuntime: true,
    });
    expect(streams.build).toHaveLength(2);
    expect(streams.runtime[0].message).toContain('runtime');
    expect(log.join('\n')).toContain('coleta do Railway concluída');
  });

  it('nunca grava o token nos metadados nem no log da coleta', async () => {
    const { metadata, log } = await collectRailwayEvidence({ env: BASE_ENV, run: fakeCli(responder) });

    const everything = JSON.stringify(metadata) + log.join('\n');
    expect(everything).not.toContain('railway-token-de-teste');
  });

  it('sanitiza segredo do log antes de persistir', async () => {
    const leaky = (args) => {
      if (args[0] === 'logs') {
        return {
          ok: true,
          stdout: [
            LOG_LINE('Authorization: Bearer ghp_abcdefghijklmnop1234567890'),
            LOG_LINE('OPENAI_API_KEY=sk-proj-super-secreto-1234567890'),
            LOG_LINE('DATABASE_URL=postgres://app:senha123@db.interno:5432/x'),
          ].join('\n'),
        };
      }
      return responder(args);
    };

    const { metadata, streams } = await collectRailwayEvidence({ env: BASE_ENV, run: fakeCli(leaky) });
    const serialized = JSON.stringify({ metadata, streams });

    expect(serialized).not.toContain('ghp_abcdefghijklmnop1234567890');
    expect(serialized).not.toContain('sk-proj-super-secreto-1234567890');
    expect(serialized).not.toContain('senha123');
    expect(serialized).toContain('[REDACTED]');
    expect(metadata.limitations.join(' ')).toMatch(/Conteúdo sensível/i);
  });

  it('respeita o limite de linhas por fluxo', async () => {
    const muitas = (args) => {
      if (args[0] === 'logs') {
        return { ok: true, stdout: Array.from({ length: 900 }, (_, i) => LOG_LINE(`linha ${i}`)).join('\n') };
      }
      return responder(args);
    };

    const { metadata, streams } = await collectRailwayEvidence({
      env: BASE_ENV,
      run: fakeCli(muitas),
      maxLinesPerStream: 300,
    });

    expect(streams.build.length).toBeLessThanOrEqual(300);
    expect(metadata.limitations.join(' ')).toMatch(/limitados às últimas 300 linhas/i);
  });

  it('respeita o teto total de caracteres', async () => {
    const gordas = (args) => {
      if (args[0] === 'logs') {
        return { ok: true, stdout: Array.from({ length: 300 }, (_, i) => LOG_LINE(`${i} ${'x'.repeat(400)}`)).join('\n') };
      }
      return responder(args);
    };

    const { metadata, streams } = await collectRailwayEvidence({
      env: BASE_ENV,
      run: fakeCli(gordas),
      maxTotalChars: 20_000,
    });

    const total = JSON.stringify(streams).length;
    expect(total).toBeLessThanOrEqual(25_000);
    expect(metadata.limitations.join(' ')).toMatch(/teto total/i);
  });

  it('marca o uso do comando de contingência como limitação', async () => {
    // Sem lista de deployments não há id: a coleta cai no comando por serviço.
    const semLista = (args) => {
      if (args[0] === 'link') return { ok: true, stdout: '' };
      if (args[0] === 'logs') return { ok: true, stdout: LOG_LINE('linha') };
      return { ok: false, errorCategory: 'not_found' };
    };

    const { metadata } = await collectRailwayEvidence({ env: BASE_ENV, run: fakeCli(semLista) });

    expect(metadata.usedFallbackCommand).toBe(true);
    expect(metadata.limitations.join(' ')).toMatch(/contingência/i);
  });
});

describe('applyCharBudget', () => {
  it('corta quando o orçamento acaba', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ message: 'x'.repeat(100), i }));
    const { kept, capped } = applyCharBudget(events, 300);

    expect(capped).toBe(true);
    expect(kept.length).toBeLessThan(10);
  });

  it('mantém tudo quando cabe', () => {
    const events = [{ a: 1 }, { b: 2 }];
    const { kept, capped } = applyCharBudget(events, 10_000);

    expect(capped).toBe(false);
    expect(kept).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------- */
/* Persistência                                                               */
/* ------------------------------------------------------------------------- */

describe('escrita e leitura das evidências', () => {
  it('grava os cinco arquivos e lê de volta', async () => {
    const { metadata, streams, log } = await collectRailwayEvidence({
      env: BASE_ENV,
      run: fakeCli((args) => {
        if (args[0] === 'link') return { ok: true, stdout: '' };
        if (args[0] === 'deployment') return { ok: true, stdout: DEPLOYMENTS(SHA) };
        if (args[0] === 'logs') return { ok: true, stdout: LOG_LINE('uma linha qualquer') };
        return { ok: false, errorCategory: 'unsupported_command' };
      }),
    });

    const outDir = tempDir();
    const { files } = writeRailwayEvidence({ metadata, streams, log, outDir });

    expect(files).toHaveLength(5);
    for (const name of ['collection-metadata.json', 'build.jsonl', 'deploy.jsonl', 'runtime.jsonl', 'collection.log']) {
      expect(files.some((file) => file.endsWith(name)), `faltou ${name}`).toBe(true);
    }

    const back = readRailwayEvidence(outDir);
    expect(back.available).toBe(true);
    expect(back.metadata.correlationStatus).toBe('matched');
    expect(back.streams.build.length).toBeGreaterThan(0);
  });

  it('lida com diretório inexistente sem lançar', () => {
    const back = readRailwayEvidence(join(tempDir(), 'não-existe'));

    expect(back.available).toBe(false);
    expect(back.metadata).toBeNull();
    expect(back.streams).toEqual({ build: [], deploy: [], runtime: [] });
  });

  it('collection-metadata.json tem os campos exigidos pelo relatório', async () => {
    const { metadata, streams, log } = await collectRailwayEvidence({
      env: BASE_ENV,
      run: fakeCli(() => ({ ok: false, errorCategory: 'not_found' })),
    });

    const outDir = tempDir();
    writeRailwayEvidence({ metadata, streams, log, outDir });
    const saved = JSON.parse(readFileSync(join(outDir, 'collection-metadata.json'), 'utf8'));

    for (const field of [
      'requestedCommitSha',
      'observedCommitSha',
      'deploymentId',
      'deploymentStatus',
      'service',
      'environment',
      'collectedAt',
      'correlationStatus',
      'limitations',
      'sourceCoverage',
    ]) {
      expect(saved, `campo ausente: ${field}`).toHaveProperty(field);
    }
  });
});
