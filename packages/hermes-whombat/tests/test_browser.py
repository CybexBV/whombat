"""The plugin's browser tools (Whombat HE-S300): agent-browser on Whombat's Chromium, never Hermes's ``browser_exec``."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from whombat_hermes import browser
from .conftest import flag_value, needs_hermes, write_config


class FakeRun:
    """Stands in for ``subprocess.run``: records the call and answers as ``agent-browser --json batch`` does."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def __call__(self, argv, **kw):
        self.calls.append({"argv": argv, **kw})
        answer = self.answers.pop(0) if self.answers else {"success": True, "result": {}}
        out = answer if isinstance(answer, str) else json.dumps([answer])
        return subprocess.CompletedProcess(argv, 0 if '"success": true' in out else 1, out, "")


@pytest.fixture
def ready(tmp_path, monkeypatch, hermes_home):
    tool = tmp_path / "agent-browser"
    tool.write_text("#!/bin/sh\n")
    tool.chmod(0o755)
    monkeypatch.setenv(browser.AGENT_BROWSER_ENV, str(tool))
    monkeypatch.setattr(browser, "cdp_url", lambda: "http://127.0.0.1:47105")
    monkeypatch.setattr(browser, "url_refusal", lambda url: None)
    monkeypatch.setattr(browser, "redact", lambda value, depth=0: value)
    return tool


def test_a_command_goes_on_stdin_never_into_argv(ready):
    run = FakeRun({"success": True, "result": {"filled": "@e3"}})
    out = json.loads(browser.browser_type("e3", "--session evil -h", task_id="t1", run=run))
    assert out == {"success": True, "typed_into": "@e3"}
    call = run.calls[0]
    assert call["argv"][-2:] == ["--json", "batch"]
    assert "--session evil -h" not in " ".join(call["argv"])
    assert json.loads(call["input"]) == [["fill", "@e3", "--session evil -h"]]
    assert flag_value(call["argv"], "--cdp") == "http://127.0.0.1:47105"
    # One daemon per task: the same session for its calls, another for another task.
    session = flag_value(call["argv"], "--session")
    endpoint = "http://127.0.0.1:47105"
    assert session == browser.session_name("t1", endpoint) != browser.session_name("t2", endpoint)
    assert session != browser.session_name("t1", "http://127.0.0.1:47106")
    assert len(session) <= 20


def test_agent_browser_gets_no_credential_and_reaches_the_relay_past_a_proxy(monkeypatch):
    env = browser.browser_env({"PATH": "/bin", "ANTHROPIC_API_KEY": "k", "WHOMBAT_MCP_TOKEN": "t",
                               "CLAUDE_CONFIG_DIR": "/x", "HTTPS_PROXY": "http://proxy:3128", "NO_PROXY": "example",
                               "AGENT_BROWSER_EXECUTABLE_PATH": "/evil"})
    assert "ANTHROPIC_API_KEY" not in env and "WHOMBAT_MCP_TOKEN" not in env and "CLAUDE_CONFIG_DIR" not in env
    assert "AGENT_BROWSER_EXECUTABLE_PATH" not in env
    assert env["NO_PROXY"].startswith("example,") and "127.0.0.1" in env["NO_PROXY"]
    assert env["AGENT_BROWSER_IDLE_TIMEOUT_MS"] and os.path.isdir(env["AGENT_BROWSER_SOCKET_DIR"])


@pytest.mark.parametrize("call", [
    lambda run: browser.browser_click("#submit", run=run),
    lambda run: browser.browser_type("--cdp", "x", run=run),
    lambda run: browser.browser_press("--help", run=run),
    lambda run: browser.browser_press("Enter Enter", run=run),
    lambda run: browser.browser_scroll("left", run=run),
    lambda run: browser.browser_navigate("file:///etc/passwd", run=run),
    lambda run: browser.browser_navigate("javascript:alert(1)", run=run),
])
def test_what_isnt_a_ref_key_direction_or_web_address_is_refused_before_the_browser(ready, call):
    run = FakeRun()
    assert json.loads(call(run))["success"] is False
    assert run.calls == []


def test_navigate_opens_and_returns_a_compact_snapshot(ready):
    run = FakeRun({"success": True, "result": {"title": "Shop", "url": "https://shop.example/"}},
                  {"success": True, "result": {"snapshot": "- link \"Cart\" [ref=e1]", "refs": {"e1": {}}}})
    out = json.loads(browser.browser_navigate("https://shop.example/", task_id="t", run=run))
    assert out == {"success": True, "url": "https://shop.example/", "title": "Shop",
                   "snapshot": "- link \"Cart\" [ref=e1]", "element_count": 1}
    assert [json.loads(c["input"])[0][0] for c in run.calls] == ["open", "snapshot"]


def test_a_redirect_to_a_refused_address_leaves_a_blank_page(ready, monkeypatch):
    monkeypatch.setattr(browser, "url_refusal", lambda url: "Blocked: metadata" if "169.254" in url else None)
    run = FakeRun({"success": True, "result": {"title": "", "url": "http://169.254.169.254/latest"}}, {"success": True})
    out = json.loads(browser.browser_navigate("https://evil.example/", run=run))
    assert out["success"] is False and "metadata" in out["error"]
    assert json.loads(run.calls[1]["input"]) == [["open", "about:blank"]]


def test_a_long_snapshot_is_cut_at_a_line(ready):
    lines = "\n".join(f"- text \"line {i}\"" for i in range(3000))
    run = FakeRun({"success": True, "result": {"snapshot": lines, "refs": {}}})
    out = json.loads(browser.browser_snapshot(full=True, run=run))
    assert len(out["snapshot"]) < 15200 and "cut at" in out["snapshot"]
    assert json.loads(run.calls[0]["input"]) == [["snapshot"]]


def test_a_failed_command_says_why(ready):
    run = FakeRun({"success": False, "error": "Element not found: @e9"})
    out = json.loads(browser.browser_click("@e9", run=run))
    assert out == {"success": False, "error": "Element not found: @e9"}
    garbled = FakeRun("not json")
    assert "failed" in json.loads(browser.browser_back(run=garbled))["error"]


def test_no_browser_in_the_turn_runs_nothing(ready, monkeypatch):
    monkeypatch.setattr(browser, "cdp_url", lambda: "")
    run = FakeRun()
    assert json.loads(browser.browser_snapshot(run=run))["success"] is False
    assert run.calls == []


def test_registers_only_what_hermes_lacks(monkeypatch):
    seen = []

    class Ctx:
        def register_tool(self, **kw):
            seen.append(kw)

    monkeypatch.setattr(browser, "hermes_has", lambda name: name == "browser_back")
    names = browser.register(Ctx())
    assert "browser_navigate" in names and "browser_back" not in names
    assert {kw["toolset"] for kw in seen} == {"browser"}
    assert "browser_exec" not in names


# ---------------------------------------------------------------------------------------------------------------------
# With Hermes


@needs_hermes
def test_browser_exec_is_in_the_toolset_whombat_turns_off():
    """The config turns off ``browser-use`` (``HERMES_BROWSER_EXEC_TOOLSET``): that must stay where Hermes keeps
    ``browser_exec``, or it would reach a turn."""
    import model_tools  # noqa: F401  (Hermes's tool discovery)
    from tools.registry import registry

    if registry.get_schema("browser_exec") is None:
        pytest.skip("this Hermes has no browser_exec")
    assert registry.get_toolset_for_tool("browser_exec") == "browser-use"


@needs_hermes
def test_hermes_refuses_a_cloud_metadata_address():
    assert browser.url_refusal("http://169.254.169.254/latest/meta-data/")
    assert browser.url_refusal("https://example.com/") is None


@needs_hermes
def test_the_tools_read_the_profiles_relay(hermes_home):
    write_config(hermes_home, "browser:\n  cdp_url: http://127.0.0.1:47105\n")
    assert browser.cdp_url() == "http://127.0.0.1:47105"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def chromium(tmp_path):
    binary = next((shutil.which(n) for n in ("chromium", "chromium-browser", "google-chrome") if shutil.which(n)), None)
    if not binary or not browser.agent_browser():
        pytest.skip("no Chromium or agent-browser here")
    port = _free_port()
    proc = subprocess.Popen([binary, "--headless=new", "--no-sandbox", f"--user-data-dir={tmp_path / 'profile'}",
                             f"--remote-debugging-port={port}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 60
    while True:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as answer:
                if answer.status == 200:
                    break
        except OSError:
            pass
        if time.monotonic() > deadline or proc.poll() is not None:
            proc.kill()
            pytest.fail("Chromium's DevTools didn't answer")
        time.sleep(0.2)
    yield f"http://127.0.0.1:{port}"
    proc.terminate()
    proc.wait(10)


@pytest.fixture
def page():
    class Page(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b"<title>Burrow</title><h1>Welcome to the burrow</h1><input aria-label=Name><button>Go</button>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()


@needs_hermes
def test_a_real_page_opens_reads_and_takes_typing(hermes_home, chromium, page):
    write_config(hermes_home, f"browser:\n  cdp_url: {chromium}\n  allow_private_urls: true\n")
    opened = json.loads(browser.browser_navigate(page, task_id="real"))
    assert opened["success"], opened
    assert opened["title"] == "Burrow" and opened["element_count"] >= 2
    full = json.loads(browser.browser_snapshot(full=True, task_id="real"))
    assert "Welcome to the burrow" in full["snapshot"]
    box = next(line for line in full["snapshot"].splitlines() if "textbox" in line)
    ref = box[box.index("ref=") + 4:].rstrip("]").split(",")[0]
    assert json.loads(browser.browser_type(ref, "-h --session x", task_id="real"))["success"]
    value = json.loads(browser.browser_console(expression="document.querySelector('input').value", task_id="real"))
    assert value == {"success": True, "result": "-h --session x"}
    shot = browser.browser_vision("what is there", task_id="real")
    path = shot["meta"]["screenshot_path"] if isinstance(shot, dict) else json.loads(shot)["screenshot_path"]
    assert Path(path).is_file()
