"""Assinatura, token e janela de tempo — isolados do HTTP."""

from __future__ import annotations

import time

from chatops.app.security.signature import (
    build_signing_payload,
    sign,
    verify_bearer_token,
    verify_signature,
    verify_timestamp,
)

# Vetor compartilhado com `automation/tests/send-chatops-event.test.mjs`.
# Se as duas linguagens divergirem na forma de montar a mensagem assinada, esta
# constante é o primeiro lugar onde isso aparece — antes de virar 401 em produção.
VETOR_SECRET = "segredo-de-teste"
VETOR_TIMESTAMP = "1700000000"
VETOR_BODY = b'{"event_type":"pipeline_diagnosis"}'
VETOR_ASSINATURA = "sha256=cb12782065cc82a42dd562e1a0d1196b30afdcc44e15ecf989972021e78a1b39"


def test_mensagem_assinada_e_timestamp_ponto_corpo():
    assert build_signing_payload("1700000000", b'{"a":1}') == b'1700000000.{"a":1}'


def test_assinatura_bate_com_o_vetor_compartilhado_com_o_node():
    assert sign(VETOR_SECRET, VETOR_TIMESTAMP, VETOR_BODY) == VETOR_ASSINATURA


def test_assinatura_valida_e_aceita():
    body = b'{"event_type":"pipeline_diagnosis"}'
    assinatura = sign("segredo", "1700000000", body)
    assert verify_signature("segredo", "1700000000", body, assinatura) is True


def test_corpo_alterado_invalida_a_assinatura():
    assinatura = sign("segredo", "1700000000", b'{"target":"test"}')
    assert verify_signature("segredo", "1700000000", b'{"target":"class"}', assinatura) is False


def test_segredo_diferente_invalida_a_assinatura():
    body = b'{"target":"test"}'
    assinatura = sign("outro-segredo", "1700000000", body)
    assert verify_signature("segredo", "1700000000", body, assinatura) is False


def test_timestamp_diferente_invalida_a_assinatura():
    body = b'{"target":"test"}'
    assinatura = sign("segredo", "1700000000", body)
    assert verify_signature("segredo", "1700000001", body, assinatura) is False


def test_assinatura_ausente_ou_sem_prefixo_e_rejeitada():
    body = b"{}"
    assert verify_signature("segredo", "1700000000", body, None) is False
    assert verify_signature("segredo", "1700000000", body, "") is False
    assert verify_signature("segredo", "1700000000", body, "abc123") is False


def test_bearer_token_valido():
    assert verify_bearer_token("Bearer token-secreto", "token-secreto") is True
    assert verify_bearer_token("bearer token-secreto", "token-secreto") is True


def test_bearer_token_invalido_ou_malformado():
    assert verify_bearer_token("Bearer errado", "token-secreto") is False
    assert verify_bearer_token("token-secreto", "token-secreto") is False
    assert verify_bearer_token("Basic token-secreto", "token-secreto") is False
    assert verify_bearer_token(None, "token-secreto") is False
    assert verify_bearer_token("Bearer ", "token-secreto") is False


def test_timestamp_recente_e_aceito():
    assert verify_timestamp(str(int(time.time())), 300) is True


def test_timestamp_expirado_e_rejeitado():
    agora = 1_700_000_000.0
    assert verify_timestamp(str(int(agora - 301)), 300, now=agora) is False
    assert verify_timestamp(str(int(agora - 299)), 300, now=agora) is True


def test_timestamp_no_futuro_e_rejeitado():
    # Janela simétrica: relógio adiantado demais é tão suspeito quanto atrasado.
    agora = 1_700_000_000.0
    assert verify_timestamp(str(int(agora + 301)), 300, now=agora) is False


def test_timestamp_ausente_ou_nao_numerico_e_rejeitado():
    assert verify_timestamp(None, 300) is False
    assert verify_timestamp("", 300) is False
    assert verify_timestamp("ontem", 300) is False
