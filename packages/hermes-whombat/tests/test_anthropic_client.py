"""Hermes's Anthropic API-key client (HE-S297): its SDK is in the environment Hermes runs on, not one Hermes's package
manager installs on demand. The relay endpoint case checks SDK configuration; Claude gateway turns use DirectSDK
(CDS-04), whose client and routing are tested separately."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from .conftest import needs_hermes

RELAY = "http://127.0.0.1:47104/ai-gateway/claude"


@needs_hermes
def test_the_anthropic_sdk_is_in_hermess_own_environment():
    spec = importlib.util.find_spec("anthropic")
    assert spec is not None and spec.origin is not None
    assert Path(spec.origin).is_relative_to(sys.prefix), spec.origin


@needs_hermes
def test_hermes_builds_its_anthropic_client_for_the_gateways_relay(monkeypatch):
    from agent.anthropic_adapter import build_anthropic_client

    # The turn's sandbox passes none of these; the SDK would take them as defaults.
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        monkeypatch.delenv(name, raising=False)
    client = build_anthropic_client("whombat-pod", RELAY, timeout=5)
    assert str(client.base_url).rstrip("/") == RELAY
    # The forwarder and the relay take the turn's key from `x-api-key` (HE-S50).
    assert client.api_key == "whombat-pod" and client.auth_token is None
