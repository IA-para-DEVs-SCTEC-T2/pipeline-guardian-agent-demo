/**
 * Classificador determinístico do fluxo operacional (CI → CD → runtime).
 *
 * É o fallback quando a OpenAI não está configurada, falha ou devolve saída
 * fora do schema — e o sinal auxiliar quando ela está. Nenhuma linha aqui chama
 * modelo.
 *
 * O que ele decide: **qual fase foi afetada** e **quais fatos sustentam isso**.
 * O que ele não decide: se passou ou não passou. Isso já chegou pronto em
 * `technicalStatus`, vindo de exit code e código HTTP.
 *
 * A precedência das fases é o coração do módulo, e cada degrau existe por um
 * motivo:
 *
 *   1. `version_mismatch` vence tudo. Se os logs são de outra release, qualquer
 *      conclusão tirada deles é sobre o software errado. Diagnosticar a falha
 *      antes de resolver a correlação seria analisar o commit de outra pessoa.
 *   2. Falha do CI vence falha de deployment. Se o pipeline reprovou, o que
 *      está no ar é irrelevante para o commit em análise.
 *   3. Falha da plataforma vence falha do smoke test. "O container não subiu" é
 *      causa; "o smoke test não obteve resposta" é o sintoma disso.
 *   4. Dentro do smoke test, health reprovado vence rota funcional, e a
 *      distinção entre os dois é o assunto do Dia 1: processo vivo não é o
 *      mesmo que funcionalidade sadia.
 */

import { classifyDeployment } from './deployment-classifier.mjs';
import { redactSecrets } from './redact-secrets.mjs';

const MAX_FACTS = 8;
const MAX_EXCERPT_LENGTH = 240;
/** Trecho curto demais casa com qualquer coisa e não sustenta nada. */
const MIN_EXCERPT_LENGTH = 12;

/** Mapa de job do CI para fase. */
const CI_JOB_PHASES = {
  quality: 'ci_quality',
  tests: 'ci_tests',
  build: 'ci_build',
  'docker-build': 'ci_docker',
};

/**
 * Houve alguma resposta HTTP no log do smoke test?
 *
 * Mesma regra de `deployment-classifier.mjs`, e pelo mesmo motivo: se o host
 * respondeu qualquer coisa, os `ECONNREFUSED` das primeiras tentativas são "a
 * aplicação ainda estava subindo", não "problema de rede". Sem isso, todo
 * deployment lento vira falha de infraestrutura.
 */
const HTTP_RESPONSE_MARKER = /\bHTTP \d{3}\b/;

/**
 * Determina a fase afetada a partir dos fatos.
 *
 * @param {object} input
 * @returns {{ affectedPhase: string, reason: string, smokeClassification: object|null }}
 */
export function classifyOperationalPhase({ context } = {}) {
  const { technicalStatus, correlation, systemFacts } = context;
  const smokeLog = textFor(context, 'smoke:deployment');

  // 1. Correlação quebrada vence tudo.
  if (correlation.status === 'mismatch') {
    return {
      affectedPhase: 'version_mismatch',
      reason: 'a versão observada na plataforma não é a versão esperada',
      smokeClassification: null,
    };
  }

  // 2. CI reprovado: a primeira etapa que falhou é a fase afetada.
  if (technicalStatus.ci === 'failure') {
    const failing = Object.entries(systemFacts.ciJobs ?? {}).find(([, result]) => result === 'failure');
    return {
      affectedPhase: failing ? CI_JOB_PHASES[failing[0]] ?? 'unknown' : 'unknown',
      reason: 'um job técnico do CI não teve sucesso',
      smokeClassification: null,
    };
  }

  // 3. A plataforma declarou falha.
  if (technicalStatus.railwayDeployment === 'failed' || technicalStatus.railwayDeployment === 'crashed') {
    const buildLog = textFor(context, 'railway:build');
    const failedInBuild = /error|failed|exit code [1-9]/i.test(buildLog);
    return {
      affectedPhase: failedInBuild ? 'railway_build' : 'startup',
      reason: 'o Railway registrou o deployment como falho',
      smokeClassification: null,
    };
  }

  // 4. Smoke test reprovado — a distinção do Dia 1.
  if (technicalStatus.smokeTest === 'failure') {
    const health = systemFacts.smokeTest?.health ?? null;
    const functional = systemFacts.smokeTest?.functional ?? null;

    // Health passou e a rota de negócio não: processo vivo, funcionalidade
    // quebrada. É o cenário 2 do laboratório, e ele não pode ser confundido
    // com "a aplicação caiu".
    if (health?.passed === true && functional?.passed === false) {
      return {
        affectedPhase: 'functional',
        reason: '`/api/health` respondeu 200, mas a rota funcional não',
        smokeClassification: null,
      };
    }

    // Reuso do classificador do pós-deployment: ele já sabe separar
    // `startup`, `environment`, `healthcheck`, `network` e `deployment` a
    // partir do log do smoke test. Duas cópias dessa regra seriam duas
    // chances de as duas divergirem.
    const smokeClassification = classifyDeployment({ log: smokeLog, status: 'failure' });

    let phase = smokeClassification.failureType;
    if (phase === 'success' || phase === 'unknown') phase = 'healthcheck';
    if (phase === 'network' && HTTP_RESPONSE_MARKER.test(smokeLog)) phase = 'healthcheck';

    return {
      affectedPhase: phase,
      reason: 'o smoke test pós-deployment reprovou',
      smokeClassification,
    };
  }

  // 5. Tudo o que se sabe é bom.
  if (technicalStatus.overall === 'success') {
    return { affectedPhase: 'success', reason: 'todos os gates conhecidos passaram', smokeClassification: null };
  }

  return {
    affectedPhase: 'unknown',
    reason: 'não há fatos suficientes para nomear uma fase afetada',
    smokeClassification: null,
  };
}

/**
 * Extrai fatos observados do material — trechos que existem de verdade.
 *
 * A seleção segue a fase afetada: num deployment saudável, os fatos são as
 * linhas que **comprovam** a saúde (health 200, rota funcional 200); numa
 * falha, são as linhas do erro. Procurar padrão de erro num log verde só
 * produziria "evidência" de um problema que não houve.
 *
 * @param {object} input
 * @returns {Array<object>} fatos com `id` já atribuído
 */
export function buildObservedFacts({ context, affectedPhase }) {
  const facts = [];
  const seen = new Set();

  const push = ({ source, phase, timestamp, excerpt }) => {
    const clean = redactSecrets(String(excerpt ?? '').trim()).slice(0, MAX_EXCERPT_LENGTH);
    const key = `${source}::${clean}`;
    if (clean.length < MIN_EXCERPT_LENGTH || seen.has(key) || facts.length >= MAX_FACTS) return;
    seen.add(key);
    facts.push({ id: `F${facts.length + 1}`, source, phase, timestamp: timestamp ?? null, excerpt: clean });
  };

  // Mismatch de SHA é o fato mais importante que existe quando acontece.
  if (context.correlation.status === 'mismatch') {
    push({
      source: 'railway:collection-metadata',
      phase: 'version_mismatch',
      timestamp: null,
      excerpt:
        `Commit esperado \`${short(context.correlation.expectedCommitSha)}\`; ` +
        `commit observado na plataforma \`${short(context.correlation.observedCommitSha)}\`.`,
    });
  }

  // Resultado dos jobs do CI: fato do sistema, não trecho de log.
  for (const [job, result] of Object.entries(context.systemFacts.ciJobs ?? {})) {
    if (result === 'unknown') continue;
    if (affectedPhase !== 'success' && result === 'success') continue;
    push({
      source: `ci:${job}`,
      phase: CI_JOB_PHASES[job] ?? 'unknown',
      timestamp: null,
      excerpt: `Job \`${job}\` do CI concluiu com resultado \`${result}\`.`,
    });
  }

  // Estado do deployment na plataforma.
  const deployment = context.systemFacts.railwayDeployment ?? {};
  if (deployment.status && deployment.status !== 'unknown') {
    push({
      source: 'railway:collection-metadata',
      phase: 'railway_deploy',
      timestamp: null,
      excerpt: `O Railway reporta o deployment \`${deployment.deploymentId ?? 'sem id'}\` com status \`${deployment.status}\`.`,
    });
  }

  // Linhas dos logs, escolhidas por relevância — não pela ordem em que
  // apareceram. Ver `rankTimelineEvents`.
  for (const event of rankTimelineEvents({ context, affectedPhase })) {
    if (facts.length >= MAX_FACTS) break;
    push({
      source: event.source,
      phase: event.phase,
      timestamp: event.timestamp,
      excerpt: event.message,
    });
  }

  return facts;
}

/** Linhas que comprovam saúde. Só entram quando o resultado técnico foi sucesso. */
const SUCCESS_MARKERS =
  /health check: aprovado|rota funcional: aprovado|health=PASS|SMOKE TEST RESULT: PASS|ouvindo na porta|relatório do álbum gerado|health check respondido|Deployment successful|Build succeeded/i;

/** Linhas que apontam falha. */
const FAILURE_MARKERS =
  /reprovado|erro de conexão|HTTP (?:4|5)\d{2}|SMOKE TEST RESULT: FAIL|falha fatal|error|failed|exit code [1-9]|não executada/i;

/**
 * Ruído transitório da subida do container.
 *
 * Um deployment **saudável** também tem `ECONNREFUSED` e `HTTP 502` nas
 * primeiras tentativas: o container leva segundos para atender. Quando o health
 * check acabou passando, essas linhas descrevem a espera, não uma falha — e
 * citá-las como evidência produziria um relatório que "prova" um problema que
 * não houve. Quando o health check **não** passou, as mesmas linhas viram a
 * evidência principal, e por isso o filtro é condicional, não absoluto.
 */
const STARTUP_TRANSIENT = /erro de conexão|ECONNREFUSED|HTTP 502|Application failed to respond/i;

/**
 * Ordena os eventos por quanto cada um sustenta a fase afetada.
 *
 * A regra de ouro é a do plantonista: o log **interno** da aplicação vale mais
 * que a observação externa do smoke test. `functional.report.failed` com o
 * `TypeError` explica; `HTTP 500` só constata. Sem esta ordenação, as 30
 * tentativas repetidas do smoke test enchem o orçamento de fatos e empurram a
 * causa para fora do relatório.
 *
 * @param {object} input
 * @returns {Array<object>} eventos em ordem de relevância
 */
export function rankTimelineEvents({ context, affectedPhase }) {
  const healthPassed = context.systemFacts?.smokeTest?.health?.passed === true;
  const wantSuccess = affectedPhase === 'success';

  const scored = [];

  for (const event of context.timeline) {
    const message = event.message ?? '';

    // Ruído de subida: descartado quando o health check acabou passando.
    if (healthPassed && STARTUP_TRANSIENT.test(message)) continue;

    // Numa falha, `level: 'error'` é sinal melhor que qualquer regex: ele foi
    // atribuído na origem, pelo próprio emissor do evento, e não depende de a
    // mensagem estar em português, em inglês ou conter uma palavra-chave. É
    // para isso que o contrato de log estruturado da Parte 1 existe.
    const relevant = wantSuccess
      ? SUCCESS_MARKERS.test(message)
      : event.level === 'error' || FAILURE_MARKERS.test(message);

    // Numa falha funcional, a prova de que o processo está vivo é tão
    // importante quanto a prova de que a funcionalidade quebrou: é o contraste
    // entre as duas que sustenta o diagnóstico.
    const isAliveProof =
      affectedPhase === 'functional' && /health check: aprovado|health check respondido/i.test(message);

    if (!relevant && !isAliveProof) continue;

    let score = 0;
    if (event.phase === affectedPhase) score += 100;
    if (isAliveProof) score += 60;
    // Log interno da plataforma explica; observação externa constata.
    if (event.source.startsWith('railway:')) score += 40;
    if (event.level === 'error') score += 20;
    if (event.timestamp) score += 5;

    scored.push({ event, score });
  }

  // Empate mantém a ordem cronológica já estabelecida pela linha do tempo.
  return scored
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.event);
}

/**
 * Diagnóstico determinístico completo.
 *
 * @param {object} input
 * @returns {object} objeto compatível com `modelOperationalDiagnosisSchema`
 */
export function buildDeterministicOperationalDiagnosis({ context }) {
  const { affectedPhase, smokeClassification } = classifyOperationalPhase({ context });
  const observedFacts = buildObservedFacts({ context, affectedPhase });

  const inferences = buildInferences({ affectedPhase, observedFacts });
  const cause = CAUSES[affectedPhase] ?? CAUSES.unknown;

  return {
    summary: buildSummary({ context, affectedPhase }),
    affectedPhase,
    observedFacts,
    inferences,
    probableCause: cause.text,
    // Teto deliberado: o classificador reconhece **padrão**, e padrão sustenta
    // hipótese, não causa comprovada. Só o modelo, lendo o stack trace de um
    // log de runtime, poderia legitimamente subir para `direct_evidence`.
    causeStrength: affectedPhase === 'success' ? 'unavailable' : cause.strength,
    recommendedActions: ACTIONS[affectedPhase] ?? ACTIONS.unknown,
    limitations: [
      'Diagnóstico gerado pelo classificador determinístico, por correspondência de padrões — sem modelo.',
      ...(smokeClassification?.ambiguous
        ? ['Os padrões encontrados no log do smoke test apontam para mais de um tipo de falha.']
        : []),
    ],
  };
}

/**
 * Inferências determinísticas — cada uma amarrada aos fatos que a sustentam.
 *
 * Uma inferência sem fato correspondente **não é gerada**. Não é um filtro
 * aplicado depois: é a condição para ela existir. Frase bonita sem apoio é
 * exatamente o que o relatório do Dia 1 se propõe a não produzir.
 */
function buildInferences({ affectedPhase, observedFacts }) {
  const inferences = [];
  const idsFrom = (predicate) => observedFacts.filter(predicate).map((fact) => fact.id);

  if (affectedPhase === 'success') {
    const supportedBy = idsFrom((fact) => fact.phase !== 'version_mismatch');
    if (supportedBy.length > 0) {
      inferences.push({
        statement:
          'A versão implantada respondeu ao health check e à rota funcional dentro das tentativas configuradas.',
        supportedBy,
        confidence: 'high',
      });
    }
    return inferences;
  }

  if (affectedPhase === 'version_mismatch') {
    const supportedBy = idsFrom((fact) => fact.phase === 'version_mismatch');
    if (supportedBy.length > 0) {
      inferences.push({
        statement:
          'Os logs coletados podem pertencer a outra release: nenhuma conclusão sobre o commit em análise se sustenta sobre eles.',
        supportedBy,
        confidence: 'high',
      });
    }
    return inferences;
  }

  if (affectedPhase === 'functional') {
    const healthFacts = idsFrom((fact) => fact.phase === 'healthcheck');
    const functionalFacts = idsFrom((fact) => fact.phase === 'functional');

    if (functionalFacts.length > 0) {
      inferences.push({
        statement:
          'O processo está em execução e atende requisições: a falha está na funcionalidade, não na disponibilidade.',
        supportedBy: [...healthFacts, ...functionalFacts],
        confidence: healthFacts.length > 0 ? 'high' : 'medium',
      });
    }
    return inferences;
  }

  const supportedBy = idsFrom((fact) => fact.phase === affectedPhase);
  if (supportedBy.length > 0) {
    inferences.push({
      statement: INFERENCES[affectedPhase] ?? INFERENCES.unknown,
      supportedBy,
      // Teto em `medium`: padrão observado sustenta hipótese, não certeza.
      confidence: 'medium',
    });
  }

  return inferences;
}

function buildSummary({ context, affectedPhase }) {
  if (affectedPhase === 'success') {
    const collected = Object.entries(context.sourceCoverage)
      .filter(([key, value]) => value === true && key !== 'ci')
      .map(([key]) => key);

    return (
      'Fluxo operacional aprovado: o CI passou, a aplicação subiu e respondeu ao health check e à rota funcional. ' +
      `Fontes verificadas: ${collected.length > 0 ? collected.join(', ') : 'nenhuma'}.`
    );
  }

  return SUMMARIES[affectedPhase] ?? SUMMARIES.unknown;
}

const SUMMARIES = {
  ci_quality: 'Fluxo operacional reprovado no CI: a verificação de lint não passou.',
  ci_tests: 'Fluxo operacional reprovado no CI: a suíte de testes não passou.',
  ci_build: 'Fluxo operacional reprovado no CI: o build da aplicação não concluiu.',
  ci_docker: 'Fluxo operacional reprovado no CI: a imagem de produção não foi construída.',
  railway_build: 'Fluxo operacional reprovado na plataforma: o build do Railway não concluiu.',
  deployment:
    'Fluxo operacional reprovado: o endereço respondeu, mas não com a aplicação (ou a versão) esperada.',
  startup:
    'Fluxo operacional reprovado: a aplicação não chegou a atender — os indícios apontam para falha na inicialização do processo.',
  environment: 'Fluxo operacional reprovado: o log indica configuração de ambiente ausente ou incorreta.',
  network: 'Fluxo operacional reprovado: nenhuma resposta HTTP foi obtida do endereço configurado.',
  healthcheck:
    'Fluxo operacional reprovado: `/api/health` não atingiu o estado saudável dentro das tentativas configuradas.',
  functional:
    'Fluxo operacional reprovado na funcionalidade: `/api/health` respondeu 200, mas a rota funcional `/api/report` não atendeu. O processo está vivo; a funcionalidade, não.',
  runtime: 'Fluxo operacional reprovado: o log de runtime da aplicação registra erro após a inicialização.',
  version_mismatch:
    'Correlação de release quebrada: o commit observado na plataforma não é o commit esperado por esta validação.',
  unknown: 'Fluxo operacional reprovado: nenhum padrão conhecido foi reconhecido no material coletado.',
};

const INFERENCES = {
  ci_quality: 'A alteração introduziu uma violação de lint que o pipeline recusou.',
  ci_tests: 'A alteração quebrou ao menos um comportamento coberto pela suíte de testes.',
  ci_build: 'O código não compila no ambiente do pipeline.',
  ci_docker: 'A imagem de produção não nasce a partir deste commit — não há o que implantar.',
  railway_build: 'A construção da imagem falhou na plataforma, antes de qualquer execução.',
  deployment: 'O deployment pode não ter concluído: o endereço responde, mas não com a versão esperada.',
  startup: 'O processo provavelmente não permaneceu em execução após iniciar.',
  environment: 'Uma variável de ambiente obrigatória não foi fornecida ao processo.',
  network: 'O endereço configurado não foi alcançado — domínio incorreto, ainda não gerado, ou serviço fora do ar.',
  healthcheck: 'A aplicação iniciou e responde, mas não alcançou o estado saudável esperado.',
  runtime: 'A aplicação iniciou e passou a falhar durante a operação normal.',
  unknown: 'Não há material suficiente para sustentar uma explicação.',
};

const CAUSES = {
  ci_quality: { text: 'Violação de regra de lint introduzida pela alteração.', strength: 'probable' },
  ci_tests: { text: 'Um comportamento coberto por teste deixou de valer com a alteração.', strength: 'probable' },
  ci_build: { text: 'O código não compila no ambiente do pipeline.', strength: 'probable' },
  ci_docker: { text: 'O Dockerfile ou uma dependência impede a construção da imagem.', strength: 'probable' },
  railway_build: { text: 'A construção da imagem falhou na plataforma de deployment.', strength: 'probable' },
  deployment: { text: 'O deployment não concluiu ou o domínio aponta para outro serviço.', strength: 'weak_hypothesis' },
  startup: {
    text: 'O processo não permaneceu em execução: a borda da plataforma respondeu sem que houvesse aplicação atrás dela.',
    strength: 'probable',
  },
  environment: {
    text: 'Uma variável de ambiente obrigatória não foi fornecida ao processo no ambiente de deployment.',
    strength: 'probable',
  },
  network: {
    text: 'O endereço configurado em `APP_BASE_URL` não foi alcançado.',
    strength: 'weak_hypothesis',
  },
  healthcheck: {
    text: 'A aplicação iniciou, mas não alcançou o estado saudável esperado pelo health check.',
    strength: 'weak_hypothesis',
  },
  functional: {
    text: 'Uma regra de negócio da rota `/api/report` falha em execução, embora o processo continue atendendo.',
    strength: 'probable',
  },
  runtime: { text: 'Um erro em tempo de execução afeta a aplicação já iniciada.', strength: 'probable' },
  version_mismatch: {
    text: 'O deployment em execução na plataforma corresponde a outro commit — a release esperada pode não ter sido implantada.',
    strength: 'probable',
  },
  success: { text: null, strength: 'unavailable' },
  unknown: { text: null, strength: 'unavailable' },
};

const ACTIONS = {
  success: [
    'Nenhuma ação necessária: a versão implantada respondeu às verificações.',
    'Guardar o relatório como registro da validação desta release.',
  ],
  ci_quality: ['Rodar `npm run lint` localmente e corrigir as violações apontadas.'],
  ci_tests: [
    'Rodar `npm run test` localmente e reproduzir a falha.',
    'Comparar o comportamento esperado pelo teste com o que a alteração fez.',
  ],
  ci_build: ['Rodar `npm run build` localmente e ler o erro do bundler.'],
  ci_docker: [
    'Rodar `docker build --progress=plain -t copa-figurinhas:local .` localmente.',
    'Conferir se o estágio de build do frontend concluiu dentro da imagem.',
  ],
  railway_build: [
    'Abrir o log de build no Railway (Deployments › View Logs).',
    'Reproduzir com `npm run docker:build`: o mesmo erro deve aparecer.',
  ],
  deployment: [
    'Verificar na aba Deployments do Railway se a última implantação concluiu.',
    'Conferir se o domínio público aponta para o serviço correto.',
  ],
  startup: [
    'Abrir os logs de deploy no Railway e procurar o erro de inicialização do processo.',
    'Conferir se o `CMD` da imagem inicia o servidor sem depender de `npm install` em runtime.',
    'Rodar `docker compose up --build` localmente: o mesmo erro deve se reproduzir.',
  ],
  environment: [
    'Conferir as variáveis configuradas no serviço do Railway (aba Variables).',
    'Comparar com `backend/.env.example` e definir a variável ausente.',
  ],
  network: [
    'Confirmar a variável de repositório `APP_BASE_URL` no GitHub.',
    'Verificar se o domínio público foi gerado no Railway (Settings › Networking).',
  ],
  healthcheck: [
    'Consultar os logs de inicialização no Railway (Deployments › View Logs).',
    'Conferir se a variável `PORT` está sendo respeitada pelo processo.',
    'Confirmar que o health check da plataforma aponta para `/api/health`.',
  ],
  functional: [
    'Abrir o log de runtime e localizar o evento `functional.report.failed` com o `requestId` da falha.',
    'Reproduzir localmente com `curl -s http://localhost:3001/api/report`.',
    'Cobrir com teste o caso que quebrou antes de reimplantar.',
  ],
  runtime: [
    'Localizar no log de runtime o primeiro evento de nível `error` após `app.started`.',
    'Correlacionar o `requestId` do erro com a requisição que o disparou.',
  ],
  version_mismatch: [
    'Confirmar na aba Deployments do Railway qual commit está de fato em execução.',
    'Reimplantar a partir do commit esperado antes de tirar qualquer conclusão dos logs.',
  ],
  unknown: [
    'Abrir os artefatos completos desta execução do workflow.',
    'Reexecutar a validação manualmente para verificar se a falha é reproduzível.',
  ],
};

/* ------------------------------------------------------------------------- */
/* Auxiliares                                                                 */
/* ------------------------------------------------------------------------- */

function textFor(context, source) {
  return context.textSources?.find((entry) => entry.source === source)?.content ?? '';
}

function short(sha) {
  return String(sha ?? 'desconhecido').slice(0, 7);
}
