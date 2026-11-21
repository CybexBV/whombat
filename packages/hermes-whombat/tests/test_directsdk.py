"""The packaged official provider on the pinned, unpatched Hermes host."""
from __future__ import annotations

import hashlib
from importlib.metadata import entry_points
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from .conftest import needs_hermes


def test_vendored_provider_matches_the_pinned_upstream():
    root = Path(__file__).parents[1] / "vendor/claude-subscription-directsdk"
    pin = json.loads((root / "UPSTREAM.json").read_text())
    assert pin["commit"] == "54afaf5014db23346148436c4883eb64095e8060"
    for name, digest in pin["files"].items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name


@needs_hermes
def test_installed_provider_uses_existing_sign_in_and_never_mcp_credentials(monkeypatch, hermes_home):
    from whombat_hermes.directsdk import profile
    from whombat_claude_directsdk.directsdk_setup import apply_config_dir

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/existing/person/config")
    monkeypatch.setenv("CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND", "/installed/claude")
    monkeypatch.setenv("WHOMBAT_MCP_TOKEN", "dispatch-secret")
    monkeypatch.setenv("WHOMBAT_VAULT_MCP_0_H0", "vault-secret")
    client = profile.create_client()
    try:
        env = dict(client.env)
        apply_config_dir(env)
        assert env["CLAUDE_CONFIG_DIR"] == "/existing/person/config"
        assert client.command == ["/installed/claude"]
        assert "WHOMBAT_MCP_TOKEN" not in env and "WHOMBAT_VAULT_MCP_0_H0" not in env
        assert profile.api_mode == "chat_completions" and profile.auth_type == "external_process"
        assert profile.supports_streaming
    finally:
        client.close()


@needs_hermes
def test_native_discovery_and_usage_probes_keep_the_same_credential_boundary(monkeypatch):
    import whombat_hermes.directsdk as adapter

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/existing/sign-in")
    monkeypatch.setenv("CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND", "/installed/claude")
    monkeypatch.setenv("WHOMBAT_VAULT_MCP_0_H0", "private")
    seen = []

    def probe(**kwargs):
        seen.append(kwargs)
        return None

    monkeypatch.setattr(adapter, "setup_status", probe)
    monkeypatch.setattr(adapter, "discover_models", probe)
    monkeypatch.setattr(adapter, "fetch_usage", lambda **kwargs: (probe(**kwargs), "unavailable"))
    adapter.profile.setup_status()
    adapter.profile.discover_models()
    adapter.profile.fetch_account_usage()
    assert len(seen) == 3
    for kwargs in seen:
        assert kwargs["command"] == ["/installed/claude"]
        assert kwargs["env"]["CLAUDE_CONFIG_DIR"] == "/existing/sign-in"
        assert "WHOMBAT_VAULT_MCP_0_H0" not in kwargs["env"]


@needs_hermes
def test_claude_tool_inventory_keeps_browser_cdp_out(monkeypatch):
    from whombat_hermes.directsdk import Client, NativeClient

    captured = []
    monkeypatch.setattr(NativeClient, "create", lambda self, **kwargs: captured.extend(kwargs["tools"]))
    client = Client(env={})
    try:
        client.chat.completions.create(tools=[{"type": "function", "function": {"name": name}}
                                            for name in ("browser_cdp", "browser_navigate", "browser_vault", "memory")])
        assert [tool["function"]["name"] for tool in captured] == ["browser_navigate", "browser_vault", "memory"]
    finally:
        client.close()


@needs_hermes
def test_a_claude_model_newer_than_the_plugin_runs_with_its_own_window():
    from whombat_hermes.directsdk import gateway_profile, profile
    from whombat_claude_directsdk.model_catalog import accepts_thinking_disable, native_model

    # Fable 5.2 came after the pinned plugin: `fable` and its own id reach Claude Code as its 1M route.
    assert native_model("fable") == native_model("claude-fable-5-2") == "claude-fable-5-2[1m]"
    assert native_model("claude-fable-5-1") == "claude-fable-5-1[1m]"
    assert not accepts_thinking_disable("claude-fable-5-2")
    for p in (profile, gateway_profile):
        assert p.get_model_context_length("claude-fable-5-2[1m]") == 1_000_000
        assert p.get_model_context_length("fable") == 1_000_000
        assert p.model_capabilities["claude-fable-5-2[1m]"]["context_window"] == 1_000_000
        assert p.model_aliases["fable"] == "claude-fable-5-2[1m]"
        assert "claude-fable-5-2[1m]" in p.fallback_models


@needs_hermes
def test_entry_points_load_without_a_turn_runtime_patch(hermes_home):
    from whombat_hermes.plugin import register

    class Host:
        # Deliberately no register_turn_runtime: the upstream host has no such extension.
        def __getattr__(self, name):
            if name in {"register_hook", "register_system_prompt_section", "register_terminal_environment_provider"}:
                return lambda *args, **kwargs: None
            raise AttributeError(name)

    names = {ep.name for ep in entry_points(group="hermes_agent.plugins")}
    assert {"whombat", "claude-subscription-directsdk-experimental"} <= names
    assert "claude-cli" not in names
    register(Host())


@needs_hermes
def test_subscription_client_has_no_api_key_fallback(monkeypatch):
    from whombat_claude_directsdk.directsdk import Client

    monkeypatch.setenv("ANTHROPIC_API_KEY", "wrong-transport")
    with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
        Client().chat.completions.create(
            model="sonnet", messages=[{"role": "user", "content": "hello"}])


def gateway_config(home, *, pod=False, base="http://127.0.0.1:47104/ai-gateway/claude", **settings):
    config = {"plugins": {"entries": {"claude-subscription-directsdk-experimental": {"settings": {
        "whombat_gateway": {"base_url": base, "pod": pod}, **settings}}}}}
    (home / "config.yaml").write_text(json.dumps(config))


@needs_hermes
@pytest.mark.parametrize("pod", [False, True])
def test_gateway_client_has_only_the_relay_credential_and_no_personal_sign_in(monkeypatch, hermes_home, pod):
    from whombat_hermes.directsdk import gateway_profile

    gateway_config(hermes_home, pod=pod)
    monkeypatch.setenv("WHOMBAT_MCP_TOKEN", "gateway-turn-token")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/existing/person/config")
    monkeypatch.setenv("CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND", "/installed/claude")
    for key in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "WHOMBAT_VAULT_MCP_0_H0"):
        monkeypatch.setenv(key, "unrelated-secret")
    client = gateway_profile.create_client()
    private = Path(client.env["CLAUDE_CONFIG_DIR"])
    try:
        assert client.env["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:47104/ai-gateway/claude"
        assert client.env["ANTHROPIC_AUTH_TOKEN"] == ("whombat-pod" if pod else "gateway-turn-token")
        assert client.command == ["/installed/claude"]
        assert client.base_url == "process://whombat-claude-gateway"
        assert private.is_dir() and not list(private.iterdir())
        assert str(private) != "/existing/person/config"
        assert not {"WHOMBAT_MCP_TOKEN", "WHOMBAT_VAULT_MCP_0_H0", "CLAUDE_CODE_OAUTH_TOKEN",
                    "ANTHROPIC_API_KEY"} & client.env.keys()
        assert "unrelated-secret" not in client.env.values()
    finally:
        client.close()
    assert not private.exists()


@needs_hermes
@pytest.mark.parametrize("base", ["https://api.anthropic.com", "https://gateway.example/ai-gateway/claude",
                                 "http://secret@127.0.0.1/ai-gateway/claude", "http://127.0.0.1/mcp",
                                 "http://127.0.0.1/ai-gateway/claude?token=secret"])
def test_gateway_client_refuses_any_destination_besides_whombats_relay(monkeypatch, hermes_home, base):
    from whombat_hermes.directsdk import gateway_profile

    gateway_config(hermes_home, base=base)
    monkeypatch.setenv("WHOMBAT_MCP_TOKEN", "gateway-turn-token")
    with pytest.raises(ValueError, match="relay configuration"):
        gateway_profile.create_client()


@needs_hermes
def test_gateway_client_never_falls_back_to_a_login_or_probes_personal_usage(monkeypatch, hermes_home):
    import whombat_hermes.directsdk as adapter

    gateway_config(hermes_home)
    monkeypatch.delenv("WHOMBAT_MCP_TOKEN", raising=False)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/existing/sign-in")
    with pytest.raises(ValueError, match="active turn token"):
        adapter.gateway_profile.create_client()
    monkeypatch.setenv("WHOMBAT_MCP_TOKEN", "gateway-turn-token")
    gateway_config(hermes_home, claude_config_dir="/existing/sign-in")
    with pytest.raises(ValueError, match="relay configuration"):
        adapter.gateway_profile.create_client()
    gateway_config(hermes_home)

    def forbidden(**_):
        raise AssertionError("a gateway must not probe a personal Claude account")

    for name in ("setup_status", "discover_models", "fetch_usage"):
        monkeypatch.setattr(adapter, name, forbidden)
    assert adapter.gateway_profile.setup_status()["login_command"] is None
    assert adapter.gateway_profile.fetch_models() is None
    assert not adapter.gateway_profile.fetch_account_usage().windows


@needs_hermes
@pytest.mark.parametrize("blocked", [False, True])
@pytest.mark.parametrize("gateway", [False, True])
def test_hermes_executes_tools_and_enforces_policy_on_unpatched_host(tmp_path, blocked, gateway):
    home = tmp_path / "profile"
    home.mkdir()
    native = tmp_path / "claude"
    checks = ('[ "$ANTHROPIC_AUTH_TOKEN" = "gateway-turn-token" ] || exit 41\n'
              '[ -z "$WHOMBAT_MCP_TOKEN" ] || exit 42\n') if gateway else ""
    native.write_text(f'#!/bin/sh\n{checks}exec "{sys.executable}" "{Path(__file__).with_name("native_directsdk.py")}" "$@"\n')
    native.chmod(0o700)
    launcher = tmp_path / "whombat-command"
    launcher.write_text('exec "$@"\n')
    plugin = "claude-subscription-directsdk-experimental"
    provider = "whombat-claude-gateway" if gateway else plugin
    config = {
        "model": {"provider": provider, "default": "sonnet"},
        "plugins": {"enabled": ["whombat", plugin], "auto_update_check_hours": 0,
                    "entries": {plugin: {"settings": {"whombat_gateway": {
                        "base_url": "http://127.0.0.1:47104/ai-gateway/claude", "pod": False}}}}},
        "auth": {"adopt_external_logins": False},
        "terminal": {"backend": "whombat_commands"},
        "agent": {"disabled_toolsets": ["browser", "web"]},
        "compression": {"enabled": True},
        "auxiliary": {"title_generation": {"enabled": False}, "background_review": {"enabled": False}},
        "updates": {"check": False}, "model_catalog": {"enabled": False},
        "models_dev": {"url": "http://127.0.0.1:9/"}, "tools": {"tool_search": {"enabled": "off"}},
    }
    (home / "config.yaml").write_text(json.dumps(config))
    (home / "whombat-policy.json").write_text(json.dumps({
        "rules": [{"tools": ["memory"], "action": "block" if blocked else "allow", "message": "denied"},
                  {"tools": ["terminal"], "action": "allow"}], "default": "block"}))
    script = '''
import json, os
import model_tools
from acp_adapter.session import SessionManager
manager = SessionManager()
state = manager.create_session(cwd=os.environ["TEST_CWD"])
result = state.agent.run_conversation(user_message="WB_TEST_MEMORY", task_id=state.session_id)
terminal = state.agent.run_conversation(user_message="WB_TEST_TERMINAL", task_id=state.session_id)
print("RESULT", json.dumps({"answer": result.get("final_response"), "messages": result.get("messages"),
                           "terminal": terminal.get("messages")}), flush=True)
os._exit(0)
'''
    done = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=90,
                          env={**os.environ, "HERMES_HOME": str(home), "TEST_CWD": str(tmp_path),
                               "WHOMBAT_MCP_TOKEN": "gateway-turn-token",
                               "WHOMBAT_COMMANDS_NODE": "/bin/sh", "WHOMBAT_COMMANDS_LAUNCHER": str(launcher),
                               "CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND": str(native)})
    line = next((line for line in done.stdout.splitlines() if line.startswith("RESULT ")), None)
    assert done.returncode == 0 and line, done.stderr[-3000:]
    result = json.loads(line.removeprefix("RESULT "))
    assert result["answer"] == "done"
    memory = home / "memories/MEMORY.md"
    assert ("test.example.org" in memory.read_text() if memory.exists() else False) is (not blocked)
    tool_results = [m for m in result["messages"] if m.get("role") == "tool"]
    assert tool_results and ("denied" in json.dumps(tool_results)) is blocked
    terminal_results = [m for m in result["terminal"] if m.get("role") == "tool"]
    assert "shell-ok" in json.dumps(terminal_results)
