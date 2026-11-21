"""ChatGPT on Hermes's own ``openai-codex`` (HN-02, HN-03): the device login reported as JSON and kept in the staging
home, the staged login moved into a profile under Hermes's own auth-store lock, sign-out, an access token, usage and the
model list — with OpenAI's endpoints standing in, and no token ever on stdout."""

from __future__ import annotations

import base64
import io
import json
import os
import threading
from pathlib import Path

import pytest

from whombat_hermes import codex_auth

from .conftest import needs_hermes

pytestmark = needs_hermes


def jwt(claims: dict) -> str:
    part = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()  # noqa: E731
    return f"{part({'alg': 'none'})}.{part(claims)}.sig"


ACCESS = jwt({"exp": 4_102_444_800, "sub": "user-1",
              "https://api.openai.com/auth": {"chatgpt_account_id": "acct-1"}})
REFRESH = "rt-not-a-real-refresh-token"


def step(op: str, stdin: str = "") -> tuple[int, list[dict]]:
    out = io.StringIO()
    code = codex_auth.main([op], stdin=io.StringIO(stdin), stdout=out)
    return code, [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "staging"
    home.mkdir(mode=0o700)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    return home


@pytest.fixture
def openai(monkeypatch: pytest.MonkeyPatch):
    """OpenAI's device-code endpoints standing in (Hermes's own three steps, patched where they live)."""
    from hermes_cli import auth_codex

    seen: dict = {}

    def request(issuer, client_id):
        seen["issuer"] = issuer
        print("noise Hermes prints while it retries")
        return {"device_auth_id": "dev-1", "user_code": "ABCD-1234", "interval": 3}

    def poll(issuer, *, device_auth_id, user_code, poll_interval):
        seen["polled"] = (device_auth_id, user_code)
        return {"authorization_code": "code-1", "code_verifier": "verifier-1"}

    def exchange(issuer, client_id, code_resp):
        return {"access_token": ACCESS, "refresh_token": REFRESH}

    monkeypatch.setattr(auth_codex, "_codex_request_device_code", request)
    monkeypatch.setattr(auth_codex, "_codex_poll_authorization_code", poll)
    monkeypatch.setattr(auth_codex, "_codex_exchange_authorization_code", exchange)
    return seen


def test_login_reports_the_link_and_code_then_keeps_the_login_in_the_staging_home(home: Path, openai: dict):
    out = io.StringIO()
    code = codex_auth.main(["login"], stdin=io.StringIO(""), stdout=out)
    assert code == 0
    text = out.getvalue()
    events = [json.loads(line) for line in text.splitlines()]
    assert events[0] == {"event": "code", "verificationUri": "https://auth.openai.com/codex/device",
                         "userCode": "ABCD-1234", "expiresInMinutes": 15}
    assert events[-1] == {"event": "done", "ok": True}
    # Only JSON on stdout; never a token.
    assert ACCESS not in text and REFRESH not in text and "noise" not in text
    assert (home / "auth.json").is_file()
    assert oct((home / "auth.json").stat().st_mode & 0o777) == "0o600"
    assert step("status")[1] == [{"signedIn": True}]


@pytest.mark.parametrize(("code", "detail", "reason"), [
    ("device_code_timeout", "Login timed out after 15 minutes.", "expired"),
    ("device_code_request_failed", "Failed to request device code: boom", "network"),
    ("device_code_request_error", "Device code request returned status 404.", "disabled"),
    ("codex_rate_limited", "OpenAI is rate-limiting Codex login requests (HTTP 429).", "busy"),
    ("token_exchange_error", "Token exchange returned status 500.", "failed"),
])
def test_a_login_that_ends_without_a_login_says_why(home: Path, openai: dict, monkeypatch, code, detail, reason):
    from hermes_cli import auth_codex
    from hermes_cli.auth_constants import AuthError

    def fail(*_a, **_k):
        raise AuthError(detail, provider="openai-codex", code=code)

    monkeypatch.setattr(auth_codex, "_codex_poll_authorization_code", fail)
    status, events = step("login")
    assert status == 1
    assert events[0]["event"] == "code"
    assert events[-1]["ok"] is False and events[-1]["reason"] == reason
    assert not (home / "auth.json").exists()


def test_nothing_signed_in_in_an_empty_home(home: Path):
    assert step("status") == (0, [{"signedIn": False}])


def test_install_moves_the_staged_login_into_the_profile_without_following_links(
        home: Path, openai: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    assert step("login")[0] == 0
    profile = tmp_path / "profile"
    profile.mkdir(mode=0o700)
    victim = tmp_path / "victim.txt"
    victim.write_text("keep me")
    # A turn could leave links where Hermes keeps its login and lock: replaced, never followed.
    (profile / "auth.json").symlink_to(victim)
    (profile / "auth.lock").symlink_to(victim)
    monkeypatch.setenv("HERMES_HOME", str(profile))
    assert step("install", json.dumps({"from": str(home)})) == (0, [{"ok": True}])
    assert victim.read_text() == "keep me"
    assert not (profile / "auth.json").is_symlink() and not (profile / "auth.lock").is_symlink()
    assert not (home / "auth.json").exists()
    assert step("status")[1] == [{"signedIn": True}]
    assert step("remove") == (0, [{"ok": True, "removed": True}])
    assert step("status")[1] == [{"signedIn": False}]
    assert step("remove") == (0, [{"ok": True, "removed": False}])


def test_install_takes_hermes_own_auth_store_lock(home: Path, openai: dict, tmp_path: Path,
                                                   monkeypatch: pytest.MonkeyPatch):
    assert step("login")[0] == 0
    profile = tmp_path / "profile"
    profile.mkdir(mode=0o700)
    monkeypatch.setenv("HERMES_HOME", str(profile))
    from hermes_cli.auth import _auth_store_lock

    held, release = threading.Event(), threading.Event()

    def hold() -> None:
        with _auth_store_lock():
            held.set()
            release.wait(5)

    holder = threading.Thread(target=hold)
    holder.start()
    held.wait(5)
    try:
        with pytest.raises(codex_auth.StepError) as busy, codex_auth.auth_store_lock(profile, wait_s=0.2):
            pass
        assert busy.value.code == "busy"
    finally:
        release.set()
        holder.join(5)
    assert codex_auth.install(home, profile) == {"ok": True}


def test_install_refuses_without_a_staged_login(home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    profile = tmp_path / "profile"
    profile.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(profile))
    status, [answer] = step("install", json.dumps({"from": str(home)}))
    assert status == 1 and answer["code"] == "not_found"
    assert step("install", json.dumps({"from": "relative"}))[1][0]["code"] == "invalid"


def test_an_access_token_becomes_hermes_own_codex_credential(home: Path):
    token = jwt({"exp": 4_102_444_800, "sub": "agent-1"})
    out = io.StringIO()
    assert codex_auth.main(["token"], stdin=io.StringIO(f"{token}\n"), stdout=out) == 0
    assert token not in out.getvalue()
    assert json.loads(out.getvalue()) == {"ok": True}
    assert step("status")[1] == [{"signedIn": True}]
    from hermes_cli.auth import resolve_codex_runtime_credentials

    assert resolve_codex_runtime_credentials(read_only=True)["base_url"].startswith("https://chatgpt.com/")
    assert step("token", "not a token")[1][0]["code"] == "invalid"


def test_usage_reads_hermes_own_usage_answer(home: Path, openai: dict, monkeypatch: pytest.MonkeyPatch):
    assert step("login")[0] == 0
    import agent.account_usage as account_usage

    raw = {"plan_type": "plus", "rate_limit": {
        "allowed": True, "limit_reached": False,
        "primary_window": {"used_percent": 12, "limit_window_seconds": 18_000, "reset_at": 1_793_000_000},
        "secondary_window": {"used_percent": 40.5, "limit_window_seconds": 604_800, "reset_at": "2026-10-30T10:00:00Z"},
    }}
    monkeypatch.setattr(account_usage, "_fetch_codex_account_usage",
                        lambda *a, **k: account_usage.AccountUsageSnapshot(
                            provider="openai-codex", source="usage_api", fetched_at=account_usage._utc_now(), raw=raw))
    status, [answer] = step("usage")
    assert status == 0
    assert answer["plan"] == "plus" and answer["limited"] is False
    assert [w["windowMinutes"] for w in answer["windows"]] == [300, 10_080]
    assert answer["windows"][0]["usedPercent"] == 12.0
    assert answer["windows"][1]["resetsAt"] == "2026-10-30T10:00:00Z"


def test_usage_without_a_login_says_so(home: Path):
    status, [answer] = step("usage")
    assert status == 1 and answer["code"] == "not_signed_in"


def test_usage_from_a_limit_reached():
    answer = codex_auth.usage_from({"rate_limit": {"limit_reached": True, "primary_window": {"used_percent": 100}}})
    assert answer["limited"] is True and answer["plan"] is None
    assert answer["windows"] == [{"usedPercent": 100.0, "windowMinutes": None, "resetsAt": None}]


def test_models_come_from_hermes_catalog_without_a_sign_in(home: Path):
    status, [answer] = step("models")
    assert status == 0
    models = answer["models"]
    ids = [m["id"] for m in models]
    assert ids and len(ids) == len(set(ids))
    assert not any(i.endswith("-900k") for i in ids)
    assert sum(1 for m in models if m["isDefault"]) == 1
    assert all("high" in m["efforts"] for m in models)
    assert any(m["fast"] for m in models)
    assert not os.path.exists(home / "auth.json")


# --- lending the person's access token (Whombat one-person.md OP-S89) ----------------------------------------------


@pytest.fixture
def lent(home: Path, openai: dict, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The person's profile signed in (Hermes's device login, OpenAI standing in) and an outsiders' profile apart from
    it, as the outsiders' sandbox sees it (no global root to fall back to). Refreshes are recorded, never sent."""
    from hermes_cli import auth

    person = tmp_path / "person"
    person.mkdir(mode=0o700)
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    monkeypatch.setenv("HERMES_HOME", str(person))
    refreshes: list[str] = []
    fresh = jwt({"exp": 4_102_444_800, "sub": "user-1", "n": 2,
                 "https://api.openai.com/auth": {"chatgpt_account_id": "acct-1"}})

    def refresh(access_token, refresh_token, *, timeout_seconds=20.0):
        refreshes.append(refresh_token)
        return {"access_token": fresh, "refresh_token": "rt-rotated", "last_refresh": "2026-10-25T12:00:00Z"}

    monkeypatch.setattr(auth, "refresh_codex_oauth_pure", refresh)
    return {"person": person, "outside": outside, "refreshes": refreshes, "fresh": fresh}


def lend(to: Path, seconds: int = 600) -> tuple[int, list[dict]]:
    return step("lend", json.dumps({"to": str(to), "minSeconds": seconds}))


def store(path: Path) -> dict:
    return json.loads((path / "auth.json").read_text())


def test_lend_hands_the_outsiders_profile_the_access_token_alone(lent: dict, monkeypatch: pytest.MonkeyPatch):
    person, outside = lent["person"], lent["outside"]
    assert step("login")[0] == 0
    out = io.StringIO()
    assert codex_auth.main(["lend"], stdin=io.StringIO(json.dumps({"to": str(outside), "minSeconds": 600})),
                           stdout=out) == 0
    assert json.loads(out.getvalue()) == {"ok": True, "expiresAt": "2100-01-01T00:00:00Z"}
    assert ACCESS not in out.getvalue()
    text = (outside / "auth.json").read_text()
    assert ACCESS in text and REFRESH not in text
    assert oct((outside / "auth.json").stat().st_mode & 0o777) == "0o600"
    lent_store = store(outside)
    assert "providers" not in lent_store
    [entry] = lent_store["credential_pool"]["openai-codex"]
    assert entry["auth_type"] == "api_key" and not entry.get("refresh_token")
    # Nothing to refresh: the person's own store wasn't touched, and nobody asked OpenAI.
    assert lent["refreshes"] == []
    assert store(person)["providers"]["openai-codex"]["tokens"]["refresh_token"] == REFRESH

    # Hermes in the outsiders' profile runs on it, and can't refresh it however hard it is asked.
    from hermes_cli.auth import AuthError, resolve_codex_runtime_credentials

    monkeypatch.setenv("HERMES_HOME", str(outside))
    creds = resolve_codex_runtime_credentials()
    assert creds["api_key"] == ACCESS and creds["source"] == "credential_pool"
    with pytest.raises(AuthError):
        resolve_codex_runtime_credentials(force_refresh=True)
    assert lent["refreshes"] == [] and REFRESH not in (outside / "auth.json").read_text()

    # Lent again: the whole store is the new one, one entry.
    monkeypatch.setenv("HERMES_HOME", str(person))
    assert lend(outside)[0] == 0
    assert len(store(outside)["credential_pool"]["openai-codex"]) == 1


def test_lend_refreshes_in_the_person_store_first_when_the_token_runs_out_soon(lent: dict, openai: dict,
                                                                              monkeypatch: pytest.MonkeyPatch):
    import time

    from hermes_cli import auth_codex

    soon = jwt({"exp": int(time.time()) + 300, "sub": "user-1",
                "https://api.openai.com/auth": {"chatgpt_account_id": "acct-1"}})
    monkeypatch.setattr(auth_codex, "_codex_exchange_authorization_code",
                        lambda *_a: {"access_token": soon, "refresh_token": REFRESH})
    assert step("login")[0] == 0
    person, outside = lent["person"], lent["outside"]
    assert lend(outside, 600) == (0, [{"ok": True, "expiresAt": "2100-01-01T00:00:00Z"}])
    # Hermes refreshed once, in the person's store, which now holds the rotated pair.
    assert lent["refreshes"] == [REFRESH]
    tokens = store(person)["providers"]["openai-codex"]["tokens"]
    assert tokens["access_token"] == lent["fresh"] and tokens["refresh_token"] == "rt-rotated"
    # The outsiders get the fresh access token and no refresh token, old or new.
    text = (outside / "auth.json").read_text()
    assert lent["fresh"] in text and "rt-rotated" not in text and REFRESH not in text


def test_lend_says_why_it_can_not(lent: dict, monkeypatch: pytest.MonkeyPatch):
    import time

    from hermes_cli import auth, auth_codex
    from hermes_cli.auth_constants import AuthError

    person, outside = lent["person"], lent["outside"]
    # Nobody signed in.
    assert lend(outside)[1][0]["code"] == "not_signed_in"
    assert not (outside / "auth.json").exists()
    soon = jwt({"exp": int(time.time()) + 300, "sub": "user-1"})
    monkeypatch.setattr(auth_codex, "_codex_exchange_authorization_code",
                        lambda *_a: {"access_token": soon, "refresh_token": REFRESH})
    assert step("login")[0] == 0
    # Never into the person's own profile, nor a path that isn't a folder.
    assert lend(person)[1][0]["code"] == "invalid"
    assert lend(outside / "missing")[1][0]["code"] == "invalid"
    assert step("lend", "{}")[1][0]["code"] == "invalid"

    # OpenAI refuses the refresh: the person has to sign in again, and nothing is lent.
    def refused(*_a, **_k):
        raise AuthError("refresh_token_reused", provider="openai-codex", code="refresh_token_reused",
                        relogin_required=True)

    monkeypatch.setattr(auth, "refresh_codex_oauth_pure", refused)
    status, answers = lend(outside, 600)
    assert status == 1 and answers[0]["code"] == "not_signed_in"
    assert not (outside / "auth.json").exists()
