import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DECISION_THRESHOLD } from '../src/day3/evaluate.mjs';
import { isFailureWindow } from '../src/day3/features.mjs';
import {
  MITIGATION_DECAY,
  applyMitigation,
  classifyDecision,
  compareMitigation,
  findDefinition,
  listChallengeIds,
} from '../src/day3/predict.mjs';
import { USAGE, parseArgs, prepare, runChallenge, validateArgs } from '../src/day3/run.mjs';

const outDir = mkdtempSync(join(tmpdir(), 'day3-challenge-'));
const { model, summary } = prepare({ outDir });

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const run = (id, options = {}) => runChallenge({ id, model, summary, outDir, env: {}, ...options });

describe('argumentos da CLI', () => {
  it('reconhece comando, alvo e opções em qualquer ordem', () => {
    expect(parseArgs(['challenge', 'case-a', '--mitigated'])).toMatchObject({
      command: 'challenge',
      target: 'case-a',
      mitigated: true,
      reveal: false,
    });
    expect(parseArgs(['challenge', '--reveal', 'case-b'])).toMatchObject({
      command: 'challenge',
      target: 'case-b',
      reveal: true,
    });
  });

  it('aceita as chamadas válidas dos scripts npm', () => {
    expect(validateArgs(parseArgs(['prepare']))).toEqual([]);
    expect(validateArgs(parseArgs(['scenario', 'all']))).toEqual([]);
    expect(validateArgs(parseArgs(['scenario', 'latency-growth']))).toEqual([]);
    expect(validateArgs(parseArgs(['challenge', 'case-a']))).toEqual([]);
    expect(validateArgs(parseArgs(['challenge', '--reveal', 'case-a']))).toEqual([]);
    expect(validateArgs(parseArgs(['challenge', 'case-a', '--mitigated']))).toEqual([]);
  });

  it('recusa entrada inválida e lista o que existe', () => {
    expect(validateArgs(parseArgs([]))).toEqual([expect.stringContaining('nenhum comando')]);
    expect(validateArgs(parseArgs(['inventado']))[0]).toMatch(/comando desconhecido/);

    const unknownCase = validateArgs(parseArgs(['challenge', 'case-z']))[0];
    expect(unknownCase).toContain('case-a');
    expect(unknownCase).toContain('case-b');
    expect(unknownCase).toContain('case-c');

    expect(validateArgs(parseArgs(['scenario']))[0]).toContain('latency-growth');
    expect(validateArgs(parseArgs(['challenge', 'case-a', '--bogus']))[0]).toMatch(/opção desconhecida/);
    expect(validateArgs(parseArgs(['scenario', 'all', '--reveal']))[0]).toMatch(/apenas para `challenge`/);
    expect(validateArgs(parseArgs(['prepare', 'x']))[0]).toMatch(/não recebe argumentos/);
  });

  it('o texto de uso nomeia os três casos e os quatro cenários', () => {
    for (const id of ['case-a', 'case-b', 'case-c', 'latency-growth', 'transient-spike']) {
      expect(USAGE).toContain(id);
    }
  });
});

describe('desafios sem revelação', () => {
  it.each(listChallengeIds())('%s não entrega o desfecho em nenhum formato', async (id) => {
    const definition = findDefinition('challenges', id);
    const { report, paths } = await run(id);

    expect(report.outcome).toEqual({
      revealed: false,
      actualFailure: null,
      firstActualFailureWindow: null,
      leadTimeWindows: null,
      decisionOutcome: null,
    });

    // A sequência para no ponto de decisão: as janelas seguintes não existem
    // no relatório, então não há de onde vazar.
    expect(report.predictions).toHaveLength(definition.decisionIndex + 1);
    expect(report.windows).toHaveLength(definition.decisionIndex + 1);
    for (const entry of report.predictions) {
      expect(entry.actualFailureWithinHorizon).toBeNull();
    }

    // A folha de estilo embutida declara `.outcome-true_positive` e as irmãs em
    // todo relatório: são nomes de classe do gabarito, não conteúdo do caso.
    const html = readFileSync(paths.html, 'utf8').replace(/<style>[\s\S]*?<\/style>/, '');
    const markdown = readFileSync(paths.markdown, 'utf8');
    const json = readFileSync(paths.json, 'utf8');

    for (const output of [html, markdown, json]) {
      expect(output).not.toContain('falha real');
      expect(output).not.toContain('## Desfecho');
      expect(output).not.toMatch(/true_positive|false_positive|true_negative|false_negative/);
    }
    expect(html).toContain('Ainda não revelado');

    // As janelas ocultas não estão no arquivo: o relatório vai de 0 ao ponto de
    // decisão e para. (Comparar valor a valor não serviria — uma janela oculta
    // pode repetir por acaso o número de uma janela visível.)
    const parsed = JSON.parse(json);
    expect(parsed.windows.map((entry) => entry.index)).toEqual(
      Array.from({ length: definition.decisionIndex + 1 }, (_value, index) => index),
    );
    expect(parsed.currentWindowIndex).toBe(definition.decisionIndex);
    expect(definition.windows.length).toBeGreaterThan(parsed.windows.length);
  });

  it('o título e a descrição são neutros e iguais entre os três casos', async () => {
    const texts = [];

    for (const id of listChallengeIds()) {
      const { report } = await run(id);
      expect(report.title).toMatch(/^Caso [A-Z]$/);

      const text = report.description.toLowerCase();
      // Palavras que entregariam o desfecho. "falha" sozinha não entrega nada:
      // ela está no enunciado da tarefa ("decida se há falha no horizonte").
      for (const word of ['termina em falha', 'sem falha', 'houve falha', 'não falha', 'recuperação', 'degradação', 'pico', 'estável']) {
        expect(text).not.toContain(word);
      }

      // A descrição só varia na contagem de janelas visíveis. Se um caso
      // ganhasse uma frase própria, ela seria a pista.
      texts.push(text.replace(/\b(cinco|seis|sete|oito)\b/, 'N'));
    }

    expect(new Set(texts).size).toBe(1);
  });
});

describe('revelação', () => {
  it('case-a e case-b terminam em falha e o modelo acerta o ponto de decisão', async () => {
    for (const id of ['case-a', 'case-b']) {
      const definition = findDefinition('challenges', id);
      const { report } = await run(id, { reveal: true });

      expect(report.outcome.revealed).toBe(true);
      expect(report.outcome.actualFailure).toBe(true);
      expect(report.outcome.firstActualFailureWindow).toBe(
        definition.windows.findIndex(isFailureWindow),
      );
      expect(report.outcome.decisionOutcome).toBe('true_positive');
      // O alarme veio antes da falha.
      expect(report.outcome.leadTimeWindows).toBeGreaterThan(0);
      expect(report.firstPredictedFailureWindow).toBeLessThan(report.outcome.firstActualFailureWindow);
    }
  });

  it('case-c não falha e o ponto de decisão é um verdadeiro negativo', async () => {
    const definition = findDefinition('challenges', 'case-c');
    const { report } = await run('case-c', { reveal: true });

    expect(definition.windows.some(isFailureWindow)).toBe(false);
    expect(report.outcome.actualFailure).toBe(false);
    expect(report.outcome.firstActualFailureWindow).toBeNull();
    expect(report.outcome.decisionOutcome).toBe('true_negative');
    expect(report.failureProbability).toBeLessThan(DECISION_THRESHOLD);
  });

  it('a revelação mostra a antecedência e o resultado no relatório', async () => {
    const { report, paths } = await run('case-a', { reveal: true });
    const html = readFileSync(paths.html, 'utf8');
    const markdown = readFileSync(paths.markdown, 'utf8');

    expect(html).toContain('Verdadeiro positivo (TP)');
    expect(html).toContain('Antecedência do modelo');
    expect(markdown).toContain('## Desfecho');
    expect(markdown).toContain(`${report.outcome.leadTimeWindows} janela(s) de antecedência`);
  });

  it('classifica os quatro resultados possíveis', () => {
    expect(classifyDecision(true, true)).toBe('true_positive');
    expect(classifyDecision(true, false)).toBe('false_positive');
    expect(classifyDecision(false, true)).toBe('false_negative');
    expect(classifyDecision(false, false)).toBe('true_negative');
  });
});

describe('mitigação simulada', () => {
  it('reduz as métricas a partir da janela de intervenção e preserva o passado', () => {
    const definition = findDefinition('challenges', 'case-a');
    const mitigated = applyMitigation(definition.windows, { interventionIndex: 5 });

    for (let index = 0; index <= 5; index += 1) {
      expect(mitigated[index]).toEqual({ ...definition.windows[index], index });
    }
    for (let index = 6; index < definition.windows.length; index += 1) {
      expect(mitigated[index].latencyP95Ms).toBeLessThan(definition.windows[index].latencyP95Ms);
      expect(mitigated[index].errorRate).toBeLessThan(definition.windows[index].errorRate);
      expect(mitigated[index].logLinesPerRequest).toBeLessThan(definition.windows[index].logLinesPerRequest);
      expect(mitigated[index].healthFailure).toBe(false);
    }
    // O decaimento é monotônico em direção à baseline.
    expect(mitigated[7].latencyP95Ms).toBeLessThan(mitigated[6].latencyP95Ms);
  });

  it('a sequência mitigada deixa de falhar', () => {
    for (const id of ['case-a', 'case-b']) {
      const definition = findDefinition('challenges', id);
      const mitigated = applyMitigation(definition.windows, {
        interventionIndex: definition.interventionIndex,
      });
      expect(definition.windows.some(isFailureWindow)).toBe(true);
      expect(mitigated.some(isFailureWindow)).toBe(false);
    }
  });

  it('reduz o risco calculado, sem ninguém ajustar a probabilidade à mão', () => {
    for (const id of ['case-a', 'case-b']) {
      const definition = findDefinition('challenges', id);
      const { mitigation } = compareMitigation({
        model,
        windows: definition.windows,
        interventionIndex: definition.interventionIndex,
      });

      expect(mitigation.mitigatedProbability).toBeLessThan(mitigation.baselineProbability);
      expect(mitigation.mitigatedMaxProbability).toBeLessThanOrEqual(mitigation.baselineMaxProbability);
      expect(mitigation.decayPerWindow).toBe(MITIGATION_DECAY);

      // Antes da intervenção as duas curvas são idênticas: a diferença vem só
      // do que mudou depois dela.
      for (const row of mitigation.comparison.slice(0, definition.interventionIndex + 1)) {
        expect(row.mitigatedProbability).toBe(row.baselineProbability);
      }
      for (const row of mitigation.comparison.slice(definition.interventionIndex + 1)) {
        expect(row.mitigatedProbability).toBeLessThan(row.baselineProbability);
      }
    }
  });

  it('grava em um diretório separado, sem tocar no relatório original', async () => {
    const original = await run('case-a', { reveal: true });
    const before = readFileSync(original.paths.json, 'utf8');

    const { report, paths } = await run('case-a', { mitigated: true });

    expect(paths.json).toContain(join('case-a', 'mitigated'));
    expect(paths.json).not.toBe(original.paths.json);
    expect(readFileSync(original.paths.json, 'utf8')).toBe(before);
    expect(existsSync(paths.html)).toBe(true);

    expect(report.mitigation).not.toBeNull();
    expect(report.predictedFailure).toBe(false);
    expect(readFileSync(paths.html, 'utf8')).toContain('Mitigação simulada');
    expect(readFileSync(paths.html, 'utf8')).toContain('original × mitigada');
  });
});
