"""The person’s Hermes profile, shared by prompt, policy and Vault integration, and the turn a tool call belongs to."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

# A person's pod (Whombat hermes-native.md HN-W01, HN-W06): one Hermes serves several turns, each a Hermes session;
# what is a turn's own (its tool policy, its logins, its commands' route) is chosen by the session a tool call runs in.
POD_ENV = "WHOMBAT_POD"
TURNS_DIR = "whombat-turns"
SESSION_ENV = "WHOMBAT_TURN_SESSION"
_SESSION = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")


def hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def in_pod() -> bool:
    """Whether this Hermes serves a person's pod (several turns), not one turn."""
    return os.environ.get(POD_ENV) == "1"


def valid_session(value: object) -> Optional[str]:
    """``value`` when it is an id of Hermes's shape (no path in it), else None."""
    return value if isinstance(value, str) and _SESSION.match(value) and value not in (".", "..") else None


def context_session() -> Optional[str]:
    """The session bound in this context by Hermes's gateway (``HERMES_SESSION_ID``; a sub-agent and the post-answer
    review inherit their session's). Never ``os.environ``'s copy, which is whichever session set it last."""
    try:
        from gateway.session_context import _UNSET, _VAR_MAP

        value = _VAR_MAP["HERMES_SESSION_ID"].get()
    except Exception:
        return None
    return None if value is _UNSET else valid_session(value)


def turn_session(fallback: object = None) -> Optional[str]:
    """The Hermes session a tool call runs in: the session context, else ``fallback`` (the hook's ``session_id``)."""
    return context_session() or valid_session(fallback)


def session_dir(session: str) -> Path:
    """``$HERMES_HOME/whombat-turns/<session>``: what the runner writes for the session's turn (HN-W06)."""
    checked = valid_session(session)
    if not checked:
        raise ValueError("not a session id")
    return hermes_home() / TURNS_DIR / checked
