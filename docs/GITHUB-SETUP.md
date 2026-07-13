# GitHub Setup — CI do CopaFigurinhas

Este documento descreve como configurar o repositório no GitHub para que o
workflow [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) funcione, e
o que esperar de cada job.

## Secret: `OPENAI_API_KEY`

Opcional. Usado pelo job `diagnose` para que o Pipeline Guardian analise o
pipeline com um modelo (via `openai.responses.parse`), em vez de cair no
classificador determinístico.

Configuração: **Settings → Secrets and variables → Actions → Secrets → New
repository secret**

- Nome: `OPENAI_API_KEY`
- Valor: uma chave de API da OpenAI (`sk-...`)

Sem esse secret, o workflow **continua funcionando normalmente** — veja
[Comportamento com fallback](#comportamento-com-fallback).

## Variable: `OPENAI_MODEL`

Opcional. Nome do modelo usado na análise (ex.: `gpt-4.1-mini`). É uma
**variable**, não um secret, porque não é sensível.

Configuração: **Settings → Secrets and variables → Actions → Variables → New
repository variable**

- Nome: `OPENAI_MODEL`
- Valor: ex. `gpt-4.1-mini`

O agente só tenta usar o modelo quando **as duas** — `OPENAI_API_KEY` e
`OPENAI_MODEL` — estão presentes (`canUseModel`, em
`automation/src/analyze-pipeline.mjs`). Falta uma das duas, ou qualquer erro na
chamada (rede, chave inválida, saída fora do schema), e o agente cai no
fallback determinístico sem quebrar o pipeline.

## Workflow permissions

O workflow declara permissões mínimas no topo do arquivo:

```yaml
permissions:
  contents: read
  pull-requests: write
```

- `contents: read` — suficiente para `actions/checkout` e para ler o
  repositório; nenhum job precisa escrever no repositório (o agente **não**
  faz commit nem push).
- `pull-requests: write` — necessário para o job `diagnose` criar ou atualizar
  o comentário de diagnóstico na Pull Request via `GITHUB_TOKEN`.

Não é necessário nenhum Personal Access Token adicional: o `GITHUB_TOKEN`
automático do Actions, com essas permissões, já é suficiente para o comentário
de PR. Nenhum outro escopo (`issues`, `actions`, `packages` etc.) é concedido.

Se a organização/repositório tiver a permissão padrão do `GITHUB_TOKEN`
restrita a "somente leitura" nas configurações do repositório (**Settings →
Actions → General → Workflow permissions**), o bloco `permissions:` do
workflow já sobrescreve isso para este workflow especificamente — não é
necessário alterar a configuração global do repositório.

## Explicação dos jobs

O workflow roda em `pull_request` (para `main`) e em `push` (para `main`), com
cinco jobs:

### 1. `quality`

Executa `npm run lint`, salva a saída em `reports/lint.log` (via `tee`, com
`pipefail` para preservar o exit code do lint mesmo através do pipe) e publica
o log como artefato **mesmo se o lint falhar** (`if: always()` no upload). O
job então termina com falha se o lint falhou — o upload não mascara o erro.

### 2. `tests`

Mesma lógica do `quality`, para `npm run test` → `reports/tests.log`.

### 3. `build`

Mesma lógica do `quality`, para `npm run build` → `reports/build.log`.

`quality`, `tests` e `build` rodam em paralelo, cada um em sua própria
instância `ubuntu-latest`, com `actions/setup-node@v4` (Node 22, cache de
`npm`) e `npm ci`.

### 4. `diagnose`

Roda o **Pipeline Guardian** (workspace `automation`). Usa `needs: [quality,
tests, build]` e `if: always()` — ou seja, roda **sempre**, mesmo que os três
jobs anteriores tenham falhado, porque o diagnóstico é mais útil justamente
quando o pipeline quebrou.

Ele **não reexecuta** lint/test/build: baixa os logs já publicados como
artefato (`lint-log`, `tests-log`, `build-log`) para `reports/input/`, e lê o
resultado de cada job (`needs.quality.result`, `needs.tests.result`,
`needs.build.result`) para saber o que passou e o que falhou. Em eventos
`pull_request`, também calcula o diff entre a base e o head da PR e salva em
`reports/input/pr.diff`.

Com esse contexto — repositório, branch, commit, run id, evento e os
resultados de cada verificação —, ele chama
`automation/src/ci-diagnose.mjs`, que:

1. monta o "source" a partir dos logs/diff consolidados (sem rodar comandos de
   novo);
2. chama `analyzePipeline` (o mesmo pipeline usado por
   `npm run agent:analyze` / `npm run agent:fixture`): mascara segredos,
   classifica a falha, tenta o modelo (se configurado) com fallback
   determinístico, aplica a política de deploy;
3. grava `reports/diagnosis.json` e `reports/diagnosis.md`;
4. adiciona `diagnosis.md` ao **Job Summary** da execução;
5. publica `diagnosis.json`, `diagnosis.md` (e `pr.diff`, quando existir) como
   artefatos;
6. cria ou atualiza o comentário de diagnóstico na Pull Request (só em eventos
   `pull_request`), usando o marcador HTML `<!-- pipeline-guardian -->`
   (definido em `automation/src/render-report.mjs`) para localizar e atualizar
   um comentário existente em vez de duplicá-lo a cada execução.

O `GITHUB_TOKEN` é passado à etapa **apenas como variável de ambiente** do
processo (`env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`); nunca aparece em
argumento de linha de comando nem é escrito em log — `redact-secrets.mjs`
mascara qualquer coisa que se pareça com um token antes de qualquer gravação
em disco ou impressão no console.

O job `diagnose` **não decide o resultado do CI**: mesmo que o diagnóstico
aponte `blocked`, o job em si não falha por causa disso (quem decide isso é o
`ci-gate`, a partir dos resultados brutos de `quality`/`tests`/`build`).

### 5. `ci-gate`

O "gate" real do pipeline. Também usa `needs: [quality, tests, build]` e
`if: always()`, mas depende **apenas** desses três jobs — nunca do
`diagnose` — porque o diagnóstico é informativo e não deve poder transformar
um pipeline quebrado em sucesso (nem, inversamente, um diagnóstico "blocked"
pode reprovar um pipeline verde). Ele falha (`exit 1`) se qualquer um dos três
não tiver terminado com `success`.

Ao proteger a branch `main` no GitHub (**Settings → Branches → Branch
protection rules**), é o **`ci-gate`** que deve ser marcado como *required
status check* — não `diagnose`.

## Localização dos artefatos

Cada execução do workflow publica, em **Actions → (execução) → Artifacts**:

| Artefato | Job que publica | Conteúdo |
| --- | --- | --- |
| `lint-log` | `quality` | `lint.log` |
| `tests-log` | `tests` | `tests.log` |
| `build-log` | `build` | `build.log` |
| `pipeline-guardian-diagnosis` | `diagnose` | `diagnosis.json`, `diagnosis.md` |
| `pr-diff` | `diagnose` (só em `pull_request`) | `pr.diff` |

## Localização do Job Summary

O conteúdo de `reports/diagnosis.md` é anexado ao **Job Summary** da execução
do job `diagnose` (visível em **Actions → (execução) → Summary**, na seção do
job "Diagnose (Pipeline Guardian)") — o mesmo relatório publicado como
artefato e (em Pull Requests) como comentário.

## Comportamento com fallback

O workflow funciona **sem** `OPENAI_API_KEY`/`OPENAI_MODEL` configurados:

- o job `diagnose` roda normalmente;
- `analyzePipeline` detecta a ausência das variáveis (`canUseModel`) e usa o
  **classificador determinístico** (`deterministic-classifier.mjs`) em vez do
  modelo;
- o diagnóstico gerado continua válido contra o schema, com
  `usedFallback: true` e uma limitação explícita registrada
  (`Sem OPENAI_API_KEY/OPENAI_MODEL: diagnóstico produzido pelo classificador
  determinístico.`);
- o comentário de PR, o Job Summary e os artefatos são publicados normalmente.

O mesmo vale para falhas em tempo de execução do modelo (erro de rede, chave
inválida, saída fora do schema): o agente nunca falha por causa do modelo —
ele degrada para o fallback e segue.

---

# Deploy assistido (`deploy-assisted.yml`)

Workflow separado, **disparo manual apenas** (`workflow_dispatch`), com dois
inputs: `environment` (`staging` | `production`) e `releaseVersion` (tag, branch
ou SHA).

**Nenhum job publica em infraestrutura real.** O deploy é *simulado*: gera um
`deployment-manifest.json` com `status: simulated`.

## Environments (obrigatório para o gate de production)

Em **Settings → Environments**, crie os dois ambientes:

| Environment | Configuração |
| --- | --- |
| `staging` | Nenhuma proteção necessária. |
| `production` | **Required reviewers** — pelo menos uma pessoa. |

> ⚠️ Sem **Required reviewers** no environment `production`, o job
> `deploy-production` roda **sem aprovação humana**. O gate de aprovação é do
> GitHub, não do código: `policyDecision: requires_human_approval` decide *que a
> aprovação é necessária*, mas quem **segura o job** até alguém aprovar é o
> environment. Essa configuração é o que fecha o circuito.

Opcionalmente, restrinja **Deployment branches and tags** em `production` para
as tags de release.

## Os três jobs

### 1. `assess`

Faz checkout da `releaseVersion`, roda `lint`, `test` e `build` preservando os
logs (um gate vermelho **não** derruba o job — é dado de entrada, não erro),
chama o Pipeline Guardian via `deploy-assessment.mjs` e produz:

- `reports/deploy-assessment.json` e `.md` (artefato `deploy-assessment` + Job Summary);
- o output de job **`policyDecision`**, que controla os jobs seguintes.

A avaliação separa, explicitamente, dois campos:

| Campo | Quem produz | O que significa |
| --- | --- | --- |
| `agentRecommendation` | o agente | prontidão **técnica**: `eligible_for_staging`, `technically_ready` ou `not_ready` |
| `policyDecision` | `deploy-policy.mjs` | o que pode ser **promovido**: `eligible_for_staging`, `requires_human_approval` ou `blocked` |

A política roda **depois** e sobrescreve qualquer recomendação insegura — se o
modelo descrever um pipeline vermelho como saudável, `policyDecision` continua
`blocked` (ela lê os exit codes, não a opinião do agente) e o relatório marca
`policyOverrodeAgent: true`.

Bloqueiam a promoção: lint, teste ou build falhando; risco alto; confiança
baixa; contexto insuficiente; conteúdo sensível detectado.

### 2. `deploy-staging`

Roda **somente** com `environment == 'staging'` **e**
`policyDecision == 'eligible_for_staging'`. Executa o deploy simulado e publica
o manifesto (`approvalRequired: false`).

### 3. `deploy-production`

Roda **somente** com `environment == 'production'` **e**
`policyDecision == 'requires_human_approval'`. Fica **pendente** até a aprovação
humana no environment `production`; só depois executa o deploy simulado e
publica o manifesto (`approvalRequired: true`).

Em ambos os casos o `--manifest` **revalida a decisão** antes de gravar: se ela
não for a esperada para o ambiente, o script falha em vez de registrar uma
promoção que ninguém autorizou. A condição do YAML não é a única barreira.

## Rodando localmente

```bash
# logs dos gates em reports/input/{lint,tests,build}.log
DEPLOY_ENVIRONMENT=staging RELEASE_VERSION=v1.4.0 \
  QUALITY_RESULT=success TESTS_RESULT=success BUILD_RESULT=success \
  npm run agent:deploy-assess

npm run agent:deploy-manifest   # deploy simulado, a partir da avaliação
```
