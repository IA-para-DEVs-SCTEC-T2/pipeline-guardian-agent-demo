#!/usr/bin/env python3
"""Envia um diagnóstico de fixture ao ChatOps local — o mesmo caminho do CI.

O script assina exatamente como `automation/src/send-chatops-event.mjs`: HMAC
SHA-256 sobre ``timestamp.corpo_bruto``, com o corpo em bytes, nunca
reserializado. É o ensaio do laboratório sem depender de uma execução real do
GitHub Actions.

    python chatops/scripts/send_fixture.py --scenario test_failure --target test

Imprime apenas `status`, `request_id` e `message_id`. Nenhum segredo, nunca.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "chatops" / "fixtures"

sys.path.insert(0, str(REPO_ROOT))

from chatops.app.security.signature import sign  # noqa: E402

SCENARIOS = ("test_failure", "dependency_failure", "environment_failure", "permission_failure")
TARGETS = ("test", "class")


def load_env_file(path: Path) -> None:
    """Lê `chatops/.env` sem depender do FastAPI. Não sobrescreve o ambiente real."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def build_payload(diagnosis: dict, target: str) -> dict:
    """Envelope de transporte — o mesmo que o script Node monta no CI."""
    repository = diagnosis["repository"]
    run_id = os.environ.get("GITHUB_RUN_ID", "0")
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")

    return {
        "event_type": "pipeline_diagnosis",
        "source": "github_actions",
        "repository": repository,
        "branch": diagnosis["branch"],
        "commit_sha": diagnosis["commitSha"],
        "run_id": run_id,
        "run_url": f"{server}/{repository}/actions/runs/{run_id}",
        "target": target,
        "diagnosis": diagnosis,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Envia uma fixture de diagnóstico ao ChatOps.")
    parser.add_argument("--scenario", required=True, choices=SCENARIOS)
    parser.add_argument("--target", required=True, choices=TARGETS)
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("CHATOPS_ENDPOINT_URL", "http://127.0.0.1:8000"),
        help="Base do ChatOps (padrão: http://127.0.0.1:8000).",
    )
    args = parser.parse_args()

    load_env_file(REPO_ROOT / "chatops" / ".env")

    secret = os.environ.get("CHATOPS_SHARED_SECRET")
    token = os.environ.get("CHATOPS_API_TOKEN")
    if not secret or not token:
        print("erro: defina CHATOPS_SHARED_SECRET e CHATOPS_API_TOKEN (veja chatops/.env.example).")
        return 2

    diagnosis = json.loads((FIXTURES_DIR / f"{args.scenario}.json").read_text(encoding="utf-8"))
    payload = build_payload(diagnosis, args.target)

    # Assina os bytes que serão enviados — não o dict, não uma reserialização.
    raw_body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    timestamp = str(int(time.time()))

    url = args.endpoint.rstrip("/") + "/webhooks/github-actions"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "X-ChatOps-Timestamp": timestamp,
        "X-ChatOps-Signature": sign(secret, timestamp, raw_body),
    }

    try:
        response = httpx.post(url, content=raw_body, headers=headers, timeout=15.0)
    except httpx.HTTPError as error:
        print(f"status: erro de rede ({type(error).__name__}) ao chamar o ChatOps.")
        return 1

    try:
        body = response.json()
    except ValueError:
        body = {}

    print(f"status:     {response.status_code} {body.get('status', '')}".rstrip())
    print(f"request_id: {body.get('request_id', '—')}")
    print(f"message_id: {body.get('message_id', '—')}")

    if response.status_code != 202:
        print(f"message:    {body.get('message', '—')}")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
