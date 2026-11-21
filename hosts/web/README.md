# Rackoon web UI

React 19 + TypeScript (strict) + Vite, plain CSS on the design tokens, TanStack Query, React Router 7.
The Go hub serves the built `dist/`.

```sh
mise exec -- pnpm install
mise exec -- pnpm dev:fixtures   # UI on :5173, /api/v1 (HTTP, SSE, console WebSocket) mocked in dev/fixtures
mise exec -- pnpm dev            # UI on :5173, /api (HTTP + WebSocket) proxied to the hub on 127.0.0.1:8080 (RACKOON_HUB overrides)
mise exec -- pnpm build          # tsc -b + vite build -> dist/
mise exec -- pnpm test           # vitest: thresholds, formats, metrics, console framing/paste, webauthn, fixture tests
```

## Fixture mode

Read endpoints come from `docs/handoff/sample-data` (the fixtures' clock, `as_of` = 2026-10-11T14:00:00Z, is
kept; `FIXTURE_TIME=live` shifts every timestamp so the data looks current). Everything else is mocked in
`dev/fixtures/` with **per-browser state** (cookie `rackoon_fx`, so parallel Playwright tests do not see each
other): auth, enrollment (an agent "calls in" about 4 s after `POST /enrollments`), agents, server settings,
alerts, audit (about 250 seeded records, cursor paging, CSV), power actions (guest state changes, SSE
`action.finished`), thumbnails (SVG drawn from the mockup tiles), screenshots and the SSE stream.

- Page toggles: `?setup=1` (first-run setup, token `fixture-setup-token`), `?signedout=1`, `?role=viewer|operator|admin`,
  `?reauth=1` (the next sensitive change asks to confirm the password), `?assistant=1` (the assistant on, Claude Code and
  Codex installed, four investigations seeded; `?assistant=nosandbox` likewise with an unsandboxed runner; it is off
  otherwise, so the other pages look as before). Any password except `wrong-password` signs in; passwords need 10
  characters, like the hub.
- Console WebSocket (Vite `upgrade` handler, CONTRACT 4 framing): `shell` / `tty` / `serial` get a fake shell
  (`help` lists its commands; `simulate-drop`, `simulate-idle` and `simulate-error` exercise the lost and closed
  states). `vnc` / `spice` answer with an `error` control explaining that graphical consoles need a hub.
- `FIXTURE_CONSOLE_IDLE_S` sets the idle timeout (default 900).
- `FIXTURE_CONSOLE_RELAY="vnc=127.0.0.1:5900,spice=127.0.0.1:5930"` relays those protocols to real servers
  (channel 0 to one TCP connection; each SPICE `open` to a new one). With a QEMU started as
  `qemu-system-x86_64 -vnc 127.0.0.1:0 -spice port=5930,addr=127.0.0.1,disable-ticketing=on -vga qxl ...`
  this exercises noVNC and spice-html5 end to end without a hub or agent.

## Against a hub

```sh
rackoon-hub serve --data /tmp/hub --listen 127.0.0.1:18080 --agent-listen 127.0.0.1:18443 \
  --public-url http://127.0.0.1:18080
rackoon-sim --ui http://127.0.0.1:18080 --admin-user <user> --admin-pass <password>   # simulated agents
RACKOON_HUB=http://127.0.0.1:18080 mise exec -- pnpm dev
```

The dev proxy keeps the browser's `Host` header, so the hub's Origin check accepts the console WebSocket without
`--allowed-origins`. The first start prints `Open http://…/setup#token=…`; the setup page reads the token from
the fragment.
`rackoon-hub serve --web-dir web/dist` serves a production build (with the hub's CSP).

## Remote console (`src/features/console/`)

- `frames.ts`: the frame format (`kind | uint16 channel | payload`) and `ConsoleControl` JSON.
- `transport.ts`: one WebSocket per session (`["rackoon.console.v1", "rackoon.token.<token>"]`), channel 0 open on
  `status`, extra channels via `open` / `opened`, each exposed as a WebSocket-like `VirtualSocket` (data that
  arrives before a client listens is held for it), ping every 5 s (latency = round trip), `activity` at most
  every 30 s and only on real key / mouse input, hub `closed` reasons.
- `useConsoleSession.ts`: `POST .../console-sessions` → socket → connecting / connected / lost / failed;
  reconnect = new session; switching guests passes `switch_from` and keeps the old session open until the new
  one is granted (the hub audits `console.switched` and closes the old one).
- `clients/`: `TerminalScreen` (xterm.js, `--term-*` theme, Geist Mono at 1.7% of the screen width, ≥ 12 px,
  `resize` on every fit), `VncScreen` (noVNC `RFB` on channel 0, security None, scale to fit, Ctrl+Alt+Del, paste
  typed as keysyms with Shift held for shifted characters), `SpiceScreen` (spice-html5, one session channel per
  SPICE channel, scaled with a CSS transform so pointer coordinates stay in guest pixels). All three load lazily.
- `ConsolePanel.tsx`: header, toolbar, 16:10 screen (Tab stop; click or Enter captures keys, Ctrl+Alt releases,
  Esc leaves fullscreen), status line, hint, side list, every state of REMOTE-CONSOLE 12. `powerActions.ts` +
  `ConsoleDialogs.tsx`: confirmation naming guest and action (Force stop / Stop: `--serious` and type the name),
  `confirm: true`, pending chip until SSE `action.finished`. `paste.ts`: 64 KB cap, control characters stripped
  unless the user picks a raw paste; the clipboard is read only in the Paste click handler.
- `ScreensWall.tsx` + `useThumbnail.ts`: thumbnails every 5 s only while the tile is in the viewport and the tab
  is visible, one request in flight per tile, object URLs revoked.

Third-party console clients: [xterm.js](https://xtermjs.org) (MIT) and [noVNC](https://novnc.com) (MPL-2.0) from
npm; **spice-html5** (LGPL-3.0-or-later) is vendored in `src/vendor/spice-html5/` with its license texts
(`COPYING`, `COPYING.LESSER`); the production bundle contains it minified and this directory is its
corresponding source. `README.rackoon` there lists the upstream commit and the local patches (socket factory,
no automatic focus, clipboard sharing off, a stale-surface fix after guest resets).

## Visual and end-to-end checks

Run inside the official Playwright image (version matches `@playwright/test` in package.json). With
`pnpm dev:fixtures` running on the host (or let Playwright start it inside the container):

```sh
cd ..   # repository root
podman run --rm --network host -v "$PWD":/work -w /work/web \
  mcr.microsoft.com/playwright:v1.64.0-noble npx playwright test -c scripts/playwright.config.ts
```

`SCREENSHOT_PORT=<port>` points the specs at another fixture server.

- `scripts/screenshots.spec.ts`: full-page screenshots of every page and tab at 1440 and 390 px into
  `.screenshots/` for review (`node scripts/slice.ts <png> <dir>` cuts tall PNGs into slices) and fails on
  horizontal page overflow. The hand-off screenshots describe the first UI; since the 2026-10-13 redesign
  (NOTES.md "UI v2") they no longer match by design.
- `scripts/interactions.spec.ts`: URL state, the hosts table and Watch panel, host tabs, the guests tab with
  the console side panel, the Guests page, the command palette, host pills, the phone bottom bar and sheets,
  chart keyboard navigation, old addresses, and axe-core WCAG 2.2 AA scans.
- `scripts/console.spec.ts`: console open / switch / close over the mock WebSocket, keyboard capture and
  release, lost connection and Reconnect, idle timeout, protocol unavailable, stopped guest and Start, power
  confirmations, action errors, paste sanitization and the 64 KB cap, Copy output, session limit, remote
  control off, Screens wall visibility rules, axe scans, and screenshots of the console states.
- `scripts/guest-page.spec.ts`: the guest page (docs/MANAGE.md): open by URL, edit with the review step and the
  pending-changes banner, add and resize disks, tags, cloud-init SSH keys, Incus limits, read-only keys, a change
  made meanwhile, field errors from the hub; axe scans (dark and light) and screenshots (`guest-*.png`).
- `scripts/admin.spec.ts`: sign-in, setup, sign-out, enrollment dialog, Settings › Agents (list, approve/
  reject, a server's page with remote control, edit, delete), Alerts, Settings › Account (password, passkeys
  incl. a CDP virtual authenticator on `http://localhost`), Settings › Audit log (paging/filters), viewer
  access: screenshots (`admin-*.png`), interactions and axe scans.
- `scripts/assistant.spec.ts`: the assistant (docs/ASSIST.md): Settings › Assistant (install with progress, sign in with
  a token and with Codex's device code, settings, re-authentication), Investigate on alert rows and the Watch panel, Ask
  assistant from the host header and the command palette, the investigation panel (live transcript over SSE, tool steps,
  approve and decline, replies, Stop, Delete, Escape and focus), phone width, the Diagnostics switch, axe scans (dark and
  light) and screenshots (`assistant-*.png`). Fixture routes: `dev/fixtures/assist.ts`.
- `scripts/guest-lifecycle.spec.ts`: managing guests, lifecycle half (docs/MANAGE.md 4): create a VM, a container
  and an Incus instance, clone from a template, back up and restore, storage contents and downloads from a URL,
  the task dialog (log, Stop), firewall rules, HA and replication, bulk power actions, the tag filter and delete; screenshots
  (`lifecycle-*.png`, also light) and axe scans at 1440 and 390 px. Fixture routes: `dev/fixtures/lifecycle.ts`.

## Layout

- `src/api/`: types (`types.ts`, fixtures + CONTRACT additions), client (CSRF, problem+json errors, dev-only
  shape validation, reads revalidated with `cache: 'no-cache'`), TanStack Query hooks (10 s refresh), SSE hook
  (`onServerEvent` for payload listeners).
- `src/lib/`: `thresholds.ts` (PRODUCT-SPEC 5), `format.ts` (SCREENS 7, viewer time zone), chart path helpers,
  URL state, `markdown.tsx` (the assistant's answers as React elements, never HTML; links http(s) only).
- `src/components/`: shell (top bar with host pills, bottom bar and sheets on phones, command palette,
  account menu, an error boundary per page), segmented control, meters, sparkline, `TimeChart`, `Modal`
  (native `<dialog>`), `Toast`, form fields.
- `src/features/fleet` (overview: hosts table, Watch panel, workloads, capacity), `server` (host page with
  tabs: summary, guests, storage, sensors, virtualization; agent tab from `agents`), `guests` (fleet-wide
  list), `guest` (the guest page: header, summary, configuration tabs whose edit dialogs end in a review step;
  `props.ts` edits property strings without losing unknown options). `console`: see above (the panel's `compact` mode is the side panel). `auth` (login, setup,
  WebAuthn), `agents` (enrollment dialog, Settings › Agents and a server's settings page), `alerts`,
  `settings` (layout with its side menu, account and passkeys, audit log), `assistant` (Settings › Assistant, the
  investigation panel the shell shows for `?investigation=<id>` on any page, Investigate / Ask assistant; API and SSE
  cache updates in `src/api/assist.ts`).
