# The agent's web browser

The agent browses with Hermes's browser tools: it opens pages, reads them, clicks, types, scrolls and takes screenshots
in a headless Chromium that runs where its commands run. So it reaches what its commands reach — the internet, your
home networks when the agent may reach your local network — and the pages its own commands serve on that machine. How
it is built: `ARCHITECTURE.md`, “Commands, the sandbox and the browser”; decisions: `docs/decisions/hermes-engine.md`
(HE-42, HE-S137…HE-S146) and `docs/decisions/browser.md`.

## Giving the agent the browser

The browser is the key **Use a web browser** (`browser.use`) in What {assistant} may do, at Just watch, Ask me first or
Go ahead like any other key; it brings Browse the web with it. Chromium starts the first time the agent browses and
stays while the agent's sandbox runs, with a fresh profile that goes with it. A machine without Chromium (a development
host that has none) gives the agent no browser.

## Signing in with the Vault

Logins in your Vault that you switched on for the agent can be used in your turns: the agent sees the site and the
username, opens the sign-in page, types the username and asks Hermes to fill the password. The password never reaches
the agent or the chat. When the agent reaches a sign-in page it has no login for, or a page asking for a code, it asks
you on a card in the thread and waits for your answer. Turns that outsiders start (website feedback, the tracker customers,
mail) never get your logins.

## Previews

`browser_preview` shows what the agent built: it opens a built folder as a website of its own (offline unless the agent
may browse) and posts a 1280×800 screenshot in the thread. `page_preview` draws an HTML page the way a message shows it,
for the agent only, and `show_pages` turns a folder into a page set you can open.

## Feedback assessments

When the agent assesses website feedback with Use a web browser at Go ahead, it looks only at the reported website:
other sites don't load, it can open, read, click, scroll and go back, but not type, hand a page a file, run scripts or answer dialogs, and it never
signs in. See `docs/feedback.md`.
