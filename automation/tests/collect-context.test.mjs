import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  buildEvidenceList,
  collectContext,
  inspectCommandResults,
  readCommandLogs,
  readPipelineMetadata,
  readPullRequestDiff,
  scanForSensitiveData,
} from '../src/collect-context.mjs';
import { simulateFailure, simulateSuccess } from '../src/simulate-failure.mjs';
import { isPullRequestCommentEnabled, upsertPullRequestComment } from '../src/upsert-pr-comment.mjs';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-guardian-'));
  tempDirs.push(dir);
  return dir;
}

describe('readPipelineMetadata', () => {
  it('normaliza os metadados do pipeline', () => {
    const metadata = readPipelineMetadata(simulateFailure('test'));

    expect(metadata.repository).toBe('senai/copa-figurinhas');
    expect(metadata.environment).toBe('staging');
    expect(metadata.isRollback).toBe(false);
    expect(metadata.limitations).toEqual([]);
  });

  it('registra limitação quando falta metadado', () => {
    const metadata = readPipelineMetadata({ pipeline: { repository: 'senai/copa' } });

    expect(metadata.branch).toBe('unknown');
    expect(metadata.environment).toBe('unknown');
    expect(metadata.limitations.join(' ')).toMatch(/commitSha/);
  });

  it('reconhece production e prod como o mesmo ambiente', () => {
    expect(readPipelineMetadata({ pipeline: { environment: 'prod' } }).environment).toBe('production');
  });
});

describe('readCommandLogs', () => {
  it('devolve os logs mascarados e marca o status de cada comando', () => {
    const commands = readCommandLogs(simulateFailure('security'));
    const scan = commands.find((command) => command.name === 'secret-scan');

    expect(scan.status).toBe('failed');
    expect(scan.log).not.toMatch(/sk-proj-/);
    expect(scan.log).toContain('[REDACTED]');
    expect(commands.find((command) => command.name === 'lint').status).toBe('skipped');
  });
});

describe('readPullRequestDiff', () => {
  it('lê os arquivos alterados e mascara o patch', () => {
    const diff = readPullRequestDiff(simulateFailure('security'));
    const paths = diff.files.map((file) => file.path);

    expect(diff.available).toBe(true);
    expect(paths).toContain('backend/src/config.js');
    expect(diff.patch).not.toMatch(/ghp_/);
  });

  it('marca ausência de diff', () => {
    expect(readPullRequestDiff({}).available).toBe(false);
  });
});

describe('inspectCommandResults', () => {
  it('deriva o status do pipeline dos códigos de saída', () => {
    const failed = inspectCommandResults(readCommandLogs(simulateFailure('test')));
    expect(failed.pipelineStatus).toBe('failed');
    expect(failed.failedCommands[0].command).toBe('npm run test');

    const green = inspectCommandResults(readCommandLogs(simulateSuccess()));
    expect(green.pipelineStatus).toBe('success');

    const partial = inspectCommandResults([{ status: 'passed' }, { status: 'skipped' }]);
    expect(partial.pipelineStatus).toBe('partial');

    expect(inspectCommandResults([]).pipelineStatus).toBe('partial');
  });
});

describe('scanForSensitiveData', () => {
  it('encontra segredos no conteúdo original', () => {
    const result = scanForSensitiveData([
      { source: 'log:deploy', content: 'OPENAI_API_KEY=sk-abcdef1234567890' },
    ]);

    expect(result.hasSensitiveData).toBe(true);
    expect(result.findings[0].source).toBe('log:deploy');
  });

  it('não acusa segredo onde não há', () => {
    expect(scanForSensitiveData([{ source: 'log:test', content: 'Tests 20 passed' }]).hasSensitiveData).toBe(false);
  });
});

describe('buildEvidenceList', () => {
  it('monta evidências a partir de trechos reais, sem duplicar', () => {
    const evidence = buildEvidenceList({
      matches: [
        { source: 'log:test', line: 18, excerpt: 'AssertionError: expected 33 to be 50' },
        { source: 'log:test', line: 18, excerpt: 'AssertionError: expected 33 to be 50' },
      ],
      commands: [{ name: 'test', command: 'npm run test', exitCode: 1, status: 'failed' }],
      diff: { files: [{ path: 'backend/src/services/report.js', additions: 1, deletions: 1 }] },
    });

    expect(evidence).toHaveLength(3);
    expect(evidence[0]).toEqual({ source: 'log:test:18', excerpt: 'AssertionError: expected 33 to be 50' });
    expect(evidence[1].excerpt).toMatch(/exit code 1/);
    expect(evidence[2].source).toBe('diff:files');
  });

  it('mascara o trecho da evidência', () => {
    const evidence = buildEvidenceList({
      matches: [{ source: 'log:scan', line: 3, excerpt: 'OPENAI_API_KEY=sk-abcdef1234567890' }],
    });

    expect(evidence[0].excerpt).not.toContain('sk-abcdef');
  });
});

describe('collectContext', () => {
  it('não deixa segredo nas fontes de texto entregues ao agente', () => {
    const context = collectContext(simulateFailure('security'));
    const text = context.textSources.map((entry) => entry.content).join('\n');

    expect(context.sensitive.hasSensitiveData).toBe(true);
    expect(text).not.toMatch(/sk-proj-|ghp_|github_pat_|S3nh4-Sup3r/);
    expect(JSON.stringify(context.commands)).not.toContain('rawLog');
  });

  it('acumula as limitações da coleta', () => {
    const context = collectContext({ pipeline: {}, commands: [], diff: {} });

    expect(context.limitations.join(' ')).toMatch(/Logs de comando ausentes/);
    expect(context.limitations.join(' ')).toMatch(/Diff da Pull Request não disponível/);
  });
});

describe('upsertPullRequestComment', () => {
  const diagnosis = {
    analysisId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    requestId: 'req-1',
    repository: 'senai/copa-figurinhas',
    branch: 'main',
    commitSha: 'c0f4a17b93e2d5486ab1e77c2d9f4b6a0e3c81df',
    pipelineStatus: 'failed',
    summary: 'Testes falharam.',
    signal: 'test:AssertionError',
    failureType: 'test',
    probableCause: 'x',
    evidence: [],
    impact: 'y',
    riskLevel: 'medium',
    confidence: 'high',
    nextSteps: [],
    deployDecision: 'blocked',
    requiresHumanApproval: true,
    limitations: [],
    usedFallback: true,
    generatedAt: '2026-07-13T12:00:00.000Z',
  };

  it('em dry-run, grava o arquivo e não chama a rede', async () => {
    const fetchImpl = vi.fn();
    const outFile = join(tempDir(), 'pr-comment.md');

    const result = await upsertPullRequestComment({
      diagnosis,
      repository: 'senai/copa-figurinhas',
      pullRequestNumber: 42,
      token: 'ghp_naoDeveriaSerUsado123456',
      dryRun: true,
      outFile,
      fetchImpl,
    });

    expect(result.action).toBe('dry_run');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(outFile, 'utf8')).toContain('Pipeline Guardian');
  });

  it('publicar exige opt-in explícito no ambiente', () => {
    expect(isPullRequestCommentEnabled({})).toBe(false);
    expect(isPullRequestCommentEnabled({ GITHUB_TOKEN: 'x' })).toBe(false);
    expect(isPullRequestCommentEnabled({ AUTOMATION_ALLOW_PR_COMMENT: 'true' })).toBe(false);
    expect(isPullRequestCommentEnabled({ AUTOMATION_ALLOW_PR_COMMENT: 'true', GITHUB_TOKEN: 'x' })).toBe(true);
  });
});
