"""Hermes's post-answer review leaves a marker while it runs (HN-08): written when Hermes builds the review — before the
answer goes back — and removed when the review thread ends, however it ends; through Hermes's own spawn path."""

from __future__ import annotations

import threading
import types
from pathlib import Path

import pytest

from whombat_hermes import review

from .conftest import needs_hermes


@pytest.fixture
def profile(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


def markers(profile: Path) -> list[str]:
    folder = profile / review.REVIEW_DIR
    return sorted(p.name for p in folder.iterdir()) if folder.exists() else []


def test_the_marker_is_there_from_the_spawn_until_the_review_ends(profile: Path):
    ran = threading.Event()
    spawn = review.signalled(lambda agent, messages: (ran.set, "prompt"))
    target, prompt = spawn(object(), [])
    assert prompt == "prompt"
    assert len(markers(profile)) == 1
    target()
    assert ran.is_set()
    assert markers(profile) == []


def test_a_review_that_fails_still_removes_its_marker(profile: Path):
    def boom() -> None:
        raise RuntimeError("review failed")

    target, _ = review.signalled(lambda *a, **k: (boom, "p"))()
    with pytest.raises(RuntimeError):
        target()
    assert markers(profile) == []


def test_wrapping_twice_wraps_once(profile: Path):
    spawn = review.signalled(lambda *a, **k: (lambda: None, "p"))
    assert review.signalled(spawn) is spawn


@needs_hermes
def test_through_hermes_spawn_path(profile: Path, monkeypatch: pytest.MonkeyPatch):
    import agent.background_review as background_review
    import run_agent

    monkeypatch.setattr(background_review, "spawn_background_review_thread",
                        background_review.spawn_background_review_thread)
    release, started = threading.Event(), threading.Event()

    def fake_review(agent, messages_snapshot, prompt, **_kwargs):
        started.set()
        release.wait(5)

    monkeypatch.setattr(background_review, "_run_review_in_thread", fake_review)
    review.install()
    # Hermes asks this after the review's target returned: the marker is gone by then.
    done = threading.Event()
    agent = types.SimpleNamespace(_maybe_requeue_preempted_review=lambda *a, **k: done.set())
    run_agent.AIAgent._spawn_background_review_now(agent, [{"role": "user", "content": "hi"}], review_memory=True)
    # Synchronously: the marker is there when the spawn returns, before the turn's answer would go out.
    assert len(markers(profile)) == 1
    assert started.wait(5)
    assert len(markers(profile)) == 1
    release.set()
    assert done.wait(5)
    assert markers(profile) == []


def test_a_turn_whose_policy_says_no_review_gets_none(profile: Path, monkeypatch: pytest.MonkeyPatch):
    """A Looks ahead check (Whombat looks-ahead.md): its policy's ``review: false`` makes the review do nothing."""
    from whombat_hermes import policy

    (profile / policy.POLICY_FILE).write_text('{"default": "block", "rules": [], "review": false}', encoding="utf-8")
    monkeypatch.setattr(policy, "_policy_file", policy.PolicyFile())
    ran = threading.Event()
    target, prompt = review.signalled(lambda *a, **k: (ran.set, "p"))()
    assert prompt == "p"
    assert markers(profile) == []
    target()
    assert not ran.is_set()


def test_review_must_be_true_or_false():
    from whombat_hermes import policy

    with pytest.raises(policy.PolicyError):
        policy.parse_policy({"rules": [], "review": "no"})
    assert policy.parse_policy({"rules": []}).review is True
