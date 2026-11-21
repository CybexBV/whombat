"""A person's pod (Whombat hermes-native.md HN-W04, HN-W06): one Hermes serves several turns, and what is a turn's own
is chosen by the Hermes session a tool call runs in — its tool policy (failing closed without one), its logins, the
session its commands name to the runner."""

from __future__ import annotations

import json
import os
import socket
import threading
from pathlib import Path

import pytest

from whombat_hermes import logins, policy, settings
from whombat_hermes.policy import NO_SESSION, UNREADABLE, pre_tool_call

from .conftest import needs_hermes


@pytest.fixture
def pod(hermes_home: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv(settings.POD_ENV, "1")
    monkeypatch.setattr(policy, "_session_policies", policy.SessionPolicies())
    return hermes_home


def write_session(home: Path, session: str, name: str, data) -> Path:
    path = home / settings.TURNS_DIR / session / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def test_each_session_obeys_its_own_policy(pod: Path) -> None:
    write_session(pod, "sess-a", "policy.json", {"rules": [{"tools": "web_search", "action": "allow"}],
                                                 "default": "block"})
    write_session(pod, "sess-b", "policy.json", {"rules": [{"tools": "web_search", "action": "block",
                                                            "message": "B may not search."}]})
    assert pre_tool_call(tool_name="web_search", session_id="sess-a") is None
    assert pre_tool_call(tool_name="web_search", session_id="sess-b") == {"action": "block",
                                                                         "message": "B may not search."}
    # The profile's policy is no session's.
    (pod / "whombat-policy.json").write_text(json.dumps({"rules": [], "default": "allow"}), encoding="utf-8")
    assert pre_tool_call(tool_name="terminal", session_id="sess-a")["action"] == "block"


@pytest.mark.parametrize("ids", [{}, {"session_id": "sess-none"}, {"session_id": "../sess-a"},
                                 {"session_id": "a/b"}])
def test_a_call_without_a_known_session_is_blocked(pod: Path, ids: dict) -> None:
    write_session(pod, "sess-a", "policy.json", {"rules": [], "default": "allow"})
    assert pre_tool_call(tool_name="memory", **ids) == {"action": "block", "message": UNREADABLE}
    assert NO_SESSION != UNREADABLE  # what the log says differs; the agent reads the same pause


def test_a_session_policy_is_read_again_when_the_runner_changes_it(pod: Path) -> None:
    path = write_session(pod, "sess-a", "policy.json", {"rules": [{"tools": "x", "action": "block"}]})
    assert pre_tool_call(tool_name="x", session_id="sess-a")["action"] == "block"
    path.write_text(json.dumps({"rules": [{"tools": "x", "action": "allow"}], "default": "block"}), encoding="utf-8")
    os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 1_000_000))
    assert pre_tool_call(tool_name="x", session_id="sess-a") is None
    # Gone (the session was forgotten): blocked, not allowed.
    path.unlink()
    assert pre_tool_call(tool_name="x", session_id="sess-a")["action"] == "block"


def test_outside_a_pod_the_profile_policy_stays_as_it_was(hermes_home: Path, monkeypatch) -> None:
    monkeypatch.delenv(settings.POD_ENV, raising=False)
    assert policy.policy_for({"session_id": "sess-a"}) is policy._policy_file


@needs_hermes
def test_the_session_context_wins_over_the_hooks_session(pod: Path) -> None:
    """A sub-agent's hook names its own session; its context is its parent's, the turn's."""
    from gateway.session_context import scoped_current_session_id

    write_session(pod, "parent", "policy.json", {"rules": [], "default": "allow"})
    with scoped_current_session_id("parent"):
        assert settings.turn_session("child") == "parent"
        assert pre_tool_call(tool_name="memory", session_id="child") is None
    assert settings.turn_session("child") == "child"
    # os.environ's copy (whichever session set it last) is never taken for the context's.
    os.environ["HERMES_SESSION_ID"] = "parent"
    try:
        assert settings.context_session() is None
    finally:
        os.environ.pop("HERMES_SESSION_ID", None)


@needs_hermes
def test_a_command_names_its_session_to_the_launcher(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from gateway.session_context import scoped_current_session_id

    from whombat_hermes import terminal
    from whombat_hermes.terminal import make_provider

    launcher = tmp_path / "whombat-command"
    launcher.write_text(f'printf %s "$WHOMBAT_TURN_SESSION" >> "{tmp_path}/sessions.txt"\n'
                        'echo >> "' + str(tmp_path) + '/sessions.txt"\nexec "$@"\n', encoding="utf-8")
    monkeypatch.setenv(terminal.NODE_ENV, "/bin/sh")
    monkeypatch.setenv(terminal.LAUNCHER_ENV, str(launcher))
    # Whatever the process's environment says is never the command's session.
    monkeypatch.setenv(settings.SESSION_ENV, "planted")
    env = make_provider().create_environment(cwd=str(tmp_path), timeout=30)
    try:
        with scoped_current_session_id("sess-a"):
            assert env.execute("true")["returncode"] == 0
        with scoped_current_session_id("sess-b"):
            assert env.execute("true")["returncode"] == 0
    finally:
        env.cleanup()
    seen = (tmp_path / "sessions.txt").read_text().splitlines()
    assert seen[-2:] == ["sess-a", "sess-b"]
    assert "planted" not in seen


@pytest.fixture
def asked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The runner's logins service standing in: records each request whole."""
    path = str(tmp_path / "logins.sock")
    requests: list[dict] = []
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(4)

    def serve() -> None:
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            with conn:
                requests.append(json.loads(conn.makefile("rb").readline()))
                conn.sendall(b'{"password": "pw", "otp": null}\n')

    threading.Thread(target=serve, daemon=True).start()
    monkeypatch.setenv(logins.SOCKET_ENV, path)
    yield requests
    server.close()


def test_a_fill_names_its_session_and_lists_its_own_logins(pod: Path, asked, monkeypatch) -> None:
    write_session(pod, "sess-a", logins.SESSION_LOGINS_FILE,
                  {"logins": [{"entryId": "vlt_a", "name": "A", "origin": "https://a.example", "username": "a"}]})
    write_session(pod, "sess-b", logins.SESSION_LOGINS_FILE,
                  {"logins": [{"entryId": "vlt_b", "name": "B", "origin": "https://b.example", "username": "b"}]})
    monkeypatch.setattr(settings, "context_session", lambda: "sess-a")
    monkeypatch.setattr(logins, "turn_session", lambda fallback=None: "sess-a")
    assert [x["entryId"] for x in logins._listed()] == ["vlt_a"]
    assert logins.ask_runner("vlt_a")["password"] == "pw"
    assert asked == [{"entry": "vlt_a", "session": "sess-a"}]
    monkeypatch.setattr(logins, "turn_session", lambda fallback=None: None)
    assert logins._listed() == []
    with pytest.raises(logins.LoginUnavailable):
        logins.ask_runner("vlt_a")
    assert len(asked) == 1
