# Settings simplified, sidebar trimmed (SS)

John, 2026-10-04: “simplify the settings page, I think we have too many tabs … rethink the whole Settings page.
Somewhere we need to see the current version … In the Sidebar we have Branch Rooms, please remove that entirely.”
He agreed to the proposal below including every further idea (“implement it fully”).

Problem found: 11 tabs (13 managed) that overflow the row at 1440 px; AI provider status shown three times (General → AI
provider, AI accounts → AI clients, This Whombat → Providers); Usage and Spend are two tabs answering one question;
GitHub is a connection with its own tab; machine settings spread over General, Repositories and Devices; no version.

## Settings: 13 tabs → 6

| Tab (`?tab=`) | Holds | Was |
|---|---|---|
| **Profile** (`profile`, default) | PROFILE (name, title, signing key, your assistant, suggestions) · WHAT YOUR AGENTS KNOW ABOUT YOU (learning switch + entries, gated `agents.memory`) | General, About you |
| **Notifications** (`notifications`) | unchanged | — |
| **Members** (`members`) | unchanged (members, invites, owners) | — |
| **AI** (`ai`) | jump links *Accounts · Usage · Spend* · YOUR AI SIGN-INS · ORGANIZATION KEYS · AI CLIENTS (with the host's readiness: runner/ACP rows, fix commands, Check again, capability matrix behind “Details”) · USAGE (gated `usage`) · SPEND (gated `spend`) | AI accounts, Usage, Spend, General's AI provider, This Whombat's Providers |
| **Connections** (`connections`) | overview of GitHub, Google, Website feedback; each opens its page (`&connection=github\|google\|feedback`) | Repositories, Connections, Feedback |
| **This Whombat** (`appliance`) | VERSION · web browser · agents' computers network · default working directory (self-hosted) · audit log link · managed only: connection, recovery kit, backups, updates, DEVICES, revocations, policy, diagnostics | General, Repositories, Devices, managed This Whombat |

- SS-01 **Superseded by settings-groups.md STG-01.** Six tabs, in this order. Page title **Settings**; subtitle “Your profile, your agents’ AI, who’s in
  {burrow} and this Whombat.”.
- SS-02 **Superseded in part by settings-groups.md STG-05 (the targets).** Old `?tab=` values keep working by redirect (replace, no history entry): `general`, `about` → `profile`
  (`about` scrolls to `#about-you`); `usage` → `ai#usage`; `spend` → `ai#spend`; `repos` → `connections&connection=github`;
  `feedback` → `connections&connection=feedback`; `devices` → `appliance#devices`; `packs` → `/agents?tab=skills`.
  `/settings#ai-provider` → `ai#clients`.
- SS-03 AI provider readiness is shown once, in AI → AI CLIENTS. A client row says Installed · version and, when the
  host can't run it, the fix command; Check again for admins. The capability matrix is behind a “Details” disclosure.
  This Whombat drops its Providers section. The usage meter that sat under the provider panel goes (Usage is on the
  same tab now). The shell notice “agents can't run” links to `?tab=ai#clients`.
- SS-04 Usage's “Pay as you go — see Spend” links to `#spend` on the same tab.
- SS-05 Connections overview lists GitHub, Google and Website feedback as CONNECTED rows or ADD A CONNECTION tiles
  (existing pattern, AP-673). GitHub's page is the old Repositories tab (sign-in, repositories, new repository) minus the
  working directory; Website feedback's page is the old Feedback tab (integrations; their own pages stay at
  `settings/feedback/new` and `settings/feedback/:id`). AI accounts' pointer to the GitHub sign-in now names
  “Settings → Connections → GitHub”.
- SS-06 This Whombat is shown on every Whombat (self-hosted too), with only the sections that apply. VERSION first:
  app version (`VITE_WHOMBAT_BUILD`'s version, build id in mono), Whombat (runtime) version when the server reports it,
  contracts version. Devices is a section here (managed only), anchor `#devices`.
- SS-07 Members only see what they can use: This Whombat shows members VERSION and the read-only rows; owners/admins
  see everything (each section keeps its own permission rule).
- SS-08 **Superseded by account-menu.md ACM-05.** Account menu: a muted mono line at the bottom, “Whombat {runtime} · app {app}” (only “app {app}” when the
  runtime version is unknown); it links to Settings → This Whombat.

## Skills move to the Agents page

- SS-10 Skills & packs leaves Settings and becomes the **Skills** tab of the Agents page (`/agents?tab=skills`), next
  to the roster. Same content (proposed, propose skills, installed, import, Learn this). Copy “Settings → Skills &
  packs” becomes “Agents → Skills” (contracts `packSkippedReason`, Whombat guides).

## Sidebar

- SS-20 BRANCH ROOMS section removed from the sidebar (web and Android). PR pages stay and are reached from run cards,
  message cards, the run page, Work and search.
- SS-21 **Superseded in part by settings-groups.md STG-07 (the audit log is reached from Advanced).** Audit log leaves the sidebar nav; it is reached from Settings → This Whombat (“Audit log · Everything signed in
  {burrow} · Open”) and search. Nav: Agents, Canvases, Vault, Needs you, Work.
- SS-22 Agent rows show a short role: “Developer” for Software Developer (`shortRoleLabel` in `@whombat/client`); the
  full title stays on the agent page and in tooltips.

### Sidebar, decided while building (web)

- SS-50 The visual comparisons take the mock's BRANCH ROOMS section and its “Audit log” nav row out of the desktop
  reference before it renders (`tools/visual/src/removals.ts`, on by default for every desktop shot; `--as-drawn` /
  `asDrawn: true` keeps them), the reverse of `hideAdditions` for what the app adds. A mock that loses either makes
  the rewrite throw, so it gets noticed.
- SS-51 Alt+↑/↓ steps through channels and DIRECT only; on a PR page it starts from the top or bottom like any other
  page that isn't a sidebar conversation. A branch room's mentions still count in the tab title, favicon and app badge
  (`unreadTotals`) and its asks still reach Needs you and Work; only the row is gone.
- SS-52 The short role goes wherever a one-line agent row runs out of room: the sidebar's AGENTS and DIRECT agent rows,
  the `@` list's role badge (full title as its tooltip) and the plan step owner select (“Banjo · Developer”). Rows with
  the role on a line of its own (members pane, people picker), the agent page and settings, roster cards, the hire
  picker, spend and the audit log keep the full title. The rows' accessible names and `title` keep the full title.
- SS-53 The sidebar's room context menu (Files changed, Copy branch name, Knowledge) was the only way to a branch
  room's Knowledge, so the room's header gets a More (`⋯`, like a channel's) with Copy branch name and Knowledge; Files
  changed is the room's own tab. The visual comparison hides it with the other header More (`[data-header-more]`).
- SS-54 The `auditLog` icon stays in the icon set (catalog story, the Audit log link in Settings).

## Android

- SS-30 Android mirrors the grouping: its settings screens are ordered and named Profile, Notifications, Members, AI,
  Connections, This Whombat, with Usage/Spend under AI, Devices under This Whombat, version shown in This Whombat; no
  branch rooms in the channels list; short role labels.

## Web decisions made while building it

- SS-40 Settings → AI is three groups with a title each (h2 “Accounts”, “Usage”, “Spend”; the sections under them are
  h3), the jump links target the groups (`#accounts`, `#usage`, `#spend`), AI CLIENTS is `#clients`. A group whose
  feature is missing keeps its title and says “Update your Whombat to use …” under it; its jump link is left out.
- SS-41 AI CLIENTS with the host's readiness: the Agent runner row first (or the scripted-agents notice), then each
  client's row (Installed · version, Install/Remove) with, under it, the host's fix command when the runner is connected
  and the host can't run it — not for a client that isn't installed, where the row's Install / “Ask an admin” already
  says it — the sandbox problem, and “Details” (a real `<button aria-expanded>`, label “Details · Claude Code”). ACP
  runtimes follow as rows; “Checked … · Check again” sits under the card. A server without `clients.*` shows the old
  provider panel there. Onboarding's provider panel puts its matrices behind the same “Details”.
- SS-42 The Agents page's tabs are “Roster” and “Skills” (Settings' underlined tabs); Hire an agent stays in the header
  on both. Skills is `PacksTab` unchanged, at the roster's width.
- SS-43 Connections overview entries, in order: GitHub (connected when the burrow's GitHub is: “GitHub · @login”,
  “N repositories on”; tile Connect when the person can connect or sign in, View otherwise, “GitHub is turned off on this
  Whombat.” when off), Google and Microsoft (as before; Google with `WHOMBAT_GOOGLE=off` is a View tile saying
  “Connecting accounts is turned off on this Whombat.”), Website feedback (only with `feedback`: connected when there is
  an integration — its name or “N integrations”, the reports of the last 24 h, “On” or “Needs attention” on a health
  warning; tile Set up, or View with “Only owners set this up.”). The overview shows without the connectors' status too
  (an older server: GitHub and Website feedback only). Intro: “GitHub for your repositories, your own accounts for your
  assistant, and your website’s feedback.” Website feedback's pages go back with “← Website feedback”.
- SS-44 This Whombat's order: VERSION, WEB BROWSER, AGENTS’ COMPUTERS, WORKING DIRECTORY (self-hosted), AUDIT LOG
  (“Audit log · Everything signed in {burrow} · Open”), then a managed box's own sections (connection, subscription,
  recovery kit, backups, updates, DEVICES `#devices`, revocations, policy, owners, diagnostics). The connection row no
  longer repeats the software version (VERSION has it).
- SS-45 VERSION rows: “App” (meta “Build {build id}” in mono when the build id says more than the version, else “This
  web app”), “Whombat” (“What runs your agents”, only when known), “Contracts” (“What the app speaks”); values in mono on
  the right. Sources, in one hook (`features/settings/version.ts`, used by This Whombat and the account menu):
  `VITE_WHOMBAT_VERSION` and `VITE_WHOMBAT_CONTRACTS` (new `vite.config.ts` defines: the root `package.json` version,
  the vendored contracts version) and `VITE_WHOMBAT_BUILD`; the Whombat's version from `appliance.status` on a managed
  box and from `health.get` on a self-hosted server, which tells only admins and local callers — members see the app's
  version alone. No server change.
- SS-46 **Superseded in part by account-menu.md ACM-05 (read once the pointer or focus comes to the person's row).** The account menu's version line is its own component (`app/shell/AccountMenuVersion.tsx`) under Sign out, read
  when the menu opens.
- SS-47 Profile: WHAT YOUR AGENTS KNOW ABOUT YOU is one section (`#about-you`): the label with the characters used
  beside it, the intro, then one card — the learning switch, the entries, the add field. Settings scrolls to an address's
  `#anchor` once the section is on the page (it is looked for up to 4 s) and again when the hash changes.
- SS-48 General's compact usage meter is gone with its helpers (nothing else used them).
- SS-49 Copy that named old places: the failed-turn card's link reads “Open AI settings”; the browser key's note “… · see
  Settings → This Whombat” (and the Vault's “See Settings → This Whombat.”); Usage's Sign in goes to `?tab=ai#accounts`
  and its help says “under Accounts”; “Settings → Connections → GitHub” (AI's GitHub pointer, an agent's REPOS, the
  feedback form's repository hint); an agent's Spend tab links “Settings → AI → Spend”; an agent's Model tab “Settings →
  AI”; Skills links “Agents → Skills”; `@whombat/client`'s refusals “An owner can add one in Settings → AI.” / “An admin
  installs it in Settings → AI.”, `SIGNIN_TEXT.tab` “AI”.

## Android, decided while building (SS-60…)

- SS-60 The phone's settings sheet is grouped as the web's tabs, with their names as headers and in their order, showing
  only the groups the phone has (`settingsGroups`): **Profile** (you, theme, your Vault), **Notifications** (Do not
  disturb and quiet hours; push labelled ON THIS PHONE), **AI** (YOUR AI SIGN-INS for self-hosted and managed alike,
  plus a managed Whombat's AI PROVIDERS, moved off This Whombat per SS-03), **This Whombat** (burrow, VERSION, the
  server and Switch server, or the managed Whombat with This Whombat, Devices and Switch Whombat). The phone has no
  Members or Connections page and gets none (members, invitations, GitHub and Google stay on the web); a managed
  Whombat's owners stay a card on This Whombat. The demo world shows Profile and This Whombat only.
- SS-61 VERSION on the phone is a card of rows: “This app · 0.36.0 · build 36000” (app.config's version and
  versionCode, what `hello` reports) and “Whombat · {runtime}” only when it is known — `appliance.status` on This
  Whombat, a managed runtime's `welcome`, or a self-hosted server's `/health` (admins only; members see the app row).
  It is first on This Whombat and in the sheet's This Whombat group; the connection row no longer repeats the version.
- SS-62 Skills on the phone stay per agent, as before, but read as skills: the agent screen's section is SKILLS
  (“Skills and packs”), the packs screen's kicker SKILLS; its pointers say “Agents → Skills” on the web.
- SS-63 This Whombat (managed) gets a DEVICES card that opens the Devices screen; the sheet keeps its Devices button.
  Push and AI sign-ins leave This Whombat (they are in the sheet's Notifications and AI groups).
- SS-64 Short roles (SS-22) on the phone: the Agents tab, the Channels tab's DMs, the `@` list and Share targets show
  `shortRoleLabel`; TalkBack keeps the full title (row labels, avatars), and the agent screen, DM header, hire screen
  and the plan owner picker keep the full title.

## SS-70 Release 0.37.0

whombat-app 0.37.0 ships SS-01…SS-64 (web and Android) and the report rows (`report-rows.md` RR-01…RR-08), with
contracts 0.45.3 (CT-262: the Settings copy). A runtime from before Whombat's SS-W01…SS-W05 still names the old places
in its own messages (“Settings → AI accounts”, “Settings → Repositories”); the old `?tab=` addresses redirect (SS-02).

## SS-71 Update available on the phone (0.37.1)

John, 2026-10-04: DEV published APK 0.37.0 and his phone said nothing. By design (AP-701) the phone only spoke when it
was too old for its Whombat or couldn't show something; a newer build that nothing needed stayed silent. Now, when the
APK control hands out (`downloads.android`, asked as a session opens and hourly) is newer than this build
(`useAppUpdate`): a calm card “Update available · 0.37.1 · 58 MB · Download and install it over this app.” with
**Update** (opens the APK's URL; Android installs it over the app, the sign-in stays) first in the settings sheet and
first on This Whombat, and a green dot on the Inbox avatar that opens the sheet (TalkBack: “Settings for Mara, Update
available”). The dot overlaps the avatar by margin, not absolute position (the reading-order audit). The notices that
say an update is *needed* keep their words and tone. Phones on 0.37.0 or older don't have this yet: they get 0.37.1 by
hand once, then are told about every later build.
