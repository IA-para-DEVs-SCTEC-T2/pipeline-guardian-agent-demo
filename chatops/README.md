# ChatOps — Pipeline Guardian → Discord

Serviço FastAPI que recebe o diagnóstico **já produzido** pelo Pipeline Guardian
(Dia 1) e o publica em um canal do Discord.

Este serviço **não diagnostica nada**. Ele transporta. Quem analisa a falha,
quem correlaciona com o diff e quem decide o deploy é o agente do Dia 1
(`automation/`), e nada disso foi reimplementado aqui — nem em Python, nem em
lugar nenhum. Se este serviço sumir, o diagnóstico continua no Job Summary e nos
artefatos do CI: o Discord é um canal a mais, não a única cópia.

## O caminho completo

```
GitHub Actions
  └─ Pipeline Guardian (Dia 1)  →  reports/diagnosis.json
       └─ automation/src/send-chatops-event.mjs   assina e envia
            └─ POST /webhooks/github-actions      FastAPI valida
                 └─ adapters/inbound              normaliza
                      └─ services/chatops_service allowlist + roteia
                           └─ adapters/outbound   monta o embed
                                └─ clients        publica no webhook
```

## Arquitetura

Hexagonal, e a divisão não é decorativa — cada peça é testável sozinha:

| Camada | Arquivo | Responsabilidade |
| --- | --- | --- |
| Borda HTTP | `app/main.py` | Lê o corpo **bruto**, autentica, devolve status. Não formata nada. |
| Segurança | `app/security/signature.py` | Bearer, HMAC, janela de tempo. Sem HTTP, sem estado. |
| Modelos | `app/models.py` | Espelha o `diagnosis.json` real e o envelope de transporte. |
| Adaptador de entrada | `app/adapters/inbound/github_actions.py` | GitHub Actions → contrato normalizado. Função pura. |
| Serviço | `app/services/chatops_service.py` | Allowlist e roteamento de canal. As regras moram aqui. |
| Adaptador de saída | `app/adapters/outbound/discord.py` | Contrato → embed. Só formatação, zero rede. |
| Cliente | `app/clients/discord_webhook.py` | HTTP, retry, 429. Só rede, zero formatação. |

O formatador e o cliente são separados **de propósito**: os limites do Discord
(6000 caracteres, 25 fields) são regra de apresentação, e testá-los não deveria
exigir mock de rede nenhum. `test_embed_formatter.py` não mocka nada.

## Instalação

```bash
python3 -m venv chatops/.venv          # ou: uv venv chatops/.venv
chatops/.venv/bin/pip install -r chatops/requirements.txt

cp chatops/.env.example chatops/.env   # preencha os segredos
```

## Executar

```bash
chatops/.venv/bin/python -m uvicorn chatops.app.main:app --port 8000
curl -s http://127.0.0.1:8000/health
```

Para o CI alcançar o serviço, ele precisa de um endereço público — um túnel
(`cloudflared`, `ngrok`) resolve durante o laboratório.

## Enviar uma fixture

Quatro diagnósticos de exemplo, coerentes com o schema real do Guardian:

```bash
python chatops/scripts/send_fixture.py --scenario test_failure        --target test
python chatops/scripts/send_fixture.py --scenario dependency_failure  --target test
python chatops/scripts/send_fixture.py --scenario environment_failure --target class
python chatops/scripts/send_fixture.py --scenario permission_failure  --target class
```

O script assina exatamente como o script Node do CI. Imprime só `status`,
`request_id` e `message_id` — nunca um segredo.

> `run_url` sai como `.../runs/0` fora do CI, porque `GITHUB_RUN_ID` não existe
> na sua máquina. Defina a variável se quiser um link real.

## Contrato normalizado

O envelope do GitHub Actions vira isto — e a partir daqui ninguém mais sabe que a
origem foi o GitHub:

```json
{
  "channel": "discord",
  "channel_id": "test",
  "user_id": "github-actions",
  "command": "pipeline-diagnosis",
  "arguments": {
    "repository": "senai/copa-figurinhas",
    "branch": "feat/ordenar-figurinhas",
    "commit_sha": "c0f4a17b93e2d5486ab1e77c2d9f4b6a0e3c81df",
    "run_url": "https://github.com/senai/copa-figurinhas/actions/runs/17293847561",
    "diagnosis": { "…": "o objeto do Pipeline Guardian, sem tradução" }
  },
  "response_target": "test",
  "request_id": "2fbd9eaa-fc5f-488c-8121-6541828a06ca"
}
```

`channel_id` é o canal **lógico** (`test` ou `class`), nunca uma URL. A tradução
para o webhook real acontece no serviço, a partir do ambiente.

## Segurança

1. **Bearer token** — `Authorization: Bearer <token>`, comparado com `compare_digest`.
2. **HMAC SHA-256** sobre `timestamp.corpo_bruto`, sobre os **bytes recebidos**.
   Reserializar o JSON antes de conferir produziria bytes diferentes: por isso a
   assinatura é validada **antes** de qualquer parse.
3. **Janela de 300s** — simétrica. Um evento capturado não é reenviável depois.
4. **Allowlist de repositório** — só `ALLOWED_REPOSITORY` é aceito (403).
5. **Allowlist de canal** — só `test` e `class` (403).
6. **Nenhuma URL do Discord no payload** — `extra="forbid"` no modelo derruba um
   corpo que traga `webhook_url`, e `run_url` apontando para o Discord é rejeitada.
7. **URLs só no ambiente**, como `SecretStr`: não aparecem em log, em traceback,
   em mensagem de erro nem na resposta HTTP.
8. **`allowed_mentions: {"parse": []}`** — um log com `@everyone` não vira menção.
9. **`request_id` em todo log**, e em toda resposta (inclusive as de erro): é por
   ele que se liga o que o CI enviou ao que o Discord recebeu.

A ordem das verificações é barata → cara: token, timestamp, assinatura, schema,
allowlist. Um corpo que não passa no HMAC nunca chega a virar objeto.

## Cores do embed

A cor **é a decisão da política**, não um enfeite:

| Decisão | Cor |
| --- | --- |
| `blocked` | `0xD64545` |
| `requires_human_approval` | `0xE9B949` |
| `eligible_for_staging` | `0x2FBF71` |
| desconhecida (fallback) | `0x5865F2` |

## Uma limitação honesta

Os **motivos** da política (`policy.reasons`) não chegam ao Discord: o Guardian
só os grava no `reports/diagnosis.md`, nunca no `diagnosis.json`, e este serviço
transporta o JSON. O embed mostra a decisão (`deployDecision`) e o
`requiresHumanApproval` — para o "por quê" detalhado, o link do run leva ao Job
Summary, que tem o Markdown completo.

Corrigir isso é trabalho no Guardian (persistir `policy.reasons` no JSON), não
aqui — e o Dia 2 não mexe no Guardian.

## Testes

```bash
pytest -q chatops/tests
```

Nenhum teste envia mensagem de verdade: o cliente do Discord é dublado
(`conftest.py`) ou responde por `httpx.MockTransport`. Um teste que dispara
mensagem em canal é um teste que ninguém roda duas vezes.
