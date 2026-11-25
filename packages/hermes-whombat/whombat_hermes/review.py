"""Whether Hermes's post-answer memory and skill review is running (docs/decisions/hermes-native.md HN-08, HN-C…).

Hermes starts the review from ``finalize_turn`` before the turn's answer goes back over ACP: ``_spawn_background_review``
→ ``agent.background_review.spawn_background_review_thread`` (the thread's target) → a daemon thread ``bg-review``.
The plugin wraps that function once per process: when Hermes builds a review it leaves a marker in
``$HERMES_HOME/whombat-review/`` (synchronously, so it is there before the answer is), and the thread removes it when the
review ends, however it ends. The runner waits after an answer only while a marker is there (``REVIEW_DIR``), and clears
the directory before a turn starts Hermes (a killed Hermes leaves one behind).

The same path serves every provider on Hermes's own loop: Claude through DirectSDK, ChatGPT through ``openai-codex``,
API keys, the AI gateway and local models.
"""

from __future__ import annotations

import itertools
import logging
import os
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

#: The markers' directory in the profile (the runner's ``HERMES_REVIEW_DIR``).
REVIEW_DIR = "whombat-review"
_WRAPPED = "_whombat_review_signal"
_ids = itertools.count(1)


def _start() -> Optional[Path]:
    try:
        from .settings import hermes_home

        folder = hermes_home() / REVIEW_DIR
        folder.mkdir(mode=0o700, exist_ok=True)
        marker = folder / f"{os.getpid()}-{next(_ids)}"
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        os.close(fd)
        return marker
    except OSError:
        logger.warning("whombat: the review marker couldn't be written", exc_info=True)
        return None


def _end(marker: Optional[Path]) -> None:
    if marker is None:
        return
    try:
        os.unlink(marker)
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("whombat: the review marker couldn't be removed", exc_info=True)


def _review_off() -> bool:
    """Whether the turn's policy says it has no review (``review: false``: a Looks ahead check). A policy that can't be
    read leaves the review as it was."""
    try:
        from .policy import policy_for

        policy = policy_for({}).load()
    except Exception:
        return False
    return policy is not None and not policy.review


def signalled(spawn: Callable[..., Any]) -> Callable[..., Any]:
    """``spawn_background_review_thread`` with the marker around the review it builds; a turn whose policy says
    ``review: false`` gets a review that does nothing (no model call, nothing remembered)."""
    if getattr(spawn, _WRAPPED, False):
        return spawn

    def wrapped(*args: Any, **kwargs: Any):
        target, prompt = spawn(*args, **kwargs)
        if _review_off():
            return (lambda: None), prompt
        marker = _start()

        def run() -> None:
            try:
                target()
            finally:
                _end(marker)

        return run, prompt

    setattr(wrapped, _WRAPPED, True)
    wrapped.__wrapped__ = spawn  # type: ignore[attr-defined]
    return wrapped


def install() -> None:
    """Wraps Hermes's review spawn in this process (idempotent)."""
    from agent import background_review

    background_review.spawn_background_review_thread = signalled(background_review.spawn_background_review_thread)
