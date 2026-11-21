"""``browser_keep_site``: the agent keeps a website signed in between its chats (Whombat kept-sites.md).

The agent's browser is fresh whenever the person's pod is new, so a sign-in is gone by the next chat. Only when the
agent asks, for one website (its https origins: the sign-in host and the hosts it signs in for), Whombat keeps that
site's cookies for a few hours (default 4, at most 24, counted again from each use) and the next fresh browser starts
signed in. ``forget`` stops it; ``list`` shows what is kept.

The request goes to the runner over the logins socket (``logins.py``: one line, one answer; in a pod it names the
Hermes session): ``{"keep": {"origins", "hours"}}``, ``{"forget": {"origins"}}``, ``{"kept": "list"}``. The runner
reads the cookies from the browser itself; this tool never sees one, and its answers carry none.
"""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import urlsplit

TOOL = "browser_keep_site"
ACTIONS = ("keep", "forget", "list")
DEFAULT_HOURS = 4
MAX_HOURS = 24
MAX_ORIGINS = 10
# Reading the browser and the server's answer.
TIMEOUT_S = 60.0

DESCRIPTION = (
    "Keep a website signed in between chats, or stop keeping it. Your browser starts fresh in a new chat, so sign-ins "
    "are lost. Use this only when the person needs the site to stay signed in between chats, e.g. a site with "
    "two-factor sign-in that will be used again soon: sign in first, then keep it; forget it when the work is done. "
    "Whombat keeps only that site's sign-in, for the hours given (default 4, at most 24) from its last use."
)

SCHEMA = {
    "name": TOOL,
    "description": DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS),
                       "description": "keep (after signing in), forget (when done) or list"},
            "site": {"type": "string",
                     "description": "The site's https address or origin, e.g. https://accounts.hetzner.com/login "
                                    "(for keep and forget)"},
            "also": {"type": "array", "items": {"type": "string"},
                     "description": "More https addresses of the same site that the sign-in is for, e.g. "
                                    "[\"https://konsoleh.hetzner.com\"]"},
            "hours": {"type": "integer", "minimum": 1, "maximum": MAX_HOURS, "default": DEFAULT_HOURS,
                      "description": "How long it stays signed in after its last use (1 to 24)"},
        },
        "required": ["action"],
    },
}


class SiteError(ValueError):
    """What the agent got wrong, in words for it."""


def origin_of(value: Any) -> str:
    """An https address (or a bare host) as its origin: ``https://host`` (and a port other than 443), lower case."""
    if not isinstance(value, str) or not value.strip():
        raise SiteError("Name the site by its https address, like https://accounts.example.com.")
    text = value.strip()
    if "://" not in text:
        text = f"https://{text}"
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        raise SiteError(f"{value[:100]} isn't a web address.") from None
    if parts.scheme.lower() != "https":
        raise SiteError("Only https sites are kept signed in.")
    if parts.username or parts.password:
        raise SiteError("Give the site's address without a username or password in it.")
    host = (parts.hostname or "").rstrip(".")
    try:
        host = host.encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise SiteError(f"{value[:100]} isn't a web address.") from None
    if not host or any(not (c.isalnum() or c in ".-") for c in host) or ".." in host:
        raise SiteError(f"{value[:100]} isn't a web address.")
    return f"https://{host}" if port in (None, 443) else f"https://{host}:{port}"


def origins_of(site: Any, also: Any = None) -> list[str]:
    """The site's origins: ``site`` first, then ``also``, without repeats."""
    more = also if isinstance(also, list) else ([also] if isinstance(also, str) and also else [])
    out: list[str] = []
    for value in [site, *more]:
        origin = origin_of(value)
        if origin not in out:
            out.append(origin)
    if len(out) > MAX_ORIGINS:
        raise SiteError(f"At most {MAX_ORIGINS} addresses for one site.")
    return out


def hours_of(value: Any) -> int:
    """Hours from 1 to 24; none given: the default."""
    if value is None or value == "":
        return DEFAULT_HOURS
    if isinstance(value, bool):
        raise SiteError("Hours are a whole number from 1 to 24.")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise SiteError("Hours are a whole number from 1 to 24.") from None
    if not number.is_integer() or not 1 <= number <= MAX_HOURS:
        raise SiteError("Hours are a whole number from 1 to 24.")
    return int(number)


def _reply(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False)


def _failed(error: str) -> str:
    return _reply({"success": False, "error": error[:300]})


def _shown(site: Any) -> dict[str, Any]:
    """A kept site as the agent may see it: its name, origins and until when; nothing else of the answer."""
    site = site if isinstance(site, dict) else {}
    origins = site.get("origins")
    return {
        "site": str(site.get("site") or "")[:253],
        "origins": [str(o)[:300] for o in origins if isinstance(o, str)] if isinstance(origins, list) else [],
        "until": str(site.get("expiresAt") or "")[:40],
    }


def _hours_note(hours: int) -> str:
    unit = "hour" if hours == 1 else "hours"
    return (f"Signed in stays for {hours} {unit} from its last use; the next fresh browser starts signed in. "
            "Forget it when the work is done.")


def keep_site(args: Any, *, path: Optional[str] = None, timeout: float = TIMEOUT_S) -> str:
    """The tool: keep, forget or list. Short JSON for the model, never a cookie."""
    # The logins socket's client (``logins.py`` imports ``browser.py``, which registers this tool): imported when used.
    from .logins import LoginUnavailable, _exchange, _session_request

    args = args if isinstance(args, dict) else {}
    action = str(args.get("action") or "").strip().lower()
    if action not in ACTIONS:
        return _failed("action is keep, forget or list.")
    try:
        if action == "list":
            request: dict[str, Any] = {"kept": "list"}
        else:
            if not args.get("site"):
                return _failed("Name the site: its https address, like https://accounts.example.com.")
            origins = origins_of(args.get("site"), args.get("also"))
            if action == "keep":
                hours = hours_of(args.get("hours"))
                request = {"keep": {"origins": origins, "hours": hours}}
            else:
                request = {"forget": {"origins": origins}}
        answer = _exchange(_session_request(request), path=path, timeout=timeout)
    except SiteError as exc:
        return _failed(str(exc))
    except LoginUnavailable:
        return _failed("Whombat can't keep websites signed in in this chat.")
    if answer.get("ok") is not True:
        return _failed(str(answer.get("error") or "Whombat couldn't do that right now."))
    if action == "keep":
        shown = _shown(answer.get("site"))
        hours = answer.get("site", {}).get("hours") if isinstance(answer.get("site"), dict) else None
        return _reply({"success": True, "kept": shown["site"], "origins": shown["origins"], "until": shown["until"],
                       "note": _hours_note(hours if isinstance(hours, int) else DEFAULT_HOURS)})
    if action == "forget":
        forgotten = answer.get("forgotten")
        names = [_shown(s)["site"] for s in forgotten] if isinstance(forgotten, list) else []
        note = ("Not kept any more: the browser is signed out of it, and the next chat signs in again."
                if names else "That site wasn't kept.")
        return _reply({"success": True, "forgotten": names, "note": note})
    sites = answer.get("sites")
    shown_sites = [_shown(s) for s in sites] if isinstance(sites, list) else []
    return _reply({"success": True, "sites": shown_sites,
                   **({} if shown_sites else {"note": "No website is kept signed in."})})
