"""Web search on the person's Brave Search key (Whombat docs/decisions/web-search.md).

Hermes's own Brave backend (``plugins/web/brave_free``) reads its key from the environment or the profile's ``.env``:
Hermes would then hold it in its process environment for its whole life, and a pod's Hermes would keep a removed or
replaced key until it restarts. So this is Hermes's Brave backend with one change: the key comes from
``$HERMES_HOME/whombat-web-search.key``, which the runner writes before each of the person's turns that may search and
removes otherwise, read at every check and every search. The config names this provider (``web.search_backend``) only
while that file is written; without the file it isn't available and Hermes doesn't offer ``web_search``.

Search only: ``web_extract`` has no backend here, and Whombat's policy tells the agent to read pages with the browser.
"""

from __future__ import annotations

import logging
from typing import Any

from .settings import hermes_home

logger = logging.getLogger(__name__)

PROVIDER_NAME = "whombat-brave"
KEY_FILE = "whombat-web-search.key"
_KEY_MAX = 200


def search_key() -> str:
    """The key the runner wrote for this turn; empty without one."""
    try:
        text = (hermes_home() / KEY_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    return text if 0 < len(text) <= _KEY_MAX and text.isprintable() and " " not in text else ""


def make_provider() -> Any:
    from plugins.web._common import http_get_json, search_fail, search_ok, titled_rows
    from plugins.web.brave_free import provider as brave

    class WhombatBraveProvider(brave.BraveFreeWebSearchProvider):
        """Hermes's Brave Search backend on the key Whombat gives the turn."""

        NAME = PROVIDER_NAME
        DISPLAY_NAME = "Brave Search"
        KEY_ENV = ""

        def is_available(self) -> bool:
            return bool(search_key())

        def search(self, query: str, limit: int = 5) -> dict[str, Any]:
            api_key = search_key()
            if not api_key:
                return search_fail("Web search isn’t set up on this Whombat.")
            data, failure = http_get_json(
                "Brave Search", brave._BRAVE_ENDPOINT,
                params={"q": query, "count": max(1, min(int(limit), 20))},  # Brave caps count at 20
                headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
                timeout=15, logger=logger,
            )
            if failure is not None:
                return failure
            raw_results = (data.get("web") or {}).get("results", []) or []
            return search_ok(titled_rows(raw_results[:limit], "description"))

        def get_setup_schema(self) -> dict[str, Any]:
            return {"name": "Brave Search", "badge": "", "tag": "Set up in Whombat's settings.", "env_vars": []}

    return WhombatBraveProvider()


def register(ctx: Any) -> None:
    ctx.register_web_search_provider(make_provider())
