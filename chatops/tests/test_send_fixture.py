"""Ensaio local: o repositório que a fixture alega.

A fixture traz um repositório de demonstração. Enquanto o ensaio local enviava esse
valor e o `.env` autorizava exatamente ele, o teste concordava consigo mesmo e nunca
exercitava o allowlist — um evento real do CI, com o nome verdadeiro do repositório,
seria rejeitado sem que nenhum teste local percebesse.

`resolve_repository` fecha essa brecha: por padrão o ensaio passa a alegar o mesmo
repositório que o CI alegaria.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from .conftest import REPO_ROOT, load_fixture

_spec = importlib.util.spec_from_file_location(
    "send_fixture", REPO_ROOT / "chatops" / "scripts" / "send_fixture.py"
)
assert _spec and _spec.loader
send_fixture = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(send_fixture)


OUTRO_REPO = "IA-para-DEVs-SCTEC-T2/pipeline-guardian-agent-demo"


def test_o_valor_da_linha_de_comando_tem_precedencia(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ALLOWED_REPOSITORY", "org/do-ambiente")
    diagnosis = load_fixture()

    assert send_fixture.resolve_repository(OUTRO_REPO, diagnosis) == OUTRO_REPO


def test_sem_argumento_cai_no_allowed_repository_do_ambiente(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ALLOWED_REPOSITORY", OUTRO_REPO)
    diagnosis = load_fixture()

    assert send_fixture.resolve_repository(None, diagnosis) == OUTRO_REPO


@pytest.mark.parametrize("valor", ["", "   "])
def test_allowed_repository_vazio_cai_na_fixture(valor: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ALLOWED_REPOSITORY", valor)
    diagnosis = load_fixture()

    assert send_fixture.resolve_repository(None, diagnosis) == diagnosis["repository"]


def test_sem_allowed_repository_no_ambiente_cai_na_fixture(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("ALLOWED_REPOSITORY", raising=False)
    diagnosis = load_fixture()

    assert send_fixture.resolve_repository(None, diagnosis) == diagnosis["repository"]


def test_envelope_e_diagnostico_alegam_o_mesmo_repositorio():
    """O backend confere o envelope; o Discord mostra o diagnóstico. Os dois têm de bater."""
    diagnosis = load_fixture()
    diagnosis["repository"] = send_fixture.resolve_repository(OUTRO_REPO, diagnosis)

    payload = send_fixture.build_payload(diagnosis, "test")

    assert payload["repository"] == OUTRO_REPO
    assert payload["diagnosis"]["repository"] == OUTRO_REPO
    assert payload["repository"] == payload["diagnosis"]["repository"]
    assert f"/{OUTRO_REPO}/actions/runs/" in payload["run_url"]
