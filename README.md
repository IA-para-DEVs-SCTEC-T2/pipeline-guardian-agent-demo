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

Uma linha JSON por requisição, em `stdout` — é assim que Docker, Railway e
GitHub Actions coletam, sem agente e sem arquivo:

```json
{"level":"info","time":"2026-07-29T17:45:06.305Z","service":"copa-figurinhas",
 "environment":"production","version":"1.0.0","commitSha":"9f3ac21",
 "message":"GET /api/report 200","requestId":"...","method":"GET",
 "path":"/api/report","statusCode":200,"durationMs":24.36}
```

**Nunca** são registrados: `Authorization`, cookies, corpo de requisição, chaves
de API, senhas ou o conteúdo de variáveis de ambiente.

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
post-deploy-smoke-test   VERIFICA   determinístico. É o gate.
deployment-diagnosis     EXPLICA    informativo. Roda com if: always().
cd-gate                  DECIDE     olha SÓ o resultado do smoke test.
```

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

## Fallback sem OpenAI

| Cenário                                     | Comportamento                                            |
| ------------------------------------------- | -------------------------------------------------------- |
| `OPENAI_API_KEY` + `OPENAI_MODEL` definidos  | Responses API com saída estruturada validada (Zod)        |
| Sem chave, erro de rede ou saída inválida    | **Classificador determinístico** (`usedFallback: true`)   |

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
na aplicação:

```text
OPENAI_API_KEY=
OPENAI_MODEL=
APP_BASE_URL=
SMOKE_MAX_ATTEMPTS=30
SMOKE_INTERVAL_SECONDS=10
```

**3. No GitHub** (Settings › Secrets and variables › Actions):

| Tipo                    | Nome              | Obrigatório | Para quê                             |
| ----------------------- | ----------------- | ----------- | ------------------------------------ |
| Repository **variable** | `APP_BASE_URL`    | **sim**     | URL pública validada pelo smoke test |
| Repository **variable** | `OPENAI_MODEL`    | não         | liga o diagnóstico por modelo        |
| Repository **secret**   | `OPENAI_API_KEY`  | não         | idem                                 |

**4. No Railway** (Variables do serviço) — nenhuma é obrigatória. `PORT` e
`NODE_ENV` são fornecidos pela plataforma e pela imagem; `RAILWAY_GIT_COMMIT_SHA`
é preenchido automaticamente e vira o `commitSha` do health check.

> Valores reais nunca vão para os arquivos de exemplo, e a `APP_BASE_URL` nunca
> é escrita dentro do YAML.

Sobre **quando** cada valor existe: `VITE_API_URL` só valeria **em build** (e é
deliberadamente deixado vazio); `APP_VERSION`, `COMMIT_SHA` e `PORT` são lidos
**em runtime**; `OPENAI_API_KEY` só existe dentro dos jobs do GitHub Actions.

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
| Diagnóstico saiu com `usedFallback: true`               | Esperado sem `OPENAI_API_KEY`/`OPENAI_MODEL`. O relatório continua válido. |
| `Post-deploy validation` não disparou                   | Só roda após um **CI aprovado na `main`**. Use **Run workflow** para forçar. |
