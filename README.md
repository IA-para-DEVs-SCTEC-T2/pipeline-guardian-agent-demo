# CopaFigurinhas

Aplicação full stack para gestão de um álbum de figurinhas da Copa: cadastre
jogadores, acompanhe **obtidas**, **faltantes** e **repetidas**, e gere um
relatório compartilhável.

Projeto didático, criado para uma aula de **DevOps Inteligente: CI/CD end-to-end
com logs de deployment explicados automaticamente por IA**. É simples de
entender, organizado e completo o suficiente para exercitar **testes, lint,
build, container, deployment e diagnóstico automatizado**.

---

## Objetivo

- Demonstrar uma aplicação full stack pequena e legível.
- Servir de base para um pipeline de CI/CD **de ponta a ponta**: da Pull Request
  ao container publicado, com validação pós-deployment.
- Mostrar um agente de IA que **explica** logs de pipeline e de deployment — sem
  nunca decidir se algo passou.
- Exercitar validação de dados, API REST e uma interface responsiva.

## Arquitetura de execução

Monorepo com **npm workspaces**:

```
copa-figurinhas/
├── backend/      API REST em Node.js + Express (dados em memória)
├── frontend/     Interface em React + Vite
└── automation/   Agente Pipeline Guardian (CI) e diagnóstico de deployment (CD)
```

O mesmo código roda de dois jeitos:

**Desenvolvimento** — dois processos, hot reload:

```text
Vite (5173)  ──proxy /api──▶  Express (3001)
```

**Produção** — **um** processo, **um** container, **um** domínio:

```text
                 ┌──────────────────────────────┐
Navegador ─────▶ │ Express (PORT)               │
                 │  /api/*  → API REST          │
                 │  /*      → frontend/dist     │
                 └──────────────────────────────┘
```

Isso explica três decisões do projeto:

- o frontend chama **`/api` em caminho relativo** (sem `VITE_API_URL` no build);
- o fallback da SPA vale para tudo **exceto `/api`** — rota inexistente da API
  continua devolvendo JSON 404, não `index.html`;
- não existe serviço separado para o frontend, nem em Docker nem no Railway.

Além disso:

- **JavaScript com ES Modules** (sem TypeScript).
- Backend separa `app.js` (aplicação Express, testável) de `server.js`
  (inicialização do servidor) — separação necessária para os testes.
- Dados vivem **em memória** — não há banco de dados.

## Tecnologias

| Camada        | Stack                                                  |
| ------------- | ------------------------------------------------------ |
| Backend       | Node.js 22, Express, CORS, Zod, Vitest, supertest       |
| Frontend      | React, Vite, Vitest, Testing Library                    |
| Automação     | Node.js (ESM), Zod, OpenAI Responses API (opcional)     |
| Qualidade     | ESLint (flat config), concurrently                      |
| Empacotamento | Docker multi-stage, Docker Compose                      |
| CI / CD       | GitHub Actions (CI) · Railway (deployment e execução)   |

## Instalação

Requer **Node.js 22** (e **Docker**, para as seções de container).

```bash
npm ci
```

O comando na raiz instala as dependências de todos os workspaces.

Copie os arquivos de exemplo de variáveis de ambiente, se desejar:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

---

## Executando em desenvolvimento

```bash
npm run dev
```

- Backend: <http://localhost:3001>
- Frontend: <http://localhost:5173> (hot reload, com proxy de `/api`)

Rodar isoladamente:

```bash
npm run dev -w backend
npm run dev -w frontend
```

Validar o health check:

```bash
curl http://localhost:3001/api/health
```

## Executando em produção local

Sem Docker — compila o frontend e sobe o Express servindo o `dist`:

```bash
npm run start:production
```

Equivale a `npm run build` seguido de `NODE_ENV=production npm start`. A
aplicação inteira passa a responder em <http://localhost:3001>.

Se o `frontend/dist` não existir, o backend **continua de pé** servindo só a
API, e registra a falta do build no log quando `NODE_ENV=production`.

## Executando com Docker

```bash
npm run docker:build          # docker build -t copa-figurinhas:local .
docker run --rm -p 3001:3001 copa-figurinhas:local
```

O `Dockerfile` é multi-stage:

| Estágio        | O que faz                                                    |
| -------------- | ------------------------------------------------------------ |
| `deps`         | `npm ci` completo (o Vite precisa das devDependencies)        |
| `build`        | compila o frontend                                            |
| `runtime-deps` | `npm ci --omit=dev --workspace backend`                        |
| `runtime`      | dependências + `backend/src` + `frontend/dist`; roda como `node` |

O container **não** instala dependências nem roda testes na inicialização: só
inicia o servidor. O `HEALTHCHECK` usa o próprio Node
(`backend/src/healthcheck.js`) — sem `curl` nem `wget` na imagem.

## Executando com Docker Compose

Um serviço só, sem banco e sem volume:

```bash
docker compose build
docker compose up
curl http://localhost:3001/api/health
docker compose down
```

Ou, pelos scripts da raiz: `npm run docker:up` / `npm run docker:down`.

O frontend abre no **mesmo endereço** da API: <http://localhost:3001>.

> Porta 3001 ocupada? `HOST_PORT=3010 docker compose up --build`.

---

## Endpoints

Base: `/api`

| Método | Rota                       | Descrição                                  | Sucesso |
| ------ | -------------------------- | ------------------------------------------ | ------- |
| GET    | `/health`                  | Estado do serviço + metadados da release   | 200     |
| GET    | `/version`                 | Só os metadados da release                 | 200     |
| GET    | `/stickers`                | Lista todas as figurinhas                  | 200     |
| GET    | `/stickers/:id`            | Detalha uma figurinha                      | 200     |
| POST   | `/stickers`                | Cria uma figurinha                         | 201     |
| PATCH  | `/stickers/:id/quantity`   | Incrementa/decrementa a quantidade         | 200     |
| DELETE | `/stickers/:id`            | Remove uma figurinha                       | 204     |
| GET    | `/report`                  | Relatório consolidado do álbum             | 200     |

`GET /api/health`:

```json
{
  "status": "ok",
  "service": "copa-figurinhas",
  "environment": "production",
  "version": "1.0.0",
  "commitSha": "9f3ac21",
  "uptimeSeconds": 120,
  "timestamp": "2026-07-29T12:00:00.000Z",
  "requestId": "..."
}
```

Sem segredo, sem `process.env`, sem caminho interno. `version` e `commitSha` têm
fallback seguro (`package.json` e `unknown`). `/api/version` devolve o mesmo
recorte de metadados, montado pela **mesma** função
(`backend/src/release.js`) — os dois nunca divergem.

`PATCH /stickers/:id/quantity` espera o corpo:

```json
{ "operation": "increment" }
```

ou

```json
{ "operation": "decrement" }
```

### Modelo da figurinha

```json
{
  "id": "uuid",
  "albumNumber": 1,
  "playerName": "Marcos Vieira",
  "country": "Brasil",
  "countryCode": "BR",
  "position": "goalkeeper",
  "quantity": 1,
  "duplicateCopies": 0,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

## Regras de negócio

- `albumNumber`: inteiro positivo e **único**.
- `playerName`: entre **3 e 80** caracteres.
- `country`: obrigatório.
- `countryCode`: exatamente **duas letras** (normalizado para maiúsculas).
- `position`: `goalkeeper`, `defender`, `midfielder` ou `forward`.
- `quantity`: inteiro **≥ 0**.
  - `0` = faltante · `1` = obtida sem repetidas · `> 1` = obtida com repetidas.
- `duplicateCopies` = `Math.max(quantity - 1, 0)`.
- Decremento **nunca** produz quantidade negativa.
- Item inexistente → **404**; entrada inválida → **400**; criação → **201**;
  exclusão → **204**.
- `GET /report` retorna `totalRegistered`, `obtained`, `missing`,
  `duplicateCopies`, `completionPercentage` (`obtained / totalRegistered * 100`,
  arredondado), `byCountry`, `missingStickers` e `duplicateStickers`.

## Logs estruturados

Uma linha JSON por **evento**, em `stdout` (`stderr` para `error`) — é assim que
Docker, Railway e GitHub Actions coletam, sem agente e sem arquivo. O contrato
vive em `backend/src/logging/structured-logger.js`:

```json
{"schemaVersion":1,"time":"2026-07-30T15:21:04.502Z","level":"error",
 "source":"application","service":"copa-figurinhas","environment":"production",
 "commitSha":"e82b60d","eventType":"functional.report.failed","phase":"functional",
 "message":"falha ao gerar o relatório do álbum: ...","requestId":"a47f0b93-...",
 "statusCode":500,"functionalArea":"report","errorName":"TypeError"}
```

| Evento                        | Fase          |
| ----------------------------- | ------------- |
| `app.starting` / `app.started` | `startup`     |
| `app.shutdown.requested`      | `shutdown`    |
| `app.uncaught_exception` / `app.unhandled_rejection` | `shutdown` |
| `http.request.completed`      | conforme a rota |
| `health.check.completed`      | `healthcheck` |
| `functional.report.completed` / `.failed` | `functional` |

`healthcheck` e `functional` são fases **distintas** de propósito: é a diferença
entre *processo vivo* e *funcionalidade sadia* — o assunto do Dia 1.

A severidade vem do código HTTP: 5xx é `error`, 4xx é `warn`, o resto é `info`.
A lista de campos é **fechada** (`OPTIONAL_FIELDS`): o que não está nela é
descartado, para que um objeto despejado por engano não vaze header ou corpo.

**Nunca** são registrados: `Authorization`, cookies, corpo de requisição, corpo
completo de resposta, stack trace, chaves de API, senhas, o conteúdo de
variáveis de ambiente — nem a **query string** (o `path` é gravado sem o que vem
depois do `?`).

## Scripts (raiz)

| Script                             | Ação                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `npm run dev`                      | Backend + frontend em paralelo                          |
| `npm start`                        | Só o backend (usa `frontend/dist`, se existir)          |
| `npm run start:production`         | Build do frontend + Express em modo produção            |
| `npm run lint`                     | ESLint em todo o monorepo                               |
| `npm run test`                     | Testes do backend, do frontend e do agente              |
| `npm run build`                    | Build de produção do frontend                           |
| `npm run ci`                       | `lint` + `test` + `build`                               |
| `npm run docker:build`             | Constrói a imagem de produção                           |
| `npm run docker:up` / `:down`      | Sobe / derruba o Docker Compose                         |
| `npm run agent:analyze`            | Agente sobre a execução real do pipeline                |
| `npm run agent:fixture -- test`    | Agente sobre um cenário simulado                        |
| `npm run deployment:smoke`         | Smoke test contra `APP_BASE_URL`                        |
| `npm run deployment:analyze`       | Diagnóstico do log de deployment                        |
| `npm run railway:collect`          | Coleta build/deploy/runtime do Railway (opt-in)         |
| `npm run operational:report`       | Relatório operacional a partir de `reports/`            |
| `npm run operational:fixture -- success` | Relatório operacional de um cenário versionado    |
| `npm run pipeline:report`          | Relatório de execução do pipeline (CI ou CD)            |
| `npm run pipeline:fixture -- <cenário>` | Um dos cinco cenários do Dia 1, offline            |

---

## Pipeline de CI

`.github/workflows/ci.yml`, em Pull Request e em push na `main`:

```text
quality        ESLint                        ── gate técnico
tests          backend + frontend + agente   ── gate técnico
build          Vite                          ── gate técnico
docker-build   imagem de produção, sem push  ── gate técnico
diagnose       Pipeline Guardian             ── INFORMATIVO
ci-gate        resultado final               ── decide pelos gates técnicos
```

Garantias que o desenho preserva:

- lint, testes, build e docker são **gates técnicos**; o diagnóstico **não** é;
- os logs são publicados como artefato **mesmo quando o comando falha**
  (`set -o pipefail` + `tee` + `if: always()`);
- uma falha interna do agente **não** derruba um pipeline tecnicamente saudável
  (`continue-on-error: true` no `diagnose`);
- o `ci-gate` lê `quality`, `tests`, `build` e `docker-build` — **nunca** a
  recomendação do modelo;
- sem `OPENAI_API_KEY`, o fallback determinístico assume e o diagnóstico
  continua sendo produzido.

O job `docker-build` constrói a imagem **sem publicar**: não usa credencial de
registry nem do Railway, e a imagem morre com o runner. Seu log vira artefato e
entra no material analisado pelo Guardian.

## Agente Pipeline Guardian (`automation/`)

Recebe **metadados do pipeline, logs dos comandos e o diff da Pull Request** e
produz um diagnóstico estruturado — em JSON e em Markdown.

```bash
npm run agent:fixture -- test     # cenário simulado
npm run agent:analyze             # executa o pipeline de verdade e analisa o resultado
```

Saídas: `reports/diagnosis.json` e `reports/diagnosis.md`.

### Três garantias

1. **Segredo nenhum sai daqui.** Chaves, `Bearer`, `ghp_`/`github_pat_`, `sk-`,
   variáveis `PASSWORD`/`SECRET`/`TOKEN`, credenciais em URL e cookies viram
   `[REDACTED]` **antes** de irem ao modelo, ao disco ou ao relatório.
2. **O modelo não decide deploy.** Ele descreve a falha; a decisão
   (`eligible_for_staging`, `blocked`, `requires_human_approval`) é de uma
   política determinística aplicada **depois**, que sobrescreve qualquer
   recomendação insegura. Lint, teste, build, permissão, segurança, confiança
   baixa ou limitação relevante ⇒ `blocked`. Produção ⇒ sempre aprovação humana.
3. **Evidência não se inventa.** Cada trecho citado é conferido contra o material
   coletado; o que não existe lá é descartado e declarado como limitação.

### Cenários simulados

`lint`, `test`, `dependency`, `build`, `environment`, `permission`, `security`,
`unknown` e `success`.

### Deploy assistido (simulado)

`.github/workflows/deploy-assisted.yml` roda os quatro gates numa release, chama
o Guardian e produz uma avaliação de prontidão. O `deployment-manifest.json`
resultante tem `status: "simulated"` e descreve o que **teria** sido promovido —
nada é publicado em infraestrutura real. Esse significado **não** mudou com a
entrada do Railway: quem implanta de verdade é a plataforma, pela integração com
o GitHub.

### Configuração do agente

Tudo é opcional — copie `automation/.env.example` para `automation/.env` se
quiser usar o modelo. O agente **não faz deploy** e **não comenta na PR** sem
opt-in explícito (`AUTOMATION_ALLOW_PR_COMMENT=true` + `GITHUB_TOKEN`).

**Basta `OPENAI_API_KEY`.** O modelo padrão é `gpt-5-mini` e vem resolvido em
`automation/src/openai-config.mjs` — `OPENAI_MODEL` só existe para trocá-lo.
Toda a configuração fica nesse módulo, e a chave nunca entra nela: vai direto do
ambiente para o SDK.

| Variável                   | Tipo         | Padrão       |
| -------------------------- | ------------ | ------------ |
| `OPENAI_API_KEY`           | **segredo**  | —            |
| `OPENAI_MODEL`             | configuração | `gpt-5-mini` |
| `OPENAI_REASONING_EFFORT`  | configuração | `low`        |
| `OPENAI_MAX_OUTPUT_TOKENS` | configuração | `2000`       |
| `OPENAI_TIMEOUT_MS`        | configuração | `45000`      |
| `OPENAI_MAX_RETRIES`       | configuração | `1`          |

Valor inválido não vira comportamento imprevisível: cai no padrão e a
substituição é **declarada como limitação** no próprio diagnóstico.

### A chamada ao modelo

Responses API com saída estruturada (`responses.parse` + `zodTextFormat`),
validada por Zod dos dois lados. Cada diagnóstico é uma requisição
**independente e sem estado**: `store: false`, sem `previous_response_id`, sem
background mode, sem ferramentas externas, sem upload.

> `store: false` evita que a resposta fique guardada na plataforma para reuso
> pela aplicação. Não é promessa de ausência de retenção operacional ou de
> monitoramento de abuso do provedor — para isso, valem os termos da OpenAI.

O relatório registra o que a chamada custou, sem nada sensível:

```text
Modelo: gpt-5-mini
Fallback: não
Latência: 1,2 s
Tokens: 1.300 (entrada 1.000 · saída 300 · raciocínio 120)
```

Esses números são **observabilidade**, não voto: não entram na decisão do CI nem
na do CD. Quando a chamada falha, o relatório traz só a **categoria**
(`authentication`, `rate_limit`, `timeout`, `network`, `invalid_output`,
`incomplete`, `unknown`) — nunca a mensagem bruta do SDK, que poderia arrastar
URL com credencial ou header para dentro de um artefato.

### Testar a integração de verdade

Os testes normais usam cliente injetado e **não** chamam a API. Para provar que
a chave, o modelo e a saída estruturada funcionam agora, existe um comando
explícito e opt-in:

```bash
OPENAI_LIVE_TEST=true npm run openai:smoke
```

Sem `OPENAI_LIVE_TEST=true` ele recusa a chamada e explica como habilitá-la.
Consome poucos tokens, não roda em `npm test`, não roda em `npm run ci` e não
roda em Pull Request.

---

## Deployment no Railway

O **Railway** executa a aplicação e faz o CD; o **GitHub Actions** continua
responsável pelo CI. Um projeto, um serviço, um container.

O procedimento manual completo está em
**[`docs/railway-setup.md`](docs/railway-setup.md)**: criar o projeto, conectar
o repositório, usar o `Dockerfile`, configurar o health check `/api/health`,
gerar o domínio público, aguardar a aprovação do CI antes de implantar e
cadastrar a URL como variável `APP_BASE_URL` no GitHub.

A configuração declarativa está em `railway.json` (builder Dockerfile, health
check, política de restart). Campos não confirmados na plataforma ficam
documentados no guia, e não inventados no arquivo.

## Validação pós-deployment

`.github/workflows/post-deploy.yml`, disparado por `workflow_run` (depois de um
**CI aprovado** na `main`) ou manualmente por `workflow_dispatch`:

```text
resolve-context                    qual commit? qual execução de CI?
collect-ci-evidence                COLETA     artefatos do CI que disparou este workflow
post-deploy-smoke-test             VERIFICA   determinístico. É o gate.
collect-railway-evidence           COLETA     build/deploy/runtime da plataforma (best-effort)
operational-deployment-diagnosis   EXPLICA    informativo. Roda com if: always().
publish-operational-report         PUBLICA    JSON + Markdown + HTML
cd-gate                            DECIDE     olha SÓ o resultado do smoke test.
```

O `cd-gate` declara `needs: [post-deploy-smoke-test]` e **mais nada** — não
depende do diagnóstico nem dos jobs de coleta. Um teste
(`automation/tests/operational-workflow.test.mjs`) lê o YAML e reprova se essa
lista crescer.

O smoke test (`automation/src/smoke-test.mjs`):

- exige `APP_BASE_URL` (variável de repositório) e falha claro sem ela;
- consulta `/api/health` até **30 tentativas** a cada **10 segundos** — sempre
  finito, e configurável em um lugar só (`SMOKE_MAX_ATTEMPTS`,
  `SMOKE_INTERVAL_SECONDS`);
- espera a **nova versão** responder, comparando o `commitSha` de `/api/health`
  com o commit que o CI aprovou;
- valida o JSON e confirma `status: "ok"`;
- consulta também a rota funcional `/api/report`;
- registra cada tentativa com código HTTP e motivo em `reports/deployment.log`,
  publicado como artefato **mesmo em falha**.

Exemplo do log:

```text
[...] tentativa 1/30 GET /api/health -> erro de conexão (ECONNREFUSED) em 118ms
[...] tentativa 3/30 GET /api/health -> HTTP 502 — esperado 200 · corpo: Application failed to respond
[...] tentativa 4/30 GET /api/health -> HTTP 200 ok version=1.0.0 commit=9f3ac21
[...] health check: aprovado na tentativa 4
SMOKE TEST RESULT: PASS
```

Rodar localmente contra qualquer URL:

```bash
APP_BASE_URL=https://sua-app.up.railway.app \
SMOKE_MAX_ATTEMPTS=5 SMOKE_INTERVAL_SECONDS=3 \
npm run deployment:smoke
```

## Diagnóstico de logs por IA

`automation/src/analyze-deployment.mjs` lê o log do smoke test e produz
`reports/deployment-diagnosis.{json,md}`:

```json
{
  "stage": "post_deployment_validation",
  "status": "failure",
  "failureType": "healthcheck",
  "summary": "...",
  "evidence": [{ "source": "log:deployment:34", "excerpt": "..." }],
  "probableCause": "...",
  "confidence": "medium",
  "nextSteps": ["..."],
  "limitations": ["..."],
  "usedFallback": false
}
```

O relatório separa quatro registros que costumam vir misturados:

| Seção               | O que é                                               |
| ------------------- | ----------------------------------------------------- |
| **Evidências**      | trechos que **existem** no log, com a linha de origem  |
| **Causa provável**  | **hipótese** inferida — declarada como tal             |
| **Próximos passos** | recomendação acionável                                 |
| **Limitações**      | o que o material **não** permite afirmar               |

A limitação estrutural aparece em **toda** execução: o log analisado é o do
smoke test, executado de fora da aplicação — ele não inclui o log interno do
Railway. Com evidência parcial, o classificador determinístico nunca emite
confiança `high` para uma falha.

O módulo **reusa** a infraestrutura existente em vez de duplicá-la: redação de
segredos, sanitização, redução de log, ancoragem de evidências, validação por
Zod e o mesmo padrão de degradação do Pipeline Guardian.

### Logs de contingência

Quatro logs de smoke test estão versionados em `samples/deployment/`, para a
aula funcionar sem Railway:

```bash
npm run deployment:analyze -- --log samples/deployment/success.log             --status success
npm run deployment:analyze -- --log samples/deployment/healthcheck-failure.log --status failure
npm run deployment:analyze -- --log samples/deployment/startup-failure.log     --status failure
npm run deployment:analyze -- --log samples/deployment/environment-failure.log --status failure
```

Os três logs de falha terminam com a **mesma** linha (`health check: reprovado`)
e mesmo assim são classificados de forma diferente — `healthcheck`, `startup` e
`environment`. Distinguir os três é o exercício.

---

## Relatório de execução do pipeline (CI → CD → runtime)

A saída principal da demonstração do Dia 1. Reúne **as três fontes** — artefatos
do CI, logs internos do Railway e o log do smoke test — num relatório único, em
JSON, Markdown e **HTML autônomo**.

**Um relatório, dois fluxos.** O workflow pós-deployment não roda quando o CI
falha — e é aí que alguém mais precisa dele. Por isso ele também nasce **dentro
do CI**, com o mesmo modelo de execução e o mesmo HTML. Muda só o escopo.

```bash
npm run pipeline:fixture -- success
npm run pipeline:fixture -- ci-lint-failure
npm run pipeline:fixture -- ci-tests-failure
npm run pipeline:fixture -- ci-docker-failure
npm run pipeline:fixture -- cd-functional-failure
open reports/pipeline-execution-report.html
```

Funciona **sem Railway, sem OpenAI e sem internet**: os cinco cenários vivem
versionados em `samples/pipeline-executions/`. Mesmo com `OPENAI_API_KEY` no
ambiente, a fixture **não** chama o modelo sem `PIPELINE_FIXTURE_USE_OPENAI=true`.

### A linha do tempo da execução

Doze etapas, na ordem real do pipeline, cada uma com símbolo **e** texto:

```text
✓ SUCCESS     Lint            ✓ SUCCESS     Railway Deploy
✗ FAILURE     Testes          — NOT REACHED Inicialização
○ SKIPPED     Build           ? UNKNOWN     Health check
```

`— NOT REACHED` significa que a etapa **nunca começou**. Não é uma segunda
falha, e `? UNKNOWN` também não é falha nenhuma: ausência de dado não é má
notícia.

**A primeira etapa que falhou é escolhida por regra**, percorrendo as etapas na
ordem e devolvendo a primeira com `FAILURE`. O modelo não participa dessa
escolha — ele explica a etapa que recebe.

### As duas formas do relatório

| Resultado | O relatório traz |
| --------- | ---------------- |
| **sucesso** | linha do tempo compacta · resumo de uma ou duas frases · cobertura · limitações · gate. **Sem** causa provável e **sem** recomendações: não houve problema. |
| **falha** | linha do tempo completa com a primeira falha destacada · **Explicação da falha**: etapa afetada, o que aconteceu, evidências, causa provável, ações, confiança, limitações e etapas não alcançadas. |

O relatório separa os registros com **rótulo textual**, não só cor:

```text
[FATO]              está literalmente no log — com ID, fonte, fase e timestamp
[EXPLICAÇÃO]        o que aconteceu, segundo a análise
[INFERÊNCIA]        foi deduzido — e mostra QUAIS fatos a sustentam
[CAUSA PROVÁVEL]    hipótese qualificada por força, nunca "causa raiz confirmada"
[AÇÃO RECOMENDADA]  uma ação acionável
[LIMITAÇÃO]         o que não foi possível verificar
```

Cinco garantias, verificadas por teste:

1. **`technicalStatus` não vem do modelo** — não existe no schema de saída dele.
   Vem de exit code de job e de código HTTP.
2. **Fato inventado é removido**, conferido contra o material coletado.
3. **Inferência que perdeu seus fatos é removida**, e a remoção vira limitação.
4. **A causa é qualificada por força** (`direct_evidence`, `probable`,
   `weak_hypothesis`, `unavailable`) — nunca "causa raiz confirmada" a partir de
   sintoma.
5. **Coleta ausente não reprova nada.** Sem `RAILWAY_TOKEN`, sem artefato de CI
   ou sem OpenAI, o relatório sai declarando as lacunas.

E a correlação da release responde a pergunta que faltava: **o commit que o CI
aprovou é o mesmo que está no ar?** (`matched`, `partial`, `mismatch`,
`unknown`). Um `mismatch` é destacado antes de qualquer outra análise.

Detalhes em **[`docs/day-1-operational-logs.md`](docs/day-1-operational-logs.md)**.
Como demonstrar os cinco cenários ao vivo:
**[`docs/day-1-failure-scenarios.md`](docs/day-1-failure-scenarios.md)**.
Atividade dos alunos em
**[`docs/day-1-evidence-review.md`](docs/day-1-evidence-review.md)**.

### O que o Dia 1 **não** faz

| Dia | Pergunta | Material |
| --- | -------- | -------- |
| **1 — implementado** | *O que aconteceu nesta execução, em qual etapa falhou, e o que os logs permitem concluir?* | **uma** execução e seus logs |
| **2 — não implementado** | *O comportamento atual está fora do padrão esperado?* | **várias** execuções comparadas |
| **3 — não implementado** | *Os sinais atuais indicam que uma falha poderá ocorrer?* | histórico e sinais anteriores |

Não há aqui baseline, comparação histórica, janela móvel, z-score, threshold
dinâmico, detecção de anomalias, séries temporais, previsão de falhas, rollback
automático nem monitoramento recorrente. O que separa os três dias é o material
de entrada, e misturá-los é como um relatório do Dia 1 passa a afirmar coisas
que os logs daquela execução não sustentam.

## Fallback sem OpenAI

| Cenário                                                     | Comportamento                                           |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| `OPENAI_API_KEY` definida                                    | Responses API com saída estruturada validada (Zod)      |
| Sem chave                                                    | **Classificador determinístico** (`usedFallback: true`) |
| Erro de rede, timeout, 401, 429 ou saída fora do schema      | **Classificador determinístico** (`usedFallback: true`) |
| Resposta `incomplete` (estourou `OPENAI_MAX_OUTPUT_TOKENS`)  | **Classificador determinístico** (`usedFallback: true`) |

Vale para os **dois** agentes (pipeline e deployment). Em qualquer um dos casos
a saída é válida contra o mesmo schema, e a falha do modelo nunca esconde a
falha real: o `status` do deployment vem do smoke test, e o resultado do CI vem
dos exit codes. O agente **degrada, não quebra**.

## Variáveis e secrets

São quatro coisas diferentes. Não as confunda:

**1. Variáveis da aplicação** (`backend/.env.example`) — em runtime, no
container ou no shell local:

```text
PORT=3001
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
APP_VERSION=1.0.0
COMMIT_SHA=local
```

**2. Variáveis do agente** (`automation/.env.example`) — só na automação, nunca
na aplicação. Localmente, em `automation/.env` (ignorado pelo git):

```text
OPENAI_API_KEY=            # segredo — a única que liga o modelo
OPENAI_MODEL=gpt-5-mini    # configuração (não sensível)
OPENAI_REASONING_EFFORT=low
OPENAI_MAX_OUTPUT_TOKENS=2000
OPENAI_TIMEOUT_MS=45000
OPENAI_MAX_RETRIES=1
APP_BASE_URL=              # URL pública — não é segredo
SMOKE_MAX_ATTEMPTS=30
SMOKE_INTERVAL_SECONDS=10
```

**3. No GitHub** (Settings › Secrets and variables › Actions):

| Tipo                    | Nome                       | Obrigatório | Fallback / padrão            | Para quê                             |
| ----------------------- | -------------------------- | ----------- | ---------------------------- | ------------------------------------ |
| Repository **variable** | `APP_BASE_URL`             | **sim**     | — (o smoke test falha claro) | URL pública validada pelo smoke test |
| Repository **secret**   | `OPENAI_API_KEY`           | não         | classificador determinístico | liga o diagnóstico por modelo        |
| Repository **secret**   | `RAILWAY_TOKEN`            | não         | logs da plataforma ausentes  | coleta build/deploy/runtime          |
| Repository **variable** | `RAILWAY_PROJECT`          | não         | vínculo implícito do token   | vincula o projeto sem interação      |
| Repository **variable** | `RAILWAY_SERVICE`          | não         | serviço padrão do projeto    | escolhe o serviço                    |
| Repository **variable** | `RAILWAY_ENVIRONMENT`      | não         | ambiente padrão do projeto   | escolhe o ambiente                   |
| Repository **variable** | `OPENAI_MODEL`             | não         | `gpt-5-mini`                 | troca o modelo                       |
| Repository **variable** | `OPENAI_REASONING_EFFORT`  | não         | `low`                        | esforço de raciocínio                |
| Repository **variable** | `OPENAI_MAX_OUTPUT_TOKENS` | não         | `2000`                       | teto da saída                        |

Os padrões são resolvidos **no código** (`automation/src/openai-config.mjs`,
`automation/src/railway-cli.mjs`), nunca no YAML: dois padrões em dois arquivos
viram dois padrões diferentes na primeira divergência.

**Em qual job cada secret entra — e onde nunca entra:**

| Job                                  | `OPENAI_API_KEY` | `RAILWAY_TOKEN` |
| ------------------------------------ | ---------------- | --------------- |
| `diagnose` (CI)                      | **sim**          | não             |
| `operational-deployment-diagnosis`   | **sim**          | não             |
| `assess` (deploy assistido)          | **sim**          | não             |
| `collect-railway-evidence`           | não              | **sim**         |
| `quality`, `tests`, `build`, `docker-build` | não       | não             |
| `ci-gate`, `post-deploy-smoke-test`, `cd-gate` | não    | não             |
| `collect-ci-evidence`, `publish-operational-report` | não | não        |
| **Container da aplicação (Railway)** | **nunca**        | **nunca**       |

Os gates técnicos não veem secret nenhum porque nenhum deles chama serviço
externo. E o container da CopaFigurinhas não recebe nenhum dos dois: ele não
chama a OpenAI nem a API do Railway.

Essa tabela é verificada por teste — `automation/tests/operational-workflow.test.mjs`
lê o YAML e reprova se um secret aparecer num job que não deveria vê-lo.

Como criar um **Project Token restrito** do Railway, como rotacioná-lo e como
removê-lo: [`docs/railway-setup.md`](docs/railway-setup.md).

No `post-deploy.yml`, disparado por `workflow_run`, a chave só é entregue quando
a origem é confiável: disparo manual, ou CI **aprovado** vindo de um **push** na
**`main`**. Nenhum workflow usa `pull_request_target` nem faz checkout de código
não confiável num job com acesso ao secret. PR de fork continua sem chave — e
com diagnóstico, via fallback.

**4. No Railway** (Variables do serviço) — nenhuma é obrigatória. `PORT` e
`NODE_ENV` são fornecidos pela plataforma e pela imagem; `RAILWAY_GIT_COMMIT_SHA`
é preenchido automaticamente e vira o `commitSha` do health check.

> **Não cadastre `OPENAI_API_KEY` nem `RAILWAY_TOKEN` no Railway.** O container
> da CopaFigurinhas não chama a OpenAI (quem chama são os workflows do GitHub e
> os scripts locais de automação) e não chama a API do Railway (quem chama é o
> job `collect-railway-evidence`). Qualquer uma das duas chaves lá seria
> superfície de exposição sem nenhum uso — e um token dentro do próprio
> container que ele governa é a pior versão disso.

> Valores reais nunca vão para os arquivos de exemplo, e a `APP_BASE_URL` nunca
> é escrita dentro do YAML.

Sobre **quando** cada valor existe: `VITE_API_URL` só valeria **em build** (e é
deliberadamente deixado vazio); `APP_VERSION`, `COMMIT_SHA` e `PORT` são lidos
**em runtime**; `OPENAI_API_KEY` só existe dentro dos jobs de diagnóstico do
GitHub Actions e no `automation/.env` da máquina de quem desenvolve.

---

## ⚠️ Limitações do armazenamento em memória

Os dados são mantidos **apenas em memória** no processo do backend.
**Reiniciar o servidor recria os dados iniciais (seed) e descarta tudo o que foi
criado ou alterado** — e isso inclui **cada novo deployment**, já que um deploy
substitui o processo.

Não há persistência, banco de dados, SQLite, migrations ou arquivo em disco.
Isso é **intencional**: a implantação tem finalidade didática e o foco do Dia 1
é CI/CD, deployment, health check e diagnóstico inteligente. Persistência está
**fora do escopo** e deve ser discutida antes de ser introduzida.

## Roteiro resumido da aula

O laboratório guiado completo (≈2h30) está em
**[`docs/day-1-lab.md`](docs/day-1-lab.md)**:

1. clonar/forkar e instalar → 2. testes e execução local → 3. Docker Compose e
health check → 4. alteração + Pull Request → 5. ler os logs do CI →
6. comparar log × diagnóstico do Guardian → 7. merge e deployment no Railway →
8. validação pós-deployment → 9. analisar o relatório da IA → 10. provar que o
gate técnico **não** depende da IA.

O guia inclui plano de contingência para Railway indisponível, conta de aluno
sem acesso, integração do GitHub com problema e API da OpenAI fora do ar.

## Solução de problemas

| Sintoma                                                | Causa provável / o que fazer                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `docker compose up` falha com *address already in use*  | A porta 3001 já está ocupada: `HOST_PORT=3010 docker compose up --build`.  |
| Container sobe, mas `/` devolve 404 em JSON             | `frontend/dist` não foi gerado. Reconstrua: `docker compose build --no-cache`. |
| Em produção local, a interface não carrega              | Faltou o build: use `npm run start:production`.                            |
| `/api/rota-errada` devolve HTML                         | Não deve acontecer — o fallback da SPA exclui `/api`. Ver `backend/src/static.js` e `backend/test/static.test.js`. |
| Smoke test falha com `APP_BASE_URL não configurada`     | Cadastre a variável de repositório no GitHub (ver `docs/railway-setup.md`). |
| Smoke test: `ECONNREFUSED` em todas as tentativas       | URL errada ou domínio ainda não gerado no Railway.                         |
| Smoke test: `HTTP 502 · Application failed to respond`  | O processo não subiu. Veja **Deployments › View Logs** no Railway.         |
| Smoke test: versão antiga respondendo                   | O deployment anterior ainda está ativo; aguarde ou reimplante.             |
| Diagnóstico saiu com `usedFallback: true`               | Esperado sem `OPENAI_API_KEY`. O relatório continua válido — veja `modelErrorCategory` para saber se houve tentativa e por que falhou. |
| `modelErrorCategory: authentication`                    | Chave inválida, revogada ou sem acesso ao modelo. Confira com `OPENAI_LIVE_TEST=true npm run openai:smoke`. |
| `modelErrorCategory: incomplete`                        | A resposta estourou o teto de saída. Aumente `OPENAI_MAX_OUTPUT_TOKENS` ou reduza `OPENAI_REASONING_EFFORT`. |
| `modelErrorCategory: rate_limit`                        | Limite da conta. O diagnóstico saiu pelo fallback; repetir mais tarde resolve. |
| `npm run openai:smoke` recusa executar                  | Falta o opt-in: `OPENAI_LIVE_TEST=true npm run openai:smoke`.              |
| `Post-deploy validation` não disparou                   | Só roda após um **CI aprovado na `main`**. Use **Run workflow** para forçar. |
