"""A person's Hermes conversations, listed the Hermes way (docs/decisions/hermes-native.md HN-K09…HN-K11; contracts
2.1 ``sessions.list``, CT-1453): one step per process, ``python -m whombat_hermes.sessions list`` with the Python beside
``hermes``, a JSON object on stdin, one JSON object on stdout, exit 0; or a nonzero exit with ``{"code", "message"}``.

    list   stdin ``{"profile": <the profile's directory>}``. The profile's conversations as Hermes lists them for an
           editor (``acp_adapter.catalog``, what ACP's ``session/list`` reads): Hermes's own ``SessionDB`` opened
           read-only, ``list_sessions_rich`` with a compressed chat projected to its tip and listed under its root's
           id, a reset lineage under its owner's (``read_local_owners``) — the id an editor holds, which
           ``hermes sessions delete`` takes for the whole conversation. Every source, archived and hidden ones too;
           sub-agent runs and compression continuations are part of their conversation, not entries. Answers
           ``{"sessions": [{"id", "source", "lastActiveAt"}], "more"}``, least recently active first, at most
           ``LIST_MAX`` (``more``: the most recent were left out).

A read: no lock is taken and nothing in the profile is written but what SQLite's own read-only reader needs beside a
WAL store. ``HERMES_HOME`` is the runner's empty scratch directory, not the profile, so Hermes's start-up scaffolding
lands there. A profile without a session store has no conversations.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

#: The error codes a step answers with (the Hermes-home service's).
CODES = ("invalid", "busy", "unavailable", "failed")
OPS = ("list",)
#: Most conversations one answer carries (contracts ``HERMES_SESSIONS_LIST_MAX``).
LIST_MAX = 5_000
#: The id Whombat stores after ``hermes:`` (contracts ``HermesSessionId``); anything else isn't listed.
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SOURCE_MAX = 40
#: Labels that say where a row is routed or nothing at all, never where it began (``gateway.session_policy``'s
#: ``_NOT_A_SURFACE``): a person's pod stores an editor's session as ``source='local'`` with ``created_source='acp'``.
_NOT_A_SURFACE = frozenset({"", "local", "unknown"})
ACP = "acp"


class StepError(Exception):
    def __init__(self, code: str, message: str):
        assert code in CODES, code
        super().__init__(message)
        self.code, self.message = code, message


def _profile(payload: dict) -> Path:
    raw = payload.get("profile")
    if not isinstance(raw, str) or not raw.strip() or not os.path.isabs(raw):
        raise StepError("invalid", "profile must be the profile directory's absolute path.")
    return Path(os.path.normpath(raw))


def began(row: dict[str, Any]) -> str:
    """Where Hermes says a conversation began: its creating surface (``created_source``) when it names one, else its
    ``source`` as stored."""
    created = str(row.get("created_source") or "")
    source = str(row.get("source") or "")
    label = created if created not in _NOT_A_SURFACE else (source or created or "unknown")
    return label[:SOURCE_MAX]


def _seconds(value: Any) -> Optional[float]:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return seconds if seconds > 0 else None


def iso(seconds: float) -> str:
    """``2026-10-25T09:58:16.123Z``: the contract's datetime (UTC, milliseconds)."""
    at = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"


def _busy(exc: BaseException) -> bool:
    """Whether Hermes couldn't read its store because another connection held it: SQLite's own error, or the
    ``StoreContention`` Hermes's storage layer raises for it since 0.23.3."""
    if isinstance(exc, sqlite3.OperationalError):
        text = str(exc).lower()
        return "locked" in text or "busy" in text
    return any(kind.__name__ == "StoreContention" for kind in type(exc).__mro__)


def _local_owners(profile: Path, store: Path) -> dict[str, str]:
    """Hermes's ``read_local_owners``: which conversation each reset segment belongs to. Hermes 0.23.3 reads it from
    the profile's folder through its storage layer (``persistence_assembly``) and finds nothing, without an error, when
    handed the ``state.db`` file that earlier releases took."""
    from acp_adapter.catalog import read_local_owners

    return read_local_owners(profile if importlib.util.find_spec("persistence_assembly") else store)


def list_sessions(profile: Path) -> dict[str, Any]:
    store = profile / "state.db"
    if not store.is_file():
        return {"sessions": [], "more": False}
    from hermes_state import SessionDB

    try:
        with SessionDB(db_path=store, read_only=True) as db:
            rows = db.list_sessions_rich(
                limit=-1, include_archived=True, include_hidden=True, compact_rows=True,
            )
        owners = _local_owners(profile, store)
    except Exception as exc:
        if _busy(exc):
            raise StepError("busy", "Hermes's session store is busy.") from None
        raise
    # One entry per conversation, under the id an editor holds (as ``catalog_sessions`` does): its latest activity, and
    # a source other than an editor's when any segment has one (a prune then keeps it).
    found: dict[str, tuple[str, float]] = {}
    for row in rows:
        sid = str(row.get("_lineage_root_id") or row.get("id") or "")
        sid = str(owners.get(sid, sid))
        at = _seconds(row.get("last_active")) or _seconds(row.get("started_at"))
        if not _ID.match(sid) or at is None:
            continue
        source = began(row)
        held = found.get(sid)
        if held is not None:
            source = held[0] if held[0] != ACP else source
            at = max(at, held[1])
        found[sid] = (source, at)
    ordered = sorted(found.items(), key=lambda item: (item[1][1], item[0]))
    return {
        "sessions": [
            {"id": sid, "source": source, "lastActiveAt": iso(at)} for sid, (source, at) in ordered[:LIST_MAX]
        ],
        "more": len(ordered) > LIST_MAX,
    }


def run(op: str, payload: dict) -> dict[str, Any]:
    if op == "list":
        return list_sessions(_profile(payload))
    raise StepError("invalid", f"One step: {', '.join(OPS)}.")


def main(argv: Optional[list[str]] = None, stdin=None, stdout=None) -> int:
    """Reads the input, runs the step with anything Hermes prints sent to stderr, writes one JSON object (one line)."""
    argv = sys.argv[1:] if argv is None else argv
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    saved = sys.stdout
    sys.stdout = sys.stderr
    try:
        if len(argv) != 1:
            raise StepError("invalid", f"One step: {', '.join(OPS)}.")
        text = stdin.read()
        try:
            payload = json.loads(text) if text.strip() else {}
        except json.JSONDecodeError:
            raise StepError("invalid", "The input isn't JSON.") from None
        if not isinstance(payload, dict):
            raise StepError("invalid", "The input isn't a JSON object.")
        answer, code = run(argv[0], payload), 0
    except StepError as exc:
        answer, code = {"code": exc.code, "message": exc.message}, 1
    except Exception as exc:  # anything Hermes raised: the step failed
        answer, code = {"code": "failed", "message": f"{type(exc).__name__}: {str(exc)[:300]}"}, 1
    finally:
        sys.stdout = saved
    stdout.write(json.dumps(answer, ensure_ascii=False) + "\n")
    stdout.flush()
    return code


if __name__ == "__main__":
    sys.exit(main())
