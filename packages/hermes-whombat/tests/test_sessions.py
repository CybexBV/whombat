"""A profile's conversations listed the Hermes way (hermes-native.md HN-K09, contracts ``sessions.list``): Hermes's own
store read-only, one entry per conversation under the id an editor holds, where it began, least recently active first,
and nothing written in the profile but SQLite's own files beside a WAL store."""

from __future__ import annotations

import io
import json
import os
import sqlite3
import time
from pathlib import Path

import pytest

from whombat_hermes import sessions

from .conftest import needs_hermes

pytestmark = needs_hermes

DAY = 86_400.0


def step(payload: object, op: str = "list") -> tuple[int, dict]:
    out = io.StringIO()
    code = sessions.main([op], stdin=io.StringIO(json.dumps(payload)), stdout=out)
    return code, json.loads(out.getvalue().strip().splitlines()[-1])


@pytest.fixture
def profile(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    # As the runner runs the step: HERMES_HOME an empty scratch directory, the profile named on stdin.
    scratch = tmp_path / "scratch"
    scratch.mkdir(mode=0o700)
    monkeypatch.setenv("HERMES_HOME", str(scratch))
    monkeypatch.setenv("HOME", str(scratch))
    profile = tmp_path / "profiles" / "acc_mara"
    profile.mkdir(parents=True, mode=0o700)
    return profile


def store(profile: Path):
    from hermes_state import SessionDB

    return SessionDB(db_path=profile / "state.db")


def conversation(db, sid: str, source: str = "acp", **kwargs) -> str:
    db.create_session(sid, source, model="m", **kwargs)
    db.append_message(sid, role="user", content=f"hello from {sid}")
    return sid


def age(profile: Path, sid: str, days: float) -> float:
    """Moves a session's start, activity and messages ``days`` back; the time it now last did something."""
    at = time.time() - days * DAY
    with sqlite3.connect(profile / "state.db") as conn:
        conn.execute("UPDATE sessions SET started_at = ?, last_activity_at = ? WHERE id = ?", (at, at, sid))
        conn.execute("UPDATE messages SET timestamp = ? WHERE session_id = ?", (at, sid))
    return at


def ids(answer: dict) -> list[str]:
    return [s["id"] for s in answer["sessions"]]


def test_a_profile_without_a_session_store_has_none(profile: Path):
    assert step({"profile": str(profile)}) == (0, {"sessions": [], "more": False})
    assert not (profile / "state.db").exists()


def test_every_conversation_once_where_it_began_least_recently_active_first(profile: Path):
    db = store(profile)
    conversation(db, "acp-old")
    conversation(db, "cli-chat", "cli")
    conversation(db, "cron-run", "cron")
    conversation(db, "acp-new")
    # A compressed conversation: listed once, under its root's id (what the editor holds), with the tip's activity.
    conversation(db, "acp-long")
    db.end_session("acp-long", "compression")
    conversation(db, "acp-long-2", parent_session_id="acp-long")
    # A sub-agent's run belongs to its conversation.
    db.create_session("acp-new-sub", "acp", model="m", parent_session_id="acp-new",
                      model_config={"_delegate_from": "acp-new"})
    db.append_message("acp-new-sub", role="user", content="sub-agent")
    # A person's pod keeps an editor's session as routed `local`, made by `acp`.
    conversation(db, "pod-chat")
    conversation(db, "archived-chat")
    db.close()
    with sqlite3.connect(profile / "state.db") as conn:
        conn.execute("UPDATE sessions SET source = 'local', created_source = 'acp' WHERE id = 'pod-chat'")
        conn.execute("UPDATE sessions SET archived = 1, hidden = 1 WHERE id = 'archived-chat'")
    old = age(profile, "acp-old", 30)
    age(profile, "cli-chat", 20)
    age(profile, "cron-run", 10)
    age(profile, "acp-long", 40)
    age(profile, "acp-long-2", 2)
    age(profile, "pod-chat", 9)
    age(profile, "archived-chat", 50)

    code, answer = step({"profile": str(profile)})
    assert code == 0
    assert ids(answer) == ["archived-chat", "acp-old", "cli-chat", "cron-run", "pod-chat", "acp-long", "acp-new"]
    by_id = {s["id"]: s for s in answer["sessions"]}
    assert [by_id[i]["source"] for i in ("acp-old", "cli-chat", "cron-run", "pod-chat", "acp-long")] == [
        "acp", "cli", "cron", "acp", "acp"]
    assert by_id["acp-old"]["lastActiveAt"] == sessions.iso(old)
    assert by_id["acp-old"]["lastActiveAt"].endswith("Z")
    assert answer["more"] is False


def test_a_reset_conversation_is_listed_under_its_owner(profile: Path):
    # A canonical reset in a pod keeps the creation id as the conversation's owner (its local receipt's lineage) and
    # moves the transcript to a new segment; the editor still holds the creation id.
    try:  # where Hermes keeps the receipt's key: its storage layer since 0.23.3
        from persistence.sqlite.conversation._store.local import POLICY_PREFIX
    except ImportError:
        from hermes_state_local import POLICY_PREFIX

    db = store(profile)
    conversation(db, "acp-owner")
    db.end_session("acp-owner", "session_reset")
    conversation(db, "acp-owner-2", parent_session_id="acp-owner", model_config={"_reset_from": "acp-owner"})
    db.close()
    receipt = {"session_id": "acp-owner", "lineage": ["acp-owner", "acp-owner-2"]}
    with sqlite3.connect(profile / "state.db") as conn:
        conn.execute("INSERT INTO state_meta (key, value) VALUES (?, ?)",
                     (POLICY_PREFIX + "acp-owner", json.dumps(receipt)))
    age(profile, "acp-owner", 12)
    code, answer = step({"profile": str(profile)})
    assert code == 0
    assert [(s["id"], s["source"]) for s in answer["sessions"]] == [("acp-owner", "acp")]


def test_more_leaves_the_most_recent_out(profile: Path, monkeypatch: pytest.MonkeyPatch):
    db = store(profile)
    for n in range(4):
        conversation(db, f"chat-{n}")
    db.close()
    for n in range(4):
        age(profile, f"chat-{n}", 10 - n)
    monkeypatch.setattr(sessions, "LIST_MAX", 3)
    code, answer = step({"profile": str(profile)})
    assert code == 0
    assert ids(answer) == ["chat-0", "chat-1", "chat-2"]
    assert answer["more"] is True


def test_a_read_while_hermes_writes_takes_no_lock_and_writes_nothing_of_its_own(profile: Path):
    db = store(profile)
    conversation(db, "acp-live")
    before = set(os.listdir(profile))
    # Hermes holds its store open and keeps writing, as a person's pod does.
    db.append_message("acp-live", role="assistant", content="still working")
    code, answer = step({"profile": str(profile)})
    db.append_message("acp-live", role="user", content="and again")
    db.close()
    assert code == 0 and ids(answer) == ["acp-live"]
    assert set(os.listdir(profile)) - before <= {"state.db-wal", "state.db-shm"}


@pytest.mark.parametrize("held", ["sqlite", "storage"])
def test_a_store_another_connection_holds_is_busy(profile: Path, monkeypatch: pytest.MonkeyPatch, held: str):
    db = store(profile)
    conversation(db, "acp-held")
    db.close()
    if held == "sqlite":
        error: Exception = sqlite3.OperationalError("database is locked")
    else:
        try:  # Hermes's storage layer's own error, since 0.23.3
            from persistence.core.errors import StoreContention
        except ImportError:
            StoreContention = type("StoreContention", (Exception,), {})
        error = StoreContention("held")

    def holds(*_args):
        raise error

    monkeypatch.setattr(sessions, "_local_owners", holds)
    code, answer = step({"profile": str(profile)})
    assert (code, answer["code"]) == (1, "busy")


def test_refuses_what_isnt_a_profile_path_or_a_step(profile: Path):
    assert step({"profile": "profiles/acc_mara"})[1]["code"] == "invalid"
    assert step({})[1]["code"] == "invalid"
    assert step({"profile": str(profile)}, op="delete")[1]["code"] == "invalid"
