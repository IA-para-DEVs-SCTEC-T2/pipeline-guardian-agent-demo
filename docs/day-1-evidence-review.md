# Dia 1 — Revisão de evidências (20 a 30 min)

Atividade individual, **não competitiva** e sem pontuação. O objetivo é um só:

> Separar o que a IA **observou** do que ela **deduziu** — e perceber quando ela
> apenas reescreveu o log em vez de explicá-lo.

Não há resposta única. Duas pessoas podem discordar sobre uma inferência e as
duas estarem certas, desde que consigam apontar em que fato se apoiam.

---

## O que você recebe

1. **Um log bruto selecionado** — `reports/evidence/ci/tests.log`,
   `reports/railway/runtime.jsonl` ou `reports/deployment.log`.
2. **O relatório HTML** — `pipeline-execution-report.html`, do artefato
   `pipeline-execution-report-<sha>` (falha de CI: workflow **CI**; falha de CD:
   workflow **Post-deploy validation**, onde ele também sai como
   `operational-deployment-report-<sha>`).
3. **O diagnóstico da IA** — as seções *Explicação da falha*, *Fatos observados*,
   *Inferências*, *Causa provável*, *Recomendações* e *Limitações* do mesmo
   relatório.

Sem acesso ao GitHub Actions? Gere tudo localmente, sem Railway e sem OpenAI:

```bash
npm run pipeline:fixture -- cd-functional-failure
open reports/pipeline-execution-report.html
```

Os outros quatro cenários: `success`, `ci-lint-failure`, `ci-tests-failure` e
`ci-docker-failure`.

---

## Antes de começar: as quatro categorias

O relatório separa quatro coisas que costumam vir misturadas. A atividade
inteira depende de você conseguir distinguí-las:

| Categoria         | Como reconhecer                                              | No relatório |
| ----------------- | ------------------------------------------------------------ | ------------ |
| **Fato**          | Está **literalmente** no log. Dá para apontar a linha.       | `[FATO]`     |
| **Hipótese**      | **Não** está no log. Alguém deduziu a partir dos fatos.       | `[INFERÊNCIA]`, `[EXPLICAÇÃO]` e `[CAUSA PROVÁVEL]` |
| **Recomendação**  | Uma ação a executar. Não é verdadeira nem falsa — é útil ou não. | `[AÇÃO RECOMENDADA]` e `[RECOMENDAÇÃO]` |
| **Limitação**     | O que **não** foi possível verificar, e por quê.              | `[LIMITAÇÃO]` |

Uma quinta coisa não é nenhuma das quatro e vem antes de todas: a **linha do
tempo da execução**, com a etapa marcada como `primeira falha`. Ela não é
opinião da IA — é resultado de regra, a partir dos exit codes dos jobs e dos
códigos HTTP. É o ponto fixo contra o qual você vai avaliar tudo o que a IA
escreveu.

> ⚠️ O teste decisivo: se você **não consegue apontar a linha do log**, não é
> fato. Por mais convincente que a frase seja.

---

## As sete tarefas

Responda em um arquivo de texto, um bloco de notas ou no papel.

### 1. Três fatos comprovados (5 min)

Escolha **três** itens da seção *Fatos observados* e, para cada um, localize o
trecho correspondente no log bruto.

| # | ID do fato | Fonte | Onde encontrei no log bruto |
| - | ---------- | ----- | --------------------------- |
| 1 |            |       |                             |
| 2 |            |       |                             |
| 3 |            |       |                             |

Se não achar um deles no log, **isso é a resposta** — anote e siga.

### 2. Duas inferências (3 min)

Copie **duas** afirmações da seção *Inferências*.

### 3. Quais fatos sustentam cada inferência (5 min)

Para cada inferência da tarefa 2, liste os IDs em *Sustentada pelos fatos*. Em
seguida, responda para cada uma:

- Os fatos citados **realmente** sustentam a afirmação?
- Ou eles apenas *acompanham* a afirmação, sem prová-la?

> 💬 Exemplo da diferença: "`/api/health` respondeu 200" **sustenta** "o
> processo está em execução". Mas "`/api/report` respondeu 500" **não sustenta**
> "há um erro no banco de dados" — não há banco neste projeto, e nada no log
> fala em banco.

### 4. Uma conclusão não sustentada (5 min)

Procure no relatório **uma** afirmação que:

- não esteja marcada como `[FATO]`, **e**
- não aponte fatos suficientes para se sustentar.

Anote-a. **Pode não existir** — o agente remove inferências sem apoio antes de
publicar. Se você não encontrar nenhuma, escreva "não encontrei" e explique
como você procurou. Não encontrar é um resultado legítimo.

### 5. Uma informação que está faltando (3 min)

O que você precisaria saber para ter certeza da causa, e que **não** está no
relatório?

Comece pela seção *Cobertura das fontes*: alguma fonte está `ausente`? E pela
seção *Limitações*: o que o relatório já admite não saber?

### 6. Uma ação melhor ou mais específica (5 min)

Escolha **uma** das *Recomendações* e reescreva-a de forma mais acionável.

| Vago                              | Específico                                      |
| --------------------------------- | ----------------------------------------------- |
| "Verificar os logs"               | "Abrir `runtime.jsonl` e localizar o `requestId` do primeiro evento `functional.report.failed`" |
| "Corrigir o erro"                 | "Cobrir com teste o caso em que uma figurinha chega sem `quantity`" |

### 7. A pergunta do dia (4 min)

> **A IA explicou o log ou apenas reescreveu o log?**

Justifique com evidência do próprio relatório. Alguns sinais que ajudam:

**Sinais de que apenas reescreveu:**

- o resumo repete a última linha do log com outras palavras;
- a "causa provável" é o sintoma dito de novo ("falhou porque não passou");
- as recomendações serviriam para qualquer falha, de qualquer projeto.

**Sinais de que explicou:**

- relaciona duas fontes diferentes (ex.: o `HTTP 500` do smoke test **com** o
  `TypeError` do log interno da aplicação);
- distingue sintoma de causa;
- diz o que **não** dá para afirmar com o material disponível.

---

## Fechamento (5 min, em conjunto)

Três perguntas para a turma:

1. Alguém encontrou uma conclusão não sustentada? Qual?
2. O relatório em algum momento afirmou "causa raiz confirmada" a partir de um
   sintoma? (Procure o campo *força da afirmação*.)
3. Se o modelo tivesse dito **"está tudo bem"** neste relatório, o deployment
   teria sido aprovado?

> A resposta da 3 está no job `cd-gate`: ele lê **apenas**
> `needs.post-deploy-smoke-test.result`. O relatório da IA não entra na
> decisão — nem para aprovar, nem para reprovar.

---

## O que esta atividade **não** é

Para evitar confusão com os próximos dias:

- não é uma competição, e não há placar;
- não envolve comparar esta execução com outras nem calcular padrão — isso é
  assunto do **Dia 2**;
- não envolve olhar o histórico nem estimar o que pode acontecer depois — isso é
  assunto do **Dia 3**;
- não envolve corrigir o código, fazer rollback nem promover ambiente.

Hoje o material é **uma** execução e os logs dela. É por isso que nenhuma
pergunta desta atividade pede para comparar com "o normal": nada aqui sabe o que
é o normal, e o relatório não finge saber.

Hoje o exercício é de **leitura**: distinguir fato de hipótese num relatório
gerado automaticamente. É a habilidade de que tudo o que vem depois depende.
