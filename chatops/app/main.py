"""Borda HTTP do ChatOps.

Ordem das verificações (barata → cara, e a mais reveladora por último):
token → timestamp → assinatura → schema → allowlist → Discord.

O corpo é lido como **bytes** e a assinatura é conferida sobre esses bytes, antes
de qualquer parse. FastAPI não valida o payload antes: um corpo que não passa no
HMAC nunca chega a virar objeto.

Nenhuma resposta e nenhum log carrega segredo — nem o token, nem o segredo
compartilhado, nem a URL do webhook. O que circula é o `request_id`, e é por ele
que se correlaciona o que aconteceu.
"""

from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from chatops.app.adapters.outbound.discord import DiscordEmbedFormatter
from chatops.app.clients.discord_webhook import DiscordDeliveryError, DiscordWebhookClient
from chatops.app.config import Settings, get_settings
from chatops.app.models import InboundEvent
from chatops.app.security.signature import (
    verify_bearer_token,
    verify_signature,
    verify_timestamp,
)
from chatops.app.services.chatops_service import (
    ChannelNotConfigured,
    ChatOpsService,
    NotAuthorized,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
logger = logging.getLogger("chatops.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.client = DiscordWebhookClient(
        timeout_seconds=settings.discord_timeout_seconds,
        max_attempts=settings.discord_max_attempts,
    )
    yield
    await app.state.client.aclose()


app = FastAPI(
    title="ChatOps · Pipeline Guardian → Discord",
    version="1.0.0",
    description="Transporta o diagnóstico do Pipeline Guardian do CI para o Discord.",
    lifespan=lifespan,
)


def get_service(request: Request) -> ChatOpsService:
    settings = get_settings()
    return ChatOpsService(
        settings=settings,
        formatter=DiscordEmbedFormatter(),
        client=request.app.state.client,
    )


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "chatops-discord"}


@app.post("/webhooks/github-actions")
async def receive_github_actions_event(
    request: Request,
    service: Annotated[ChatOpsService, Depends(get_service)],
    authorization: Annotated[str | None, Header()] = None,
    x_chatops_timestamp: Annotated[str | None, Header()] = None,
    x_chatops_signature: Annotated[str | None, Header()] = None,
) -> JSONResponse:
    settings: Settings = get_settings()
    request_id = str(uuid.uuid4())

    raw_body = await request.body()

    if not verify_bearer_token(authorization, settings.chatops_api_token.get_secret_value()):
        logger.warning("request_id=%s token inválido ou ausente", request_id)
        return _erro(401, "Credenciais inválidas.", request_id)

    if not verify_timestamp(x_chatops_timestamp, settings.max_timestamp_skew_seconds):
        logger.warning("request_id=%s timestamp ausente, inválido ou fora da janela", request_id)
        return _erro(401, "Timestamp ausente, inválido ou fora da janela permitida.", request_id)

    if not verify_signature(
        settings.chatops_shared_secret.get_secret_value(),
        x_chatops_timestamp or "",
        raw_body,
        x_chatops_signature,
    ):
        logger.warning("request_id=%s assinatura inválida", request_id)
        return _erro(401, "Assinatura inválida.", request_id)

    try:
        event = InboundEvent.model_validate_json(raw_body)
    except ValidationError as error:
        logger.warning("request_id=%s payload inválido: %s erro(s)", request_id, error.error_count())
        return _erro(422, "Payload fora do contrato esperado.", request_id)

    try:
        resultado = await service.handle(event, request_id)
    except NotAuthorized as error:
        return _erro(403, str(error), request_id)
    except ChannelNotConfigured as error:
        return _erro(503, str(error), request_id)
    except DiscordDeliveryError as error:
        return _erro(502, str(error), request_id)

    return JSONResponse(
        status_code=202,
        content={
            "status": "accepted",
            "request_id": resultado["request_id"],
            "message_id": resultado["message_id"],
        },
        headers={"X-Request-Id": request_id},
    )


def _erro(status: int, message: str, request_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"status": "rejected", "message": message, "request_id": request_id},
        headers={"X-Request-Id": request_id},
    )
