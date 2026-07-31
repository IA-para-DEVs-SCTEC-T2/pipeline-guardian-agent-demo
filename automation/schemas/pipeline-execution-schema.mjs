/**
 * Representação unificada de **uma execução do pipeline** — CI, plataforma,
 * runtime e gates numa estrutura só.
 *
 * Ela não substitui `operationalDiagnosisSchema`: é uma **projeção** dele. O
 * diagnóstico continua sendo onde vivem `technicalStatus`, os fatos ancorados e
 * a saída conciliada do modelo; a execução é a leitura por **etapa** desse mesmo
 * material, e é o que os dois relatórios (CI e pós-deployment) renderizam. Duas
 * fontes de verdade para "o que aconteceu" seriam duas versões da mesma
 * execução divergindo na primeira mudança.
 *
 * Duas distinções de vocabulário que este arquivo protege:
 *
 * 1. **Etapa não é fase.** `OPERATIONAL_PHASES` responde *onde* um fato foi
 *    observado; `PIPELINE_STAGES` responde *o que o pipeline executou*, e por
 *    isso inclui os dois gates, que não são momentos de observação. As duas
 *    listas se encontram no campo `phase` de cada etapa — e a checagem no fim
 *    deste arquivo reprova, **na importação**, qualquer etapa cuja fase não
 *    exista no vocabulário do diagnóstico.
 * 2. **`not_reached` não é `failure`.** Uma etapa que nunca começou porque uma
 *    anterior reprovou não é uma segunda falha; contá-la como tal
 *    multiplicaria um problema por dez e esconderia qual deles é o primeiro.
 */

import { z } from 'zod';

import { CONFIDENCE_LEVELS } from './diagnosis-schema.mjs';
import {
  CAUSE_STRENGTHS,
  CORRELATION_STATUSES,
  OPERATIONAL_PHASES,
  OVERALL_STATUSES,
  inferenceSchema,
  observedFactSchema,
  sourceCoverageSchema,
} from './operational-diagnosis-schema.mjs';

/**
 * As etapas, **na ordem real de execução do pipeline**.
 *
 * A ordem é o que `determineFirstFailedStage` percorre, e por isso os gates
 * ficam onde de fato acontecem: `ci_gate` fecha o CI antes de existir qualquer
 * deployment, `cd_gate` fecha a validação pós-deployment. Colocá-los no fim da
 * lista faria a primeira falha de um CI reprovado ser reportada depois de
 * etapas que nunca chegaram a rodar.
 *
 * `scope` diz a qual relatório a etapa pertence: num relatório de CI as etapas
 * `cd` existem, mas como `not_reached` — ainda não havia deployment.
 */
export const PIPELINE_STAGES = [
  { stage: 'ci_quality', label: 'Lint', phase: 'ci_quality', scope: 'ci' },
  { stage: 'ci_tests', label: 'Testes', phase: 'ci_tests', scope: 'ci' },
  { stage: 'ci_build', label: 'Build', phase: 'ci_build', scope: 'ci' },
  { stage: 'ci_docker', label: 'Docker', phase: 'ci_docker', scope: 'ci' },
  { stage: 'ci_gate', label: 'CI Gate', phase: 'unknown', scope: 'ci' },
  { stage: 'railway_build', label: 'Railway Build', phase: 'railway_build', scope: 'cd' },
  { stage: 'railway_deploy', label: 'Railway Deploy', phase: 'railway_deploy', scope: 'cd' },
  { stage: 'startup', label: 'Inicialização', phase: 'startup', scope: 'cd' },
  { stage: 'healthcheck', label: 'Health check', phase: 'healthcheck', scope: 'cd' },
  { stage: 'functional', label: 'Rota funcional', phase: 'functional', scope: 'cd' },
  { stage: 'smoke_test', label: 'Smoke test', phase: 'post_deployment_validation', scope: 'cd' },
  { stage: 'cd_gate', label: 'CD Gate', phase: 'unknown', scope: 'cd' },
];

/** Só os identificadores, na ordem — é o que o schema valida. */
export const STAGE_IDS = PIPELINE_STAGES.map((entry) => entry.stage);

/** Índice por identificador, para consulta O(1) sem varrer a lista. */
export const STAGE_BY_ID = new Map(PIPELINE_STAGES.map((entry) => [entry.stage, entry]));

/**
 * Situação de uma etapa.
 *
 * - `success`     — executou e passou;
 * - `failure`     — executou e reprovou;
 * - `skipped`     — foi deliberadamente pulada (condição do workflow);
 * - `not_reached` — nunca começou, porque uma etapa anterior reprovou ou porque
 *                   o fluxo parou antes dela. Inclui `cancelled` do GitHub
 *                   Actions: job interrompido não produziu veredito;
 * - `unknown`     — não há material para afirmar nada sobre ela. **Nunca** é
 *                   tratado automaticamente como falha.
 */
export const STAGE_STATUSES = ['success', 'failure', 'skipped', 'not_reached', 'unknown'];

/** Resultado de um gate. Determinístico, sempre — ver `gateSchema.determinedBy`. */
export const GATE_STATUSES = ['approved', 'rejected', 'not_reached', 'unknown'];

/** Tipos de gate. `ci` fecha o pipeline; `cd` fecha a validação pós-deployment. */
export const GATE_TYPES = ['ci', 'cd'];

/**
 * Escopo do relatório.
 *
 * `ci` é gerado dentro do próprio CI, quando a execução parou antes do
 * deployment; `cd` é gerado depois da validação pós-deployment. É a **mesma**
 * estrutura e o **mesmo** HTML nos dois casos.
 */
export const EXECUTION_SCOPES = ['ci', 'cd'];

export const stageSchema = z.object({
  stage: z.enum(STAGE_IDS),
  label: z.string().min(1),
  phase: z.enum(OPERATIONAL_PHASES),
  scope: z.enum(EXECUTION_SCOPES),
  status: z.enum(STAGE_STATUSES),
  evidenceIds: z.array(z.string()),
  /** Uma frase curta de contexto. Nunca uma explicação — ver `failureExplanation`. */
  note: z.string().nullable(),
});

/**
 * A explicação da falha principal — **uma só por relatório**.
 *
 * Existe apenas quando `overallStatus` é `failure`, e descreve exclusivamente a
 * etapa que o sistema determinou como primeira a falhar. Etapas saudáveis
 * anteriores não ganham texto: elas já estão contadas na linha do tempo, e
 * escrever um parágrafo sobre cada uma afogaria a única que importa.
 *
 * `probableCause` é anulável de propósito: "o log mostra o sintoma, não a
 * causa" precisa ser dizível sem inventar uma hipótese para preencher o campo.
 */
export const failureExplanationSchema = z.object({
  stage: z.enum([...STAGE_IDS, 'unknown']),
  label: z.string().min(1),
  phase: z.enum(OPERATIONAL_PHASES),
  whatHappened: z.string().min(1),
  probableCause: z.string().nullable(),
  causeStrength: z.enum(CAUSE_STRENGTHS),
  recommendedActions: z.array(z.string()),
  confidence: z.enum(CONFIDENCE_LEVELS),
  evidenceIds: z.array(z.string()),
  limitations: z.array(z.string()),
  /** Etapas posteriores que não chegaram a rodar. Não são falhas independentes. */
  notReachedStages: z.array(z.string()),
});

export const gateSchema = z.object({
  type: z.enum(GATE_TYPES),
  status: z.enum(GATE_STATUSES),
  /**
   * Literal, e não um enum com outras opções: o dia em que este campo puder
   * valer outra coisa é o dia em que a IA passou a decidir. O tipo é a
   * documentação da invariante.
   */
  determinedBy: z.literal('deterministic'),
});

export const pipelineExecutionSchema = z.object({
  executionId: z.string().uuid(),
  scope: z.enum(EXECUTION_SCOPES),
  repository: z.string().min(1),
  commitSha: z.string().min(1),
  environment: z.string().nullable(),

  overallStatus: z.enum(OVERALL_STATUSES),

  /**
   * A primeira etapa que falhou, ou `null` quando nada falhou.
   *
   * `'unknown'` é a resposta quando `overallStatus` é `failure` e nenhuma etapa
   * pôde ser responsabilizada — melhor que eleger uma etapa arbitrária.
   */
  firstFailedStage: z.enum([...STAGE_IDS, 'unknown']).nullable(),

  stages: z.array(stageSchema),

  failureExplanation: failureExplanationSchema.nullable(),
  successSummary: z.string().min(1).nullable(),

  observedFacts: z.array(observedFactSchema),
  inferences: z.array(inferenceSchema),

  sourceCoverage: sourceCoverageSchema,
  correlationStatus: z.enum(CORRELATION_STATUSES),
  expectedCommitSha: z.string().min(1),
  observedCommitSha: z.string().nullable(),

  gate: gateSchema,

  usedFallback: z.boolean(),
  limitations: z.array(z.string()),
  generatedAt: z.string().datetime(),
});

/**
 * Checagem na importação: toda etapa aponta para uma fase que existe no
 * vocabulário do diagnóstico.
 *
 * Falhar aqui é falhar cedo, com o processo ainda subindo. A alternativa seria
 * descobrir a divergência como erro de validação do Zod com o relatório já
 * montado — que é o pior momento possível para descobrir qualquer coisa.
 */
for (const entry of PIPELINE_STAGES) {
  if (!OPERATIONAL_PHASES.includes(entry.phase)) {
    throw new Error(
      `Etapa \`${entry.stage}\` aponta para a fase \`${entry.phase}\`, que não existe em OPERATIONAL_PHASES.`,
    );
  }
}
