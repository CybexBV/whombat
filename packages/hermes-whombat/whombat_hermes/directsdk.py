"""Nous's pinned DirectSDK provider with Whombat's native-client environment boundary.

No authentication code: the unmodified Claude executable reads the existing CLAUDE_CONFIG_DIR. Hermes owns
the conversation and executes tools. The upstream sources under vendor/ remain unchanged.
"""
from __future__ import annotations

from dataclasses import fields
from datetime import datetime, timezone
import os
import shutil
import tempfile
from urllib.parse import urlsplit

from providers import register_provider
from whombat_claude_directsdk import ClaudeOAuthDirectSDKProfile, model_catalog, profile as upstream, usage_windows
from whombat_claude_directsdk.directsdk import Client as NativeClient
from whombat_claude_directsdk.directsdk_setup import discover_models, fetch_usage, setup_status

from .env import cli_env

GATEWAY_PROVIDER = "whombat-claude-gateway"
PLUGIN_ID = "claude-subscription-directsdk-experimental"

# Claude models Anthropic released after the pinned plugin, with their context window. Claude Code runs them by id, but
# without a window here Hermes would compress at its 200K guess. `fable` means the newest Fable, as Whombat's model
# list says (agent-runtime's models/list.ts), so an agent on Fable moves up by itself, like one on `opus`.
NEWER_MODELS = {"claude-fable-5-2": 1_000_000}
NEWER_ALIASES = {"fable": "claude-fable-5-2"}


def _add_newer_models():
    """Adds NEWER_MODELS to the plugin's own tables, in place: its functions and profile read those same dicts."""
    model_catalog.CONTEXT_WINDOWS.update(NEWER_MODELS)
    model_catalog.ALIASES.update(NEWER_ALIASES)
    for model, window in NEWER_MODELS.items():
        model_catalog.MODEL_METADATA[model_catalog.native_model(model)] = {"canonical_model": model,
                                                                           "context_window": window}
    for canonical in {*NEWER_MODELS, *NEWER_ALIASES.values()}:
        capabilities = {"supports_vision": True, "context_window": model_catalog.CONTEXT_WINDOWS[canonical]}
        for model_id in model_catalog._session_ids(canonical):
            model_catalog.MODEL_CAPABILITIES[model_id] = capabilities
    # Worked out once when the plugin loaded, so worked out again.
    upstream.fallback_models = tuple(model_catalog.MODEL_METADATA)
    upstream.model_aliases = {alias: model_catalog.native_model(alias) for alias in model_catalog.ALIASES}


_add_newer_models()


class Client(NativeClient):
    def create(self, **kwargs):
        # Keep TO-05's Claude tool inventory: the browser's ordinary tools and the agent's commands cover raw CDP.
        if isinstance(kwargs.get("tools"), list):
            kwargs["tools"] = [tool for tool in kwargs["tools"]
                               if (tool.get("function") or {}).get("name") != "browser_cdp"]
        return super().create(**kwargs)


class WhombatClaudeProfile(ClaudeOAuthDirectSDKProfile):
    def create_client(self, **kwargs):
        # The native client needs its sign-in, proxy and certificates, never Whombat's MCP/Vault credentials.
        kwargs["env"] = cli_env(os.environ)
        kwargs["command"] = os.environ.get("CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND") or "claude"
        return Client(**kwargs)

    def setup_status(self, **kwargs):
        return setup_status(**_probe_kwargs(kwargs))

    def discover_models(self, **kwargs):
        return discover_models(**_probe_kwargs(kwargs))

    def fetch_account_usage(self, **_):
        from agent.account_usage import AccountUsageSnapshot

        limits, reason = fetch_usage(**_probe_kwargs({}))
        windows, details = usage_windows(limits) if limits is not None else ((), ())
        return AccountUsageSnapshot(provider=self.name, source="claude_code_get_usage",
                                    fetched_at=datetime.now(timezone.utc), title="Claude plan limits",
                                    windows=tuple(windows), details=tuple(details), unavailable_reason=reason)


def gateway_options():
    """Only Whombat's loopback relay, never an inherited endpoint or the person's sign-in."""
    from hermes_cli.config import load_config_readonly

    settings = load_config_readonly().get("plugins", {}).get("entries", {}).get(PLUGIN_ID, {}).get("settings", {})
    gateway = settings.get("whombat_gateway", {})
    base = gateway.get("base_url", "")
    target = urlsplit(base)
    if (target.scheme not in ("http", "https") or target.hostname not in ("127.0.0.1", "localhost", "::1")
            or target.path != "/ai-gateway/claude" or target.username or target.password or target.query
            or target.fragment or not isinstance(gateway.get("pod"), bool) or settings.get("claude_config_dir")):
        raise ValueError("Claude Code's AI gateway route requires Whombat's relay configuration")
    token = "whombat-pod" if gateway["pod"] else os.environ.get("WHOMBAT_MCP_TOKEN", "")
    if not token:
        raise ValueError("Claude Code's AI gateway route has no active turn token")
    return base, token


class GatewayClient(Client):
    """DirectSDK with the official CLI's gateway settings and a private home containing no personal login."""
    def __init__(self, **kwargs):
        base, token = gateway_options()
        self._gateway_home = tempfile.TemporaryDirectory(prefix="whombat-claude-gateway-")
        env = cli_env(os.environ)
        env.update(CLAUDE_CONFIG_DIR=self._gateway_home.name, ANTHROPIC_BASE_URL=base, ANTHROPIC_AUTH_TOKEN=token)
        kwargs["env"] = env
        kwargs["command"] = os.environ.get("CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND") or "claude"
        try:
            super().__init__(**kwargs)
        except BaseException:
            self._gateway_home.cleanup()
            raise
        self.base_url = f"process://{GATEWAY_PROVIDER}"

    def close(self):
        try:
            super().close()
        finally:
            self._gateway_home.cleanup()


class WhombatClaudeGatewayProfile(ClaudeOAuthDirectSDKProfile):
    def create_client(self, **kwargs):
        return GatewayClient(**kwargs)

    def setup_status(self, **_):
        gateway_options()
        command = os.environ.get("CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND") or "claude"
        return {"available": shutil.which(command) is not None, "logged_in": True, "plan": "",
                "detail": "Uses Whombat's AI gateway, not a personal Claude sign-in", "login_command": None}

    def discover_models(self, **_):
        return None  # The gateway's model list is Whombat's; never probe a personal subscription.

    def fetch_account_usage(self, **_):
        from agent.account_usage import AccountUsageSnapshot

        return AccountUsageSnapshot(provider=self.name, source="whombat_ai_gateway",
                                    fetched_at=datetime.now(timezone.utc), title="AI gateway usage",
                                    windows=(), details=(),
                                    unavailable_reason="Gateway usage is shown in Whombat's Settings")


def _probe_kwargs(kwargs):
    return {"command": [os.environ.get("CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND") or "claude"],
            "env": cli_env(os.environ), **({"timeout": kwargs["timeout"]} if "timeout" in kwargs else {})}


profile = WhombatClaudeProfile(**{f.name: getattr(upstream, f.name) for f in fields(upstream) if f.init})
profile.supports_streaming = upstream.supports_streaming
register_provider(profile)

gateway_profile = WhombatClaudeGatewayProfile(**{f.name: getattr(upstream, f.name)
                                                for f in fields(upstream) if f.init})
gateway_profile.name = GATEWAY_PROVIDER
gateway_profile.display_name = "Claude Code through Whombat's AI gateway"
gateway_profile.description = "Claude Code as Hermes's model client, routed through the chosen AI gateway"
gateway_profile.base_url = f"process://{GATEWAY_PROVIDER}"
gateway_profile.supports_streaming = upstream.supports_streaming
register_provider(gateway_profile)
