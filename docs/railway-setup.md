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

Nenhuma chave da OpenAI vai para o Railway: o modelo é usado no GitHub Actions,
não dentro da aplicação.

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

> Nunca escreva a URL dentro do YAML e nunca versione token algum.

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
        ├── post-deploy-smoke-test   determinístico, é o gate
        ├── deployment-diagnosis     informativo, roda mesmo em falha
        └── cd-gate                  decide só pelo smoke test
```

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
  declara essa limitação.
- **Dependência de disponibilidade.** Se o Railway estiver fora do ar, use os
  logs de contingência em `samples/deployment/` (ver `docs/day-1-lab.md`).
