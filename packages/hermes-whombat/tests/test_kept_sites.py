"""``browser_keep_site`` (Whombat kept-sites.md): the agent's keep, forget and list go to the runner's logins socket as
origins, https only, with bounded hours; its answers name the site and never carry a cookie."""

from __future__ import annotations

import json
import socket
import threading
from pathlib import Path

import pytest

from whombat_hermes import browser, kept_sites, logins

SITE = {"id": "kst_site00000001", "site": "accounts.hetzner.com",
        "origins": ["https://accounts.hetzner.com", "https://konsoleh.hetzner.com"], "agentId": "prn_agent00000001",
        "hours": 6, "keptAt": "2026-11-13T10:00:00.000Z", "lastUsedAt": "2026-11-13T10:00:00.000Z",
        "expiresAt": "2026-11-13T16:00:00.000Z"}


@pytest.fixture
def runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The runner's logins service standing in: records each request, answers what the test set (a cookie slipped in to
    show the tool never passes one on)."""
    path = str(tmp_path / "logins.sock")
    state: dict = {"asked": [], "answer": {"ok": True, "site": {**SITE, "cookies": [{"value": "secret-sid"}]}}}
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
                state["asked"].append(json.loads(conn.makefile("rb").readline()))
                conn.sendall((json.dumps(state["answer"]) + "\n").encode())

    threading.Thread(target=serve, daemon=True).start()
    monkeypatch.setenv(logins.SOCKET_ENV, path)
    monkeypatch.delenv("WHOMBAT_POD", raising=False)
    yield state
    server.close()


def call(args: dict) -> dict:
    return json.loads(kept_sites.keep_site(args))


def test_keeps_a_site_by_its_origins(runner) -> None:
    out = call({"action": "keep", "site": "https://Accounts.Hetzner.com/login?next=/", "also": ["konsoleh.hetzner.com"],
                "hours": 6})
    assert runner["asked"] == [{"keep": {"origins": ["https://accounts.hetzner.com", "https://konsoleh.hetzner.com"],
                                         "hours": 6}}]
    assert out["success"] is True
    assert out["kept"] == "accounts.hetzner.com"
    assert out["origins"] == SITE["origins"]
    assert out["until"] == SITE["expiresAt"]
    assert "6 hours" in out["note"]
    assert "secret" not in json.dumps(out) and "cookie" not in json.dumps(out).lower()


def test_hours_default_and_bounds(runner) -> None:
    call({"action": "keep", "site": "https://example.com"})
    assert runner["asked"][-1]["keep"]["hours"] == kept_sites.DEFAULT_HOURS == 4
    call({"action": "keep", "site": "https://example.com", "hours": 24})
    assert runner["asked"][-1]["keep"]["hours"] == 24
    for bad in (0, 25, -1, 2.5, "lots", True):
        out = call({"action": "keep", "site": "https://example.com", "hours": bad})
        assert out["success"] is False, bad
    assert len(runner["asked"]) == 2


def test_https_origins_only(runner) -> None:
    assert kept_sites.origin_of("https://Shop.Example.com:443/a/b?c#d") == "https://shop.example.com"
    assert kept_sites.origin_of("shop.example.com") == "https://shop.example.com"
    assert kept_sites.origin_of("https://shop.example.com:8443/") == "https://shop.example.com:8443"
    assert kept_sites.origin_of("https://bücher.example/") == "https://xn--bcher-kva.example"
    for bad in ("http://shop.example.com", "ftp://shop.example.com", "https://user:pw@shop.example.com", "",
                "https://", "https://shop example.com", None):
        with pytest.raises(kept_sites.SiteError):
            kept_sites.origin_of(bad)
    out = call({"action": "keep", "site": "http://accounts.hetzner.com"})
    assert out["success"] is False and "https" in out["error"]
    out = call({"action": "keep", "site": "https://accounts.hetzner.com", "also": ["http://konsoleh.hetzner.com"]})
    assert out["success"] is False
    assert runner["asked"] == []
    assert kept_sites.origins_of("https://a.example", ["https://a.example/x", "b.example"]) == [
        "https://a.example", "https://b.example"]


def test_forget_and_list(runner) -> None:
    runner["answer"] = {"ok": True, "forgotten": [SITE]}
    out = call({"action": "forget", "site": "https://konsoleh.hetzner.com/x"})
    assert runner["asked"][-1] == {"forget": {"origins": ["https://konsoleh.hetzner.com"]}}
    assert out == {"success": True, "forgotten": ["accounts.hetzner.com"], "note": out["note"]}
    runner["answer"] = {"ok": True, "sites": [{**SITE, "cookies": [{"value": "secret-sid"}]}]}
    out = call({"action": "list"})
    assert runner["asked"][-1] == {"kept": "list"}
    assert out["sites"] == [{"site": "accounts.hetzner.com", "origins": SITE["origins"], "until": SITE["expiresAt"]}]
    assert "secret" not in json.dumps(out)


def test_says_why_not(runner, monkeypatch: pytest.MonkeyPatch) -> None:
    assert call({"action": "keep"})["success"] is False
    assert call({"action": "stash", "site": "https://example.com"})["success"] is False
    assert runner["asked"] == []
    runner["answer"] = {"ok": False, "error": "There's no sign-in for that site in the browser yet."}
    out = call({"action": "keep", "site": "https://example.com"})
    assert out == {"success": False, "error": "There's no sign-in for that site in the browser yet."}
    # No socket (no turn of the person's): said plainly.
    monkeypatch.delenv(logins.SOCKET_ENV)
    assert call({"action": "list"})["success"] is False


def test_names_the_session_in_a_pod(runner, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WHOMBAT_POD", "1")
    monkeypatch.setattr(logins, "turn_session", lambda: "20261113_101010_abcdef")
    call({"action": "list"})
    assert runner["asked"][-1] == {"kept": "list", "session": "20261113_101010_abcdef"}
    # A session Whombat doesn't know: nothing sent.
    monkeypatch.setattr(logins, "turn_session", lambda: None)
    assert call({"action": "list"})["success"] is False
    assert len(runner["asked"]) == 1


def test_registered_as_a_browser_tool(runner, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = []

    class Ctx:
        def register_tool(self, **kw):
            seen.append(kw)

    monkeypatch.setattr(browser, "hermes_has", lambda name: False)
    names = browser.register(Ctx())
    assert "browser_keep_site" in names
    mine = next(kw for kw in seen if kw["name"] == "browser_keep_site")
    assert mine["toolset"] == "browser" and mine["check_fn"] is browser.available
    params = mine["schema"]["parameters"]
    assert params["required"] == ["action"]
    assert set(params["properties"]) == {"action", "site", "also", "hours"}
    assert params["properties"]["action"]["enum"] == ["keep", "forget", "list"]
    description = mine["schema"]["description"]
    for phrase in ("between chats", "two-factor", "forget"):
        assert phrase in description
    runner["answer"] = {"ok": True, "sites": []}
    assert json.loads(mine["handler"]({"action": "list"}, task_id="t"))["success"] is True
