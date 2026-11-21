# Threads full width, the Vault in the sidebar, one Settings link, Connections as an overview (AP-670…AP-673)

John, 2026-10-03, four changes:

1. “When I am in a channel and I open a thread, the thread should be expanded by default.”
2. “At Settings we have the Vault, I want the Vault to be shown in the sidebar by default, under Automations.”
3. “When you click on the username (sidebar, bottom), it opens a context menu. This context menu shows direct links to
   tabs in the Settings menu. Remove those direct links, only keep 1 link to ‘Settings’.”
4. “Change the ‘Connections’ tab to show an overview of the connections made … In the near future we will add many
   more connections, so this tab needs to be redesigned to be able to show all those connections. I would like to show
   a rich version of the connections, meaning I want the logo of the service included.”

None of these screens is in the mocks (B-05); they keep Settings' page language.

## AP-670 A channel's thread opens full width

- Opening a thread from a channel (the “N replies” link, “Reply in thread” in the toolbar or menu) opens it in focus
  mode, `?thread=<id>&focus=1` (AP-304): the thread takes the conversation's place, “← Back to #channel” and the
  collapse button show it beside the channel, Esc collapses first. The replies link's `href` carries `&focus=1` too, so
  a new tab opens it the same way.
- Channels only, as asked. A DM, a direct conversation and a branch room keep the split view: there the conversation
  beside the thread is the point (a DM is short; a branch room has its tabs). The pins pane, a plan's lanes and links
  from elsewhere (inbox, search, pushes) open what their address says, unchanged.

## AP-671 The Vault is a page in the sidebar, under Automations

- `/vault` (`?entry=vlt_…` for an open entry), a page of its own with Settings' header: “Vault”, the Vault's intro as
  the subtitle, then YOUR ENTRIES and HOME NETWORK as they were. The sidebar row “Vault” (lucide `KeyRound`, AP-674) sits under
  Automations (after Canvases while Automations is hidden), selected on `/vault`, shown wherever the Whombat has the
  `vault` feature: “by default”, nothing to switch on.
- Moved, not copied: Settings has no Vault tab any more. `/settings?tab=vault[&entry=]` — agents' messages, older
  clients, bookmarks — redirects to `/vault[?entry=]` (`replace`). `BURROW_ROUTES` gains `/vault` (so a burrow called
  “vault” is read as the screen, AP-362). Android opens its inbox for `/vault`, as it did for `?tab=vault`.
- Copy follows: the agent profile's “Give it a login or an API key in the Vault”, the phone's “Test the sign-in on the
  web, in the Vault.”, and contracts 0.40.1 (CT-242) for the shared copy and the agents' instructions (Whombat
  `docs/decisions/settings-sidebar.md`).
- The visual comparisons with the mocks hide the row (`[data-nav-vault]`, like `[data-nav-work]`); the Vault's
  baselines are now of the page.

## AP-672 The account menu has one Settings link

- The menu under your name: **Settings** (everyone; was “Burrow settings”, owners only), Start a new burrow (owners),
  a divider, Turn on/off notifications, Sign out. Notifications, Connected accounts, AI accounts and Vault are gone from
  it: Settings' tabs have them, the Vault is in the sidebar.
- The do-not-disturb moon beside your name still goes to Settings → Notifications: it is a state, not a menu link.

## AP-673 Connections: an overview, then a page per provider

- `?tab=connections` is the overview: an intro line (“Connect your own accounts, and your assistant works with them as
  you, in every burrow.”), **CONNECTED** — one link row per connection: the provider's logo, “Google · address”, its
  services (or why it needs connecting again), the state with its dot, a chevron — and **ADD A CONNECTION**, a tile per
  provider not connected yet (logo, name, what it brings, a button: Connect, Set up for an admin while the provider
  isn't set up, View for others), in a grid that wraps (`auto-fill`, 260px). Empty CONNECTED says “Nothing connected
  yet.”; with nothing left to add, ADD A CONNECTION isn't shown; Google turned off says so instead of both.
- `?tab=connections&connection=google` is the provider's page: “← All connections”, its logo, name and line, then what
  the tab had (GOOGLE APP — was GOOGLE — with the guided setup for admins, YOUR ACCOUNTS, TROUBLESHOOTING). Google's
  answer after connecting opens Google's page: the return path is `…&connection=google` now, and an older return
  path (only `connected=`/`connect_error=`) opens it too and keeps it open once the answer is off the address.
- Providers come from the contracts (`CONNECTOR_PROVIDERS`); the web keeps each one's name, line and logo in
  `features/connectors/providers.tsx`. A provider the contracts add appears in ADD A CONNECTION once it has an entry
  there (and its own page). GitHub stays in Settings → Repositories (AP-540): it connects repositories, not an
  assistant.
- Logos are the providers' own marks, drawn inline in their own colours on a bordered tile (40px; 48px on the page):
  the one place hex colours stand outside the tokens, as the README's fixed colours do. Never fetched (strict CSP,
  boxes offline).
- Fixture mode serves `/connectors` only with `VITE_FIXTURE_CONNECTORS=connected|none` (`connectorFixtures.ts`), so
  the shared world and its visual comparisons stay as they were.

## AP-674 The Vault's sidebar icon is a key

- John, 2026-10-03: the Vault row uses lucide `KeyRound` instead of `Vault`. It is the existing `key` slot in
  `iconSlots`, so the row goes through `NAV_ICONS` like Agents and Canvases. Android's Vault has no sidebar icon.
