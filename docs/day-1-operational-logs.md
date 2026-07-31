# Dia 1 — Logs operacionais explicados pela IA

Documentação do fluxo que reúne **CI, deployment e runtime** num único relatório
e o explica automaticamente. É o material de referência do laboratório
(`docs/day-1-lab.md`), dos cenários de aula
(`docs/day-1-failure-scenarios.md`) e de quem for evoluir o código.

> A saída principal da demonstração é o **relatório HTML**:
> `pipeline-execution-report.html` (gravado também como
> `operational-deployment-report.html`, byte a byte igual).

---

## Os três dias, e por que eles não se misturam

| Dia | Pergunta | Material | O que o sistema faz |
| --- | -------- | -------- | ------------------- |
| **1** | *O que aconteceu nesta execução, em qual etapa falhou, e o que os logs permitem concluir?* | **uma** execução e seus logs | coleta, identifica a etapa, seleciona evidências, explica, aponta causa provável, sugere ações e declara limitações |
| **2** | *O comportamento atual está fora do padrão esperado?* | **várias** execuções comparadas entre si | — |
| **3** | *Os sinais atuais indicam que uma falha poderá ocorrer?* | histórico e sinais anteriores | — |

O Dia 1 termina na explicação de **uma** execução. Ele não compara com execuções
anteriores, não calcula padrão e não projeta nada para a frente — nem como
funcionalidade escondida, nem como rótulo no relatório. O que separa os três dias
é o **material de entrada**, e misturar os materiais é como um relatório do Dia 1
passa a afirmar coisas que os logs daquela execução não sustentam.

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
   ├── diagnose              ── EXPLICA · if: always() · só ele vê a chave
   │      └── relatório de execução (escopo `ci`)
   ├── publish-pipeline-report  PUBLICA · Summary curto + link · sem secret
   └── ci-gate               ── DECIDE · exit codes de quality/tests/build/docker
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
declara `needs: [post-deploy-smoke-test]` e mais nada. Do lado do CI vale o
mesmo: `publish-pipeline-report` **não** está em `needs` do `ci-gate`.

**Quando o CI falha, o pós-deployment não roda** — e é justamente aí que alguém
precisa do relatório. Por isso ele nasce dentro do próprio CI, no job
`diagnose`, com o mesmo modelo de execução e o mesmo HTML. A única diferença é
o **escopo**: com `ci`, as etapas de Railway, runtime e smoke test aparecem como
`NOT REACHED` — nunca começaram — em vez de `UNKNOWN`.

---

## O modelo de execução — etapas, e a primeira que falhou

`automation/schemas/pipeline-execution-schema.mjs` e
`automation/src/pipeline-execution.mjs`.

As doze etapas, **na ordem real do pipeline**:

```text
ci_quality → ci_tests → ci_build → ci_docker → ci_gate
  → railway_build → railway_deploy → startup
  → healthcheck → functional → smoke_test → cd_gate
```

Cada uma recebe uma situação, e as cinco significam coisas diferentes:

| Situação | Símbolo | Significa |
| -------- | ------- | --------- |
| `success`     | `✓` | executou e passou |
| `failure`     | `✗` | executou e reprovou |
| `skipped`     | `○` | foi deliberadamente pulada |
| `not_reached` | `—` | **nunca começou** — inclui `cancelled` do GitHub Actions |
| `unknown`     | `?` | não há material para afirmar nada sobre ela |

> **`not_reached` não é `failure`.** É a distinção de que o dia inteiro depende.
> Uma etapa que nunca começou porque uma anterior reprovou não é uma segunda
> falha: contá-la assim transformaria um problema em dez e esconderia qual deles
> precisa ser corrigido. `unknown` também não é falha — ausência de dado não é
> má notícia.

### `determineFirstFailedStage`

Percorre as etapas na ordem acima e devolve **a primeira com `failure`**.
`skipped`, `not_reached` e `unknown` são ignorados. Sem nenhuma falha, devolve
`null` quando o resultado é sucesso e `'unknown'` quando o resultado é falha mas
nenhuma etapa pôde ser responsabilizada — eleger uma etapa arbitrária seria
apontar um culpado sorteado.

**A precedência**, e o motivo de cada degrau:

1. **Correlação quebrada vence tudo.** Com `mismatch`, os logs de runtime são de
   outra release: **nenhuma** etapa de CD é atribuída ao commit em análise (todas
   viram `unknown`) e a primeira falha fica `unknown`.
2. **Falha do CI vence falha de deployment.** As etapas de CD viram
   `not_reached`: não houve deployment deste commit.
3. **A ordem real do pipeline decide o resto.**
4. **A fase do classificador entra como união, nunca como substituição.** O
   smoke test enxerga a borda da aplicação; os logs internos às vezes acusam uma
   etapa mais cedo (o container que nem subiu). A união faz a primeira falha ser
   a mais precoce das duas — e nunca transforma em falha uma etapa observada como
   saudável, porque só acrescenta.

**O modelo não participa de nada disso.** Ele pode escrever o texto que descreve
a etapa; qual etapa esse texto descreve sai daqui. Um modelo que responde
`affectedPhase: success` numa execução reprovada tem a resposta descartada e a
divergência publicada como limitação.

### As duas formas do relatório

| `overallStatus` | O relatório traz |
| --------------- | ---------------- |
| `success` | cabeçalho · linha do tempo compacta · **resumo de uma ou duas frases** · cobertura das fontes · limitações · decisão do gate |
| `failure` | cabeçalho · linha do tempo completa com a **primeira falha destacada** · **Explicação da falha** (etapa afetada, o que aconteceu, evidências, causa provável, ações, confiança, limitações, etapas não alcançadas) · decisão do gate |

Numa execução aprovada **não existem** seções de causa provável e de
recomendações: `probableCause` é `null`, `recommendedActions` é `[]`, e o resumo
não cita risco, alerta nem problema. Não há o que corrigir — e um relatório
verde com a forma visual de um relatório de incidente ensina a procurar problema
onde os gates não encontraram nenhum.

Numa execução reprovada, a explicação detalhada cobre **só a falha principal**.
As etapas saudáveis anteriores não ganham texto: elas já estão contadas na linha
do tempo, e um parágrafo sobre cada uma afogaria a única que importa.

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

## Os cinco cenários do Dia 1

```bash
npm run pipeline:fixture -- success
npm run pipeline:fixture -- ci-lint-failure
npm run pipeline:fixture -- ci-tests-failure
npm run pipeline:fixture -- ci-docker-failure
npm run pipeline:fixture -- cd-functional-failure
```

Material versionado em `samples/pipeline-executions/<cenário>/`. Funciona sem
Railway, sem OpenAI e sem internet. Ver `docs/day-1-failure-scenarios.md` para
como demonstrá-los ao vivo.

| Cenário | Escopo | `firstFailedStage` | Gate |
| ------- | ------ | ------------------ | ---- |
| `success` | `cd` | `null` | `cd` aprovado |
| `ci-lint-failure` | `ci` | `ci_quality` | `ci` reprovado |
| `ci-tests-failure` | `ci` | `ci_tests` | `ci` reprovado |
| `ci-docker-failure` | `ci` | `ci_docker` | `ci` reprovado |
| `cd-functional-failure` | `cd` | `functional` | `cd` reprovado |

> `npm run operational:fixture -- functional-failure` continua funcionando: o
> nome antigo é um alias de `cd-functional-failure`.

**A chave sozinha não liga o modelo.** No modo fixture, `OPENAI_API_KEY` é
removida do ambiente antes de chegar ao agente; para habilitar a chamada é
preciso `PIPELINE_FIXTURE_USE_OPENAI=true`. A máquina de quem apresenta costuma
ter a chave no `.env`, e uma demonstração que sai chamando a API a cada
`npm run` é uma conta e uma dependência de rede que ninguém pediu.

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
| Relatório | `overall: success` · `firstFailedStage: null` · `probableCause: null` · `recommendedActions: []` |

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
| CD Gate | reprovado |
| Relatório | `overall: failure` · `firstFailedStage: functional` |

O relatório distingue **processo vivo** de **funcionalidade quebrada** e traz os
dois lados do contraste como fatos: o health em 200 e o erro interno da
aplicação, relacionado ao `HTTP 500` visto de fora.

### Cenários 3, 4 e 5 — as falhas de CI

Os três param antes do deployment, e o relatório sai **dentro do CI**:

| Cenário | `✓` até | `✗` em | O que os fatos citam |
| ------- | ------- | ------ | -------------------- |
| `ci-lint-failure` | — | Lint | arquivo e regra (`no-unused-vars`) |
| `ci-tests-failure` | Lint | Testes | expectativa, valor observado e arquivo do teste |
| `ci-docker-failure` | Lint, Testes, Build | Docker | comando e caminho ausente |

Nos três, todas as etapas de Railway em diante aparecem como `— NOT REACHED`: o
deployment não começou.

> Uma observação que vale dizer em aula: `tests`, `build` e `docker-build` rodam
> **em paralelo** com `quality` neste repositório. Numa falha de lint, os outros
> três continuam `✓ SUCCESS` no relatório — porque foi isso que aconteceu. O
> relatório usa `needs.<job>.result` de cada um; ele não inventa "não alcançado"
> para um job que rodou e passou.

---

## Verificação rápida

```bash
# Sem OpenAI → fallback determinístico (o padrão das fixtures)
npm run pipeline:fixture -- cd-functional-failure
node -e "console.log(require('./reports/pipeline-execution-report.json').usedFallback)"
# esperado: true

# Qual etapa falhou primeiro, e quem decidiu o gate
node -e "const e=require('./reports/pipeline-execution-report.json').pipelineExecution;
  console.log(e.overallStatus, e.firstFailedStage, JSON.stringify(e.gate))"
# esperado: failure functional {"type":"cd","status":"rejected","determinedBy":"deterministic"}

# Nenhum segredo em nenhuma saída
grep -rE 'sk-|ghp_|github_pat_|Bearer |Authorization:|Cookie:|access_token|password=' \
  reports/pipeline-execution-report.* && echo "VAZOU" || echo "limpo"

# Qual commit foi analisado
node -e "const r=require('./reports/pipeline-execution-report.json');
  console.log(r.correlationStatus, r.expectedCommitSha, r.observedCommitSha)"
```

---

## Fora do escopo do Dia 1

Deliberadamente **não** implementado aqui: detecção de anomalias, baseline
estatística, z-score, IQR, janela móvel, média ou mediana móvel, threshold
dinâmico, séries temporais, previsão de falhas, classificação preditiva,
rollback automático, autocorreção, promoção automática de ambiente,
monitoramento periódico, banco de dados, OpenTelemetry, Kubernetes.

Esses assuntos pertencem aos **Dias 2 e 3** e devem permanecer separados. O
relatório também não usa os rótulos `[ANOMALIA]`, `[PREVISÃO]`, `[RISCO FUTURO]`
ou `[TENDÊNCIA]` — os únicos rótulos são `[FATO]`, `[EXPLICAÇÃO]`,
`[CAUSA PROVÁVEL]`, `[AÇÃO RECOMENDADA]`, `[LIMITAÇÃO]` e `[INFERÊNCIA]`.
`automation/tests/pipeline-execution.test.mjs` reprova a suíte se algum desses
termos aparecer na saída dos cinco cenários.

## Evolução futura (não desta entrega)

Trocar o gatilho `workflow_run` por **`deployment_status`** traria o estado real
da plataforma como origem do fluxo, em vez de inferi-lo. É uma mudança de
superfície de segurança (outro payload, outras condições de entrega de secret),
e por isso ficou documentada em vez de feita: o `workflow_run` atual já está
validado e a aula acontece antes da próxima janela de revisão.
