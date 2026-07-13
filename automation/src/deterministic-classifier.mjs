/**
 * Classificador determinístico.
 *
 * Reconhece o tipo de falha por padrões de log, sem modelo. É usado sempre
 * (como sinal independente) e vira o diagnóstico completo quando o modelo não
 * está disponível, falha ou devolve uma saída inválida.
 */

/**
 * Regras por tipo. `priority` só desempata quando dois tipos têm o mesmo
 * número de padrões distintos encontrados — quanto maior, mais específico.
 */
export const CLASSIFICATION_RULES = [
  {
    type: 'security',
    priority: 80,
    riskLevel: 'high',
    patterns: [/token detectado/i, /segredo detectado/i, /credencial detectada/i],
  },
  {
    type: 'permission',
    priority: 70,
    riskLevel: 'high',
    patterns: [/\bEACCES\b/, /permission denied/i, /403 Forbidden/i],
  },
  {
    type: 'dependency',
    priority: 60,
    riskLevel: 'medium',
    patterns: [/\bERR_MODULE_NOT_FOUND\b/, /Cannot find package/i, /module not found/i],
  },
  {
    type: 'environment',
    priority: 50,
    riskLevel: 'medium',
    patterns: [/missing env/i, /is required but was not provided/i, /undefined environment variable/i],
  },
  {
    type: 'build',
    priority: 40,
    riskLevel: 'medium',
    patterns: [/Could not resolve/i, /build failed/i, /\bRollupError\b/],
  },
  {
    type: 'test',
    priority: 30,
    riskLevel: 'medium',
    patterns: [/\bAssertionError\b/, /\bexpected\b/i, /\breceived\b/i, /\bFAIL\b/],
  },
  {
    type: 'lint',
    priority: 20,
    riskLevel: 'low',
    patterns: [/no-unused-vars/i, /no-undef/i, /\bESLint\b/i],
  },
];

const MAX_MATCHES_PER_TYPE = 6;
const MAX_EXCERPT_LENGTH = 220;

/**
 * Procura os padrões de todos os tipos em um conjunto de fontes de texto.
 *
 * @param {Array<{ source: string, content: string }>} sources
 * @returns {Array<{ type: string, pattern: string, source: string, line: number, excerpt: string }>}
 */
export function findPatternMatches(sources) {
  const matches = [];

  for (const { source, content } of sources) {
    if (typeof content !== 'string' || content.length === 0) continue;
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      for (const rule of CLASSIFICATION_RULES) {
        for (const pattern of rule.patterns) {
          if (pattern.test(line)) {
            matches.push({
              type: rule.type,
              pattern: String(pattern),
              source,
              line: index + 1,
              excerpt: line.trim().slice(0, MAX_EXCERPT_LENGTH),
            });
          }
        }
      }
    });
  }

  return matches;
}

/**
 * Pontua cada tipo pelo número de padrões *distintos* encontrados. Repetir o
 * mesmo padrão em cem linhas não torna a hipótese mais forte; encontrar padrões
 * diferentes do mesmo tipo, sim.
 *
 * @param {ReturnType<typeof findPatternMatches>} matches
 * @returns {Array<{ type: string, score: number, priority: number, patterns: string[] }>}
 */
export function scoreMatches(matches) {
  const byType = new Map();

  for (const match of matches) {
    if (!byType.has(match.type)) byType.set(match.type, new Set());
    byType.get(match.type).add(match.pattern);
  }

  return CLASSIFICATION_RULES.filter((rule) => byType.has(rule.type))
    .map((rule) => ({
      type: rule.type,
      score: byType.get(rule.type).size,
      priority: rule.priority,
      patterns: [...byType.get(rule.type)],
    }))
    .sort((a, b) => b.score - a.score || b.priority - a.priority);
}

/**
 * Classifica a falha.
 *
 * `sources` deve conter apenas os logs dos comandos que FALHARAM. O diff não
 * entra aqui: código-fonte que menciona `no-unused-vars` ou `ESLint` (uma
 * config de lint, um classificador como este) faria o agente "encontrar" uma
 * falha que não existe.
 *
 * @param {object} input
 * @param {Array<{ source: string, content: string }>} input.sources logs já mascarados dos comandos que falharam
 * @param {boolean} [input.secretsDetected] resultado de `scanForSensitiveData` no conteúdo original
 * @param {boolean} [input.hasFailedCommands] se algum comando do pipeline falhou
 * @param {boolean} [input.hasCommands] se algum comando foi observado
 * @returns {{
 *   failureType: string, signal: string, confidence: string, riskLevel: string,
 *   matches: Array<object>, scores: Array<object>, ambiguous: boolean
 * }}
 */
export function classifyFailure({
  sources = [],
  secretsDetected = false,
  hasFailedCommands = true,
  hasCommands = true,
} = {}) {
  const matches = findPatternMatches(sources);
  const scores = scoreMatches(matches);

  // Segredo encontrado no conteúdo original decide sozinho: o achado é um fato
  // observado pelo scanner, não uma inferência sobre o texto do log. Vale mesmo
  // com o pipeline verde — um segredo commitado é um problema por si só.
  if (secretsDetected) {
    return {
      failureType: 'security',
      signal: 'secret-detected-in-pipeline-content',
      confidence: 'high',
      riskLevel: 'high',
      matches: selectMatches(matches, 'security'),
      scores,
      ambiguous: false,
    };
  }

  // Sem comando falhando não há falha a classificar. Padrões encontrados em
  // outro lugar não transformam um pipeline verde em vermelho.
  if (!hasFailedCommands) {
    return hasCommands
      ? {
          failureType: 'unknown',
          signal: 'no-failure-detected',
          confidence: 'high',
          riskLevel: 'low',
          matches: [],
          scores: [],
          ambiguous: false,
        }
      : {
          failureType: 'unknown',
          signal: 'no-commands-observed',
          confidence: 'low',
          riskLevel: 'medium',
          matches: [],
          scores: [],
          ambiguous: false,
        };
  }

  if (scores.length === 0) {
    return {
      failureType: 'unknown',
      signal: 'no-reliable-pattern',
      confidence: 'low',
      riskLevel: 'medium',
      matches: [],
      scores,
      ambiguous: false,
    };
  }

  const [winner, runnerUp] = scores;
  const ambiguous = Boolean(runnerUp && runnerUp.score === winner.score);
  const rule = CLASSIFICATION_RULES.find((item) => item.type === winner.type);
  const winningMatches = selectMatches(matches, winner.type);

  return {
    failureType: winner.type,
    signal: signalFor(winner.type, winningMatches),
    confidence: confidenceFor({ score: winner.score, ambiguous, hasFailedCommands }),
    riskLevel: rule.riskLevel,
    matches: winningMatches,
    scores,
    ambiguous,
  };
}

/**
 * Diagnóstico completo sem modelo — o fallback.
 *
 * @param {object} input
 * @param {ReturnType<typeof classifyFailure>} input.classification
 * @param {Array<{ source: string, excerpt: string }>} input.evidence
 * @param {Array<object>} input.failedCommands
 * @param {string[]} [input.limitations]
 * @returns {object} objeto compatível com `modelDiagnosisSchema`
 */
export function buildDeterministicDiagnosis({
  classification,
  evidence = [],
  failedCommands = [],
  limitations = [],
}) {
  const { failureType, signal, confidence, riskLevel } = classification;
  const commandList = failedCommands.map((command) => command.command).join(', ');

  return {
    summary: summaryFor(failureType, failedCommands),
    signal,
    failureType,
    probableCause: PROBABLE_CAUSES[failureType],
    evidence,
    impact: commandList
      ? `Pipeline interrompido em: ${commandList}. A entrega desta Pull Request fica bloqueada até a correção.`
      : 'Nenhum comando do pipeline falhou nos dados coletados.',
    riskLevel,
    confidence,
    nextSteps: NEXT_STEPS[failureType],
    limitations: [
      'Diagnóstico gerado pelo classificador determinístico, por correspondência de padrões nos logs.',
      ...limitations,
    ],
  };
}

const PROBABLE_CAUSES = {
  lint: 'O ESLint encontrou violações de regras no código alterado.',
  test: 'Ao menos um teste automatizado falhou: o comportamento observado difere do esperado.',
  dependency: 'Um módulo importado não foi resolvido — dependência ausente, não instalada ou com nome incorreto.',
  build: 'O bundler não concluiu o build — provavelmente um import que não resolve.',
  environment: 'Uma variável de ambiente obrigatória não foi fornecida ao processo.',
  permission: 'O processo não tem permissão sobre um arquivo, diretório ou recurso remoto.',
  security: 'Conteúdo sensível (token, segredo ou credencial) foi identificado no material do pipeline.',
  unknown: 'Nenhum padrão conhecido foi reconhecido nos logs; a causa não pôde ser determinada por padrões.',
};

const NEXT_STEPS = {
  lint: [
    'Rodar `npm run lint` localmente e corrigir as regras apontadas.',
    'Revisar o código alterado na Pull Request antes de novo push.',
  ],
  test: [
    'Reproduzir com `npm run test` localmente.',
    'Comparar o valor esperado com o recebido no teste que falhou.',
    'Corrigir o código ou o teste, conforme qual dos dois estiver errado.',
  ],
  dependency: [
    'Conferir se a dependência está declarada no `package.json` do workspace correto.',
    'Rodar `npm install` e versionar o `package-lock.json`.',
  ],
  build: [
    'Rodar `npm run build` localmente.',
    'Conferir os caminhos de import citados no log do bundler.',
  ],
  environment: [
    'Conferir o `.env.example` e as variáveis configuradas no ambiente do pipeline.',
    'Definir a variável ausente antes de reexecutar o job.',
  ],
  permission: [
    'Conferir as permissões do arquivo/diretório ou o escopo do token usado pelo job.',
    'Reexecutar o job após ajustar a permissão.',
  ],
  security: [
    'Revogar imediatamente qualquer credencial exposta.',
    'Remover o segredo do código e movê-lo para variável de ambiente.',
    'Acionar uma pessoa responsável por segurança antes de qualquer deploy.',
  ],
  unknown: [
    'Abrir o log completo do job que falhou.',
    'Reexecutar o pipeline para verificar se a falha é reproduzível.',
  ],
};

function summaryFor(failureType, failedCommands) {
  const first = failedCommands[0];
  const where = first ? ` em \`${first.command}\`` : '';

  const descriptions = {
    lint: `Pipeline falhou${where}: violações de lint.`,
    test: `Pipeline falhou${where}: testes automatizados falharam.`,
    dependency: `Pipeline falhou${where}: dependência não resolvida.`,
    build: `Pipeline falhou${where}: build não concluído.`,
    environment: `Pipeline falhou${where}: variável de ambiente obrigatória ausente.`,
    permission: `Pipeline falhou${where}: permissão negada.`,
    security: `Conteúdo sensível detectado no pipeline${where}.`,
    unknown: failedCommands.length
      ? `Pipeline falhou${where}: causa não identificada por padrões conhecidos.`
      : 'Pipeline concluído sem falhas nos comandos observados.',
  };

  return descriptions[failureType];
}

function signalFor(type, matches) {
  const first = matches[0];
  if (!first) return `${type}:pattern-match`;

  const marker = first.pattern
    .replace(/^\/|\/[a-z]*$/g, '')
    .replace(/\\b/g, '')
    .replace(/\\/g, '');

  return `${type}:${marker}`;
}

function confidenceFor({ score, ambiguous, hasFailedCommands }) {
  if (ambiguous) return 'low';
  if (score >= 2 && hasFailedCommands) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

function selectMatches(matches, type) {
  return matches.filter((match) => match.type === type).slice(0, MAX_MATCHES_PER_TYPE);
}
