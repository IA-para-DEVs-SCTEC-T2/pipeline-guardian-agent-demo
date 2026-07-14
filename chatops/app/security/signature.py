"""Autenticação e integridade do evento vindo do GitHub Actions.

Três verificações independentes, todas em tempo constante:

1. **Bearer token** — quem é o chamador.
2. **HMAC SHA-256** sobre ``f"{timestamp}.{corpo_bruto}"`` — o corpo não foi
   alterado no caminho, e quem assinou tem o segredo compartilhado.
3. **Janela de tempo** — um evento capturado não pode ser reenviado dias depois.

A assinatura é calculada sobre o **corpo bruto** (bytes), nunca sobre o JSON
reserializado: `json.dumps` do Python e `JSON.stringify` do Node não produzem os
mesmos bytes, e qualquer normalização no meio do caminho quebraria a conferência.
`automation/src/send-chatops-event.mjs` assina exatamente os bytes que envia.
"""

from __future__ import annotations

import hashlib
import hmac
import time

#: Prefixo do header `X-ChatOps-Signature`.
SIGNATURE_PREFIX = "sha256="


def build_signing_payload(timestamp: str, raw_body: bytes) -> bytes:
    """Monta ``timestamp.corpo_bruto`` — a mensagem que é assinada."""
    return f"{timestamp}.".encode("utf-8") + raw_body


def sign(secret: str, timestamp: str, raw_body: bytes) -> str:
    """Assinatura no formato ``sha256=<hex>``."""
    digest = hmac.new(
        secret.encode("utf-8"),
        build_signing_payload(timestamp, raw_body),
        hashlib.sha256,
    ).hexdigest()
    return f"{SIGNATURE_PREFIX}{digest}"


def verify_signature(secret: str, timestamp: str, raw_body: bytes, provided: str | None) -> bool:
    """Confere a assinatura recebida contra a esperada, com ``compare_digest``."""
    if not provided or not provided.startswith(SIGNATURE_PREFIX):
        return False
    expected = sign(secret, timestamp, raw_body)
    return hmac.compare_digest(expected, provided)


def verify_bearer_token(authorization: str | None, expected_token: str) -> bool:
    """Valida ``Authorization: Bearer <token>``, também com ``compare_digest``."""
    if not authorization:
        return False

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return False

    return hmac.compare_digest(token.strip(), expected_token)


def verify_timestamp(timestamp: str | None, max_skew_seconds: int, now: float | None = None) -> bool:
    """Rejeita timestamps fora da janela de ``max_skew_seconds`` (para os dois lados).

    A janela é simétrica: um timestamp no futuro é tão suspeito quanto um velho
    demais — só significa que os relógios não batem ou que alguém o forjou.
    """
    if not timestamp:
        return False

    try:
        sent_at = int(timestamp)
    except (TypeError, ValueError):
        return False

    current = time.time() if now is None else now
    return abs(current - sent_at) <= max_skew_seconds
