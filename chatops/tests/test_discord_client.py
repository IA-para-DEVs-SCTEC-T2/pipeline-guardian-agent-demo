"""Cliente do Discord: retry, 429, falha de rede e sigilo da URL.

Nenhum teste sai para a rede: `httpx.MockTransport` responde no lugar do Discord.
"""

from __future__ import annotations

import logging

import httpx
import pytest

from chatops.app.clients.discord_webhook import DiscordDeliveryError, DiscordWebhookClient

WEBHOOK = "https://discord.com/api/webhooks/999/token-super-secreto-do-webhook"
PAYLOAD = {"embeds": [{"title": "teste"}], "allowed_mentions": {"parse": []}}


def _client(handler, *, max_attempts: int = 3, esperas: list[float] | None = None) -> DiscordWebhookClient:
    async def _sleep(seconds: float) -> None:
        if esperas is not None:
            esperas.append(seconds)

    transport = httpx.MockTransport(handler)
    return DiscordWebhookClient(
        max_attempts=max_attempts,
        client=httpx.AsyncClient(transport=transport),
        sleep=_sleep,
    )


async def test_envio_bem_sucedido_devolve_o_message_id():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "1122334455"})

    client = _client(handler)
    message_id = await client.send(WEBHOOK, PAYLOAD, request_id="req-1", channel_id="test")

    assert message_id == "1122334455"


async def test_usa_wait_true_para_receber_a_mensagem_criada():
    vistas: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        vistas.append(str(request.url))
        return httpx.Response(200, json={"id": "1"})

    await _client(handler).send(WEBHOOK, PAYLOAD, request_id="req-1", channel_id="test")

    assert vistas[0].endswith("?wait=true")


async def test_429_e_retentado_respeitando_retry_after():
    tentativas: list[int] = []
    esperas: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        tentativas.append(1)
        if len(tentativas) == 1:
            return httpx.Response(429, json={"retry_after": 0.75, "global": False})
        return httpx.Response(200, json={"id": "9988"})

    client = _client(handler, esperas=esperas)
    message_id = await client.send(WEBHOOK, PAYLOAD, request_id="req-1", channel_id="test")

    assert message_id == "9988"
    assert len(tentativas) == 2
    assert esperas == [0.75]  # esperou exatamente o que o Discord pediu


async def test_429_persistente_para_em_3_tentativas():
    tentativas: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        tentativas.append(1)
        return httpx.Response(429, json={"retry_after": 0.1})

    client = _client(handler)

    with pytest.raises(DiscordDeliveryError):
        await client.send(WEBHOOK, PAYLOAD, request_id="req-1", channel_id="test")

    assert len(tentativas) == 3


async def test_falha_de_rede_e_retentada_e_depois_desiste():
    tentativas: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        tentativas.append(1)
        raise httpx.ConnectError("conexão recusada", request=request)

    client = _client(handler)

    with pytest.raises(DiscordDeliveryError) as erro:
        await client.send(WEBHOOK, PAYLOAD, request_id="req-1", channel_id="test")

    assert len(tentativas) == 3
    assert "falha de rede" in str(erro.value)


async def test_falha_de_rede_transitoria_se_recupera():
    tentativas: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        tentativas.append(1)
        if len(tentativas) < 3:
            raise httpx.ConnectTimeout("timeout", request=request)
        return httpx.Response(200, json={"id": "77"})

    client = _client(handler)
    assert await client.send(WEBHOOK, PAYLOAD, request_id="req-1", channel_id="test") == "77"


async def test_4xx_nao_e_retentado():
    """Payload inválido continuará inválido na terceira tentativa."""
    tentativas: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        tentativas.append(1)
        return httpx.Response(400, json={"message": "Invalid Form Body"})

    client = _client(handler)

    with pytest.raises(DiscordDeliveryError):
        await client.send(WEBHOOK, PAYLOAD, request_id="req-1", channel_id="test")

    assert len(tentativas) == 1


async def test_5xx_e_retentado():
    tentativas: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        tentativas.append(1)
        if len(tentativas) == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"id": "55"})

    client = _client(handler)
    assert await client.send(WEBHOOK, PAYLOAD, request_id="req-1", channel_id="test") == "55"
    assert len(tentativas) == 2


async def test_a_url_do_webhook_nunca_aparece_no_log(caplog):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("conexão recusada", request=request)

    client = _client(handler)

    with caplog.at_level(logging.DEBUG, logger="chatops.discord"), pytest.raises(DiscordDeliveryError):
        await client.send(WEBHOOK, PAYLOAD, request_id="req-1", channel_id="test")

    registrado = caplog.text
    assert WEBHOOK not in registrado
    assert "token-super-secreto-do-webhook" not in registrado
    assert "req-1" in registrado  # mas o request_id, sim: é por ele que se correlaciona


async def test_a_url_do_webhook_nunca_aparece_na_excecao():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("conexão recusada", request=request)

    with pytest.raises(DiscordDeliveryError) as erro:
        await _client(handler).send(WEBHOOK, PAYLOAD, request_id="req-1", channel_id="test")

    mensagem = str(erro.value)
    assert "discord.com" not in mensagem
    assert "token-super-secreto-do-webhook" not in mensagem
    assert "'test'" in mensagem  # o canal lógico, esse pode


async def test_todo_log_do_cliente_carrega_o_request_id(caplog):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "1"})

    with caplog.at_level(logging.INFO, logger="chatops.discord"):
        await _client(handler).send(WEBHOOK, PAYLOAD, request_id="req-rastreavel", channel_id="class")

    assert [r for r in caplog.records if "req-rastreavel" in r.getMessage()]
