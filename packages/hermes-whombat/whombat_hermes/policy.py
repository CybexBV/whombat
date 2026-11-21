"""Whombat's ``pre_tool_call`` hook (HE-17), the skeleton step 3 fills: it sees every tool call Hermes's loop makes —
Hermes's own tools, the plugin's and the MCP servers' (a Claude turn's too: on DirectSDK the CLI runs no tool itself,
CDS-01) — and fails closed.

The policy is ``$HERMES_HOME/whombat-policy.json`` (written by the runner every turn from the agent's keys, HE-44;
optional) — in a person's pod, where one Hermes serves several turns (Whombat hermes-native.md HN-W06), the policy of
the session the call runs in, ``$HERMES_HOME/whombat-turns/<session>/policy.json``, read again when the runner changes
it, and a session without one blocks every tool::

    {"rules": [{"tools": ["Read", "Grep", "Glob"], "paths": ["$HERMES_HOME"], "action": "block", "message": "…"},
               {"tools": ["web_search", "WebFetch"], "action": "approve", "key": "web.browse"},
               {"tools": "browser_*", "action": "block", "message": "…"}],
     "default": "block"}

The first rule that matches decides: ``allow``, ``approve`` (a person answers through Hermes's approval gate, so an
ACP client gets ``session/request_permission``) or ``block`` (the message is the tool's result). A rule matches a tool
name by its patterns (``fnmatch``; a string or a list); with ``paths`` (directories; ``$HERMES_HOME`` and other
``$NAME``s from the environment expanded) it matches only a call whose path arguments (``file_path``, ``path``,
``notebook_path``, a Glob's absolute ``pattern``, the files a V4A ``patch`` names, ``search_files``' directory) lie
inside one of them — any of them for ``block`` and ``approve``, every one for ``allow``. Hermes's own file tools'
relative paths are resolved as Hermes resolves them (the session's workspace, ``_resolve_path_for_task``). An ``approve`` rule with a ``key`` (the
Whombat key it stands for) is asked here, through Hermes's approval gate, with a description the runner reads
(``ask_description``): the key, the tool, what the call looks at (a URL, a query) and an ask id; a no blocks with the
words the runner left for that id (``take_answer``). No match: ``default`` (``allow`` unless set). No file: every tool
is allowed. A file that can't be read or parsed, an unknown action, a ``$NAME`` that isn't set, or any failure here
blocks every tool (fail closed).
"""

from __future__ import annotations

import contextlib
import fnmatch
import json
import logging
import os
import re
import secrets
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .paths import expand as expand_home
from .settings import hermes_home, in_pod, session_dir, turn_session

logger = logging.getLogger(__name__)

POLICY_FILE = "whombat-policy.json"
SESSION_POLICY_FILE = "policy.json"
NO_SESSION = "Tools are paused: Whombat doesn't know this turn."
ACTIONS = ("allow", "approve", "block")
UNREADABLE = "Tools are paused: Whombat's tool policy can't be read."
REFUSED = "Whombat's tool policy doesn't allow this."
ASK = "Whombat asks a person before this runs."
NOT_ASKED = "Nobody said yes to this, so it didn't happen."
# Where the runner leaves Whombat's words for an ask that didn't run (`packages/agent-runtime` `ASK_ANSWERS_DIR`).
ASK_ANSWERS_DIR = "whombat-asks"
# The description of a keyed ask, as the runner recognises it (`session/request_permission`'s `rawInput.description`).
ASK_KIND = "whombat_ask"
DETAIL_MAX = 300
# What a call looks at, by the argument that says it (the first one present).
_DETAIL_ARGS = ("url", "urls", "query", "q", "search_query", "prompt", "text")
_PATH_ARGS = ("file_path", "path", "notebook_path")
_VAR = re.compile(r"\$(\w+)|\$\{(\w+)\}")


class PolicyError(ValueError):
    pass


@dataclass(frozen=True)
class Rule:
    patterns: tuple[str, ...]
    action: str
    message: str
    key: str = ""
    paths: tuple[str, ...] = ()

    def matches(self, tool_name: str, args: Any = None, task_id: str = "") -> bool:
        if not any(fnmatch.fnmatchcase(tool_name, p) for p in self.patterns):
            return False
        if not self.paths:
            return True
        found = call_paths(tool_name, args, task_id)
        inside = [any(_inside(candidate, root) for root in self.paths) for candidate in found]
        # An allow holds only when every path of the call is inside (one patch may name several files).
        return bool(found) and all(inside) if self.action == "allow" else any(inside)


@dataclass(frozen=True)
class Policy:
    rules: tuple[Rule, ...] = ()
    default: str = "allow"

    def decide(self, tool_name: str, args: Any = None, task_id: str = "") -> tuple[str, str, str, str]:
        """``(action, message, rule key, Whombat key)`` for one call."""
        for index, rule in enumerate(self.rules):
            if rule.matches(tool_name, args, task_id):
                return rule.action, rule.message, f"whombat:{index}:{','.join(rule.patterns)}", rule.key
        return self.default, "", "whombat:default", ""


def _expand(path: str) -> str:
    """``$HERMES_HOME`` (Hermes's own idea of it) and other set ``$NAME``s; an unset one makes the policy unusable."""

    def value(match: re.Match) -> str:
        name = match.group(1) or match.group(2)
        found = str(hermes_home()) if name == "HERMES_HOME" else os.environ.get(name)
        if not found:
            raise PolicyError(f"${name} is not set")
        return found

    expanded = _VAR.sub(value, path)
    if not os.path.isabs(expanded):
        raise PolicyError(f"a policy path must be absolute: {path!r}")
    return os.path.realpath(expanded)


#: Hermes's own file tools (v0.22.5 ``tools/file_tools.py``), whose relative paths Hermes resolves per session.
HERMES_FILE_TOOLS = frozenset({"read_file", "write_file", "patch", "search_files"})
#: The files a V4A patch names (``*** Update File: <path>``, Add, Delete, ``*** Move to: <path>``).
_V4A_PATH = re.compile(r"^\*\*\* (?:(?:Update|Add|Delete) File|Move to):\s*(.+?)\s*$", re.MULTILINE)


def _hermes_resolve(path: str, task_id: str) -> str:
    """A Hermes file tool's path as Hermes resolves it: against the session's workspace, else the process's cwd."""
    # ``~`` is the commands' home, as the call will run (``paths.py``), not Hermes's own.
    path = expand_home(path)
    try:
        from tools.file_tools_paths import _resolve_path_for_task

        return os.path.realpath(str(_resolve_path_for_task(path, task_id or "default")))
    except Exception:
        return os.path.realpath(os.path.expanduser(path))


def call_paths(tool_name: str, args: Any, task_id: str = "") -> list[str]:
    """The paths a call names (resolved, symlinks followed)."""
    if not isinstance(args, dict):
        return []
    found = [args[k] for k in _PATH_ARGS if isinstance(args.get(k), str) and args[k]]
    pattern = args.get("pattern")
    if tool_name == "Glob" and isinstance(pattern, str) and pattern.startswith("/"):
        fixed = re.split(r"[*?\[{]", pattern, maxsplit=1)[0]
        found.append(fixed if fixed.endswith("/") or not fixed else os.path.dirname(fixed) or "/")
    if tool_name not in HERMES_FILE_TOOLS:
        return [os.path.realpath(os.path.expanduser(p)) for p in found]
    if tool_name == "patch" and isinstance(args.get("patch"), str):
        found.extend(_V4A_PATH.findall(args["patch"]))
    if tool_name == "search_files" and not found:
        found.append(".")
    return [_hermes_resolve(p, task_id) for p in found]


def _inside(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def call_detail(args: Any) -> str:
    """What a call looks at, short: its URL, its URLs, its query."""
    if not isinstance(args, dict):
        return ""
    for name in _DETAIL_ARGS:
        value = args.get(name)
        if isinstance(value, list):
            value = " ".join(str(v) for v in value if isinstance(v, (str, int, float)))
        if isinstance(value, (str, int, float)) and str(value).strip():
            return " ".join(str(value).split())[:DETAIL_MAX]
    return ""


def ask_description(key: str, tool_name: str, args: Any, ask_id: str = "") -> str:
    """A keyed ask's description: JSON the runner reads (never shown to anyone as it is)."""
    said = {"kind": ASK_KIND, "key": key, "tool": tool_name, "detail": call_detail(args)}
    if ask_id:
        said["ask"] = ask_id
    return json.dumps(said, ensure_ascii=False, separators=(",", ":"))


def take_answer(ask_id: str) -> Optional[str]:
    """Whombat's words for an ask that didn't run (``$HERMES_HOME/whombat-asks/<id>``, the runner's), read once."""
    if not re.fullmatch(r"[0-9a-f]{32}", ask_id or ""):
        return None
    path = hermes_home() / ASK_ANSWERS_DIR / ask_id
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    with contextlib.suppress(OSError):
        path.unlink()
    return text[:1000] or None


def ask_person(key: str, tool_name: str, args: Any, rule_key: str, ids: dict) -> Optional[dict]:
    """A keyed ask (HE-44, HE-S149): Hermes's own approval gate — so an ACP client gets ``session/request_permission``
    — asked here, so a no reads in Whombat's words (the person's no, the wait over, the key off), which the runner leaves
    by the ask's id, not Hermes's “denied”. None lets the call run; a failure blocks (fail closed)."""
    ask_id = secrets.token_hex(16)
    try:
        from tools.approval import request_tool_approval

        tokens = None
        try:
            from tools.approval_context import set_current_observability_context

            tokens = set_current_observability_context(turn_id=ids.get("turn_id") or "",
                                                       tool_call_id=ids.get("tool_call_id") or "",
                                                       session_id=ids.get("session_id") or "")
        except Exception:
            tokens = None
        try:
            result = request_tool_approval(tool_name, ask_description(key, tool_name, args, ask_id),
                                           rule_key=f"{rule_key}:{tool_name}")
        finally:
            if tokens is not None:
                with contextlib.suppress(Exception):
                    from tools.approval_context import reset_current_observability_context

                    reset_current_observability_context(tokens)
    except Exception:
        logger.warning("whombat ask failed for %s", tool_name, exc_info=True)
        return {"action": "block", "message": take_answer(ask_id) or NOT_ASKED}
    if result.get("approved"):
        take_answer(ask_id)
        return None
    return {"action": "block", "message": take_answer(ask_id) or NOT_ASKED}


def parse_policy(data: Any) -> Policy:
    if not isinstance(data, dict):
        raise PolicyError("the policy must be an object")
    default = data.get("default", "allow")
    if default not in ACTIONS:
        raise PolicyError(f"unknown default action {default!r}")
    rules = []
    for raw in data.get("rules") or []:
        if not isinstance(raw, dict):
            raise PolicyError("a rule must be an object")
        tools = raw.get("tools")
        patterns = (tools,) if isinstance(tools, str) else tuple(tools) if isinstance(tools, list) else ()
        if not patterns or not all(isinstance(p, str) and p for p in patterns):
            raise PolicyError("a rule needs tool name patterns")
        action = raw.get("action")
        if action not in ACTIONS:
            raise PolicyError(f"unknown action {action!r}")
        message = raw.get("message") if isinstance(raw.get("message"), str) else ""
        key = raw.get("key", "")
        if not isinstance(key, str):
            raise PolicyError("a rule's key must be a string")
        raw_paths = raw.get("paths", [])
        if not isinstance(raw_paths, list) or not all(isinstance(p, str) and p for p in raw_paths):
            raise PolicyError("a rule's paths must be a list of directories")
        rules.append(Rule(patterns, action, message, key, tuple(_expand(p) for p in raw_paths)))
    return Policy(tuple(rules), default)


class PolicyFile:
    """A policy file. One turn's Hermes (``reread=False``) reads it once: the runner writes it before Hermes starts, and
    a change during the turn counts for nothing. A session's in a person's pod (``reread=True``, HN-W06) is read again
    whenever the runner changes it (its next turn's keys), and is required (``missing="block"``)."""

    def __init__(self, path: Optional[Path] = None, *, reread: bool = False, missing: str = "allow") -> None:
        self._path = path
        self._reread = reread
        self._missing = missing
        self._lock = threading.Lock()
        self._read = False
        self._stamp: Optional[tuple[int, int, int]] = None
        self._policy: Optional[Policy] = None
        self._error: Optional[str] = None

    @property
    def path(self) -> Path:
        return self._path or hermes_home() / POLICY_FILE

    def _current_stamp(self) -> Optional[tuple[int, int, int]]:
        try:
            st = self.path.stat()
        except FileNotFoundError:
            return None
        except OSError:
            return (-1, -1, -1)
        return (st.st_ino, st.st_mtime_ns, st.st_size)

    def load(self) -> Optional[Policy]:
        """The policy; None when there was no file (and none is required). Raises ``PolicyError`` when it can't be
        used."""
        with self._lock:
            if self._reread and self._read and self._current_stamp() != self._stamp:
                self._read = False
            if not self._read:
                self._read = True
                self._policy, self._error = None, None
                self._stamp = self._current_stamp() if self._reread else None
                try:
                    text = self.path.read_text(encoding="utf-8")
                except FileNotFoundError:
                    text = None
                    if self._missing == "block":
                        self._error = "this turn has no tool policy"
                except OSError as exc:
                    self._error = str(exc)
                    text = None
                if text is not None:
                    try:
                        self._policy = parse_policy(json.loads(text))
                    except ValueError as exc:
                        self._error = str(exc)
            if self._error is not None:
                raise PolicyError(self._error)
            return self._policy


class SessionPolicies:
    """The policy of each session in a person's pod (HN-W06), the most recently used kept."""

    def __init__(self, keep: int = 256) -> None:
        self._keep = keep
        self._lock = threading.Lock()
        self._files: dict[str, PolicyFile] = {}

    def for_session(self, session: str) -> PolicyFile:
        with self._lock:
            found = self._files.pop(session, None)
            if found is None:
                found = PolicyFile(session_dir(session) / SESSION_POLICY_FILE, reread=True, missing="block")
            self._files[session] = found
            while len(self._files) > self._keep:
                self._files.pop(next(iter(self._files)))
            return found


_policy_file = PolicyFile()
_session_policies = SessionPolicies()


def policy_for(ids: dict) -> PolicyFile:
    """The policy a call obeys: in a pod, its session's (the session context, else the hook's ``session_id``); else the
    profile's."""
    if not in_pod():
        return _policy_file
    session = turn_session(ids.get("session_id"))
    if not session:
        raise PolicyError(NO_SESSION)
    return _session_policies.for_session(session)


def pre_tool_call(tool_name: str = "", args: Any = None, policy_file: Optional[PolicyFile] = None,
                  **ids: Any) -> Optional[dict]:
    """The hook: None lets the call run; ``{"action": "block"|"approve", "message"}`` otherwise."""
    try:
        policy = (policy_file or policy_for(ids)).load()
        if policy is None:
            return None
        name = str(tool_name or "")
        action, message, rule_key, key = policy.decide(name, args, str(ids.get("task_id") or ""))
        if action == "allow":
            return None
        if action == "approve":
            # A keyed ask is asked per call (no ``[a]lways`` grain shared between calls): Whombat keeps its own scopes.
            if key:
                return ask_person(key, name, args, rule_key, ids)
            return {"action": "approve", "message": message or ASK, "rule_key": rule_key}
        return {"action": "block", "message": message or REFUSED}
    except PolicyError as exc:
        logger.warning("whombat tool policy unusable: %s", exc)
        return {"action": "block", "message": UNREADABLE}
    except Exception:
        logger.exception("whombat tool policy failed")
        return {"action": "block", "message": UNREADABLE}
