from __future__ import annotations

import os
from pathlib import Path

import pytest

def hermes_importable() -> bool:
    try:
        import run_agent  # noqa: F401
    except Exception:
        return False
    return True


needs_hermes = pytest.mark.skipif(not hermes_importable(), reason="Hermes Agent is not importable")


@pytest.fixture
def hermes_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def write_config(home: Path, text: str) -> None:
    (home / "config.yaml").write_text(text, encoding="utf-8")


def flag_value(argv: list[str], name: str):
    for i, a in enumerate(argv):
        if a == name and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return None


@pytest.fixture(autouse=True)
def _quiet_env(monkeypatch: pytest.MonkeyPatch):
    # The host's own sign-in and Hermes settings never leak into a unit test.
    for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TERMINAL_ENV"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("HERMES_QUIET", "1")
    yield
    for key in ("WHOMBAT_COMMANDS_NODE", "WHOMBAT_COMMANDS_LAUNCHER", "WHOMBAT_COMMANDS_HOME", "WHOMBAT_COMMANDS_CGROUP"):
        os.environ.pop(key, None)
