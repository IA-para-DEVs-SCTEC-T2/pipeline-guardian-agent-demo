# CLAUDE.md — CopaFigurinhas

Contexto para agentes e para quem for evoluir este repositório.

## Decisões arquiteturais

- **Monorepo com npm workspaces** (`backend`, `frontend`, `automation`). A raiz
  orquestra os scripts; cada workspace tem o seu `package.json`.
- **JavaScript + ES Modules** em todo o projeto. **Não usar TypeScript.**
- **Backend**: Express com `app.js` (cria e configura a aplicação, sem abrir
  porta) separado de `server.js` (chama `listen`). Essa separação permite testar
  a API com Vitest + Supertest sem subir rede.
- **Validação com Zod** centralizada em `backend/src/schemas.js`. Erros de
  validação são convertidos para resposta HTTP 400 no `errorHandler`.
- **Dados em memória** no `backend/src/store/store.js`. `resetStore()` recria o
  seed e é usado nos testes.
- **Regras de negócio derivadas** (ex.: `duplicateCopies`, relatório) ficam em
  `backend/src/services/report.js` — funções puras, fáceis de testar.
- **Frontend**: React + Vite. Lógica pura (filtros, iniciais, texto do
  relatório) isolada em `frontend/src/utils.js` para permitir testes unitários
  sem DOM. Chamadas HTTP centralizadas em `frontend/src/api.js`.
- **Um container em produção.** O Express serve a API em `/api` e o
  `frontend/dist` no mesmo domínio (`backend/src/static.js`). O fallback da SPA
  cobre tudo **exceto** `/api`: rota inexistente da API devolve JSON 404, nunca
  `index.html`. Sem `dist`, a API continua de pé — o aviso só aparece com
  `NODE_ENV=production`. Caminhos resolvidos por `import.meta.url`, nunca pelo
  diretório do terminal.
- **Metadados de release em um lugar só** (`backend/src/release.js`).
  `/api/health`, `/api/version` e o logger leem de lá, com fallback seguro
  (`package.json` para versão, `unknown` para commit). O health check não expõe
  `process.env`.
- **Compartilhamento** via `navigator.share` com fallback para
  `navigator.clipboard.writeText` — sem bibliotecas externas.
- **CSS puro** com variáveis (paleta esportiva). Sem framework CSS, sem imagens
  externas: iniciais, badges e chips desenhados via CSS.

## Workspace `automation` — agente Pipeline Guardian

Agente que lê **metadados do pipeline, logs e diff da PR** e produz um
diagnóstico estruturado (`reports/diagnosis.json` + `.md`). Decisões que valem
para quem for evoluí-lo:

- **Degrada, não quebra.** Sem `OPENAI_API_KEY`, com erro de rede, timeout, 401,
  429, resposta `incomplete` ou saída fora do schema, cai no **classificador
  determinístico** (`deterministic-classifier.mjs`) e ainda entrega um
  diagnóstico válido, com `usedFallback: true`. O agente nunca fica sem resposta.
- **Uma configuração da OpenAI, um cliente.** `openai-config.mjs` é puro (não
  importa o SDK) e é o **único** lugar onde a string `gpt-5-mini` existe;
  `openai-client.mjs` tem a fábrica do cliente e a única chamada à Responses
  API. Os workflows passam `OPENAI_MODEL` vazio quando a variável não existe no
  GitHub — o padrão é resolvido no código, nunca no YAML, porque dois padrões em
  dois arquivos viram dois padrões diferentes na primeira divergência.
- **Só a chave liga o modelo.** `canUseModel` olha apenas `OPENAI_API_KEY`.
  Exigir `OPENAI_MODEL` junto, como antes, só criava uma forma a mais de o
  modelo ficar desligado sem querer. A chave nunca entra na configuração
  resolvida: vai do `env` direto para o construtor do SDK.
- **Erro do modelo vira categoria, não texto.** O relatório recebe
  `authentication`, `rate_limit`, `timeout`, `network`, `invalid_output`,
  `incomplete` ou `unknown` — nunca a mensagem do SDK, que pode carregar URL com
  credencial, header ou corpo de requisição.
- **Metadados da chamada são conta de luz, não voto.** `model`,
  `modelResponseId`, `modelLatencyMs` e `modelUsage` são opcionais no schema
  (relatórios antigos continuam válidos) e não entram em decisão de CI nem de
  CD.
- **Requisição independente e sem estado.** `store: false` em toda chamada, sem
  `previous_response_id`, sem background mode, sem ferramentas externas, sem
  upload. `store: false` evita o armazenamento da resposta para reuso pela
  aplicação — não é promessa de ausência de retenção operacional do provedor.
- **Chamada real só com opt-in duplo.** `npm run openai:smoke` exige
  `OPENAI_LIVE_TEST=true` **e** a chave. `npm test` e `npm run ci` nunca tocam a
  rede: os testes injetam cliente falso.
- **Métrica de uso não é credencial.** A regra `token: valor` do
  `redact-secrets.mjs` abre exceção para nome no plural **e** valor numérico
  (`Tokens: 1.300`, `totalTokens: 1300`) — `token: valor-real` e
  `password: 123456` continuam mascarados. Os renderizadores redigem **campo a
  campo** e fecham com `redactCredentialMaterial`, que só reconhece material de
  credencial: aplicar a regra de `chave: valor` sobre o Markdown pronto fazia o
  relatório mascarar o próprio rótulo de consumo de tokens.
- **O modelo não decide deploy.** `modelDiagnosisSchema` sequer expõe
  `deployDecision` ao modelo. A decisão vem de `deploy-policy.mjs`, aplicada
  **depois** da análise, com precedência `blocked > requires_human_approval >
  eligible_for_staging`. Na dúvida, fecha.
- **Nada sai sem máscara.** `redact-secrets.mjs` roda sobre logs, diff, payload
  do modelo, saída do modelo e relatório final. A detecção (`detectSecrets`)
  roda no conteúdo **original**; tudo o que circula depois já está mascarado.
- **Evidência não se inventa.** As citações do modelo são conferidas contra o
  material coletado (`groundEvidence`); o que não existe no material é
  descartado e vira limitação.
- **O classificador lê só os logs de quem falhou** — nunca o diff. Código-fonte
  que *menciona* `no-unused-vars` ou `ESLint` (uma config de lint, o próprio
  classificador) faria o agente reprovar um pipeline verde. Sem comando falhando
  não há falha a classificar.

## Validação pós-deployment (CD)

Quem implanta é o **Railway**, pela integração com o GitHub. O agente **não**
executa infraestrutura. `deploy-assisted.yml` continua **simulado** — o
`deployment-manifest.json` tem `status: "simulated"` e esse significado não
mudou com a entrada do Railway.

- **Verificar, explicar e decidir são três jobs distintos**
  (`post-deploy.yml`): `post-deploy-smoke-test` (determinístico, é o gate),
  `deployment-diagnosis` (`if: always()`, informativo) e `cd-gate` (lê **apenas**
  o resultado do smoke test). A IA nunca é condição de aprovação.
- **`status` não é opinião.** Vem do smoke test (código HTTP, exit code) e
  sequer existe em `modelDeploymentDiagnosisSchema`. Sem origem confiável,
  `readTechnicalStatus` assume `failure` — fail-closed.
- **Reuso, não cópia.** `analyze-deployment.mjs` usa `redact-secrets`,
  `sanitize-log`, `selectRelevantLines`, `ground-evidence` e Zod. A ancoragem de
  evidências vive em `ground-evidence.mjs`, compartilhada com o pipeline: duas
  cópias seriam duas chances de afrouxar a regra.
- **Sintoma × causa** (`deployment-classifier.mjs`): "health check reprovado"
  está presente em toda falha e por isso é sintoma. Quando o log traz uma causa
  nomeada (`environment`, `startup`), ela vence o sintoma. E se houve qualquer
  resposta HTTP, `network` sai da disputa — o host respondeu.
- **Teto de confiança em `medium`** para falhas no fallback: o smoke test vê a
  borda da aplicação, não o log interno da plataforma. Essa limitação é
  declarada em toda execução.
- **O gate `docker-build` é um gate inteiro**: está em `GATES`, em
  `gateResultsSchema`, em `buildCiSource` (`DOCKER_RESULT` + `docker.log`), nos
  dois workflows e nos testes. Não existe meio gate.

## Relatório operacional do Dia 1 (CI → CD → runtime)

Reúne **artefatos do CI, logs internos do Railway e o log do smoke test** num
relatório único — JSON, Markdown e **HTML autônomo**
(`pipeline-execution-report.*`, gravado também como
`operational-deployment-report.*`). Ver `docs/day-1-operational-logs.md` e
`docs/day-1-failure-scenarios.md`.

- **Um relatório, dois fluxos, um HTML.** O pós-deployment não roda quando o CI
  falha — e é aí que o relatório vale mais. Ele nasce também no job `diagnose`
  do `ci.yml`, com o mesmo `pipelineExecutionSchema` e o mesmo renderizador. A
  única diferença é o `scope`: com `ci`, as etapas de Railway em diante são
  `not_reached` (nunca começaram), não `unknown`. Um segundo relatório com outro
  layout seria um segundo layout para manter e duas verdades a conciliar.
- **Etapa não é fase.** `OPERATIONAL_PHASES` responde *onde* um fato foi
  observado; `PIPELINE_STAGES` responde *o que o pipeline executou*, e por isso
  inclui os gates. As duas se encontram no campo `phase` de cada etapa, e
  `pipeline-execution-schema.mjs` reprova **na importação** uma etapa cuja fase
  não exista no vocabulário do diagnóstico.
- **`not_reached` não é `failure`, e `unknown` também não.** É a distinção de
  que o dia inteiro depende: uma etapa que nunca começou porque outra reprovou
  não é uma segunda falha. Contá-la assim transformaria um problema em dez e
  esconderia qual deles precisa ser corrigido. `cancelled` do GitHub Actions vira
  `not_reached` pelo mesmo motivo: job interrompido não produziu veredito.
- **A primeira falha é regra, não opinião.** `determineFirstFailedStage` percorre
  `PIPELINE_STAGES` na ordem real e devolve a primeira `failure`. Precedência:
  (1) `mismatch` de SHA zera as etapas de CD para `unknown` — log de outra
  release não sustenta conclusão sobre este commit; (2) falha do CI torna as
  etapas de CD `not_reached`; (3) a ordem decide o resto; (4) a fase do
  classificador entra como **união**, nunca substituição — ela só acrescenta a
  etapa que os logs internos acusam e que a observação externa não alcançava.
- **Os jobs do CI rodam em paralelo, e o relatório diz a verdade sobre isso.**
  Numa falha de lint, `tests`, `build` e `docker-build` continuam `success`
  porque foi isso que `needs.<job>.result` reportou. Marcar como "não alcançado"
  um job que rodou e passou seria exatamente a invenção que o resto do desenho
  proíbe.
- **Sucesso não gera causa nem recomendação.** `probableCause` é `null` e
  `recommendedActions` é `[]` — no classificador e também quando o modelo
  responde outra coisa (a saída descartada vira limitação declarada). Um modelo
  prestativo produz "considere monitorar X" para qualquer release verde, e
  publicar isso ensina a procurar problema onde os gates não encontraram nenhum.
- **A chave sozinha não liga o modelo nas fixtures.** `pipeline-report.mjs`
  **remove** `OPENAI_API_KEY` do ambiente sem `PIPELINE_FIXTURE_USE_OPENAI=true`.
  Não é condição em volta da chamada: é a chave não existir para quem chamaria.
  A máquina de quem apresenta a aula tem a chave no `.env`.
- **`publish-pipeline-report` não está em `needs` do `ci-gate`.** Mesma
  invariante do `cd-gate`, do outro lado: publicar um relatório não é condição do
  resultado técnico, nos dois sentidos.
- **Os dois nomes de arquivo são gravados sempre**, com conteúdo byte a byte
  idêntico. Trocar `operational-deployment-report.*` por
  `pipeline-execution-report.*` de uma vez quebraria material impresso no meio
  da aula.

- **Um vocabulário de fases, num lugar só.** `OPERATIONAL_PHASES` vive no schema
  (`operational-diagnosis-schema.mjs`) e é reexportado pelo agregador. Ele serve
  ao mesmo tempo à fase afetada, à fase de cada fato e à fase de cada evento da
  linha do tempo. Duas listas parecidas divergiriam na primeira fase nova — e a
  divergência aparece como erro de schema com o relatório pronto.
- **Log estruturado é contrato, não hábito.** `backend/src/logging/structured-logger.js`
  define `schemaVersion`, `eventType` e `phase`, e a lista de campos opcionais é
  **fechada** (`OPTIONAL_FIELDS`). O que não está nela é descartado: um objeto
  despejado por engano é como header e corpo vazam para um artefato de CI.
- **`level` vence regex.** Na seleção de fatos, `level: 'error'` é o sinal — ele
  foi atribuído na origem e não depende de a mensagem estar em português. É para
  isso que o log estruturado existe.
- **Ruído de subida não é evidência.** `ECONNREFUSED` e `HTTP 502` nas primeiras
  tentativas são o container subindo. Quando o health check acabou passando, o
  classificador os descarta; quando não passou, eles viram a evidência
  principal. O filtro é condicional, nunca absoluto.
- **O deployment mais recente não é presumido o correto.** A correlação usa o
  SHA quando a plataforma o fornece (aceitando abreviação de ≥ 7) e declara
  `partial` quando não fornece. `mismatch` vence toda outra fase: logs de outra
  release não sustentam conclusão sobre o commit em análise.
- **Ausência de dado não é má notícia.** `railwayDeployment: 'unknown'` nunca
  produz `failure` em `deriveTechnicalStatus`. Só `failed` e `crashed` contam —
  do contrário um token expirado reprovaria um deployment saudável.
- **O bruto do Railway não sai do `$RUNNER_TEMP`.** Sanitiza, copia para
  `reports/`, apaga o bruto. **Sem `tee`**: `tee` imprime no terminal do Actions,
  que é público na execução. `stderr` da CLI vira categoria, nunca texto.
- **Versão da CLI fixada em dois lugares que precisam concordar:**
  `RAILWAY_CLI_VERSION` em `railway-cli.mjs` e o step de instalação no workflow.
  Nunca `latest`.
- **Artefato do CI vem por `run-id`.** Nunca "última execução": entre o CI e a
  validação pode ter entrado outro push, e correlacionar com o CI errado é pior
  que não correlacionar. O conteúdo baixado é texto não confiável e **nunca** é
  executado.
- **Inferência sem fato não existe.** Não é filtro aplicado depois: é condição
  para ser gerada. Fato citado pelo modelo é conferido contra o material
  (`groundObservedFacts`), os `id` são renumerados e `supportedBy` é remapeado —
  sem o remapeamento, remover `F2` faria quem citava `F3` apontar para o fato
  errado.
- **Causa tem força, não certeza.** `causeStrength` distingue
  `direct_evidence`, `probable`, `weak_hypothesis` e `unavailable`. O
  classificador determinístico nunca emite o primeiro: padrão sustenta hipótese.
- **Tudo que entra no HTML passa por `escapeHtml`.** Log de CI, saída da CLI e
  texto de modelo são três fontes não confiáveis, e o HTML é um arquivo que
  alguém abre no navegador. Não existe "escapar só um pouquinho" em
  `html-escape.mjs`.
- **O `cd-gate` declara `needs: [post-deploy-smoke-test]` e nada mais.**
  `automation/tests/operational-workflow.test.mjs` lê o YAML e reprova se essa
  lista crescer, se um secret aparecer no job errado ou se o Summary passar a
  despejar o relatório inteiro. É a invariante do dia, e ela vive num arquivo
  que nenhum teste de unidade cobriria.

## Comandos principais

```bash
npm install                  # instala todos os workspaces
npm run dev                  # backend + frontend (concurrently)
npm run lint                 # ESLint no monorepo
npm run test                 # testes backend + frontend + automation
npm run test:backend         # apenas os testes do backend
npm run test:frontend        # apenas os testes do frontend
npm run test:automation      # apenas os testes do agente
npm run build                # build do frontend
npm run ci                   # lint + test + build

npm run agent:analyze        # agente sobre a execução real (roda o pipeline e lê o working tree)
npm run agent:fixture -- test  # agente sobre um cenário simulado (lint, test, dependency,
                               # build, environment, permission, security, unknown, success)

OPENAI_LIVE_TEST=true npm run openai:smoke   # única chamada real à OpenAI do repositório

npm start                    # só o backend (serve frontend/dist se existir)
npm run start:production     # build do frontend + Express em modo produção
npm run docker:build         # imagem de produção
npm run docker:up            # docker compose up --build
npm run docker:down          # docker compose down

npm run deployment:smoke     # smoke test contra APP_BASE_URL
npm run deployment:analyze   # diagnóstico do log de deployment
npm run deployment:analyze -- --log samples/deployment/startup-failure.log --status failure

npm run operational:report                        # relatório operacional a partir de reports/
npm run operational:fixture -- success            # alias histórico do comando abaixo

npm run pipeline:report                           # relatório de execução (escopo deduzido)
npm run pipeline:fixture -- success               # os cinco cenários do Dia 1, offline
npm run pipeline:fixture -- ci-lint-failure       # firstFailedStage: ci_quality
npm run pipeline:fixture -- ci-tests-failure      # firstFailedStage: ci_tests
npm run pipeline:fixture -- ci-docker-failure     # firstFailedStage: ci_docker
npm run pipeline:fixture -- cd-functional-failure # health 200, /api/report 500

PIPELINE_FIXTURE_USE_OPENAI=true npm run pipeline:fixture -- success  # opt-in do modelo

RAILWAY_LIVE_TEST=true npm run railway:collect    # única coleta real do Railway
```

Por workspace: `npm run <script> -w backend`, `-w frontend` ou `-w automation`.

## Padrão de nomes

- Arquivos JS utilitários e de configuração: `camelCase.js` / `kebab` quando fizer sentido.
- Componentes React: `PascalCase.jsx`.
- Testes: `*.test.js` (backend em `backend/test/`, frontend ao lado do módulo).
- Endpoints REST em inglês sob `/api`; posições em inglês
  (`goalkeeper`, `defender`, `midfielder`, `forward`).
- Respostas de erro padronizadas: `{ error: { code, message, details? }, requestId }`.

## Padrão de nomes (automation)

- Arquivos do agente: `kebab-case.mjs` (ESM explícito, sem TypeScript).
- Testes: `automation/tests/*.test.mjs` (Vitest).
- Fixtures do pipeline: `automation/fixtures/logs/<cenário>.log` e
  `automation/fixtures/diffs/<cenário>.diff`.
- Logs de contingência do deployment: `samples/deployment/<cenário>.log`
  (material didático versionado — precisam da negação em `.gitignore` para
  escapar da regra `*.log`).
- Cenários completos de execução: `samples/pipeline-executions/<cenário>/` com
  `lint.log`, `tests.log`, `build.log`, `docker.log`, `railway-*.jsonl`,
  `deployment.log`, `smoke-test.json`, `collection-metadata.json` e
  `ci-results.json` (mesma negação no `.gitignore`). Os cenários de CI têm
  apenas os quatro `.log` e o `ci-results.json`: sem deployment, não há material
  de deployment a versionar. São **exatamente cinco**, listados em
  `DAY_1_SCENARIOS`; `functional-failure` continua funcionando como alias de
  `cd-functional-failure`.
- Logging da aplicação: `backend/src/logging/structured-logger.js`.

## Restrições

- **Não** fazer commit, push ou abrir Pull Request automaticamente.
- **Não** executar deploy real. O agente **decide**, não promove. Quem implanta é
  o Railway, por integração com o GitHub — nenhum script deste repositório
  publica, faz rollback ou altera infraestrutura.
- **Não** publicar imagem em registry. O job `docker-build` constrói e descarta;
  não usa credencial de registry nem do Railway.
- **Não** publicar comentário em PR sem opt-in explícito: `upsert-pr-comment.mjs`
  é **dry-run por padrão** e só chama a API do GitHub com
  `AUTOMATION_ALLOW_PR_COMMENT=true` **e** `GITHUB_TOKEN`.
- **Não** usar APIs externas no backend/frontend nem buscar imagens da internet.
  A única chamada de rede do projeto é a do agente à OpenAI — e ela é opcional.
- **Não** imprimir `Authorization`, cookies ou corpo de requisição nos logs.
- **Não** enviar conteúdo não mascarado ao modelo.
- **Não** cadastrar `OPENAI_API_KEY` nem `RAILWAY_TOKEN` no Railway: o container
  não chama a OpenAI nem a API da plataforma. A chave da OpenAI existe nos jobs
  de diagnóstico do GitHub e no `automation/.env` local; o `RAILWAY_TOKEN`
  existe **apenas** no job `collect-railway-evidence`.
- **Não** fazer coleta real do Railway em `npm test` ou `npm run ci`: exige
  `RAILWAY_LIVE_TEST=true` **e** o token. Os testes injetam CLI falsa.
- **Não** entregar a chave a job que não diagnostica, nem usar
  `pull_request_target`, nem fazer checkout de código não confiável em job com
  acesso ao secret.
- **Não** fazer chamada real à OpenAI em `npm test` ou `npm run ci`.

## Regra: nada de banco, autenticação ou Docker

Este projeto é **deliberadamente simples**. **Não introduza**:

- **banco de dados** ou qualquer persistência em disco — os dados são em memória;
- **autenticação/autorização** — não há usuários nem sessões;
- **Docker** ou orquestração de containers.

Se uma dessas necessidades surgir, ela pertence a uma etapa futura e deve ser
discutida antes — não adicione por conta própria.
