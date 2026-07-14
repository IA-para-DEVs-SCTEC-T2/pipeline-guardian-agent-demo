"""Serviço de aplicação: onde as regras de autorização e o roteamento moram.

O caso de uso completo, sem HTTP e sem Discord: recebe um evento já autenticado,
normaliza, autoriza, formata e entrega. As allowlists ficam **aqui**, e não no
schema Pydantic, porque negar um repositório é uma decisão de negócio (403 —
"sei quem você é, e não pode"), não um erro de formato (422).
"""

from __future__ import annotations

import logging

from chatops.app.adapters.inbound.github_actions import to_chatops_command
from chatops.app.adapters.outbound.discord import DiscordEmbedFormatter
from chatops.app.clients.discord_webhook import DiscordWebhookClient
from chatops.app.config import Settings
from chatops.app.models import ChatOpsCommand, InboundEvent

logger = logging.getLogger("chatops.service")


class NotAuthorized(PermissionError):
    """Repositório ou canal fora da allowlist."""


class ChannelNotConfigured(RuntimeError):
    """Canal permitido, mas sem webhook configurado no ambiente."""


class ChatOpsService:
    def __init__(
        self,
        *,
        settings: Settings,
        formatter: DiscordEmbedFormatter,
        client: DiscordWebhookClient,
    ) -> None:
        self._settings = settings
        self._formatter = formatter
        self._client = client

    def normalize(self, event: InboundEvent, request_id: str) -> ChatOpsCommand:
        return to_chatops_command(event, request_id)

    def authorize(self, event: InboundEvent, request_id: str) -> None:
        """Allowlist de repositório e de canal. Fail-closed."""
        if event.repository != self._settings.allowed_repository:
            logger.warning(
                "request_id=%s repositório não autorizado: %s",
                request_id,
                event.repository,
            )
            raise NotAuthorized("Repositório não autorizado.")

        if event.target not in self._settings.allowed_targets:
            logger.warning("request_id=%s target não autorizado: %s", request_id, event.target)
            raise NotAuthorized("Target não autorizado.")

    async def handle(self, event: InboundEvent, request_id: str) -> dict[str, str | None]:
        self.authorize(event, request_id)

        command = self.normalize(event, request_id)

        webhook = self._settings.webhook_url_for(command.response_target)
        if webhook is None:
            logger.error(
                "request_id=%s canal=%s sem webhook configurado",
                request_id,
                command.response_target,
            )
            raise ChannelNotConfigured(
                f"Canal '{command.response_target}' não tem webhook configurado."
            )

        payload = self._formatter.format(command)

        logger.info(
            "request_id=%s comando=%s repo=%s branch=%s canal=%s decisão=%s status=%s",
            request_id,
            command.command,
            command.arguments["repository"],
            command.arguments["branch"],
            command.response_target,
            command.diagnosis.deploy_decision,
            command.diagnosis.pipeline_status,
        )

        message_id = await self._client.send(
            webhook.get_secret_value(),
            payload,
            request_id=request_id,
            channel_id=command.response_target,
        )

        return {"request_id": request_id, "message_id": message_id}
