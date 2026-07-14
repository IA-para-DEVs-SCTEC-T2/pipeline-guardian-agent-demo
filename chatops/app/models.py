"""Modelos de entrada e o contrato normalizado interno.

`Diagnosis` espelha **exatamente** o `reports/diagnosis.json` produzido pelo
Pipeline Guardian (`automation/schemas/diagnosis-schema.mjs`). O JSON é
camelCase; aqui os atributos são snake_case e o alias faz a ponte. Não existe um
segundo schema de diagnóstico neste projeto: se o Guardian mudar, este modelo
muda junto.

Os campos "enum" (`pipelineStatus`, `failureType`, `deployDecision`, ...) chegam
como `str`, não como `Literal`. Um valor novo vindo do Guardian não pode
derrubar a notificação: o formatador cai para a cor de fallback e segue. Quem
fecha a porta é a allowlist (`repository`, `target`), no serviço.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

# Valores conhecidos, replicados de automation/schemas/diagnosis-schema.mjs.
PIPELINE_STATUSES = ("success", "failed", "partial")
FAILURE_TYPES = (
    "lint",
    "test",
    "dependency",
    "build",
    "environment",
    "permission",
    "security",
    "unknown",
)
DEPLOY_DECISIONS = ("eligible_for_staging", "blocked", "requires_human_approval")

#: Domínios de webhook do Discord. Nenhum deles pode chegar pelo payload.
_DISCORD_HOSTS = ("discord.com", "discordapp.com", "discord.gg", "canary.discord.com")


class Evidence(BaseModel):
    """Trecho concreto que sustenta o diagnóstico."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    source: str
    excerpt: str


class Diagnosis(BaseModel):
    """Diagnóstico do Pipeline Guardian, tal como sai do `diagnosis.json`.

    Note o que **não** está aqui: os motivos da política (`policy.reasons`). O
    Guardian só os grava no `diagnosis.md`, nunca no JSON. A decisão em si
    (`deployDecision`, `requiresHumanApproval`) está — e é dela que o embed
    deriva o bloco "decisão da política".
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    analysis_id: str
    request_id: str
    repository: str
    branch: str
    commit_sha: str
    pipeline_status: str
    summary: str
    signal: str
    failure_type: str
    probable_cause: str
    evidence: list[Evidence] = Field(default_factory=list)
    impact: str
    risk_level: str
    confidence: str
    next_steps: list[str] = Field(default_factory=list)
    deploy_decision: str
    requires_human_approval: bool
    limitations: list[str] = Field(default_factory=list)
    used_fallback: bool = False
    generated_at: str


class InboundEvent(BaseModel):
    """Envelope de transporte enviado pelo GitHub Actions.

    `extra="forbid"`: um campo a mais no corpo é rejeitado. É o que impede que
    alguém contrabandeie um `webhook_url` no payload — a regra de que URL do
    Discord só vem do ambiente vale já na borda do modelo.
    """

    model_config = ConfigDict(extra="forbid")

    event_type: Literal["pipeline_diagnosis"]
    source: Literal["github_actions"]
    repository: str
    branch: str
    commit_sha: str
    run_id: str
    run_url: str
    # `target` é `str`, e não `Literal`, de propósito: um alvo desconhecido deve
    # bater na allowlist do serviço (403 explícito), não virar um 422 de schema.
    target: str
    diagnosis: Diagnosis

    @field_validator("run_url")
    @classmethod
    def _sem_url_do_discord(cls, value: str) -> str:
        lowered = value.lower()
        if not lowered.startswith("https://"):
            raise ValueError("run_url deve ser https.")
        if any(host in lowered for host in _DISCORD_HOSTS):
            raise ValueError("run_url não pode apontar para o Discord.")
        return value


class ChatOpsCommand(BaseModel):
    """Contrato normalizado interno.

    A partir daqui ninguém mais sabe que a origem foi o GitHub Actions: é um
    comando de ChatOps como outro qualquer.
    """

    model_config = ConfigDict(extra="forbid")

    channel: Literal["discord"] = "discord"
    channel_id: str
    user_id: str = "github-actions"
    command: str = "pipeline-diagnosis"
    arguments: dict[str, Any]
    response_target: str
    request_id: str

    @property
    def diagnosis(self) -> Diagnosis:
        return self.arguments["diagnosis"]
