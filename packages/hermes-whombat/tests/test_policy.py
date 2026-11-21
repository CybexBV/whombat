from __future__ import annotations

import json
import re

import pytest

from whombat_hermes.policy import (ASK, ASK_KIND, NOT_ASKED, UNREADABLE, PolicyError, PolicyFile, parse_policy,
                                   pre_tool_call)


@pytest.fixture
def policy(tmp_path):
    path = tmp_path / "whombat-policy.json"
    return path, PolicyFile(path)


def write(path, data):
    path.write_text(json.dumps(data) if not isinstance(data, str) else data, encoding="utf-8")


def test_no_policy_file_allows_everything(policy):
    _, pf = policy
    assert pre_tool_call(tool_name="terminal", args={}, policy_file=pf) is None


def test_first_matching_rule_decides(policy):
    path, pf = policy
    write(path, {"rules": [{"tools": "mcp__whombat__deploy*", "action": "approve", "message": "Ask John."},
                           {"tools": ["browser_*", "Bash"], "action": "block", "message": "No."},
                           {"tools": "*", "action": "allow"}]})
    assert pre_tool_call(tool_name="mcp__whombat__deploy_site", policy_file=pf) == {
        "action": "approve", "message": "Ask John.", "rule_key": "whombat:0:mcp__whombat__deploy*"}
    assert pre_tool_call(tool_name="Bash", policy_file=pf)["action"] == "block"
    assert pre_tool_call(tool_name="memory", policy_file=pf) is None


def test_the_default_applies_when_nothing_matches(policy):
    path, pf = policy
    write(path, {"rules": [], "default": "approve"})
    assert pre_tool_call(tool_name="anything", policy_file=pf) == {"action": "approve", "message": ASK,
                                                                   "rule_key": "whombat:default"}


@pytest.mark.parametrize("content", ["{not json", json.dumps({"rules": [{"tools": "x", "action": "maybe"}]}),
                                     json.dumps({"default": "sometimes"}), json.dumps([1])])
def test_an_unusable_policy_blocks_every_tool(policy, content):
    path, pf = policy
    write(path, content)
    assert pre_tool_call(tool_name="memory", policy_file=pf) == {"action": "block", "message": UNREADABLE}


def test_the_policy_is_read_once_so_a_change_during_the_turn_counts_for_nothing(policy):
    path, pf = policy
    write(path, {"rules": [{"tools": "x", "action": "block"}]})
    assert pre_tool_call(tool_name="x", policy_file=pf)["action"] == "block"
    write(path, {"rules": [{"tools": "x", "action": "allow", "message": "now fine"}]})
    assert pre_tool_call(tool_name="x", policy_file=pf)["action"] == "block"
    path.unlink()
    assert pre_tool_call(tool_name="x", policy_file=pf)["action"] == "block"


def test_any_failure_fails_closed(monkeypatch):
    class Broken(PolicyFile):
        def load(self):
            raise RuntimeError("disk on fire")

    assert pre_tool_call(tool_name="x", policy_file=Broken())["action"] == "block"


def test_parse_rejects_rules_without_patterns():
    with pytest.raises(PolicyError):
        parse_policy({"rules": [{"tools": [], "action": "allow"}]})


def test_a_keyed_ask_goes_through_hermes_gate_and_a_no_reads_in_whombat_words(policy, tmp_path, monkeypatch):
    path, pf = policy
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr("whombat_hermes.policy.hermes_home", lambda: home)
    write(path, {"rules": [{"tools": ["web_*", "WebFetch"], "action": "approve", "key": "web.browse"}],
                 "default": "block"})
    asked = []

    def yes(tool_name, reason, *, rule_key="", approval_callback=None):
        asked.append((tool_name, json.loads(reason), rule_key))
        return {"approved": True, "message": None}

    monkeypatch.setattr("tools.approval.request_tool_approval", yes)
    assert pre_tool_call(tool_name="web_extract", args={"urls": ["https://example.com/a", "https://b.org"]},
                         policy_file=pf) is None
    tool, said, rule_key = asked[-1]
    assert tool == "web_extract" and rule_key.endswith(":web_extract")
    assert re.fullmatch(r"[0-9a-f]{32}", said.pop("ask"))
    assert said == {"kind": ASK_KIND, "key": "web.browse", "tool": "web_extract",
                    "detail": "https://example.com/a https://b.org"}
    pre_tool_call(tool_name="WebFetch", args={"url": "https://x.dev", "prompt": "p"}, policy_file=pf)
    assert asked[-1][1]["detail"] == "https://x.dev"
    pre_tool_call(tool_name="web_search", args={"query": "q" * 900}, policy_file=pf)
    assert len(asked[-1][1]["detail"]) == 300
    assert pre_tool_call(tool_name="terminal", policy_file=pf)["action"] == "block"

    # A no: the words the runner left for this ask, read once — never Hermes's own “denied”.
    def no(tool_name, reason, **_):
        answers = home / "whombat-asks"
        answers.mkdir(exist_ok=True)
        (answers / json.loads(reason)["ask"]).write_text("Mara said no; it didn’t happen.", encoding="utf-8")
        return {"approved": False, "message": "BLOCKED: User denied this action."}

    monkeypatch.setattr("tools.approval.request_tool_approval", no)
    assert pre_tool_call(tool_name="web_search", args={"query": "x"}, policy_file=pf) == {
        "action": "block", "message": "Mara said no; it didn’t happen."}
    assert list((home / "whombat-asks").iterdir()) == []
    # Nothing left for it: a plain no of Whombat's; a gate that fails blocks.
    monkeypatch.setattr("tools.approval.request_tool_approval", lambda *a, **k: {"approved": False})
    assert pre_tool_call(tool_name="web_search", args={"query": "x"}, policy_file=pf) == {
        "action": "block", "message": NOT_ASKED}

    def broken(*a, **k):
        raise RuntimeError("gate down")

    monkeypatch.setattr("tools.approval.request_tool_approval", broken)
    assert pre_tool_call(tool_name="web_search", args={"query": "x"}, policy_file=pf)["action"] == "block"


def test_path_rules_match_calls_inside_the_profile_only(policy, tmp_path, monkeypatch):
    path, pf = policy
    home = tmp_path / "profile"
    (home / "memories").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr("whombat_hermes.policy.hermes_home", lambda: home)
    write(path, {"rules": [{"tools": ["Read", "Glob", "Grep", "Edit"], "paths": ["$HERMES_HOME"], "action": "block",
                            "message": "Not there."},
                           {"tools": "*", "action": "allow"}]})
    inside = str(home / "memories" / "MEMORY.md")
    assert pre_tool_call(tool_name="Read", args={"file_path": inside}, policy_file=pf) == {
        "action": "block", "message": "Not there."}
    assert pre_tool_call(tool_name="Read", args={"file_path": str(home / ".." / "profile" / "x")},
                         policy_file=pf)["action"] == "block"
    grep = pre_tool_call(tool_name="Grep", args={"pattern": "token", "path": str(home)}, policy_file=pf)
    assert grep["action"] == "block"
    assert pre_tool_call(tool_name="Glob", args={"pattern": f"{home}/**/*.md"}, policy_file=pf)["action"] == "block"
    # A link into the profile is the profile.
    link = tmp_path / "work" / "peek"
    link.parent.mkdir()
    link.symlink_to(home)
    assert pre_tool_call(tool_name="Read", args={"file_path": f"{link}/memories/MEMORY.md"},
                         policy_file=pf)["action"] == "block"
    assert pre_tool_call(tool_name="Read", args={"file_path": str(tmp_path / "work" / "a.txt")}, policy_file=pf) is None
    assert pre_tool_call(tool_name="Read", args={"file_path": str(tmp_path / "profile-other")}, policy_file=pf) is None
    assert pre_tool_call(tool_name="Bash", args={"command": f"cat {inside}"}, policy_file=pf) is None


def test_hermes_file_tools_stay_out_of_the_home_but_its_skills(policy, tmp_path, monkeypatch):
    """One-person.md OP-07: Hermes's own file tools run in its process, so its home is closed to them but ``skills/``;
    a V4A patch counts every file it names, and an allow needs all of them inside."""
    path, pf = policy
    home = tmp_path / "hermes"
    (home / "skills" / "ops" / "deploy").mkdir(parents=True)
    (home / "skills" / ".whombat").mkdir()
    monkeypatch.setattr("whombat_hermes.policy.hermes_home", lambda: home)
    tools = ["read_file", "write_file", "patch", "search_files"]
    write(path, {"rules": [{"tools": tools, "paths": ["$HERMES_HOME/skills/.whombat"], "action": "block",
                            "message": "Not there."},
                           {"tools": tools, "paths": ["$HERMES_HOME/skills"], "action": "allow"},
                           {"tools": tools, "paths": ["$HERMES_HOME"], "action": "block", "message": "Not there."},
                           {"tools": "*", "action": "allow"}]})
    skill = str(home / "skills" / "ops" / "deploy" / "SKILL.md")
    for tool in tools:
        assert pre_tool_call(tool_name=tool, args={"path": str(home / "auth.json")}, policy_file=pf)["action"] == \
            "block", tool
        assert pre_tool_call(tool_name=tool, args={"path": skill}, policy_file=pf) is None, tool
        assert pre_tool_call(tool_name=tool, args={"path": str(home / "skills" / ".whombat" / "skills.json")},
                             policy_file=pf)["action"] == "block", tool
    # A patch naming a skill and the login: blocked, though one of its files is a skill.
    both = f"*** Begin Patch\n*** Update File: {skill}\n@@\n-a\n+b\n*** Update File: {home / 'auth.json'}\n*** End Patch"
    assert pre_tool_call(tool_name="patch", args={"mode": "patch", "patch": both}, policy_file=pf)["action"] == "block"
    only = f"*** Begin Patch\n*** Add File: {home / 'skills' / 'ops' / 'deploy' / 'notes.md'}\n+hi\n*** End Patch"
    assert pre_tool_call(tool_name="patch", args={"mode": "patch", "patch": only}, policy_file=pf) is None
    # A relative path resolves as Hermes resolves it, here from the working directory.
    monkeypatch.chdir(home)
    assert pre_tool_call(tool_name="read_file", args={"path": "auth.json"}, policy_file=pf)["action"] == "block"
    assert pre_tool_call(tool_name="search_files", args={"pattern": "token"}, policy_file=pf)["action"] == "block"
    assert pre_tool_call(tool_name="read_file", args={"path": str(tmp_path / "work.txt")}, policy_file=pf) is None


def test_a_path_rule_on_an_unset_variable_blocks_every_tool(policy, monkeypatch):
    path, pf = policy
    monkeypatch.delenv("WHOMBAT_NOT_SET", raising=False)
    write(path, {"rules": [{"tools": "Read", "paths": ["$WHOMBAT_NOT_SET"], "action": "block"}]})
    assert pre_tool_call(tool_name="memory", policy_file=pf) == {"action": "block", "message": UNREADABLE}
    write(path, {"rules": [{"tools": "Read", "paths": ["relative/dir"], "action": "block"}]})
    assert pre_tool_call(tool_name="memory", policy_file=pf)["action"] == "block"
