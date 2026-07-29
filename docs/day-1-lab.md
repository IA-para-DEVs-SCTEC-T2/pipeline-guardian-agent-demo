# Dia 1 — Laboratório guiado

**DevOps Inteligente: CI/CD end-to-end com logs de deployment explicados
automaticamente por IA.**

Duração prevista: **2h30**.

Você **não** vai construir a infraestrutura do zero. Ela já existe neste
repositório. Seu trabalho é **operá-la, quebrá-la de propósito e ler o que ela
tem a dizer** — para no fim conseguir responder a uma pergunta:

> Quando a IA explica uma falha de deployment, **quem** decidiu que houve falha?

---

## Roteiro em uma tela

| # | Etapa                                    | Tempo |
| - | ---------------------------------------- | ----- |
| 1 | Clonar e instalar                        | 10min |
| 2 | Testes e execução local                  | 15min |
| 3 | Docker Compose e health check            | 20min |
| 4 | Alteração + Pull Request                 | 20min |
| 5 | Ler os logs do CI                        | 20min |
| 6 | Comparar log × diagnóstico do Guardian   | 20min |
| 7 | Merge e deployment no Railway            | 15min |
| 8 | Validação pós-deployment                 | 20min |
| 9 | Analisar o relatório da IA               | 20min |
| 10| Provar que o gate não depende da IA      | 10min |

---

## 1. Clonar e instalar (10 min)

Faça **fork** do repositório para a sua conta (o fork é o que permite abrir Pull
Request e ver o CI rodando no seu próprio GitHub).

```bash
git clone https://github.com/SEU-USUARIO/pipeline-guardian-agent-demo.git
cd pipeline-guardian-agent-demo
npm ci
```

Requer **Node.js 22** e **Docker**.

✅ **Checkpoint:** `npm ci` terminou sem erro.

---

## 2. Testes e execução local (15 min)

```bash
npm run lint
npm run test
npm run build
```

Suba a aplicação em modo de desenvolvimento:

```bash
npm run dev
```

- Backend: <http://localhost:3001>
- Frontend: <http://localhost:5173>

```bash
curl -s http://localhost:3001/api/health | jq
```

Repare no que o health check devolve: `status`, `service`, `environment`,
`version`, `commitSha`, `uptimeSeconds`, `timestamp`. E no que ele **não**
devolve: nenhuma variável de ambiente, nenhum token, nenhum caminho interno.

Olhe o terminal do backend enquanto navega na interface. Cada requisição vira
uma linha JSON:

```json
{"level":"info","service":"copa-figurinhas","message":"GET /api/report 200",
 "requestId":"...","method":"GET","path":"/api/report","statusCode":200,"durationMs":24.36}
```

> 💬 **Por que JSON?** Porque `stdout` é a interface universal: Docker, Railway
> e GitHub Actions coletam essa saída sem agente, sem arquivo e sem biblioteca
> de observabilidade.

Encerre com `Ctrl+C`.

✅ **Checkpoint:** três comandos verdes e `/api/health` respondendo 200.

---

## 3. Docker Compose e health check (20 min)

Agora o **mesmo container que vai para produção**:

```bash
docker compose up --build
```

Em outro terminal:

```bash
curl -i http://localhost:3001/api/health
curl -s http://localhost:3001/api/version
open http://localhost:3001            # a interface, no MESMO endereço da API
```

> Se a porta 3001 já estiver em uso (por um `npm run dev` esquecido):
> `HOST_PORT=3010 docker compose up --build`.

Experimente estas quatro requisições e explique a diferença entre elas:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:3001/
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:3001/album
curl -s -w "\n" http://localhost:3001/api/nao-existe
curl -s -w "\n" http://localhost:3001/api/report | head -c 120
```

As duas primeiras devolvem **HTML** — é o fallback da SPA, o que faz um *refresh*
em `/album` não quebrar. A terceira devolve **JSON 404**: rota inexistente da API
**não** recebe `index.html`, porque isso esconderia o erro de quem consome a API.

Veja o estado de saúde que o Docker calcula sozinho:

```bash
docker compose ps
```

Encerre:

```bash
docker compose down
```

✅ **Checkpoint:** `/api/health` em 200 pelo container, interface abrindo no
mesmo endereço e `/api/*` inexistente devolvendo JSON.

---

## 4. Alteração + Pull Request (20 min)

Crie uma branch e faça uma alteração pequena e visível:

```bash
git switch -c lab/minha-alteracao
```

Sugestões (escolha uma):

- mudar o texto do cabeçalho em `frontend/src/components/Header.jsx`;
- adicionar uma figurinha ao seed em `backend/src/data/seed.js`;
- ajustar uma cor em `frontend/src/styles.css`.

```bash
npm run test
git add -A
git commit -m "lab: minha primeira alteracao"
git push -u origin lab/minha-alteracao
```

Abra a Pull Request para a `main` **do seu fork**.

✅ **Checkpoint:** PR aberta e o workflow `CI` iniciado.

---

## 5. Ler os logs do CI (20 min)

Na aba **Actions**, abra a execução do `CI`. Cinco jobs importam:

| Job            | O que é                              |
| -------------- | ------------------------------------ |
| `quality`      | ESLint                               |
| `tests`        | testes dos três workspaces           |
| `build`        | build do frontend                    |
| `docker-build` | constrói a imagem, **sem publicar**  |
| `ci-gate`      | o resultado final                    |

Baixe os artefatos `lint-log`, `tests-log`, `build-log` e `docker-log`. Abra o
`docker.log` e localize a linha em que o frontend é compilado **dentro** da
imagem.

> 💬 **Por que um gate de Docker?** Porque lint, teste e build passam num
> repositório cuja imagem não constrói. Se a imagem não nasce, não há o que
> implantar — e isso precisa reprovar o CI, não aparecer só no deploy.

✅ **Checkpoint:** você localizou os quatro logs e sabe dizer o que cada job faz.

---

## 6. Comparar log × diagnóstico do Guardian (20 min)

Ainda na execução do CI, abra o **Job Summary** e leia o relatório do
**Pipeline Guardian**. Depois compare, lado a lado:

| No log bruto            | No diagnóstico                       |
| ----------------------- | ------------------------------------ |
| centenas de linhas      | um resumo em duas frases             |
| a linha do erro         | a mesma linha, em **Evidências**     |
| nada                    | **Causa provável** — uma inferência  |
| nada                    | **Limitações** — o que não foi visto |

Repare em `usedFallback`. Se a turma não tiver `OPENAI_API_KEY` configurada, ele
estará `true`: o diagnóstico veio do **classificador determinístico**, e mesmo
assim é válido, estruturado e útil.

Com a chave configurada (**só ela** — o modelo padrão é `gpt-5-mini`), o
relatório traz também o que a chamada custou:

```text
### Chamada ao modelo

- Modelo: `gpt-5-mini` (openai)
- Fallback: não
- Latência: 1,2 s
- Tokens: 1.300 (entrada 1.000 · saída 300 · raciocínio 120)
```

Vale perguntar para a turma: **esses números decidem alguma coisa?** Não. O
`ci-gate` continua lendo só `quality`, `tests`, `build` e `docker-build`. Se a
chamada falhar, o relatório diz a categoria (`timeout`, `rate_limit`,
`authentication`…) e o diagnóstico sai pelo fallback — a falha do modelo nunca
esconde a falha técnica, e nunca inventa uma.

Agora quebre o pipeline de propósito, num segundo commit na mesma PR:

```js
// backend/src/services/report.js
export function duplicateCopies(quantity) {
  return quantity;                    // era Math.max(quantity - 1, 0)
}
```

```bash
git commit -am "lab: quebrar o teste de proposito"
git push
```

Acompanhe: `tests` fica vermelho, o `ci-gate` reprova — e o `diagnose` roda
mesmo assim, explicando **qual** teste falhou e **por quê**.

Depois desfaça:

```bash
git revert --no-edit HEAD
git push
```

✅ **Checkpoint:** você viu o agente explicar uma falha real e sabe dizer de
onde veio cada campo do relatório.

---

## 7. Merge e deployment no Railway (15 min)

Com o CI verde, faça o **merge** na `main`.

Siga `docs/railway-setup.md` (se o projeto ainda não estiver criado) e acompanhe
em **Deployments › View Logs**. Procure a primeira linha do processo:

```json
{"level":"info","service":"copa-figurinhas","environment":"production",
 "message":"CopaFigurinhas ouvindo na porta 8080","port":8080,"frontendMounted":true}
```

`frontendMounted: true` confirma que a SPA está sendo servida pelo Express.

Confirme com o navegador e com:

```bash
curl -s https://SUA-URL.up.railway.app/api/version
```

✅ **Checkpoint:** a sua alteração está no ar, na URL pública.

---

## 8. Validação pós-deployment (20 min)

Na aba **Actions**, abra **Post-deploy validation**. Ele roda sozinho depois de
um CI aprovado na `main`; para disparar agora, use **Run workflow**.

Três jobs, três papéis diferentes — e essa separação é o assunto da aula:

```text
post-deploy-smoke-test   VERIFICA   determinístico. É o gate.
deployment-diagnosis     EXPLICA    informativo. Roda mesmo em falha.
cd-gate                  DECIDE     olha só o resultado do smoke test.
```

Baixe o artefato `deployment-log` e abra `reports/deployment.log`. Cada
tentativa está lá, com código HTTP e motivo:

```text
[...] tentativa 1/30 GET /api/health -> erro de conexão (ECONNREFUSED) em 118ms
[...] tentativa 3/30 GET /api/health -> HTTP 502 — esperado 200 · corpo: Application failed to respond
[...] tentativa 4/30 GET /api/health -> HTTP 200 ok version=1.0.0 commit=9f3ac21
[...] health check: aprovado na tentativa 4
SMOKE TEST RESULT: PASS
```

> 💬 Um deployment **saudável** também tem linhas de erro no começo: o container
> leva alguns segundos para subir. "Tem erro no log" não é o mesmo que "falhou".

Você pode rodar o mesmo smoke test da sua máquina:

```bash
APP_BASE_URL=https://SUA-URL.up.railway.app \
SMOKE_MAX_ATTEMPTS=5 SMOKE_INTERVAL_SECONDS=3 \
npm run deployment:smoke
```

✅ **Checkpoint:** você leu o log tentativa a tentativa e sabe em qual delas a
aplicação passou a responder.

---

## 9. Analisar o relatório da IA (20 min)

Ainda em **Post-deploy validation**, abra o Job Summary do job
`deployment-diagnosis`. O relatório separa quatro coisas que costumam vir
misturadas:

| Seção              | O que é                                              |
| ------------------ | ---------------------------------------------------- |
| **Evidências**     | trechos que **existem** no log, com a linha de origem |
| **Causa provável** | **hipótese** inferida — não é fato observado          |
| **Próximos passos**| recomendação acionável                                |
| **Limitações**     | o que o material **não** permite afirmar              |

Leia a limitação que aparece em **toda** execução:

> Os logs analisados são do smoke test, executado de fora da aplicação: eles não
> incluem o log interno da plataforma de deployment (Railway).

Agora rode os cenários de falha, sem precisar quebrar o Railway. Os logs de
contingência estão versionados em `samples/deployment/`:

```bash
npm run deployment:analyze -- --log samples/deployment/healthcheck-failure.log --status failure
cat reports/deployment-diagnosis.md

npm run deployment:analyze -- --log samples/deployment/startup-failure.log --status failure
npm run deployment:analyze -- --log samples/deployment/environment-failure.log --status failure
npm run deployment:analyze -- --log samples/deployment/success.log --status success
```

**Exercício.** Os três logs de falha terminam com `health check: reprovado`.
Ainda assim o agente classifica cada um de forma diferente: `healthcheck`,
`startup` e `environment`. Abra os três e responda:

1. Qual **linha exata** distingue um do outro?
2. Por que "o health check não passou" é um **sintoma**, e não uma causa?
3. Em qual deles a `confiança` deveria ser mais baixa? Por quê?

✅ **Checkpoint:** você consegue apontar, em cada relatório, o que é evidência,
o que é hipótese e o que é limitação declarada.

---

## 10. Provar que o gate não depende da IA (10 min)

Esta é a conclusão do dia. Três provas:

**1. Sem chave da OpenAI, o diagnóstico continua saindo.**

```bash
OPENAI_API_KEY= \
  npm run deployment:analyze -- --log samples/deployment/startup-failure.log --status failure
```

Basta neutralizar a **chave**: `OPENAI_MODEL` sozinha não liga nada, porque o
modelo já tem padrão (`gpt-5-mini`).

> Note o `=` no fim, sem valor. `env -u OPENAI_API_KEY` **não** funciona aqui:
> ao remover a variável do ambiente, o `dotenv` a repõe a partir do
> `automation/.env` (ou do `.env` da raiz) e a chave volta. Uma variável já
> definida — mesmo vazia — o `dotenv` não sobrescreve, e `enabled` fica `false`. Rode o mesmo comando **com** a chave e compare os
dois `deployment-diagnosis.json`:

| Campo               | Com chave        | Sem chave |
| ------------------- | ---------------- | --------- |
| `usedFallback`      | `false`          | `true`    |
| `status`            | `failure`        | `failure` |
| `failureType`       | `startup`        | `startup` |
| `model`             | `gpt-5-mini`     | `gpt-5-mini` (o que *seria* usado) |
| `modelUsage`        | contagens        | `null`    |
| `modelResponseId`   | `resp_…`         | `null`    |

O texto muda; **a decisão técnica não**. O agente **degrada, não quebra**.

**2. Nem a IA nem você decidem o `status`.**

```bash
grep -n "SMOKE TEST RESULT" samples/deployment/*.log
```

O `status` do diagnóstico vem dessa linha (ou do `smoke-test.json`), nunca do
modelo. O schema `modelDeploymentDiagnosisSchema`, em
`automation/schemas/deployment-diagnosis-schema.mjs`, **sequer tem** um campo
`status` para o modelo preencher.

**3. Um modelo otimista não aprova nada.**

Abra `automation/tests/analyze-deployment.test.mjs` e leia o teste
*"não deixa o modelo declarar sucesso quando o smoke test reprovou"*. O modelo
falso diz `failureType: 'success'` e `summary: 'Tudo certo!'`; o diagnóstico
final continua `status: failure`, e a divergência aparece nas limitações.

E no workflow, o `cd-gate` lê **apenas** `needs.post-deploy-smoke-test.result`.

> 🧠 **A ideia central do dia:** a IA responde *"o que aconteceu e o que fazer"*.
> Quem responde *"passou ou não passou"* é o comando, o código HTTP e o exit
> code. Trocar essa ordem é o erro que transforma automação em aposta.

✅ **Checkpoint final:** você consegue explicar, com o código na mão, por que
uma falha da IA não reprova um deployment saudável — nem aprova um quebrado.

---

## Plano de contingência

Nada aqui depende de tudo funcionar. Escolha a coluna que se aplica:

| Se isto falhar…                          | Faça isto                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| **Railway fora do ar ou conta sem acesso** | Pule as etapas 7 e 8. Use `samples/deployment/*.log` na etapa 9 — eles são logs reais de smoke test, versionados no repositório. |
| **API da OpenAI indisponível ou sem chave** | Nada a fazer: o fallback determinístico assume sozinho. Confira `usedFallback: true` no relatório e siga o roteiro. |
| **Integração GitHub↔Railway com problema** | Use `workflow_dispatch` em **Post-deploy validation** apontando para uma URL que você controle, ou rode `npm run deployment:smoke` contra o container local (`docker compose up`). |
| **Actions indisponível / sem minutos**     | Reproduza o CI localmente: `npm run ci`, depois `npm run docker:build`, depois `npm run agent:fixture -- test`. |
| **Docker não instalado na máquina**        | Pule a etapa 3. Use `npm run start:production` para ver o Express servindo o `frontend/dist`. |
| **Sem internet**                           | Etapas 1–2 e 9–10 funcionam offline (os `samples/` estão no repositório). |

Para simular um deployment saudável **sem Railway nenhum**:

```bash
docker compose up -d --build
APP_BASE_URL=http://localhost:3001 SMOKE_MAX_ATTEMPTS=5 SMOKE_INTERVAL_SECONDS=2 \
  npm run deployment:smoke
npm run deployment:analyze
cat reports/deployment-diagnosis.md
docker compose down
```

---

## Para os Dias 2 e 3

Fora do escopo hoje, de propósito: banco de dados e persistência, múltiplos
ambientes reais, blue-green, canary, rollback automático, escalabilidade,
observabilidade externa (Prometheus, Grafana, OpenTelemetry), detecção de
anomalias e correção automática de código.

A base entregue no Dia 1 é organizada para receber isso — não para antecipá-lo.
