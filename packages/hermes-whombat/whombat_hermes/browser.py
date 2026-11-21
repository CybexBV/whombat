"""The agent's browser tools: ``browser_navigate``, ``browser_snapshot``, ``browser_click`` and the rest, on Whombat's
Chromium at ``browser.cdp_url`` (the runner's relay, Whombat hermes-engine.md HE-S138, HE-S300).

Hermes's own browser is ``browser_exec``: model-written Python run by Hermes's interpreter, beside the profile's
sign-ins. Whombat turns it off and keeps the browser as tools that take a URL, a ref or a key and nothing else. Each
call is one ``agent-browser`` command (Vercel's CLI, the version Whombat pins in ``agent-browser.json``): a native
binary, no shell and no interpreter, without any credential in its environment. The call goes on its stdin as JSON
(``batch``), so nothing the model typed is ever read as one of its options or shows in a process list. One
``agent-browser`` daemon per Hermes task keeps the snapshot's refs between calls and ends after an idle while.

What the pages show passes Hermes's redaction on the way back (a login the vault filled is never echoed), the URL policy
Hermes applies to its own browser (secrets in a URL, the cloud-metadata floor) holds for every page opened, and the
turn's policy hook decides about every call (the browser key; an assessment only looks, HE-S140). Hermes's
``browser_vault`` fills logins over its own CDP connection to the same Chromium (HE-S141), which ``hermes_session``
opens for it (HE-S307).

``browser_keep_site`` (``kept_sites.py``) keeps a website signed in between chats, only when the agent asks: the
runner reads and restores that site's cookies; the tool never sees one.

Where Hermes still has its own tools of these names (before 0.22.6), they stay and these are not registered.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .env import command_env
from .kept_sites import SCHEMA as KEEP_SITE_SCHEMA
from .kept_sites import keep_site

logger = logging.getLogger(__name__)

AGENT_BROWSER_ENV = "WHOMBAT_AGENT_BROWSER"
TOOLSET = "browser"

# How long one command may take: opening a page waits for it to load.
_OPEN_TIMEOUT_S = 60
_COMMAND_TIMEOUT_S = 30
# The daemon of a task that stopped browsing goes after this long.
_IDLE_TIMEOUT_MS = 10 * 60 * 1000
# A snapshot longer than this is cut at a line; the agent asks for the rest by scrolling or a full snapshot.
_SNAPSHOT_MAX = 15000
_SCROLL_PIXELS = 500

_REF = re.compile(r"^@?e[0-9]{1,6}$")
# A key as Playwright names it, with modifiers: ``Enter``, ``Tab``, ``Control+a``, ``Shift+ArrowDown``.
_KEY = re.compile(r"^[A-Za-z0-9]+(\+[A-Za-z0-9]+){0,3}$|^[!-~]$")
_LOOPBACK = "127.0.0.1,localhost,::1"


def agent_browser() -> Optional[str]:
    """``agent-browser``: ``WHOMBAT_AGENT_BROWSER``, else on the ``PATH`` (the runner puts the folder of ``hermes``
    first), else beside the Python running Hermes (a development install's venv)."""
    explicit = (os.environ.get(AGENT_BROWSER_ENV) or "").strip()
    if explicit:
        return explicit if os.access(explicit, os.X_OK) else None
    found = shutil.which("agent-browser")
    if found:
        return found
    beside = Path(sys.executable).parent / "agent-browser"
    return str(beside) if os.access(beside, os.X_OK) else None


def available() -> bool:
    return agent_browser() is not None


def cdp_url() -> str:
    """``browser.cdp_url`` of the profile's config: the runner's relay (``http://127.0.0.1:47105``)."""
    try:
        from hermes_cli.config import load_config

        browser = (load_config() or {}).get("browser") or {}
    except Exception:
        logger.debug("whombat browser: config unreadable", exc_info=True)
        return ""
    value = browser.get("cdp_url") if isinstance(browser, dict) else None
    return value.strip() if isinstance(value, str) else ""


def hermes_session(task_id: Optional[str]) -> bool:
    """Hermes's own browser session for the task on ``browser.cdp_url``, with its CDP supervisor (HE-S307): what
    ``browser_vault`` (and ``browser_cdp``, ``browser_dialog``) reach the page through. Hermes's built-in browser tools
    opened it on every call; these tools don't, so the vault opens it before it acts. Without ``browser.cdp_url`` there
    is none (Hermes would launch a Chromium of its own). A session on the relay owns no browser: ending it closes only
    Hermes's connection. True when the task has one."""
    if not cdp_url():
        return False
    try:
        from tools.browser_session import get_session_info

        return bool(get_session_info(task_id or "default").get("cdp_url"))
    except Exception:
        logger.debug("whombat browser: Hermes's session on the relay couldn't open", exc_info=True)
        return False


def session_name(task_id: Optional[str], endpoint: str = "") -> str:
    """The task's ``agent-browser`` session: short (its socket's path), the same for every call of the task on one
    endpoint. A daemon keeps the endpoint it started with, so another endpoint gets a daemon of its own."""
    digest = hashlib.sha256(f"{task_id or 'default'}\n{endpoint}".encode("utf-8")).hexdigest()[:16]
    return f"wb-{digest}"


def _socket_dir() -> str:
    path = os.path.join(tempfile.gettempdir(), f"wb-ab-{os.getuid()}")
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def browser_env(base: Optional[dict[str, str]] = None) -> dict[str, str]:
    """``agent-browser``'s environment: Hermes's without any credential, the relay on loopback past any proxy, its
    sockets in a folder of their own and an idle end for its daemon."""
    env = command_env(os.environ if base is None else base)
    for key in [k for k in env if k.startswith("AGENT_BROWSER_")]:
        env.pop(key)
    for name in ("NO_PROXY", "no_proxy"):
        env[name] = f"{env[name]},{_LOOPBACK}" if env.get(name) else _LOOPBACK
    env["AGENT_BROWSER_SOCKET_DIR"] = _socket_dir()
    env["AGENT_BROWSER_IDLE_TIMEOUT_MS"] = str(_IDLE_TIMEOUT_MS)
    return env


Runner = Callable[..., subprocess.CompletedProcess]


def run_command(task_id: Optional[str], command: list[str], *, timeout: int = _COMMAND_TIMEOUT_S,
                run: Runner = subprocess.run) -> dict[str, Any]:
    """One ``agent-browser`` command on the task's session: ``{"success", "data", "error"}``."""
    binary = agent_browser()
    if not binary:
        return {"success": False, "error": "The browser isn't installed on this Whombat."}
    endpoint = cdp_url()
    if not endpoint:
        return {"success": False, "error": "This turn has no browser."}
    argv = [binary, "--session", session_name(task_id, endpoint), "--cdp", endpoint, "--json", "batch"]
    try:
        proc = run(argv, input=json.dumps([command]), capture_output=True, text=True, timeout=timeout,
                   env=browser_env())
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"The browser took longer than {timeout} s."}
    except OSError as exc:
        return {"success": False, "error": f"The browser couldn't start: {exc}"}
    try:
        results = json.loads(proc.stdout or "")
    except ValueError:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()[-1:] or [f"exit {proc.returncode}"]
        return {"success": False, "error": f"The browser failed: {detail[0][:300]}"}
    if isinstance(results, dict):  # the batch itself was refused
        return {"success": False, "error": str(results.get("error") or "The browser refused the command.")}
    result = results[0] if isinstance(results, list) and results and isinstance(results[0], dict) else {}
    if not result.get("success"):
        return {"success": False, "error": str(result.get("error") or "The browser command failed.")}
    data = result.get("result")
    return {"success": True, "data": data if isinstance(data, dict) else {"value": data}}


# ---------------------------------------------------------------------------------------------------------------------
# What goes back to the model


def redact(value: Any, depth: int = 0) -> Any:
    """Hermes's redaction, forced: a page can show keys and tokens, and a filled login is never echoed."""
    if depth > 12:
        return "[…]"
    if isinstance(value, str):
        try:
            from agent.redact import redact_sensitive_text

            return redact_sensitive_text(value, force=True)
        except Exception:
            logger.debug("whombat browser: redaction unavailable", exc_info=True)
            return "[hidden: Hermes's redaction is unavailable]"
    if isinstance(value, list):
        return [redact(v, depth + 1) for v in value]
    if isinstance(value, dict):
        return {redact(k, depth + 1): redact(v, depth + 1) for k, v in value.items()}
    return value


def _reply(payload: dict[str, Any]) -> str:
    return json.dumps(redact(payload), ensure_ascii=False)


def _failed(result: dict[str, Any], default: str) -> str:
    return _reply({"success": False, "error": result.get("error") or default})


def url_refusal(url: str) -> Optional[str]:
    """Why Hermes's URL policy refuses ``url`` (a secret in it, the cloud-metadata floor), or None. Fails closed."""
    try:
        from tools.browser_url_policy import evaluate_url_safety
    except Exception:
        return "The browser's address check is unavailable in this Hermes."
    error = evaluate_url_safety(url)
    return str(error.get("error") or "Blocked: unsafe URL") if error else None


def _snapshot_text(data: dict[str, Any]) -> dict[str, Any]:
    text = str(data.get("snapshot") or "")
    if len(text) > _SNAPSHOT_MAX:
        cut = text.rfind("\n", 0, _SNAPSHOT_MAX)
        text = text[: cut if cut > 0 else _SNAPSHOT_MAX] + (
            f"\n… (cut at {_SNAPSHOT_MAX} characters: scroll and take another snapshot for the rest)")
    refs = data.get("refs")
    return {"snapshot": text, "element_count": len(refs) if isinstance(refs, dict) else 0}


def _at_ref(ref: Any) -> Optional[str]:
    if not isinstance(ref, str) or not _REF.match(ref.strip()):
        return None
    ref = ref.strip()
    return ref if ref.startswith("@") else f"@{ref}"


# ---------------------------------------------------------------------------------------------------------------------
# The tools


def browser_navigate(url: str, task_id: Optional[str] = None, run: Runner = subprocess.run) -> str:
    url = (url or "").strip()
    if not re.match(r"^https?://", url, re.IGNORECASE) and url != "about:blank":
        return _reply({"success": False, "error": "Open an http:// or https:// address."})
    refused = url_refusal(url)
    if refused:
        return _reply({"success": False, "error": refused})
    result = run_command(task_id, ["open", url], timeout=_OPEN_TIMEOUT_S, run=run)
    if not result.get("success"):
        return _failed(result, "The page didn't open.")
    data = result["data"]
    final = str(data.get("url") or url)
    if final != url and final.startswith(("http://", "https://")):
        refused = url_refusal(final)
        if refused:
            run_command(task_id, ["open", "about:blank"], timeout=10, run=run)
            return _reply({"success": False, "error": f"The page went on to an address that isn't allowed. {refused}"})
    response: dict[str, Any] = {"success": True, "url": final, "title": data.get("title") or ""}
    snap = run_command(task_id, ["snapshot", "-c"], run=run)
    if snap.get("success"):
        response.update(_snapshot_text(snap["data"]))
    return _reply(response)


def browser_snapshot(full: bool = False, task_id: Optional[str] = None, run: Runner = subprocess.run) -> str:
    result = run_command(task_id, ["snapshot"] if full else ["snapshot", "-c"], run=run)
    if not result.get("success"):
        return _failed(result, "No snapshot of the page.")
    return _reply({"success": True, **_snapshot_text(result["data"])})


def browser_click(ref: str, task_id: Optional[str] = None, run: Runner = subprocess.run) -> str:
    at = _at_ref(ref)
    if not at:
        return _reply({"success": False, "error": "Give a ref from the snapshot, like @e5."})
    result = run_command(task_id, ["click", at], run=run)
    return _reply({"success": True, "clicked": at}) if result.get("success") else _failed(result, f"{at} wasn't clicked.")


def browser_type(ref: str, text: str, task_id: Optional[str] = None, run: Runner = subprocess.run) -> str:
    at = _at_ref(ref)
    if not at:
        return _reply({"success": False, "error": "Give a ref from the snapshot, like @e3."})
    if not isinstance(text, str):
        return _reply({"success": False, "error": "Give the text to type."})
    result = run_command(task_id, ["fill", at, text], run=run)
    # The typed text isn't repeated: the agent knows it, and it may be something not to keep in the history.
    return _reply({"success": True, "typed_into": at}) if result.get("success") else _failed(
        result, f"Nothing was typed into {at}.")


def browser_scroll(direction: str, task_id: Optional[str] = None, run: Runner = subprocess.run) -> str:
    if direction not in ("up", "down"):
        return _reply({"success": False, "error": "Scroll up or down."})
    result = run_command(task_id, ["scroll", direction, str(_SCROLL_PIXELS)], run=run)
    return _reply({"success": True, "scrolled": direction}) if result.get("success") else _failed(
        result, "The page didn't scroll.")


def browser_back(task_id: Optional[str] = None, run: Runner = subprocess.run) -> str:
    result = run_command(task_id, ["back"], run=run)
    if not result.get("success"):
        return _failed(result, "The browser didn't go back.")
    url = run_command(task_id, ["get", "url"], run=run)
    where = str((url.get("data") or {}).get("url") or (url.get("data") or {}).get("value") or "") if url.get(
        "success") else ""
    return _reply({"success": True, "url": where})


def browser_press(key: str, task_id: Optional[str] = None, run: Runner = subprocess.run) -> str:
    if not isinstance(key, str) or not _KEY.match(key):
        return _reply({"success": False, "error": "Name one key, like Enter, Tab or Control+a."})
    result = run_command(task_id, ["press", key], run=run)
    return _reply({"success": True, "pressed": key}) if result.get("success") else _failed(
        result, f"{key} wasn't pressed.")


def browser_console(clear: bool = False, expression: Optional[str] = None, task_id: Optional[str] = None,
                    run: Runner = subprocess.run) -> str:
    if expression is not None:
        if not isinstance(expression, str) or not expression.strip():
            return _reply({"success": False, "error": "Give a JavaScript expression."})
        result = run_command(task_id, ["eval", expression], run=run)
        if not result.get("success"):
            return _failed(result, "The expression failed.")
        value = result["data"].get("result", result["data"].get("value"))
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                pass
        return _reply({"success": True, "result": value})
    flags = ["--clear"] if clear else []
    console = run_command(task_id, ["console", *flags], run=run)
    errors = run_command(task_id, ["errors", *flags], run=run)
    messages = [{"type": m.get("type", "log"), "text": m.get("text", "")}
                for m in (console.get("data") or {}).get("messages", []) if isinstance(m, dict)] if console.get(
        "success") else []
    js_errors = [{"message": e.get("message", "")} for e in (errors.get("data") or {}).get("errors", [])
                 if isinstance(e, dict)] if errors.get("success") else []
    return _reply({"success": True, "console_messages": messages, "js_errors": js_errors})


def _screenshot_dir() -> Path:
    from .settings import hermes_home

    path = hermes_home() / "cache" / "whombat-browser"
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    for old in path.glob("*.png"):  # a day's screenshots at most
        try:
            if old.stat().st_mtime < time.time() - 86400:
                old.unlink()
        except OSError:
            pass
    return path


def browser_vision(question: str = "", task_id: Optional[str] = None, run: Runner = subprocess.run) -> Any:
    # Only the path: a command on stdin takes no options (``batch``), so no labels drawn on the page.
    target = _screenshot_dir() / f"{session_name(task_id)}-{int(time.time() * 1000)}.png"
    result = run_command(task_id, ["screenshot", str(target)], run=run)
    if not result.get("success") or not target.is_file():
        return _failed(result, "No screenshot of the page.")
    response = {"success": True, "screenshot_path": str(target), "question": question}
    try:
        # Hermes attaches the image for a model that sees images (its own browser's way); otherwise the path is
        # for its vision tool.
        from tools.browser_use_cli import _native_screenshot_result

        native = _native_screenshot_result(redact(response), str(target))
        if native is not None:
            return native
    except Exception:
        logger.debug("whombat browser: no native screenshot", exc_info=True)
    return _reply({**response, "note": "Look at the screenshot with your vision tool."})


# ---------------------------------------------------------------------------------------------------------------------
# Schemas and registration

def _schema(name: str, description: str, properties: Optional[dict[str, Any]] = None,
            required: Optional[list[str]] = None) -> dict[str, Any]:
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties or {}, "required": required or []}}


SCHEMAS = [
    _schema("browser_navigate",
            "Open a URL in your web browser. Returns the page's title and a compact snapshot of its interactive "
            "elements with refs (@e1, @e2…) for browser_click and browser_type. For plain text, JSON or files, "
            "fetching them with a command is faster.",
            {"url": {"type": "string", "description": "The address to open, http:// or https://"}}, ["url"]),
    _schema("browser_snapshot",
            "A text snapshot of the current page's accessibility tree, with refs for browser_click and "
            "browser_type. Compact (interactive elements) by default; full=true for all the page's content.",
            {"full": {"type": "boolean", "default": False, "description": "The whole page, not only what you can "
                      "interact with"}}),
    _schema("browser_click", "Click an element by its ref from the snapshot (e.g. @e5).",
            {"ref": {"type": "string", "description": "The element's ref, like @e5"}}, ["ref"]),
    _schema("browser_type", "Clear an input field (by its ref from the snapshot) and type text into it.",
            {"ref": {"type": "string", "description": "The field's ref, like @e3"},
             "text": {"type": "string", "description": "The text to type"}}, ["ref", "text"]),
    _schema("browser_scroll", "Scroll the page up or down by about half a screen.",
            {"direction": {"type": "string", "enum": ["up", "down"]}}, ["direction"]),
    _schema("browser_back", "Go back to the previous page."),
    _schema("browser_press", "Press a key on the page: Enter to submit, Tab, Escape, ArrowDown, Control+a.",
            {"key": {"type": "string", "description": "The key, as Enter, Tab or Control+a"}}, ["key"]),
    _schema("browser_console",
            "The page's console messages and JavaScript errors; with expression, evaluate JavaScript in the page "
            "and return its value (DOM inspection, reading the page's state).",
            {"clear": {"type": "boolean", "default": False, "description": "Clear the messages after reading"},
             "expression": {"type": "string", "description": "JavaScript to evaluate in the page"}}),
    _schema("browser_vision",
            "Take a screenshot of the current page to look at it: layouts, images, charts, what the text snapshot "
            "misses.",
            {"question": {"type": "string", "description": "What you want to see on the page"}}, ["question"]),
    KEEP_SITE_SCHEMA,
]

_HANDLERS: dict[str, Callable[..., Any]] = {
    "browser_navigate": lambda a, t: browser_navigate(str(a.get("url") or ""), t),
    "browser_snapshot": lambda a, t: browser_snapshot(bool(a.get("full", False)), t),
    "browser_click": lambda a, t: browser_click(a.get("ref"), t),
    "browser_type": lambda a, t: browser_type(a.get("ref"), a.get("text"), t),
    "browser_scroll": lambda a, t: browser_scroll(str(a.get("direction") or ""), t),
    "browser_back": lambda a, t: browser_back(t),
    "browser_press": lambda a, t: browser_press(a.get("key"), t),
    "browser_console": lambda a, t: browser_console(bool(a.get("clear", False)), a.get("expression"), t),
    "browser_vision": lambda a, t: browser_vision(str(a.get("question") or ""), t),
    "browser_keep_site": lambda a, t: keep_site(a),
}

_EMOJI = {"browser_navigate": "🌐", "browser_vision": "📸", "browser_keep_site": "🔑"}


def _handler(name: str) -> Callable[..., Any]:
    def handle(args: dict[str, Any], **kw: Any) -> Any:
        return _HANDLERS[name](args or {}, kw.get("task_id"))

    handle.__name__ = f"whombat_{name}"
    return handle


def hermes_has(name: str) -> bool:
    """Whether Hermes has a tool of this name of its own (before 0.22.6 it had these)."""
    try:
        from tools.registry import registry

        return registry.get_schema(name) is not None
    except Exception:
        return False


def register(ctx: Any) -> list[str]:
    """Registers the tools Hermes doesn't have itself; returns their names."""
    registered = []
    for schema in SCHEMAS:
        name = schema["name"]
        if hermes_has(name):
            continue
        ctx.register_tool(name=name, toolset=TOOLSET, schema=schema, handler=_handler(name), check_fn=available,
                          emoji=_EMOJI.get(name, "🖱️"))
        registered.append(name)
    return registered
