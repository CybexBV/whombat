# Workstream: web shell (`apps/web`)

TODO 4.1–4.4 and the per-user theme persistence left open by 1.1 (TP-05). Builds on
`tokens-primitives.md`, `avatars.md`, `client.md` and `core-contracts.md`.

## Layout of `apps/web/src`

```
app/
  App.tsx            services + router + providers; 401 → /login?redirect=…
  services.ts        client, realtime, query cache; fixture mode switch
  fixtureFetch.ts    fixture world + local account endpoints
  providers.tsx      WhombatClientProvider, ThemeProvider, ToastProvider, useAppServices()
  router.tsx         the route tree (the only file that knows every screen)
  routing/           typed search params, search-param navigation helpers
  shell/             BurrowShell, Sidebar, pane/modal hosts, keyboard, sidebar model
  auth/              /login, /login/verify, AuthLayout
  pages/             /mobile
features/<feature>/  one folder per feature, each exporting named screens (placeholders for now)
components/          primitives (+ Placeholder for unbuilt screens)
```

## Decisions

| # | Decision | Reason |
|---|---|---|
| WS-01 | **Screens take plain props; only `router.tsx` reads params and search.** Each feature folder exports named components (`ChannelScreen({burrow, channel, threadId})`, `AuditLogScreen({actor, kind, who, open, onChange})`, `ThreadPane({…, onClose})`, `ApprovalModal({number, open, onOpenChange})`…). The router passes typed values and callbacks that write the URL. | Feature workstreams replace one folder without touching the router; screens stay Storybook-friendly. |
| WS-02 | **Panes and modals are URL state.** Thread pane = `?thread=` on channel / DM / branch room; agent profile = `/:burrow/agents/:agent` over the roster; approval modal = `?approval=<n>` on any burrow page; hire modal = `?hire=1` on the roster. The shell's `PaneHost` / `ModalHost` render them (`SidePane` frame; the feature renders the contents). The branch room's CHECKS/REVIEWERS pane is part of `BranchRoomScreen`, as in the mock (it sits inside `<main>`). | Deep links, reload and back button work for every pane and modal (ARCHITECTURE "Web app"). |
| WS-03 | Search params are validated forgivingly: unknown or malformed values are dropped, defaults are left out of the URL (`?tab=conversation`, `?actor=everyone`, `?kind=all`, `?type=all` never appear). Log and search filters reuse the core enums (`AuditActorFilter`, `AuditKindFilter`, `SearchFilter`). Filter edits replace the history entry; opening panes and modals pushes. | Old or hand-edited links still open; clean URLs. |
| WS-04 | `/` → the first membership's burrow (none → `/onboarding`); `/:burrow` → its first sidebar channel (none → roster). A burrow the account is not in redirects home. Invalid `:number` params are a quiet not-found page. | "Redirect to the user's first burrow". |
| WS-05 | **Esc order**: route modal → pane → search (back to the page search was opened from, else the burrow home). When a Radix dialog is on screen it closes itself on Esc (and writes the URL through `onOpenChange`); the shell then does nothing, so one Esc never closes two layers. Handlers that consume Esc call `preventDefault()`; the shell ignores prevented events. | README "Esc closes search/modals/panes"; no double closes. |
| WS-06 | **⌘K and Ctrl K both work everywhere** (B-03); the hint shows ⌘K on Apple platforms, Ctrl K elsewhere. When search is open, ⌘K focuses the element marked `data-search-input` (the search workstream sets it). **Alt+↑/↓** step through CHANNELS → BRANCH ROOMS → DIRECT, wrapping. | Spec + the optional shortcut. |
| WS-07 | Sidebar rows are **links** (`aria-current="page"` when selected), not buttons, because they navigate. Weights follow the mock exactly: channels 400 / 600 when selected or unread; branch rooms mono 400 / 500 selected; agents 500 always; DMs 400 / 600 selected; nav 500 / 600. The unread badge hides on the selected channel. Section titles are `h2`s; status dots carry labels ("Working", "Open · changes requested"); the unread badge has screen-reader text. | Accessibility rules in CLAUDE.md without visual change. |
| WS-08 | **DM rows show no unread badge** (the mock's DIRECT rows have none, even though the fixture Pippa DM has 1 unread); the count is in screen-reader text only. | Mocks win on visuals. Revisit if DMs need a visible badge. |
| WS-09 | Lucide icons replace the mock's placeholder glyphs in the search button and nav (TP-14). The search icon is 16px inside the mock's 11px glyph box so the label keeps its x position. With "Ctrl K" (28px wider than "⌘K") the search label may run into the 10px gap instead of wrapping. | Pixel parity for the text; no wrap on non-Apple platforms. |
| WS-10 | *Superseded in part by ui-refresh-status.md UIR-08: the row leads to Settings, ⋯ opens the account menu.* The footer's user row is a button that opens a one-item account menu (**Sign out**). "Mobile app →" links to `/mobile`, an info page in the sign-in frame, until there is a download. | Logout needs a home; the mock has no account UI. |
| WS-11 | **Sign-in** (`/login`, not mocked) uses the onboarding frame: aside with logo and Clover's tip bubble, `STEP 1 OF 2` kicker, 44px title. Email → "Check your email" → 6-digit code (auto-submits at 6 digits, "Send it again", "Use a different email"). The magic link lands on `/login/verify?token=` (the server's link). Both continue to `?redirect=` (same-app paths only), else the server's `redirectTo`, else the first burrow. `/login` redirects away when already signed in. | README "Onboarding" visual language; server-core's link format. |
| WS-12 | Session handling: routes guard with `ensureQueryData(auth.session)`. Any 401 (HTTP or socket) marks the cached session signed-out and sends the user to `/login?redirect=<current>`. Sign-out calls `auth.logout`, closes the socket, then drops every cached query except the session. | One source of truth for "signed in", no stale burrow data after sign-out. |
| WS-13 | **Realtime per burrow**: `createRealtime({ url: () => realtimeUrl() + '?burrow=<slug>' })` (C-09), opened by the burrow shell (`WhombatClientProvider connect={false}`), subscribed to `bootstrap.realtime.topics`, closed when leaving the burrow. `bindBrowserLifecycle` is bound once in `App`. The sidebar reads only the bootstrap query, which the client's reducers keep live (unread, agent status, PR status). | The socket needs the burrow slug; nothing to connect to before sign-in. |
| WS-14 | **Theme per user**: the shell passes `bootstrap.preferences.theme` to `useThemePreferenceSync` (`system` = no server choice, keep the local one) and saves toggles with `PATCH /me/preferences`, patching the cached bootstrap. Pages outside a burrow use the local choice. | Closes TP-05. |
| WS-15 | **Fixture mode**: `VITE_FIXTURES=1` (`pnpm --filter @whombat/web dev:fixtures`), Storybook and tests use `createFixtureFetch()` behind a small web wrapper that answers the account endpoints (session, magic link, verify, logout, `/me`, preferences) and keeps preferences in memory. Any email and any 6-digit code sign in as Mara. No socket. The fixture world is not changed: it has one DM and one canvas (FX-02, FX-15), so the fixture sidebar shows "Canvases · 1" and no Hazel DM. | The fixtures package owns the world; the shell renders whatever the bootstrap says. |
| WS-16 | Dev builds expose `window.__WHOMBAT__ = { services, router }` (visual tests patch the cached bootstrap to the mock's data; debugging). | The visual spec compares layout row for row without changing the fixture world. |
| WS-17 | **Burrow name = burrow switcher; burrow actions live in the account menu.** The burrow-name button opens “Your burrows” (a `nav` of links to `/:burrow` for every `session.memberships` entry, the current one `aria-current="page"` with the selected-row look). The footer account menu shows **Burrow settings** and **Start a new burrow** (locked with `BURROW_CREATION_LOCKED` when the account may not create burrows) above a divider, **only to owners of the current burrow** (`membership.role === 'owner'`); then notifications and Sign out. Supersedes the burrow-name dropdown of web-push-connect and extends WS-10. Members no longer have a link to `/:burrow/settings` (the route still works). | Product call (2026-09-24): the burrow name switches burrows; managing a burrow is an owner action. |

## Verification

- `pnpm visual` (`apps/web/visual/shell.spec.ts`): the sidebar column of `/burrow-hq/c/billing-v2` in fixture mode
  vs `pnpm ref:shot --file desktop --screen channel`, 1440×900, frozen clock, light and dark. The bootstrap is
  patched to the mock's data (Hazel DM, "Canvases · 4"), the page reports macOS (⌘K), and the four Lucide icon
  slots are masked. Result: every text, badge, dot, row and spacing matches; the remaining 0.1 % is avatar
  anti-aliasing at 26px (AV-02). Diffs are written to `tmp/visual/`.
- `pnpm e2e` (`apps/web/e2e/login.spec.ts`): starts a real server on a throwaway database
  (`whombat_e2e_<hex>`, seeded with `pnpm db:seed`, dropped afterwards; `e2e/support/server.mjs`), signs in by
  code and by magic link (read from the server log), checks the socket opens, reloads, signs out. Needs
  `docker compose up -d`. Ports: `WEB_E2E_PORT`, `E2E_SERVER_PORT`, `WEB_VISUAL_PORT`.
- Unit/integration (`pnpm check`): routing and deep links for every route, search-param validators, sidebar
  model and rendering from the fixture bootstrap, live updates through `applyRealtimeEvent`, theme
  persistence, keyboard (⌘K / Ctrl K, Esc order, Alt+↑/↓), sign-in / magic link / sign-out / 401 with a mocked
  server.
