# Dia 2 — Desafio: injete, detecte, explique, corrija

Leia antes o [laboratório do Dia 2](day-2-simple-lab.md). Aqui a gente usa o que
está lá.

O desafio tem **duas rodadas**. Na primeira, o Grupo A esconde uma anomalia e o
Grupo B tem que encontrá-la. Na segunda, trocam os papéis. Ninguém fica só
inventando problema, e ninguém fica só apanhando.

---

## O ponto de partida: a tag `day-2-baseline`

Toda branch do desafio nasce da tag `day-2-baseline`. É ela que garante que os
dois grupos estão medindo a **mesma** aplicação — sem isso, o Grupo B pode
passar meia hora perseguindo uma diferença que veio do commit de outra pessoa.

```bash
# uma vez, pelo instrutor:
git tag day-2-baseline
```

```bash
# cada grupo, no início da sua rodada:
git checkout -b desafio/grupo-a day-2-baseline
npm ci
npm run anomaly:baseline          # a baseline nasce da aplicação limpa
```

> A baseline é medida **antes** de qualquer alteração. Uma baseline medida
> depois da anomalia já contém a anomalia — e nada mais dispara.

---

## Regras do desafio

### Para quem injeta

- **Tipos permitidos, só estes dois:**
  - **atraso periódico** — a rota espera de vez em quando;
  - **excesso de logs** — a rota emite linhas demais.
- A aplicação **continua funcional**: nada de HTTP 500, nada de exceção, nada de
  travar.
- **`/api/health` continua respondendo `200`**, e rápido.
- Os testes continuam passando (`npm test`).
- Não vale alterar:
  - o **detector** (`automation/src/simple-anomaly-detector.mjs`);
  - a **baseline** (`reports/day-2/baseline.json`);
  - o **relatório** (`automation/src/simple-anomaly-report.mjs`,
    `simple-anomaly-explainer.mjs`, `simple-anomaly-lab.mjs`);
  - os **testes**.
- Não vale usar `DEMO_ANOMALY_MODE`. Isso é a demonstração pronta; aqui o
  trabalho é escrever a sua.
- A alteração vai no código da aplicação (`backend/src/…`) e cabe em poucas
  linhas. Se ficou grande, provavelmente virou uma falha, não uma anomalia.

### Para quem investiga

- **Nos primeiros oito minutos, `git diff` está proibido** — e também
  `git log -p`, `git show` e abrir a branch no editor procurando a linha
  vermelha. Nesses oito minutos, use **só**:
  - `npm run anomaly:check`;
  - o relatório gerado em `reports/day-2/`;
  - os logs da aplicação;
  - `curl` na rota, se quiser.
- Depois dos oito minutos, vale tudo, inclusive `git diff`.
- **A correção só termina quando `npm run anomaly:check` disser
  `anomalyDetected: false` e `gateResult: pass`.**
- Corrigir **não é** ajustar a baseline nem afrouxar a regra. É desfazer o que
  mudou o comportamento.

> **Por que os oito minutos?** Porque em produção não existe `git diff` do
> incidente. Existe um gráfico estranho, um relatório e uma pergunta: "o que
> mudou?". Esses oito minutos são o único momento do curso em que você treina
> responder isso a partir de **evidência**, e não a partir do código-fonte. Vale
> mais que a correção em si.

---

## Rodada 1 — Grupo A injeta, Grupo B investiga

### Etapa 1 · Grupo A injeta (10 minutos, sozinhos)

```bash
git checkout -b desafio/grupo-a day-2-baseline
npm run anomaly:baseline           # confirme: anomalyDetected false no check seguinte
```

Escolham **um** tipo (atraso periódico ou excesso de logs) e implementem.
Confirmem, antes de entregar:

```bash
npm run anomaly:check              # tem que acusar: anomalyDetected true
npm test                           # tem que continuar verde
curl -s localhost:3102/api/health  # (durante uma medição) tem que responder 200
```

Se o `check` **não** acusou, a anomalia ficou pequena demais — releia as duas
condições da regra na seção 5 do laboratório. Se `npm test` ficou vermelho,
vocês criaram uma falha, não uma anomalia.

Entreguem a branch ao Grupo B **sem contar o que fizeram** — nem o tipo.

### Etapa 2 · Grupo B investiga (8 minutos, sem `git diff`)

```bash
git checkout desafio/grupo-a
npm ci
npm run anomaly:check -- --baseline reports/day-2/baseline.json
```

Respondam, por escrito, antes de olhar o código:

1. Houve anomalia? (`anomalyDetected`)
2. Qual sinal disparou? (`firstAnomalousSignal`)
3. Quais regras foram acionadas? (seção 5 do relatório)
4. O que as **evidências** mostram? (seção 6 — trechos de log, não achismo)
5. Qual a hipótese de vocês para a causa?
6. Onde vocês procurariam no código, e por quê?

Só depois disso, abram o diff.

### Etapa 3 · Grupo B corrige

```bash
git checkout -b desafio/grupo-a-correcao
# corrige
npm run anomaly:check
```

Pronto quando:

```
anomalyDetected . false
gateResult ...... pass
```

### Etapa 4 · Conversa (5 minutos)

- A hipótese do Grupo B, escrita antes do diff, estava certa?
- A explicação do relatório ajudou ou atrapalhou?
- A anomalia teria sido percebida em produção sem baseline? Como?

---

## Rodada 2 — Grupo B injeta, Grupo A investiga

Exatamente as mesmas etapas, com os papéis trocados:

```bash
git checkout -b desafio/grupo-b day-2-baseline
```

Uma regra a mais: **o tipo tem que ser o outro.** Se o Grupo A usou atraso
periódico na rodada 1, o Grupo B usa excesso de logs — e vice-versa. Assim os
dois grupos passam pelos dois sinais.

---

## Ficha de avaliação

Vale mais quem investiga bem do que quem esconde bem.

| Critério | Peso |
| --- | --- |
| A anomalia respeitou as regras (funcional, health OK, testes verdes) | 1 |
| A investigação respondeu às 6 perguntas **antes** do `git diff` | 3 |
| A hipótese estava fundamentada nas evidências do relatório | 3 |
| A correção zerou o alarme sem tocar na baseline nem na regra | 2 |
| O grupo soube explicar por que a regra tem duas condições | 1 |

---

## Erros comuns (e o que eles ensinam)

| O que acontece | O que aprender |
| --- | --- |
| A anomalia não é detectada | O desvio tem que passar nas **duas** condições. +4 linhas de log por requisição não passa na regra absoluta (≥ 5) |
| `npm test` fica vermelho | Isso é falha, não anomalia. Anomalia não quebra teste — é exatamente por isso que ela é difícil |
| O grupo mexe na baseline para o alarme parar | Quebrar o termômetro não baixa a febre. E, num time, é assim que um detector perde a confiança de todo mundo |
| O grupo olha o `git diff` no primeiro minuto | Pulou o único exercício que não dá para fazer em produção |
| O `check` acusa mesmo na branch limpa | A baseline foi medida com a aplicação já alterada, ou a máquina estava ocupada. Meça de novo, com o notebook parado |
| A porta 3102 está ocupada | Tem um `npm run dev` aberto, ou uma medição anterior não encerrou. Use `-- --port 3103` |
