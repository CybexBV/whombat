"""The plugin's own skills (Whombat assistant-settings.md, council.md, delegate.md): ``whombat:settings`` is registered from the files
the settings map writes, ``whombat:council`` from its own, and through Hermes's own registrar where Hermes is installed."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from whombat_hermes import plugin

from .conftest import needs_hermes


class Recorder:
    def __init__(self) -> None:
        self.skills: list[tuple[str, Path, str]] = []

    def register_skill(self, name: str, path: Path, description: str = "", **_: Any) -> None:
        self.skills.append((name, Path(path), description))


def test_registers_the_settings_skill_from_its_files() -> None:
    ctx = Recorder()
    plugin.register_skills(ctx)
    names = [name for name, _, _ in ctx.skills]
    assert names == ["settings", "council", "delegate", "connection-pages"]
    _, path, description = ctx.skills[0]
    assert path.is_file() and path.name == "SKILL.md"
    assert "name: settings" in path.read_text(encoding="utf-8")
    assert (path.parent / "references" / "this-whombat.md").is_file()
    assert "Wi-Fi" in description


def test_registers_the_council_skill_from_its_file() -> None:
    ctx = Recorder()
    plugin.register_skills(ctx)
    _, path, description = next(s for s in ctx.skills if s[0] == "council")
    text = path.read_text(encoding="utf-8")
    assert path.is_file() and "name: council" in text
    for tool in ("council_start", "council_tell", "council_finish", "council_read"):
        assert tool in text
    assert "T3 Code" in description


def test_registers_the_delegate_skill_from_its_file() -> None:
    ctx = Recorder()
    plugin.register_skills(ctx)
    _, path, description = next(s for s in ctx.skills if s[0] == "delegate")
    text = path.read_text(encoding="utf-8")
    assert path.is_file() and "name: delegate" in text
    for tool in ("delegate_offer", "delegate_update", "delegate_finish", "fast-test"):
        assert tool in text
    assert "production_release" not in text
    assert "T3 Code" in description


def test_registers_the_connection_pages_skill_from_its_file() -> None:
    ctx = Recorder()
    plugin.register_skills(ctx)
    _, path, description = next(s for s in ctx.skills if s[0] == "connection-pages")
    text = path.read_text(encoding="utf-8")
    assert path.is_file() and "name: connection-pages" in text
    for word in ("connection_look", "connection_tools", "important", "simple-icons", "dashboard-icons"):
        assert word in text
    assert "logo" in description


@needs_hermes
def test_hermes_finds_it_as_whombat_settings(tmp_path: Path) -> None:
    # Hermes loads only the plugins its config turns on, as Whombat's does; a child process of its own, so the
    # plugin manager this test's process may already have discovered (with another home) plays no part.
    home = tmp_path / "hermes-home"
    home.mkdir()
    (home / "config.yaml").write_text(json.dumps({"plugins": {"enabled": ["whombat"], "auto_update_check_hours": 0}}))
    script = """
from hermes_cli.plugins import discover_plugins, get_plugin_manager
discover_plugins()
print("SKILL", get_plugin_manager().find_plugin_skill("whombat:settings"), flush=True)
"""
    done = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=60,
                          env={**os.environ, "HERMES_HOME": str(home)})
    line = next((line for line in done.stdout.splitlines() if line.startswith("SKILL ")), None)
    assert done.returncode == 0 and line, done.stderr[-3000:]
    path = line.removeprefix("SKILL ")
    assert path != "None" and Path(path).name == "SKILL.md"
