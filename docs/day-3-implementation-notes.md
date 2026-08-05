# Dia 3 — laboratório de previsão de falhas

Notas técnicas do ambiente. O material didático completo é entregue à parte;
aqui está o que alguém precisa saber para **operar, validar e evoluir** o
laboratório.

## Objetivo

Mostrar a diferença entre **explicar** o que já aconteceu (Dia 1), **detectar**
o que está acontecendo (Dia 2) e **prever** o que vai acontecer (Dia 3) — com um
modelo estatístico pequeno o bastante para caber numa tela.

A divisão de trabalho é o assunto da aula:

| Quem | O que produz |
| :--- | :--- |
| Regressão logística | `failureProbability`, `predictedFailure`, `threshold`, `topFactors` |
| IA generativa | `summary`, `evidence`, `interpretation`, `recommendedActions`, `limitations` |

A IA generativa **não** consegue alterar nenhum número, e a garantia não é o
prompt: `modelPredictionExplanationSchema`
(`automation/schemas/day-3-prediction-schema.mjs`) não tem esses campos. O
structured output não pode devolver o que o schema não declara.

## Alvo e horizonte

- **Alvo:** `failureWithinNext2Windows`.
- **Horizonte:** as **duas** janelas seguintes, e só elas.

Uma janela é **falha** quando pelo menos uma condição é verdadeira:

- `errorRate >= 0.50`
- `latencyP95Ms >= 1500`
- `healthFailure === true`

Duas decisões que valem para quem for mexer nisso:

- **Horizonte incompleto vira `null`, não `0`.** As últimas janelas de cada
  sequência não têm duas janelas à frente para observar. Chamá-las de "não vai
  falhar" seria inventar um negativo a partir da ausência de dado. A exceção é
  quando a parte observável já contém uma falha: aí a resposta não depende do
  que falta, e o rótulo é `1`.
- **Janela já em falha não é exemplo de treino.** Prever o que já aconteceu não
  é previsão — e, na prática, os valores extremos dessas janelas inflavam o
  desvio padrão a ponto de o modelo só acender depois da falha.

## Baseline operacional

Fixa, didática e declarada em todo relatório: latência p95 **12 ms**, taxa de
erro **0**, **2** linhas de log por requisição.

## Features (sete, e só sete)

| # | Feature | O que é |
| ---: | :--- | :--- |
| 1 | `currentLatencyRatio` | latência p95 atual ÷ baseline |
| 2 | `latencySlope3` | inclinação da latência nas últimas 3 janelas |
| 3 | `currentErrorRate` | taxa de erro atual |
| 4 | `errorRateSlope3` | inclinação da taxa de erro nas últimas 3 janelas |
| 5 | `currentLogRatio` | logs por requisição ÷ baseline |
| 6 | `logSlope3` | inclinação dos logs nas últimas 3 janelas |
| 7 | `consecutiveDegradedWindows` | persistência da degradação |

**Nenhuma feature olha o futuro.** Toda função recebe a sequência e um índice, e
lê apenas `windows[0..index]`. O teste `day-3-features.test.mjs` prova isso
comparando as features de um prefixo idêntico com futuros opostos.

O **nome do padrão** que gerou a sequência nunca entra como feature. Se
entrasse, o modelo aprenderia a ler a etiqueta em vez do sinal.

**Degradação ≠ falha.** Os limites de degradação (latência ≥ 3× baseline **e**
≥ 150 ms de diferença; erro ≥ 0,15; logs ≥ 3× baseline **e** ≥ 5 linhas de
diferença) existem só para contar persistência. Cada um exige razão **e**
diferença absoluta, porque razão sozinha mente perto do zero: 6 linhas contra
uma baseline de 2 é o triplo, e não é degradação nenhuma.

## Inclinação

`linearSlope` é mínimos quadrados sobre índices igualmente espaçados. Com três
pontos o resultado é exatamente `(y2 - y0) / 2`; a forma geral está lá porque
também precisa responder para dois pontos (início da sequência). Positiva no
crescimento, negativa na recuperação, zero na estabilidade.

## Dados sintéticos

`synthetic-history.mjs` gera **80 sequências** (8 padrões × 10), de 7 a 10
janelas, a partir de um `mulberry32` semeado (`GENERATOR_SEED = 20260805`). Cada
sequência recebe a sua própria derivação da semente, então acrescentar um padrão
no fim da lista não desloca os números dos anteriores.

Quatro padrões terminam em falha (`latency-growth`, `error-growth`,
`log-then-latency`, `mixed-degradation`) e quatro não (`stable-normal`,
`transient-spike`, `moderate-noise`, `plateau-below-threshold`).

Os quatro negativos não são enfeite: sem `transient-spike` o modelo aprende que
"métrica alta = falha" e reprova todo pico passageiro; sem
`plateau-below-threshold` ele aprende que persistência sozinha basta.

## Divisão treino/teste

**Sequências inteiras, estratificadas por padrão**: dos 10 exemplares de cada
padrão, os 3 primeiros vão para o teste e os 7 restantes para o treino (56/24).

Janelas vizinhas compartilham quase todo o passado — a janela 4 e a 5 têm as
mesmas medições no cálculo da tendência. Sortear janelas colocaria parte do
passado do teste dentro do treino, e a métrica mediria memória, não previsão.

Média, desvio e limiar saem **apenas** do treino. Os identificadores dos dois
lados ficam registrados em `training-summary.json`.

## Regressão logística

JavaScript puro, sem dependência nova.

| Constante | Valor | Onde |
| :--- | ---: | :--- |
| `LEARNING_RATE` | `0.1` | `logistic-regression.mjs` |
| `MAX_ITERATIONS` | `8000` | idem (para sozinho quando a loss estabiliza) |
| `L2_LAMBDA` | `0.02` | idem |
| Inicialização | zeros | determinística, sem sorteio |

O valor de `L2_LAMBDA` **não** é decorativo. `currentLatencyRatio` e
`latencySlope3` são quase colineares numa rampa geométrica; com regularização
menor, o ajuste distribuía a informação de forma arbitrária entre as duas e
chegava a dar peso **negativo** ao nível de latência. A previsão continuava
certa e a tabela de pesos passava a dizer que latência alta reduz o risco. Num
laboratório cujo produto é a explicação, isso é pior que um ponto de F1.

Outros cuidados: `sigmoid` em dois ramos (estável em `±1e6`), desvio padrão zero
vira 1, probabilidades grampeadas antes do logaritmo, e `model.json` sem carimbo
de tempo — duas execuções da mesma semente produzem o arquivo byte a byte igual.

`topFactors` = `peso × valor padronizado`, ordenado pela magnitude absoluta. É
uma aproximação linear: as contribuições somam o **logit**, não a probabilidade,
e os relatórios dizem isso.

## Limiar e faixas

`threshold = 0.70`, constante declarada — nunca ajustada nos dados.

| Faixa | Probabilidade | Leitura |
| :--- | :--- | :--- |
| ● baixo | < 0,40 | observar |
| ▲ atenção | 0,40 – 0,69 | investigar |
| ■ provável | ≥ 0,70 | mitigar |

## Comandos

```bash
npm run day3:prepare                       # treina, avalia, grava modelo e painel
npm run day3:scenario -- latency-growth
npm run day3:scenario -- error-growth
npm run day3:scenario -- log-growth
npm run day3:scenario -- transient-spike
npm run day3:scenario -- all
npm run day3:challenge -- case-a           # sem desfecho
npm run day3:challenge:reveal -- case-a    # com desfecho
npm run day3:challenge -- case-a --mitigated
npm run test:day3
```

A CLI usa **exit code 0** em toda execução válida — inclusive quando a
probabilidade passa do limiar. Exit code diferente de zero significa erro de uso
(`2`) ou falha interna (`1`), nunca risco alto. Se o exit code virasse alarme,
qualquer `npm run` num cenário de falha passaria a "quebrar o build".

`scenario` e `challenge` treinam o modelo automaticamente quando `model.json`
não existe.

## Arquivos

```
automation/src/day3/
  synthetic-history.mjs   gerador determinístico das 80 sequências
  features.mjs            baseline, limites, inclinação, features e rótulo
  logistic-regression.mjs sigmoid, scaler, treino, inferência, contribuições
  evaluate.mjs            divisão 70/30, matriz de confusão, métricas, faixas
  predict.mjs             inferência por janela, desfecho, mitigação
  explain.mjs             chamada à OpenAI e fallback determinístico
  report.mjs              JSON, Markdown e HTML (SVG inline, sem biblioteca)
  run.mjs                 CLI

automation/schemas/day-3-prediction-schema.mjs   contrato do relatório
automation/prompts/day-3-prediction-explanation.md
samples/day-3/scenarios.json     os quatro cenários visuais
samples/day-3/challenges.json    os três casos (é o gabarito: entrega o final)
automation/tests/day-3-*.test.mjs
```

Saída (em `reports/day-3/`, que é ignorado pelo Git e regenerado por
`day3:prepare`):

```
training-summary.json
model.json
model-evaluation.html
scenarios/<cenário>/prediction.json | prediction-report.md | prediction-report.html
challenges/<caso>/prediction.json | prediction-report.md | prediction-report.html
challenges/<caso>/mitigated/prediction.json | prediction-report.md | prediction-report.html
```

## Desafios e mitigação

Um desafio mostra a sequência **até o ponto de decisão** e nada além. As janelas
seguintes existem em `samples/day-3/challenges.json`, mas não entram no
relatório: o desfecho não é calculado, e por isso não há de onde vazar. O
`reveal` recalcula com `revealed: true` e sobrescreve o mesmo relatório,
acrescentando: houve falha, primeira janela em falha, primeira janela acima do
limiar, antecedência e o resultado (TP/FP/TN/FN) no ponto de decisão.

`--mitigated` aplica um decaimento (fator `0.45` por janela) às métricas a partir
da janela de intervenção, **recalcula as features do zero** e consulta o modelo
de novo — nenhuma probabilidade é ajustada à mão. O relatório vai para
`challenges/<caso>/mitigated/` e o original fica intacto.

> A comparação da mitigação mostra a trajetória original completa. Rode-a
> **depois** do `reveal`.

## Sem `OPENAI_API_KEY`

O laboratório funciona inteiro. `explain.mjs` reusa o cliente, a configuração, o
timeout, o sanitizador e a categorização de erro do Dia 1; qualquer desvio (sem
chave, rede, timeout, 401, 429, resposta incompleta, saída fora do schema) cai no
**fallback determinístico**, que produz os cinco campos a partir dos mesmos
números. Os três formatos de relatório saem iguais, e `explanation.origin`
declara `openai` ou `fallback` — no JSON, no Markdown, no HTML e no terminal.

Nada identifica o cenário ou o caso no payload enviado ao modelo: sem `id`, sem
título, sem o padrão que gerou a sequência. Num desafio, o nome do caso é a
resposta.

## Limitações

- Os dados são **sintéticos**. As métricas medem o modelo neste laboratório, não
  a confiabilidade de uma previsão sobre um sistema real.
- O horizonte é de duas janelas. Nada aqui diz o que acontece depois.
- A regressão logística é **linear** no espaço padronizado: não captura interação
  entre features nem saturação.
- Ela mede **correlação entre séries**. Não observa código, configuração nem
  infraestrutura, e por isso nenhum relatório afirma causa confirmada.
- `recall` abaixo de 100% significa que existem falhas que o modelo não
  antecipa — em particular as que só se anunciam duas janelas antes.

## Como validar antes da aula

```bash
npm ci
npm run test:day3
npm run lint
npm run test
npm run build
npm run day3:prepare
npm run day3:scenario -- all
npm run day3:challenge -- case-a
npm run day3:challenge:reveal -- case-a
npm run day3:challenge -- case-a --mitigated
npm run day3:challenge -- case-b
npm run day3:challenge -- case-c
```

Depois, confira:

1. `reports/day-3/model-evaluation.html` abre e mostra matriz de confusão,
   métricas, pesos e distribuição;
2. os quatro cenários abrem e a curva de probabilidade sobe **antes** da janela
   em falha nos três progressivos, e cai depois da recuperação no
   `transient-spike`, sem passar do limiar;
3. `case-a` e `case-b` sem `--reveal` mostram "Ainda não revelado";
4. o `reveal` mostra TP e uma antecedência maior que zero;
5. a versão mitigada mostra a probabilidade final caindo;
6. nenhum relatório contém `NaN`, `Infinity` ou chave.

O passo 6 está coberto por teste (`day-3-report.test.mjs`), mas repetir a
inspeção depois de qualquer mudança de dado custa um `grep`.
