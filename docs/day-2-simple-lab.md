# Dia 2 — Laboratório simples de detecção de anomalias

No Dia 1 você aprendeu a fazer a IA **explicar um log**. O pipeline quebrava, o
agente lia o log e dizia o que tinha acontecido.

Hoje o assunto é outro, e é mais difícil: **nada quebrou.** Todos os testes
passam, o health check responde `200`, a aplicação está no ar — e mesmo assim
alguma coisa está diferente. É isso que a gente vai aprender a medir.

---

## 1. Falha e anomalia não são a mesma coisa

| | Falha | Anomalia |
| --- | --- | --- |
| O que é | Algo **parou de funcionar** | Algo **mudou de comportamento** |
| Como aparece | Erro, exceção, HTTP 500, teste vermelho | Nada disso: continua HTTP 200 |
| Quem percebe | O gate técnico, na hora | Só quem tinha uma medida de "antes" |
| Exemplo | `/api/report` devolve 500 | `/api/report` devolve 200 em 500 ms, quando devolvia em 4 ms |

Uma falha se anuncia sozinha. **Uma anomalia só existe em comparação com
alguma coisa.** Sem essa "alguma coisa", 500 ms é só um número: pode ser normal
para essa aplicação, pode ser um desastre. Não dá para saber olhando um número
só.

Essa "alguma coisa" tem nome: baseline.

---

## 2. O que é uma baseline

**Baseline é o comportamento normal, medido.** Não é o comportamento que você
acha que é normal, nem o que estava na documentação: é o que a aplicação fez
quando você mediu, com um número em um arquivo.

Neste laboratório, a baseline mora em `reports/day-2/baseline.json` e tem esta
cara:

```json
{
  "sampleCount": 30,
  "route": "/api/report",
  "latencyP95Ms": 4.52,
  "logLinesPerRequest": 2,
  "createdAt": "2026-08-04T05:18:34.340Z",
  "commitSha": "local"
}
```

Três coisas para reparar:

- ela tem **data** e **commit**. Uma baseline sem isso vira folclore em duas
  semanas: ninguém lembra de quando é nem do que ela mediu;
- ela tem `sampleCount`. Uma medição de 3 requisições e uma de 30 não valem a
  mesma coisa;
- ela mede **duas** coisas. Só duas. Voltamos a isso já.

> **Baseline não é meta.** Ela não diz que 4,52 ms é rápido nem que é lento.
> Ela diz que **é o que essa aplicação faz**. Comparar contra ela é comparar a
> aplicação com ela mesma.

---

## 3. Os dois sinais deste laboratório

| Sinal | O que mede |
| --- | --- |
| `latencyP95Ms` | latência p95 de `GET /api/report` |
| `logLinesPerRequest` | linhas de log estruturado por requisição da mesma rota |

E só. O relatório mostra `requestCount`, `errorCount`, `latencyMinMs` e
`latencyMaxMs` como **contexto** — eles ajudam a entender o que aconteceu, mas
**não decidem** se houve anomalia.

Por que tão pouco? Porque cada métrica que decide precisa de baseline própria,
de regra própria e de explicação própria. Com 17 métricas, você não tem um
laboratório: tem um painel bonito que ninguém sabe ler e um alarme que todo
mundo aprende a ignorar. Comece com duas que você entende inteiramente.

---

## 4. Por que latência **p95**, e não média nem máximo

Imagine 30 requisições: 20 levaram 4 ms e 10 levaram 500 ms.

- **Média** = 169 ms. Parece "meio lento". A média **dilui** o problema: quanto
  mais requisições rápidas, mais o problema some. Você pode ter 10% dos usuários
  esperando meio segundo e uma média que continua parecendo aceitável.
- **Máximo** = 500 ms. Sempre acusa. E também acusa quando **uma** requisição
  infeliz demorou — a primeira do processo, uma pausa do coletor de lixo, o
  antivírus do notebook. O máximo transforma qualquer soluço em incidente.
- **p95** = 500 ms aqui, e 4 ms no caso em que só **uma** requisição demorou. É
  o valor abaixo do qual estão 95% das medições: enxerga a cauda sem ser refém
  de um ponto isolado.

Com 30 amostras, o p95 cai na **29ª** medição em ordem crescente. Ou seja: a
mais lenta de todas é descartada; **as duas mais lentas, não.** Um soluço não
dispara nada; um problema que atinge 1 em cada 3 requisições dispara.

---

## 5. Por que duas condições, e não uma

Cada sinal só acusa anomalia quando as **duas** condições valem ao mesmo tempo:

**Latência**

```
observedLatencyP95Ms >= baselineLatencyP95Ms * 3      (relativa)
observedLatencyP95Ms  - baselineLatencyP95Ms >= 150   (absoluta, em ms)
```

**Volume de log**

```
observedLogLinesPerRequest >= baselineLogLinesPerRequest * 3   (relativa)
observedLogLinesPerRequest  - baselineLogLinesPerRequest >= 5  (absoluta, em linhas)
```

Veja o que cada uma sozinha faria:

- **só a relativa:** a baseline é 2 ms, a medição deu 7 ms. São 3,5× — e são
  5 ms. Ninguém percebe 5 ms. Você acabou de criar um alarme que toca todo dia;
- **só a absoluta:** a aplicação normalmente responde em 900 ms e agora responde
  em 1.060 ms. São 160 ms a mais, mas o patamar é o mesmo. Alarme de novo.

Juntas, elas dizem uma frase só: **"mudou de patamar — e o tamanho da mudança
importa."**

### O que é um falso positivo

É o alarme que toca sem que nada tenha mudado de verdade.

Parece um problema pequeno. Não é. Um detector que dá falso positivo é
desligado — primeiro mentalmente ("ah, esse alerta sempre toca"), depois de
verdade. E aí, no dia em que o alarme está certo, ninguém olha. **Um detector
barulhento é pior que nenhum detector**, porque custa a mesma atenção e não
entrega confiança.

É por isso que as regras deste laboratório são conservadoras: elas preferem
deixar passar um desvio pequeno a acusar um desvio que não existe.

---

## 6. Como executar

### Passo 1 — medir o normal

```bash
npm run anomaly:baseline
```

O comando faz tudo sozinho: sobe a aplicação numa porta só dele (3102), espera
o `/api/health` responder, faz **5 requisições de aquecimento** (descartadas),
faz **30 requisições medidas**, calcula os dois sinais, encerra a aplicação e
grava `reports/day-2/baseline.json`.

> **Por que descartar o aquecimento?** A primeira requisição de um processo Node
> paga coisas que as outras não pagam: compilação do código quente, abertura de
> conexão, primeira passagem por cada middleware. Medi-la é medir a partida do
> carro, não a velocidade dele.

### Passo 2 — observar e comparar

```bash
npm run anomaly:check
# ou, apontando a baseline explicitamente:
npm run anomaly:check -- --baseline reports/day-2/baseline.json
```

Mede de novo, compara com a baseline, chama a explicação e grava quatro
arquivos em `reports/day-2/`:

| Arquivo | Para quê |
| --- | --- |
| `observation.json` | o que foi medido agora |
| `anomaly-report.json` | o resultado completo, para ler com código |
| `anomaly-report.md` | o mesmo relatório, para ler no editor ou no GitHub |
| `anomaly-report.html` | o mesmo relatório, para abrir no navegador |

Logo depois da baseline, o resultado tem que ser `anomalyDetected: false`. Você
mediu a mesma aplicação duas vezes — se acusar anomalia aí, o problema é a
regra, não o código.

### Passo 3 — ver uma anomalia acontecer

```bash
npm run anomaly:demo -- latency      # anomalyType: latency
npm run anomaly:demo -- noisy-logs   # anomalyType: log-volume
```

Estes comandos sobem a aplicação com `DEMO_ANOMALY_MODE` ligado:

- **`latency`** — a cada terceira requisição de `/api/report`, a aplicação
  espera 500 ms antes de responder. Continua devolvendo `200`, e `/api/health`
  continua rápido;
- **`noisy-logs`** — a cada terceira requisição, a aplicação emite 18 linhas de
  log a mais (`eventType: demo.anomaly.noisy-log`). A resposta não muda.

Repare no que **não** acontece nos dois casos: nenhum erro, nenhum 500, nenhum
teste vermelho. É exatamente esse o ponto do dia.

### Sem subir nada: os cenários offline

```bash
npm run anomaly:fixture -- normal
npm run anomaly:fixture -- latency
npm run anomaly:fixture -- noisy-logs
npm run anomaly:fixture -- all
```

Os números vêm de arquivos versionados em `samples/day-2-anomalies/`. Nada sobe,
nada sai pela rede, o resultado é sempre o mesmo. Servem para estudar a regra
sem depender de máquina, de rede ou de chave de API.

---

## 7. Como ler o relatório

O relatório tem nove seções, sempre na mesma ordem. Leia nesta ordem — ela foi
montada assim de propósito:

1. **Resultado** — os quatro campos que importam:
   `anomalyDetected`, `anomalyType`, `firstAnomalousSignal`, `gateResult`;
2. **Sinal analisado** — a tabela com baseline, observado, diferença e razão dos
   **dois** sinais. O que não disparou também aparece: saber que a latência está
   normal faz parte do diagnóstico;
3. **Baseline** — com o que você está comparando, e de quando;
4. **Valor observado** — o que foi medido agora, mais o contexto;
5. **Regra aplicada** — as duas condições de cada sinal, com ✅ ou ⬜ em cada
   uma. **É a seção mais importante do relatório:** ela mostra a conta, não só o
   resultado dela;
6. **Evidências dos logs** — os trechos reais que sustentam o número;
7. **Explicação** — o texto. Diz na primeira linha de onde veio: `OpenAI` ou
   `fallback determinístico`;
8. **Ações recomendadas** — o que fazer, na ordem;
9. **Limitações** — o que esta medição **não** prova.

### Quem decide o quê

Esta é a regra mais importante do dia:

> **A detecção é determinística. A IA explica — não decide.**

`anomalyDetected`, `anomalyType`, `firstAnomalousSignal` e `gateResult` saem das
regras da seção 5. A IA recebe esses valores **já calculados** e escreve o texto
em volta. Ela não pode virar um `false` em `true`, nem o contrário — o campo
sequer existe no formato de resposta que ela é obrigada a seguir.

Por que tanto cuidado? Porque um modelo de linguagem é excelente em escrever
uma explicação convincente para **qualquer** conclusão, inclusive uma errada. Se
ele decidisse, você não teria um detector: teria uma opinião muito bem escrita.

**Sem `OPENAI_API_KEY`, o laboratório funciona igual.** A explicação vem de
regras em vez do modelo, o relatório é gerado do mesmo jeito e a detecção é
exatamente a mesma. A linha final do comando diz qual dos dois foi usado:

```
Explicação: OpenAI
Explicação: fallback determinístico — OPENAI_API_KEY não configurada
```

---

## 8. Como confirmar que normalizou

Depois de corrigir o que causou a anomalia:

```bash
npm run anomaly:check
```

A correção só está pronta quando o relatório disser:

```
anomalyDetected . false
gateResult ...... pass
```

Três armadilhas para não cair:

1. **Não altere a baseline para o alarme parar.** É a versão técnica de quebrar
   o termômetro porque a febre incomodou. Se a baseline realmente estava errada,
   meça de novo **e diga que fez isso** — mudar em silêncio o critério é como se
   perde a confiança de um time inteiro num detector;
2. **Meça duas vezes.** Uma medição é uma medição; duas medições iguais são um
   resultado. A sua máquina não está sozinha: compilação, navegador aberto,
   outro container rodando — tudo isso entra na conta;
3. **Confira o `firstAnomalousSignal`, não só o `anomalyDetected`.** Se você
   corrigiu a latência e agora o volume de log disparou, o alarme continua
   tocando por outro motivo — e é outro problema.

---

## 9. O que este laboratório **não** é

Não é uma plataforma de observabilidade. Não tem banco de dados, dashboard,
alerta externo, série temporal nem estatística avançada. Não guarda histórico:
cada execução compara **uma** observação com **uma** baseline.

E, principalmente: a medição é de laboratório. 30 requisições sequenciais na sua
máquina, sem tráfego concorrente. Isso mostra **mudança de comportamento**, que
é o que a gente quer ensinar. Não mostra capacidade em produção, e o relatório
declara essa limitação em toda execução — de propósito.

Um laboratório honesto sobre os próprios limites ensina mais que um painel que
promete o que não pode entregar.

---

## Resumo dos comandos

```bash
npm run anomaly:baseline                 # mede o normal
npm run anomaly:check                    # observa e compara
npm run anomaly:demo -- latency          # anomalia de latência
npm run anomaly:demo -- noisy-logs       # anomalia de volume de log
npm run anomaly:fixture -- all           # os três cenários, offline
npm run test:day2                        # os testes do Dia 2
```

Opções úteis: `--port 3103` (se a 3102 estiver ocupada), `--out <dir>`,
`--requests <n>`, `--warmup <n>`, `--fail-on-anomaly` (encerra com código 1
quando detecta — útil em automação; por padrão o comando sempre sai com 0).
