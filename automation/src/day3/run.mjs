/**
 * Dia 3 — a linha de comando do laboratório preditivo.
 *
 * Três verbos:
 *
 *   node run.mjs prepare                      treina, avalia e grava o modelo
 *   node run.mjs scenario latency-growth|all  os quatro cenários visuais
 *   node run.mjs challenge case-a [--reveal] [--mitigated]
 *
 * Regras da CLI que valem a pena declarar, porque são fáceis de quebrar depois:
 *
 * - **Exit code fala de execução, não de risco.** Uma probabilidade de 98% é uma
 *   execução bem-sucedida do laboratório. Só erro de uso e falha interna saem
 *   com código diferente de zero. Se o exit code virasse alarme, qualquer
 *   `npm run` num cenário de falha passaria a "quebrar o build".
 * - **Argumento inválido lista o que existe.** Errar o nome de um caso no meio
 *   da aula é normal; ficar sem saber quais são os nomes, não.
 * - **`prepare` roda sozinho quando falta o modelo.** A alternativa é uma
 *   mensagem de erro pedindo para rodar outro comando, no meio de uma
 *   demonstração.
 * - **O desafio não revela nada sem `--reveal`.** Não é o renderizador que
 *   esconde: o desfecho não é calculado. Ver `analyzeSequence`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { predictionReportSchema } from '../../schemas/day-3-prediction-schema.mjs';
import { redactSecrets } from '../redact-secrets.mjs';
import { DECISION_THRESHOLD, RISK_BANDS, evaluateModel, splitSequences } from './evaluate.mjs';
import { explainPrediction } from './explain.mjs';
import {
  BASELINE,
  DEGRADATION_THRESHOLDS,
  FAILURE_THRESHOLDS,
  FEATURE_LABELS,
  FEATURE_NAMES,
  HORIZON_WINDOWS,
  TARGET_NAME,
  buildDataset,
} from './features.mjs';
import {
  L2_LAMBDA,
  LEARNING_RATE,
  MAX_ITERATIONS,
  deserializeModel,
  serializeModel,
  trainLogisticRegression,
} from './logistic-regression.mjs';
import {
  MITIGATION_DECAY,
  REPO_ROOT,
  analyzeSequence,
  compareMitigation,
  findDefinition,
  listChallengeIds,
  listScenarioIds,
} from './predict.mjs';
import { writePredictionReports, writeTrainingArtifacts } from './report.mjs';
import { GENERATOR_SEED, PATTERN_LABELS, generateHistory } from './synthetic-history.mjs';

/** Onde tudo é gravado. */
export const DEFAULT_OUT_DIR = join(REPO_ROOT, 'reports', 'day-3');

/** Limitações estruturais do laboratório, repetidas em todo artefato. */
export const LAB_NOTES = Object.freeze([
  'As sequências são sintéticas e determinísticas. As métricas medem o modelo neste laboratório, não a confiabilidade de uma previsão sobre um sistema real.',
  'A divisão treino/teste separa sequências inteiras. Sortear janelas colocaria parte do passado do teste dentro do treino.',
  'Média, desvio e limiar não olham o conjunto de teste.',
  'A regressão logística é linear no espaço padronizado: ela não captura interação entre features nem efeito de saturação.',
]);

export const USAGE = `Uso:
  npm run day3:prepare
  npm run day3:scenario -- <${listSafe(listScenarioIds)}|all>
  npm run day3:challenge -- <${listSafe(listChallengeIds)}> [--mitigated]
  npm run day3:challenge:reveal -- <${listSafe(listChallengeIds)}>

Opções:
  --reveal      revela o desfecho do caso (o que aconteceu depois da janela de decisão)
  --mitigated   simula uma intervenção e grava um relatório separado, sem tocar no original
  --out <dir>   diretório de saída (padrão: reports/day-3)`;

/* ------------------------------------------------------------------------- */
/* Argumentos                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * @param {string[]} argv
 * @returns {{ command: string|null, target: string|null, reveal: boolean,
 *             mitigated: boolean, outDir: string|null, errors: string[] }}
 */
export function parseArgs(argv = []) {
  const options = {
    command: null,
    target: null,
    reveal: false,
    mitigated: false,
    outDir: null,
    errors: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--reveal') options.reveal = true;
    else if (arg === '--mitigated') options.mitigated = true;
    else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) options.errors.push('`--out` exige um diretório.');
      else {
        options.outDir = value;
        index += 1;
      }
    } else if (arg.startsWith('--')) options.errors.push(`opção desconhecida: \`${arg}\`.`);
    else if (options.command === null) options.command = arg;
    else if (options.target === null) options.target = arg;
    else options.errors.push(`argumento extra ignorado: \`${arg}\`.`);
  }

  return options;
}

/**
 * Valida a combinação comando + alvo, sem tocar em disco.
 *
 * @param {object} options saída de `parseArgs`
 * @returns {string[]} erros; vazio quando a chamada é válida
 */
export function validateArgs(options) {
  const errors = [...options.errors];

  if (!options.command) {
    errors.push('nenhum comando informado.');
    return errors;
  }

  if (!['prepare', 'scenario', 'challenge'].includes(options.command)) {
    errors.push(`comando desconhecido: \`${options.command}\`.`);
    return errors;
  }

  if (options.command === 'prepare') {
    if (options.target) errors.push('`prepare` não recebe argumentos.');
    return errors;
  }

  const known = options.command === 'scenario' ? listScenarioIds() : listChallengeIds();
  const allowed = options.command === 'scenario' ? [...known, 'all'] : known;

  if (!options.target) {
    errors.push(`\`${options.command}\` exige um nome. Disponíveis: ${allowed.join(', ')}.`);
  } else if (!allowed.includes(options.target)) {
    errors.push(`\`${options.target}\` não existe. Disponíveis: ${allowed.join(', ')}.`);
  }

  if (options.command === 'scenario' && (options.reveal || options.mitigated)) {
    errors.push('`--reveal` e `--mitigated` valem apenas para `challenge`.');
  }

  return errors;
}

/* ------------------------------------------------------------------------- */
/* Treino                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Gera o histórico, treina, avalia e grava `model.json`,
 * `training-summary.json` e `model-evaluation.html`.
 *
 * @param {object} [input]
 * @param {string} [input.outDir]
 * @param {number} [input.seed]
 * @returns {{ model: object, summary: object, paths: object }}
 */
export function prepare({ outDir = DEFAULT_OUT_DIR, seed = GENERATOR_SEED } = {}) {
  const sequences = generateHistory({ seed });
  const { train, test } = splitSequences(sequences);

  const { rows, labels } = buildDataset(train);
  const trained = trainLogisticRegression({
    rows,
    labels,
    featureNames: FEATURE_NAMES,
    learningRate: LEARNING_RATE,
    maxIterations: MAX_ITERATIONS,
    lambda: L2_LAMBDA,
  });

  const model = serializeModel(trained);
  const summary = buildTrainingSummary({ model, sequences, train, test, seed });
  const paths = writeTrainingArtifacts({ summary, model, outDir });

  return { model, summary, paths };
}

/**
 * O relatório do treino. Registra tudo o que é preciso para reproduzir e para
 * contestar: semente, identificadores das sequências de cada lado da divisão,
 * hiperparâmetros, pesos e as duas avaliações.
 *
 * @param {object} input
 * @returns {object}
 */
export function buildTrainingSummary({ model, sequences, train, test, seed }) {
  const trainEvaluation = strip(evaluateModel({ model, sequences: train }));
  const testEvaluation = strip(evaluateModel({ model, sequences: test }));

  const byPattern = {};
  for (const sequence of sequences) {
    byPattern[sequence.pattern] ??= { total: 0, withFailure: 0, label: PATTERN_LABELS[sequence.pattern] };
    byPattern[sequence.pattern].total += 1;
    if (sequence.hasFailure) byPattern[sequence.pattern].withFailure += 1;
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seed,
    baseline: BASELINE,
    threshold: DECISION_THRESHOLD,
    riskBands: RISK_BANDS.map((band) => ({
      id: band.id,
      label: band.label,
      upperBound: Number.isFinite(band.max) ? band.max : 1,
    })),
    target: {
      name: TARGET_NAME,
      horizonWindows: HORIZON_WINDOWS,
      failureThresholds: FAILURE_THRESHOLDS,
      degradationThresholds: DEGRADATION_THRESHOLDS,
    },
    features: FEATURE_NAMES.map((name) => ({ name, meaning: FEATURE_LABELS[name] })),
    sequences: {
      total: sequences.length,
      train: train.length,
      test: test.length,
      trainIds: train.map((sequence) => sequence.id),
      testIds: test.map((sequence) => sequence.id),
      byPattern,
    },
    split: {
      trainRatio: 0.7,
      strategy:
        'Sequências inteiras, estratificadas por padrão: dos 10 exemplares de cada padrão, os 3 primeiros vão para o teste e os 7 restantes para o treino. Nenhuma janela individual é sorteada.',
    },
    hyperparameters: model.hyperparameters,
    training: model.training,
    weights: FEATURE_NAMES.map((feature, index) => ({ feature, weight: model.weights[index] })),
    bias: model.bias,
    scaler: model.scaler,
    evaluation: { train: trainEvaluation, test: testEvaluation },
    limitations: [...LAB_NOTES],
  };
}

/**
 * Carrega `model.json`, treinando antes se ele não existir.
 *
 * @param {object} [input]
 * @returns {{ model: object, summary: object, prepared: boolean }}
 */
export function loadModel({ outDir = DEFAULT_OUT_DIR } = {}) {
  const modelPath = join(outDir, 'model.json');
  const summaryPath = join(outDir, 'training-summary.json');

  if (!existsSync(modelPath) || !existsSync(summaryPath)) {
    const { model, summary } = prepare({ outDir });
    return { model: deserializeModel(model), summary, prepared: true };
  }

  return {
    model: deserializeModel(JSON.parse(readFileSync(modelPath, 'utf8'))),
    summary: JSON.parse(readFileSync(summaryPath, 'utf8')),
    prepared: false,
  };
}

/* ------------------------------------------------------------------------- */
/* Relatórios de previsão                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Monta e valida um relatório de previsão.
 *
 * @param {object} input
 * @returns {Promise<object>} validado por `predictionReportSchema`
 */
export async function buildPredictionReport({
  kind,
  id,
  title,
  description,
  model,
  summary,
  windows,
  decisionIndex = null,
  revealed = false,
  mitigation = null,
  limitations = [],
  env = process.env,
  client = null,
}) {
  const threshold = summary.threshold ?? DECISION_THRESHOLD;
  const analysis = analyzeSequence({ model, windows, decisionIndex, revealed, threshold });

  const modelMetrics = {
    accuracy: summary.evaluation.test.accuracy,
    precision: summary.evaluation.test.precision,
    recall: summary.evaluation.test.recall,
    f1Score: summary.evaluation.test.f1Score,
    examples: summary.evaluation.test.examples,
    positiveExamples: summary.evaluation.test.positiveExamples,
    negativeExamples: summary.evaluation.test.negativeExamples,
  };

  const explanation = await explainPrediction({
    analysis,
    threshold,
    modelMetrics,
    limitations,
    env,
    client,
  });

  return predictionReportSchema.parse({
    schemaVersion: 1,
    kind,
    id,
    title,
    description,
    target: TARGET_NAME,
    predictionHorizonWindows: HORIZON_WINDOWS,
    threshold,
    baseline: BASELINE,
    windows: analysis.windows,
    predictions: analysis.predictions,
    currentWindowIndex: analysis.currentWindowIndex,
    failureProbability: analysis.failureProbability,
    predictedFailure: analysis.predictedFailure,
    riskBand: analysis.riskBand,
    topFactors: analysis.topFactors,
    firstPredictedFailureWindow: analysis.firstPredictedFailureWindow,
    outcome: analysis.outcome,
    mitigation,
    modelMetrics,
    explanation,
    limitations: [...LAB_NOTES, ...limitations],
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Um cenário visual: sequência inteira à vista, desfecho revelado.
 *
 * @param {object} input
 * @returns {Promise<{ report: object, paths: object }>}
 */
export async function runScenario({ id, model, summary, outDir = DEFAULT_OUT_DIR, env = process.env, client = null }) {
  const definition = findDefinition('scenarios', id);

  const report = await buildPredictionReport({
    kind: 'scenario',
    id: definition.id,
    title: definition.title,
    description: definition.description,
    model,
    summary,
    windows: definition.windows,
    revealed: true,
    env,
    client,
  });

  return { report, paths: writePredictionReports({ report, outDir: join(outDir, 'scenarios', definition.id) }) };
}

/**
 * Um caso de desafio.
 *
 * Sem `--reveal`, a sequência é cortada no ponto de decisão e o desfecho não é
 * calculado. Com `--mitigated`, o relatório da simulação vai para um
 * subdiretório e o relatório original permanece intacto.
 *
 * @param {object} input
 * @returns {Promise<{ report: object, paths: object }>}
 */
export async function runChallenge({
  id,
  model,
  summary,
  outDir = DEFAULT_OUT_DIR,
  env = process.env,
  reveal = false,
  mitigated = false,
  client = null,
}) {
  const definition = findDefinition('challenges', id);
  const caseDir = join(outDir, 'challenges', definition.id);
  const interventionIndex = definition.interventionIndex ?? definition.decisionIndex;

  if (!mitigated) {
    const report = await buildPredictionReport({
      kind: 'challenge',
      id: definition.id,
      title: definition.title,
      description: definition.description,
      model,
      summary,
      windows: definition.windows,
      decisionIndex: definition.decisionIndex,
      revealed: reveal,
      limitations: [
        `A sequência foi apresentada até a janela de decisão (${definition.decisionIndex}). ` +
          'As janelas seguintes existem na definição do caso e não entram neste relatório enquanto o desfecho não for revelado.',
      ],
      env,
      client,
    });

    return { report, paths: writePredictionReports({ report, outDir: caseDir }) };
  }

  const { mitigatedWindows, mitigation } = compareMitigation({
    model,
    windows: definition.windows,
    interventionIndex,
    decay: MITIGATION_DECAY,
    threshold: summary.threshold ?? DECISION_THRESHOLD,
  });

  const report = await buildPredictionReport({
    kind: 'challenge',
    id: definition.id,
    title: `${definition.title} — com mitigação simulada`,
    description:
      `Mesma sequência do caso, com uma intervenção aplicada na janela ${interventionIndex}: ` +
      'a partir dali as métricas decaem em direção à baseline. As features são recalculadas e o modelo é consultado de novo.',
    model,
    summary,
    windows: mitigatedWindows,
    revealed: true,
    mitigation,
    limitations: [
      'Este é um relatório de simulação: a intervenção é um decaimento aplicado às métricas, não uma mudança verificada em um sistema.',
      'A comparação mostra a trajetória original completa — rode este comando depois de revelar o caso.',
    ],
    env,
    client,
  });

  return { report, paths: writePredictionReports({ report, outDir: join(caseDir, 'mitigated') }) };
}

/* ------------------------------------------------------------------------- */
/* Saída no terminal                                                           */
/* ------------------------------------------------------------------------- */

/**
 * O bloco de texto de uma execução. Separado da escrita para poder ser testado.
 *
 * @param {object} report
 * @param {object} paths
 * @returns {string}
 */
export function formatRunOutput(report, paths) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const band = RISK_BANDS.find((candidate) => candidate.id === report.riskBand);

  const lines = [
    `  caso/cenário .... ${report.id}`,
    `  janela atual .... ${report.currentWindowIndex}`,
    `  probabilidade ... ${percent(report.failureProbability)} (limiar ${percent(report.threshold)})`,
    `  faixa ........... ${band ? `${band.icon} ${band.label}` : report.riskBand}`,
    `  previsão ........ ${report.predictedFailure ? 'falha provável nas próximas 2 janelas' : 'sem falha prevista no horizonte'}`,
    `  1º alerta ....... ${report.firstPredictedFailureWindow === null ? 'nenhum' : `janela ${report.firstPredictedFailureWindow}`}`,
    `  fatores ......... ${report.topFactors.map((factor) => factor.feature).join(', ')}`,
    `  explicação ...... ${report.explanation.origin === 'openai' ? 'OpenAI (saída validada por schema)' : 'fallback determinístico (sem chamada de rede)'}`,
  ];

  if (report.outcome.revealed) {
    lines.push(
      '  --- desfecho revelado ---',
      `  falha real ...... ${report.outcome.actualFailure ? `sim, a partir da janela ${report.outcome.firstActualFailureWindow}` : 'não houve falha no horizonte'}`,
      `  antecedência .... ${
        report.outcome.leadTimeWindows === null
          ? 'não aplicável'
          : `${report.outcome.leadTimeWindows} janela(s) entre o 1º alerta e a falha`
      }`,
      `  ponto de decisão  ${report.outcome.decisionOutcome ?? 'não aplicável'}`,
    );
  } else {
    lines.push(`  desfecho ........ oculto — use \`npm run day3:challenge:reveal -- ${report.id}\``);
  }

  if (report.mitigation) {
    lines.push(
      '  --- mitigação simulada ---',
      `  intervenção ..... janela ${report.mitigation.interventionWindowIndex} (decaimento ${report.mitigation.decayPerWindow}/janela)`,
      `  prob. final ..... ${percent(report.mitigation.baselineProbability)} → ${percent(report.mitigation.mitigatedProbability)}`,
      `  pico ............ ${percent(report.mitigation.baselineMaxProbability)} → ${percent(report.mitigation.mitigatedMaxProbability)}`,
    );
  }

  lines.push(
    `  JSON ............ ${paths.json}`,
    `  Markdown ........ ${paths.markdown}`,
    `  HTML ............ ${paths.html}`,
  );

  return lines.join('\n');
}

/* ------------------------------------------------------------------------- */
/* main                                                                        */
/* ------------------------------------------------------------------------- */

async function main() {
  dotenv.config({ path: [join(REPO_ROOT, 'automation', '.env'), join(REPO_ROOT, '.env')], quiet: true });

  const options = parseArgs(process.argv.slice(2));
  const errors = validateArgs(options);

  if (errors.length > 0) {
    process.stderr.write(`[day3] ${errors.join('\n[day3] ')}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);

  if (options.command === 'prepare') {
    const { summary, paths } = prepare({ outDir });
    const test = summary.evaluation.test;
    process.stdout.write(
      '[day3] modelo treinado\n' +
        `  semente ......... ${summary.seed}\n` +
        `  sequências ...... ${summary.sequences.total} (${summary.sequences.train} treino / ${summary.sequences.test} teste)\n` +
        `  exemplos ........ ${summary.evaluation.train.examples} treino / ${test.examples} teste\n` +
        `  acurácia ........ ${(test.accuracy * 100).toFixed(1)}%\n` +
        `  precisão ........ ${(test.precision * 100).toFixed(1)}%\n` +
        `  recall .......... ${(test.recall * 100).toFixed(1)}%\n` +
        `  F1 .............. ${(test.f1Score * 100).toFixed(1)}%\n` +
        `  matriz .......... TP=${test.confusionMatrix.truePositives} FP=${test.confusionMatrix.falsePositives} ` +
        `FN=${test.confusionMatrix.falseNegatives} TN=${test.confusionMatrix.trueNegatives}\n` +
        `  loss ............ ${summary.training.initialLoss.toFixed(4)} → ${summary.training.finalLoss.toFixed(4)} ` +
        `(${summary.training.iterations} iterações)\n` +
        `  modelo .......... ${paths.model}\n` +
        `  resumo .......... ${paths.summary}\n` +
        `  painel .......... ${paths.evaluation}\n`,
    );
    return;
  }

  const { model, summary, prepared } = loadModel({ outDir });
  if (prepared) process.stdout.write('[day3] `model.json` não existia; o modelo foi treinado agora.\n');

  if (options.command === 'scenario') {
    const ids = options.target === 'all' ? listScenarioIds() : [options.target];
    for (const id of ids) {
      const { report, paths } = await runScenario({ id, model, summary, outDir });
      process.stdout.write(`[day3] cenário ${id}\n${formatRunOutput(report, paths)}\n\n`);
    }
    return;
  }

  const { report, paths } = await runChallenge({
    id: options.target,
    model,
    summary,
    outDir,
    reveal: options.reveal,
    mitigated: options.mitigated,
  });

  process.stdout.write(
    `[day3] desafio ${options.target}${options.mitigated ? ' (mitigado)' : ''}${options.reveal ? ' (revelado)' : ''}\n` +
      `${formatRunOutput(report, paths)}\n\n`,
  );
}

/** Lista os nomes disponíveis sem derrubar o `USAGE` se o arquivo faltar. */
function listSafe(fn) {
  try {
    return fn().join('|');
  } catch {
    return '...';
  }
}

/** Remove os vetores longos do resumo: eles pesam e não são lidos. */
function strip(evaluation) {
  const { probabilities: _probabilities, labels: _labels, ...rest } = evaluation;
  return rest;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[day3] erro: ${redactSecrets(String(error?.message ?? error))}\n`);
    process.exitCode = 1;
  });
}
