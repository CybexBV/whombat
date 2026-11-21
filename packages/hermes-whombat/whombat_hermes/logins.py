"""Whombat's Vault logins in Hermes's credential vault (Whombat hermes-engine.md HE-42, HE-S141).

The logins of the person a turn is for, switched on for the agent, are Hermes's vault for that turn and nothing else:

- ``$HERMES_HOME/whombat-logins.json`` (written by the runner before the turn, removed after it) lists them without a
  secret: the Vault entry, its name, the origin of its sign-in page, the username, whether it has a one-time-code seed.
  ``browser_vault action=list`` shows them as ``wb:<entry>`` handles; the agent types the username itself.
- A fill asks the runner's logins service for that one login's password (or its current one-time code) over the unix
  socket ``WHOMBAT_LOGINS_SOCKET`` names; the runner fetches it from Whombat for this turn only. Nothing is kept: no
  file, no cache. Hermes fills it into the page over its CDP socket and redacts it; the model sees only "filled". That
  socket is Hermes's own session on ``browser.cdp_url`` (the runner's relay to the Chromium Whombat's browser tools
  drive), which ``browser_vault`` opens before it acts on a page (HE-S307).
- The backend is registered through Hermes's door for plugin login backends (``ctx.register_login_backend``, name
  ``wb``, handles ``wb:<entry>``; Whombat hermes-engine.md HE-S302): Hermes wraps it (``PluginLoginBackend``) and
  lists it beside its own local store when the profile turns it on (``vault.wb.enabled``); 1Password and Bitwarden
  stay off. Hermes takes that door only from bundled and catalog plugins, so Whombat's plugin, a pip entry point,
  registers the same backend in the same registry itself when the door turns it away. No Hermes function is replaced.
- Hermes's prompts (vault-simplify.md VLT-45, HE-S303…HE-S306): in a person's turn ``browser_vault`` runs with
  Whombat's save-login and code prompts installed on its own thread (Hermes keeps them per thread). Each asks the
  runner over the same socket (``{"ask": "login" | "code", "origin"}``); the runner asks Whombat, which posts the card in
  the turn's thread and waits for the person (a login up to 10 minutes, a code 5). A saved login comes back for Hermes to
  store in its local store for this turn (the runner wipes it after) and fill; a code comes back once; anything else is
  a decline. No socket (an outsiders' turn, an assessment): no prompts, and Hermes says it can't ask.
- In a person's pod, where one Hermes serves several turns (hermes-native.md HN-W06), each turn's list is its
  session's, ``$HERMES_HOME/whombat-turns/<session>/logins.json``, and a fill names the session: the runner gives a
  password only to the session's live turn.
"""

from __future__ import annotations

import json
import logging
import os
import socket
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Optional

from .browser import hermes_session
from .settings import hermes_home, in_pod, session_dir, turn_session

logger = logging.getLogger(__name__)

LOGINS_FILE = "whombat-logins.json"
SESSION_LOGINS_FILE = "logins.json"
SOCKET_ENV = "WHOMBAT_LOGINS_SOCKET"
PREFIX = "wb:"
# Hermes names a plugin backend by its handles' prefix (``<name>:``): ``wb``, so the handles stay ``wb:<entry>``.
BACKEND_NAME = "wb"
TIMEOUT_S = 30.0
# ``browser_vault``'s actions on the open page (Hermes's names); ``list`` and ``unlock`` need no page.
PAGE_ACTIONS = ("fill", "save_login", "enter_code")


class LoginUnavailable(RuntimeError):
    """The login's secret couldn't be had (the turn is over, the login was switched off): safe to show."""


def _logins_file() -> Optional[Path]:
    """The turn's list: its session's in a pod, else the profile's; None when the session isn't known."""
    if not in_pod():
        return Path(hermes_home()) / LOGINS_FILE
    session = turn_session()
    return session_dir(session) / SESSION_LOGINS_FILE if session else None


def _listed() -> list[dict[str, Any]]:
    path = _logins_file()
    if path is None:
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except Exception:
        logger.warning("whombat: %s can't be read", path)
        return []
    logins = data.get("logins") if isinstance(data, dict) else None
    return [x for x in logins if isinstance(x, dict) and isinstance(x.get("entryId"), str)] if isinstance(logins, list) else []


def _session_request(request: dict[str, Any]) -> dict[str, Any]:
    """The request with the turn's Hermes session in a pod (the runner routes by it), or LoginUnavailable."""
    if in_pod():
        session = turn_session()
        if not session:
            raise LoginUnavailable("Whombat doesn't know this turn.")
        request["session"] = session
    return request


def _exchange(request: dict[str, Any], *, path: Optional[str], timeout: float) -> dict[str, Any]:
    """One line to the runner's logins service and its one-line answer."""
    where = path or os.environ.get(SOCKET_ENV, "")
    if not where:
        raise LoginUnavailable("Whombat's logins aren't reachable in this turn.")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(where)
            s.sendall((json.dumps(request) + "\n").encode("utf-8"))
            buf = b""
            while b"\n" not in buf:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > 1024 * 1024:
                    raise LoginUnavailable("Whombat's answer was too long.")
    except OSError as exc:
        raise LoginUnavailable(f"Whombat's logins aren't reachable ({exc.__class__.__name__}).") from None
    try:
        answer = json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
    except Exception:
        raise LoginUnavailable("Whombat's answer couldn't be read.") from None
    if not isinstance(answer, dict):
        raise LoginUnavailable("Whombat's answer couldn't be read.")
    return answer


def ask_runner(entry_id: str, *, path: Optional[str] = None, timeout: float = TIMEOUT_S) -> dict[str, Any]:
    """One login's secret from the runner's logins service: ``{"password": …, "otp": …|None}``."""
    answer = _exchange(_session_request({"entry": entry_id}), path=path, timeout=timeout)
    if answer.get("error"):
        raise LoginUnavailable(str(answer.get("error") or "Whombat didn't give this login.")[:200])
    return answer


# How long a prompt waits for the person: Whombat's waits (a login 10 minutes, a code 5) and a minute for the runner.
ASK_TIMEOUT_S = {"login": 660.0, "code": 360.0}
# The tool's own deadline while a prompt waits (Hermes's default, 420 s, is shorter than a login's wait).
TOOL_TIMEOUT_S = 720.0


def ask_person(kind: str, origin: str, username: Optional[str] = None, *, path: Optional[str] = None,
               timeout: Optional[float] = None) -> dict[str, Any]:
    """One of Hermes's asks, answered by the person on a card in the turn's thread (VLT-45): ``{"identifier",
    "password"}`` for a login saved in Whombat's Vault, ``{"code"}`` for a code, else ``{"declined": True, "error"}``."""
    request = _session_request({"ask": kind, "origin": origin, "username": username})
    return _exchange(request, path=path, timeout=timeout if timeout is not None else ASK_TIMEOUT_S[kind])


def save_login_prompt(origin: str, site: str) -> Optional[dict[str, str]]:
    """Hermes's save-login prompt: the login the person saved in Whombat's Vault on the card, or None (declined)."""
    try:
        answer = ask_person("login", origin)
    except LoginUnavailable:
        return None
    identifier, password = answer.get("identifier"), answer.get("password")
    if isinstance(identifier, str) and identifier and isinstance(password, str) and password:
        return {"identifier": identifier, "password": password}
    return None


def code_prompt(site: str, hint: str) -> str:
    """Hermes's code prompt: the code the person typed on the card, once, or "" (declined)."""
    origin = site if site.startswith("https://") else f"https://{site}"
    try:
        code = ask_person("code", origin).get("code")
    except LoginUnavailable:
        return ""
    return code if isinstance(code, str) else ""


def _no_unlock(backend: str, display_name: str) -> str:
    """Password managers stay off (VLT-20): nothing is ever unlocked."""
    return ""


def prompts_here() -> bool:
    """Whether this turn may ask the person: the runner's logins service is reachable (a person's turn)."""
    return bool(os.environ.get(SOCKET_ENV, ""))


@contextmanager
def person_prompts():
    """Whombat's prompts on this thread for one ``browser_vault`` call, restored after (Hermes keeps them per thread)."""
    if not prompts_here():
        yield
        return
    from agent.vault_backends import unlock

    previous = (unlock.get_unlock_prompt_callback(), unlock.get_save_login_prompt_callback(),
                unlock.get_code_prompt_callback())
    unlock.set_unlock_prompt_callback(_no_unlock)
    unlock.set_save_login_prompt_callback(save_login_prompt)
    unlock.set_code_prompt_callback(code_prompt)
    try:
        yield
    finally:
        unlock.set_unlock_prompt_callback(previous[0])
        unlock.set_save_login_prompt_callback(previous[1])
        unlock.set_code_prompt_callback(previous[2])


def _backend_class():
    from agent.vault_backends.base import LoginBackend
    from agent.vault_store import VaultItemMeta

    class WhombatLoginBackend(LoginBackend):
        name = BACKEND_NAME
        display_name = "Whombat Vault"
        prefix = PREFIX

        def _meta(self, item: dict[str, Any]) -> VaultItemMeta:
            username = str(item.get("username") or "")
            return VaultItemMeta(
                id=f"{PREFIX}{item['entryId']}",
                kind="login",
                label=str(item.get("name") or item["entryId"])[:80],
                origin=str(item.get("origin") or "") or None,
                created_at="",
                identifier_type=("email" if "@" in username else "username") if username else None,
                identifier=username or None,
                has_otp=bool(item.get("otp")),
            )

        def list_items(self) -> list:
            return [self._meta(x) for x in _listed()]

        def get_meta(self, handle: str):
            entry = handle[len(PREFIX):] if handle.startswith(PREFIX) else None
            item = next((x for x in _listed() if x["entryId"] == entry), None)
            return self._meta(item) if item else None

        def resolve_password(self, handle: str) -> str:
            if self.get_meta(handle) is None:
                raise LoginUnavailable("That login isn't one of this turn's.")
            password = ask_runner(handle[len(PREFIX):]).get("password")
            if not isinstance(password, str) or not password:
                raise LoginUnavailable("Whombat didn't give this login's password.")
            return password

        def resolve_otp(self, handle: str) -> Optional[str]:
            meta = self.get_meta(handle)
            if meta is None or not meta.has_otp:
                return None
            otp = ask_runner(handle[len(PREFIX):]).get("otp")
            return otp if isinstance(otp, str) and otp else None

    return WhombatLoginBackend


def register_backend(ctx: Any) -> str:
    """The backend in Hermes's login-backend registry: through ``ctx.register_login_backend`` when Hermes takes it from
    this plugin, else (a pip entry point) straight into the same registry. Returns how: ``ctx`` or ``registry``."""
    import agent.vault_backend_registry as registry

    backend = _backend_class()()
    try:
        ctx.register_login_backend(backend)
    except Exception:
        logger.debug("whombat: register_login_backend failed", exc_info=True)
    if registry.get_provider(BACKEND_NAME) is not None:
        return "ctx"
    registry.register_provider(backend)
    return "registry"


def register_vault_tool(ctx: Any) -> bool:
    """``browser_vault`` with Whombat's prompts around Hermes's own handler (``override``, granted in the profile).
    False, with Hermes's own left in place, when Hermes doesn't let this home's plugin replace it."""
    import tools.browser_vault_tool  # noqa: F401 -- registers Hermes's tool
    from tools.registry import registry

    entry = registry.get_entry("browser_vault")
    if entry is None:
        logger.warning("whombat: this Hermes has no browser_vault to ask the person through")
        return False
    inner = entry.handler
    if getattr(inner, "_whombat_prompts", False):
        return True

    def handle(args: Any, **kw: Any) -> Any:
        # A fill, a save or a code acts on the page Whombat's browser tools opened, which Hermes reaches through its own
        # session on the relay; only Hermes's built-in browser tools (gone since 0.22.6) used to open it (HE-S307).
        if isinstance(args, dict) and args.get("action") in PAGE_ACTIONS and (args.get("target") or "browser") == "browser":
            hermes_session(kw.get("task_id"))
        with person_prompts():
            return inner(args, **kw)

    handle._whombat_prompts = True  # type: ignore[attr-defined]
    handle.__name__ = "whombat_browser_vault"
    try:
        ctx.register_tool(name="browser_vault", toolset=entry.toolset, schema=entry.schema, handler=handle,
                          check_fn=entry.check_fn, emoji=entry.emoji, override=True)
    except Exception as error:
        # A home whose config.yaml doesn't let the plugin replace a built-in tool (Hermes's own check home, a profile
        # not written by the runner): Hermes's own browser_vault stays, which only can't ask the person. Said in one
        # line, not as a crash: nothing else of the plugin depends on it.
        if type(error).__name__ != "PluginToolOverrideError":
            raise
        logger.warning("whombat: browser_vault stays Hermes's own here (this home's config.yaml doesn't let the plugin"
                       " replace it), so it can't ask the person")
        return False
    mine = registry.get_entry("browser_vault")
    if mine is None or mine.handler is not handle:
        logger.warning("whombat: Hermes kept its own browser_vault, so it can't ask the person")
        return False
    # Our own entry: its deadline covers a login's wait for the person.
    mine.execution_timeout = TOOL_TIMEOUT_S
    return True
