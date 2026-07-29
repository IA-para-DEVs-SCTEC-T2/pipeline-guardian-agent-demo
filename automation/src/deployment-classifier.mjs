/**
 * Classificador determinístico do log de validação pós-deployment.
 *
 * Mesma ideia do `deterministic-classifier.mjs` do pipeline: reconhece o tipo
 * de falha por padrões, sem modelo. É o fallback quando a OpenAI não está
 * configurada, falha ou devolve uma saída fora do schema — e o sinal auxiliar
 * quando ela está.
 *
 * O que ele NÃO faz: dizer se o deployment passou. Isso vem do smoke test
 * (códigos HTTP e exit code). Aqui só se classifica uma falha que já é fato.
 */

/**
 * Regras por tipo. `priority` desempata quando dois tipos encontram o mesmo
 * número de padrões distintos — quanto maior, mais específico.
 */
export const DEPLOYMENT_RULES = [
  {
    type: 'environment',
    priority: 70,
    patterns: [
      /missing required environment variable/i,
      /environment variable [`"']?\w+[`"']? (?:is )?(?:missing|not set|required)/i,
      /vari[áa]vel (?:de ambiente )?[`"']?\w+[`"']? (?:obrigat[óo]ria )?(?:ausente|n[ãa]o (?:definida|configurada))/i,
      /is required but was not provided/i,
    ],
  },
  {
    type: 'startup',
    priority: 60,
    patterns: [
      /application failed to respond/i,
      /\bERR_MODULE_NOT_FOUND\b/,
      /cannot find (?:module|package)/i,
      /container (?:crashed|exited|stopped)/i,
      /process exited with code/i,
      /HTTP 502\b/,
    ],
  },
  {
    type: 'healthcheck',
    priority: 50,
    patterns: [
      /HTTP 503\b/,
      /service unavailable/i,
      // Cobre `status="degraded"` (log do smoke test) e `"status":"degraded"`
      // (corpo JSON da própria aplicação embutido na linha).
      /\bstatus["']?\s*[:=]\s*["']?(?:degraded|starting|unhealthy|error)\b/i,
      /health check: reprovado/i,
      /healthcheck failed/i,
    ],
  },
  {
    type: 'deployment',
    priority: 40,
    patterns: [
      /HTTP 404\b/,
      /no (?:active )?deployment/i,
      /deployment (?:failed|not found)/i,
      /image (?:pull|build) failed/i,
      /vers[ãa]o antiga no ar/i,
    ],
  },
  {
    type: 'network',
    priority: 30,
    patterns: [
      /\bECONNREFUSED\b/,
      /\bENOTFOUND\b/,
      /\bETIMEDOUT\b/,
      /\bEAI_AGAIN\b/,
      /\bECONNRESET\b/,
      /\bCERT_/,
    ],
  },
];

/**
 * A aplicação chegou a responder alguma coisa em HTTP?
 *
 * Serve para uma correção de precedência importante: quando existe QUALQUER
 * resposta HTTP no log, o host resolveu e alguém atendeu — os `ECONNREFUSED`
 * das primeiras tentativas são "a aplicação ainda estava subindo", não
 * "problema de rede". Sem essa regra, um deployment lento seria diagnosticado
 * como falha de infraestrutura de rede.
 */
export const HTTP_RESPONSE_MARKER = /\bHTTP \d{3}\b/;

/**
 * Sintoma × causa.
 *
 * "O health check não passou" é o SINTOMA — está sempre presente numa validação
 * reprovada, porque é a própria definição de reprovação. "Falta a variável X" e
 * "o processo não subiu" são CAUSAS: dizem por que o sintoma existe.
 *
 * Quando o log contém uma causa nomeada, ela vence o sintoma, mesmo que o
 * sintoma tenha casado com mais padrões. Sem esta regra, todo deployment
 * quebrado seria classificado como `healthcheck` — verdadeiro, inútil e
 * indistinguível entre si.
 */
export const CAUSE_TYPES = ['environment', 'startup'];
export const SYMPTOM_TYPES = ['healthcheck', 'deployment'];

const MAX_MATCHES = 6;
const MAX_EXCERPT_LENGTH = 220;

/**
 * @param {string} log log do smoke test, já sanitizado e mascarado
 * @returns {Array<{ type: string, pattern: string, line: number, excerpt: string }>}
 */
export function findDeploymentMatches(log = '') {
  const matches = [];
  if (typeof log !== 'string' || log.length === 0) return matches;

  log.split('\n').forEach((line, index) => {
    for (const rule of DEPLOYMENT_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(line)) {
          matches.push({
            type: rule.type,
            pattern: String(pattern),
            line: index + 1,
            excerpt: line.trim().slice(0, MAX_EXCERPT_LENGTH),
          });
        }
      }
    }
  });

  return matches;
}

/**
 * Pontua cada tipo pelo número de padrões DISTINTOS encontrados. Trinta linhas
 * com o mesmo `ECONNREFUSED` não tornam a hipótese mais forte — padrões
 * diferentes do mesmo tipo, sim.
 *
 * @param {ReturnType<typeof findDeploymentMatches>} matches
 * @returns {Array<{ type: string, score: number, priority: number }>}
 */
export function scoreDeploymentMatches(matches) {
  const byType = new Map();

  for (const match of matches) {
    if (!byType.has(match.type)) byType.set(match.type, new Set());
    byType.get(match.type).add(match.pattern);
  }

  return DEPLOYMENT_RULES.filter((rule) => byType.has(rule.type))
    .map((rule) => ({ type: rule.type, score: byType.get(rule.type).size, priority: rule.priority }))
    .sort((a, b) => b.score - a.score || b.priority - a.priority);
}

/**
 * Classifica a validação pós-deployment.
 *
 * @param {object} input
 * @param {string} input.log log do smoke test (mascarado)
 * @param {'success'|'failure'} input.status resultado TÉCNICO do smoke test
 * @returns {{ failureType: string, confidence: string, matches: Array<object>,
 *             scores: Array<object>, ambiguous: boolean, respondedOverHttp: boolean }}
 */
export function classifyDeployment({ log = '', status = 'failure' } = {}) {
  const respondedOverHttp = HTTP_RESPONSE_MARKER.test(log);

  // Deployment aprovado não tem falha a classificar. Procurar padrão de erro
  // num log verde só produziria diagnóstico inventado.
  if (status === 'success') {
    return {
      failureType: 'success',
      confidence: 'high',
      matches: [],
      scores: [],
      ambiguous: false,
      respondedOverHttp,
    };
  }

  const matches = findDeploymentMatches(log);
  let scores = scoreDeploymentMatches(matches);

  if (respondedOverHttp) {
    scores = scores.filter((score) => score.type !== 'network');
  }

  if (scores.some((score) => CAUSE_TYPES.includes(score.type))) {
    scores = scores.filter((score) => !SYMPTOM_TYPES.includes(score.type));
  }

  if (scores.length === 0) {
    return {
      failureType: 'unknown',
      confidence: 'low',
      matches: [],
      scores,
      ambiguous: false,
      respondedOverHttp,
    };
  }

  const [winner, runnerUp] = scores;
  const ambiguous = Boolean(runnerUp && runnerUp.score === winner.score);

  return {
    failureType: winner.type,
    // Teto deliberado em `medium`: o smoke test enxerga a borda da aplicação,
    // não o log interno da plataforma. Afirmar causa raiz com `high` a partir
    // daqui seria confundir sintoma bem observado com causa comprovada.
    confidence: ambiguous ? 'low' : 'medium',
    matches: selectMatches(matches, winner.type),
    scores,
    ambiguous,
    respondedOverHttp,
  };
}

/**
 * Diagnóstico completo sem modelo — o fallback do pós-deployment.
 *
 * @param {object} input
 * @param {ReturnType<typeof classifyDeployment>} input.classification
 * @param {Array<{ source: string, excerpt: string }>} input.evidence
 * @param {string[]} [input.limitations]
 * @returns {object} objeto compatível com `modelDeploymentDiagnosisSchema`
 */
export function buildDeterministicDeploymentDiagnosis({
  classification,
  evidence = [],
  limitations = [],
}) {
  const { failureType, confidence } = classification;

  return {
    summary: SUMMARIES[failureType],
    failureType,
    evidence,
    probableCause: PROBABLE_CAUSES[failureType],
    confidence,
    nextSteps: NEXT_STEPS[failureType],
    limitations: [
      'Diagnóstico gerado pelo classificador determinístico, por correspondência de padrões no log.',
      ...limitations,
    ],
  };
}

const SUMMARIES = {
  success:
    'Validação pós-deployment aprovada: `/api/health` respondeu 200 com `status: "ok"` e a rota funcional atendeu.',
  healthcheck:
    'Validação pós-deployment reprovada: `/api/health` não atingiu o estado saudável dentro das tentativas configuradas.',
  startup:
    'Validação pós-deployment reprovada: a aplicação não chegou a atender — os indícios apontam para falha na inicialização do processo.',
  environment:
    'Validação pós-deployment reprovada: o log indica configuração de ambiente ausente ou incorreta.',
  network:
    'Validação pós-deployment reprovada: nenhuma resposta HTTP foi obtida do endereço configurado.',
  deployment:
    'Validação pós-deployment reprovada: o endereço respondeu, mas não com a aplicação (ou não com a versão) esperada.',
  unknown:
    'Validação pós-deployment reprovada: nenhum padrão conhecido foi reconhecido no log coletado.',
};

const PROBABLE_CAUSES = {
  success: null,
  healthcheck:
    'A aplicação iniciou e responde, mas não alcançou o estado saudável esperado pelo health check.',
  startup:
    'O processo provavelmente não permaneceu em execução: a borda da plataforma respondeu sem que houvesse aplicação atrás dela.',
  environment:
    'Uma variável de ambiente obrigatória não foi fornecida ao processo no ambiente de deployment.',
  network:
    'O endereço configurado em `APP_BASE_URL` não foi alcançado — domínio incorreto, ainda não gerado, ou serviço fora do ar.',
  deployment:
    'O deployment pode não ter concluído: o endereço responde, mas não com a aplicação (ou com a versão) esperada.',
  unknown: null,
};

const NEXT_STEPS = {
  success: [
    'Nenhuma ação necessária: a versão implantada respondeu às verificações.',
    'Guardar o relatório como registro da validação desta release.',
  ],
  healthcheck: [
    'Consultar os logs de inicialização no Railway (aba Deployments › View Logs).',
    'Conferir se a variável `PORT` está sendo respeitada pelo processo.',
    'Confirmar que o health check da plataforma aponta para `/api/health`.',
    'Verificar se o processo permanece em execução após responder as primeiras requisições.',
  ],
  startup: [
    'Abrir os logs de deploy no Railway e procurar o erro de inicialização do processo.',
    'Conferir se o `CMD` da imagem inicia o servidor sem depender de `npm install` em runtime.',
    'Rodar `docker compose up --build` localmente: o mesmo erro deve se reproduzir.',
  ],
  environment: [
    'Conferir as variáveis configuradas no serviço do Railway (aba Variables).',
    'Comparar com `backend/.env.example` e definir a variável ausente.',
    'Reimplantar após corrigir a configuração.',
  ],
  network: [
    'Confirmar a variável de repositório `APP_BASE_URL` no GitHub.',
    'Verificar se o domínio público foi gerado no Railway (Settings › Networking › Generate Domain).',
    'Testar a URL manualmente com `curl -i <URL>/api/health`.',
  ],
  deployment: [
    'Verificar na aba Deployments do Railway se a última implantação concluiu.',
    'Conferir se o commit implantado é o mesmo avaliado por este workflow.',
    'Reimplantar a partir do commit correto.',
  ],
  unknown: [
    'Abrir o log completo do smoke test no artefato do workflow.',
    'Consultar os logs da plataforma no período da validação.',
    'Reexecutar o workflow manualmente para verificar se a falha é reproduzível.',
  ],
};

/**
 * Filtra e ordena os matches do tipo vencedor por especificidade (a ordem em
 * `DEPLOYMENT_RULES` já é a prioridade) e depois por posição no log.
 */
function selectMatches(matches, type) {
  const rule = DEPLOYMENT_RULES.find((item) => item.type === type);
  const priorityIndex = new Map(rule.patterns.map((pattern, index) => [String(pattern), index]));

  return matches
    .filter((match) => match.type === type)
    .sort((a, b) => {
      const diff = (priorityIndex.get(a.pattern) ?? 99) - (priorityIndex.get(b.pattern) ?? 99);
      return diff !== 0 ? diff : a.line - b.line;
    })
    .slice(0, MAX_MATCHES);
}
