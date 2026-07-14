"""Ambiente dos testes.

Nenhum teste toca o Discord: o cliente HTTP é substituído por um dublê que
apenas registra o que receberia. Um teste que dispara mensagem de verdade em um
canal é um teste que ninguém roda duas vezes.

Os valores abaixo são segredos *de teste*, e existem para uma finalidade
específica: garantir que eles **não** aparecem em log nem em resposta HTTP.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "chatops" / "fixtures"
sys.path.insert(0, str(REPO_ROOT))

SECRET = "segredo-de-teste-nao-use-em-producao"
TOKEN = "token-de-teste-nao-use-em-producao"
WEBHOOK_TEST = "https://discord.com/api/webhooks/111111/token-secreto-do-canal-test"
WEBHOOK_CLASS = "https://discord.com/api/webhooks/222222/token-secreto-do-canal-class"
REPOSITORY = "senai/copa-figurinhas"

# Precisa valer antes de qualquer import de `chatops.app.config`.
os.environ.update(
    {
        "CHATOPS_SHARED_SECRET": SECRET,
        "CHATOPS_API_TOKEN": TOKEN,
        "DISCORD_WEBHOOK_URL_TEST": WEBHOOK_TEST,
        "DISCORD_WEBHOOK_URL_CLASS": WEBHOOK_CLASS,
        "ALLOWED_REPOSITORY": REPOSITORY,
        "MAX_TIMESTAMP_SKEW_SECONDS": "300",
    }
)

from fastapi.testclient import TestClient  # noqa: E402

from chatops.app.adapters.outbound.discord import DiscordEmbedFormatter  # noqa: E402
from chatops.app.clients.discord_webhook import DiscordDeliveryError  # noqa: E402
from chatops.app.config import get_settings  # noqa: E402
from chatops.app.main import app, get_service  # noqa: E402
from chatops.app.security.signature import sign  # noqa: E402
from chatops.app.services.chatops_service import ChatOpsService  # noqa: E402


class FakeDiscordClient:
    """Dublê do cliente do Discord: registra o envio, não faz rede."""

    def __init__(self, *, message_id: str = "1234567890", error: Exception | None = None) -> None:
        self.message_id = message_id
        self.error = error
        self.calls: list[dict[str, Any]] = []

    async def send(
        self,
        webhook_url: str,
        payload: dict[str, Any],
        *,
        request_id: str,
        channel_id: str,
    ) -> str | None:
        self.calls.append(
            {
                "webhook_url": webhook_url,
                "payload": payload,
                "request_id": request_id,
                "channel_id": channel_id,
            }
        )
        if self.error is not None:
            raise self.error
        return self.message_id

    async def aclose(self) -> None:  # pragma: no cover - simetria com o cliente real
        pass


@pytest.fixture(autouse=True)
def _settings_limpas():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def fake_discord() -> FakeDiscordClient:
    return FakeDiscordClient()


@pytest.fixture
def client(fake_discord: FakeDiscordClient):
    """TestClient com o Discord dublado."""

    def _service_dublado() -> ChatOpsService:
        return ChatOpsService(
            settings=get_settings(),
            formatter=DiscordEmbedFormatter(),
            client=fake_discord,  # type: ignore[arg-type]
        )

    app.dependency_overrides[get_service] = _service_dublado
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def client_discord_indisponivel():
    """TestClient em que o Discord falha na entrega."""
    quebrado = FakeDiscordClient(error=DiscordDeliveryError("Não foi possível publicar no canal 'test'."))

    def _service_dublado() -> ChatOpsService:
        return ChatOpsService(
            settings=get_settings(),
            formatter=DiscordEmbedFormatter(),
            client=quebrado,  # type: ignore[arg-type]
        )

    app.dependency_overrides[get_service] = _service_dublado
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def load_fixture(scenario: str = "test_failure") -> dict[str, Any]:
    return json.loads((FIXTURES_DIR / f"{scenario}.json").read_text(encoding="utf-8"))


def build_event(scenario: str = "test_failure", *, target: str = "test", **overrides: Any) -> dict[str, Any]:
    diagnosis = load_fixture(scenario)
    event = {
        "event_type": "pipeline_diagnosis",
        "source": "github_actions",
        "repository": REPOSITORY,
        "branch": diagnosis["branch"],
        "commit_sha": diagnosis["commitSha"],
        "run_id": "17293847561",
        "run_url": f"https://github.com/{REPOSITORY}/actions/runs/17293847561",
        "target": target,
        "diagnosis": diagnosis,
    }
    event.update(overrides)
    return event


def signed_request(
    event: dict[str, Any],
    *,
    secret: str = SECRET,
    token: str = TOKEN,
    timestamp: str | None = None,
) -> tuple[bytes, dict[str, str]]:
    """Corpo bruto + headers assinados — o mesmo caminho do CI."""
    raw_body = json.dumps(event, ensure_ascii=False).encode("utf-8")
    ts = timestamp if timestamp is not None else str(int(time.time()))
    return raw_body, {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "X-ChatOps-Timestamp": ts,
        "X-ChatOps-Signature": sign(secret, ts, raw_body),
    }
