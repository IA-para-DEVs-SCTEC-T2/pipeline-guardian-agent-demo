"""Adaptador de saída: contrato normalizado → mensagem do Discord.

Só formatação. Nenhuma rede, nenhum segredo, nenhuma URL de webhook — o
`DiscordWebhookClient` cuida disso. Por isso o formatador é testável sem mock
nenhum: entra um `ChatOpsCommand`, sai um `dict`.

Os limites do Discord são regra de negócio aqui, não detalhe do cliente HTTP:
uma mensagem que estoura 6000 caracteres é rejeitada com HTTP 400 pelo Discord,
e uma notificação de falha de pipeline que falha em silêncio é pior que
notificação nenhuma. Então o formatador trunca antes de enviar.
"""

from __future__ import annotations

from typing import Any

from chatops.app.models import ChatOpsCommand, Diagnosis

# Limites da API do Discord (embeds).
TITLE_LIMIT = 256
DESCRIPTION_LIMIT = 4096
FIELD_NAME_LIMIT = 256
FIELD_VALUE_LIMIT = 1024
FOOTER_LIMIT = 2048
MAX_FIELDS = 25
TOTAL_LIMIT = 6000

# Cores por decisão da política de deploy.
DECISION_COLORS: dict[str, int] = {
    "blocked": 0xD64545,
    "requires_human_approval": 0xE9B949,
    "eligible_for_staging": 0x2FBF71,
}
FALLBACK_COLOR = 0x5865F2

_ELLIPSIS = "…"

_STATUS_LABELS = {"success": "✅ sucesso", "failed": "❌ falhou", "partial": "⚠️ parcial"}
_RISK_LABELS = {"low": "🟢 baixo", "medium": "🟡 médio", "high": "🔴 alto"}
_CONFIDENCE_LABELS = {"low": "🔴 baixa", "medium": "🟡 média", "high": "🟢 alta"}
_DECISION_LABELS = {
    "blocked": "🔴 `blocked` — promoção bloqueada",
    "requires_human_approval": "🟡 `requires_human_approval` — exige aprovação humana",
    "eligible_for_staging": "🟢 `eligible_for_staging` — elegível para staging",
}
_FAILURE_TYPE_LABELS = {
    "lint": "lint",
    "test": "testes",
    "dependency": "dependência",
    "build": "build",
    "environment": "ambiente",
    "permission": "permissão",
    "security": "segurança",
    "unknown": "não identificado",
}


def truncate(text: str, limit: int) -> str:
    """Corta em `limit` caracteres, reservando espaço para as reticências."""
    if text is None:
        return ""
    text = str(text)
    if len(text) <= limit:
        return text
    if limit <= len(_ELLIPSIS):
        return text[:limit]
    return text[: limit - len(_ELLIPSIS)] + _ELLIPSIS


def color_for(deploy_decision: str) -> int:
    """Cor do embed. Decisão desconhecida cai no fallback em vez de quebrar."""
    return DECISION_COLORS.get(deploy_decision, FALLBACK_COLOR)


def _agent_recommendation(diagnosis: Diagnosis) -> str:
    """A recomendação de quem *analisou* — separada da decisão de quem *decide*.

    O modelo (ou o classificador determinístico, no fallback) nunca decide
    deploy: `modelDiagnosisSchema` sequer expõe `deployDecision`. O que o agente
    produz é análise e ação sugerida — é isso que este campo mostra.
    """
    origem = (
        "classificador determinístico (sem modelo)"
        if diagnosis.used_fallback
        else "modelo de linguagem, com evidência conferida"
    )
    confianca = _CONFIDENCE_LABELS.get(diagnosis.confidence, diagnosis.confidence)
    acao = diagnosis.next_steps[0] if diagnosis.next_steps else "Sem ação sugerida."
    return f"**Origem:** {origem}\n**Confiança:** {confianca}\n**Ação prioritária:** {acao}"


def _policy_decision(diagnosis: Diagnosis) -> str:
    """A decisão da política (`deploy-policy.mjs`), aplicada depois da análise.

    Os *motivos* (`policy.reasons`) não trafegam: o Guardian só os grava no
    `diagnosis.md`, nunca no `diagnosis.json`. O que temos no JSON é a decisão e
    o `requiresHumanApproval` — e é o suficiente para o canal.
    """
    decisao = _DECISION_LABELS.get(diagnosis.deploy_decision, f"`{diagnosis.deploy_decision}`")
    aprovacao = "sim" if diagnosis.requires_human_approval else "não"
    return f"{decisao}\n**Exige aprovação humana:** {aprovacao}"


def _numbered(items: list[str]) -> str:
    if not items:
        return "_Nenhum passo sugerido._"
    return "\n".join(f"{index}. {step}" for index, step in enumerate(items, start=1))


def _evidence_block(diagnosis: Diagnosis) -> str:
    if not diagnosis.evidence:
        return "_Nenhuma evidência coletada._"
    linhas = []
    for item in diagnosis.evidence:
        excerpt = item.excerpt.replace("`", "'").strip()
        linhas.append(f"**{item.source}**\n`{truncate(excerpt, 180)}`")
    return "\n".join(linhas)


class DiscordEmbedFormatter:
    """Converte o contrato normalizado em um embed do Discord.

    Um embed por mensagem, `allowed_mentions.parse` vazio: o bot não consegue
    marcar `@everyone` nem cargo nenhum, mesmo que um log traga esse texto.
    """

    def format(self, command: ChatOpsCommand) -> dict[str, Any]:
        diagnosis = command.diagnosis
        args = command.arguments

        status = _STATUS_LABELS.get(diagnosis.pipeline_status, diagnosis.pipeline_status)
        failure = _FAILURE_TYPE_LABELS.get(diagnosis.failure_type, diagnosis.failure_type)
        run_url = args["run_url"]
        commit_curto = diagnosis.commit_sha[:7]

        title = truncate(f"🛡️ Pipeline Guardian · {args['repository']} · {status}", TITLE_LIMIT)
        description = truncate(diagnosis.summary, DESCRIPTION_LIMIT)

        # Ordem = prioridade. Se o orçamento de 6000 apertar, o corte começa pelo fim.
        candidatos: list[tuple[str, str, bool]] = [
            ("Status", f"`{diagnosis.pipeline_status}` — {status}", True),
            ("Tipo de falha", f"`{diagnosis.failure_type}` ({failure})", True),
            ("Sinal", f"`{diagnosis.signal}`", False),
            ("Causa provável", diagnosis.probable_cause, False),
            ("Impacto", diagnosis.impact, False),
            ("Próximos passos", _numbered(diagnosis.next_steps), False),
            ("Risco", _RISK_LABELS.get(diagnosis.risk_level, diagnosis.risk_level), True),
            ("Confiança", _CONFIDENCE_LABELS.get(diagnosis.confidence, diagnosis.confidence), True),
            ("Recomendação do agente", _agent_recommendation(diagnosis), False),
            ("Decisão da política", _policy_decision(diagnosis), False),
            ("Repositório", f"`{args['repository']}`", True),
            ("Branch", f"`{args['branch']}`", True),
            ("Commit", f"`{commit_curto}`", True),
            ("Evidências", _evidence_block(diagnosis), False),
            ("Execução", f"[Abrir no GitHub Actions]({run_url})", False),
        ]

        if diagnosis.limitations:
            limitacoes = "\n".join(f"- {item}" for item in diagnosis.limitations)
            candidatos.insert(-1, ("Limitações", limitacoes, False))

        footer = truncate(
            f"request_id: {command.request_id} · analysis: {diagnosis.analysis_id}",
            FOOTER_LIMIT,
        )

        # Orçamento total: título + descrição + rodapé já consomem parte dos 6000.
        usado = len(title) + len(description) + len(footer)
        fields: list[dict[str, Any]] = []

        for name, value, inline in candidatos:
            if len(fields) >= MAX_FIELDS:
                break
            name = truncate(name, FIELD_NAME_LIMIT)
            value = truncate(value or "—", FIELD_VALUE_LIMIT)
            custo = len(name) + len(value)
            if usado + custo > TOTAL_LIMIT:
                continue
            usado += custo
            fields.append({"name": name, "value": value, "inline": inline})

        embed: dict[str, Any] = {
            "title": title,
            "url": run_url,
            "description": description,
            "color": color_for(diagnosis.deploy_decision),
            "fields": fields,
            "footer": {"text": footer},
            "timestamp": diagnosis.generated_at,
        }

        return {
            "username": "Pipeline Guardian",
            "embeds": [embed],
            "allowed_mentions": {"parse": []},
        }


def embed_total_length(payload: dict[str, Any]) -> int:
    """Soma o que o Discord conta no limite de 6000 caracteres."""
    embed = payload["embeds"][0]
    total = len(embed.get("title", "")) + len(embed.get("description", ""))
    total += len(embed.get("footer", {}).get("text", ""))
    for field in embed.get("fields", []):
        total += len(field["name"]) + len(field["value"])
    return total
