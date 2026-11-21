"""Whombat's words in Hermes's system prompt (HE-11): ``$HERMES_HOME/whombat.md``, written by the runner, holds what
is stable for a person (the agent's name, the talk-like-people rules of concise-replies.md); ``whombat-notes.md`` the
notes the person wrote for the agent (HE-39, HE-S120), a section of its own so neither crowds the other out.
Hermes freezes each section into each NEW session's prompt (a resumed session keeps its own); at most 4,000 characters
each. What changes per turn (who asks, where, what is connected, the trigger) goes in front of the ACP prompt text
instead.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from .settings import hermes_home

logger = logging.getLogger(__name__)

SECTION_ID = "whombat"
PROMPT_FILE = "whombat.md"
NOTES_SECTION_ID = "whombat-notes"
NOTES_FILE = "whombat-notes.md"
MAX_CHARS = 4000


def whombat_section(_session: Mapping[str, Any] | None = None) -> str:
    return _read_section(PROMPT_FILE)


def notes_section(_session: Mapping[str, Any] | None = None) -> str:
    return _read_section(NOTES_FILE)


def _read_section(name: str) -> str:
    path = hermes_home() / name
    try:
        text = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except OSError:
        logger.warning("could not read %s", path, exc_info=True)
        return ""
    if len(text) > MAX_CHARS:
        logger.warning("%s is %d characters; Hermes keeps the first %d", path, len(text), MAX_CHARS)
        text = text[:MAX_CHARS]
    return text
