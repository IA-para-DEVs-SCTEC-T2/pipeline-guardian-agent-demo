"""Adaptador de entrada: GitHub Actions → contrato normalizado."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from chatops.app.adapters.inbound.github_actions import to_chatops_command
from chatops.app.models import InboundEvent

from .conftest import build_event, load_fixture


def test_normaliza_o_evento_no_contrato_de_chatops():
    event = InboundEvent.model_validate(build_event("test_failure", target="class"))

    command = to_chatops_command(event, request_id="req-123")

    assert command.channel == "discord"
    assert command.channel_id == "class"
    assert command.user_id == "github-actions"
    assert command.command == "pipeline-diagnosis"
    assert command.response_target == "class"
    assert command.request_id == "req-123"

    assert set(command.arguments) == {"repository", "branch", "commit_sha", "run_url", "diagnosis"}
    assert command.arguments["repository"] == "senai/copa-figurinhas"
    assert command.arguments["branch"] == "feat/ordenar-figurinhas"
    assert command.arguments["run_url"].startswith("https://github.com/")


def test_diagnostico_atravessa_o_adaptador_sem_perder_campo():
    """O contrato normalizado carrega o diagnóstico do Guardian, não uma cópia empobrecida."""
    original = load_fixture("test_failure")
    event = InboundEvent.model_validate(build_event("test_failure"))

    diagnosis = to_chatops_command(event, request_id="req-1").diagnosis

    assert diagnosis.analysis_id == original["analysisId"]
    assert diagnosis.failure_type == original["failureType"]
    assert diagnosis.deploy_decision == original["deployDecision"]
    assert diagnosis.requires_human_approval is original["requiresHumanApproval"]
    assert diagnosis.used_fallback is original["usedFallback"]
    assert diagnosis.next_steps == original["nextSteps"]
    assert diagnosis.evidence[0].source == original["evidence"][0]["source"]
    assert diagnosis.generated_at == original["generatedAt"]


@pytest.mark.parametrize("scenario", ["test_failure", "dependency_failure", "environment_failure", "permission_failure"])
def test_as_quatro_fixtures_batem_com_o_schema_real_do_guardian(scenario: str):
    event = InboundEvent.model_validate(build_event(scenario))
    assert event.diagnosis.repository == "senai/copa-figurinhas"
    assert event.diagnosis.summary


def test_campo_extra_no_payload_e_rejeitado():
    """A porta fechada que impede contrabandear um `webhook_url` no corpo."""
    with pytest.raises(ValidationError):
        InboundEvent.model_validate(
            build_event(webhook_url="https://discord.com/api/webhooks/1/roubado")
        )


def test_run_url_apontando_para_o_discord_e_rejeitada():
    with pytest.raises(ValidationError):
        InboundEvent.model_validate(
            build_event(run_url="https://discord.com/api/webhooks/1/token")
        )


def test_run_url_precisa_ser_https():
    with pytest.raises(ValidationError):
        InboundEvent.model_validate(build_event(run_url="http://github.com/senai/copa/actions/runs/1"))


def test_event_type_e_source_sao_fixos():
    with pytest.raises(ValidationError):
        InboundEvent.model_validate(build_event(event_type="deploy_request"))
    with pytest.raises(ValidationError):
        InboundEvent.model_validate(build_event(source="jenkins"))
