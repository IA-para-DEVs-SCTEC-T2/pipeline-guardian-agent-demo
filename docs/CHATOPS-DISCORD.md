# ChatOps com Discord — Dia 2

Como o diagnóstico do Pipeline Guardian sai do CI e chega ao Discord.

## O que muda em relação ao Dia 1

No Dia 1 o agente publicava o diagnóstico como **comentário na Pull Request**.
No Dia 2 o canal do Discord assume esse papel: o comentário automático é
desligado (`AUTOMATION_ALLOW_PR_COMMENT: "false"`), e o Discord vira a saída
principal.

O que **não** muda:

- o Pipeline Guardian continua igual — não foi reimplementado, nem portado para
  Python, nem teve sua lógica copiada;
- o **Job Summary** continua recebendo o `diagnosis.md` completo;
- os **artefatos** (`diagnosis.json`, `diagnosis.md`, `pr-comment.md`, diff)
  continuam sendo publicados;
- o **CI Gate** continua decidindo o pipeline só com `quality`, `tests` e
  `build`. A notificação não entra nessa conta.

A notificação é um canal **a mais**, não a única cópia do diagnóstico. Se o
Discord estiver fora do ar, nada de importante se perde.

## Fluxo

```
┌──────────────── GitHub Actions ────────────────┐
│  quality ─┐                                    │
│  tests  ──┼─→ diagnose (Pipeline Guardian)     │
│  build  ──┘        │                           │
│                    ├─→ reports/diagnosis.json  │  (artefato + Job Summary)
│                    │                           │
│                    └─→ send-chatops-event.mjs  │  assina (HMAC) e envia
└────────────────────────────┬───────────────────┘
                             │  POST /webhooks/github-actions
                             ▼
┌──────────────────── FastAPI (chatops/) ────────────────────┐
│  main.py            valida token, timestamp e assinatura   │
│  adapters/inbound   normaliza → ChatOpsCommand             │
│  services           allowlist (repo, canal) → roteia       │
│  adapters/outbound  DiscordEmbedFormatter → embed          │
│  clients            httpx → webhook (?wait=true, retry)    │
└────────────────────────────┬───────────────────────────────┘
                             ▼
                    Canal do Discord
```

Cada seta é uma fronteira testável. O formatador não sabe o que é rede; o cliente
não sabe o que é um diagnóstico.

## Configuração no GitHub

### Variables (`vars`) — não são segredo

| Variável | Exemplo | Papel |
| --- | --- | --- |
| `CHATOPS_ENDPOINT_URL` | `https://chatops.exemplo.dev` | Base do FastAPI. **Vazia = notificação desligada**, e o step nem roda. |
| `CHATOPS_TARGET` | `test` | Canal lógico: `test` (privado) ou `class` (turma). |

### Secrets — são segredo

| Secret | Papel |
| --- | --- |
| `CHATOPS_SHARED_SECRET` | Chave do HMAC. O mesmo valor no CI e no FastAPI. |
| `CHATOPS_API_TOKEN` | Bearer token da API. |

As **URLs dos webhooks do Discord não ficam no GitHub**. Elas vivem só no
ambiente do FastAPI (`DISCORD_WEBHOOK_URL_TEST`, `DISCORD_WEBHOOK_URL_CLASS`).
O CI escolhe um canal *lógico*; quem sabe traduzir isso em URL é o backend.

Uma URL de webhook do Discord é um segredo em formato de URL: quem tem a URL
publica no canal, sem autenticação nenhuma. Ela nunca entra em payload, nunca
entra em log, nunca entra em variável do GitHub.

## Alterações no `ci.yml`

Duas, ambas no job `diagnose`:

**1. Comentário de PR desligado** (era uma expressão, virou `"false"`):

```yaml
AUTOMATION_ALLOW_PR_COMMENT: "false"
```

`upsertPullRequestComment` entra em dry-run: o corpo ainda é gravado em
`reports/pr-comment.md` e vai para os artefatos — só não é publicado na PR.

**2. Step de notificação**, o último do job:

```yaml
- name: Notify Discord (ChatOps)
  if: ${{ always() && github.event_name == 'pull_request' && hashFiles('reports/diagnosis.json') != '' && vars.CHATOPS_ENDPOINT_URL != '' }}
  continue-on-error: true
  env:
    CHATOPS_ENDPOINT_URL: ${{ vars.CHATOPS_ENDPOINT_URL }}
    CHATOPS_TARGET: ${{ vars.CHATOPS_TARGET }}
    CHATOPS_SHARED_SECRET: ${{ secrets.CHATOPS_SHARED_SECRET }}
    CHATOPS_API_TOKEN: ${{ secrets.CHATOPS_API_TOKEN }}
    GITHUB_SHA: ${{ github.event.pull_request.head.sha || github.sha }}
    GITHUB_HEAD_REF: ${{ github.head_ref }}
  run: node automation/src/send-chatops-event.mjs
```

Cada condição do `if` existe por um motivo:

- `always()` — o diagnóstico interessa **justamente** quando o pipeline falhou;
- `github.event_name == 'pull_request'` — só há o que discutir em contexto de PR;
- `hashFiles('reports/diagnosis.json') != ''` — sem diagnóstico, não há o que notificar;
- `vars.CHATOPS_ENDPOINT_URL != ''` — quem não configurou o ChatOps não vê o step falhar.

E `continue-on-error: true` porque, durante o laboratório, um webhook mal colado
não pode reprovar código que está correto.

O `GITHUB_SHA` é sobrescrito de propósito: em Pull Request ele aponta para o
merge commit, e `GITHUB_REF_NAME` vira `<numero>/merge`. O que interessa ao
diagnóstico é o commit e a branch de quem abriu a PR — daí `GITHUB_HEAD_REF`.

## Assinatura: a mesma dos dois lados

```
mensagem  = "<timestamp>" + "." + <corpo bruto, em bytes>
assinatura = "sha256=" + HMAC_SHA256(CHATOPS_SHARED_SECRET, mensagem)
```

Headers:

```
Authorization:       Bearer <CHATOPS_API_TOKEN>
X-ChatOps-Timestamp: 1700000000
X-ChatOps-Signature: sha256=cb12782065cc82a42dd562e1a0d1196b30afdcc44e15ecf989972021e78a1b39
```

O corpo assinado é **exatamente** a string enviada no POST. `JSON.stringify` do
Node e `json.dumps` do Python não produzem os mesmos bytes — se qualquer um dos
lados reserializasse o JSON entre assinar e conferir, a assinatura quebraria.

Essa é uma daquelas coisas que falham em produção como um `401` opaco às 3h da
manhã. Por isso as duas suítes de teste asseveram **o mesmo vetor**:

- `chatops/tests/test_security.py::test_assinatura_bate_com_o_vetor_compartilhado_com_o_node`
- `automation/tests/send-chatops-event.test.mjs` → `assina 'timestamp.corpo_bruto'`

Se Node e Python divergirem, o teste fica vermelho antes de o CI ficar.

## Verificações do FastAPI

Na ordem — barata → cara, e a mais reveladora por último:

| # | Verificação | Falha |
| --- | --- | --- |
| 1 | Bearer token (`compare_digest`) | 401 |
| 2 | Timestamp dentro de 300s (janela simétrica) | 401 |
| 3 | HMAC sobre o corpo bruto (`compare_digest`) | 401 |
| 4 | Schema do payload | 422 |
| 5 | `repository` na allowlist | 403 |
| 6 | `target` na allowlist (`test`/`class`) | 403 |
| 7 | Entrega no Discord | 502 |

As três primeiras respondem a mesma coisa a quem erra: uma rejeição sem pista.
`repository` e `target` são `str` no modelo, e não `Literal`, justamente para
baterem na **allowlist** (403 — "sei quem você é, e não pode") em vez de virarem
um 422 de formato.

## O embed

| Elemento | Origem no `diagnosis.json` |
| --- | --- |
| Título | `repository` + `pipelineStatus` |
| Descrição | `summary` |
| Status / Tipo de falha | `pipelineStatus`, `failureType` |
| Sinal | `signal` |
| Causa provável | `probableCause` |
| Impacto | `impact` |
| Próximos passos | `nextSteps` |
| Risco / Confiança | `riskLevel`, `confidence` |
| Recomendação do agente | `usedFallback`, `confidence`, `nextSteps[0]` |
| Decisão da política | `deployDecision`, `requiresHumanApproval` |
| Repositório / Branch / Commit | `repository`, `branch`, `commitSha` |
| Evidências | `evidence[]` |
| Execução | `run_url` (do envelope, não do diagnóstico) |
| Rodapé | `request_id` + `analysisId` |
| Timestamp | `generatedAt` |

**Recomendação do agente** e **decisão da política** são campos separados porque
são coisas separadas — é a arquitetura do Dia 1 aparecendo no canal: o modelo
descreve a falha (`modelDiagnosisSchema` sequer expõe `deployDecision` a ele), e
quem decide promoção é `deploy-policy.mjs`, depois, com regras legíveis.

A cor do embed **é** a decisão: `blocked` vermelho, `requires_human_approval`
âmbar, `eligible_for_staging` verde, desconhecida azul (fallback). Dá para ler o
resultado do pipeline pela cor, sem ler uma palavra.

### Limites do Discord

Título 256 · descrição 4096 · 25 fields · nome 256 · valor 1024 · **soma 6000**.
Um embed por mensagem.

Estourar o limite dá HTTP 400 — e uma notificação de falha que falha em silêncio
é pior do que notificação nenhuma. O formatador trunca antes de enviar, e corta
os campos menos importantes primeiro quando o orçamento de 6000 aperta.

## Rodar o laboratório

```bash
# 1. dependências
python3 -m venv chatops/.venv
chatops/.venv/bin/pip install -r chatops/requirements.txt
cp chatops/.env.example chatops/.env     # preencha

# 2. o serviço
chatops/.venv/bin/python -m uvicorn chatops.app.main:app --port 8000

# 3. saúde
curl -s http://127.0.0.1:8000/health

# 4. uma fixture no canal privado
python chatops/scripts/send_fixture.py --scenario test_failure --target test
```

Saída esperada:

```
status:     202 accepted
request_id: 2fbd9eaa-fc5f-488c-8121-6541828a06ca
message_id: 1291837465920384756
```

Para o CI alcançar o serviço, exponha-o com um túnel (`cloudflared`, `ngrok`) e
coloque a URL pública em `vars.CHATOPS_ENDPOINT_URL`.

## Testes

```bash
pytest -q chatops/tests          # 69 testes
npm run test -w automation       # inclui send-chatops-event.test.mjs
```

Nenhum deles envia mensagem de verdade ao Discord.

## O que este serviço não faz

- **Não diagnostica.** Nenhuma regra do Pipeline Guardian foi reescrita aqui.
- **Não decide deploy.** A decisão vem pronta, de `deploy-policy.mjs`.
- **Não altera o CI Gate.** O pipeline passa ou falha por `quality`, `tests` e
  `build` — nunca pelo Discord.
- **Não fala com Slack, Teams ou e-mail.**

## Limitação conhecida

Os **motivos** da política (`policy.reasons`) não chegam ao Discord: o Guardian
os grava apenas no `reports/diagnosis.md`, e o que trafega é o `diagnosis.json`.
O embed leva a decisão e o `requiresHumanApproval`; para o "por quê" detalhado, o
link do run abre o Job Summary com o Markdown completo.

Persistir `policy.reasons` no JSON resolveria — mas isso é mudança no Pipeline
Guardian, e o Dia 2 não mexe no Guardian.
