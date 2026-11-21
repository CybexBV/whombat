"""Hermes's own skills code on the person's skills folder (``$WHOMBAT_HERMES_ROOT/skills``, the skills of Hermes's
default profile: Whombat one-person.md OP-08; docs/decisions/hermes-skills.md HSK-02…HSK-10, the interface in
HSK-S01…): one step per process, a JSON object on stdin, a JSON object on stdout, exit 0; or a nonzero
exit with ``{"code", "message"}`` (codes in ``CODES``).

    hermes whombat-skills <op>                 the plugin's subcommand (``plugin.py``)
    python -m whombat_hermes.hermes_skills <op>   the same without Hermes's CLI start, with Hermes's interpreter

``HERMES_HOME`` is the *skills home*: a small directory of the runner's, outside ``$WHOMBAT_HERMES_ROOT``, holding only
what these steps need (``SKILLS_HOME_CONFIG``, a ``skills`` link to the skills folder, the hub's quarantine and
caches, Hermes's own scaffolding). Hermes's code finds its skills directory at ``$HERMES_HOME/skills``; the link makes
that the skills folder for every Hermes function at once (the sync and its manifest, restore and compare, the hub
and its lock, the usage sidecar), and nothing else under ``$WHOMBAT_HERMES_ROOT`` is touched (the person's memory,
sessions and logins stay out of these steps). A profile's ``skills`` is a folder, never a link, so a step never runs
on a profile as its home (``prepare_home``).

What Whombat adds to Hermes's functions: ``hermes-agent`` is never seeded (HE-S127); the hub has three sources
(``official`` as the package ships it, ``github`` with Hermes's trusted default taps, ``skills-sh``) and nothing else
(HSK-06); an install takes the stricter of Hermes's two trust levels (the scan's and the source's), never a force
(HSK-07); a name the skills folder already has is refused (Hermes's switches match skills by name, HSK-05).
"""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

#: The error codes a step answers with.
CODES = ("invalid", "not_found", "conflict", "blocked", "unavailable", "failed")
#: Marks a Hermes home as the skills home (``_not_a_profile``).
MARKER = "whombat-skills-home"
#: The skills home's ``config.yaml``: the plugin on (for ``hermes whombat-skills``), Hermes's own traffic off, no
#: external skill directories (the sync would defer to them and leave the skills folder empty).
SKILLS_HOME_CONFIG = """\
plugins:
  enabled: [whombat]
  auto_update_check_hours: 0
updates:
  check: false
telemetry:
  shared_metrics:
    enabled: false
    send: false
security:
  allow_lazy_installs: false
curator:
  enabled: false
"""
#: Hermes's essential skill, never seeded on Whombat (HE-S127, HSK-04).
HERMES_MANUAL = "hermes-agent"
BUNDLED_MANIFEST = ".bundled_manifest"
#: The hub's three sources (HSK-06).
SOURCES = ("official", "github", "skills-sh")
#: Time budgets in seconds (an input's ``timeout`` overrides them).
BUDGETS = {"hub-search": 20.0, "hub-inspect": 60.0, "hub-install": 90.0, "hub-check": 60.0, "hub-update": 90.0}
#: How long a step that changes the skills folder waits for another one to finish.
LOCK_WAIT_S = 60.0


class StepError(Exception):
    def __init__(self, code: str, message: str):
        assert code in CODES, code
        super().__init__(message)
        self.code, self.message = code, message


# --- the skills home -----------------------------------------------------------------------------------------------


def _home() -> Path:
    raw = os.environ.get("HERMES_HOME", "").strip()
    if not raw:
        raise StepError("invalid", "HERMES_HOME must name the skills home.")
    return Path(raw).expanduser().absolute()


#: What a Hermes profile holds and the skills home never does: a person's Hermes state.
PROFILE_ENTRIES = ("state.db", "memories", "sessions", "auth.json", "SOUL.md")


def _not_a_profile(home: Path) -> None:
    """A home with a person's Hermes state and no skills-home marker is a profile: refused before anything in it
    changes (a step would write its marker and config there)."""
    if (home / MARKER).exists():
        return
    if any((home / name).exists() for name in PROFILE_ENTRIES):
        raise StepError("invalid", "HERMES_HOME is a Hermes profile, not the skills home.")


def _shared_dir(payload: dict, home: Path) -> Path:
    raw = payload.get("dir")
    if not isinstance(raw, str) or not raw.strip() or not os.path.isabs(raw):
        raise StepError("invalid", "dir must be the skills folder's absolute path.")
    shared = Path(os.path.normpath(raw))
    if shared == home or shared.is_relative_to(home) or home.is_relative_to(shared):
        raise StepError("invalid", "The skills home and the skills folder must be apart.")
    return shared


def prepare_home(home: Path, shared: Optional[Path]) -> None:
    """The skills home ready for one step: its marker and config, no opt-out marker (the sync would seed only
    Hermes's essential skill), and ``skills`` a link to ``shared`` (left as it is when the step has no directory)."""
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    marker = home / MARKER
    if not marker.exists():
        marker.write_text("Whombat's skills home: Hermes's skills steps on the person's skills folder.\n",
                          encoding="utf-8")
    config = home / "config.yaml"
    if not config.exists():
        config.write_text(SKILLS_HOME_CONFIG, encoding="utf-8")
    (home / ".no-bundled-skills").unlink(missing_ok=True)
    if shared is None:
        return
    shared.mkdir(parents=True, exist_ok=True)
    link = home / "skills"
    if link.is_symlink():
        if os.readlink(link) == str(shared):
            return
        tmp = home / f".skills-link-{os.getpid()}"
        tmp.unlink(missing_ok=True)
        os.symlink(shared, tmp)
        os.replace(tmp, link)
        return
    if link.is_dir():
        # Hermes's start makes an empty one before the first step of a fresh home, and the plugin's profile setup may
        # have put its manifest in it before the marker was there.
        leftovers = {p.name for p in link.iterdir()}
        if leftovers - {BUNDLED_MANIFEST}:
            raise StepError("failed", f"{link} is a folder with files in it, not a link to the skills folder; "
                                      "remove it and run the step again.")
        (link / BUNDLED_MANIFEST).unlink(missing_ok=True)
        link.rmdir()
    elif link.exists():
        link.unlink()
    os.symlink(shared, link)


def _hub_paths(home: Path, shared: Optional[Path]) -> None:
    """The hub's quarantine and caches in the skills home; its lock, audit log and taps in the skills folder's
    ``.hub`` (Hermes's place), or in the home too when the step has no skills folder."""
    import tools.skills_hub as hub

    work = home / "hub"
    for path in (_quarantine(home), work / "index-cache"):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    hub.QUARANTINE_DIR = _quarantine(home)
    hub.INDEX_CACHE_DIR = work / "index-cache"
    if shared is None:
        hub.HUB_DIR = work
    else:
        vars(hub).pop("HUB_DIR", None)


def _quarantine(home: Path) -> Path:
    """This step's own quarantine (Hermes empties a skill's quarantine folder before writing it: two steps at once
    must not share one); removed when the step ends."""
    return home / "hub" / "quarantine" / str(os.getpid())


def _no_external_dirs() -> None:
    from agent.skill_utils import _external_dirs_cache_clear, get_external_skills_dirs

    _external_dirs_cache_clear()
    if get_external_skills_dirs():
        raise StepError("invalid", "The skills home's config.yaml lists skills.external_dirs; it must list none.")


@contextmanager
def _exclusive(home: Path) -> Iterator[None]:
    """One step that changes the skills folder at a time (per skills home)."""
    with open(home / ".step.lock", "a+") as handle:
        deadline = time.monotonic() + LOCK_WAIT_S
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise StepError("conflict", "Another skills step is still running.") from None
                time.sleep(0.1)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _budget(payload: dict, op: str) -> float:
    value = payload.get("timeout", BUDGETS.get(op, 60.0))
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 < value <= 600:
        raise StepError("invalid", "timeout must be a number of seconds up to 600.")
    return float(value)


def _within(fn: Callable[[], Any], seconds: float, what: str) -> Any:
    """``fn()`` on a worker thread, or ``unavailable`` when it isn't done in ``seconds`` (the thread is left to the
    process's exit: a hub source that doesn't answer can't be interrupted)."""
    box: dict[str, Any] = {}

    def work() -> None:
        try:
            box["value"] = fn()
        except BaseException as exc:  # handed to the caller's thread
            box["error"] = exc

    worker = threading.Thread(target=work, name="whombat-skills-step", daemon=True)
    worker.start()
    worker.join(max(seconds, 0.0))
    if worker.is_alive():
        raise StepError("unavailable", f"{what} didn't answer in time.")
    if "error" in box:
        raise box["error"]
    return box.get("value")


# --- built-in skills (HSK-02, HSK-04) ------------------------------------------------------------------------------


def _keep_manual_out() -> None:
    """``hermes-agent`` named in the manifest as handled, so Hermes's sync never seeds it (HE-S127); a copy Hermes
    placed earlier and nobody changed goes."""
    from tools import skills_sync as ss

    manifest = ss._read_manifest()
    if manifest.get(HERMES_MANUAL) == "":
        return
    origin = manifest.get(HERMES_MANUAL)
    if origin:
        bundled_dir = ss._get_bundled_dir()
        src = dict(ss._discover_bundled_skills(bundled_dir)).get(HERMES_MANUAL)
        if src is not None:
            dest = ss._compute_relative_dest(src, bundled_dir)
            if dest.exists() and ss._matches_origin_hash(dest, origin):
                ss._rmtree_writable(dest)
    manifest[HERMES_MANUAL] = ""
    ss._write_manifest(manifest)


def _skill_names(shared: Path) -> dict[str, list[str]]:
    """Every skill in the skills folder by its name (front matter, else folder): relative paths."""
    from agent.skill_utils import iter_skill_index_files
    from tools.skill_usage import read_skill_name

    found: dict[str, list[str]] = {}
    for skill_md in iter_skill_index_files(shared, "SKILL.md"):
        rel = skill_md.parent.relative_to(shared).as_posix()
        found.setdefault(read_skill_name(skill_md, skill_md.parent.name), []).append(rel)
    return found


def op_sync(payload: dict, home: Path) -> dict:
    shared = _shared_dir(payload, home)
    prepare_home(home, shared)
    _no_external_dirs()
    with _exclusive(home):
        from tools import skills_sync as ss

        _keep_manual_out()
        bundled_dir = ss._get_bundled_dir()
        bundled = ss._discover_bundled_skills(bundled_dir)
        before = ss._read_manifest()
        occupied = [name for name, src in bundled
                    if name not in before and ss._compute_relative_dest(src, bundled_dir).exists()]
        result = ss.sync_skills(quiet=True)
        after = ss._read_manifest()
        duplicates = [{"name": n, "paths": sorted(p)} for n, p in sorted(_skill_names(shared).items()) if len(p) > 1]
    return {
        "added": sorted(result.get("copied", [])),
        "updated": sorted(result.get("updated", [])),
        "kept": sorted(result.get("user_modified", [])),
        "removed": sorted(result.get("cleaned", [])),
        "relocated": sorted(result.get("relocated", [])),
        # Folders at a built-in's place that Hermes didn't put there: it leaves them alone and never updates them.
        "not_placed": sorted(n for n in occupied if n not in after),
        "duplicates": duplicates,
        "total": sum(1 for name, _ in bundled if name != HERMES_MANUAL),
    }


def _turn_toolsets(disabled: list[str]) -> tuple[set[str], set[str]]:
    """``(toolsets, tools)`` a Whombat turn has: Hermes's own ACP set for the config Whombat writes (no
    ``platform_toolsets``; ``agent.disabled_toolsets`` as given, ``browser`` without a browser)."""
    from hermes_cli.tools_config import _get_platform_tools
    from toolsets import resolve_toolset

    toolsets = set(_get_platform_tools({"agent": {"disabled_toolsets": list(disabled)}}, "acp",
                                       include_default_mcp_servers=False))
    tools: set[str] = set()
    for name in toolsets:
        try:
            tools.update(resolve_toolset(name))
        except Exception:
            continue
    return toolsets, tools


def _offered(frontmatter: dict, toolsets: set[str], tools: set[str]) -> bool:
    """Hermes's offer-time gates (its skills index): the host's platform, the runtime environment, required apps, and
    the toolset conditions; no session platform (an ACP turn has none)."""
    from agent.prompt_builder import _skill_should_show
    from agent.skill_utils import (extract_skill_conditions, skill_matches_apps, skill_matches_environment,
                                   skill_matches_platform)

    return bool(skill_matches_platform(frontmatter) and skill_matches_environment(frontmatter)
                and skill_matches_apps(frontmatter)
                and _skill_should_show(extract_skill_conditions(frontmatter), tools, toolsets, None))


def _frontmatter(skill_md: Path) -> dict:
    from agent.skill_utils import parse_frontmatter

    try:
        return parse_frontmatter(skill_md.read_text(encoding="utf-8-sig"))[0]
    except (OSError, UnicodeDecodeError):
        return {}


def _category_texts(shared: Path, bundled_dir: Path, categories: set[str]) -> dict[str, dict]:
    """Each category's ``DESCRIPTION.md``: the skills folder's copy, else Hermes's (built-in, then optional)."""
    from agent.skill_utils import parse_frontmatter
    from tools.skills_sync import _get_optional_dir

    optional_dir = _get_optional_dir()
    out: dict[str, dict] = {}
    for category in sorted(categories):
        for root in (shared, bundled_dir, optional_dir):
            path = root / category / "DESCRIPTION.md"
            try:
                text = path.read_text(encoding="utf-8-sig")
            except OSError:
                continue
            description = parse_frontmatter(text)[0].get("description")
            out[category] = {"description": str(description).strip() if description else None, "text": text}
            break
        else:
            out[category] = {"description": None, "text": None}
    return out


def op_builtins(payload: dict, home: Path) -> dict:
    shared = _shared_dir(payload, home)
    disabled = payload.get("disabled_toolsets", [])
    if not isinstance(disabled, list) or not all(isinstance(t, str) for t in disabled):
        raise StepError("invalid", "disabled_toolsets must be a list of toolset names.")
    prepare_home(home, shared)
    from tools import skills_sync as ss

    manifest = ss._read_manifest()
    bundled_dir = ss._get_bundled_dir()
    toolsets, tools = _turn_toolsets(disabled)
    rows: list[dict] = []
    categories: set[str] = set()
    for name, src in sorted(ss._discover_bundled_skills(bundled_dir)):
        if name == HERMES_MANUAL:
            continue
        dest = ss._compute_relative_dest(src, bundled_dir)
        rel = dest.relative_to(ss._skills_dir()).as_posix()
        category = rel.rsplit("/", 1)[0] if "/" in rel else "general"
        categories.add(category)
        present = (dest / "SKILL.md").is_file()
        origin = manifest.get(name, "")
        tracked = name in manifest
        changed = bool(present and tracked and origin and not ss._matches_origin_hash(dest, origin))
        rows.append({
            "name": name, "path": rel, "category": category, "present": present, "tracked": tracked,
            "removed": tracked and not present, "changed": changed,
            "original_changed": changed and ss.dir_hash(src) != origin,
            "offered": _offered(_frontmatter((dest if present else src) / "SKILL.md"), toolsets, tools),
        })
    # Hub skills' and learned skills' categories too (HSK-13): every folder in `dir` that holds skills.
    categories.update(rel.rsplit("/", 1)[0] for paths in _skill_names(shared).values() for rel in paths if "/" in rel)
    return {"builtins": rows, "categories": _category_texts(shared, bundled_dir, categories),
            "toolsets": sorted(toolsets)}


def op_diff(payload: dict, home: Path) -> dict:
    shared = _shared_dir(payload, home)
    name = _name(payload)
    prepare_home(home, shared)
    from tools.skills_sync_bundled_ops import _bundled_state, diff_bundled_skill

    src = _bundled_state()[3].get(name)
    if src is None or name == HERMES_MANUAL:
        raise StepError("not_found", f"{name} isn't one of Hermes's built-in skills.")
    result = diff_bundled_skill(name)
    try:
        original = (src / "SKILL.md").read_text(encoding="utf-8-sig")
    except OSError:
        original = ""
    present = bool(result.get("ok"))
    return {"name": name, "present": present, "modified": bool(result.get("modified")),
            "diffs": [{"path": d["path"], "status": d["status"], "diff": d["diff"]} for d in result.get("diffs", [])],
            "skill_md": original}


def op_reset(payload: dict, home: Path) -> dict:
    shared = _shared_dir(payload, home)
    name = _name(payload)
    prepare_home(home, shared)
    _no_external_dirs()
    if name == HERMES_MANUAL:
        raise StepError("not_found", f"{name} isn't offered on a Whombat.")
    with _exclusive(home):
        from tools import skills_sync as ss
        from tools.skills_sync_bundled_ops import _bundled_state, reset_bundled_skill

        _keep_manual_out()
        _ss, _manifest, bundled_dir, by_name = _bundled_state()
        if name not in by_name:
            raise StepError("not_found", f"{name} isn't one of Hermes's built-in skills.")
        result = reset_bundled_skill(name, restore=True)
        if not result.get("ok"):
            raise StepError("not_found" if result.get("action") in ("not_in_manifest", "bundled_missing") else "failed",
                            result.get("message") or "The skill couldn't be restored.")
        dest = ss._compute_relative_dest(by_name[name], bundled_dir)
        if not (dest / "SKILL.md").is_file():
            raise StepError("failed", f"Hermes didn't put {name} back.")
    return {"name": name, "path": dest.relative_to(ss._skills_dir()).as_posix(), "restored": True}


def _name(payload: dict) -> str:
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip() or "/" in name or name in (".", ".."):
        raise StepError("invalid", "name must be a skill's name.")
    return name.strip()


# --- Hermes's hub, three sources (HSK-06, HSK-07, HSK-09) ----------------------------------------------------------

_SKILLS_SH_PREFIXES = ("skills-sh/", "skills.sh/", "skils-sh/", "skils.sh/")
_REFUSED_PREFIXES = ("clawhub/", "lobehub/", "browse-sh/", "well-known:", "http://", "https://")


def _allowed_repos() -> frozenset[str]:
    """Hermes's default GitHub taps that it trusts (``TRUSTED_REPOS``), lower case."""
    from tools.skills_guard import TRUSTED_REPOS
    from tools.skills_hub_github import GitHubSource

    return frozenset(t["repo"].lower() for t in GitHubSource.DEFAULT_TAPS if t["repo"] in TRUSTED_REPOS)


def _github_repo(identifier: str) -> Optional[str]:
    parts = identifier.strip().strip("/").split("/")
    return f"{parts[0]}/{parts[1]}".lower() if len(parts) >= 3 and parts[0] and parts[1] else None


def _source_of(source: str) -> str:
    return "skills-sh" if source in ("skills.sh", "skills-sh") else source


_CLASSES: dict[str, type] = {}


def _classes() -> dict[str, type]:
    """Hermes's source adapters limited to what Whombat allows (made once, after Hermes is importable)."""
    if _CLASSES:
        return _CLASSES
    from tools.skills_hub_github import GitHubSource
    from tools.skills_hub_official import HermesIndexSource, OptionalSkillSource
    from tools.skills_hub_skillssh import SkillsShSource

    class Official(OptionalSkillSource):
        """Hermes's optional skills as its package ships them, never its live repository."""

        def _list_remote_skill_dirs(self) -> dict[str, bool]:
            return {}

        def _fetch_from_live_repo(self, rel: str):
            return None

    class Index(HermesIndexSource):
        """Hermes's skills index, only its entries that resolve into the allowed GitHub repositories and skills.sh
        (the local catalog stands for ``official``)."""

        def __init__(self, auth, allowed: tuple[str, ...]):
            super().__init__(auth)
            self._allowed = allowed
            self._filtered: Optional[list] = None
            #: Set when the index didn't load in time: the registries answer for it (Hermes's own fallback).
            self.dropped = False

        def _skills(self) -> list:
            if self.dropped:
                return []
            if self._filtered is None:
                repos = _allowed_repos()
                filtered = [
                    s for s in super()._skills() if isinstance(s, dict) and (
                        (_source_of(str(s.get("source", ""))) == "skills-sh" and "skills-sh" in self._allowed)
                        or (s.get("source") == "github" and "github" in self._allowed
                            and str(s.get("repo", "")).lower() in repos))]
                self._filtered = filtered
            return [] if self.dropped else self._filtered

        def fetch(self, identifier: str):
            bundle = super().fetch(identifier)
            # A resolved GitHub id is fetched as it is; for a ``github`` entry it must stay in an allowed repository.
            if (bundle is not None and bundle.source == "github"
                    and _github_repo(bundle.identifier) not in _allowed_repos()):
                return None
            return bundle

    class GitHub(GitHubSource):
        """Hermes's GitHub source with its default taps that it trusts, and nothing else."""

        def __init__(self, auth):
            super().__init__(auth)
            repos = _allowed_repos()
            self.taps = [t for t in self.DEFAULT_TAPS if t["repo"].lower() in repos]

        def fetch(self, identifier: str):
            return super().fetch(identifier) if _github_repo(identifier) in _allowed_repos() else None

        def inspect(self, identifier: str):
            return super().inspect(identifier) if _github_repo(identifier) in _allowed_repos() else None

    _CLASSES.update(official=Official, index=Index, github=GitHub, skills_sh=SkillsShSource)
    return _CLASSES


def hub_sources(allowed: tuple[str, ...] = SOURCES, auth=None) -> list:
    """The allowed sources in Hermes's priority order (``create_source_router``'s): official, the index, skills.sh,
    GitHub."""
    from tools.skills_hub_github import GitHubAuth

    c = _classes()
    auth = auth or GitHubAuth()
    out: list = []
    if "official" in allowed:
        out.append(c["official"](auth=auth))
    if "github" in allowed or "skills-sh" in allowed:
        out.append(c["index"](auth, tuple(s for s in allowed if s != "official")))
    if "skills-sh" in allowed:
        out.append(c["skills_sh"](auth=auth))
    if "github" in allowed:
        out.append(c["github"](auth))
    return out


def route(identifier: str) -> str:
    """Which allowed source an identifier belongs to; ``invalid`` for any other (ClawHub, LobeHub, browse.sh,
    well-known endpoints, links, other GitHub repositories)."""
    ident = identifier.strip()
    low = ident.lower()
    if not ident:
        raise StepError("invalid", "identifier must name a skill of Hermes's hub.")
    if low.startswith("official/"):
        return "official"
    if low.startswith(_SKILLS_SH_PREFIXES):
        return "skills-sh"
    if not low.startswith(_REFUSED_PREFIXES) and "://" not in low:
        repo = _github_repo(ident)
        if repo is not None and repo in _allowed_repos():
            return "github"
    raise StepError("invalid", "Skills come only from Hermes's official skills, its trusted GitHub repositories and "
                               "skills.sh.")


def _identifier(payload: dict) -> str:
    identifier = payload.get("identifier")
    if not isinstance(identifier, str) or not identifier.strip():
        raise StepError("invalid", "identifier must name a skill of Hermes's hub.")
    return identifier.strip()


def _meta_row(meta) -> dict:
    extra = getattr(meta, "extra", None) or {}
    installs = extra.get("installs")
    if not isinstance(installs, int) or isinstance(installs, bool):
        installs = None
    return {"source": _source_of(meta.source), "identifier": meta.identifier, "name": meta.name,
            "description": meta.description or "", "trust": meta.trust_level, "repo": meta.repo or None,
            "path": meta.path or None, "installs": installs}


def op_hub_search(payload: dict, home: Path) -> dict:
    query = payload.get("query", "") or ""
    source = payload.get("source", "all") or "all"
    limit = payload.get("limit", 20)
    if not isinstance(query, str):
        raise StepError("invalid", "query must be text.")
    if source != "all" and source not in SOURCES:
        raise StepError("invalid", f"source must be one of {', '.join(SOURCES)} or all.")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise StepError("invalid", "limit must be a number from 1 to 100.")
    budget = _budget(payload, "hub-search")
    deadline = time.monotonic() + budget
    prepare_home(home, None)
    _hub_paths(home, None)
    from tools.skills_hub_models import TRUST_RANK, _dedupe_by_trust
    from tools.skills_hub_search import parallel_search_sources

    allowed = SOURCES if source == "all" else (source,)
    sources = hub_sources(allowed)
    unanswered: set[str] = set()
    index = next((s for s in sources if s.source_id() == "hermes-index"), None)
    if index is not None:
        # The index is a large download (cached for hours): within part of the budget, or the registries answer
        # for it, as Hermes does when it has none.
        try:
            _within(index._skills, max(min(budget * 0.6, deadline - time.monotonic() - 1.0), 0.5),
                    "Hermes's skills index")
        except StepError:
            index.dropped = True
    stands_for = [s for s in allowed if s != "official"]
    results, _counts, timed_out = parallel_search_sources(
        sources, query=query.strip(), per_source_limits={s.source_id(): limit for s in sources},
        source_filter="all", overall_timeout=max(deadline - time.monotonic(), 0.5))
    for sid in timed_out:
        unanswered.update(stands_for if sid == "hermes-index" else [_source_of(sid)])
    if any(getattr(s, "is_rate_limited", False) or getattr(getattr(s, "github", None), "is_rate_limited", False)
           for s in sources):
        unanswered.add("github")
    rows = _dedupe_by_trust(r for r in results if _source_of(r.source) in allowed)
    rows.sort(key=lambda r: -TRUST_RANK.get(r.trust_level, 0))
    answered = [_meta_row(r) for r in rows[:limit]]
    return {"results": answered, "unanswered": sorted(unanswered & set(allowed))}


def _check_provenance(bundle, source: str) -> None:
    if _source_of(bundle.source) != source or (source == "github" and _github_repo(bundle.identifier) not in
                                                _allowed_repos()):
        raise StepError("invalid", "The skill didn't come from the source its identifier names.")


def _resolve(identifier: str, source: str, budget: float):
    """``(meta, bundle)`` from one allowed source's adapters (Hermes's ``_resolve_source_meta_and_bundle``)."""
    from hermes_cli.skills_hub import _resolve_source_meta_and_bundle
    from tools.skills_hub import skills_hub_http_session

    sources = hub_sources((source,))

    def fetch():
        with skills_hub_http_session():
            meta, bundle, _src = _resolve_source_meta_and_bundle(identifier, sources)
        return meta, bundle

    meta, bundle = _within(fetch, budget, "The skill's source")
    if bundle is None:
        if any(getattr(s, "is_rate_limited", False) or getattr(getattr(s, "github", None), "is_rate_limited", False)
               for s in sources):
            raise StepError("unavailable", "GitHub's limit for requests without a sign-in is used up for now.")
        raise StepError("not_found", f"{identifier} couldn't be found or fetched.")
    _check_provenance(bundle, source)
    return meta, bundle


def _builtin(identifier: str) -> None:
    from tools.skills_sync_bundled_ops import bundled_skill_for_install

    if bundled_skill_for_install(identifier):
        raise StepError("conflict", "That's one of Hermes's built-in skills, which come with Hermes.")


def _scan(q_path: Path, bundle, meta, identifier: str, home: Path):
    """Hermes's install scan (``_scan_quarantined``) and policy (``should_allow_install``, never forced), with the
    stricter of the scan's and the source's trust level (an official catalog stub is live third-party content, which
    Hermes marks ``trusted``)."""
    from tools.skills_guard import scan_skill_cached, should_allow_install
    from tools.skills_hub_models import TRUST_RANK, source_url_for_bundle

    scan_source = "official" if bundle.source == "official" else (
        bundle.identifier or getattr(meta, "identifier", "") or identifier)
    result, _prov = scan_skill_cached(q_path, source=scan_source, source_url=source_url_for_bundle(bundle),
                                      cache_dir=home / "hub" / "scan-cache")
    if TRUST_RANK.get(bundle.trust_level, 0) < TRUST_RANK.get(result.trust_level, 0):
        result.trust_level = bundle.trust_level
    allowed, reason = should_allow_install(result, force=False)
    return result, ("allow" if allowed is True else "block"), reason


def _findings(result) -> list[dict]:
    return [{"pattern_id": f.pattern_id, "severity": f.severity, "category": f.category, "file": f.file,
             "line": f.line, "match": f.match, "description": f.description} for f in result.findings]


def _default_category(bundle) -> str:
    # Hermes keeps an official skill's place in its catalog; every other source installs at the top.
    return "/".join(bundle.identifier.split("/")[1:-1]) if bundle.source == "official" else ""


def op_hub_inspect(payload: dict, home: Path) -> dict:
    identifier = _identifier(payload)
    budget = _budget(payload, "hub-inspect")
    source = route(identifier)
    prepare_home(home, None)
    _hub_paths(home, None)
    _builtin(identifier)
    meta, bundle = _resolve(identifier, source, budget)
    from tools.skills_hub_install import quarantine_bundle

    try:
        q_path = quarantine_bundle(bundle)
    except ValueError as exc:
        raise StepError("blocked", str(exc)) from None
    try:
        result, decision, reason = _scan(q_path, bundle, meta, identifier, home)
        files = sorted(({"path": p.relative_to(q_path).as_posix(), "size": p.stat().st_size}
                        for p in q_path.rglob("*") if p.is_file()), key=lambda f: f["path"])
        try:
            skill_md = (q_path / "SKILL.md").read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            skill_md = ""
    finally:
        shutil.rmtree(q_path, ignore_errors=True)
    head = meta or bundle
    return {
        "identifier": bundle.identifier, "name": bundle.name, "description": getattr(head, "description", "") or "",
        "source": _source_of(bundle.source), "trust": result.trust_level, "repo": getattr(meta, "repo", None),
        "path": getattr(meta, "path", None), "category": _default_category(bundle), "skill_md": skill_md,
        "files": files, "verdict": result.verdict, "findings": _findings(result), "decision": decision,
        "reason": reason,
    }


def _install_bundle(home: Path, shared: Path, bundle, meta, identifier: str, category: str) -> dict:
    """Quarantine, scan, policy and Hermes's install from quarantine into the skills folder (its lock entry and
    audit line)."""
    from tools.skills_hub import append_audit_log
    from tools.skills_hub_install import install_from_quarantine, quarantine_bundle

    try:
        q_path = quarantine_bundle(bundle)
    except ValueError as exc:
        append_audit_log("BLOCKED", bundle.name, bundle.source, bundle.trust_level, "invalid_path", str(exc))
        raise StepError("blocked", str(exc)) from None
    try:
        result, decision, reason = _scan(q_path, bundle, meta, identifier, home)
        if decision != "allow":
            append_audit_log("BLOCKED", bundle.name, bundle.source, bundle.trust_level, result.verdict,
                             f"{len(result.findings)}_findings")
            raise StepError("blocked", reason)
        try:
            install_dir = install_from_quarantine(q_path, bundle.name, category, bundle, result)
        except ValueError as exc:
            raise StepError("conflict", str(exc)) from None
    finally:
        shutil.rmtree(q_path, ignore_errors=True)
    return {"name": bundle.name, "identifier": bundle.identifier, "source": _source_of(bundle.source),
            "trust": result.trust_level, "verdict": result.verdict,
            "path": install_dir.resolve().relative_to(shared.resolve()).as_posix(),
            "files": sorted(bundle.files.keys())}


def _category(payload: dict) -> Optional[str]:
    category = payload.get("category")
    if category is None or category == "":
        return None
    from hermes_cli.skills_hub import _VALID_CATEGORY_RE

    if not isinstance(category, str) or not _VALID_CATEGORY_RE.match(category) or ".." in category.split("/"):
        raise StepError("invalid", "category must be a folder name in lower case (letters, digits, - and _).")
    return category.strip("/")


def op_hub_install(payload: dict, home: Path) -> dict:
    shared = _shared_dir(payload, home)
    identifier = _identifier(payload)
    category = _category(payload)
    budget = _budget(payload, "hub-install")
    source = route(identifier)
    prepare_home(home, shared)
    _hub_paths(home, shared)
    _no_external_dirs()
    _builtin(identifier)
    meta, bundle = _resolve(identifier, source, budget)
    from tools.skills_hub import HubLockFile
    from tools.skills_hub_models import _validate_skill_name

    try:
        _validate_skill_name(bundle.name)
    except ValueError as exc:
        raise StepError("blocked", str(exc)) from None
    with _exclusive(home):
        if HubLockFile().get_installed(bundle.name):
            raise StepError("conflict", f"{bundle.name} is already installed.")
        if bundle.name in _skill_names(shared):
            raise StepError("conflict", f"A skill named {bundle.name} is already here.")
        return _install_bundle(home, shared, bundle, meta, identifier,
                               _default_category(bundle) if category is None else category)


def op_hub_uninstall(payload: dict, home: Path) -> dict:
    shared = _shared_dir(payload, home)
    name = _name(payload)
    prepare_home(home, shared)
    _hub_paths(home, shared)
    with _exclusive(home):
        from tools.skills_hub import HubLockFile
        from tools.skills_hub_install import uninstall_skill

        entry = HubLockFile().get_installed(name)
        if not entry:
            raise StepError("not_found", f"{name} isn't a skill installed from the hub.")
        ok, message = uninstall_skill(name)
        if not ok:
            raise StepError("failed", message)
    return {"name": name, "path": entry.get("install_path"), "removed": True}


def _checks(names: list[str], budget: float) -> dict[str, dict]:
    """Hermes's update check per installed hub skill, as many as answer within the budget."""
    from tools.skills_hub import HubLockFile
    from tools.skills_hub_install import check_for_skill_updates

    done: dict[str, dict] = {}
    sources = hub_sources(("official", "skills-sh", "github"))
    lock = HubLockFile()

    def work() -> None:
        for name in names:
            for row in check_for_skill_updates(name=name, lock=lock, sources=sources):
                done[row.get("name", name)] = row

    try:
        _within(work, budget, "The skills' sources")
    except StepError:
        pass
    return dict(done)


def op_hub_check(payload: dict, home: Path) -> dict:
    shared = _shared_dir(payload, home)
    budget = _budget(payload, "hub-check")
    prepare_home(home, shared)
    _hub_paths(home, shared)
    from tools.skills_hub import HubLockFile

    installed = HubLockFile().list_installed()
    done = _checks([e["name"] for e in installed], budget)
    rows = []
    for entry in installed:
        row = done.get(entry["name"], {"status": "unavailable"})
        rows.append({"name": entry["name"], "identifier": entry.get("identifier", ""),
                     "source": _source_of(entry.get("source", "")), "status": row.get("status", "unavailable"),
                     "update_available": row.get("status") == "update_available"})
    return {"skills": rows}


def op_hub_update(payload: dict, home: Path) -> dict:
    shared = _shared_dir(payload, home)
    name = _name(payload)
    overwrite = payload.get("overwrite", False) is True
    budget = _budget(payload, "hub-update")
    prepare_home(home, shared)
    _hub_paths(home, shared)
    _no_external_dirs()
    from hermes_cli.skills_hub import _has_local_edits
    from tools.skills_hub import HubLockFile

    installed = HubLockFile().get_installed(name)
    if not installed:
        raise StepError("not_found", f"{name} isn't a skill installed from the hub.")
    source = _source_of(installed.get("source", ""))
    if source not in SOURCES:
        raise StepError("invalid", f"{name} came from a source Whombat doesn't use.")
    row = _checks([name], budget).get(name)
    status = (row or {}).get("status", "unavailable")
    if status == "up_to_date":
        return {"name": name, "updated": False}
    if status in ("orphaned", "invalid_install"):
        raise StepError("not_found", f"{name}'s folder is missing.")
    if status != "update_available" or not row.get("bundle"):
        raise StepError("unavailable", f"{name}'s source didn't answer.")
    bundle = row["bundle"]
    _check_provenance(bundle, source)
    if bundle.name != name:
        raise StepError("failed", f"{name} has a different name at its source now.")
    if not overwrite and _has_local_edits(installed):
        raise StepError("conflict", f"{name} was changed here; updating it would replace those changes.")
    parent = str(Path(installed.get("install_path", "")).parent)
    with _exclusive(home):
        done = _install_bundle(home, shared, bundle, None, installed.get("identifier", ""),
                               "" if parent == "." else parent)
    return {**done, "updated": True}


def op_scan(payload: dict, home: Path) -> dict:
    raw = payload.get("path")
    if not isinstance(raw, str) or not os.path.isabs(raw):
        raise StepError("invalid", "path must be a skill folder's absolute path.")
    path = Path(raw)
    if not path.exists():
        raise StepError("not_found", f"{path} doesn't exist.")
    prepare_home(home, None)
    from tools.skills_guard import scan_skill, should_allow_install

    result = scan_skill(path, source="agent-created")
    allowed, reason = should_allow_install(result, force=False)
    # Hermes's "ask" for a dangerous agent-created skill: nobody confirms one here, so it is refused (HSK-07).
    return {"verdict": result.verdict, "findings": _findings(result),
            "decision": "allow" if allowed is True else "block", "reason": reason}


OPS: dict[str, Callable[[dict, Path], dict]] = {
    "sync": op_sync, "builtins": op_builtins, "diff": op_diff, "reset": op_reset,
    "hub-search": op_hub_search, "hub-inspect": op_hub_inspect, "hub-install": op_hub_install,
    "hub-uninstall": op_hub_uninstall, "hub-check": op_hub_check, "hub-update": op_hub_update, "scan": op_scan,
}


# --- the process ---------------------------------------------------------------------------------------------------


def run(op: str, payload: Any) -> dict:
    """One step: its answer, or ``StepError``."""
    handler = OPS.get(op)
    if handler is None:
        raise StepError("invalid", f"Unknown step {op!r}; one of {', '.join(OPS)}.")
    if not isinstance(payload, dict):
        raise StepError("invalid", "The input must be a JSON object.")
    home = _home()
    _not_a_profile(home)
    try:
        return handler(payload, home)
    finally:
        shutil.rmtree(_quarantine(home), ignore_errors=True)


def main(argv: Optional[list[str]] = None, stdin=None, stdout=None, *, process: bool = False) -> int:
    """Reads the input, runs the step with anything Hermes prints sent to stderr, writes one JSON object (one line).
    ``process``: stdout stays stderr afterwards, so a source thread left behind can't print after the answer."""
    argv = sys.argv[1:] if argv is None else argv
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    saved = sys.stdout
    sys.stdout = sys.stderr
    try:
        if len(argv) != 1:
            raise StepError("invalid", f"One step: {', '.join(OPS)}.")
        text = stdin.read()
        try:
            payload = json.loads(text) if text.strip() else {}
        except json.JSONDecodeError:
            raise StepError("invalid", "The input isn't JSON.") from None
        answer, code = run(argv[0], payload), 0
    except StepError as exc:
        answer, code = {"code": exc.code, "message": exc.message}, 1
    except Exception as exc:  # anything Hermes raised: the step failed
        answer, code = {"code": "failed", "message": f"{type(exc).__name__}: {exc}"}, 1
    finally:
        if not process:
            sys.stdout = saved
    stdout.write(json.dumps(answer, ensure_ascii=False) + "\n")
    stdout.flush()
    return code


def setup_cli(parser) -> None:
    """``hermes whombat-skills <op>`` (the plugin's ``register_cli_command``)."""
    parser.add_argument("op", choices=sorted(OPS), help="the step; its JSON input on stdin")


def run_cli(args) -> None:
    sys.exit(main([args.op], process=True))


if __name__ == "__main__":
    sys.exit(main(process=True))
