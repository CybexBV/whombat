# UI improvements (2026-09-29): decisions

The eight items John raised on 2026-09-29 (Whombat `docs/implementation/ui-improvements/assignment.md`). Each
workstream records its decisions under its own heading, in its own number range.

## U1

Items 1 (the agent card shows the job description), 2 (role title in the sidebar) and 4 (thread focus mode).

### AP-300 “Just hired …” reads as nothing on the client

The runtime stops writing `HIRED_DOING` (“Just hired. Reading the burrow to get up to speed.”) and migrates the rows
that hold it, but a box on an older runtime keeps sending it. Core 0.23.0's copy helpers ignore it
(`LEGACY_HIRED_DOING`, `agentWorkingText`); `@whombat/client`'s `agentActivity.ts` adds what core leaves to the app
— `agentDoing()` (`''` for blanks and the legacy line), the live-run activity that feeds `agentWorkingText`
(`agentWorkingLine()`) and the profile's RIGHT NOW (`agentRightNow()`) — so web and mobile never show it either.
Subtitles, role titles and row labels come straight from core (`agentJobText`, `agentRoleTitle`, `agentRowLabel`).

### AP-301 The card's subtitle is the job; “Working: …” only while working

- Subtitle: `agent.job`, or `ROLE_JOBS[role]` when it is blank (core `agentJobText`), in the mock's `doing` slot and style
  (14.5px, `--ink2`, min-height 42px), so a card without work looks exactly like the mock's.
- Working: a live `currentRun` (its `doing`, else the run's title), or status `working` with a real `doing`
  (`agentWorkingLine()` over core's `agentWorkingText`). Shown as a muted line under the job, 13px `--mut`, at most two lines (clamped, the full text
  in `title`): “Working: Rounding VAT before formatting on feat/invoice-pdf.” A paused run, a waiting or an idle agent
  has no line: a waiting agent's status pill already says Waiting, and a second line on a third of the cards would
  make the grid noisy.
- The job/working block takes the card's free height, so the keys footer stays aligned across a row.
- Mobile Agents tab: the body is the job, the working line a muted 13dp line under it (one line), and TalkBack reads
  “Banjo, Developer · working. Writes, refactors … Working: …”.

### AP-302 The profile's RIGHT NOW follows the same rule

The profile pane (web) and the agent screen (mobile) already show the job under the name (now through core
`agentJobText`). RIGHT NOW keeps its place and says (`agentRightNow()`): what the agent works on while it works; what a waiting agent
waits for (its `doing` — the pane's role line says Waiting, and the reason is the useful part); otherwise “Nothing right
now.” (mobile's existing copy). An idle agent's last `doing` is history (it is in RECENT), never “right now”. No
second “Working: …” line in the pane's header: RIGHT NOW is that line.

### AP-303 Role titles in lists

- Web sidebar, AGENTS and DIRECT: `Name · Designer` on the row's one line: the name in the row's weight, then a muted
  `·` and the role title (`ROLE_LABELS[role]`, 400 weight, `--mut`); the text ellipsizes as one piece before the
  status dot, so a long name keeps its row height (the status word went in AP-307). The row's `title` carries
  “Swatch, Designer” (an AGENTS row's accessible name adds the status, AP-307; the `·` is hidden from screen readers,
  a visually hidden comma stands in for it). A personal agent's role is `assistant`, so it reads “Assistant”.
- Mobile: the Agents tab already shows the role after the name (role dot + “Developer · working”, AP-230); the
  Channels tab's DIRECT rows now show the role dot and the role title instead of “Direct”, and TalkBack reads “Swatch,
  Designer, direct message, 0 unread”.

### AP-304 Thread focus mode: the pane takes the main column's place

- **Address.** `?thread=<id>&focus=1` (`validateConversationSearch` keeps `focus` only with a thread, as the number
  `1` so the address always reads `focus=1`; a plan or the plans list drops both). The DM route's cleanup keeps
  `focus`. Expanding and collapsing push a history entry, so the browser's Back undoes either, and a shared link opens
  in focus mode.
- **Layout.** The shell hides `<main>` (`hidden`, the screen stays mounted: its scroll position and composer draft
  are there on the way back) and the thread's `SidePane` becomes `width="full"` (flex 1, never an overlay, no divider).
  The same `ThreadPane` stays mounted in the same place, so the reply draft, the typing line and an open menu survive
  the switch. Inside, the thread takes the conversation column's geometry: a header with 32px sides and the header
  title's type, messages and the reply box in the 880px message column (`--max-messages`), left-aligned like a
  conversation.
- **Header.** Split view: “Thread”, its context line, then the expand button (lucide `Maximize2`, label “Open thread
  full width”) before ×. Focus view: a back link “← Back to #general” (the thread's `where`: `#channel`, the DM's
  title, the branch room's title) above “Thread”, the topic alone as its context (the place is already in the back
  link), then the collapse button (`Minimize2`, “Show thread beside the conversation”) and ×. The expand and collapse
  buttons are one button that swaps icon and label, so keyboard focus stays on it. The back link is a real link to the
  split view's address (it opens in a new tab too) and returns to the split view; × closes the thread and clears
  `focus`.
- Replies, cards (plan cards included), quick replies, the message menu and the checkpoint are the same component in
  both layouts. Mobile already shows threads full screen: nothing changes there.
- The thread pane header now differs from the mock by the expand button (deliberate, John 2026-09-29).

### AP-305 Esc in focus mode goes back to the split view, even from the reply box

Esc resolves, in order: a dialog on screen, a route modal, **thread focus mode → split view**, the pane, search. It
does so also while the reply box has focus and holds text: nothing is lost (the draft stays, the same text box keeps
focus), so there is no reason to make Esc behave differently there. A second Esc closes the pane as before.

### AP-306 The visual suite keeps comparing against the mock

The mock predates these changes. `pnpm visual` hides the additions like the earlier ones (`hideAdditions`: the
sidebar's role titles, the roster's “Working: …” line, the thread pane's expand button), gives the cached roster the
mock's `doing` as each agent's job (the fixture's `doing` is the mock's copy), and lets an idle agent's RIGHT NOW show
its last line by patching its cached profile to `waiting` (the pane's role line, which then says Waiting, is masked
for Sketch and Pippa). Focus mode has no mock; it is checked by screenshots and `threadFocus.test.tsx`.

### AP-307 Sidebar agent rows drop the status word

The mock's mono status word (“working”, “waiting”) took the room the role title needs: “Banjo · Devel…”, “Dusty ·
Oper…”. John's point was to see job titles at a glance, so AGENTS rows show no status word any more (DIRECT rows never
had one); the coloured status dot stays. The dot carries the status for everyone: its accessible label and its
tooltip (`title`) say “Working”, “Waiting” or “Idle”, so colour is not the only signal. The row's accessible name
includes it: “Banjo, Developer, working” (`aria-label`, lower-case status after the row label); its `title` stays
“Banjo, Developer”. `pnpm visual` masks the mock's status-word slot left of each agent row's dot (60px,
`deviationMasks`), with the role title hidden as before (AP-306). The one baseline with the sidebar in it,
`feedback-list-narrow-light.png`, is re-recorded (no status words; its tab strip also still showed main's older
tabs).

## U5

Item 5: the Configure agent modal becomes a page. AP-380…AP-399.

### AP-380 The page, its route and its entry points

- `/:burrow/agents/:agent/settings`, with the tab in `?tab=` (`model`, `skills`, `access`, `workspace`, `spend`; absent
  = Profile) and, on Access, `?key=<keyId>` for a key row to show. It is a direct child of the burrow route, not of the
  roster: the page replaces the roster and the profile pane. The shell reads it as `{ kind: 'agents', agent, settings:
  true }`, so the sidebar's Agents row stays selected and no pane opens. The route is written in today's `/:burrow`
  style; the burrow-less URL stream (L) moves it with the others.
- Entry points: the profile pane's Configure (still hidden on someone else's assistant), the sidebar's Configure (AGENTS
  and DIRECT rows' context menu) and the rename in the empty DM with your own assistant all navigate to the page.
- `ConfigureAgentModal` is removed. The modal was never URL state (always local component state), so there are no deep
  links to redirect; the old `?`-less paths keep working as before.

### AP-381 Where every option went (audit)

Old location → new place. “Pane” is the agent profile pane, which keeps its read-only summaries and its immediate
controls (AP-390).

| Old location | What | New place |
|---|---|---|
| Modal NAME (a personal agent's owner only) | Rename, one capitalised word (PA-04) | Profile › NAME, now for every agent (AP-387) |
| — (not editable anywhere) | Job description (`agents.update` `job`) | Profile › JOB DESCRIPTION (AP-387) |
| — (derived from the role) | Avatar | Profile › AVATAR, read-only: it follows the role |
| Modal INSTRUCTIONS AND KNOWLEDGE (from the pane only) | Count, “Open” → memory modal (instructions, knowledge, context, “Propose memory”, “Let X propose skills”) | Profile › INSTRUCTIONS AND KNOWLEDGE, from every entry point |
| Modal AI PROVIDER (live Whombats) | Claude Code / Codex; ACP runtimes for team agents (owner-admins only, BP-E03), the guarded warning | Model & provider › AI PROVIDER; not live: the current provider read-only (scripted: where the AI provider is) |
| Pane RUNS ON (`CredentialSection`) | Whose sign-in a team agent runs on; burrow owners change it, add/remove organization keys | Model & provider › RUNS ON (saves at once, as before) |
| Modal SKILLS (`RolePackRows`) | The role's shipped packs on/off, “an owner adds it”, “on the whole burrow”, “Turn on … to use all its skills” links | Skills › ROLE PACKS; the links go to Access with `?key=` (AP-389) |
| Pane SKILLS (`AgentPacks`) | Per-skill switches, the role-pack suggestion, “Learn this”, “Manage packs” | Skills (saves at once, as before) |
| Modal KEYS, team agent | The role's rows (hire rows + role extras), “Propose skills” before the locked rows, Merge/Deploy locked with notes, rows a bundle brings in, the browser's hint, highlighted key links | Access › KEYS |
| Modal KEYS, personal agent | Its personal keys and “Propose skills”, locked notes | Access › KEYS |
| Modal CHANNELS | Every sidebar channel on/off | Access › CHANNELS |
| Pane VAULT (`AgentVault`) | Your Vault entries it holds a key to (logins, browser logins, API keys) | Access › VAULT, with a line and a link to Settings → Vault when there are none |
| Pane Connect Google callout (own assistant) | Connect / reconnect Google | Access › CONNECTIONS, with the link to Settings → Connections |
| — | Repos | Access › REPOS: a line to Settings → Software Dev (repos are burrow-wide; nothing per agent exists) |
| Modal WORKSPACE (team agents) | Working directory (shape check, server's field error, burrow default), checkout, access; owner-admins edit, others read with the reason | Workspace |
| Pane “This week: …” | The agent's spend, all of it (owners) or yours (members) | Spend: turns, tokens in/out, cost, unreported turns, link to Settings → Spend |
| Modal notices | Blocked, “Waiting for a person to approve (approval #n).” | The tab's notice above the save bar; the edits stay |
| Modal Save changes / Cancel | One save for everything, in order workspace → name → provider → keys → channels → packs | Each tab's Save / Discard (AP-384) |
| Modal loading (`Save` disabled until seeded) | — | Skeleton header and rows; a load error shows “Couldn’t load this agent.” with Retry |
| — | Fire / remove | Not built (AP-386) |

### AP-382 Which tabs an agent has

Profile, Model & provider and Access always. Workspace only for team agents (a personal agent has none, as in the
modal). Skills only where the Whombat has packs (`packs` feature). Spend only where it has spend and `spend.agent`
answers for this viewer (the pane's rule: nothing when the viewer may not see it). A `?tab=` the agent doesn't have
(or doesn't exist) shows Profile.

### AP-383 Who configures what

- System principals (`system`: the GitHub mirror, automations, Feedback's receiver) show “X is part of Whombat itself,
  so there is nothing to configure.” and no tabs.
- Someone else's personal agent shows “Only Joris changes Quokka. Quokka works only for Joris.” (core's
  `onlyOwnerChangesText`) and no tabs; the pane already hides Configure for it.
- Everything else is gated as before: the server's keys (`agents.manage` etc.) answer blocked or pending approval;
  Workspace and ACP runtimes need an owner who is an admin of this Whombat (`ownerAdminLockedReason`); RUNS ON needs a
  burrow owner; importing a pack needs an owner (the pack row says so).

### AP-384 Saving: per tab, a save bar, and asking before leaving

- Each tab has its own draft (`useDraft`): it follows the agent while nothing is changed and keeps the edits once
  something is (the modal's “seed once” rule). Drafts compare by value (key order, a channel switched off and on).
- While the tab differs, a bar sticks to the bottom: “Unsaved changes”, Discard, Save. Save sends only the fields that
  changed; a step that is refused keeps the edits and shows why; a partial save (keys went through, channels were
  refused) keeps only the refused part unsaved. An unexpected failure says “That didn’t save. Try again.”
- Leaving the tab, the page or the window with unsaved changes asks: “Leave without saving?” with Stay and Discard
  changes (the router's blocker; the browser's own prompt on unload). One draft at a time, so switching tabs asks too.
- Controls that saved at once before (RUNS ON, per-skill switches, memory items, Connect Google) still do and never
  count as unsaved.

### AP-385 Save toasts

“Updated Banjo’s profile.”, “Updated Banjo’s AI provider.”, “Updated Banjo’s access.”, “Updated Banjo’s workspace.”;
Skills names the packs: “Attached Developer craft to Sketch.”, “Took Researcher craft off Pippa.”, “Attached Documents
to Pippa and took off Researcher craft.” (replaces the modal's “Updated Bolt’s keys and attached …”, AP-251).

### AP-386 No Danger zone yet

Neither contracts (0.22.4, 0.23.0) nor the runtime have an operation that fires or removes an agent, and U works on
existing contracts. The tab is left out (the tab list has room for it) rather than shown without an action. It needs
`agents.remove` (or `fire`) in `@whombat/core` and a runtime command (what happens to its DMs, grants, runs, packs,
personal agents never), then a `danger` tab with a confirm. Left for the lead to schedule.

### AP-387 Name and job for every agent

`agents.update` already takes `name` and `job` for any agent (the server checks the key and, for a personal agent, the
one-word rule); only the modal limited renaming to personal agents. The page checks what it can before sending (empty,
the personal pattern, a name taken in the burrow with core's `agentNameTaken`) and shows the server's field errors
otherwise. An empty job shows the role's usual one on the card (`ROLE_JOBS`, the placeholder).

### AP-388 Layout

Burrow settings' page shell (the scroll, the 1040px page, 36px title) with the agent's avatar, name and role title
(“Mara’s assistant” for a personal agent), a “← Banjo” link back to the profile, the tabs on the left as the sidebar's
nav rows (real links, `aria-current="page"`), the tab's title and its groups at the modal's 640px width. The page is a
CSS container: under 640px the tabs become one row that scrolls sideways (the current one scrolled into view) with
44px targets. The web shell itself keeps its 256px sidebar at every width (not this item's), so the phone-width
screenshot is taken at 646px, where the page gets a phone's 390px.

### AP-389 “Propose skills” stays a key

It is a key like the others (AP-245), so it stays in Access › KEYS, saved with them. Skills' “Turn on “Browse the
web” to use all its skills.” links open Access with `?key=web.browse`, which scrolls to, focuses and highlights the row
(AP-250); with unsaved skills the usual question comes first.

### AP-390 The profile pane stays

Only its Configure changed (a link to the page). Its read-only sections and its immediate controls (RUNS ON, SKILLS,
VAULT, MEMORY, Connect Google) stay: the pane is where people look, the page is where they change things. U1 edits the
pane's header in parallel; this item touched only the Configure button.

### AP-391 Mobile

The mobile app has no Configure screen (its agent screen shows RUNS ON with its own picker); nothing changes there.

### AP-392 Copy that pointed at the modal

The ACP hint said “make Banjo trusted below”; it says “in Workspace” now. Texts that say “in Configure” (“Give it in
Configure.”, “Add it to one in Configure.”) stay true: the button is still called Configure.

## U6

Item 6: the feedback integration's “New integration” modal, whose content didn't fit, and the integration's modal
(switches, health, snippets, settings summary, editor) become pages. Range AP-400…AP-419.

### AP-400 Two routes, next to Settings

- `/:burrow/settings/feedback/new` — New integration in steps (`?step=reports|widget`, Name & site without one).
- `/:burrow/settings/feedback/:id` — an integration's page; `?step=install` is the stepper's last step right after
  Create. The id must look like one (`fbi_…`), else the not-found page.
- Both are sibling routes of `settings` under the burrow route (like `canvases` / `canvases/$slug`), so the Settings
  screen and its `?tab=` handling stay untouched; they don't show Settings' tab row (it costs 110 px at 720 px tall
  and they are one level down). A “← Feedback” link goes back to `settings?tab=feedback`. The modal was never URL
  state, so nothing old needs a redirect. Stream L drops the `/:burrow` prefix like everywhere else.
- Settings → Feedback's “New integration” and each row's “Open” are real links now (`createLink(ButtonLink)`, the
  Vault's pattern), so they open in a new tab too.

### AP-401 What each step holds

1. **Name & site**: NAME, PRODUCT (BASICS), ALLOWED ORIGINS with the live line-by-line check (WHERE IT RUNS).
2. **Where reports go**: CHANNEL, REPOSITORY, ASSESSMENT AGENT, PROJECT CONTEXT, then HANDOFF's DEVELOPER AGENT (it
   is chosen among the same channel's members). The first group has no label of its own: the step's title names it.
3. **Widget**: THE FORM ON YOUR WEBSITE (report types, theme, position, button, button label, name, email, privacy
   notice), then **Privacy and limits**, a disclosure (collapsed, “Optional … The defaults suit most sites.”) holding
   PRIVACY (page addresses, context keys, keeping content, days) and LIMITS (the eight limits). It opens by itself
   while one of its fields has a problem.
4. **Install**: the snippets with their Copy buttons and the CSP line (or AP-102's notice), SEND A TEST REPORT,
   STATUS (the two switches) and HEALTH.

The mapping is `steps.ts` (pure, unit-tested); every `FieldKey` has a step, so a server error always lands somewhere
visible.

### AP-402 Create at the end of Widget; Install is the integration's page

`feedback.createIntegration` answers only the integration; the snippets and health come from
`feedback.getIntegration`, so the integration must exist before Install can show anything real. Widget's primary
button is “Create integration”; on success the toast says “<name> created.” and the page is replaced by
`/:burrow/settings/feedback/<id>?step=install` (a reload keeps the step). There, steps 1–3 show as done and aren't
clickable (the integration exists: its settings are edited on its page), the bar says “Created. Install it on your
website, then send a test report.” with “Edit settings” (the edit page) and “Done” (back to the list).

A refused Create goes back to the first step the server's `fields` name (Pippa isn't a member → Where reports go)
and shows them under the fields; the server's own sentence is the bar's alert (AP-290's `toApiError` fallback keeps a
managed Whombat's “Feedback needs an update of this Whombat’s cloud connection.”). Pending approval and blocked
outcomes read as before (`settle`).

### AP-403 “Send a test report” is the real widget

Contracts 0.22.4 have no endpoint that files a report on a visitor's behalf: the public `/embed/v1` surface wants an
allowed parent origin and Whombat's own `Origin`, and a managed Whombat receives reports only through the encrypted
drop. Faking one from the app would test neither, and a new endpoint is a contracts + runtime change outside this
stream. So SEND A TEST REPORT explains the real thing (“Open your website with the snippet in place, choose
“Feedback” and send a report. It becomes a thread in #general, and Health counts it.”, the custom-button wording
when the floating button is off), links “Open <first allowed origin>” (new tab, `noopener noreferrer`), and “Check for
reports” re-reads the integration, next to a live line “N reports in the last 24 h · Last report: …”. With intake off
it says to switch it on first. Where nothing can be installed (managed without the drop) the section is absent.

### AP-404 Validation per step

- Next checks its own step with the server's schema (`validateForm`, filtered by step); its problems then show live
  while the person fixes them, other steps' problems stay hidden until those steps are tried. “Check the highlighted
  fields.” is the bar's alert, and focus goes to the first invalid field.
- The stepper's steps are buttons: back to any earlier step freely, forward only when the steps in between are fine
  (checked the same way). `?step=` is pushed, so the browser's Back goes back a step; Back keeps what was typed (the
  form lives on the page, not per step). Opening `?step=widget` with an empty form replaces it with the first step
  that isn't filled in.
- A new step scrolls to the top and focuses its heading (“Step 2 of 4”, then the title).

### AP-405 The edit page

One page without the stepper: STATUS (the switches, applied at once as before), HEALTH, then the settings as cards —
Name & site, Where reports go, Widget, Privacy and limits (open) — then INSTALL and SEND A TEST REPORT. A sticky bar at
the bottom: “Unsaved changes” or “Last changed 22 Sep by Mara Okafor · revision 3” (the old SETTINGS summary's last
line; its other facts are the fields themselves now), Discard and “Save changes” (both disabled until something
changed). Saving keeps the page (toast “<name> saved.”); a 409 loads the other version with the same sentence as
before. A channel the viewer isn't in shows as “A channel you’re not in” in its select, a former assessor/developer
by name.

Switching intake or assessment bumps the integration's revision without touching its settings: the form takes the
new revision and keeps its edits (otherwise the next Save would meet a 409). A change of the settings themselves
replaces an untouched form; an edited one meets the 409 when it saves.

### AP-406 Leaving with unsaved changes asks

Leaving New integration after typing, or the edit page with unsaved changes, asks “Leave this page? Your changes to this
integration aren’t saved.” (`window.confirm`, as the app's other confirmations; a reload or closing the tab gets the
browser's own prompt). Moving between steps never asks, nor do Create and Save.

### AP-407 Fitting 1280×720 and a phone

- The page column is at most 920 px; the action bar sticks to the bottom of the window, so Next / Create / Save are
  always in view at 720 px tall.
- The page is a CSS container and follows the width it gets: under 760 px the stepper drops its hints, under 560 px it
  shows the dots with the current step's title only; under 640 px the padding tightens and the bar's buttons share the
  row at 44 px; under 520 px HEALTH's facts stack (name above value). Segmented choices wrap instead of overflowing;
  KEEP REPORT CONTENT has its own row.
- The web shell's sidebar doesn't collapse (the mobile app is the phone client), which would leave the page 134 px at
  390 px wide. In a window up to 720 px wide these pages cover the app (fixed, above the panes, below modals and
  toasts), the way a thread opens full screen on mobile; “← Feedback” is the way back.

### AP-408 Gating and load states on the pages

Both pages sit behind `FeatureGate feature="feedback"` like the tab. New integration asks the list endpoint and the
integration page its detail: a 403 or `can.manage: false` shows the tab's “Only burrow owners set up feedback
integrations.”, a 404 “This integration no longer exists.”, another failure “Couldn’t load this integration. Try again
in a moment.” with Retry; skeleton rows while loading.

### AP-409 Field audit

Everything the modal had, and where it is now:

- **Editor (IntegrationForm)**: NAME (≤80), PRODUCT (≤60), ALLOWED ORIGINS (live ✓/✗ per line, canonical form) → 1;
  CHANNEL (a change clears an assessor/developer who isn't a member), REPOSITORY (enabled repos, the load-failure hint),
  ASSESSMENT AGENT (“None — …”, in-channel agents, unusable ones disabled with the reason, a Product agent pre-chosen
  for a new integration until the person picks, AR-07/AP-226), PROJECT CONTEXT (≤4000), DEVELOPER AGENT → 2; REPORT
  TYPES, THEME, POSITION, BUTTON, BUTTON LABEL (the custom-button hint), ASK FOR A NAME / AN EMAIL, PRIVACY NOTICE →
  3; HIDE PARTS OF PAGE ADDRESSES, CUSTOM CONTEXT KEYS, KEEP REPORT CONTENT + DAYS (7–3650), the eight LIMITS with
  their bounds, units and defaults → 3, Privacy and limits. Behaviour: the server's schema and plain-language errors
  (`settingsForm.ts`, unchanged), server `fields` mapped onto fields (`settings.x.n` and `x.n`, list entries quoted),
  the revision sent on update, 409 reload + sentence, `settle` for pending approval / blocked, `errorText` (501,
  network, invalid request, the server's message per AP-290), toasts “<name> created.” / “<name> saved.”.
- **Detail (IntegrationDetail)**: the intake switch (on a managed Whombat without the drop it can be switched off,
  never on) and the assessment switch (disabled without an agent, “Choose an assessment agent …”), their toasts and
  their refusals as a notice; HEALTH (reports in 24 h, last report, assessments with failed/blocked colored, public
  address or “Not set …” on a self-hosted Whombat, delivery / site published / last collected / widget address with
  the drop), the server's warnings (on a managed Whombat without the self-hosted ones; `drop_not_filed` “… couldn’t be
  filed.”, `drop_expired`, `drop_unsupported`, `drop_not_published`); INSTALL (basic and custom snippets verbatim with
  Copy snippet / Copy example, the CSP line with Copy, or AP-102's notice when the drop isn't available); the
  SETTINGS summary's facts are the edit page's fields, its “Last changed … by … · revision N” is the save bar's quiet
  state.
- **The tab (FeedbackTab)**: the rows, the owners-only lock, load error with Retry, skeleton — unchanged.

## S

Item 7, the web side: subscription usage in Settings (contracts 0.23.0, CT-153…CT-157). AP-340…AP-349.

### AP-340 A Usage tab next to AI accounts, gated by the runtime feature

- Settings → Usage (`?tab=usage`) sits right after AI accounts (where people sign in to the subscriptions it
  measures), for every member. The tab is always listed; on a Whombat without the `usage` feature its panel says
  `featureNeedsUpdate('usage')` (“Update your Whombat to use subscription usage.”) and calls nothing, like Spend,
  Vault and Skills & packs (AP-256). Hiding the tab would leave people who read about it with nothing to find.
- The compact meter in General is hidden there instead (it is an extra, not an entry point).

### AP-341 One card per provider, always both

“YOUR SUBSCRIPTIONS” shows a card for Claude and one for Codex (`LIVE_PROVIDERS`), whether or not `mine` has them: a
provider without a snapshot, or with `connected: false`, is “Not connected · Sign in with your own subscription under
AI accounts to see its limits here.” with a **Sign in** button. The assignment says “a link to connect in Settings →
General's AI provider”; General's AI provider is the host's CLI status, and a person's own sign-in lives in Settings →
AI accounts (SUB-01…SUB-05), so Sign in goes to `?tab=ai`. An API key shows `USAGE_PAY_AS_YOU_GO` verbatim with
“Spend” a link to `?tab=spend`, and no Refresh (it has no windows to read).

### AP-342 Card contents

- Head: the provider (`USAGE_PROVIDER_LABELS`), then `Max plan` (the CLI's plan name capitalized, `_`/`-` as spaces)
  or `Subscription` when the plan is unknown, then `· as of 14:32` (`formatAsOf`) when `isUsageStale`. Refresh on the
  right.
- A bar per window in `sortUsageWindows` order, in a grid (three across at 1440, one per line when narrow): label,
  share (`formatUsagePct`, “limit reached” when limited without a number), “resets in 2 h 10 min” (`formatResetsIn`;
  the reset clock, `formatResetTime`, as its tooltip).
- No windows: “Not read yet. Refresh to read it now.” before the first reading, “Its provider didn’t report any
  limits.” after one.
- `error` is shown verbatim on its own line in `--bad` under the bars (the bars are the last good numbers).

### AP-343 Bars are `role="meter"`, state in words too

- A bar is a `div role="meter"` (0–100, `aria-valuenow` rounded, `aria-valuetext` = `formatUsageWindowLine`, label
  “Claude 5-hour usage”; in the table “Joris de Vries, Claude 5-hour usage”). A native `<meter>` can't be styled the
  same in every browser with tokens (biome's `useSemanticElements` is suppressed there with that reason).
- Tone through `windowLevel`: `--ok` below 80 %, `--warn` from 80 %, `--bad` from 95 % and when limited; `--mut` for
  an unknown share. A limited window without a number fills the bar.
- Never by color alone: beside the share a word in the same tone — “High” (≥ 80 %), “Near the limit” (≥ 95 %),
  “Limit reached” (limited). Below 80 % no word; the number says it.

### AP-344 Refresh

`usage.refresh` for the card's provider. A fresh snapshot replaces the old one in every cached `usage.list` (mine and
everyone) at once, then the button waits the minute the runtime would refuse anyway (`USAGE_REFRESH_MIN_INTERVAL_MS`)
as “Refresh in 59 s”, disabled. A 429 `rate_limited` does the same with `details.retryAfter` (60 s when absent). A 404
says “You’re not signed in to Claude anymore.” and reloads the list; anything else “Couldn’t read your usage. Try again
in a moment.”. The countdown is per card and not kept across reloads (the server still enforces the minute).

### AP-345 Everyone: a column-labelled list, fullest first

- Owners and admins get “EVERYONE” whenever `everyone` isn't null (the runtime decides who; the client doesn't
  second-guess roles), with “Everyone’s Claude and Codex sign-ins in {burrow}. Only owners and admins see this.”.
- Columns PERSON (head avatar and name), PROVIDER, PLAN (`Max`, `API key`, `Subscription`, `Not connected`), 5-HOUR,
  7-DAY (small bars with share and word), RESETS (the 5-hour window's, else the 7-day's: “in 38 min”), AS OF (“10:10”,
  “28 Sep, 14:32”, “not read yet”; `formatAsOf` without its “as of”, which the column says). Spend's table pattern:
  a list with mono column labels hidden from assistive tech and each cell's column name read out.
- Order: a limited window first, then the fullest share, then API keys, not connected and unread; ties by name.
- Search (“Search people or providers”, name, provider or plan) from 8 rows (`USAGE_SEARCH_FROM`).

### AP-346 Narrow: a size container, not the viewport

The web shell keeps its sidebar at every width, so a viewport media query would never fire where it matters. The tab
is a CSS size container (`container: usage / inline-size`); below 700px of its own width each table row becomes a card
(person; provider and plan; 5-hour and 7-day; resets and as of, each with its visible column label) and the windows
go one per line.

### AP-347 Freshness

`usage.list` is read every time the tab opens (`refetchOnMount: 'always'`) and kept fresh by `usage.updated` (the
client already refetches on it). Relative times move with a 30 s clock. The viewer's time zone (preference, else the
burrow's) is used for “as of” and reset times, like the rest of Settings.

### AP-348 The compact meter in General

A row at the end of the AI provider card (mounted from `GeneralTab` as one more child of `AiProviderPanel`; the panel
itself is unchanged): a status dot in the fullest window's tone (labelled with its word, else “OK”), “Your usage”, and
per subscription with windows “Claude · 5-hour 62 % · 7-day 41 %” (`compactUsageText`: the 5-hour and 7-day windows,
else `primaryUsageWindow`; “5-hour limit reached” when limited) with two small bars, and “See usage” linking to
`?tab=usage`. Absent on a Whombat without `usage`, for API keys only, and before the first reading. It shows only
where General shows the AI provider (the runner's status is known).

### AP-349 Code lives in `features/usage`

`model.ts` (copy and pure helpers), `useUsage.ts` (`useUsageList = queryHook(api.usage.list)`, the refresh hook and
`refreshOutcomeOf`), `UsageBar`, `UsageTab`, `UsageMeter`, `Usage.module.css`. No new query hook in
`@whombat/client` yet: the phone can add one there when it needs it.

## M

Item 8: rich rendering (Markdown, HTML previews, images, media) on web and mobile, on contracts 0.23.0 (CT-148…CT-152).
AP-320…AP-339.

### AP-320 The HTML preview frame

- An agent's page (a fenced `html` block, a raw `<!DOCTYPE html>` page, an `.html`/`text/html` attachment) shows in
  `<iframe sandbox="allow-scripts" src="/sandbox/html-frame.html">` — never `allow-same-origin`, popups, forms,
  downloads or top navigation. The page is never a URL: the app reads it as text and posts `{type: 'whombat.html',
  html}` once, to that frame's `contentWindow`, with target origin `*` (the frame's origin is opaque), on the frame's
  first `load` (a later load is the page navigating itself inside the frame; it gets nothing). The app reads only
  `{type: 'whombat.height', height}` and only from that `contentWindow`; the height is clamped to 160…720 px in a
  message (80 for a diagram), full screen fills the window.
- The frame page is static (`apps/web/public/sandbox/html-frame.html`) with its script as a file
  (`html-frame.js`, `document.open/write/close`, then a ResizeObserver on the root and body reporting the page's own
  height — `getBoundingClientRect` of the root, not `scrollHeight`, which is never less than the frame). External, so
  the frame's own policy could drop `'unsafe-inline'` for its shell if the page ever didn't need it.
- Its policy is John's list plus `'self'` in `script-src`/`style-src` (the frame's script and the Mermaid runtime, which
  are this origin's) and `frame-ancestors 'self'` in the header: `hosted.ts` `sandboxContentSecurityPolicy`. It is
  delivered twice: as the `/sandbox/*` block of the hosted build's `_headers` (values replace the `/*` ones,
  appliance IN-121; `/*` sets no `X-Frame-Options`, so nothing to override) and as a `<meta>` in the frame page
  (without `frame-ancestors`), so every server that serves the build — the Hetzner static host, the appliance
  harness web-server, Vite dev/preview (`sandboxHeaders()` sets the header too), Storybook (`staticDirs`) and the legacy
  monolith (whose static files get only `nosniff`) — confines the page the same way. Verified: a meta policy stays in
  force after `document.open()`, and Chrome matches `'self'` in an opaque-origin frame against the frame URL's origin.
- The app's own CSP gets `frame-src 'self'` (was `'none'`) and nothing wider.
- Verified against the appliance web-server (`~/Code/.wt/appliance-ui`, IN-121) serving `build:hosted`: the page's
  inline SVG, `<style>`, Google Fonts and inline script work; `fetch` (https and same origin), XHR, WebSocket and
  `sendBeacon` are refused (`connect-src 'none'`); `parent.document` throws `SecurityError`; `top.location` throws
  `SecurityError` and the app stays where it was; `window.open` is null; forms don't submit; storage and cookies throw.
  `e2e-managed/rich-hosted.spec.ts` runs the same checks in the hosted build with the fake world.

### AP-321 Markdown blocks on web

- Headings are real headings under the page's own: `#` → `<h3>`, `##` → `<h4>`, `###` → `<h5>`, `####`…`######` →
  `<h6>`; a modest scale from the tokens (card title, body large bold, body bold, secondary, small muted).
- Tables scroll sideways inside the message (`<section aria-label="Table" tabindex="0">`, so a keyboard can scroll
  them), header on `sf2`, rows ruled with `line`, every other row tinted `sel`, alignment by class (no `style`).
- Task items are disabled checkboxes labelled by the item's text (`<label>`); checked items' text is muted. Nested
  quotes keep their own bar.

### AP-322 Code blocks and highlighting

- Every fenced block: its language as written (or “Code”) and a Copy button (“Copied” for 2 s) above the code, on the
  README's `code` surface. Highlighting is highlight.js core with 13 grammars (bash, css, diff, go, javascript, json,
  markdown, python, rust, sql, typescript, xml/html/svg, yaml, plus common aliases), in its own lazy chunk
  (`highlight.ts`, 70 KB, 23 KB gzip), turned into a token tree rendered as React elements with CSS-module classes: no
  HTML strings, no `style` attributes, no eval (the hosted `style-src 'self'`). No auto-detection; over 100 000
  characters stays plain. Shiki was not used: it colours with inline styles and ships a WASM regex engine.
- Colours are new tokens `codeColors.syntax*` (`--code-syntax-*`), each ≥ 4.5:1 on both themes' `code`
  (contrast test); diff lines reuse `code-added`/`code-removed`.

### AP-323 Mermaid in the sandbox

- A `mermaid` fence (and an `.mmd`/`.mermaid` attachment) is a card titled “Diagram” with “Open full screen” and
  “View source”, drawn in the same frame as an HTML page: the app writes a small document (the source escaped, the
  app's colours from the token CSS variables, `securityLevel: 'strict'`, `startOnLoad: false`, `useMaxWidth: false` so
  wide charts scroll instead of shrinking to unreadable text) that loads the Mermaid runtime from this origin.
- The runtime is `mermaid/dist/mermaid.min.js` 11.17 (3.5 MB, 0.98 MB gzip; 12.0 is 5.5 MB), emitted by Vite as a
  hashed file in `/assets/` rather than copied to `/sandbox/`: the static hosts cache `/assets/` for a year and
  `/sandbox/` not at all (no validators), and the opaque-origin frames do reuse the HTTP cache for it (checked). Classic
  script, not the ESM build: a module script from an opaque-origin document needs CORS headers the hosts don't send.
  Mermaid runs without eval under the frame's CSP (checked). Mobile shows the source under a “Diagram” label
  (**Superseded in part by `docs/decisions/visual-replies.md` VR-08**: the phone draws it too).

### AP-324 Images and the gallery

- How an attachment shows is `attachmentPreview` (CT-152). Raster images include AVIF (`kind: file`); SVGs stay
  `<img>` of a `data:` URL (AP-100). Two or more pictures are a grid of square crops (2 columns for 2 or 4, else 3;
  420/540 px wide); the existing lightbox opens each.

### AP-325 PDFs: the first page, drawn by pdf.js

- An `<iframe>`/`<object>` of a PDF blob is out: `frame-src 'self'` doesn't cover `blob:`, `object-src 'none'`, and a
  `blob:` document has the app's origin. pdf.js 5 (lazy: 409 KB + a 1.2 MB worker from `/assets/`, `worker-src 'self'`)
  draws the first page on a canvas under the chip (“PDF · size”, Download); clicking opens the first 30 pages in the
  lightbox (“Showing the first 30 of N pages. Download the file for the rest.”). No WebAssembly (the CSP has no
  `wasm-unsafe-eval`), no font or CMap fetches (`connect-src`), system fonts: pdf.js falls back to its JS decoders.
  Anything failing leaves the chip. Mobile keeps the chip (share sheet).

### AP-326 Audio and video

- `<audio controls>` / `<video controls>` for `PREVIEW_AUDIO_TYPES` / `PREVIEW_VIDEO_TYPES`, the chip under the player.
  Legacy: the attachment URL. Managed: the bytes (≤ 32 MB) as an object URL typed as the media type, revoked when the
  player goes. The hosted CSP gains `media-src blob:` only. Other types stay chips. Mobile keeps chips.

### AP-327 Long messages need `messages.long`

- The composer allows `messageTextFits` (48 000 characters within 48 KiB of JSON) when the runtime advertises
  `messages.long`, else 8000 characters. Over the limit Send is held (`aria-disabled`) and the notice says “That
  message is too long.” (plus “Update your Whombat to use long messages.” on an older runtime). Outside the providers
  (stories, tests) and over the legacy server every feature is there (`useOptionalAppServices`).

### AP-328 Mobile

- Tables scroll sideways with per-column widths from the longest cell (72…240 dp), task items are read-only
  checkbox icons with `accessibilityRole="checkbox"` and their text as label, headings scale 1.25…0.94 of the bubble
  text, code blocks show their language (no highlighter), Mermaid shows its source labelled “Diagram” (superseded by visual-replies.md VR-08), AVIF images
  show on Android 12+ / iOS 16+.
- HTML pages use `react-native-webview` 13.16.1 (Expo SDK 57's version; autolinked, no config plugin): a 300 dp card
  with “Open full screen” (a modal) and “View source”. The frame's CSP is inserted as the page's first element (after a
  leading doctype) with no-referrer and a device-width viewport; JavaScript on; DOM storage, file access, geolocation,
  cookies and cache off, incognito, `setSupportMultipleWindows={false}`, no `onMessage` (no bridge in the page;
  **superseded in part by `docs/decisions/visual-replies.md` VR-07**: the card reads the page's height).
  `originWhitelist` is `['*']` on purpose — the library hands a URL that fails the whitelist to `Linking.openURL`,
  which would let a page open anything in the system browser — and `onShouldStartLoadWithRequest` allows only
  `about:blank` (the HTML string's own load), so links, `location` changes, `data:` pages and windows go nowhere.
  `dataDetectorTypes` is `['none']`: a bare string crashes the new architecture's prop parser. Checked on the emulator:
  the page renders (Google Fonts included); `fetch` is blocked, top navigation stays in the card and opens nothing,
  `window.open` is null, `localStorage` throws, `window.ReactNativeWebView` is undefined.
- **A new native build is required** (the module is native); JS-only updates don't exist for this app.

### AP-329 Test fixtures

- Web: `VITE_FIXTURE_RICH=1` (fixture mode) adds Swatch, a designer, to the bootstrap and six messages to #general:
  the logo page as a fenced `html` block (inline SVG, `<style>`, a Google Fonts `<link>`, a script bouncing the coin),
  the same page as `burrow-billing-logo.html`, a heading with a table and a task list, a Mermaid flowchart, CSS with a
  nested quote, and three SVG swatches, a one-page PDF and a WAV chime (blob URLs made in the page). The same messages
  are the Storybook story “Messaging/Rich messages” (light, dark, phone width). Off by default, so the mock's screens
  stay as drawn.
- Mobile: `EXPO_PUBLIC_WHOMBAT_RICH=1` adds Swatch and the text messages to the demo world's #general.

## L

Item 3: burrow-less URLs in the web app and the phone's link parser. AP-360…AP-379. The lead's settled design (the
routes, which burrow is open, old links, the ambiguity rule, `appPath`, mobile, managed paths) is recorded here with
the details decided while building it.

### AP-360 The routes

Every burrow screen drops `/:burrow`: `/`, `/c/:channel`, `/dm/:agent`, `/pr/:number`, `/runs/:number`, `/work`,
`/agents`, `/agents/:agent`, `/agents/:agent/settings`, `/canvases[/:slug]`, `/log`, `/search`, `/settings`,
`/settings/feedback/new|:id`, `/automations[/:id]`, `/automation-runs/:number`. Search params are unchanged. The list is
`BURROW_ROUTES` in `@whombat/client` (`packages/client/src/paths.ts`), shared by web and mobile; a web test checks
that the router's burrow routes are exactly that list. In the router the burrow screens hang off a pathless layout
route (`id: '_burrow'`) whose `beforeLoad` picks the open burrow and puts it in the route context
(`useOpenBurrow()`); screens still take `burrow` as a prop for their queries.

### AP-361 Which burrow is open

- Managed: the open appliance's session only offers its own memberships, so the choice below is always one of that
  appliance's burrows; the memory's key names the appliance (`whombat.burrow.<device>`).
- Self-hosted and several burrows: a switch is remembered for the tab (`sessionStorage`, so a reload stays put) and for
  the browser (`localStorage`, the last opened, for a new tab); the tab's wins. Without one, or when it is no longer a
  membership (after asking the server again once: a burrow just created or joined), the first membership, and the
  stale memory is forgotten. No membership: `/onboarding`.
- What switches: an old `/<burrow>/…` link, `?burrow=<slug>`, the burrow menu (its rows are `/?burrow=<slug>`, real
  links), and onboarding's end (`/?burrow=<new>`). Nothing else writes the memory; opening a page never does.
- `?burrow=` on any burrow page: switch (a member's burrow), then the same path with the other params and the hash,
  `replace`. `homePath()` is `/` (or `/onboarding` without a burrow).
- The shell's `<Outlet>` is keyed by the burrow: another burrow's screens start afresh.

### AP-362 Old or new: the rule

`splitBurrowPath(pathname)`:
1. A path that is a burrow screen as it stands (matches `BURROW_ROUTES`) is the new form, whatever its first segment.
2. Otherwise, if what follows the first segment is a burrow screen (or nothing), it is the old form and the first
   segment is the burrow.
3. Anything else is neither: Not found (the web), nothing (the phone).

In the router the burrow-less routes are tried first (TanStack ranks static segments above the old form's splat
route), so the old-form route only ever sees paths rule 1 rejected. Consequences, on purpose: `/work` is the Work
view even where a burrow is called “work”; `/work/c/general` is burrow “work”'s #general; `/agents/work` is the
profile of an agent called “work”. A bare `/<burrow>` whose slug is a route name (`/work`, `/search`, `/settings`,
`/log`, `/agents`, `/canvases`, `/automations`, `/c`…) is read as that screen in the open burrow, not as a switch.
Slugs are checked by `isValidBurrowSlug` (contracts `RESERVED_SLUGS`: `login`, `onboarding`, `mobile`, `brand`,
`auth`, `admin`, …) and the runtime's `createBurrow` uses it, but none of the burrow route names (`c`, `dm`, `pr`,
`runs`, `work`, `agents`, `canvases`, `log`, `search`, `settings`, `automations`, `automation-runs`) nor the hosted
UI's own pages (`appliances`, `claim`, `connect`, `billing`, `signup`, `waitlist`, `invitations`, `account`, `legal`)
are reserved; a burrow named from an organization called “Work” gets `work`. Reserving them is a contracts follow-up
(new burrows only; existing ones keep working through this rule). No contracts or runtime change here.

### AP-363 Old links keep working

`/<burrow>/<rest>` (every link the servers write: emails, pushes, `linkPath()`, invites, feedback, Android app links,
the Google return, the guides' `returnTo`, sign-in `redirectTo`, `/appliances/<device>/<burrow>/…`): the old-form route
(a root splat) asks for the session (signed out: `/login?redirect=<the old URL>`, so it still switches after sign-in),
checks the membership (asking the server again once), remembers the burrow and redirects to `/<rest>` with the search
and hash, `replace: true`. A burrow the person isn't in, and `?burrow=` of one: the existing Not found page (“Nothing
lives here · The link may be old, or the burrow was renamed.”), nothing remembered. Server-made links stay in the old
form on purpose.

### AP-364 In-app links

Every `<Link>` and `navigate()` uses burrow-less routes (`to="/settings"`, `to="/agents/$agent"`), no `burrow`
param. `appPath(link)` (client) is `linkPath()` without the `/<burrow>` prefix and replaces `linkPath` everywhere in
the web app (cards, plan pane, search, work, runs, audit, memory, thread receipts, channel welcome actions); hand-built
`/${burrow}/…` strings are gone (automation paths, the sidebar's Alt+↑/↓ order, the shell location parser, search's
Esc). Components whose only use of `burrow` was a link lost the prop (cards' `PlanCard`/`RunCard`/`AnswerCard`,
`AuditRow`, `ThreadView`, `AutomationRow`, the feedback pages' frame).

### AP-365 Links that leave the tab name their burrow

A link that may be opened by someone in several burrows is burrow-less with `?burrow=<slug>` (`withBurrow`): the
canvas Share link (`/canvases/<slug>?burrow=…`, managed: `/appliances/<device>/canvases/<slug>?burrow=…`), the
Google connect's default return (`/settings?tab=connections&burrow=…`; a guide's server-made `returnTo` goes as it
is), the phone's link to Settings → AI accounts (`aiAccountsPath`), and a tapped browser notification in managed mode
(`push.resolve`'s link, the inbox fallback, the by-kind fallback).

### AP-366 The phone

- `appUrlForPath(path)` reads both forms (through `splitBurrowPath`); `burrowOfPath(path)` is the burrow a path names
  (the old form's first segment, else `?burrow=`), null for burrow-less. `/agents` opens the Agents tab and
  `/automations` the automations list (new).
- Managed: links naming an appliance keep their query now (`?thread=`, `?burrow=`; before, the query was dropped), and
  a hosted-UI burrow page without an appliance (`https://<ui>/c/general`, `/<burrow>/agents/banjo`) is a new incoming
  kind, `path`, opened in the Whombat last used (not paired: pairing; none: the list). The UI's own pages (`/`,
  `/appliances`, `/auth`, `/claim`, `/invitations`, `/legal`, `/login`, `/connect`, `/billing`) are never one.
- A path that names another burrow of this person on the open Whombat switches to it (`ManagedBurrow` picks it; the
  burrow app underneath is keyed by the burrow) and the path is held for the next navigator (`LinkBus.hold`); a burrow
  they aren't in opens the inbox (as a push of another burrow already did). Server (non-managed) mode has no app links;
  its notification taps carry the burrow separately and behave as before.

### AP-367 Android app links

The managed build's intent filters add the burrow-less pages the phone has a screen for: `/c/`, `/dm/`, `/runs/`,
`/agents`, `/agents/`, `/work`, `/search`, `/automations`, `/automation-runs/` (per UI origin, beside `/auth/verify`,
`/appliances/`, `/invitations/accept`, `/claim`). Settings, canvases, the audit log and `/pr/` stay in the browser
(no phone screen). The old form can't be declared (its first segment is any slug); it reaches the phone through
`/appliances/<device>/<burrow>/…` as before. `assetlinks.json` names no paths and is unchanged. Needs a new native
build (intent filters are in the manifest).

### AP-368 Managed paths untouched

`ManagedRoot` still owns its paths before the burrow app (`/auth/verify`, `/appliances…` and the journeys, `/claim`,
`/connect/google`, `/billing`, `/signup`, `/waitlist`, `/invitations/accept`, `/account/delete`, `/legal/…`); none of
them is a burrow route, so nothing moved. `/appliances/<device>/<path>` opens `<path>` in either form. The servers that
serve the web build (the runtime's `web/static.ts`, the hosted `web-server.ts`, Vite) fall back to `index.html` for any
page path, so the new top-level paths need nothing there.

### AP-369 Tests and the harnesses

Unit: `packages/client/src/paths.test.ts` (both forms, the ambiguity rule, `appPath`, `withBurrow`), the router
(`src/app/router.test.tsx`: old → new with search and hash and `replace`, `?burrow=`, the remembered burrow, unknown
burrow, neither form, the ambiguity rule, the route list), mobile (`src/navigation/links.test.ts`,
`src/managed/incoming.test.ts`, the intent filters in `src/data/app-config.test.ts`). Unit tests, the visual specs
and the e2e specs now open burrow-less paths; a few keep an old URL on purpose (the managed attachment journey, the
appliance deep link, sign-in through an old link) to cover the redirect.
