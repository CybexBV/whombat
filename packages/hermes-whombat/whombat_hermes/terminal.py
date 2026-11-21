"""Hermes's own terminal on this Whombat (one-person.md OP-07, OP-S107): ``terminal.backend: whombat_commands``.

Every command Hermes runs — the agent's, its file tools', its background processes', ``execute_code``'s — goes through
``whombat-command`` (the runner's Node at ``WHOMBAT_COMMANDS_NODE`` with ``WHOMBAT_COMMANDS_LAUNCHER``), which asks the
runner (the guard, a person's yes, what of the turn the command sees) and then runs it in a wrapper of its own beside
Hermes: the commands' network and pid namespaces, a mount namespace with the agent's home and nothing of Hermes's, a
cgroup of its own. That wrapper is ``exec_prefix()``: what follows it runs there with stdin and stdout open.

The wrapper is the wall for commands: like Hermes's other sandbox backends this one skips Hermes's dangerous-command
prompts; Whombat's guard (the runner's) and its ``pre_tool_call`` hook decide (HE-17). Hermes's browser stays on the
gateway (``bot_desktop.placement: gateway``): the agent's Chromium is Whombat's, reached over CDP (OP-S113).
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
import uuid
from typing import Any, Optional

from .env import command_env, hermes_strip_keys
from .settings import SESSION_ENV, turn_session

BACKEND = "whombat_commands"
NODE_ENV = "WHOMBAT_COMMANDS_NODE"
LAUNCHER_ENV = "WHOMBAT_COMMANDS_LAUNCHER"
HOME_ENV = "WHOMBAT_COMMANDS_HOME"
CGROUP_ENV = "WHOMBAT_COMMANDS_CGROUP"
COMMAND_ID_ENV = "WHOMBAT_COMMAND_ID"
# With this and the pod's proxy variables set, Node loads its whole HTTP client stack before the first line runs
# (about 15 ms per command). The launcher talks only to Unix sockets, and the command gets its environment from the
# runner, which sets it again.
_ENV_PROXY = "NODE_USE_ENV_PROXY"
# How long a stopped command's launcher may take to end the command (its cgroup) before it is killed itself.
_KILL_GRACE_S = 3.0

# Sign-ins, provider credentials and the MCP tokens never reach a command (SUB-04, HE-12, HE-32): ``env.command_env``
# for the launcher, which gives the command the runner's environment alone. Hermes strips ``env.hermes_strip_keys``
# (this backend's ``strip_env_keys``) from every other process it starts.


def launcher_env(command_id: Optional[str] = None) -> dict[str, str]:
    """The launcher's environment: Hermes's without a credential or Node's proxy switch, the Hermes session the
    command belongs to (``WHOMBAT_TURN_SESSION``, hermes-native.md HN-W04, read from the gateway's session context)
    and the command's id (its cgroup's name). The launcher sends the session in its request and gives the command
    none of it."""
    env = command_env(os.environ)
    env.pop(SESSION_ENV, None)
    env.pop(_ENV_PROXY, None)
    session = turn_session()
    if session:
        env[SESSION_ENV] = session
    if command_id:
        env[COMMAND_ID_ENV] = command_id
    return env


def launcher() -> Optional[list[str]]:
    """``[node, whombat-command.mjs]``, or None when this process wasn't started for commands."""
    node = (os.environ.get(NODE_ENV) or "").strip()
    script = (os.environ.get(LAUNCHER_ENV) or "").strip()
    if not node or not script or not os.path.isfile(script) or not os.access(node, os.X_OK):
        return None
    return [node, script]


def commands_home() -> str:
    """The commands' ``$HOME``: the agent's home (an outsiders' turn: a temporary one)."""
    home = (os.environ.get(HOME_ENV) or "").strip()
    return home if home.startswith("/") else "/tmp"


def _base_classes():
    from agent.terminal_env_provider import TerminalEnvironmentProvider
    from tools.environments.base import BaseEnvironment

    return TerminalEnvironmentProvider, BaseEnvironment


def _make_environment_class():
    _, BaseEnvironment = _base_classes()
    from tools.environments.base_output import _popen_bash

    class CommandsEnvironment(BaseEnvironment):
        """One launcher per command, like Hermes's SSH backend runs one ``ssh`` per command."""

        def __init__(self, prefix: list[str], cwd: str, timeout: int, env: Optional[dict] = None) -> None:
            self.prefix = prefix
            if cwd == "~":
                cwd = commands_home()
            # Which command each launcher runs (its cgroup), for a kill that must not miss a child.
            self._ids: dict[int, str] = {}
            super().__init__(cwd=cwd, timeout=timeout, env=env)
            self.init_session()

        def exec_prefix(self, *, user: Optional[str] = None, interactive: bool = True) -> list[str]:
            """What runs its remainder in a command's wrapper, stdin and stdout open (``supports_streams``)."""
            return list(self.prefix)

        def _run_bash(self, cmd_string: str, *, login: bool = False, timeout: int = 120,
                      stdin_data: Optional[str] = None) -> subprocess.Popen:
            command_id = uuid.uuid4().hex[:16]
            argv = [*self.prefix, "bash", "-lc" if login else "-c", cmd_string]
            proc = _popen_bash(argv, stdin_data, env=launcher_env(command_id))
            self._ids[proc.pid] = command_id
            while len(self._ids) > 256:
                self._ids.pop(next(iter(self._ids)))
            return proc

        def _kill_process(self, proc) -> None:
            """The launcher ends the whole command (its cgroup) on SIGTERM; one that doesn't is ended for it."""
            try:
                proc.send_signal(signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                return
            deadline = time.monotonic() + _KILL_GRACE_S
            while time.monotonic() < deadline and proc.poll() is None:
                time.sleep(0.05)
            if proc.poll() is None:
                self._force_kill_process(proc)

        def _force_kill_process(self, proc) -> None:
            command_id = self._ids.pop(getattr(proc, "pid", -1), None)
            root = (os.environ.get(CGROUP_ENV) or "").strip()
            if command_id and root:
                try:
                    with open(os.path.join(root, f"c-{command_id}", "cgroup.kill"), "w") as f:
                        f.write("1")
                except OSError:
                    pass
            try:
                proc.kill()
            except (ProcessLookupError, PermissionError, OSError):
                pass

        def cleanup(self) -> None:
            pass  # nothing held: every command was its own launcher

    return CommandsEnvironment


def make_provider() -> Any:
    """The provider instance (built lazily: Hermes's base classes are only importable inside Hermes)."""
    TerminalEnvironmentProvider, _ = _base_classes()
    environment_class = _make_environment_class()

    class WhombatCommandsProvider(TerminalEnvironmentProvider):
        name = BACKEND
        display_name = "Whombat commands"
        is_remote = True
        is_container = True
        supports_streams = True

        @property
        def description(self) -> str:
            return "Run commands on this Whombat, each in a sandbox of its own."

        @property
        def default_cwd(self) -> Optional[str]:
            return "~"

        @property
        def strip_env_keys(self) -> frozenset:
            # Read on every spawn (exact names): the provider credentials in Hermes's environment right now.
            return hermes_strip_keys()

        @property
        def env_description(self) -> str:
            return "this Whombat (Linux, the user agent, no sudo; the image's tools, Docker when it is there)"

        def is_available(self) -> bool:
            return launcher() is not None

        def check_requirements(self, config: dict[str, Any]) -> bool:
            if launcher() is None:
                import logging

                logging.getLogger(__name__).error("%s and %s don't name the commands' launcher", NODE_ENV,
                                                  LAUNCHER_ENV)
                return False
            return True

        def create_environment(self, *, cwd: str, timeout: int, task_id: str = "default",
                               image: Optional[str] = None, container_config: Optional[dict[str, Any]] = None,
                               **kwargs: Any):
            prefix = launcher()
            if prefix is None:
                raise RuntimeError(f"{NODE_ENV} and {LAUNCHER_ENV} don't name the commands' launcher.")
            return environment_class(prefix, cwd or "~", timeout, env=kwargs.get("env"))

    return WhombatCommandsProvider()
