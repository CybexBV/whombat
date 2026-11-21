"""The commands terminal backend and the prompt sections."""

from __future__ import annotations

import time

import pytest

from whombat_hermes.prompt import MAX_CHARS, notes_section, whombat_section

from .conftest import needs_hermes


def test_the_prompt_section_reads_whombat_md(hermes_home):
    assert whombat_section() == ""
    (hermes_home / "whombat.md").write_text("You are Dusty, Lumio's agent.\n", encoding="utf-8")
    assert whombat_section() == "You are Dusty, Lumio's agent."
    (hermes_home / "whombat.md").write_text("x" * (MAX_CHARS + 10), encoding="utf-8")
    assert len(whombat_section()) == MAX_CHARS


def test_the_notes_section_reads_whombat_notes_md(hermes_home):
    assert notes_section() == ""
    (hermes_home / "whombat-notes.md").write_text("## Notes from Mara\nDeploys on Tuesdays.\n")
    assert notes_section().endswith("Deploys on Tuesdays.")


@needs_hermes
def test_the_commands_backend_runs_every_command_through_the_launcher(tmp_path, monkeypatch):
    from whombat_hermes import terminal
    from whombat_hermes.terminal import make_provider

    log = tmp_path / "launcher.log"
    launcher = tmp_path / "whombat-command"
    # A stand-in for whombat-command.mjs (run by "node", here /bin/sh): records its argv and environment, runs it.
    launcher.write_text(f'echo "$1 $2" >> "{log}"\nenv > "{tmp_path}/env.txt"\nexec "$@"\n', encoding="utf-8")
    provider = make_provider()
    assert provider.name == "whombat_commands" and provider.supports_streams and not provider.is_available()
    monkeypatch.setenv(terminal.NODE_ENV, "/bin/sh")
    monkeypatch.setenv(terminal.LAUNCHER_ENV, str(launcher))
    monkeypatch.setenv(terminal.HOME_ENV, str(tmp_path))
    secrets = {"CLAUDE_CONFIG_DIR": "/secret/claude", "CODEX_HOME": "/secret/codex", "ANTHROPIC_API_KEY": "sk-ant",
               "ANTHROPIC_BASE_URL": "http://gw", "OPENAI_API_KEY": "sk-oa", "CLAUDE_CODE_OAUTH_TOKEN": "oat",
               "WHOMBAT_MCP_TOKEN": "mcp"}
    for key, value in secrets.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("WHOMBAT_TEST_PLAIN", "kept")
    monkeypatch.setenv("NODE_USE_ENV_PROXY", "1")
    assert provider.is_available() and provider.is_container
    # Hermes strips these from every process it starts.
    assert set(secrets) <= provider.strip_env_keys
    env = provider.create_environment(cwd="~", timeout=30)
    try:
        assert env.cwd == str(tmp_path)
        assert env.exec_prefix() == ["/bin/sh", str(launcher)]
        result = env.execute("echo hi from a command")
    finally:
        env.cleanup()
    assert result["returncode"] == 0 and "hi from a command" in result["output"]
    assert {line.split()[0] for line in log.read_text().splitlines()} == {"bash"}
    names = {line.split("=", 1)[0] for line in (tmp_path / "env.txt").read_text().splitlines()}
    assert not names & set(secrets) and "WHOMBAT_TEST_PLAIN" in names and terminal.COMMAND_ID_ENV in names
    assert "NODE_USE_ENV_PROXY" not in names


def test_the_launcher_starts_without_nodes_proxy_switch(monkeypatch):
    from whombat_hermes.terminal import COMMAND_ID_ENV, launcher_env

    # The pod sets it for every process; the launcher's Node would load its HTTP stack for nothing.
    monkeypatch.setenv("NODE_USE_ENV_PROXY", "1")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:47101")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant")
    env = launcher_env("abc123")
    assert "NODE_USE_ENV_PROXY" not in env and "ANTHROPIC_API_KEY" not in env
    assert env["HTTPS_PROXY"] == "http://127.0.0.1:47101" and env[COMMAND_ID_ENV] == "abc123"


@needs_hermes
def test_a_stopped_command_ends_whole_even_when_its_launcher_hangs(tmp_path, monkeypatch):
    from whombat_hermes import terminal
    from whombat_hermes.terminal import make_provider

    launcher = tmp_path / "whombat-command"
    # A launcher that ignores SIGTERM: the environment kills it and writes its command's cgroup.kill itself.
    launcher.write_text('mkdir -p "$WHOMBAT_COMMANDS_CGROUP/c-$WHOMBAT_COMMAND_ID"\ntrap "" TERM\n'
                        'if [ "$2" = -lc ]; then exec "$@"; fi\nsleep 30\n', encoding="utf-8")
    cgroups = tmp_path / "cgroups"
    cgroups.mkdir()
    monkeypatch.setenv(terminal.NODE_ENV, "/bin/sh")
    monkeypatch.setenv(terminal.LAUNCHER_ENV, str(launcher))
    monkeypatch.setenv(terminal.CGROUP_ENV, str(cgroups))
    monkeypatch.setattr(terminal, "_KILL_GRACE_S", 0.2)
    env = make_provider().create_environment(cwd=str(tmp_path), timeout=30)
    try:
        proc = env._run_bash("sleep 30")
        # Once it runs (its cgroup made, SIGTERM ignored): then stopped.
        deadline = time.monotonic() + 5
        while len(list(cgroups.glob("c-*"))) < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        time.sleep(0.1)
        env._kill_process(proc)
        assert proc.wait(timeout=5) != 0
    finally:
        env.cleanup()
    kills = list(cgroups.glob("c-*/cgroup.kill"))
    assert len(kills) == 1 and kills[0].read_text() == "1"
