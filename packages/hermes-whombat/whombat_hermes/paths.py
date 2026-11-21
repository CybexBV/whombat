"""``~`` in Hermes's file tools means the commands' home, where the file is actually read or written.

Hermes expands ``~`` in ``read_file``, ``write_file``, ``patch`` and ``search_files`` with its own ``HOME`` (the pod's
home, ``/home/whombat-task``), but on this Whombat the read or write runs in a command's wrapper, whose ``HOME`` is the
agent's home at its real path (``WHOMBAT_COMMANDS_HOME``). Without this, ``~/work/x`` names a folder the command can't
see or create (“mkdir: cannot create directory ‘/home’: Read-only file system”). The ``pre_tool_call`` hook here
rewrites such a path before the tool runs; the tool policy resolves paths with the same rule, so what it checks is what
runs.
"""

from __future__ import annotations

import os
import re
from typing import Any, Optional

HOME_ENV = "WHOMBAT_COMMANDS_HOME"
#: Hermes's own file tools (v0.22.5 ``tools/file_tools.py``) and the argument that names their file or folder.
FILE_TOOLS = frozenset({"read_file", "write_file", "patch", "search_files"})
#: The files a V4A patch names (``*** Update File: <path>``, Add, Delete, ``*** Move to: <path>``).
_V4A_PATH = re.compile(r"^(\*\*\* (?:(?:Update|Add|Delete) File|Move to):\s*)(~(?:/[^\n]*)?)$", re.MULTILINE)


def home() -> Optional[str]:
    """The commands' home, when this Hermes runs its commands in Whombat's wrapper."""
    value = (os.environ.get(HOME_ENV) or "").strip()
    if not value.startswith("/"):
        return None
    return value.rstrip("/") or "/"


def expand(path: str) -> str:
    """``~`` and ``~/…`` against the commands' home; any other path (``~user`` too) as it is."""
    root = home()
    if root is None or not isinstance(path, str):
        return path
    if path == "~":
        return root
    if path.startswith("~/"):
        return root.rstrip("/") + path[1:]
    return path


def rewritten_args(tool_name: str, args: Any) -> Optional[dict]:
    """The arguments that change for a file tool's call, or None when nothing does."""
    if tool_name not in FILE_TOOLS or not isinstance(args, dict) or home() is None:
        return None
    changed: dict = {}
    path = args.get("path")
    if isinstance(path, str) and expand(path) != path:
        changed["path"] = expand(path)
    patch = args.get("patch")
    if tool_name == "patch" and isinstance(patch, str):
        fixed = _V4A_PATH.sub(lambda m: m.group(1) + expand(m.group(2)), patch)
        if fixed != patch:
            changed["patch"] = fixed
    return changed or None


def pre_tool_call(tool_name: str = "", args: Any = None, **_ids: Any) -> Optional[dict]:
    """The hook: ``{"action": "modify", "args": …}`` for a file tool's ``~`` path, None otherwise."""
    changed = rewritten_args(str(tool_name or ""), args)
    return {"action": "modify", "args": changed} if changed else None
