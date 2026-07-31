# Dia 1 — Logs operacionais explicados pela IA

Documentação do fluxo que reúne **CI, deployment e runtime** num único relatório
e o explica automaticamente. É o material de referência do laboratório
(`docs/day-1-lab.md`) e o guia de quem for evoluir o código.

> A saída principal da demonstração é o **relatório HTML**:
> `operational-deployment-report.html`.

---

## O problema que este fluxo resolve

Antes, cada evidência vivia num lugar diferente e ninguém as via juntas:

```text
lint.log ─┐
tests.log ├─ artefatos do CI ......... aba Actions, execução do CI
build.log │
docker.log┘
                    logs do Railway ... painel da plataforma, outra aba, outro login
                    deployment.log .... artefato de OUTRA execução do GitHub
```

Diagnosticar significava abrir três telas e correlacionar horários na cabeça. E
a pergunta que mais importa — *o commit que o CI aprovou é o mesmo que está no
ar?* — não tinha onde ser respondida.

O fluxo do Dia 1 junta as três fontes, correlaciona por commit SHA e produz um
relatório único, com **fato, inferência, recomendação e limitação em seções
separadas**.

---

## O fluxo, de ponta a ponta

```text
Pull Request
   │
   ▼
CI (.github/workflows/ci.yml)
   ├── quality (lint)        → artefato lint-log
   ├── tests                 → artefato tests-log
   ├── build                 → artefato build-log
   ├── docker-build          → artefato docker-log
   └── ci-gate               ── gate técnico
   │
   ▼  merge na main + CI verde
   │
Railway implanta (integração GitHub↔Railway — nenhum script deste repo)
   │
   ▼
Post-deploy validation (.github/workflows/post-deploy.yml)
   │
   ├── resolve-context ─────────────── qual commit? qual execução de CI?
   │
   ├── collect-ci-evidence ─────────── baixa os 4 artefatos por `run-id`
   │      (sem secrets · actions: read · nada é executado)
   │
   ├── post-deploy-smoke-test ──────── VERIFICA · determinístico · É O GATE
   │      /api/health e /api/report → reports/deployment.log + smoke-test.json
   │
   ├── collect-railway-evidence ────── build + deploy + runtime da plataforma
   │      (só RAILWAY_TOKEN · best-effort · nunca reprova)
   │
   ├── operational-deployment-diagnosis  EXPLICA · informativo
   │      (só OPENAI_API_KEY · continue-on-error · fallback determinístico)
   │      → JSON + Markdown + HTML
   │
   ├── publish-operational-report ──── PUBLICA · Job Summary curto + link
   │
   └── cd-gate ─────────────────────── DECIDE · lê SÓ o smoke test
```

**A seta que não existe** é a que faltaria para quebrar tudo: não há nenhuma
ligação entre `operational-deployment-diagnosis` e `cd-gate`. O `cd-gate`
declara `needs: [post-deploy-smoke-test]` e mais nada.

---

## Parte 1 — Logs estruturados da aplicação

`backend/src/logging/structured-logger.js` define o contrato. Uma linha JSON por
evento, em `stdout` (`stderr` para `error`).

### Contrato mínimo

```json
{
  "schemaVersion": 1,
  "time": "2026-07-30T15:21:04.502Z",
  "level": "error",
  "source": "application",
  "service": "copa-figurinhas",
  "environment": "production",
  "commitSha": "e82b60d5f1a94c37bd08e25a71f3c6094ab1d7e2",
  "eventType": "functional.report.failed",
  "phase": "functional",
  "message": "falha ao gerar o relatório do álbum: ..."
}
```

Campos opcionais, conforme o evento: `requestId`, `method`, `path`,
`statusCode`, `durationMs`, `port`, `frontendMounted`, `errorName`,
`errorCategory`, `exitCode`, `signal`, `functionalArea`, `healthStatus`.

### Eventos e fases

| Evento                     | Fase          | Quando |
| -------------------------- | ------------- | ------ |
| `app.starting`             | `startup`     | processo começou a subir |
| `app.started`              | `startup`     | ouvindo na porta |
| `app.shutdown.requested`   | `shutdown`    | SIGTERM/SIGINT recebido |
| `app.uncaught_exception`   | `shutdown`    | exceção não capturada → exit 1 |
| `app.unhandled_rejection`  | `shutdown`    | Promise rejeitada → exit 1 |
| `http.request.completed`   | conforme rota | toda requisição concluída |
| `health.check.completed`   | `healthcheck` | `/api/health` respondido |
| `functional.report.completed` | `functional` | `/api/report` OK |
| `functional.report.failed` | `functional`  | `/api/report` falhou |

### Três decisões

1. **A lista de campos é fechada.** `buildLogEvent` só deixa passar o que está
   em `OPTIONAL_FIELDS`. Despejar um objeto inteiro no log é a forma mais fácil
   de vazar header, corpo ou variável de ambiente — e o vazamento apareceria num
   artefato de CI meses depois.
2. **`healthcheck` e `functional` são fases distintas.** É a diferença entre
   *processo vivo* e *funcionalidade sadia*, e é o assunto do cenário 2.
3. **Exceção fatal encerra o processo com código ≠ 0.** Nada de `try/catch`
   global que devolva o processo ao event loop: depois de uma exceção não
   capturada o estado é desconhecido, e servir requisições nesse estado é pior
   que reiniciar.

### O que **nunca** é registrado

`Authorization`, `Cookie`, corpo de requisição, corpo completo de resposta,
`process.env`, stack trace, token, chave, e a **query string** (o `path` é
gravado sem o que vem depois do `?`).

---

## Parte 2 — Coleta dos logs do Railway

`automation/src/collect-railway-evidence.mjs`, via Railway CLI **fixada em
`5.30.1`** (a constante vive em `automation/src/railway-cli.mjs`).

### Saídas

```text
reports/railway/collection-metadata.json
reports/railway/build.jsonl
reports/railway/deploy.jsonl
reports/railway/runtime.jsonl
reports/railway/collection.log
```

### Correlação da release

`collection-metadata.json` responde *qual versão está realmente no ar*:

| `correlationStatus` | Significa |
| ------------------- | --------- |
| `matched`   | um deployment declara o SHA esperado (completo ou abreviação de ≥ 7) |
| `mismatch`  | há SHA declarado e **nenhum** bate — a versão no ar é outra |
| `partial`   | a plataforma não informou SHA; usa deployment ID, branch e horário como evidência **auxiliar** |
| `unknown`   | nenhum deployment foi listado |

**O deployment mais recente não é presumido o correto.** Entre o CI e a coleta
pode ter entrado outro deploy.

### Limites e segurança

- no máximo **300 linhas** por fluxo (build, deploy, runtime);
- no máximo **~120 KB** de material sanitizado no total;
- o bruto da CLI vive **só em `$RUNNER_TEMP`**, é sanitizado, copiado para
  `reports/` e então **apagado**;
- **sem `tee`** — `tee` imprimiria no terminal do Actions, que é público na
  execução;
- `stderr` da CLI vira **categoria** (`authentication`, `not_found`,
  `unsupported_command`, `timeout`, `not_installed`, `unknown`), nunca texto;
- o token vai do `env` direto para o processo filho, e **nunca** para relatório,
  argumento de comando ou log.

### Degradação

| Situação | Comportamento |
| -------- | ------------- |
| Sem `RAILWAY_TOKEN` | `collection-metadata.json` com `sourceCoverage.railway = false`, limitação explícita, **exit 0** |
| CLI ausente | categoria `not_installed`, limitação declarada, **exit 0** |
| CLI falha | categoria segura, evidência limitada, **exit 0** |

Em nenhum caso a coleta reprova o workflow.

---

## Parte 3 — Evidências do CI anterior

O job `collect-ci-evidence` baixa os quatro artefatos usando **`run-id`** (o id
da execução do CI que disparou este workflow) e `github-token`.

**Não** se busca "a última execução": entre o CI e este job pode ter entrado
outro push, e correlacionar o deployment com o CI errado é pior que não
correlacionar.

Em `workflow_dispatch` não existe `workflow_run.id`. O workflow **declara a
ausência** (`has_ci_run=false`) e o relatório sai com `ci: unknown` — que é
diferente de `ci: failure`.

O conteúdo baixado é tratado como **texto não confiável**: nada é executado, o
job só faz `ls`, e a sanitização roda de novo na agregação.

---

## Parte 4 — Agregação

`automation/src/collect-operational-context.mjs` produz
`reports/operational-context.json` e `reports/operational-timeline.json`,
separados em seis blocos:

| Bloco | Campo | O que é |
| ----- | ----- | ------- |
| A | `systemFacts` | fatos do sistema: exit codes, resultados de job, HTTP |
| B | `textSources` | conteúdo textual, mascarado e reduzido |
| C | `limitations` | o que não foi coletado ou verificado |
| D | `sourceCoverage` | quais fontes existem |
| E | `technicalStatus` | o veredito determinístico |
| F | payload do modelo | o recorte que a IA pode ver |

A separação é a garantia de que o modelo receba (F) **sem poder tocar** em (E).

### A linha do tempo

- ordenada por timestamp quando ele existe;
- eventos **sem** timestamp vão para o fim, agrupados por fase, marcados com
  `hasTimestamp: false` — **nenhum horário é fabricado**;
- correlaciona por commit SHA, deployment ID e `requestId`;
- eventos idênticos são deduplicados (30 linhas iguais de health check não
  tornam a evidência mais forte).

### O veredito

```js
overall = 'failure'  se ci === 'failure' || smokeTest === 'failure'
                     || railwayDeployment ∈ {failed, crashed}
overall = 'success'  se ci === 'success' && smokeTest === 'success'
overall = 'unknown'  caso contrário
```

`railwayDeployment: 'unknown'` **nunca** produz `failure`: ausência de dado não
é má notícia, e um token expirado não pode reprovar um deployment saudável.

---

## Parte 5 — O diagnóstico

`automation/src/analyze-operational.mjs`. Reusa toda a infraestrutura existente
(redação, sanitização, `selectRelevantLines`, `groundEvidenceAgainst`, Responses
API, Zod, fallback determinístico, metadados da chamada).

### As cinco regras de reconciliação

1. `technicalStatus` **não** é produzido pelo modelo — não existe no
   `modelOperationalDiagnosisSchema`.
2. `affectedPhase` é conciliada com os fatos: num fluxo aprovado vira `success`;
   num reprovado nunca pode ser `success`.
3. Fato citado que não existe no material é **removido**.
4. Inferência cujo `supportedBy` perdeu todos os fatos é **removida**, e a
   remoção vira limitação declarada.
5. A causa é qualificada por **força**, não afirmada como raiz.

### `causeStrength`

| Valor | Significa |
| ----- | --------- |
| `direct_evidence` | o log **mostra** a causa (a exceção, a variável faltando) |
| `probable` | é a explicação mais provável a partir dos sintomas |
| `weak_hypothesis` | cogitável, mas o material é insuficiente |
| `unavailable` | não há material para apontar causa alguma |

O classificador determinístico **nunca** emite `direct_evidence`: ele reconhece
padrão, e padrão sustenta hipótese, não causa comprovada.

### Fases

`success`, `ci_quality`, `ci_tests`, `ci_build`, `ci_docker`, `railway_build`,
`railway_deploy`, `deployment`, `startup`, `environment`, `network`,
`healthcheck`, `functional`, `runtime`, `post_deployment_validation`,
`version_mismatch`, `unknown`.

A precedência ao escolher a fase afetada:

1. `version_mismatch` vence tudo — se os logs são de outra release, qualquer
   conclusão é sobre o software errado;
2. falha do CI vence falha de deployment;
3. falha da plataforma vence falha do smoke test;
4. dentro do smoke test, health reprovado vence rota funcional.

---

## Parte 6 — O relatório HTML

`reports/operational-deployment-report.html` — arquivo **autônomo**, sem CDN,
script externo, CSS externo, fonte externa ou imagem externa. Abre offline.

Seções: cabeçalho com resultado técnico · resultado por gate · cobertura das
fontes · fase afetada · correlação do SHA · fatos observados · inferências ·
causa provável · recomendações · limitações · linha do tempo · evidências
selecionadas · chamada ao modelo · **O que a IA não pode afirmar**.

### Como ler

**Os rótulos são textuais, não só coloridos:**

```text
[FATO]          está literalmente no log — dá para apontar a linha
[INFERÊNCIA]    foi deduzido dos fatos — mostra QUAIS fatos
[RECOMENDAÇÃO]  uma ação a executar
[LIMITAÇÃO]     o que não foi possível verificar
```

**Cada fato mostra:** ID (`F1`, `F2`…), fonte, fase, timestamp quando existe (ou
"sem timestamp registrado") e o trecho literal sanitizado.

**Cada inferência mostra** os IDs dos fatos que a sustentam, como links
clicáveis para os fatos.

**A cobertura** diz o que foi coletado e o que faltou:

```text
CI lint .............. coletado
CI tests ............. coletado
CI build ............. coletado
Docker ............... coletado
Railway build ........ ausente
Railway deploy ....... ausente
Railway runtime ...... ausente
Smoke test ........... coletado
```

Quando os três do Railway estão ausentes por falta de token, um aviso explícito
aparece dizendo isso.

**O log completo nunca é inserido** — só trechos. Os arquivos inteiros ficam nos
artefatos.

---

## Os dois cenários do Dia 1

```bash
npm run operational:fixture -- success
npm run operational:fixture -- functional-failure
```

Material versionado em `samples/operational/<cenário>/`. Funciona sem Railway,
sem OpenAI e sem internet.

### Cenário 1 — saudável

| | |
| - | - |
| CI | aprovado (lint, tests, build, docker) |
| Railway build | aprovado |
| Aplicação | iniciada (`app.started`) |
| `/api/health` | 200 |
| `/api/report` | 200 |
| SHA | correspondente (`matched`) |
| Smoke test | PASS |
| Relatório | `overall: success` · `affectedPhase: success` · `probableCause: null` |

O log verde **tem** `ECONNREFUSED` e `HTTP 502` nas primeiras tentativas — o
container leva segundos para subir. Nenhuma dessas linhas vira fato: o
classificador as descarta quando o health check acabou passando. *"Tem erro no
log" não é o mesmo que "falhou".*

### Cenário 2 — falha funcional

| | |
| - | - |
| CI | aprovado |
| Railway build | aprovado |
| Aplicação | iniciada |
| `/api/health` | **200** |
| `/api/report` | **500** |
| Runtime | `functional.report.failed` com `TypeError` |
| Smoke test | FAIL |
| CD Gate | falharia |
| Relatório | `overall: failure` · `affectedPhase: functional` |

O relatório distingue **processo vivo** de **funcionalidade quebrada** e traz os
dois lados do contraste como fatos: o health em 200 e o erro interno da
aplicação, relacionado ao `HTTP 500` visto de fora.

---

## Verificação rápida

```bash
# Sem OpenAI → fallback determinístico
OPENAI_API_KEY= npm run operational:fixture -- functional-failure
node -e "console.log(require('./reports/operational-deployment-report.json').usedFallback)"
# esperado: true

# Nenhum segredo em nenhuma saída
grep -rE 'sk-|ghp_|github_pat_|Bearer |Authorization:|Cookie:|access_token|password=' \
  reports/operational-deployment-report.* && echo "VAZOU" || echo "limpo"

# Qual commit foi analisado
node -e "const r=require('./reports/operational-deployment-report.json');
  console.log(r.correlationStatus, r.expectedCommitSha, r.observedCommitSha)"
```

---

## Fora do escopo do Dia 1

Deliberadamente **não** implementado aqui: detecção de anomalias, baseline
estatística, z-score, IQR, janela móvel, previsão de falhas, classificação
preditiva, rollback automático, autocorreção, promoção automática de ambiente,
monitoramento periódico, banco de dados, OpenTelemetry, Kubernetes.

Esses assuntos pertencem aos **Dias 2 e 3** e devem permanecer separados.

## Evolução futura (não desta entrega)

Trocar o gatilho `workflow_run` por **`deployment_status`** traria o estado real
da plataforma como origem do fluxo, em vez de inferi-lo. É uma mudança de
superfície de segurança (outro payload, outras condições de entrega de secret),
e por isso ficou documentada em vez de feita: o `workflow_run` atual já está
validado e a aula acontece antes da próxima janela de revisão.
