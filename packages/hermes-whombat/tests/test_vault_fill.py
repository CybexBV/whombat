"""A Vault login filled into the page the agent opened with Whombat's browser tools (HE-S141, HE-S300, HE-S307): Hermes's
``browser_vault`` reaches that page over its own CDP connection to the same Chromium, ``browser.cdp_url``. With a real
Chromium, agent-browser and Hermes: no Hermes browser tool ran before the fill, as in every turn since Hermes 0.22.6."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from whombat_hermes import browser, logins

from .conftest import needs_hermes, write_config
from .test_browser import chromium  # noqa: F401 -- the fixture
from .test_logins import RefusingCtx, runner  # noqa: F401 -- the fixture

LOGIN_PAGE = (b"<title>Sign in</title><form><input name=email type=email autocomplete=username aria-label=Email>"
              b"<input name=password type=password autocomplete=current-password aria-label=Password>"
              b"<button>Sign in</button></form>")


@pytest.fixture
def login_page():
    class Page(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(LOGIN_PAGE)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, chromium, login_page, runner):  # noqa: F811
    """A profile as the runner writes it: the relay's address, the Whombat logins on, one login for the page's origin;
    the plugin's backend and its ``browser_vault`` registered as the plugin registers them. Undone after."""
    import agent.vault_backend_registry as vault_registry
    from tools import browser_session
    from tools.browser_session_lifecycle import cleanup_browser
    from tools.registry import registry

    import tools.browser_vault_tool  # noqa: F401 -- Hermes's own tool

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(logins, "hermes_home", lambda: tmp_path)
    write_config(tmp_path, f"browser:\n  cdp_url: {chromium}\n  allow_private_urls: true\n"
                           "vault:\n  wb: {enabled: true}\n  onepassword: {enabled: false}\n  bitwarden: {enabled: false}\n")
    (tmp_path / logins.LOGINS_FILE).write_text(json.dumps({"logins": [
        {"entryId": "vlt_github", "name": "Burrow", "origin": login_page, "username": "mara@example.com"},
    ]}))
    original = registry.get_entry("browser_vault")
    vault_registry._reset_for_tests()
    logins.register_backend(RefusingCtx())
    assert logins.register_vault_tool(RefusingCtx())
    yield registry.get_entry("browser_vault").handler
    cleanup_browser("fill")
    assert browser_session.session_for_task("fill") == {}
    vault_registry._reset_for_tests()
    registry.register(name="browser_vault", toolset=original.toolset, schema=original.schema, handler=original.handler,
                      check_fn=original.check_fn, emoji=original.emoji, override=True)


@needs_hermes
def test_a_login_fills_the_page_the_browser_tools_opened(vault, login_page, runner) -> None:  # noqa: F811
    opened = json.loads(browser.browser_navigate(f"{login_page}/login", task_id="fill"))
    assert opened["success"], opened

    answer = vault({"action": "fill", "handle": "wb:vlt_github", "target": "browser"}, task_id="fill")
    result = json.loads(answer)
    assert result.get("success") is True, result
    assert result["origin"] == login_page
    # One password asked for, filled into the page, never in the answer.
    assert runner == ["vlt_github"]
    assert "hunter2-secret" not in answer
    filled = json.loads(browser.browser_console(expression="document.querySelector('[name=password]').value.length",
                                                task_id="fill"))
    assert filled == {"success": True, "result": len("hunter2-secret")}
    # The Chromium the tools drive is still the one open: the vault's connection to it closed nothing.
    still = json.loads(browser.browser_console(expression="location.href", task_id="fill"))
    assert still == {"success": True, "result": f"{login_page}/login"}


@needs_hermes
def test_without_the_relay_hermes_opens_no_browser_of_its_own(hermes_home, monkeypatch: pytest.MonkeyPatch) -> None:
    from tools import browser_session

    def launched(*args, **kwargs):
        raise AssertionError("Hermes was asked for a browser session without browser.cdp_url")

    monkeypatch.setattr(browser_session, "get_session_info", launched)
    write_config(hermes_home, "browser:\n  allow_private_urls: true\n")
    assert browser.hermes_session("plain") is False
