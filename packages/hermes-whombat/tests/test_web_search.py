"""Web search on the person's Brave Search key (Whombat web-search.md): the key comes from the profile's key file at
every check and search, never from the environment; without the file Hermes offers no ``web_search``."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from whombat_hermes import env, web_search

from .conftest import needs_hermes, write_config

KEY = "BSA-test-key-one"


def test_the_key_is_read_from_the_profile_file(hermes_home: Path) -> None:
    assert web_search.search_key() == ""
    (hermes_home / web_search.KEY_FILE).write_text(f"{KEY}\n", encoding="utf-8")
    assert web_search.search_key() == KEY
    (hermes_home / web_search.KEY_FILE).write_text("two words", encoding="utf-8")
    assert web_search.search_key() == ""


def test_hermes_brave_key_name_never_reaches_a_child(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", KEY)
    assert "BRAVE_SEARCH_API_KEY" in env.hermes_strip_keys()
    assert "BRAVE_SEARCH_API_KEY" not in env.command_env({"BRAVE_SEARCH_API_KEY": KEY, "PATH": "/bin"})


@needs_hermes
def test_searches_brave_with_the_file_key(hermes_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    import plugins.web._common as common

    asked: list[dict] = []

    def fake_get(label, url, *, params, headers, timeout, logger, **_):
        asked.append({"url": url, "params": params, "headers": headers})
        return {"web": {"results": [{"title": "Whombat", "url": "https://example.org/", "description": "A box."}]}}, None

    monkeypatch.setattr(common, "http_get_json", fake_get)
    provider = web_search.make_provider()
    assert provider.name == web_search.PROVIDER_NAME
    assert provider.is_available() is False
    assert provider.search("whombat")["success"] is False
    assert asked == []

    (hermes_home / web_search.KEY_FILE).write_text(KEY, encoding="utf-8")
    assert provider.is_available() is True
    assert provider.supports_extract() is False
    out = provider.search("whombat", 3)
    assert out["success"] is True
    assert out["data"]["web"][0]["url"] == "https://example.org/"
    assert asked[0]["url"].startswith("https://api.search.brave.com/")
    assert asked[0]["headers"]["X-Subscription-Token"] == KEY
    assert asked[0]["params"] == {"q": "whombat", "count": 3}

    # Removed between turns: gone at once, also in a long-lived pod.
    (hermes_home / web_search.KEY_FILE).unlink()
    assert provider.is_available() is False


@needs_hermes
def test_web_search_is_offered_only_with_the_backend_and_its_key(
    hermes_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
    from agent import web_search_registry
    from tools import web_tools

    web_tools._ensure_web_plugins_loaded()
    web_search_registry.register_provider(web_search.make_provider())

    def config(backend: str | None) -> None:
        web = {"keyless_fallback": False, **({"search_backend": backend} if backend else {})}
        write_config(hermes_home, json.dumps({"web": web}))
        try:
            from hermes_cli.config import invalidate_config_cache

            invalidate_config_cache()
        except Exception:
            pass

    config(None)
    assert web_tools.check_web_api_key() is False
    config(web_search.PROVIDER_NAME)
    assert web_tools.check_web_api_key() is False
    (hermes_home / web_search.KEY_FILE).write_text(KEY, encoding="utf-8")
    assert web_tools.check_web_api_key() is True
    assert web_tools._get_search_backend() == web_search.PROVIDER_NAME
