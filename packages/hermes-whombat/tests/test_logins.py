"""Whombat's logins as Hermes's credential vault (HE-S141): listed without a secret, a password only from the runner's
socket at fill time, nothing else of Hermes's vault offered."""

from __future__ import annotations

import json
import socket
import threading
from pathlib import Path

import pytest

from whombat_hermes import logins

from .conftest import needs_hermes


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(logins, "hermes_home", lambda: tmp_path)
    return tmp_path


@pytest.fixture
def runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The runner's logins service standing in: answers one secret per connection, records what it was asked."""
    path = str(tmp_path / "logins.sock")
    asked: list[str] = []
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
                line = conn.makefile("rb").readline()
                entry = json.loads(line)["entry"]
                asked.append(entry)
                answer = ({"password": "hunter2-secret", "otp": "123456"} if entry == "vlt_github"
                          else {"error": "That login isn't one of this turn's."})
                conn.sendall((json.dumps(answer) + "\n").encode())

    threading.Thread(target=serve, daemon=True).start()
    monkeypatch.setenv(logins.SOCKET_ENV, path)
    yield asked
    server.close()


class RefusingCtx:
    """A plugin context as Hermes gives a pip entry point: its login-backend door says no (provenance)."""

    def __init__(self) -> None:
        self.tools: list[dict] = []

    def register_login_backend(self, backend) -> None:
        return None

    def register_tool(self, **kw) -> None:
        from tools.registry import registry

        self.tools.append(kw)
        registry.register(**kw)


@pytest.fixture
def installed(home: Path, monkeypatch: pytest.MonkeyPatch):
    """The backend registered as the plugin registers it, the profile turning it on (VLT-20); undone after."""
    import agent.vault_backend_registry as registry

    (home / "config.yaml").write_text(
        "vault:\n  wb: {enabled: true}\n  onepassword: {enabled: false}\n  bitwarden: {enabled: false}\n",
        encoding="utf-8",
    )
    registry._reset_for_tests()
    how = logins.register_backend(RefusingCtx())
    yield how
    registry._reset_for_tests()


def write_logins(home: Path) -> None:
    (home / logins.LOGINS_FILE).write_text(json.dumps({"logins": [
        {"entryId": "vlt_github", "name": "GitHub", "origin": "https://github.com", "username": "mara@example.com",
         "otp": True},
    ]}))


def test_asks_the_runner_for_one_secret(runner, tmp_path: Path) -> None:
    assert logins.ask_runner("vlt_github")["password"] == "hunter2-secret"
    with pytest.raises(logins.LoginUnavailable):
        logins.ask_runner("vlt_other")
    assert runner == ["vlt_github", "vlt_other"]


def test_without_the_service_there_is_no_secret(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv(logins.SOCKET_ENV, raising=False)
    with pytest.raises(logins.LoginUnavailable):
        logins.ask_runner("vlt_github")
    with pytest.raises(logins.LoginUnavailable):
        logins.ask_runner("vlt_github", path=str(tmp_path / "gone.sock"))


@needs_hermes
def test_the_logins_are_a_registered_backend(home: Path, runner, installed) -> None:
    from agent.vault_backends import backend_for_handle, enabled_backends
    from agent.vault_backends.plugin import PluginLoginBackend

    # Hermes's door turns a pip plugin away: the same backend goes into Hermes's registry, wrapped by Hermes.
    assert installed == "registry"
    whombat = [b for b in enabled_backends() if b.name == "wb"]
    assert len(whombat) == 1 and isinstance(whombat[0], PluginLoginBackend)
    # Hermes's own local store is there too (wiped after every turn); no password manager.
    assert sorted(b.name for b in enabled_backends()) == ["local", "wb"]
    # No login file (a turn without logins, or after it): nothing to list.
    assert whombat[0].list_items() == []
    write_logins(home)
    [item] = whombat[0].list_items()
    assert (item.id, item.origin, item.identifier, item.identifier_type, item.has_otp) == (
        "wb:vlt_github", "https://github.com", "mara@example.com", "email", True)
    backend = backend_for_handle("wb:vlt_github")
    assert backend is not None and backend.name == "wb"
    assert runner == []
    assert backend.resolve_password("wb:vlt_github") == "hunter2-secret"
    assert backend.resolve_otp("wb:vlt_github") == "123456"
    assert runner == ["vlt_github", "vlt_github"]
    # A handle the turn doesn't list is never fetched (Hermes's wrapper says so in its own words).
    with pytest.raises(Exception):
        backend.resolve_password("wb:vlt_other")
    assert runner == ["vlt_github", "vlt_github"]


@needs_hermes
def test_the_agent_sees_logins_never_a_password(home: Path, runner, installed) -> None:
    write_logins(home)
    from tools.browser_vault_tool import browser_vault_list

    listed = browser_vault_list()
    assert "wb:vlt_github" in listed
    assert "mara@example.com" in listed
    assert "hunter2-secret" not in listed
    assert runner == []


@needs_hermes
def test_a_profile_without_it_has_no_whombat_logins(home: Path, installed) -> None:
    from agent.vault_backends import enabled_backends

    # An outsiders' profile (vault.whombat.enabled false): the backend is registered but never offered.
    (home / "config.yaml").write_text("vault:\n  wb: {enabled: false}\n", encoding="utf-8")
    assert "wb" not in [b.name for b in enabled_backends()]


@pytest.fixture
def person(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The runner's logins service answering Hermes's asks as the person did on the card."""
    path = str(tmp_path / "asks.sock")
    asked: list[dict] = []
    answers: dict[str, dict | None] = {}
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
                request = json.loads(conn.makefile("rb").readline())
                asked.append(request)
                answer = answers.get(request.get("ask"))
                if answer is None:  # never answers: the plugin's own wait runs out
                    conn.recv(1)
                    continue
                conn.sendall((json.dumps(answer) + "\n").encode())

    threading.Thread(target=serve, daemon=True).start()
    monkeypatch.setenv(logins.SOCKET_ENV, path)
    yield asked, answers
    server.close()


def test_a_save_login_prompt_asks_the_person_through_the_runner(person) -> None:
    asked, answers = person
    answers["login"] = {"identifier": "mara@example.com", "password": "hunter2-secret", "entry": "vlt_new"}
    assert logins.save_login_prompt("https://github.com", "github.com") == {
        "identifier": "mara@example.com", "password": "hunter2-secret"}
    assert asked == [{"ask": "login", "origin": "https://github.com", "username": None}]
    answers["login"] = {"declined": True, "error": "The person chose Not now."}
    assert logins.save_login_prompt("https://github.com", "github.com") is None


def test_a_code_prompt_gets_the_code_once(person) -> None:
    asked, answers = person
    answers["code"] = {"code": "424242"}
    assert logins.code_prompt("github.com", "") == "424242"
    assert asked[-1] == {"ask": "code", "origin": "https://github.com", "username": None}
    answers["code"] = {"declined": True, "error": "too late"}
    assert logins.code_prompt("github.com", "") == ""


def test_a_wait_that_runs_out_is_a_decline(person, monkeypatch: pytest.MonkeyPatch) -> None:
    _, answers = person
    answers["login"] = None
    monkeypatch.setitem(logins.ASK_TIMEOUT_S, "login", 0.2)
    assert logins.save_login_prompt("https://github.com", "github.com") is None


def test_without_the_service_nobody_is_asked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(logins.SOCKET_ENV, raising=False)
    assert logins.save_login_prompt("https://github.com", "github.com") is None
    assert logins.code_prompt("github.com", "") == ""


@needs_hermes
def test_browser_vault_asks_only_where_the_person_can_answer(person, monkeypatch: pytest.MonkeyPatch) -> None:
    from agent.vault_backends import unlock

    assert unlock.get_save_login_prompt_callback() is None
    with logins.person_prompts():
        assert unlock.get_save_login_prompt_callback() is logins.save_login_prompt
        assert unlock.get_code_prompt_callback() is logins.code_prompt
        assert unlock.can_prompt_here()
    assert unlock.get_save_login_prompt_callback() is None
    # An outsiders' turn or an assessment has no logins service: Hermes keeps saying it can't ask.
    monkeypatch.delenv(logins.SOCKET_ENV)
    with logins.person_prompts():
        assert not unlock.can_prompt_here()


@needs_hermes
def test_browser_vault_is_wrapped_with_the_prompts(person) -> None:
    from agent.vault_backends import unlock
    from tools.registry import registry

    import tools.browser_vault_tool  # noqa: F401

    original = registry.get_entry("browser_vault")
    seen: list = []

    def hermes_handler(args, **kw):
        seen.append(unlock.get_save_login_prompt_callback())
        return "{}"

    # Hermes's own handler stood in for, so the test sees what it runs with.
    registry.register(name="browser_vault", toolset=original.toolset, schema=original.schema, handler=hermes_handler,
                      check_fn=original.check_fn, emoji=original.emoji, override=True)
    ctx = RefusingCtx()
    try:
        assert logins.register_vault_tool(ctx)
        mine = registry.get_entry("browser_vault")
        assert mine.handler is not hermes_handler and ctx.tools[0]["override"] is True
        # Its deadline covers a login's wait for the person (Hermes's default is 420 s).
        assert mine.execution_timeout == logins.TOOL_TIMEOUT_S
        # Registering again (another profile, a reload) wraps nothing twice.
        assert logins.register_vault_tool(ctx) and len(ctx.tools) == 1
        assert mine.handler({"action": "list"}, task_id="t") == "{}"
        assert seen == [logins.save_login_prompt]
        assert unlock.get_save_login_prompt_callback() is None
    finally:
        registry.register(name="browser_vault", toolset=original.toolset, schema=original.schema,
                          handler=original.handler, check_fn=original.check_fn, emoji=original.emoji, override=True)


class OverrideRefusingCtx(RefusingCtx):
    """A plugin context in a home whose config.yaml doesn't grant the plugin ``tools.override`` (Hermes's own check)."""

    def register_tool(self, **kw) -> None:
        from hermes_cli.plugins import PluginToolOverrideError

        raise PluginToolOverrideError("Plugin 'whombat' cannot override built-in tool 'browser_vault'.")


@needs_hermes
def test_a_home_without_the_grant_keeps_hermes_browser_vault_and_says_so_in_one_line(caplog) -> None:
    from tools.registry import registry

    import tools.browser_vault_tool  # noqa: F401

    before = registry.get_entry("browser_vault")
    with caplog.at_level("WARNING", logger=logins.logger.name):
        assert logins.register_vault_tool(OverrideRefusingCtx()) is False
    assert registry.get_entry("browser_vault").handler is before.handler
    said = [r for r in caplog.records if "browser_vault" in r.getMessage()]
    assert len(said) == 1 and said[0].exc_info is None


@needs_hermes
def test_the_profile_grant_lets_the_plugin_override_a_built_in_tool() -> None:
    """`plugins.entries.whombat` as the runner writes it (agent-runtime `hermesPlugins`), read by Hermes's own check."""
    from hermes_cli.plugin_capabilities import plugin_capability_granted

    entry = {"granted_capabilities": ["tools.override"], "allow_tool_override": True}
    config = {"plugins": {"entries": {"whombat": entry}}}
    assert plugin_capability_granted("whombat", "tools.override", config=config)
    assert not plugin_capability_granted("whombat", "tools.override", config={"plugins": {"entries": {}}})
