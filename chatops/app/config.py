"""Configuração da aplicação ChatOps.

Regra central: **nenhuma URL de webhook do Discord entra pelo payload**. As URLs
existem apenas aqui, lidas do ambiente. O payload escolhe um *canal lógico*
(``test`` ou ``class``); quem traduz canal lógico em URL é este módulo.

Segredos são ``SecretStr``: o ``repr`` de ``Settings`` — que acaba em log,
traceback e mensagem de erro — mostra ``**********`` e nunca o valor.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: Canais lógicos aceitos. Também é a allowlist de ``target`` do payload.
ALLOWED_TARGETS: tuple[str, ...] = ("test", "class")


class Settings(BaseSettings):
    """Configuração lida do ambiente (ou de um ``.env`` local)."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    chatops_shared_secret: SecretStr
    chatops_api_token: SecretStr

    discord_webhook_url_test: SecretStr | None = None
    discord_webhook_url_class: SecretStr | None = None

    allowed_repository: str
    max_timestamp_skew_seconds: int = 300

    #: Timeout de rede do cliente Discord, em segundos.
    discord_timeout_seconds: float = 10.0
    #: Tentativas totais (a primeira + as repetições) por mensagem.
    discord_max_attempts: int = 3

    @field_validator("allowed_repository")
    @classmethod
    def _repository_nao_vazio(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("ALLOWED_REPOSITORY não pode ser vazio.")
        return value

    @property
    def allowed_targets(self) -> tuple[str, ...]:
        return ALLOWED_TARGETS

    def webhook_url_for(self, target: str) -> SecretStr | None:
        """URL do webhook do canal lógico, ou ``None`` se o canal não está configurado."""
        mapping: dict[str, SecretStr | None] = {
            "test": self.discord_webhook_url_test,
            "class": self.discord_webhook_url_class,
        }
        return mapping.get(target)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Instância única. Nos testes, use ``get_settings.cache_clear()``."""
    return Settings()  # type: ignore[call-arg]
