"""Cliente HTTP do incoming webhook do Discord.

Incoming webhook, não bot: sem gateway, sem sessão, sem token de bot. Uma URL
secreta que aceita POST — e é justamente por ser um segredo em formato de URL
que **ela nunca é logada, nem em erro, nem em traceback**. As mensagens de erro
citam o canal lógico (`test`/`class`), nunca o destino real.

`?wait=true` faz o Discord responder com a mensagem criada, o que dá um
`message_id` para conferir. Sem isso, a resposta é 204 e o envio é um "confie em
mim".
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

logger = logging.getLogger("chatops.discord")

#: Teto de espera ao respeitar o `retry_after` de um 429.
MAX_RETRY_AFTER_SECONDS = 30.0


class DiscordDeliveryError(RuntimeError):
    """Falha ao entregar a mensagem. A mensagem nunca contém a URL do webhook."""


class DiscordWebhookClient:
    """Publica uma mensagem em um incoming webhook, com retry limitado."""

    def __init__(
        self,
        *,
        timeout_seconds: float = 10.0,
        max_attempts: int = 3,
        client: httpx.AsyncClient | None = None,
        sleep=asyncio.sleep,
    ) -> None:
        self._timeout = httpx.Timeout(timeout_seconds)
        self._max_attempts = max(1, max_attempts)
        self._client = client
        self._owns_client = client is None
        self._sleep = sleep

    async def __aenter__(self) -> "DiscordWebhookClient":
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
            self._owns_client = True
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    async def send(
        self,
        webhook_url: str,
        payload: dict[str, Any],
        *,
        request_id: str,
        channel_id: str,
    ) -> str | None:
        """Publica o payload e devolve o `message_id` (ou `None`, se o Discord não devolver).

        Erros de rede e 5xx são retentados; 4xx (fora do 429) não — um payload
        inválido continuará inválido na terceira tentativa.
        """
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
            self._owns_client = True

        url = f"{webhook_url}{'&' if '?' in webhook_url else '?'}wait=true"
        ultimo_erro = "erro desconhecido"

        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._client.post(url, json=payload, timeout=self._timeout)
            except httpx.HTTPError as error:
                # `error` pode carregar a URL no repr — só o tipo entra no log.
                ultimo_erro = f"falha de rede ({type(error).__name__})"
                logger.warning(
                    "request_id=%s canal=%s tentativa=%s/%s falha de rede: %s",
                    request_id,
                    channel_id,
                    attempt,
                    self._max_attempts,
                    type(error).__name__,
                )
                if attempt < self._max_attempts:
                    await self._sleep(min(2**attempt * 0.5, MAX_RETRY_AFTER_SECONDS))
                    continue
                break

            if response.status_code == 429:
                espera = _retry_after(response)
                ultimo_erro = "rate limit do Discord (429)"
                logger.warning(
                    "request_id=%s canal=%s tentativa=%s/%s 429, aguardando %.2fs",
                    request_id,
                    channel_id,
                    attempt,
                    self._max_attempts,
                    espera,
                )
                if attempt < self._max_attempts:
                    await self._sleep(espera)
                    continue
                break

            if response.status_code >= 500:
                ultimo_erro = f"erro do Discord (HTTP {response.status_code})"
                logger.warning(
                    "request_id=%s canal=%s tentativa=%s/%s HTTP %s",
                    request_id,
                    channel_id,
                    attempt,
                    self._max_attempts,
                    response.status_code,
                )
                if attempt < self._max_attempts:
                    await self._sleep(min(2**attempt * 0.5, MAX_RETRY_AFTER_SECONDS))
                    continue
                break

            if response.status_code >= 400:
                # 4xx não se resolve repetindo: falha agora, sem gastar tentativa.
                logger.error(
                    "request_id=%s canal=%s recusado pelo Discord: HTTP %s",
                    request_id,
                    channel_id,
                    response.status_code,
                )
                raise DiscordDeliveryError(
                    f"Discord recusou a mensagem no canal '{channel_id}' (HTTP {response.status_code})."
                )

            message_id = _message_id(response)
            logger.info(
                "request_id=%s canal=%s mensagem publicada message_id=%s tentativa=%s",
                request_id,
                channel_id,
                message_id,
                attempt,
            )
            return message_id

        logger.error(
            "request_id=%s canal=%s entrega falhou após %s tentativas: %s",
            request_id,
            channel_id,
            self._max_attempts,
            ultimo_erro,
        )
        raise DiscordDeliveryError(
            f"Não foi possível publicar no canal '{channel_id}' após "
            f"{self._max_attempts} tentativas: {ultimo_erro}."
        )


def _retry_after(response: httpx.Response) -> float:
    """Lê o `retry_after` do 429 — do corpo (segundos, float) ou do header."""
    try:
        body = response.json()
        if isinstance(body, dict) and body.get("retry_after") is not None:
            return min(float(body["retry_after"]), MAX_RETRY_AFTER_SECONDS)
    except (ValueError, TypeError):
        pass

    header = response.headers.get("Retry-After")
    if header:
        try:
            return min(float(header), MAX_RETRY_AFTER_SECONDS)
        except ValueError:
            pass

    return 1.0


def _message_id(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        return None
    return body.get("id") if isinstance(body, dict) else None
