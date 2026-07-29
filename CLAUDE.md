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

- **Degrada, não quebra.** Sem `OPENAI_API_KEY`/`OPENAI_MODEL`, com erro de rede
  ou com saída fora do schema, cai no **classificador determinístico**
  (`deterministic-classifier.mjs`) e ainda entrega um diagnóstico válido, com
  `usedFallback: true`. O agente nunca fica sem resposta.
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

npm start                    # só o backend (serve frontend/dist se existir)
npm run start:production     # build do frontend + Express em modo produção
npm run docker:build         # imagem de produção
npm run docker:up            # docker compose up --build
npm run docker:down          # docker compose down

npm run deployment:smoke     # smoke test contra APP_BASE_URL
npm run deployment:analyze   # diagnóstico do log de deployment
npm run deployment:analyze -- --log samples/deployment/startup-failure.log --status failure
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

## Regra: nada de banco, autenticação ou Docker

Este projeto é **deliberadamente simples**. **Não introduza**:

- **banco de dados** ou qualquer persistência em disco — os dados são em memória;
- **autenticação/autorização** — não há usuários nem sessões;
- **Docker** ou orquestração de containers.

Se uma dessas necessidades surgir, ela pertence a uma etapa futura e deve ser
discutida antes — não adicione por conta própria.
