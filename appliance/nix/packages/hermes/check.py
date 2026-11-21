"""whombat-hermes-check: does this Hermes work, before anyone needs it (Whombat HU-05; NX-484).

Run by the `whombat-hermes-check` unit at every start of the runtime (an activation, a rollback, a boot) and by the
package's install check, in a throwaway home of its own (never the person's): the manager counts a runtime as healthy
only once it passed, so a broken Hermes or plugin sends the box back to its known-good release by itself.

1. `hermes --version` names the release this package is (`WHOMBAT_HERMES_CHECK_VERSION`);
2. Hermes's own plugin discovery, with Whombat's plugins enabled as the runner's config.yaml enables them (every
   `hermes_agent.plugins` entry point of the `WHOMBAT_HERMES_CHECK_PLUGIN` distribution), loads its general plugin
   without an error, and Whombat's model providers are the ones Hermes's registry returns;
3. `hermes acp` answers `initialize` and `session/new`, which starts its gateway on that home (its state database, its
   config, its plugins again).

No model is called and nothing leaves the machine: the config turns Hermes's own fetches off (NX-435) and a session
without a prompt contacts no provider. Exit 0 and a few lines on stdout when it works; 1 and the reason on stderr
otherwise.
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import select
import signal
import subprocess
import sys
import tempfile
import time

HERMES = os.environ["WHOMBAT_HERMES_BIN"]
VERSION = os.environ["WHOMBAT_HERMES_CHECK_VERSION"]
PLUGIN = os.environ.get("WHOMBAT_HERMES_CHECK_PLUGIN", "")
# Each step's limit. A cold gateway took 4–5 s on the build machine and more in a small VM (NX-434).
STEP_SECONDS = float(os.environ.get("WHOMBAT_HERMES_CHECK_TIMEOUT", "120"))
PR_SET_CHILD_SUBREAPER = 36


class Failed(Exception):
    pass


def say(text: str) -> None:
    print(f"hermes-check: {text}", flush=True)


def plugin_entry_points() -> list[str]:
    """The names Hermes enables Whombat's plugins by: the distribution's `hermes_agent.plugins` entry points."""
    import importlib.metadata as metadata

    wanted = re.sub(r"[-_.]+", "-", PLUGIN).lower()
    names = sorted(ep.name for ep in metadata.entry_points(group="hermes_agent.plugins")
                   if re.sub(r"[-_.]+", "-", ep.dist.name).lower() == wanted)
    if not names:
        raise Failed(f"the plugin {PLUGIN} has no hermes_agent.plugins entry point")
    return names


def write_config(home: str, plugins: list[str]) -> None:
    """The least a runner's config.yaml says for a session (NX-434), with Hermes's own fetches off (NX-435). JSON is
    YAML."""
    config = {
        "model": {"default": "gpt-5.5", "provider": "openai-codex", "openai_runtime": "codex_app_server"},
        "updates": {"check": False},
        "plugins": {"enabled": plugins, "auto_update_check_hours": 0},
        "model_catalog": {"enabled": False},
        "models_dev": {"url": "http://127.0.0.1:9/"},
        "web": {"keyless_fallback": False},
        "lsp": {"enabled": False},
        "security": {"allow_lazy_installs": False},
    }
    with open(os.path.join(home, "config.yaml"), "w", encoding="utf-8") as f:
        json.dump(config, f)


def check_version(env: dict[str, str]) -> None:
    done = subprocess.run([HERMES, "--version"], env=env, capture_output=True, text=True, timeout=STEP_SECONDS)
    line = re.search(r"Hermes Agent v(\d+\.\d+\.\d+[\w.+-]*)", done.stdout)
    if done.returncode != 0 or not line:
        raise Failed(f"hermes --version: {(done.stderr or done.stdout).strip()[-500:] or done.returncode}")
    if line.group(1) != VERSION:
        raise Failed(f"hermes --version says {line.group(1)}, this package is {VERSION}")
    say(f"Hermes Agent {VERSION}")


def check_plugins(plugins: list[str]) -> None:
    """Hermes's plugin discovery and provider registry in this process, on the scratch home (HERMES_HOME is set)."""
    import importlib
    import importlib.metadata as metadata

    from hermes_cli.plugins import discover_plugins, get_plugin_manager
    from providers import get_provider_profile

    discover_plugins(force=True)
    listed = {p["name"]: p for p in get_plugin_manager().list_plugins()}
    # A general plugin has `register(ctx)`; a provider plugin's module only registers its providers on import, and the
    # plugin manager lists it with “no register() function” (its providers are checked below).
    targets = {ep.name: ep.module for ep in metadata.entry_points(group="hermes_agent.plugins") if ep.name in plugins}
    general = [n for n in plugins if hasattr(importlib.import_module(targets[n]), "register")]
    if not general:
        raise Failed(f"the plugin {PLUGIN} has no general plugin (an entry point with register())")
    for name in general:
        p = listed.get(name)
        if p is None:
            raise Failed(f"Hermes didn't find the plugin {name} (found {', '.join(sorted(listed)) or 'none'})")
        if p.get("error") or not p.get("enabled"):
            raise Failed(f"the plugin {name} didn't load: {p.get('error') or 'not enabled'}")
    # Whombat's model providers (its DirectSDK modes): what the registry returns for their names is the plugin's own.
    from whombat_hermes import directsdk

    for profile in (directsdk.profile, directsdk.gateway_profile):
        if get_provider_profile(profile.name) is not profile:
            raise Failed(f"Hermes's provider registry has no {profile.name} from the plugin")
    say(f"plugin {', '.join(general)} loaded; providers {directsdk.profile.name}, {directsdk.GATEWAY_PROVIDER}")


class Acp:
    """`hermes acp` over stdio, as the runner speaks it."""

    def __init__(self, env: dict[str, str], cwd: str):
        # Its own process group: the gateway it starts stays in it (Hermes doesn't detach it on Linux).
        self.p = subprocess.Popen([HERMES, "acp"], env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1, start_new_session=True)
        self.t0 = time.monotonic()
        self.next = 0

    def call(self, method: str, params: dict) -> dict:
        self.next += 1
        assert self.p.stdin and self.p.stdout
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.next, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        end = time.monotonic() + STEP_SECONDS
        while time.monotonic() < end:
            if not select.select([self.p.stdout], [], [], 1)[0]:
                if self.p.poll() is not None:
                    break
                continue
            line = self.p.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("id") != self.next:
                continue
            if "result" not in msg:
                raise Failed(f"{method}: {json.dumps(msg.get('error', msg))[:500]}")
            return msg["result"]
        err = self.p.stderr.read()[-500:] if self.p.poll() is not None and self.p.stderr else ""
        raise Failed(f"{method}: no answer in {STEP_SECONDS:.0f} s{f' ({err.strip()})' if err.strip() else ''}")

    def since(self) -> str:
        return f"{time.monotonic() - self.t0:.1f} s"

    def close(self) -> None:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(self.p.pid, sig)
            except ProcessLookupError:
                break
            try:
                self.p.wait(timeout=5)
                break
            except subprocess.TimeoutExpired:
                pass


def check_acp(env: dict[str, str], cwd: str) -> None:
    acp = Acp(env, cwd)
    try:
        init = acp.call("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        agent = init.get("agentInfo") or {}
        if agent.get("version") != VERSION:
            raise Failed(f"initialize names {json.dumps(agent)}, not Hermes {VERSION}")
        say(f"acp initialize after {acp.since()}")
        # The first session/new starts the gateway; one that doesn't take the viewer within Hermes's own open timeout
        # (“Gateway connection failed”, seen in small VMs) is dialled again by a second one (runtime-live-turn).
        try:
            session = acp.call("session/new", {"cwd": cwd, "mcpServers": []})
        except Failed as first:
            say(f"session/new again after: {first}")
            session = acp.call("session/new", {"cwd": cwd, "mcpServers": []})
        if not session.get("sessionId"):
            raise Failed(f"session/new answered without a session: {json.dumps(session)[:300]}")
        say(f"acp session/new after {acp.since()}")
    finally:
        acp.close()


def reap_orphans() -> None:
    """Whatever Hermes left (its gateway, should it have left the group) was reparented to this process: end it."""
    me = os.getpid()
    for _ in range(2):
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
                    ppid = int(f.read().rsplit(")", 1)[1].split()[1])
            except (OSError, ValueError, IndexError):
                continue
            if ppid == me:
                try:
                    os.kill(int(pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass


def main() -> int:
    try:
        ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
    except (OSError, AttributeError):
        pass
    with tempfile.TemporaryDirectory(prefix="hermes-check-") as scratch:
        home, hermes_home = os.path.join(scratch, "home"), os.path.join(scratch, "hermes")
        os.mkdir(home, 0o700)
        os.mkdir(hermes_home, 0o700)
        try:
            plugins = plugin_entry_points() if PLUGIN else []
            write_config(hermes_home, plugins)
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "HERMES_HOME": hermes_home,
                   "TMPDIR": scratch, "LANG": "C.UTF-8", "NO_PROXY": "127.0.0.1,localhost"}
            for key in ("SSL_CERT_FILE", "TZ"):
                if key in os.environ:
                    env[key] = os.environ[key]
            check_version(env)
            os.environ.update(env)
            if plugins:
                check_plugins(plugins)
            check_acp(env, scratch)
        except Failed as failure:
            print(f"hermes-check: {failure}", file=sys.stderr, flush=True)
            return 1
        except Exception as error:  # an import or a Hermes internal failing is a failed check, said plainly
            print(f"hermes-check: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            return 1
        finally:
            reap_orphans()
    say("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
