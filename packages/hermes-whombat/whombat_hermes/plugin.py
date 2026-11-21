"""The general plugin (entry point ``whombat``): what Whombat adds to Hermes.

- the ``whombat_commands`` terminal backend: Hermes's own tools on this Whombat, each command in a wrapper of its own
  (one-person.md OP-07);
- the ``pre_tool_call`` hooks: ``~`` in a file tool's path as the commands' home (``paths.py``), and Whombat's tool
  policy over every tool call, failing closed (HE-17);
- the ``whombat`` system-prompt section from ``$HERMES_HOME/whombat.md`` (HE-11) and ``whombat-notes`` from
  ``whombat-notes.md``, the person's notes (HE-39);
- Whombat's logins as a Hermes login backend (``logins.py``, HE-42, HE-S141, HE-S302), and Hermes's save-login and code
  prompts asking the person on a card through the runner (HE-S303…HE-S306);
- web search on the person's Brave Search key (``web_search.py``, docs/decisions/web-search.md);
- the browser's tools on Whombat's Chromium (``browser.py``, HE-S300), in place of Hermes's ``browser_exec``;
- ``hermes whombat-skills <op>``: Hermes's own skills code on the person's skills folder, run by the runner in its
  skills home (``hermes_skills.py``, HSK-03);
- the ``whombat:settings`` skill: where Whombat's settings are and how to change them for the person with the settings
  tools (``skills/settings``, written from the runtime's settings map; docs/decisions/assistant-settings.md);
- the ``whombat:council`` skill: how to lead a council of AI models in T3 Code (``skills/council``;
  docs/decisions/council.md);
- the ``whombat:delegate`` skill: how to hand a list of tasks to T3 Code from one checklist card (``skills/delegate``;
  docs/decisions/delegate.md);
- the ``whombat:connection-pages`` skill: a Custom connection's logo and page (``skills/connection-pages``;
  docs/decisions/connection-looks.md);
- a marker while Hermes's memory and skill review runs (``review.py``, HN-08), so the runner waits after an answer only
  when a review started.

ChatGPT's sign-in, usage and model list are steps of their own (``codex_auth.py``), not part of the plugin's start.
"""

from __future__ import annotations

import logging
from typing import Any


logger = logging.getLogger(__name__)


def register(ctx: Any) -> None:
    from .hermes_skills import run_cli, setup_cli
    from .paths import pre_tool_call as home_paths
    from .policy import pre_tool_call
    from .prompt import MAX_CHARS, NOTES_SECTION_ID, SECTION_ID, notes_section, whombat_section
    from .terminal import make_provider

    ctx.register_hook("pre_tool_call", home_paths)
    ctx.register_hook("pre_tool_call", pre_tool_call)
    try:
        ctx.register_cli_command("whombat-skills", "Whombat's skills steps (JSON on stdin and stdout)", setup_cli,
                                 run_cli, description="Hermes's skills code on the person's skills folder.")
    except Exception:
        logger.warning("whombat: the whombat-skills command could not be registered", exc_info=True)
    ctx.register_system_prompt_section(SECTION_ID, whombat_section, max_chars=MAX_CHARS)
    ctx.register_system_prompt_section(NOTES_SECTION_ID, notes_section, max_chars=MAX_CHARS)
    try:
        ctx.register_terminal_environment_provider(make_provider())
    except Exception:
        logger.warning("whombat: the commands terminal backend could not be registered", exc_info=True)
    try:
        register_skills(ctx)
    except Exception:
        # Without it the assistant still has the settings tools, only not the map of where everything is.
        logger.warning("whombat: the settings skill could not be registered", exc_info=True)
    try:
        from .web_search import register as register_web_search

        register_web_search(ctx)
    except Exception:
        # No web search then: the config names a provider Hermes doesn't have, and `web_search` isn't offered.
        logger.warning("whombat: web search could not be registered", exc_info=True)
    try:
        from .browser import register as register_browser

        register_browser(ctx)
    except Exception:
        # No browser tools then: a turn with a browser can't browse, and says so.
        logger.warning("whombat: the browser tools could not be registered", exc_info=True)
    try:
        from .review import install as install_review_signal

        install_review_signal()
    except Exception:
        # Without it the runner can't see a review: it doesn't wait for one, and the review ends with the turn.
        logger.warning("whombat: the review signal could not be installed", exc_info=True)
    try:
        from .logins import register_backend

        register_backend(ctx)
    except Exception:
        # No Whombat logins then: a fill finds nothing of Whombat's.
        logger.warning("whombat: the logins couldn't be put in Hermes's vault", exc_info=True)
    try:
        from .logins import register_vault_tool

        register_vault_tool(ctx)  # says by itself when it can't
    except Exception:
        # Without it Hermes's browser says it can't ask for a login or a code here.
        logger.warning("whombat: browser_vault couldn't ask the person", exc_info=True)


#: The plugin's own skills: name -> the one line the skills index shows.
SKILLS = {
    "settings": "Whombat's settings: where everything is, and changing it for the person when they ask (Wi-Fi, backups,"
    " notifications, the screen, what you may do).",
    "council": "The council: several AI models of different companies on one question, each on its own in T3 Code,"
    " led there by one thread to one answer, plan or result (review, research, improve a project until they score it"
    " high), and the person's council (who sits on it, models, effort).",
    "delegate": "Handing a list of coding tasks to T3 Code from one checklist card: the person ticks them, one thread"
    " leads them in one pull request, Whombat checks and merges the work, you follow it on the card and change it when"
    " the person talks about it.",
    "connection-pages": "A logo and a page of its own for a Custom connection (an MCP server or API you set up): find"
    " its SVG logo, and build its page from what it can read with connection_look.",
}


def register_skills(ctx: Any) -> None:
    """Registers each of the plugin's skills as ``whombat:<name>`` (read-only, never copied into the skills folder)."""
    from pathlib import Path

    root = Path(__file__).resolve().parent / "skills"
    for name, description in SKILLS.items():
        ctx.register_skill(name, root / name / "SKILL.md", description=description)
