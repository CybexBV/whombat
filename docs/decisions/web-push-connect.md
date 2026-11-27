# Workstream: web push + connect (`apps/web/src/push`, onboarding step 2, `/:burrow/settings`)

TODO 9.4 (desktop half) and the web entry points `github.md` hands off to "the web workstreams". Builds
on `notifications.md`, `github.md`, `web-shell.md` and `canvas-onboarding.md`.

## Desktop push (NT-12 follow-up)

- **SW registration is unconditional; subscribing is the opt-in.** `useServiceWorkerRegistration()`
  (`apps/web/src/app/shell/hooks.ts`) calls `navigator.serviceWorker.register('/sw.js')` once from
  `BurrowShell`, behind a `'serviceWorker' in navigator` guard, with no permission prompt. This just
  gets `sw.js`'s `notificationclick` deep-linking and future push delivery ready; it does not touch
  `Notification.permission` or `PushManager`, so nothing pops on page load.
- **Superseded by `docs/app/decisions/account-menu.md` ACM-06 and ACM-07** (notifications come on by themselves where
  the browser allows them; the Chat asks once; Settings → Notifications has the switch). **The opt-in lives in the account menu** (`UserFooter` in `Sidebar.tsx`), not a one-time inline
  banner: it is the same menu that already holds "Sign out", matches WS's "quiet, in the same visual
  language" requirement, and does not compete for space with onboarding or the roster. A menu row
  reading "Turn on notifications" / "Turn off notifications" calls `Notification.requestPermission()`
  only on click (a user gesture), never automatically.
- **Device id is account-scoped, kept in `localStorage`** (`whombat:push-device-id`), because
  `POST /devices` has no `burrow` param (`RegisterDeviceBody` — devices belong to the signed-in
  account, not a burrow) and there is no `devices.list` read endpoint to recover an id after a reload.
  A stale id (e.g. the account signs in on a second browser) fails `devices.remove` with `not_found`,
  which `useWebPush()` treats as already-off rather than surfacing an error.
- **Superseded in part by `docs/app/decisions/account-menu.md` ACM-06** (one state per Whombat, read once a page, with
  the Whombat's own answer whether this browser is registered). **Status is derived from `PushManager.getSubscription()`, not from server state**, each time the menu
  opens/the hook mounts: the source of truth for "is *this browser* subscribed" is the browser's own
  subscription, not our device row (which could also represent a different browser on the same
  account). `packages/core` has no read endpoint for "is this device registered" and adding one is out
  of scope for a desktop-only opt-in row.
- **`apps/web/public/sw.js` is unchanged.** It already shows the push and deep-links
  `notificationclick` via `data.path` (NT-12); this workstream only registers and subscribes it.

## "Needs you" indicator

- **Sidebar row, not a new nav concept**: added to `SidebarModel.nav` between "Canvases" and "Audit
  log" — reuses the existing `NavRow` shape (`bell` icon, `sidebar.counts.needsYou` as `meta`) and
  reuses the Audit log's `?kind=asks` filter... **correction, see below**: `AuditKindFilter` doesn't
  have a `needs_you`-equivalent value that maps 1:1 to the notification kind, and the inbox itself
  isn't a route on desktop (mobile owns `/inbox`). Rather than invent a desktop inbox screen (out of
  scope for this workstream) the row links to `/:burrow/log?kind=asks` — the closest existing desktop
  surface for "things waiting on a person" — and is only rendered when the count is non-zero, so it
  never draws an empty affordance the mock doesn't have.
- **Kept live by extending the existing `notification.created` reducer** in
  `packages/client/src/query/apply.ts` (shared file, additive only): when the event's `item.kind ===
  'needs_you'` and `!item.readAt` and this is the first time we've seen the event (`once()`), it also
  bumps `bootstrap.sidebar.counts.needsYou` by 1 via `patchEndpoint('conversations.bootstrap', ...)`.
  No decrement path is implemented — same accepted gap as the existing static `agents`/`canvases`
  counts elsewhere in the sidebar, which also don't live-decrement. A full read-state sync for the
  count would need a dedicated endpoint; out of scope here.
- **Toast** on new needs-you items: `needsYouToast()` (`packages/core/src/text/copy.ts`, unit-tested
  like the other toast helpers) fires from a `useRealtimeEvent('notification.created', ...)` listener
  in `BurrowShell`, gated the same way (first-seen, `needs_you`, unread, and — since a burrow can have
  many principals connected to the same socket — only when `item.principalId === bootstrap.me.id`).

## GitHub connect (onboarding step 2)

> **Superseded (2026-09-24) by `github-gh.md` ("Web"):** connecting is a call to the server (it checks the
> host's gh), not a round trip through GitHub, so `?github=` and its toasts are gone; `?burrow=&step=` still
> resumes a burrow being set up. The button placement and "no GitHub brand icon" below still hold.

- **Resume-through-navigation via URL search params.** `OnboardingScreen` keeps all progress in local
  `useState` with no persistence, but connecting GitHub is a full-page round trip (browser → GitHub's
  (or FakeGitHub's) install flow → `GET /api/v1/github/setup` → 302 back). `validateOnboardingSearch()`
  (`apps/web/src/app/routing/search.ts`) reads `?burrow=&step=&github=&reason=`; `onboardingRoute`
  passes them to `OnboardingScreen` as `resume` props. On mount, if `resumeBurrow` is set and local
  state has no `burrowSlug` yet, the screen fetches `onboarding.get` for that slug and hydrates
  `burrowSlug`/`repos`/`agents`/`selectedRoles`/`invites`/`step` from it, then clears the search params
  (replace) so a refresh doesn't re-fetch. `returnTo` sent to `api.github.status`'s `query.returnTo` is
  built as `/onboarding?burrow=<slug>&step=1` (not the server's `defaultReturn()`, which would land on
  `/onboarding` with no way to resume past step 1).
- **`?github=connected|error|requested`** surfaces as a toast (`githubConnectedToast()` /
  `githubErrorToast()` / `githubRequestedToast()`, `packages/core/src/text/copy.ts`) once resume
  hydration finishes (or immediately if already on the right burrow), then the params are stripped from
  the URL the same way.
- **"Connect GitHub" button placement**: the mock's step-2 repo card (`.repoCard`/`.repoRow`) is drawn
  for a burrow that already has repos — a freshly created burrow has zero until GitHub is connected
  (`onboardingState()` in `apps/server/src/read/work-views.ts`), so the mock has no "connect" affordance
  to match verbatim. We add a `secondary` `Button` ("Connect GitHub" / "Repos connected · Manage on
  GitHub" once connected) above the repo card, shown only when `!githubConnected`, using the existing
  `Button` component and step's own spacing token (`--space-16` gap) — same visual language, no new
  layout invented for the repo rows themselves, which are untouched.
- **No GitHub brand icon**: confirmed by inspecting the installed `lucide-react@1.47.0` — no GitHub
  glyph in its icon set. Text-only button, consistent with the "Add" button already on step 4.
- **Onboarding's write endpoints stay out of `createFixtureFetch()`'s `IMPLEMENTED` set** — same
  precedent as `canvas-onboarding.md`'s note on `onboarding.update`/`repos.update`/etc.: `github.status`,
  `repos.list`, `repos.update`, `repos.sync`, `devices.*` and `members.invite`/`revokeInvite` are all
  state-machine writes or account-scoped reads with no burrow-scoped fixture story, so the GitHub-connect
  and settings-screen tests use the same "mocked server, fall through to `createWebFixtureFetch()`"
  pattern as `OnboardingScreen.test.tsx`'s second `describe` block, rather than extending the shared
  fixture fetch.

## `/:burrow/settings` (not mocked)

- **Visual language: roster + audit, not a new style.** Header block copies `AgentsScreen`'s
  `.content`/`.head`/`.title`/`.sub` (`--max-roster`, `--space-40`/`--space-32`, `--type-page-title`);
  grouped lists (repos, members, invites) reuse the onboarding step 2 `.repoCard`/`.repoRow` /
  `.invitesCard`/`.inviteItem` pattern (border `--line`, `--radius-card`, `--sf` background, no border
  on the last row) — that pattern is itself "audit/roster" adjacent (`AuditLogScreen`'s day groups use
  the same bordered-list shape). No new component primitives; `Toggle`, `Button`, `RoleBadge`,
  `HumanAvatar` are reused as-is.
- **Route**: `/:burrow/settings`, a new leaf under `burrowRoute` (renders in `ShellLayout`'s `<Outlet
  />`, same as every other burrow screen). `parseShellLocation()` gets a `{ kind: 'settings' }` case so
  the shell's location model stays exhaustive; nothing currently keys off it for pane/modal state
  (`paneFor`/`modalFor` already default to `null` for unmatched kinds).
- **Reached from the sidebar burrow-name link**, which becomes a small dropdown (same pattern as
  `UserFooter`'s account menu — `open` state, Esc-to-close, blur-to-close): "Burrow settings" (→
  `/:burrow/settings`) and "Start a new burrow" (→ `/onboarding`, the link's previous sole behavior).
  Only owners see repos/GitHub-connect controls (`bootstrap.me` has no role field surfaced yet beyond
  what's needed elsewhere, so the screen shows them to everyone but the mutations 403 for non-owners
  the same way the server's `installLink()`/key checks already gate them — consistent with "signed
  event through the commit pipeline" being the actual enforcement boundary, not client-side hiding).
- **Every toggle/invite/revoke is a plain `useApiMutation` call** against the existing
  `repos.update`/`repos.sync`/`members.invite`/`members.revokeInvite` endpoints — no new contracts, no
  direct writes.
- **`useApiMutation` does not invalidate any query cache on its own** (unlike the specialised
  `useSetAgentKeys`/`useMarkRead`/etc. hooks) — `SettingsScreen` invalidates `queryKeys.repos.list(...)`
  and `queryKeys.members.list(...)` (from `@whombat/client/query`) itself in each mutation's `onSuccess`
  path, following the precedent in `CanvasScreen`. Any future screen built directly on `useApiMutation`
  needs the same explicit invalidation or its UI won't reflect a successful write.
- **Tests**: `SettingsScreen.test.tsx` uses the same "mocked server, fall through to
  `createWebFixtureFetch()`" pattern as `OnboardingScreen.test.tsx`. `webPush.test.ts` /
  `useWebPush.test.ts` mock `ServiceWorker`/`PushManager`/`Notification` via `vi.stubGlobal` on
  individual globals (`navigator`, `PushManager`, `Notification`) — never replace `window` itself with
  `vi.stubGlobal('window', ...)` in jsdom, since `window === globalThis` there and doing so severs
  `document`, breaking Testing Library's `render`/`waitFor`.
