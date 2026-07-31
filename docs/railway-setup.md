# Deployment no Railway

Guia do procedimento manual. O Railway é responsável pelo **CD e pela execução**
da aplicação; o GitHub Actions continua responsável pelo **CI**.

> Nada neste repositório executa deploy. O agente **avalia**; a plataforma
> **implanta**; o workflow pós-deployment **valida**. Nenhum script faz
> rollback, altera infraestrutura ou promove versão automaticamente.

---

## O que será publicado

**Um** serviço, **um** container:

```text
copa-figurinhas (1 container)
├── Express          API em /api
└── frontend/dist    SPA servida pelo mesmo Express, no mesmo domínio
```

Sem banco, sem Redis, sem volume, sem serviço adicional. Os dados vivem em
memória e são recriados a cada reinício — ver "Limitações", no final.

---

## Passo a passo

### 1. Criar o projeto

1. Acesse <https://railway.com> e faça login com a conta do GitHub.
2. **New Project** › **Deploy from GitHub repo**.
3. Autorize o Railway a ler o repositório, se ainda não tiver autorizado.

### 2. Conectar o repositório e a branch

1. Selecione este repositório.
2. Em **Settings › Source**, confirme:
   - **Branch**: `main`
   - **Root Directory**: vazio (a raiz do repositório)

### 3. Usar o Dockerfile

O `railway.json` na raiz já declara o builder:

```json
{
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" }
}
```

Confirme em **Settings › Build** que o builder detectado é **Dockerfile** (e não
Nixpacks). Se a interface tiver mudado e o campo não existir mais, selecione
Dockerfile manualmente — o `Dockerfile` na raiz é a fonte da verdade.

### 4. Health check

O `railway.json` já declara:

```json
{
  "deploy": {
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

Confirme em **Settings › Deploy › Health Check Path** que o valor é
`/api/health`. É esse endpoint que decide se a instância nova entra em serviço.

> Se algum campo da configuração declarativa não for aceito pela versão atual da
> plataforma, **configure pela interface** e mantenha o `railway.json` só com o
> que for suportado. É preferível a um arquivo inválido.

### 5. Variáveis do serviço

Em **Variables**, nenhuma variável é obrigatória. Opcionais:

| Variável      | Para quê                                    | Observação                              |
| ------------- | ------------------------------------------- | --------------------------------------- |
| `APP_VERSION` | aparece em `/api/health` e `/api/version`   | sem ela, usa o `version` do `package.json` |
| `CORS_ORIGIN` | libera outra origem para a API              | desnecessário: API e SPA no mesmo domínio |

Não defina:

- **`PORT`** — o Railway injeta a porta; o Express já a respeita.
- **`NODE_ENV`** — a imagem já fixa `production`.
- **`COMMIT_SHA`** — o Railway expõe `RAILWAY_GIT_COMMIT_SHA` automaticamente, e
  a aplicação usa esse valor como fallback.

**Não cadastre `OPENAI_API_KEY` aqui.** O container da CopaFigurinhas não chama
a OpenAI: quem chama são os workflows do GitHub (jobs de diagnóstico) e os
scripts locais de `automation/`. Uma chave no Railway seria superfície de
exposição sem nenhum uso — mais um lugar de onde vazar, zero funcionalidade a
mais. O mesmo vale para `OPENAI_MODEL` e companhia: são configuração da
automação, não da aplicação.

### 6. Gerar o domínio público

**Settings › Networking › Public Networking** › **Generate Domain**.

Guarde a URL — algo como
`https://copa-figurinhas-production.up.railway.app`.

### 7. Aguardar a aprovação do CI antes de implantar

Em **Settings › Deploy**, procure a opção de aguardar as verificações do GitHub
(nomeada **Wait for CI** nas versões recentes) e ative-a.

Com ela ligada, o Railway só implanta um commit da `main` depois que o workflow
`CI` fica verde — inclusive o gate `docker-build`. Se a opção não existir na sua
versão da plataforma, o fluxo continua funcionando: o `post-deploy.yml` só roda
depois de um CI aprovado, então um deploy de commit reprovado seria implantado
mas não validado.

### 8. Cadastrar a URL no GitHub

No repositório: **Settings › Secrets and variables › Actions › Variables** ›
**New repository variable**.

| Nome           | Valor                                              |
| -------------- | -------------------------------------------------- |
| `APP_BASE_URL` | a URL gerada no passo 6, **sem barra no final**     |

É uma **variável**, não um secret: é um endereço público, e mantê-la como
variável permite que o log do workflow mostre contra o que ele testou.

Se quiser o diagnóstico com modelo no pós-deployment, cadastre também — no mesmo
lugar, mas na aba certa:

| Aba           | Nome                       | Obrigatório | Observação                    |
| ------------- | -------------------------- | ----------- | ----------------------------- |
| **Secrets**   | `OPENAI_API_KEY`           | não         | única que é segredo           |
| **Variables** | `OPENAI_MODEL`             | não         | padrão no código: `gpt-5-mini` |
| **Variables** | `OPENAI_REASONING_EFFORT`  | não         | padrão no código: `low`        |
| **Variables** | `OPENAI_MAX_OUTPUT_TOKENS` | não         | padrão no código: `2000`       |

Sem o secret, o job `operational-deployment-diagnosis` continua rodando e
produzindo diagnóstico pelo classificador determinístico. Ele é o **único** job
deste fluxo que recebe a chave — `post-deploy-smoke-test` e `cd-gate`, que são
quem de fato aprova ou reprova, não a veem.

> Nunca escreva a URL dentro do YAML e nunca versione token algum.

---

## Coleta dos logs internos do Railway (opcional)

Sem esta seção, o relatório operacional continua sendo gerado — ele apenas
declara que os logs da plataforma estão **ausentes** e trabalha com o que o CI e
o smoke test viram. Com ela, o diagnóstico passa a enxergar o **interior do
container**: build, inicialização e runtime.

### 1. Criar um Project Token restrito

No Railway: **Project Settings › Tokens › New Token**.

| Escolha            | Valor                                              |
| ------------------ | -------------------------------------------------- |
| Tipo               | **Project Token** (não um token de conta)          |
| Projeto            | apenas o projeto da CopaFigurinhas                  |
| Ambiente           | apenas `production`                                 |
| Nome               | algo rastreável, ex.: `github-actions-log-collector` |

> ⚠️ Um **Project Token** vale só para um projeto e um ambiente. Um token de
> conta daria acesso a **todos** os seus projetos a um workflow que só precisa
> ler log de um. A diferença aparece no dia em que o token vaza.

Copie o valor — ele só é exibido uma vez.

### 2. Cadastrar como secret no GitHub

**Settings › Secrets and variables › Actions › Secrets** › **New repository
secret**:

| Nome            | Valor                          |
| --------------- | ------------------------------ |
| `RAILWAY_TOKEN` | o Project Token do passo 1     |

E, na aba **Variables** (não são segredos — são configuração):

| Nome                  | Obrigatória | Exemplo            |
| --------------------- | ----------- | ------------------ |
| `RAILWAY_PROJECT`     | não\*       | `copa-figurinhas`  |
| `RAILWAY_SERVICE`     | não         | `copa-figurinhas`  |
| `RAILWAY_ENVIRONMENT` | não         | `production`       |

\* Sem `RAILWAY_PROJECT`, a coleta depende do vínculo implícito do token e
declara isso como limitação no relatório. Com ela, o vínculo é explícito e
não interativo.

### 3. Onde o token entra — e onde nunca entra

| Job / destino                      | Recebe `RAILWAY_TOKEN`? |
| ---------------------------------- | ----------------------- |
| `collect-railway-evidence`         | **sim** — o único       |
| `collect-ci-evidence`              | não                     |
| `post-deploy-smoke-test`           | não                     |
| `operational-deployment-diagnosis` | não                     |
| `publish-operational-report`       | não                     |
| `cd-gate`                          | não                     |
| **Container da aplicação (Railway)** | **nunca**             |

> **Não cadastre `RAILWAY_TOKEN` nas Variables do serviço no Railway.** A
> aplicação não chama a API do Railway; o token existe para um job do GitHub
> ler log. Um token dentro do próprio container que ele governa é superfície de
> exposição sem nenhum uso.

Um teste da suíte (`automation/tests/operational-workflow.test.mjs`) verifica
essa tabela lendo o YAML: se alguém copiar o token para outro job numa
refatoração, o teste reprova.

### 4. Versão da Railway CLI

O workflow instala uma versão **exata**:

```bash
npm install -g @railway/cli@5.30.1
```

Nunca `latest`. Uma CLI que muda de flag entre duas execuções transforma "a
coleta falhou" num mistério — e a aula acontece numa data específica.

Para atualizar: rode `npm view @railway/cli versions`, escolha a nova versão,
confirme `railway logs --help` no runner e ajuste **os dois lugares** que
declaram a versão:

- `automation/src/railway-cli.mjs` → `RAILWAY_CLI_VERSION`
- `.github/workflows/post-deploy.yml` → o step *Instalar Railway CLI*

### 5. Testar a coleta de verdade

A coleta real **não** roda em `npm test` nem em `npm run ci`. Para exercitá-la
localmente, é preciso opt-in explícito **e** o token:

```bash
RAILWAY_LIVE_TEST=true \
RAILWAY_TOKEN=xxxxx \
RAILWAY_PROJECT=copa-figurinhas \
RAILWAY_SERVICE=copa-figurinhas \
RAILWAY_ENVIRONMENT=production \
EXPECTED_COMMIT_SHA=$(git rev-parse HEAD) \
  npm run railway:collect

cat reports/railway/collection-metadata.json
```

Requer `npm install -g @railway/cli@5.30.1`. Sem token, o comando termina bem e
grava um `collection-metadata.json` com `sourceCoverage.railway: false`.

### 6. Rotacionar ou remover o token

**Rotacionar:** crie um token novo no Railway, atualize o secret no GitHub e só
então revogue o antigo (**Project Settings › Tokens › Revoke**). Nessa ordem —
revogar primeiro deixaria a próxima execução sem coleta.

**Remover de vez:** revogue no Railway e apague o secret no GitHub. O fluxo
continua funcionando: o relatório passa a declarar os logs da plataforma como
ausentes, e o `cd-gate` não muda em nada.

### 7. Rodar sem o Railway

Se o Railway estiver indisponível, sem acesso ou fora do escopo da aula:

```bash
npm run operational:fixture -- success
npm run operational:fixture -- functional-failure
```

Os cenários em `samples/operational/` são material versionado e produzem os três
relatórios sem rede nenhuma.

### 9. Fazer o primeiro deployment

Faça merge de qualquer alteração na `main` (ou use **Deploy** na interface do
Railway). Acompanhe em **Deployments › View Logs**.

Os logs da aplicação são JSON, uma linha por requisição:

```json
{"level":"info","time":"2026-07-29T17:45:06.305Z","service":"copa-figurinhas",
 "environment":"production","version":"1.0.0","commitSha":"9f3ac21",
 "message":"GET /api/health 200","requestId":"...","method":"GET",
 "path":"/api/health","statusCode":200,"durationMs":1.33}
```

### 10. Validar

```bash
curl -i https://SUA-URL.up.railway.app/api/health
curl -s https://SUA-URL.up.railway.app/api/version
```

Esperado: HTTP 200 e `"status":"ok"`. Abra a URL no navegador — a interface do
CopaFigurinhas deve carregar do mesmo endereço.

Em seguida, o workflow **Post-deploy validation** roda sozinho depois do próximo
CI aprovado na `main`. Para disparar na hora:
**Actions › Post-deploy validation › Run workflow**.

---

## Como o CI e o CD se encaixam

```text
Pull Request → CI (lint, testes, build, docker-build, diagnóstico, CI Gate)
                     │
                  merge na main
                     │
             CI verde na main
                     │
        Railway implanta o container  ← integração GitHub↔Railway
                     │
     Post-deploy validation (GitHub Actions)
        ├── resolve-context                    qual commit? qual execução de CI?
        ├── collect-ci-evidence                baixa os artefatos do CI certo
        ├── post-deploy-smoke-test             determinístico, é o gate
        ├── collect-railway-evidence           build + deploy + runtime (best-effort)
        ├── operational-deployment-diagnosis   informativo, roda mesmo em falha
        ├── publish-operational-report         JSON + Markdown + HTML
        └── cd-gate                            decide só pelo smoke test
```

O detalhe completo do fluxo está em
**[`docs/day-1-operational-logs.md`](day-1-operational-logs.md)**.

---

## Solução de problemas

| Sintoma no smoke test                          | Onde olhar primeiro                                        |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `ECONNREFUSED`/`ENOTFOUND` em todas as tentativas | `APP_BASE_URL` errada, ou domínio ainda não gerado (passo 6) |
| `HTTP 502 · Application failed to respond`     | o processo não subiu: **Deployments › View Logs** no Railway |
| `HTTP 503` com `status="degraded"`             | o processo subiu mas não ficou saudável — health check       |
| `HTTP 404` na raiz                             | deployment não concluiu, ou domínio aponta para outro serviço |
| Versão antiga respondendo                      | deployment anterior ainda ativo; aguarde ou reimplante       |

Para reproduzir localmente o mesmo container que o Railway executa:

```bash
docker compose up --build
curl http://localhost:3001/api/health
```

---

## Limitações

- **Sem persistência.** Os dados são em memória. Reiniciar o serviço — inclusive
  a cada novo deployment — recria o seed e descarta tudo o que foi criado.
  Isso é uma decisão didática do Dia 1, não um bug.
- **Sem banco, sem migrations, sem SQLite.** Fora do escopo desta entrega.
- **O smoke test enxerga a borda.** Ele consulta a aplicação de fora e não tem
  acesso ao log interno do Railway. Todo diagnóstico gerado a partir dele
  declara essa limitação — e é essa limitação que o job
  `collect-railway-evidence` remove **quando** a coleta funciona.
- **A coleta da plataforma é best-effort.** Sem `RAILWAY_TOKEN`, com CLI ausente
  ou com erro de autenticação, o relatório sai igual, declarando as fontes como
  ausentes. Ela **nunca** reprova um deployment saudável.
- **Dependência de disponibilidade.** Se o Railway estiver fora do ar, use os
  logs de contingência em `samples/deployment/` (ver `docs/day-1-lab.md`).
