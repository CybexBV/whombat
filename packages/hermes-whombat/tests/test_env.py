"""What the ``claude`` CLI, the commands' launcher and Hermes's other children get of Hermes's environment
(HE-32)."""

from __future__ import annotations

import json
import os
import subprocess
import sys

from whombat_hermes.env import cli_env, command_env

from .conftest import needs_hermes

# Provider credentials as Hermes's environment could hold them (an org key or gateway turn's, an operator's).
CREDENTIALS = {
    "ANTHROPIC_API_KEY": "sk-ant", "ANTHROPIC_AUTH_TOKEN": "tok", "ANTHROPIC_BASE_URL": "http://gateway.example",
    "OPENAI_API_KEY": "sk-oa", "OPENAI_BASE_URL": "http://local.example", "CLAUDE_CODE_OAUTH_TOKEN": "oat",
    "CLAUDE_CODE_USE_BEDROCK": "1", "CODEX_HOME": "/creds/codex", "WHOMBAT_MCP_TOKEN": "dispatch",
    "AWS_SECRET_ACCESS_KEY": "aws",
    "CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR": "/private/profile",
    "CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND": "/private/client",
}
# What the CLI needs: its sign-in home, the system, the sandbox's proxy and certificates.
NEEDED = {
    "PATH": "/usr/bin:/bin", "HOME": "/home/task", "CLAUDE_CONFIG_DIR": "/creds/claude/config",
    "HTTPS_PROXY": "http://127.0.0.1:3128", "https_proxy": "http://127.0.0.1:3128", "NO_PROXY": "127.0.0.1",
    "SSL_CERT_FILE": "/etc/ssl/certs/ca.pem", "NODE_EXTRA_CA_CERTS": "/etc/ssl/certs/ca.pem",
    "SHELL": "/bin/sh", "LC_ALL": "C.UTF-8",
    "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "credential.helper", "GIT_CONFIG_VALUE_0": "",
    "DISABLE_UPDATES": "1",
}
# Hermes's own variables the CLI has no use for.
HERMES_OWN = {"HERMES_HOME": "/profiles/p", "WHOMBAT_COMMANDS_LAUNCHER": "/run/whombat-command.mjs", "PYTHONPATH": "/x"}
HERMES_ENV = {**CREDENTIALS, **NEEDED, **HERMES_OWN}


def set_hermes_env(monkeypatch):
    """Hermes's environment in this process (its home stays the test's)."""
    for key, value in HERMES_ENV.items():
        if key != "HERMES_HOME":
            monkeypatch.setenv(key, value)


def test_the_cli_gets_only_the_allowlist_and_never_a_provider_credential():
    env = cli_env(HERMES_ENV)
    assert not set(CREDENTIALS) & set(env)
    assert not set(HERMES_OWN) & set(env)
    assert {k: env.get(k) for k in NEEDED} == NEEDED


def test_the_cli_names_its_own_entrypoint():
    # A label left by whatever started Hermes (a Claude Code or T3 Code session) must not reach the CLI.
    env = cli_env({**NEEDED, "CLAUDE_CODE_ENTRYPOINT": "sdk-ts"})
    assert "CLAUDE_CODE_ENTRYPOINT" not in env


def test_the_commands_launcher_gets_no_credential():
    env = command_env({**HERMES_ENV, "GIT_AUTHOR_NAME": "Dusty", "MAX_THINKING_TOKENS": "1"})
    assert not (set(CREDENTIALS) | {"CLAUDE_CONFIG_DIR"}) & set(env)
    assert env["GIT_AUTHOR_NAME"] == "Dusty" and env["MAX_THINKING_TOKENS"] == "1" and env["PATH"] == NEEDED["PATH"]


def test_a_vault_mcp_servers_sign_in_stays_with_hermes():
    """Hermes's MCP client reads it from its own environment; no command and no CLI gets it (HE-S154)."""
    vault = {"WHOMBAT_VAULT_MCP_0_URL": "https://ha.example.com/mcp", "WHOMBAT_VAULT_MCP_0_H0": "Bearer ha-secret"}
    assert not set(vault) & set(command_env({**HERMES_ENV, **vault}))
    assert not set(vault) & set(cli_env({**HERMES_ENV, **vault}))


@needs_hermes
def test_hermes_children_that_inherit_credentials_get_no_sign_in_home_token_or_provider_key(tmp_path):
    """Hermes applies the backend's ``strip_env_keys`` to every child, even those it lets inherit credentials
    (``hermes_subprocess_env(inherit_credentials=True)``); run in its own process (the registry is process-wide)."""
    script = ("import json\n"
              "from agent.terminal_env_registry import register_provider\n"
              "from tools.environments.local import hermes_subprocess_env\n"
              "from whombat_hermes.terminal import make_provider\n"
              "register_provider(make_provider())\n"
              "print('RESULT', json.dumps(sorted(hermes_subprocess_env(inherit_credentials=True))))\n")
    env = {**os.environ, **CREDENTIALS, "CLAUDE_CONFIG_DIR": "/creds/claude", "HERMES_HOME": str(tmp_path)}
    done = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=120, env=env)
    line = next((ln for ln in done.stdout.splitlines() if ln.startswith("RESULT ")), None)
    assert line, done.stderr[-2000:]
    names = set(json.loads(line[len("RESULT "):]))
    assert "PATH" in names
    assert not {"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR",
                "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "WHOMBAT_MCP_TOKEN"} & names
