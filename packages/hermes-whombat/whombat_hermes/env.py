"""Provider credentials stay with model clients; the agent's commands receive none.

DirectSDK gets the CLI allowlist and the selected executable. Every other process Hermes starts loses the provider
credentials and Whombat's MCP token; terminal commands lose those as well.
"""

from __future__ import annotations

import os
import re
from typing import Mapping, Optional

SIGN_IN_ENV = "CLAUDE_CONFIG_DIR"
# Whombat's per-dispatch token (the runner's): Hermes's own gateway key and its MCP bridge's (given in the MCP
# server's own ``env``), never a child's.
MCP_TOKEN_ENVS = frozenset({"WHOMBAT_MCP_TOKEN"})

# Model logins, endpoints and routing: Anthropic's and OpenAI's families (keys, auth tokens, base URLs), Codex's,
# Claude Code's OAuth token and cloud switches, and the CLIs' sign-in homes.
_PROVIDER_PREFIXES = ("ANTHROPIC_", "OPENAI_", "AZURE_OPENAI_", "CODEX_", "CLAUDE_CODE_USE_", "CLAUDE_SUBSCRIPTION_DIRECTSDK_")
_PROVIDER_NAMES = frozenset({SIGN_IN_ENV, "CODEX_HOME", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
                             "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"})
# Anything named like a secret (whole name segments: ``GIT_AUTHOR_NAME`` and ``MAX_THINKING_TOKENS`` are not).
_SECRET_NAME = re.compile(
    r"(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|COOKIE|BEARER|AUTH)(_|$)"
    r"|(^|_)(API|ACCESS|PRIVATE|SECRET|CLIENT)_?KEY(_|$)")
# What the CLI needs (``packages/agent-runtime``: the managed sandbox's allowlist and the variables it sets, the
# runner's guarded environment).
_CLI_NAMES = frozenset({
    # The system: paths, user, locale, terminal, temp dirs.
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ", "NO_COLOR",
    "FORCE_COLOR", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
    # The sandbox's egress proxy and the image's certificates.
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    # The person's sign-in.
    SIGN_IN_ENV,
    # Claude Code's switches Whombat sets (updates, traffic, background tasks, fast mode). Not the rest of
    # ``CLAUDE_CODE_*``: hundreds of names, among them tokens, endpoints, cloud and gateway switches, auth skips and
    # mTLS keys. Not ``CLAUDE_CODE_ENTRYPOINT`` either: Claude Code names its own entrypoint, and a value inherited
    # from whatever started Hermes would mislabel every request.
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS",
    "BASH_MAX_OUTPUT_LENGTH", "API_TIMEOUT_MS",
    # git and gh as the runner sets them: commit identity, the workspace repo, no prompts, no credential helper, gh
    # through Whombat.
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_DIR", "GIT_WORK_TREE",
    "GIT_TERMINAL_PROMPT", "GIT_CONFIG_COUNT", "GH_CONFIG_DIR", "GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER",
    "WHOMBAT_GH_SOCKET",
})
# Locale categories, the runner's command-line git settings, and off-switches (``DISABLE_AUTOUPDATER``,
# ``DISABLE_UPDATES``, ``DISABLE_TELEMETRY`` …).
_CLI_PATTERN = re.compile(r"^(LC_[A-Z]+|GIT_CONFIG_(KEY|VALUE)_\d+|DISABLE_[A-Z0-9_]+)$")


def is_provider_credential(name: str) -> bool:
    """A model login, endpoint or routing switch, or a CLI's sign-in home."""
    upper = name.upper()
    return (upper in _PROVIDER_NAMES or upper.startswith(_PROVIDER_PREFIXES)
            or (upper.startswith("CLAUDE_CODE_") and bool(_SECRET_NAME.search(upper))))


# The turn person's Vault MCP servers' addresses and sign-ins (Whombat HE-S154): Hermes's own, for its MCP client.
VAULT_MCP_PREFIX = "WHOMBAT_VAULT_MCP_"


def is_credential(name: str) -> bool:
    """A provider credential, one of Whombat's MCP tokens, a Vault MCP server's sign-in, or anything named like a
    secret."""
    upper = name.upper()
    return (is_provider_credential(name) or upper in MCP_TOKEN_ENVS or upper.startswith(VAULT_MCP_PREFIX)
            or bool(_SECRET_NAME.search(upper)))


def cli_allowed(name: str) -> bool:
    """Whether the CLI may take ``name`` from Hermes's environment without the config listing it."""
    if name == SIGN_IN_ENV:
        return True
    return (name in _CLI_NAMES or bool(_CLI_PATTERN.match(name))) and not is_credential(name)


def cli_env(base_env: Mapping[str, str]) -> dict[str, str]:
    """The native model client’s environment: only system settings and its own sign-in home."""
    return {k: v for k, v in base_env.items() if isinstance(v, str) and cli_allowed(k)}


def command_env(base_env: Mapping[str, str]) -> dict[str, str]:
    """What the commands' launcher gets: ``base_env`` without any credential (:func:`is_credential`)."""
    return {k: v for k, v in base_env.items() if not is_credential(k)}


def hermes_strip_keys(base_env: Optional[Mapping[str, str]] = None) -> frozenset[str]:
    """The names Hermes strips from every process it starts (the backend's ``strip_env_keys``, matched by exact
    name): the provider credentials in ``base_env`` (default ``os.environ``) and the usual ones, and Whombat's MCP
    token."""
    # Hermes's own Brave key name too: Whombat gives the key in a file (``web_search.py``), but should one ever be in
    # Hermes's environment, nothing it starts gets it.
    names = set(_PROVIDER_NAMES) | MCP_TOKEN_ENVS | {"BRAVE_SEARCH_API_KEY"}
    names.update(k for k in (os.environ if base_env is None else base_env) if is_provider_credential(k))
    return frozenset(names)
