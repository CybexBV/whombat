# Provider subscriptions in the apps (AP-52…)

Workstream `subscriptions`: the web and phone side of provider subscriptions — people sign in to Claude Code and Codex
with their own subscription or an API key, on managed appliances and self-hosted installs. The settled decisions are
`SUB-01…SUB-11` (`Whombat/docs/decisions/provider-subscriptions.md`, don't reopen) and the contracts `CT-68…CT-75`
(`whombat-contracts/docs/decisions/contracts.md`, contracts 0.9.0). Numbers continue `app-managed.md` (AP-51 is the
last there).

## AP-52 Contracts 0.9.0

Vendored as usual (AP-02). `@whombat/client/react` gains the read hooks of the new endpoints (`useSignIns`,
`useSignInLogin`, `useOrgCredentials`, `useClients`, and `useSignInConsoleRead`, which only exists because every read
endpoint has a hook: the console reads through its own loop, see AP-55).

## AP-53 One code path: `signins.*` / `clients.*` through the typed client

Every new screen calls the REST-shaped endpoints (`api.signins`, `api.clients`, CT-70, CT-72) through `WhombatClient`,
so the same component works over REST (self-hosted) and the session (managed, CT-06). The session-native
`providers.*` wrappers in `sessionOps` stay for older callers but nothing new uses them.

- **App error codes on both transports.** REST puts the app code in `error.details.code` (`error.code` is a core
  `ErrorCode`); the session lifts it into `error.code`, which the typed client can't parse, so `ApiError.code` is
  `unknown` there. `appErrorOf` (`@whombat/client/signins`) reads the raw body and returns the app code, the message
  and the details the same way for both. `isRetryable` says when sending the same thing again is right (network,
  lost or redacted-but-not-rejected answers, 408/425/429/5xx, `unavailable`/`rate_limited`/`unknown_outcome`).
- **A server without them.** A self-hosted server before contracts 0.9 answers 404: onboarding then shows the host's
  AI provider panel as before (`host.agents`), and Settings → AI accounts says the Whombat runs the clients from its
  own machine (`notServed`).

## AP-54 Onboarding: four steps, “Set up your AI”

Per SUB-08 / CT-68. Copy is `ONBOARDING_STEPS` from the fixtures, verbatim (a test compares the web's copy with it).
No mock exists for the new step; it is built from the step's own patterns:

- **Superseded in part by AP-5615 (chatgpt-no-client.md)**: the second card is “ChatGPT”, and its card is its sign-in alone. Two choice cards (Claude Code, Codex) in the agent cards' language (1.5px border, 16px radius, the check badge,
  selected = ink border), compact and left-aligned, each with who makes it and which plans or keys work (no logos,
  SUB-06). Either or both; the choice is saved as `OnboardingState.clients` with each progress save.
- **Superseded in part by AP-5615 (chatgpt-no-client.md)**: only Claude Code installs on choose; ChatGPT needs nothing installed. **Choosing is wanting it:** when an owner who may manage clients (`clients.list.canManage`) picks a client that isn't
  installed, the step calls `clients.install` at once (idempotent). Others see “Ask your Whombat admin to install it”.
  Unchoosing doesn't remove anything (removing is in Settings).
- Per chosen client, one bordered card (the repo/invite card rows): the install state (not installed / installing
  with the run card's 6px progress bar / installed version / failed with the reason and “Try again”), then the
  sign-in row: “Sign in with your subscription” (primary), “Use your own API key”, and for owners who can manage
  organization keys (`signins.orgList` answers) “Add an organization API key”. The subscription sign-in runs the CLI,
  so it waits until the client is installed and says so; keys don't wait.
- Under the cards, one line: “Agents work on the account of whoever asks them.”
- “YOUR FIRST AGENTS USE” stays: a segmented control of the chosen clients, enabled only for those installed and
  signed in (the person's own ready sign-in, or a ready organization key). Until the owner picks, it follows the first
  usable client and saves that as `provider`, so `onboarding.complete` sends what the step showed.
- Resume: `?step=` and the stored step are clamped to 0–3 (the server maps older stored steps, CT-68). The GitHub
  step, its queries and styles are gone; GitHub stays in Settings → Software Dev.

## AP-55 The Claude sign-in console

`SignInConsole` (web) drives `createConsoleDriver` (`@whombat/client/signins`, transport-neutral and unit-tested):

- Start, or pick up a console of this person that still runs (from `signins.list.consoles`; a reloaded page opens it
  again by itself). Read with a long poll (`waitMs` 25 s, session `deadlineMs` 35 s) from the last `next`; output the
  server no longer keeps comes back from a later `from` and is simply shown. Stop once the console isn't `running`
  and `more` is false.
- Writes go one at a time, numbered from the console's `inputSeq` + 1, at most 4 KiB of UTF-8 each (a large paste is
  split without breaking a surrogate pair). A lost answer resends the same `seq` (the server applies it once); a
  redacted outcome that says `completed` counts as applied; `provider.console_input_gap` renumbers from the reported
  `inputSeq`; `provider.console_ended` drops what's left.
- The terminal's size follows its box (fit addon + `ResizeObserver`), clamped to the contract, sent only on change.
  Closing the panel (Cancel, unmount) cancels a console that still runs. States: running (“Waiting for you to finish
  signing in…”), completed (“Signed in”, the sign-in lists refetch), failed (the server's reason), expired, cancelled,
  each with “Try again” (a new console) and Close. Above it, one line: “This is Claude Code’s own sign-in. Open the
  link it shows, approve, and paste the code back here.” A Paste button reads the clipboard for browsers where the
  terminal's own paste is awkward; Ctrl/⌘+V works in the terminal.
- **Never kept:** output and keystrokes go only to the terminal — no logging, no query cache (the loop calls the
  client directly), no storage.
- **xterm**, lazy-loaded (`import('./terminal')`), themed from the tokens' CSS variables (the code surface, the
  README's code-block colors, status and role colors for the ANSI palette), re-themed when `data-theme` changes, after
  the mono web font loaded (xterm measures once).
- **Under the hosted CSP** (`style-src 'self'`, AP-23) xterm's `<style>` elements and truecolor `style` attributes
  would be refused. xterm gets a `documentOverride` whose `<style>` is an inert hidden element (its text goes into a
  constructable stylesheet, `adoptedStyleSheets`) and whose elements take `setAttribute('style')` through the CSSOM
  (`style.cssText`); neither is restricted by CSP. xterm 6.0.0 ignores `documentOverride` for its main document
  (operator precedence) and its DOM row factory (the global `document`), so both are fixed with a pnpm patch
  (`patches/@xterm__xterm@6.0.0.patch`). The hosted e2e signs in through the console with zero violations.

## AP-56 Codex's device code

`signins.loginStart {codex, chatgpt}` → the link (a real link, new tab) and the code in DM Mono on the chip surface
with “Copy code” and a `m:ss` countdown, the hint that device code login must be turned on in ChatGPT's security
settings (or by the workspace admin), and “Waiting for you to finish signing in…”. The attempt is polled every 3 s
(`signins.loginStatus`) from component state only (the code is a `secret` op's answer); expired or failed offers “Get
a new code”; Cancel cancels the attempt.

## AP-57 Settings → AI accounts (`?tab=ai`)

A settings tab for everyone (also in the account menu next to “Connected accounts”), the same on self-hosted and
managed Whombats: YOUR AI SIGN-INS (each client's state — ready, not signed in, expired, out of quota… — with the
console, device code, own key and Sign out), ORGANIZATION KEYS (owners/admins only: shown when `signins.orgList`
answers; add per client, remove with a confirm), and AI CLIENTS (installed version, latest tested, “Updates itself to
each version Whombat has tested.”, install/remove for admins; no update button). The managed-only sign-ins section of
“This Whombat” moved here; that tab keeps the appliance's provider states. The phone's “Sign in on the web” opens this
page.

## AP-58 “Whoever asks” in RUNS ON

The agent profile's RUNS ON (the place a team agent's credential source is configured; hiring takes no source, the
server gives new team agents `DEFAULT_TEAM_CREDENTIAL_SOURCE`) offers “Whoever asks (their own sign-in)” next to the
organization keys and the owner's own sign-in. With it chosen, a “WORK NOBODY ASKED FOR” group picks the fallback:
“Doesn’t run” or an organization key of the agent's provider. The section shows wherever people sign in themselves:
managed, or a server that serves `signins.*`. Keys and lists go through `signins.*`.

**Refusals.** Turn refusals reach the web only as the agent's words in the conversation (the runner's `refusal`,
no structured code), so the app can't attach an action to that message. Instead the wording of
`provider.requester_not_signed_in` (and `provider.no_requester`, `provider.not_signed_in`, `client.not_installed`) is
`REFUSAL_TEXT`, shown before the person hits it: in RUNS ON when the source is “Whoever asks” and they aren't signed in
to the agent's provider, and on a managed Whombat as the quiet line above the screen while they have no ready sign-in
for any installed client — both with a “Sign in” link to AI accounts. Raised with the orchestrator: if a refusal
message carried its code (e.g. a pill card), the app could put the Sign in action on it.

## AP-59 The phone (SUB-11)

**Superseded in part by AP-5618 (chatgpt-no-client.md)**: ChatGPT's state shows whether or not a client is listed. This Whombat (managed) and
the settings sheet (self-hosted server) show a YOUR AI SIGN-INS card: each installed
client's state and “Sign in on the web” (44dp, opens Settings → AI accounts of the burrow: the appliance link under the
hosted UI's origin, or the server's own URL). No console, no key entry, no device code on the phone.

## AP-60 The fake AI side

**Superseded in part by AP-5619 (chatgpt-no-client.md)**: the fake lists and installs Claude Code only and refuses an install for ChatGPT.
`apps/web/src/managed/fake/ai.ts` fakes `signins.*` and `clients.*` for the fixture transport (tests, Storybook,
`VITE_FIXTURES=1`) and the fake managed world (which answers the `providers.*` twins from the same state and keeps
sign-ins, keys and installs across a reload). Default: Claude Code installed, Codex not, nobody signed in, Mara may
install and add organization keys. Installs take a few seconds with progress (or fail, `failInstall`); the Codex device
code completes on the third poll; keys with `bad`/`wrong` are refused. The console plays `claude auth login`: a
truecolor welcome, a sign-in link, “Paste code here if prompted >”, echo and backspace; 6+ characters and Enter sign
in, `wrong` fails, Ctrl+C stops; `seq` and gap rules as the contract says; `expireConsole()` ends it.

## AP-61 The sign-in console makes the hidden code visible as a count

Claude Code (2.1.283) echoes nothing at its “Paste code here if prompted >” prompt, and only acts on Enter, so a
pasted code looked lost (maintainer, dev.whombat.com, 2026-09-26). The console now says so in its explanation, the
footer counts what was typed since the last Enter (“Code entered (n characters) · press Enter”, counts only — never
the characters) and then “Code sent · checking with Claude…”, and “Paste code” types the trimmed clipboard text
followed by Enter. The fake world's console no longer echoes either.

## AP-62 Guided sign-in in front of the CLIs' own flows

A terminal with a wall of URL text, a prompt that shows nothing and a shortcut to know was too hard for an end user
(maintainer, dev.whombat.com, 2026-09-26). Both subscription sign-ins now show numbered steps (onboarding's step dots
at 22px: sf2 and a mono number, the current step in the primary button's colors, done = ok with ✓), a `role="status"`
line with a status dot (no spinner), and one line under the steps on whose flow it is. The data path doesn't change
(SUB-03). Refines AP-55, AP-56 and AP-61.

- **Claude.** The same console driver (AP-55) underneath. `@whombat/client/signins` reads Claude Code's output as it
  arrives (`createSignInOutputWatcher`, pure, bounded, in memory only): the sign-in link from the OSC 8 hyperlink
  target (2.1.283 prints `ESC ] 8 ; ; URL BEL` around a bright-blue copy of it, recorded from the real binary), else
  the escape-stripped text after “visit:”, a link wrapped over lines joined, and only once its line has ended; “Login
  failed”; how often it asked for the code. Only `https:` links on `claude.ai`, `claude.com`, `platform.claude.com`,
  `console.anthropic.com` get the step 1 button (“Open claude.ai to sign in”, a real link to a new tab); another link
  gets no button and the output opens instead. Until the link appears: “Starting Claude Code’s sign-in…”.
- **Step 2** is one field (“Paste the code from claude.ai”, `autocomplete=off`, `spellcheck=false`, password-manager
  opt-outs, DM Mono), “Paste” (reads the clipboard on click, into the field only) and “Sign in”, which types the trimmed
  code followed by `\r` through the driver — the keystrokes the terminal would send — then clears and disables the
  form. Opening the link moves the focus to the field; coming back to the tab (`focus` / `visibilitychange`) focuses it
  too and, **only** when `navigator.permissions.query({name: 'clipboard-read'})` is already `granted` and the clipboard
  holds something code-shaped (no whitespace inside, 20–512 characters), fills it in. Never auto-submitted; the code
  lives in component state only and is never logged.
- **Step 3.** “Checking with Claude…” after a code was sent (from the field, or typed into the terminal and Enter). If
  Claude Code asks for the code again without exiting, the form comes back. Success: the row's sign-in list refetches
  and the panel folds into “Signed in with your Claude subscription” (onboarding's card shows the same, and its client
  becomes usable for the first agents). A refused code (console `failed` after a code, or “Login failed” in the output):
  “That code didn’t work. Codes work once and expire after a few minutes.” with a primary “Get a new link” that starts
  a new console in one click (the focus lands on it); expired and stopped consoles say so and offer the same; a start
  that failed before any link says the server's reason with “Try again”.
- **“Show Claude Code’s output”** is a disclosure (`aria-expanded`, collapsed by default) with the unchanged xterm
  terminal (AP-55), typing into it still works and its hidden input is still counted (“Code entered (n characters) ·
  press Enter”). Collapsed, the terminal stays laid out (no height, `visibility: hidden`, `inert`), so xterm measures its
  cells and the fit follows its box; it doesn't take the focus on mount any more.
- **Codex** gets the same structure: step 1 “Open auth.openai.com” (the host of `verificationUri`, only `https:` on
  `openai.com` / `chatgpt.com` and their subdomains; otherwise the page is shown as text without a button) with the
  page's address for another device, step 2 “Enter this code” (the code large, “Copy code”, the countdown, the device
  code hint), then waiting, success folding into the row, or “Get a new code”.
- `ButtonLink` (`components/Button`): links that look like buttons keep their button colors over the global link hover.
- The fake world's console prints what Claude Code 2.1.283 prints (“Opening browser to sign in…”, the OSC 8 link on
  `claude.com`, the silent prompt, a truecolor “Login failed: Request failed with status code 400” and exit 1 for
  `wrong`), so the hosted e2e still renders truecolor cells under its CSP.

## A shared own sign-in, and whose sign-in unasked work runs on (2026-09-30, AP-420…AP-426)

John, 2026-09-30 (Whombat SUB-57, SUB-58; contracts CT-159): an owner may share their own Claude or Codex sign-in with
everyone as an override the app marks as against the providers' terms, and website feedback runs on the sign-in of the
owner who set the integration up.

## AP-420 Contracts 0.24.0

Vendored as usual (AP-02), its own commit. `CredentialSource`'s `account` member gains `shared: true`; the client names
the new runtime feature `signins.shared` (“a shared sign-in”, `FEATURE_NAMES`).

## AP-421 Automations and website feedback aren't “work nobody asked for” any more

RUNS ON's “Whoever asks” note without a fallback said automations and website feedback don't run without an
organization key. Automations run on the publisher's sign-in (SUB-27) and website feedback now on the sign-in of the
owner who set the integration up (SUB-58), so it says: “Automations run on the sign-in of the person who published them,
and website feedback on the sign-in of the owner who set it up. Other work nobody asked for needs an organization key.”
The organization key's help (Settings → AI accounts, onboarding) said the same thing; it now reads “For team agents
everyone can ask, and for work nobody asked for. Billed to your organization.” — the allowed way to share. The
feedback integration's ASSESSMENT AGENT hint adds “When it runs on “Whoever asks”, it assesses on the sign-in of the
owner who set up this integration.” Nothing else on the feedback pages spoke of keys. The fallback group (“WORK NOBODY
ASKED FOR”, “Doesn’t run”, “Work nobody asked for runs on the organization key “…”.”) stays true and stays as it was.
Spend's “Work nobody asked for: schedules and automations.” is about whom spend is counted for, not whose sign-in
pays, and isn't touched here.

## AP-422 The override: offered where “My own … sign-in” is, set apart, only on runtimes that have it

- **Where.** In RUNS ON's choices (the profile pane and Configure → Model & provider, one component), exactly where “My
  own Claude sign-in (only I can ask it then)” is offered — the viewer's own sign-in for the agent's provider is ready and
  their account is known — and only when the runtime advertises `signins.shared` (`useFeature`). An older runtime would
  drop the flag and keep the sign-in personal (CT-159), so the app doesn't offer what wouldn't happen.
- **Set apart.** Last among the choices, after “Add an organization key” and before Cancel, in its own `fieldset`
  with the legend “OVERRIDE” in the warning tone (`SectionLabel tone="warn"`) and a 2 px `--warn` left rule — the
  fallback group's shape in the warning colour. Under the button the warning in `--ink2` at 12.5 px: “Override:
  everyone’s requests to this agent run on your own Claude subscription. Anthropic’s terms don’t allow sharing a
  subscription with other people, and Anthropic may limit or close your account. An organization API key is the allowed
  way to share.” (Codex: “… your own ChatGPT sign-in. OpenAI’s terms don’t allow sharing a ChatGPT sign-in …”). The
  button (“My own Claude sign-in for everyone (override)”) names it with `aria-describedby`; its label wraps in the
  narrow profile pane rather than running past it.
- **What it sends.** `agents.setCredentialSource` with `{kind: 'account', accountId: <me>, shared: true}`; “My own …
  sign-in” keeps sending `{kind: 'account', accountId}` without the flag. `aria-pressed` tells them apart (the shared one
  is pressed only with `shared: true`, the personal one only without).

## AP-423 A shared sign-in's state

RUNS ON reads “Mara Okafor’s own Claude sign-in · shared with everyone” and, in the warning tone (text on the pane and
page backgrounds only, as the token contrast rules allow), “Everyone in the burrow can ask this agent, and every
request runs on Mara Okafor’s own Claude subscription. This override is against Anthropic’s terms: Anthropic may limit
or close that account.” Vendors by provider id (`PROVIDER_TERMS`: claude → Anthropic, codex → OpenAI; any other says
“the provider”). The copy lives in `@whombat/client/signins` (`SOURCE_TEXT.shared*`) so the phone can use it. The
warning is the same whether the person's own sign-in is a subscription or their own API key: the app doesn't know which
kind the runtime will use at turn time, and a subscription is the case the terms are about.

## AP-424 “Whoever asks” stays the default and the first choice

The runtime creates team agents on “Whoever asks” (`DEFAULT_TEAM_CREDENTIAL_SOURCE`); RUNS ON lists it first and the
override last. It gets no “(default)” marker: the current state line already says what the agent runs on.

## AP-425 The phone

The phone doesn't show an agent's credential source (its RUNS ON is the provider, `runsOnModel`), so there is nothing
to show wrong; the shared words are in the client package for when it does.

## AP-426 whombat-app 0.14.0

The shared own sign-in and the new words for unasked work (AP-420…AP-425), on contracts 0.24.0.
