# Dia 1 — Como demonstrar os cinco cenários

Guia de quem vai conduzir a aula. Explica como provocar, ao vivo, cada um dos
cinco cenários do Dia 1 — e como voltar tudo ao lugar depois.

> **Regra que atravessa o documento inteiro:** nenhuma branch com código
> propositalmente quebrado entra na `main`. A `main` é o que o Railway implanta.

---

## Os cinco cenários

| # | Cenário | Onde acontece | `firstFailedStage` | Gate |
| - | ------- | ------------- | ------------------ | ---- |
| 1 | `success` | `main` | `null` | `cd` aprovado |
| 2 | `ci-lint-failure` | branch temporária | `ci_quality` | `ci` reprovado |
| 3 | `ci-tests-failure` | branch temporária | `ci_tests` | `ci` reprovado |
| 4 | `ci-docker-failure` | branch temporária | `ci_docker` | `ci` reprovado |
| 5 | `cd-functional-failure` | ambiente isolado (`staging-lab`) | `functional` | `cd` reprovado |

---

## Antes de qualquer coisa: ensaie offline

Os cinco cenários rodam **sem GitHub, sem Railway, sem OpenAI e sem internet**,
a partir de material versionado em `samples/pipeline-executions/`:

```bash
npm run pipeline:fixture -- success
npm run pipeline:fixture -- ci-lint-failure
npm run pipeline:fixture -- ci-tests-failure
npm run pipeline:fixture -- ci-docker-failure
npm run pipeline:fixture -- cd-functional-failure
```

Cada comando grava:

```text
reports/pipeline-execution-report.json
reports/pipeline-execution-report.md
reports/pipeline-execution-report.html      ← abra este
```

E, com o mesmo conteúdo, os aliases `operational-deployment-report.*`.

Abra o HTML:

```bash
xdg-open reports/pipeline-execution-report.html   # Linux
open     reports/pipeline-execution-report.html   # macOS
```

**A fixture nunca chama a OpenAI**, mesmo que `OPENAI_API_KEY` exista no
`.env` da máquina. Para habilitar a chamada de propósito:

```bash
PIPELINE_FIXTURE_USE_OPENAI=true npm run pipeline:fixture -- cd-functional-failure
```

---

## Cenário 1 — Execução saudável (`main`)

Nada a provocar: é o fluxo normal.

1. Faça um merge comum na `main` (ou dispare **Post-deploy validation** por
   `workflow_dispatch`).
2. Aguarde CI → Railway → **Post-deploy validation**.
3. Baixe o artefato `pipeline-execution-report-<sha>` (ou
   `operational-deployment-report-<sha>`, mesmo conteúdo).

**O que mostrar:** o relatório é **curto**. Linha do tempo toda verde, um resumo
de uma ou duas frases, cobertura das fontes, limitações e a decisão do gate. Sem
causa provável, sem recomendações, sem alerta inventado.

> Pergunta para a turma: *o log verde tem `ECONNREFUSED` e `HTTP 502` nas
> primeiras tentativas. Por que nenhuma dessas linhas virou evidência de
> problema?*

---

## Cenário 2 — Falha de lint

**Patch conceitual** — uma variável declarada e nunca usada, em
`backend/src/services/report.js`:

```diff
 export function buildReport(stickers) {
+  const totalDuplicates = stickers.length;
   const registered = stickers.filter((sticker) => sticker.quantity > 0);
```

Passo a passo:

```bash
git switch -c demo/ci-lint-failure
# aplique a alteração acima
git add backend/src/services/report.js
git commit -m "demo: viola no-unused-vars para a aula"
git push -u origin demo/ci-lint-failure
# abra a Pull Request para main — NÃO faça merge
```

**No relatório:** `✗ FAILURE Lint`, `firstFailedStage: ci_quality`, e os fatos
citam **o arquivo e a regra** (`no-unused-vars`). As etapas de Railway em diante
aparecem como `— NOT REACHED`: o deployment não começou.

> Observação honesta: `tests`, `build` e `docker-build` rodam **em paralelo** com
> `quality` neste repositório. Eles continuam `✓ SUCCESS` no relatório, porque
> foi isso que aconteceu. O relatório não inventa "não alcançado" para um job que
> rodou e passou.

---

## Cenário 3 — Falha de teste

**Patch conceitual** — uma expectativa incorreta em `backend/test/report.test.js`:

```diff
-    expect(report.duplicateCopies).toBe(3);
+    expect(report.duplicateCopies).toBe(4);
```

```bash
git switch -c demo/ci-tests-failure
# aplique a alteração
git commit -am "demo: expectativa incorreta para a aula"
git push -u origin demo/ci-tests-failure
```

**No relatório:** `✓ Lint`, `✗ Testes`, `firstFailedStage: ci_tests`. Os fatos
trazem **a expectativa e o valor observado** (`expected 3 to be 4`) e o arquivo
do teste.

> Pergunta para a turma: *o lint passou e o teste falhou. Qual é a diferença
> entre "o código está bem escrito" e "o código faz o que se espera dele"?*

---

## Cenário 4 — Falha de build da imagem

**Patch conceitual** — um `COPY` apontando para um caminho que não existe, no
`Dockerfile`:

```diff
-COPY --from=build /app/frontend/dist ./frontend/dist
+COPY --from=build /app/frontend/build ./frontend/dist
```

```bash
git switch -c demo/ci-docker-failure
# aplique a alteração
git commit -am "demo: caminho COPY inexistente para a aula"
git push -u origin demo/ci-docker-failure
```

**No relatório:** `✓ Lint`, `✓ Testes`, `✓ Build`, `✗ Docker`,
`firstFailedStage: ci_docker`. Os fatos citam o **caminho ausente**
(`/app/frontend/build: not found`).

> Pergunta para a turma: *`npm run build` passou e a imagem não nasceu. O que o
> `docker-build` verifica que os outros três jobs não verificam?*

---

## Cenário 5 — Falha funcional pós-deployment

Este é o único que **não** se demonstra provocando falha em produção.

**Nunca** quebre a aplicação publicada para demonstrar o CD. Faça em um serviço
isolado — `staging-lab` —, com domínio próprio e `APP_BASE_URL` apontando para
ele.

**Patch conceitual** — a rota funcional passa a acessar uma propriedade de um
objeto que pode não existir:

```diff
-  const registered = stickers.filter((sticker) => sticker.quantity > 0);
+  const registered = stickers.filter((sticker) => sticker.stats.quantity > 0);
```

O resultado: `/api/health` continua respondendo **200** (o processo está vivo) e
`/api/report` passa a responder **500** com um `TypeError`.

**Nesta tarefa o `staging-lab` não foi criado nem configurado.** Quando for:

1. crie um serviço separado no Railway, com domínio público próprio;
2. aponte `APP_BASE_URL` (variável do repositório, ou uma variável de ambiente do
   workflow) para esse domínio;
3. implante ali a branch com a alteração;
4. dispare **Post-deploy validation** por `workflow_dispatch`;
5. desfaça tudo (ver *Restaurar a baseline*).

Enquanto isso, use a fixture — ela reproduz o cenário byte a byte:

```bash
npm run pipeline:fixture -- cd-functional-failure
```

**No relatório:** `✓ Health check`, `✗ Rota funcional`, `✗ Smoke test`,
`✗ CD Gate`, `firstFailedStage: functional`. A explicação distingue
**processo ativo** de **funcionalidade quebrada**, e relaciona a evidência
externa (`HTTP 500` visto pelo smoke test) com a interna
(`functional.report.failed` com o `TypeError`).

---

## Onde baixar o relatório

| Falhou em | Workflow | Artefato |
| --------- | -------- | -------- |
| CI (lint, testes, build, Docker) | **CI** | `pipeline-execution-report-<sha>` |
| CD (Railway, runtime, smoke test) | **Post-deploy validation** | `operational-deployment-report-<sha>` **ou** `pipeline-execution-report-<sha>` |

Nos dois casos há um resumo curto no **Job Summary** da execução, com o link
direto para o artefato. Abra `pipeline-execution-report.html` no navegador.

---

## Como identificar a primeira falha

No relatório, três lugares dizem a mesma coisa — e é a mesma fonte:

1. a linha marcada com **`primeira falha`** na linha do tempo;
2. o campo `firstFailedStage` no JSON;
3. o título **Etapa afetada** dentro de *Explicação da falha*.

Ela é escolhida por **regra**, percorrendo as etapas na ordem real do pipeline e
devolvendo a primeira com `failure`. `SKIPPED`, `NOT REACHED` e `UNKNOWN` não
contam como falha. O modelo não participa dessa escolha — e é por isso que ela
não muda quando o modelo muda de opinião.

---

## Como avaliar a explicação da IA

Cinco perguntas, na ordem:

1. **Ela cita fatos que existem?** Todo `[FATO]` deve poder ser localizado no
   log bruto. Se não dá para apontar a linha, não é fato.
2. **A causa está separada do sintoma?** "O health check não passou" é sintoma —
   está presente em toda falha por definição. Procure o campo *força da
   afirmação*.
3. **As ações servem só para este erro?** Uma recomendação que serviria para
   qualquer falha de qualquer projeto não é uma recomendação.
4. **Ela diz o que não sabe?** Procure *Limitações* e *Cobertura das fontes*.
5. **Ela relaciona fontes diferentes?** Ligar o `HTTP 500` do smoke test ao
   `TypeError` do log interno é explicar. Repetir a última linha do log com
   outras palavras é reescrever.

E a pergunta que fecha o dia:

> Se o modelo tivesse escrito "está tudo bem", o deployment teria sido aprovado?

A resposta está no YAML: `cd-gate` declara `needs: [post-deploy-smoke-test]` e
nada mais; `ci-gate` decide pelos exit codes de `quality`, `tests`, `build` e
`docker-build`. Nenhum dos dois lê o relatório.

---

## Restaurar a baseline

Depois de cada demonstração:

```bash
# 1. volte para a main intacta
git switch main
git pull --ff-only

# 2. confirme que nada da demonstração ficou no working tree
git status --short          # precisa sair vazio
git diff --check

# 3. apague a branch temporária, local e remota
git branch -D demo/ci-lint-failure
git push origin --delete demo/ci-lint-failure

# 4. feche a Pull Request SEM merge (pela interface do GitHub)
```

Se a demonstração envolveu o `staging-lab`, implante nele novamente o commit da
`main` antes de encerrar.

**Nunca**, em nenhum dos cinco cenários:

- `git push --force` (em branch nenhuma);
- merge de branch de demonstração na `main`;
- alteração de secret (`OPENAI_API_KEY`, `RAILWAY_TOKEN`) ou de variável de
  produção;
- provocar falha no serviço de produção para demonstrar o CD.

---

## Checklist do instrutor

- [ ] as cinco fixtures rodaram offline antes da aula;
- [ ] `git status --short` está vazio;
- [ ] a `main` está no commit da baseline;
- [ ] nenhuma branch `demo/*` sobrou (local ou remota);
- [ ] nenhuma Pull Request de demonstração ficou aberta;
- [ ] `APP_BASE_URL` voltou a apontar para o serviço correto.
