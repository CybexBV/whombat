from __future__ import annotations

import json

from whombat_hermes.paths import HOME_ENV, pre_tool_call
from whombat_hermes.policy import PolicyFile, call_paths
from whombat_hermes.policy import pre_tool_call as policy_hook


def test_a_file_tools_home_path_is_the_commands_home(monkeypatch):
    monkeypatch.setenv(HOME_ENV, "/persist/agent/home/")
    assert pre_tool_call(tool_name="write_file", args={"path": "~/work/site.conf", "content": "x"}) == {
        "action": "modify", "args": {"path": "/persist/agent/home/work/site.conf"}}
    assert pre_tool_call(tool_name="search_files", args={"path": "~"})["args"] == {"path": "/persist/agent/home"}
    patch = "*** Begin Patch\n*** Update File: ~/work/a.txt\n@@\n-a\n+b\n*** Move to: ~/b.txt\n*** End Patch"
    changed = pre_tool_call(tool_name="patch", args={"mode": "patch", "patch": patch})["args"]["patch"]
    assert "*** Update File: /persist/agent/home/work/a.txt" in changed
    assert "*** Move to: /persist/agent/home/b.txt" in changed


def test_other_paths_and_tools_are_left_alone(monkeypatch):
    monkeypatch.setenv(HOME_ENV, "/persist/agent/home")
    assert pre_tool_call(tool_name="write_file", args={"path": "/tmp/x", "content": ""}) is None
    assert pre_tool_call(tool_name="read_file", args={"path": "notes/~draft.md"}) is None
    assert pre_tool_call(tool_name="read_file", args={"path": "~other/x"}) is None
    assert pre_tool_call(tool_name="terminal", args={"path": "~/x"}) is None


def test_without_the_commands_wrapper_nothing_changes(monkeypatch):
    monkeypatch.delenv(HOME_ENV, raising=False)
    assert pre_tool_call(tool_name="write_file", args={"path": "~/x", "content": ""}) is None
    monkeypatch.setenv(HOME_ENV, "relative")
    assert pre_tool_call(tool_name="write_file", args={"path": "~/x", "content": ""}) is None


def test_the_policy_checks_the_path_that_will_be_written(monkeypatch, tmp_path):
    home = tmp_path / "agent"
    private = tmp_path / "private"
    home.mkdir()
    private.mkdir()
    monkeypatch.setenv(HOME_ENV, str(home))
    monkeypatch.setenv("WB_PRIVATE", str(private))
    assert call_paths("write_file", {"path": "~/x.txt"}) == [str(home / "x.txt")]
    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps({"rules": [
        {"tools": "write_file", "paths": ["$WB_PRIVATE"], "action": "block", "message": "No."}]}), encoding="utf-8")
    hook = PolicyFile(policy)
    assert policy_hook(tool_name="write_file", args={"path": "~/../private/x"}, policy_file=hook)["action"] == "block"
    assert policy_hook(tool_name="write_file", args={"path": "~/x"}, policy_file=hook) is None
