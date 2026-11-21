"""ChatGPT sign-in and account reads through Hermes's own ``openai-codex`` code (docs/decisions/hermes-native.md HN-02,
HN-03, HN-C01…): one step per process, ``python -m whombat_hermes.codex_auth <op>`` with the Python beside ``hermes``,
JSON on stdout (one object per line), anything Hermes prints sent to stderr.

    login     HERMES_HOME = a private staging home. Hermes's device-code login (OpenAI's own page and a one-time code):
              ``{"event": "code", ...}`` once the code is there, ``{"event": "done", "ok": ...}`` at the end. Hermes
              writes the login into the staging home's ``auth.json``; the step checks it with Hermes's read-only
              resolution before it says ``ok``.
    token     HERMES_HOME = a staging home. A Codex access token (stdin, never an argument) as Hermes's own
              ``openai-codex`` credential (a pool entry of the API-key kind, as ``hermes auth add`` makes one).
    install   HERMES_HOME = the person's profile; stdin ``{"from": <staging home>}``. The staged ``auth.json`` replaces
              the profile's, under Hermes's own auth-store lock (``auth.lock``), so a Hermes running there never
              writes an older login over it.
    remove    HERMES_HOME = the profile. Its ``auth.json`` goes, under the same lock.
    lend      HERMES_HOME = the person's profile; stdin ``{"to": <outsiders' profile>, "minSeconds": n}``. The person's
              current access token, refreshed first the Hermes way when it has less than ``minSeconds`` left
              (``resolve_codex_runtime_credentials`` under Hermes's auth-store lock, the rotated pair written back
              there), goes into ``to`` as an access token alone: one pool entry of the API-key kind, no refresh
              token, so nothing there can refresh or spend the person's rotation (Whombat one-person.md OP-S89).
              ``{"ok": true, "expiresAt"}``.
    status    HERMES_HOME = a home. Whether Hermes has a ChatGPT login there (read-only: nothing refreshed or written).
    usage     HERMES_HOME = the profile. The plan and its usage windows, from Hermes's own usage read.
    models    any HERMES_HOME. Hermes's catalog of ChatGPT models without a sign-in.

Nothing here prints a token, and Whombat's TypeScript never opens ``auth.json``: only Hermes reads, writes and refreshes
it (HN-03).
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import stat
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

#: OpenAI's device-code issuer (Hermes's own constant in ``_codex_device_code_login``).
ISSUER = "https://auth.openai.com"
#: Where the person enters the code.
VERIFICATION_URI = f"{ISSUER}/codex/device"
#: How long Hermes polls for the code (``_codex_poll_authorization_code``'s ``max_wait``).
CODE_MINUTES = 15
AUTH_FILE = "auth.json"
LOCK_FILE = "auth.lock"
#: How long ``install`` and ``remove`` wait for Hermes's auth-store lock.
LOCK_WAIT_S = 30.0
PROVIDER = "openai-codex"
#: ``lend``'s refresh window, clamped: at least ten minutes left, at most a day asked for.
LEND_MIN_S, LEND_MAX_S = 600, 86_400
#: A lent token must still have this long when it is handed over.
LEND_LEFT_S = 60


class StepError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _home() -> Path:
    from .settings import hermes_home

    return hermes_home()


def _emit(out, value: dict[str, Any]) -> None:
    out.write(json.dumps(value, ensure_ascii=False) + "\n")
    out.flush()


# --- login --------------------------------------------------------------------------------------------------------


def login_failure(exc: BaseException) -> dict[str, str]:
    """Why Hermes's device login ended without a login: a reason Whombat words for people, and Hermes's own detail."""
    code = str(getattr(exc, "code", "") or "")
    detail = str(exc)[:300]
    if code == "device_code_timeout":
        reason = "expired"
    elif code in {"device_code_request_failed", "token_exchange_failed"} or (
        code == "device_code_poll_error" and "transport" in detail.lower()
    ):
        reason = "network"
    elif code == "device_code_request_error" and "404" in detail:
        # The usercode endpoint refuses device-code sign-in for this account or workspace.
        reason = "disabled"
    elif code == "codex_rate_limited":
        reason = "busy"
    else:
        reason = "failed"
    return {"reason": reason, "detail": detail}


def _login(out) -> int:
    from hermes_cli import auth_codex
    from hermes_cli.auth import _save_codex_tokens, _utc_now_z
    from hermes_cli.auth_constants import CODEX_OAUTH_CLIENT_ID

    # Hermes's own three steps (``_codex_device_code_login``), with the code reported as JSON instead of printed.
    try:
        device = auth_codex._codex_request_device_code(ISSUER, CODEX_OAUTH_CLIENT_ID)
    except Exception as exc:
        _emit(out, {"event": "done", "ok": False, **login_failure(exc)})
        return 1
    _emit(out, {"event": "code", "verificationUri": VERIFICATION_URI, "userCode": str(device["user_code"]),
                "expiresInMinutes": CODE_MINUTES})
    try:
        approved = auth_codex._codex_poll_authorization_code(
            ISSUER, device_auth_id=device["device_auth_id"], user_code=device["user_code"],
            poll_interval=device["interval"])
        tokens = auth_codex._codex_exchange_authorization_code(ISSUER, CODEX_OAUTH_CLIENT_ID, approved)
        _save_codex_tokens({"access_token": tokens.get("access_token", ""),
                            "refresh_token": tokens.get("refresh_token", "")}, _utc_now_z())
    except Exception as exc:
        _emit(out, {"event": "done", "ok": False, **login_failure(exc)})
        return 1
    if not signed_in():
        _emit(out, {"event": "done", "ok": False, "reason": "failed",
                    "detail": "Hermes didn't keep the sign-in."})
        return 1
    _emit(out, {"event": "done", "ok": True})
    return 0


def signed_in() -> bool:
    """Hermes's read-only resolution (no refresh, no import, no write) finds a ChatGPT login in ``HERMES_HOME``."""
    from hermes_cli.auth import resolve_codex_runtime_credentials

    try:
        creds = resolve_codex_runtime_credentials(read_only=True)
    except Exception:
        return False
    return bool(str(creds.get("api_key") or "").strip())


# --- an access token ----------------------------------------------------------------------------------------------


def _token(stdin) -> dict[str, Any]:
    token = stdin.read().strip()
    if not token or len(token) > 16_384 or any(c.isspace() for c in token):
        raise StepError("invalid", "That doesn't look like a Codex access token.")
    from agent.credential_pool import AUTH_TYPE_API_KEY, SOURCE_MANUAL, PooledCredential, load_pool
    from hermes_cli.auth_constants import DEFAULT_CODEX_BASE_URL

    pool = load_pool(PROVIDER)
    pool.add_entry(PooledCredential(
        provider=PROVIDER, id=uuid.uuid4().hex[:6], label="Codex access token", auth_type=AUTH_TYPE_API_KEY,
        priority=0, source=SOURCE_MANUAL, access_token=token, base_url=DEFAULT_CODEX_BASE_URL))
    if not signed_in():
        raise StepError("failed", "Hermes didn't keep the access token.")
    return {"ok": True}


# --- install and remove -------------------------------------------------------------------------------------------


def _regular(path: Path) -> bool:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1


@contextmanager
def auth_store_lock(home: Path, wait_s: float = LOCK_WAIT_S) -> Iterator[None]:
    """Hermes's auth-store lock (``hermes_cli.auth._auth_store_lock``: an exclusive ``flock`` on ``auth.lock`` beside
    ``auth.json``), taken without following a link: a link or a file with another name there is removed first, never
    opened (the profile is a turn's writable home)."""
    path = home / LOCK_FILE
    for attempt in (1, 2):
        try:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        except OSError as exc:
            if exc.errno != errno.ELOOP or attempt == 2:
                raise
            os.unlink(path)
            continue
        info = os.fstat(fd)
        if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            break
        os.close(fd)
        if attempt == 2:
            raise StepError("failed", "Hermes's auth lock in this profile isn't a plain file.")
        os.unlink(path)
    deadline = time.monotonic() + wait_s
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise StepError("busy", "Hermes kept its sign-in file busy; try again.") from None
                time.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _sync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def install(staging: Path, home: Path) -> dict[str, Any]:
    source = staging / AUTH_FILE
    if not _regular(source):
        raise StepError("not_found", "There's no staged sign-in to keep.")
    with auth_store_lock(home):
        # A rename: the file isn't read here, and a link at the target is replaced, never followed.
        os.replace(source, home / AUTH_FILE)
        _sync_dir(home)
    return {"ok": True}


def remove(home: Path) -> dict[str, Any]:
    target = home / AUTH_FILE
    if not os.path.lexists(target):
        return {"ok": True, "removed": False}
    with auth_store_lock(home):
        try:
            os.unlink(target)
            removed = True
        except FileNotFoundError:
            removed = False
        _sync_dir(home)
    return {"ok": True, "removed": removed}


# --- lending the person's access token to the outsiders' profile ---------------------------------------------------


def _expires_at(token: str) -> Optional[float]:
    from hermes_cli.auth_constants import _decode_jwt_claims

    exp = _decode_jwt_claims(token).get("exp")
    return float(exp) if isinstance(exp, (int, float)) else None


def lend(home: Path, to: Path, min_seconds: int) -> dict[str, Any]:
    """The person's access token alone into ``to``'s ``auth.json`` (see the module comment). Refreshes only in the
    person's own store, Hermes's way; ``to`` gets one API-key pool entry and nothing else."""
    from agent.credential_pool import AUTH_TYPE_API_KEY, SOURCE_MANUAL, PooledCredential
    from hermes_cli.auth import AuthError, _save_auth_store, resolve_codex_runtime_credentials
    from hermes_cli.auth_constants import DEFAULT_CODEX_BASE_URL

    info = os.lstat(to) if os.path.lexists(to) else None
    if info is None or not stat.S_ISDIR(info.st_mode):
        raise StepError("invalid", "The outsiders' profile isn't a folder.")
    if to.resolve() == home.resolve():
        raise StepError("invalid", "A token is lent to another profile, never the person's own.")
    window = max(LEND_MIN_S, min(LEND_MAX_S, int(min_seconds)))
    try:
        creds = resolve_codex_runtime_credentials(refresh_if_expiring=True, refresh_skew_seconds=window)
    except AuthError as exc:
        if getattr(exc, "relogin_required", False) or str(getattr(exc, "code", "")).startswith("codex_auth_missing"):
            raise StepError("not_signed_in", "The ChatGPT sign-in needs signing in again.") from None
        raise StepError("failed", f"{getattr(exc, 'code', '') or 'auth_error'}: {str(exc)[:200]}") from None
    token = str(creds.get("api_key") or "").strip()
    exp = _expires_at(token)
    if not token:
        raise StepError("not_signed_in", "There's no ChatGPT sign-in here.")
    if exp is not None and exp - time.time() < LEND_LEFT_S:
        raise StepError("expired", "The ChatGPT sign-in's access token has run out and couldn't be refreshed.")
    entry = PooledCredential(
        provider=PROVIDER, id=uuid.uuid4().hex[:6], label="Lent for one turn", auth_type=AUTH_TYPE_API_KEY,
        priority=0, source=SOURCE_MANUAL, access_token=token,
        base_url=str(creds.get("base_url") or DEFAULT_CODEX_BASE_URL))
    with auth_store_lock(to):
        # The whole store is written: nothing of an earlier turn's, and no singleton tokens to refresh.
        _save_auth_store({"credential_pool": {PROVIDER: [entry.to_dict()]}}, target_path=to / AUTH_FILE)
    expires = datetime.fromtimestamp(exp, timezone.utc).isoformat().replace("+00:00", "Z") if exp is not None else None
    return {"ok": True, "expiresAt": expires}


# --- usage --------------------------------------------------------------------------------------------------------


def _iso(value: Any) -> Optional[str]:
    from agent.account_usage import _parse_dt

    dt = _parse_dt(value)
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def usage_from(raw: dict[str, Any]) -> dict[str, Any]:
    """Hermes's usage answer (``_fetch_codex_account_usage``'s ``raw``) as Whombat reads it: each window's share,
    length and reset, the plan, and whether a limit was reached. Pure."""
    rate = raw.get("rate_limit") if isinstance(raw.get("rate_limit"), dict) else {}
    windows = []
    for key in ("primary_window", "secondary_window"):
        window = rate.get(key)
        if not isinstance(window, dict):
            continue
        used = window.get("used_percent")
        seconds = window.get("limit_window_seconds")
        windows.append({
            "usedPercent": float(used) if isinstance(used, (int, float)) else None,
            "windowMinutes": round(seconds / 60) if isinstance(seconds, (int, float)) and seconds > 0 else None,
            "resetsAt": _iso(window.get("reset_at")),
        })
    plan = raw.get("plan_type")
    return {
        "plan": plan if isinstance(plan, str) and plan and plan != "unknown" else None,
        "windows": windows,
        "limited": rate.get("limit_reached") is True or rate.get("allowed") is False,
    }


def _usage() -> dict[str, Any]:
    if not signed_in():
        raise StepError("not_signed_in", "There's no ChatGPT sign-in here.")
    from agent.account_usage import _fetch_codex_account_usage

    try:
        snapshot = _fetch_codex_account_usage()
    except Exception as exc:
        raise StepError("failed", f"{type(exc).__name__}: {str(exc)[:200]}") from None
    return usage_from(snapshot.raw if snapshot is not None and isinstance(snapshot.raw, dict) else {})


# --- models -------------------------------------------------------------------------------------------------------


def _models() -> dict[str, Any]:
    from agent.model_metadata import CODEX_CONTEXT_VARIANT_SUFFIX
    from agent.reasoning_effort import codex_supported_efforts
    from hermes_cli.auth_constants import DEFAULT_CODEX_BASE_URL
    from hermes_cli.models import get_default_model_for_provider, resolve_fast_mode_overrides
    from hermes_cli.models_catalog_static import _codex_curated_models

    default = get_default_model_for_provider(PROVIDER)
    models = []
    for model in _codex_curated_models():
        # Hermes's large-context picker aliases are the same model with a bigger window: one entry each.
        if model.endswith(CODEX_CONTEXT_VARIANT_SUFFIX):
            continue
        models.append({
            "id": model,
            "efforts": list(codex_supported_efforts(model)),
            "isDefault": model == default,
            "fast": resolve_fast_mode_overrides(model, provider=PROVIDER, base_url=DEFAULT_CODEX_BASE_URL)
            is not None,
        })
    return {"models": models}


# --- the step -----------------------------------------------------------------------------------------------------

OPS = ("login", "token", "install", "remove", "lend", "status", "usage", "models")


def run(op: str, stdin, out) -> int:
    if op == "login":
        return _login(out)
    if op == "token":
        answer = _token(stdin)
    elif op == "install":
        text = stdin.read()
        try:
            payload = json.loads(text) if text.strip() else {}
        except json.JSONDecodeError:
            raise StepError("invalid", "The input isn't JSON.") from None
        source = payload.get("from") if isinstance(payload, dict) else None
        if not isinstance(source, str) or not os.path.isabs(source):
            raise StepError("invalid", "Say where the staged sign-in is.")
        answer = install(Path(source), _home())
    elif op == "remove":
        answer = remove(_home())
    elif op == "lend":
        text = stdin.read()
        try:
            payload = json.loads(text) if text.strip() else {}
        except json.JSONDecodeError:
            raise StepError("invalid", "The input isn't JSON.") from None
        to = payload.get("to") if isinstance(payload, dict) else None
        seconds = payload.get("minSeconds", LEND_MIN_S) if isinstance(payload, dict) else LEND_MIN_S
        if not isinstance(to, str) or not os.path.isabs(to) or not isinstance(seconds, int):
            raise StepError("invalid", "Say which profile the token is lent to, and for how long.")
        answer = lend(_home(), Path(to), seconds)
    elif op == "status":
        answer = {"signedIn": signed_in()}
    elif op == "usage":
        answer = _usage()
    elif op == "models":
        answer = _models()
    else:
        raise StepError("invalid", f"One step: {', '.join(OPS)}.")
    _emit(out, answer)
    return 0


def main(argv: Optional[list[str]] = None, stdin=None, stdout=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    stdin, stdout = stdin or sys.stdin, stdout or sys.stdout
    # Whatever Hermes prints (a retry notice, a status line) goes to stderr: stdout is the answer alone.
    saved = sys.stdout
    sys.stdout = sys.stderr
    try:
        if len(argv) != 1:
            raise StepError("invalid", f"One step: {', '.join(OPS)}.")
        return run(argv[0], stdin, stdout)
    except StepError as exc:
        _emit(stdout, {"code": exc.code, "message": exc.message})
        return 1
    except Exception as exc:  # anything Hermes raised: the step failed
        _emit(stdout, {"code": "failed", "message": f"{type(exc).__name__}: {str(exc)[:300]}"})
        return 1
    finally:
        sys.stdout = saved


if __name__ == "__main__":
    sys.exit(main())
