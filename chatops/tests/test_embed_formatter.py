"""Formatador do embed: cores, limites do Discord e menções."""

from __future__ import annotations

from chatops.app.adapters.inbound.github_actions import to_chatops_command
from chatops.app.adapters.outbound.discord import (
    DESCRIPTION_LIMIT,
    FALLBACK_COLOR,
    FIELD_NAME_LIMIT,
    FIELD_VALUE_LIMIT,
    MAX_FIELDS,
    TITLE_LIMIT,
    TOTAL_LIMIT,
    DiscordEmbedFormatter,
    color_for,
    embed_total_length,
    truncate,
)
from chatops.app.models import InboundEvent

from .conftest import build_event


def _embed(scenario: str = "test_failure", target: str = "test", **overrides):
    event_dict = build_event(scenario, target=target)
    event_dict["diagnosis"].update(overrides)
    event = InboundEvent.model_validate(event_dict)
    command = to_chatops_command(event, request_id="req-abc-123")
    return DiscordEmbedFormatter().format(command)


def test_cor_por_decisao_da_politica():
    assert color_for("blocked") == 0xD64545
    assert color_for("requires_human_approval") == 0xE9B949
    assert color_for("eligible_for_staging") == 0x2FBF71


def test_decisao_desconhecida_cai_na_cor_de_fallback():
    assert color_for("decisao-que-nao-existe") == FALLBACK_COLOR
    assert color_for("") == FALLBACK_COLOR


def test_cor_do_embed_segue_a_decisao_do_diagnostico():
    assert _embed("test_failure")["embeds"][0]["color"] == 0xD64545
    assert _embed("environment_failure")["embeds"][0]["color"] == 0xE9B949
    assert _embed(deployDecision="eligible_for_staging")["embeds"][0]["color"] == 0x2FBF71


def test_embed_traz_o_diagnostico_inteiro():
    payload = _embed("test_failure")
    embed = payload["embeds"][0]
    campos = {field["name"]: field["value"] for field in embed["fields"]}

    assert "Pipeline Guardian" in embed["title"]
    assert "duplicateCopies" in embed["description"]
    assert embed["timestamp"] == "2026-07-14T13:05:22.481Z"

    for esperado in (
        "Status",
        "Tipo de falha",
        "Sinal",
        "Causa provável",
        "Impacto",
        "Próximos passos",
        "Risco",
        "Confiança",
        "Recomendação do agente",
        "Decisão da política",
        "Repositório",
        "Branch",
        "Execução",
    ):
        assert esperado in campos, f"campo ausente no embed: {esperado}"

    assert "`test`" in campos["Tipo de falha"]
    assert "test:AssertionError" in campos["Sinal"]
    assert "blocked" in campos["Decisão da política"]
    assert "aprovação humana:** sim" in campos["Decisão da política"]
    assert "actions/runs/" in campos["Execução"]


def test_recomendacao_do_agente_e_separada_da_decisao_da_politica():
    """Quem analisa recomenda; quem decide é a política. O embed não mistura os dois."""
    payload = _embed("test_failure")
    campos = {field["name"]: field["value"] for field in payload["embeds"][0]["fields"]}

    recomendacao = campos["Recomendação do agente"]
    assert "classificador determinístico" in recomendacao  # usedFallback: true
    assert "Ação prioritária" in recomendacao
    assert "blocked" not in recomendacao

    assert "blocked" in campos["Decisão da política"]


def test_diagnostico_do_modelo_aparece_como_tal_na_recomendacao():
    payload = _embed(usedFallback=False)
    campos = {field["name"]: field["value"] for field in payload["embeds"][0]["fields"]}
    assert "modelo de linguagem" in campos["Recomendação do agente"]


def test_request_id_no_rodape():
    embed = _embed()["embeds"][0]
    assert "request_id: req-abc-123" in embed["footer"]["text"]


def test_allowed_mentions_vazio():
    """Um log pode conter '@everyone'. O Discord não vai marcar ninguém por isso."""
    payload = _embed(summary="@everyone o pipeline quebrou @here")
    assert payload["allowed_mentions"] == {"parse": []}


def test_um_embed_por_mensagem():
    assert len(_embed()["embeds"]) == 1


def test_truncate_respeita_o_limite_e_sinaliza_o_corte():
    assert truncate("abc", 10) == "abc"
    assert len(truncate("a" * 100, 10)) == 10
    assert truncate("a" * 100, 10).endswith("…")


def test_titulo_e_descricao_sao_truncados():
    payload = _embed(summary="s" * 9000, repository="r" * 500)
    embed = payload["embeds"][0]
    assert len(embed["title"]) <= TITLE_LIMIT
    assert len(embed["description"]) <= DESCRIPTION_LIMIT


def test_campos_respeitam_os_limites_de_nome_e_valor():
    payload = _embed(
        probableCause="c" * 5000,
        impact="i" * 5000,
        nextSteps=[f"passo {i} " + "p" * 200 for i in range(20)],
    )
    for field in payload["embeds"][0]["fields"]:
        assert len(field["name"]) <= FIELD_NAME_LIMIT
        assert len(field["value"]) <= FIELD_VALUE_LIMIT


def test_no_maximo_25_campos():
    payload = _embed(limitations=[f"limitação {i}" for i in range(40)])
    assert len(payload["embeds"][0]["fields"]) <= MAX_FIELDS


def test_soma_total_nao_passa_de_6000_caracteres():
    """O caso patológico: um diagnóstico gigante não pode virar um 400 do Discord."""
    payload = _embed(
        summary="s" * 4000,
        probableCause="c" * 3000,
        impact="i" * 3000,
        signal="x" * 2000,
        nextSteps=["p" * 900 for _ in range(10)],
        limitations=["l" * 900 for _ in range(10)],
        evidence=[{"source": f"log:test:{i}", "excerpt": "e" * 900} for i in range(10)],
    )
    assert embed_total_length(payload) <= TOTAL_LIMIT


def test_diagnostico_sem_proximos_passos_nao_quebra():
    payload = _embed(nextSteps=[], evidence=[], limitations=[])
    campos = {field["name"]: field["value"] for field in payload["embeds"][0]["fields"]}
    assert campos["Próximos passos"] == "_Nenhum passo sugerido._"
    assert "Sem ação sugerida" in campos["Recomendação do agente"]
