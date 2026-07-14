"""Adaptador de entrada: GitHub Actions → contrato normalizado.

Função pura, sem I/O e sem decisão de segurança. Traduz o envelope de transporte
no `ChatOpsCommand` que o resto da aplicação entende. Trocar a origem (GitLab,
Jenkins, um `curl` manual) é escrever outro adaptador como este — nada abaixo
daqui muda.
"""

from __future__ import annotations

from chatops.app.models import ChatOpsCommand, InboundEvent


def to_chatops_command(event: InboundEvent, request_id: str) -> ChatOpsCommand:
    """Normaliza o evento do GitHub Actions.

    `channel_id` é o canal **lógico** (`test` ou `class`), nunca um snowflake nem
    uma URL: a tradução para o webhook real acontece no serviço, a partir do
    ambiente.
    """
    return ChatOpsCommand(
        channel="discord",
        channel_id=event.target,
        user_id="github-actions",
        command="pipeline-diagnosis",
        arguments={
            "repository": event.repository,
            "branch": event.branch,
            "commit_sha": event.commit_sha,
            "run_url": event.run_url,
            "diagnosis": event.diagnosis,
        },
        response_target=event.target,
        request_id=request_id,
    )
