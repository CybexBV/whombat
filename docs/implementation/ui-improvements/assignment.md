# Whombat UI improvements (2026-09-29): eight items from John

John raised eight items on 2026-09-29, reviewed the proposal below and greenlit it, including shipping to production
(“Implement this fully and apply to production afterwards as well”; “for any future questions use your best
judgement”). Decisions here are settled. Decide open details yourself, record them in the decision file of your
repository (see §5) and move on.

Repositories (all on `main`, all private, the maintainer account’s token per command for pushes, never change the global gh account):

| Repo | What | Version today |
|---|---|---|
| `~/Code/whombat-contracts` | `@whombat/core` (schemas, markdown parser, roles copy), `@whombat/protocol` | 0.22.4 (CT-147) |
| `~/Code/whombat-app` | web (`apps/web`), mobile (`apps/mobile`, Expo/RN), `@whombat/client`, tokens | app 0.12.2 (AP-291) |
| `~/Code/Whombat` | the runtime that runs on each Whombat box (`apps/server`, `apps/runner`, `packages/agent-runtime`) | runtime 0.2.0 |
| `~/Code/whombat-appliance` | candidates, harness, `release/ship` | candidate 0.19.4 |
| `~/Code/whombat-api` | hosted control/web/embed deploy (`infra/hetzner/deploy.sh`) | — |

Contracts reach the app and the runtime as vendored tarballs (`vendor/whombat-contracts/<version>/`), see each repo's
CONTRIBUTING/README for the release and vendoring commands.

## 1. The items and what to build

### 1. Agents screen shows the description, not “Just hired…”
- The runtime writes `HIRED_DOING` (`apps/server/src/commands/agents.ts`) at hire and nothing replaces it until work
  happens. Stop writing a placeholder: a new agent's `doing` is `''`. Migrate existing rows whose `doing` equals the old
  placeholder to `''`.
- The agent card on the Agents screen (web + mobile) shows the agent's job description (`agent.job`, the text shown in
  Hire an agent; fall back to `ROLE_JOBS[role]`) as its subtitle. While the agent is actually working (a live
  `currentRun`, or a non-empty `doing` while status is working), show that as a second, muted line (“Working: …”).
  Same rule on the profile pane.

### 2. Job title in the sidebar
- Agent rows in the sidebar (web) and the agents list/DM list (mobile): one line, **Name** then a muted `·` role title
  (`ROLE_LABELS[role]`, e.g. “Designer”); truncates with an ellipsis; `title` attribute / accessibility label carries
  the full “Swatch, Designer”. Personal assistants show “Assistant”. Rows keep their current height.

### 3. Burrow-less URLs
- Web routes drop the `/:burrow` prefix: `/agents`, `/agents/:agent`, `/c/:channel`, `/dm/:agent`, `/pr/:number`,
  `/runs/:number`, `/work`, `/canvases`, `/log`, `/search`, `/automations…`, `/settings`, etc. The open burrow is the
  one the session is in (hosted: the open appliance; self-hosted: remembered per browser, first burrow by default).
- Old URLs `/<burrow>/<rest>` keep working: they switch to that burrow if the person is a member and redirect to
  `/<rest>` (replace, not push). Links the system generates (emails, push notifications, Android app links, the
  runtime's `LinkRef`/URL builders, invites, feedback links) use the new form with `?burrow=<slug>` only where the
  link may be opened by someone in several burrows; the app consumes `?burrow=` and strips it.
- Reserved top-level paths no longer clash with burrow slugs; keep every existing auth/managed path (`/login`,
  `/appliances`, `/claim`, `/onboarding`, `/auth/verify`, …) working. Android app links (`assetlinks.json`, intent
  filters) and the mobile deep-link parser accept both forms.

### 4. Thread focus mode
- The thread pane header gets an expand button (lucide `Maximize2`, label “Open thread full width”); focus mode shows
  the thread as the main view with a header “← Back to #general” (or the DM/PR name). URL state:
  `?thread=<id>&focus=1`, so Back and a shared link work. Esc, the back link and a collapse button (`Minimize2`) return
  to the split view. Composer, replies, plan cards work the same in both modes. Mobile already shows threads full
  screen; nothing to do there.

### 5. Configure agent becomes a page
- Replace `ConfigureAgentModal` with a full configuration page at `/agents/:agent/settings` (tab in the URL:
  `?tab=`), reached from the profile pane's Configure button. Left navigation: **Profile** (name, avatar, job
  description, instructions), **Model & provider**, **Skills**, **Access** (keys, channels, repos, browser, Vault
  logins, connectors), **Workspace**, **Spend**, **Danger zone** (fire/remove). Audit every option the modal and its
  sections have today and move each one; nothing may be lost. Each tab saves on its own with a sticky save bar showing
  unsaved changes; leaving with unsaved changes asks. Uses tokens only, matches the app's existing settings screen style.

### 6. Feedback integration page
- “New integration” and editing an integration become a page (`/settings/feedback/new`, `/settings/feedback/:id`)
  instead of a modal, in steps: 1. Name & site (origins), 2. Where reports go (channel, assessor agent), 3. Widget
  (appearance, copy), 4. Install (snippet with copy button, “Send a test report”, health). Editing shows the same
  sections without the stepper. Every field of `IntegrationForm.tsx` today keeps working. Must fit at 1280×720 and on a
  phone-width viewport without clipped content.

### 7. Subscription usage (5-hour and 7-day) and alerts
- Read usage through the unmodified CLIs in their own flow (SUB rule: never read or copy credential files):
  - **Claude Code** (2.1.284): stream-json `control_request` subtype `get_usage` with `skip_behaviors: true` (no model
    turn; response `rate_limits.five_hour|seven_day|seven_day_opus|seven_day_sonnet` `{utilization 0–100, resets_at
    ISO}` and `subscription_type`; experimental, so tolerate its absence), plus every turn's `rate_limit_event.
    rate_limit_info` (`status`, `resetsAt`, `rateLimitType`, `utilization`, `unifiedWindows.five_hour|seven_day
    {utilization 0–1, resetsAt unix}`). Add the fields to the fixture/`USED_BY_WHOMBAT` table.
  - **Codex** (0.159.0): app-server `account/rateLimits/read` (on demand) and the `account/rateLimits/updated`
    notification during turns (`primary`/`secondary` windows with `usedPercent`, `windowDurationMins`, `resetsAt`;
    plan type).
  - A usage probe runs per connected subscription (per person, per provider) at most every 15 minutes while it has
    been used in the last 24 h, hourly otherwise, and on demand from the page (rate-limited, 1/min per subscription);
    turns update it for free. API-key credentials have no windows: show “Pay as you go — see Spend”.
- Store the latest snapshot per subscription (new table, migration in the runtime), not a history.
- **Who sees what**: every member sees their own subscriptions (Settings → Usage, and a compact meter next to the AI
  provider in Settings → General); owners/admins also see a table of everyone's (person, provider, plan, 5-hour bar,
  7-day bar, resets in …, as of …). Stale data says “as of 14:32”.
- **Alerts**: the owner's personal assistant posts in their DM when a window crosses 80 % and 95 %, and when a limit
  was hit (a turn refused): once per window per threshold until that window resets. Recipients: the subscription's
  owner, and every burrow admin/owner (an admin's assistant tells them “Jamie's Claude subscription is at 85 % of its
  5-hour limit, resets at 16:00”). Copy with curly quotes, `·`, times in the person's locale.
- Contracts: the usage snapshot schema, the endpoint(s) and realtime event, all in `@whombat/core`.

### 8. Rich rendering: Markdown, HTML, images, media
- **Markdown** (contracts parser `packages/core/src/text/markdown.ts`, keep it pure and forgiving; `rich-messages.md`):
  GitHub-flavoured tables (alignment), task lists (read-only checkboxes), heading levels 1–6, nested quotes, fenced code
  with a language label and syntax highlighting on web (a small highlighter, lazy-loaded), `mermaid` fences rendered as
  diagrams on web (lazy-loaded, in the sandbox of the HTML preview or via mermaid's strict security level), autolinks
  as today. Keep chat semantics (single newline = break). Keep the curly-quote rule.
- **HTML**: a fenced `html` block holding a document or a fragment (not just SVG), a raw `<!DOCTYPE html>`/`<html>`
  paragraph, an `.html`/`text/html` attachment, or an HTML file an agent attaches, renders as a **preview card**: the
  live page in a sandboxed frame (fixed height with “Open full screen”, “View source”, “Download”), title from
  `<title>`. Security (John's choice): scripts may run; https images, styles and fonts may load; nothing can send data
  out (`connect-src 'none'`, `form-action 'none'`, no top navigation, no popups, no same-origin). Implementation on web:
  an `<iframe sandbox="allow-scripts">` (never `allow-same-origin`) loading a static `/sandbox/html-frame.html` served
  with its own Content-Security-Policy (`default-src 'none'; script-src 'unsafe-inline' https:; style-src
  'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src
  'none'; form-action 'none'; frame-src 'none'; base-uri 'none'`) that receives the HTML by `postMessage` from the
  parent (check `event.source`) and writes it. The hosted build's CSP gets `frame-src 'self'` (and nothing else wider);
  `_headers` gets a rule for `/sandbox/*`; make sure every server that serves the web build honours it (hosted web on
  Hetzner, the dev stack, the box's own local web if any, the legacy monolith). Mobile: `react-native-webview` with
  the same CSP injected as a meta tag, JavaScript on, `originWhitelist` limited, no navigation outside
  `about:blank`/data, `setSupportMultipleWindows={false}`; if adding the native module is not possible in this
  release, mobile shows the card with “View source” and records why.
- **Images**: every image attachment and `![]()` inline (PNG, JPEG, GIF, WebP, AVIF, SVG through `<img>`), several
  images as a gallery grid, the existing lightbox. **PDF**: inline first-page preview or an embedded viewer on web,
  chip on mobile. **Audio/video**: native players for common types.
- Test case: Swatch's logo page on production (not reachable read-only: the box is sealed). Use a representative page:
  a logo presentation with inline SVG, `<style>`, a Google Fonts `<link>` and a small script, sent as a fenced `html`
  block and as an `.html` attachment. Both must render.

## 2. Hard rules

- CLAUDE.md of each repo applies (tokens only, verbatim copy style, accessibility, contracts first, commit trailer
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`).
- `export TMPDIR=~/.cache/wb-tmp` (host `/tmp` runs out of inodes). Other agents run at the same time: use free ports,
  your own throwaway databases, never stop, reset or `down -v` shared containers, never stop the container
  `whombat-prod-cloudflared-1`.
- Work in your own git worktree on your own branch; commit small; do not merge into `main`, push, deploy or publish —
  the lead does that. Do not touch production.
- Pass the repo's full check (`pnpm check`, and `pnpm test:server` for runtime server code) before you report.
- UI: verify visually (Playwright screenshots at 1440×900, light and dark; phone width for mobile-facing web) and
  include the screenshot paths in your report.

## 3. Workstreams

| ID | Repo(s) | Items | Depends on |
|---|---|---|---|
| C | contracts | parser (8), usage schemas + endpoints (7), anything else the others need | — |
| U1 / U5 / U6 | app (web + mobile) | 1, 2, 4 / 5 / 6 | — (uses existing contracts) |
| R | runtime | 1 (runtime), 7 (probes, storage, endpoints, alerts), 3 (runtime-generated links) | C |
| M | app (web + mobile) | 8 rendering | C |
| S | app (web) | 7 usage UI | C, R's endpoint shapes |
| L | app (web + mobile) + runtime links check | 3 routes | U, M, S merged |

## 4. Decision numbering (avoid collisions)

- contracts: CT-148…CT-169 (C only), file `docs/decisions/contracts.md`.
- app: U1 AP-300…AP-319, M AP-320…AP-339, S AP-340…AP-359, L AP-360…AP-379, U5 AP-380…AP-399, U6 AP-400…AP-419; file `docs/decisions/app-managed.md` or a new
  `docs/decisions/ui-improvements.md` in whombat-app.
- runtime: `docs/decisions/ui-improvements.md` in Whombat, R uses UI-R01…
- lead: UI-01… in the same Whombat file; appliance IN-… next free.
