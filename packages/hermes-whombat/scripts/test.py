#!/usr/bin/env python3
"""``pnpm hermes:test``: the plugin's pytest suite on a Python that runs Hermes.

Without ``--hermes``: the Python that runs the pinned Hermes — ``WHOMBAT_HERMES_PYTHON``, else the interpreter next to
``WHOMBAT_HERMES_BIN`` (``…/bin/hermes``), else the one next to ``hermes`` on PATH. The plugin must be installed into it
(editable is fine) so Hermes finds its entry points; tests that need Hermes skip without it.

``--hermes latest|pin|<tag>`` (hermes-native.md HN-10): a fresh environment under ``$TMPDIR`` with that Hermes release,
installed as ``pnpm hermes:install`` installs the pin (a clone at the tag, unmodified; Python 3.14; Hermes's own
``uv.lock`` with the ``acp``, ``mcp`` and ``anthropic`` extras; Hermes and this plugin editable), then the suite on it.
``latest`` is Hermes's newest GitHub release, ``pin`` the one in ``agent-runtime/src/hermes/pin.ts``. Prints the Hermes
it tested and a one-line result, exits non-zero when anything fails, and removes the environment (``--keep`` leaves it).
The pin never changes here. Needs ``git``, the network and ``uv`` (installed into the environment from PyPI when it
isn't on PATH). Runs on the system's ``python3`` (3.12 or newer), so CI needs nothing installed first.

Extra arguments go to pytest.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
REPO = PACKAGE.parent.parent
PIN_FILE = REPO / "packages" / "agent-runtime" / "src" / "hermes" / "pin.ts"
UPSTREAM = "NousResearch/hermes-agent"
PYTHON = "3.14"  # as `pnpm hermes:install`
UV = "0.11.26"  # only when uv isn't on PATH (a CI guest)
TAG = re.compile(r"v[0-9A-Za-z][0-9A-Za-z._-]*")


def say(text: str) -> None:
    print(f"hermes:test · {text}", flush=True)


def hermes_python() -> str | None:
    explicit = os.environ.get("WHOMBAT_HERMES_PYTHON")
    if explicit:
        return explicit
    for hermes in (os.environ.get("WHOMBAT_HERMES_BIN"), shutil.which("hermes")):
        if not hermes:
            continue
        for candidate in (Path(hermes).parent / "python", Path(hermes).resolve().parent / "python"):
            if candidate.exists():
                return str(candidate)
    return None


def pytest(python: str, args: list[str], env: dict[str, str]) -> tuple[int, str]:
    """Runs the suite, its output streamed; returns pytest's exit code and its closing count line."""
    process = subprocess.Popen([python, "-m", "pytest", "-q", "-rs", str(PACKAGE / "tests"), *args], cwd=PACKAGE,
                               env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    counts = ""
    assert process.stdout is not None
    for line in process.stdout:
        sys.stdout.write(line)
        if re.search(r"\d+ (passed|failed|errors?|skipped|deselected)|no tests ran", line):
            counts = line.strip().strip("=").strip()
    return process.wait(), counts


# --- another Hermes release ------------------------------------------------------------------------------------------

class Failed(Exception):
    pass


def run(argv: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    done = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True)
    if done.returncode != 0:
        detail = (done.stderr or done.stdout).strip().splitlines()[-20:]
        raise Failed(f"{' '.join(argv[:3])} … failed ({done.returncode})\n" + "\n".join(detail))
    return done.stdout.strip()


def github_api(path: str) -> urllib.request.Request:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "whombat-hermes-test"}
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(f"https://api.github.com/{path}", headers=headers)


def newest_release() -> str:
    """The tag of Hermes's newest release (GitHub's “Latest”: no drafts or pre-releases). Tags alone don't say it:
    Hermes has used both ``v2026.9.24`` and ``v0.22.5``."""
    try:
        with urllib.request.urlopen(github_api(f"repos/{UPSTREAM}/releases/latest"), timeout=30) as response:
            tag = json.load(response)["tag_name"]
    except (urllib.error.URLError, KeyError, ValueError):
        # The API's anonymous limit is per address; the release page's redirect names the same tag without it.
        try:
            page = urllib.request.Request(f"https://github.com/{UPSTREAM}/releases/latest",
                                          headers={"User-Agent": "whombat-hermes-test"})
            with urllib.request.urlopen(page, timeout=30) as response:
                tag = response.geturl().rstrip("/").rsplit("/", 1)[-1]
        except urllib.error.URLError as error:
            raise Failed(f"couldn’t ask GitHub for Hermes's newest release: {error}") from error
    if not TAG.fullmatch(tag):
        raise Failed(f"GitHub named {tag!r} as Hermes's newest release")
    return tag


def pinned() -> tuple[str, str]:
    text = PIN_FILE.read_text(encoding="utf-8")
    tag = re.search(r"tag:\s*'([^']+)'", text)
    commit = re.search(r"commit:\s*'([0-9a-f]{40})'", text)
    if not tag or not commit:
        raise Failed(f"no tag and commit in {PIN_FILE}")
    return tag.group(1), commit.group(1)


def uv_binary(work: Path) -> str:
    found = shutil.which("uv")
    if found:
        return found
    say(f"no uv on PATH: installing uv {UV} from PyPI into the environment")
    tool = work / "uv-tool"
    run([sys.executable, "-m", "venv", str(tool)])
    run([str(tool / "bin" / "pip"), "install", "--quiet", "--disable-pip-version-check", f"uv=={UV}"])
    return str(tool / "bin" / "uv")


def install(tag: str, commit: str | None, work: Path, env: dict[str, str]) -> tuple[str, str, str]:
    """Hermes at ``tag`` with this plugin in a new environment under ``work``; returns its Python, commit and version."""
    uv = uv_binary(work)
    src, venv = work / "src", work / "venv"
    say(f"cloning Hermes Agent {tag}")
    run(["git", "clone", "--quiet", "--depth", "1", "--branch", tag, f"https://github.com/{UPSTREAM}", str(src)])
    head = run(["git", "-C", str(src), "rev-parse", "HEAD"])
    if commit and head != commit:
        raise Failed(f"{tag} is at {head[:12]}, not the pinned {commit[:12]}")
    if not (src / "uv.lock").exists():
        raise Failed(f"Hermes {tag} has no uv.lock; `pnpm hermes:install`'s way doesn't install it")
    say(f"making the environment (Python {PYTHON}) and installing Hermes as its uv.lock pins it")
    run([uv, "venv", "--quiet", "--python", PYTHON, str(venv)], env=env)
    python = str(venv / "bin" / "python")
    requirements = work / "requirements.txt"
    run([uv, "export", "--quiet", "--project", str(src), "--frozen", "--no-dev", "--extra", "acp", "--extra", "mcp",
         "--extra", "anthropic", "--no-hashes", "--no-emit-project", "--output-file", str(requirements)], env=env)
    run([uv, "pip", "install", "--quiet", "--python", python, "--no-deps", "-r", str(requirements)], env=env)
    run([uv, "pip", "install", "--quiet", "--python", python, "--no-deps", "-e", str(src)], env=env)
    say("installing our plugin (packages/hermes-whombat) with pytest")
    run([uv, "pip", "install", "--quiet", "--python", python, "-e", f"{PACKAGE}[test]"], env=env)
    # Tests that need Hermes skip when it can't be imported; for another release that is a break, not a skip.
    run([python, "-c", "import run_agent"], cwd=work, env=env)
    version = run([str(venv / "bin" / "hermes"), "--version"], cwd=work, env=env).splitlines()[0].strip()
    return python, head, version


def against_release(which: str, keep: bool, args: list[str]) -> int:
    started = time.monotonic()
    work = Path(tempfile.mkdtemp(prefix="hermes-test-", dir=os.environ.get("TMPDIR") or None))
    # Hermes's home is a throwaway one, never the machine's ~/.hermes; its update check stays off (`--version` would
    # ask GitHub otherwise, as `checkHermes` knows).
    home = work / "hermes-home"
    home.mkdir()
    (home / "config.yaml").write_text('{"updates": {"check": false}}\n', encoding="utf-8")
    env = {**os.environ, "HERMES_HOME": str(home), "TMPDIR": os.environ.get("TMPDIR") or "/tmp",
           "UV_LINK_MODE": os.environ.get("UV_LINK_MODE", "copy")}
    tag, tested = which, False
    try:
        commit = None
        if which == "latest":
            tag = newest_release()
        elif which == "pin":
            tag, commit = pinned()
        elif not TAG.fullmatch(which):
            raise Failed(f"--hermes takes latest, pin or a release tag (vX.Y.Z), not {which!r}")
        pin_tag, _ = pinned()
        if which == "latest":
            say(f"Hermes's newest release is {tag}" + (", the pin" if tag == pin_tag else f"; the pin stays {pin_tag}"))
        python, head, version = install(tag, commit, work, env)
        say(f"testing on {version} ({tag}, {head[:12]}) in {work}")
        tested = True
        code, counts = pytest(python, args, env)
    except Failed as error:
        say(f"Hermes {tag}: not tested — {error}")
        code, counts = 1, ""
    finally:
        if keep:
            say(f"kept {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)
    if tested:
        result = "passed" if code == 0 else "FAILED"
        say(f"Hermes {tag}: {result} · {counts or f'pytest exited {code}'} · {time.monotonic() - started:.0f} s")
    return code


def main() -> int:
    argv = sys.argv[1:]
    which, keep = None, False
    rest: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--hermes" and i + 1 < len(argv):
            which, i = argv[i + 1], i + 2
            continue
        if arg.startswith("--hermes="):
            which = arg.split("=", 1)[1]
        elif arg == "--keep":
            keep = True
        else:
            rest.append(arg)
        i += 1
    if which is not None:
        return against_release(which, keep, rest)
    python = hermes_python()
    if python is None:
        sys.stderr.write("No Hermes environment: set WHOMBAT_HERMES_PYTHON (or WHOMBAT_HERMES_BIN) to the pinned "
                         "Hermes, with this plugin installed into it, or pass --hermes latest|pin|<tag>.\n")
        return 2
    env = {**os.environ, "TMPDIR": os.environ.get("TMPDIR") or "/tmp"}
    return subprocess.call([python, "-m", "pytest", "-q", str(PACKAGE / "tests"), *rest], cwd=PACKAGE, env=env)


if __name__ == "__main__":
    sys.exit(main())
