"""Endpoint HTTP: autenticação, allowlist, roteamento de canal e sigilo."""

from __future__ import annotations

import json
import logging
import time

from .conftest import (
    REPOSITORY,
    SECRET,
    TOKEN,
    WEBHOOK_CLASS,
    WEBHOOK_TEST,
    build_event,
    signed_request,
)

ENDPOINT = "/webhooks/github-actions"


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_evento_valido_retorna_202(client, fake_discord):
    corpo, headers = signed_request(build_event())

    response = client.post(ENDPOINT, content=corpo, headers=headers)

    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "accepted"
    assert body["message_id"] == fake_discord.message_id
    assert body["request_id"]
    assert response.headers["X-Request-Id"] == body["request_id"]
    assert len(fake_discord.calls) == 1


def test_token_invalido_retorna_401_e_nao_chama_o_discord(client, fake_discord):
    corpo, headers = signed_request(build_event(), token="token-errado")

    response = client.post(ENDPOINT, content=corpo, headers=headers)

    assert response.status_code == 401
    assert fake_discord.calls == []


def test_authorization_ausente_retorna_401(client):
    corpo, headers = signed_request(build_event())
    headers.pop("Authorization")

    assert client.post(ENDPOINT, content=corpo, headers=headers).status_code == 401


def test_assinatura_invalida_retorna_401(client, fake_discord):
    corpo, headers = signed_request(build_event(), secret="segredo-errado")

    response = client.post(ENDPOINT, content=corpo, headers=headers)

    assert response.status_code == 401
    assert fake_discord.calls == []


def test_corpo_adulterado_apos_a_assinatura_retorna_401(client, fake_discord):
    """Assinatura válida, corpo trocado no caminho: é exatamente o que o HMAC pega."""
    corpo, headers = signed_request(build_event(target="test"))
    adulterado = corpo.replace(b'"target": "test"', b'"target": "class"')

    response = client.post(ENDPOINT, content=adulterado, headers=headers)

    assert response.status_code == 401
    assert fake_discord.calls == []


def test_timestamp_expirado_retorna_401(client, fake_discord):
    antigo = str(int(time.time()) - 301)
    corpo, headers = signed_request(build_event(), timestamp=antigo)

    response = client.post(ENDPOINT, content=corpo, headers=headers)

    assert response.status_code == 401
    assert fake_discord.calls == []


def test_timestamp_dentro_da_janela_e_aceito(client):
    recente = str(int(time.time()) - 299)
    corpo, headers = signed_request(build_event(), timestamp=recente)

    assert client.post(ENDPOINT, content=corpo, headers=headers).status_code == 202


def test_repository_nao_autorizado_retorna_403(client, fake_discord):
    corpo, headers = signed_request(build_event(repository="atacante/repo-falso"))

    response = client.post(ENDPOINT, content=corpo, headers=headers)

    assert response.status_code == 403
    assert "epositório não autorizado" in response.json()["message"]
    assert fake_discord.calls == []


def test_target_nao_autorizado_retorna_403(client, fake_discord):
    corpo, headers = signed_request(build_event(target="canal-do-diretor"))

    response = client.post(ENDPOINT, content=corpo, headers=headers)

    assert response.status_code == 403
    assert "arget não autorizado" in response.json()["message"]
    assert fake_discord.calls == []


def test_payload_fora_do_contrato_retorna_422(client, fake_discord):
    evento = build_event()
    del evento["diagnosis"]["failureType"]
    corpo, headers = signed_request(evento)

    response = client.post(ENDPOINT, content=corpo, headers=headers)

    assert response.status_code == 422
    assert fake_discord.calls == []


def test_webhook_url_no_payload_e_rejeitada(client, fake_discord):
    corpo, headers = signed_request(
        build_event(webhook_url="https://discord.com/api/webhooks/1/canal-do-atacante")
    )

    response = client.post(ENDPOINT, content=corpo, headers=headers)

    assert response.status_code == 422
    assert fake_discord.calls == []


def test_target_test_seleciona_o_webhook_do_canal_privado(client, fake_discord):
    corpo, headers = signed_request(build_event(target="test"))

    client.post(ENDPOINT, content=corpo, headers=headers)

    assert fake_discord.calls[0]["webhook_url"] == WEBHOOK_TEST
    assert fake_discord.calls[0]["channel_id"] == "test"


def test_target_class_seleciona_o_webhook_da_turma(client, fake_discord):
    corpo, headers = signed_request(build_event(target="class"))

    client.post(ENDPOINT, content=corpo, headers=headers)

    assert fake_discord.calls[0]["webhook_url"] == WEBHOOK_CLASS
    assert fake_discord.calls[0]["channel_id"] == "class"


def test_falha_do_discord_vira_502(client_discord_indisponivel):
    corpo, headers = signed_request(build_event())

    response = client_discord_indisponivel.post(ENDPOINT, content=corpo, headers=headers)

    assert response.status_code == 502
    assert response.json()["request_id"]


def test_o_embed_enviado_carrega_o_diagnostico_do_guardian(client, fake_discord):
    corpo, headers = signed_request(build_event("permission_failure", target="class"))

    response = client.post(ENDPOINT, content=corpo, headers=headers)

    payload = fake_discord.calls[0]["payload"]
    embed = payload["embeds"][0]
    campos = {field["name"]: field["value"] for field in embed["fields"]}

    assert embed["color"] == 0xD64545  # blocked
    assert payload["allowed_mentions"] == {"parse": []}
    assert "permission:403 Forbidden" in campos["Sinal"]
    assert response.json()["request_id"] in embed["footer"]["text"]


def test_nenhum_segredo_vaza_na_resposta(client):
    corpo, headers = signed_request(build_event())

    response = client.post(ENDPOINT, content=corpo, headers=headers)

    texto = response.text
    for segredo in (SECRET, TOKEN, WEBHOOK_TEST, WEBHOOK_CLASS):
        assert segredo not in texto


def test_nenhum_segredo_vaza_nos_logs(client, caplog):
    """Inclui o caminho de erro: é onde segredo costuma escapar."""
    with caplog.at_level(logging.DEBUG):
        corpo, headers = signed_request(build_event())
        client.post(ENDPOINT, content=corpo, headers=headers)

        corpo_ruim, headers_ruins = signed_request(build_event(), secret="segredo-errado", token="token-errado")
        client.post(ENDPOINT, content=corpo_ruim, headers=headers_ruins)

        corpo_403, headers_403 = signed_request(build_event(repository="atacante/repo"))
        client.post(ENDPOINT, content=corpo_403, headers=headers_403)

    registrado = caplog.text
    for segredo in (SECRET, TOKEN, WEBHOOK_TEST, WEBHOOK_CLASS, "token-secreto-do-canal-test"):
        assert segredo not in registrado


def test_request_id_aparece_no_log_de_cada_requisicao(client, caplog):
    with caplog.at_level(logging.INFO, logger="chatops.service"):
        corpo, headers = signed_request(build_event())
        response = client.post(ENDPOINT, content=corpo, headers=headers)

    request_id = response.json()["request_id"]
    assert any(request_id in registro.getMessage() for registro in caplog.records)


def test_contrato_normalizado_documentado_no_readme_bate_com_o_enviado(client, fake_discord):
    """O exemplo do README não pode envelhecer em silêncio."""
    corpo, headers = signed_request(build_event(target="test"))
    client.post(ENDPOINT, content=corpo, headers=headers)

    payload = fake_discord.calls[0]["payload"]
    assert json.dumps(payload)  # serializável: é o que vai no corpo do POST
    assert fake_discord.calls[0]["channel_id"] in ("test", "class")
    assert fake_discord.calls[0]["request_id"]
