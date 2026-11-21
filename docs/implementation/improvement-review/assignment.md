# Improvement review build (2026-10-07)

John asked for a review in four categories (efficiency, new features, overall UI/UX, mobile UI/UX), got the report
next to this file (`report.md`, every finding with file:line evidence), and answered:

> Implement this fully so everything you recommend, but for new features only implement 1, 4, 5

So: **every efficiency, web UI/UX and mobile UI/UX item in the report**, plus new features **1** (Schedules,
Computers, Spend and Audit on the phone), **4** (Stop an agent's turn) and **5** (deploy record and environments
board). New features 2, 3 and 6–16 are out of scope. Items the report marked “measure first” are built, and measured
as part of building them.

John wants choices made by us (feedback-decide-yourself): decide open details yourself, record them in your stream's
decision file with the reason, and move on. Ship target is **DEV** (IN-132 fast path). Production is not part of this
task.

## 0. Rules for every stream

- Work only in your worktree and branch. Commit there in small focused commits (imperative, `area: what`), each ending
  with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. **Never push, never merge into `main` or
  `improve`, never tag** (the lead does), except stream C, which releases contracts as described below.
- **Quick checks only** (John, DEV fast): your repo's `TMPDIR=~/.cache/wb-tmp pnpm check` and, for server changes,
  `pnpm test:server` **once** at the end (run single int-test files while working). No `harness/validate`, no
  `release/ship`, no VM tests, no Android emulator, no waiting on GitHub Actions, no repeated full suites.
- **No sub-agents** (don't use the Agent/Task tool). Never `pkill`/`killall` broadly; stop only processes you started,
  by PID. Never write outside your worktree (scratch goes to `~/.cache/wb-tmp/ir/<stream>/`). Never touch Docker
  containers, the dev stack (`whombat-stack-dev`), `whombat-dev`, the DEV box, `~/Services/*` or production.
- Server tests use the shared Postgres on `:55432` with throwaway databases (`useTestDb()`); a dev server of your own
  uses the ports in the stream table and its own database `whombat_ir_<stream>`.
- Contracts first: anything crossing a process boundary is a Zod schema in `@whombat/core`. Only stream C changes
  contracts. If you need a contract change C didn't make, write it in your final report and work around it (never
  edit the vendored tarballs).
- Copy rules (CLAUDE.md): curly quotes, `·`, `−`, verbatim mock copy; colors/fonts/radii only through tokens; 44 px
  touch targets on mobile; real buttons and links, visible focus, labels.
- UI work is verified visually: web screens in Playwright at 1440×900 in light and dark against the nearest reference
  pattern (`pnpm ref:shot` for mocked screens), screenshots to `~/.cache/wb-tmp/ir/<stream>/shots/`. Mobile: render
  tests (React Native Testing Library) and the fixture world; the lead does one emulator pass after integration.
- Decision ids: your prefix from the stream table. The item ids below are the decision ids for those items; further
  decisions continue after your highest item id. One file per stream in `docs/decisions/<file>` of your repo, a table
  `| # | Decision | Reason |`. Report items by their id.
- Finish with: all items done (or explicitly not, with why), checks green, a short report of commits, decisions,
  measurements and anything the lead must do at merge (migrations, contract gaps, follow-ups).

## 1. Repositories, versions, branches

| Repo | Today | Target |
|---|---|---|
| `~/Code/whombat-contracts` | 0.54.1 (`SESSION_API_LEVEL` 33), CT-294 | **0.55.0** (level 34), CT-295… |
| `~/Code/Whombat` | main 9d385b8d, migrations to `0083_checks_wake` | `0084` (SV indexes), `0085` (RF: deployments, thumbnails, dispatch cancel/merge columns) |
| `~/Code/whombat-app` | 0.46.0 (ef85c6a) | **0.47.0** |
| `~/Code/whombat-appliance` | candidate 0.54.0 (IN-225) | candidate **0.55.0** (IN-226) |

Integration branches: **`improve`** in Whombat and in whombat-app (from main). Every stream branches from `improve`.
Stream C vendors contracts 0.55.0 onto both `improve` branches and writes
`docs/implementation/improvement-review/contracts-0.55.md` (exact shapes) on Whombat `improve`; streams then
`git merge improve` into their branch (the lead tells you; you may also check `git log improve`).

## 2. Streams

| Stream | Repo · worktree · branch | Prefix · decision file | Ports (server/web) | Items |
|---|---|---|---|---|
| C | contracts · `~/Code/.wt/contracts-ir` · `ir-contracts` | CT-295… · `docs/decisions/contracts.md` | — | §3 |
| SP | Whombat · `~/Code/.wt/whombat-ir-perf` · `ir-perf` | SV · `server-efficiency.md` | 24411 | §4.1 |
| SG | Whombat · `~/Code/.wt/whombat-ir-poll` · `ir-poll` | PL · `polling.md` | 24412 | §4.2 |
| SR | Whombat · `~/Code/.wt/whombat-ir-turns` · `ir-turns` | TE · `turn-efficiency.md` | 24413 | §4.3 |
| SX | Whombat · `~/Code/.wt/whombat-ir-steer` · `ir-steer` | SX · `steering.md` | 24414 | §4.4 |
| RF | Whombat · `~/Code/.wt/whombat-ir-features` · `ir-features` | RF · `review-features.md` | 24415 | §4.5 |
| WA | app · `~/Code/.wt/app-ir-shell` · `ir-shell` | WE · `web-efficiency.md` | 24416 / 25186 | §5.1 |
| WM | app · `~/Code/.wt/app-ir-messages` · `ir-messages` | WX · `web-messages.md` | 24417 / 25187 | §5.2 |
| MC | app · `~/Code/.wt/app-ir-mchat` · `ir-mchat` | MX · `mobile-chat.md` | — | §6.1 |
| MN | app · `~/Code/.wt/app-ir-mnav` · `ir-mnav` | MN · `mobile-reach.md` | — | §6.2 |
| MQ | app · `~/Code/.wt/app-ir-mparity` · `ir-mparity` | MQ · `mobile-parity.md` | — | §6.3 |

Lead (orchestrator): merges streams into `improve`, then `improve` into `main` per repo, runs the checks once, releases
app 0.47.0 (+ APK on DEV), vendors the app into Whombat, cuts candidate 0.55.0, restarts the dev stack, ships to
John's box, deploys `whombat-dev`, verifies.

## 3. Stream C — contracts 0.55.0

All additive and optional where old peers are involved; old clients and old runtimes keep working (check the skew
rules in `docs/decisions/contracts.md`; unknown card kinds and unknown realtime events must stay harmless to the
clients in the field — follow how `turn_failed`, `guide`, `skill` were introduced). New runtime features in
`RUNTIME_FEATURES` (`@whombat/protocol`), `SESSION_API_LEVEL` 34. Exact shapes are yours; these are the decisions:

1. **Stop a turn** (feature 4). `dispatches.cancel` POST `/burrows/:burrow/dispatches/:dispatchId/cancel` →
   `{dispatch: DispatchSummary}`. `typing` event gains `dispatchId: DispatchId.nullable().optional()` (the agent's turn
   that thinks). `WorkAction` gains `stop_turn`. Feature `dispatches.cancel`.
2. **Deployments** (feature 5). Domain `Deployment {id (dpl_), environment (1–60), service (1–80), status:
   succeeded|failed, how: github_actions|ssh|computer|other, repo?, ref?, sha?, url?, summary (≤ 500, burrow-visible),
   byId, runId?, conversationId?, messageId?, previousId?, createdAt}`. Endpoints `deployments.list` (GET, filters
   environment/service, cursor paging) and `deployments.environments` (GET: per environment, per service the current
   succeeded deployment, the last attempt when it is newer and failed, and the previous succeeded one). Realtime
   `deployment.recorded {deployment}` on `burrow`. Card kind `deploy` `{deploymentId, environment, service, status, sha,
   url}`. MCP tool `record_deploy` (input: environment, service, status, how, summary, sha?, ref?, url?, repo?,
   runId?; its description says: call it after every deploy you do, the summary is visible to everyone in the
   burrow). Signed event type `deploy.recorded`, audit kind `Code`. Feature `deployments`.
3. **Thread paging.** `messages.thread` query `{before?: MessageId, limit?: 1..200}`; response adds
   `more: {before: MessageId} | null`. No `limit` = every reply (old clients). Feature `messages.threadPaging`.
4. **Thumbnails.** `Attachment.thumbnailUrl: string.nullable().optional()` (+ `thumbnailWidth`/`thumbnailHeight`
   optional) and the route the URL points to (authorized like the file). Feature `attachments.thumbnails`.
5. **Read state across devices.** Realtime `notification.read {ids: NotificationId[] | null, before?: Timestamp}`
   on `me` (`null` = everything up to `before`). Feature `notifications.readEvents`.
6. **Needs-you count.** `work.needsYou` GET `/burrows/:burrow/needs-you` → `{count}` (the same number bootstrap
   carries). Feature `work.needsYouCount`.
7. **Canvas for phones.** `canvases.content` GET `/burrows/:burrow/canvases/:slug/content` → `{markdown, updatedAt}`
   (the same text `canvas_read` gives agents). Feature `canvases.content`.
8. **Runner protocol** (runner and server ship together; still optional fields):
   - `ProgressBody.computerBegun?: boolean` — the turn has started using the agent's computer (TE-04).
   - `runner.packSkills` request accepts the content hashes the runner already has; the answer leaves their files
     out (TE-09).
   - `DispatchContext.workspace.headSha?: GitSha | null` — the head the server knows for the branch (TE-10).
   - The session part of `DispatchContext` gains `forkFrom?: {providerSessionId, promptHash} | null` — start this
     turn as a fork of a warm session of the same agent (TE-03).
   - Steering (SX): `ProgressResponse.inject?: [{dispatchId, messageId, text…}]` (messages to add to the running
     turn) and `ProgressBody.injected?: DispatchId[]` (what the runner delivered); a merged dispatch is `cancelled`
     with reason “Answered in the running turn” and a server-only link to the turn that took it.
9. Release: bump to 0.55.0, CT rows in `docs/decisions/contracts.md`, `pnpm check`, `pnpm gen:check` (Go/schema
   vectors) and `pnpm test:go` if the session protocol changed, merge `--no-ff` into contracts `main`, tag
   `contracts-v0.55.0` on the merge, `pnpm release`, push `main` and the tag. Vendor into Whombat `improve` and
   whombat-app `improve` (both worktrees: `~/Code/.wt/whombat-ir`, `~/Code/.wt/app-ir`; follow how 0.54.1 is
   vendored: `vendor/whombat-contracts/<v>/`, `package.json`, `pnpm-workspace.yaml` overrides, lockfile, `previous/`
   if the skew pin moves), fix compile errors that are pure vendoring (features not implemented yet go in the
   runtime's `NOT_IMPLEMENTED`/feature lists as earlier releases did), run each repo's `pnpm check`, commit on
   `improve`, and write `contracts-0.55.md`. Do this fast: the other streams wait for it.

## 4. Runtime (Whombat)

### 4.1 SP — server efficiency (report A2; no contract change)
- SV-01 Unread badges: `publishUnread` one grouped query for all members; partial index on messages
  `(conversation_id, ord) … where thread_root_id is null and deleted_at is null` (migration **0084**, also SV-09/SV-12
  indexes). Bootstrap's unread counts use it too. Measure with `explain analyze` on a seeded 20 k-message channel.
- SV-02 Post-commit hooks: dispatch enqueue stays synchronous (ids are returned); independent hooks run concurrently;
  push delivery, notification fan-out and badge publishing become tracked background work (the `UsageService.track`
  pattern; shut down waits for them). The sender's response no longer waits on push transports.
- SV-03 Idle tickers: the claim long-poll relies on `wake()` with a 5–10 s safety re-check; the automations engine is
  kicked from the bus and ticks every 10–30 s otherwise, checks its lock every 5 s, skips `scanBurrow` when no live
  automation has an event trigger; fold the small fixed tickers (runtime sweep, feedback source, welcome, hub
  revalidate, usage) into one housekeeping tick where their semantics allow; the usage tick respects its TTL. Count
  statements per idle hour before/after (log or `pg_stat_statements` on your own database).
- SV-05 Outbox: drop the `published_at` UPDATE, prune hourly from the housekeeping tick.
- SV-06 Bootstrap: member counts by `count(*) group by`, PR heads without files/commits, approvals counted in SQL.
- SV-09 Audit page counts: partial covering index `(burrow_id, kind) where text is not null` (0084).
- SV-10 Hub: personalization dispatched by event type before any await; one `JSON.stringify` when no viewer-relative
  field; a short membership cache invalidated by the existing removal controls.
- SV-11 Auth: 30–60 s in-process cache of (token hash, slug) → session/account/principal, invalidated by the existing
  bus controls (`session.revoked`, `api_token.revoked`, `principal.removed`).
- SV-12 Work view open questions: one grouped query or partial index `(conversation_id, thread_root_id, ord)`.
- SV-13 Precompressed web assets: `apps/server/src/web/static.ts` serves `<file>.br` / `<file>.gz` when present and
  accepted (`Vary: Accept-Encoding`, correct `Content-Encoding` and length); the app build emits them (WA).

### 4.2 SG — polling and test speed
- PL-01 Adaptive GitHub polling (report A2-4 + A1-8): 10 s for a repo while an agent's PR there has pending checks or
  a run/push grant/deploy is live, 30 s while a person is active in the burrow, 2–5 min otherwise; the 10-minute
  no-ETag refresh stays but only on the slow cadence. Record what it does to the checks-wake latency (HW-01…).
- PL-02 A head with zero check runs gets marked handled after the first unchanged poll (`poll-plan.ts:179`).
- PL-03 Integration tests: migrate once per run into a template database keyed by the migrations' hash, then
  `create database … template …` per file; measure `pnpm test:server` wall time before and after.

### 4.3 SR — agent turn efficiency (report A1; contract items after C)
- TE-01 Profile part of the session fingerprint = `#profile:<personId>` (a person's corrections already retire through
  `session-retire.ts`); fix the test that asserts the opposite.
- TE-02 Retire only on narrowing: keys part (removed or lowered grants only; a yes to a key request keeps the session),
  Vault part (held entries and tiers only: no `updatedAt`, readiness, unheld entries), members part (removals only),
  People/Agents burrow facts out of the stable prompt into the turn state lines.
- TE-03 Fork a warm session for a thread's first turn (Claude `--resume <id> --fork-session`; Codex if its app-server
  can fork a thread) via `forkFrom` (C 8). Measure first: count `session_reason` in a seeded run and report.
- TE-04 AC-20's claim exclusion counts only turns that began on the computer (`computerBegun`, C 8); the first command
  of a second person's turn waits for the computer (an activity row “Waiting for the computer”).
- TE-05 `pnpm prompt:size` imports the server's pure tool selection (`mcp/served.ts`) and counts JSON with a real
  tokenizer ratio; report served sizes per fixture.
- TE-06 Teammates' skills (and anything else per-teammate that changes often) out of the stable prompt; compute the
  resume decision before `prepareCwd` so a `requeue` doesn't throw away the checkout and skills.
- TE-09 Skills hash-first (`packSkills` with known hashes, C 8); attachments cached by sha256 across attempts/turns.
- TE-10 Skip `git fetch` when the clone already has `headSha` (C 8).
- TE-11 Serve `post_card` (and other action tools) by turn shape, measured with TE-05.
- TE-12 One timing line per turn-setup step (runner journal), and `chooseSession`'s queries out of the global
  `CLAIM_LOCK` where safe.

### 4.4 SX — steering follow-ups into a running turn (report A1-7)
A same-person follow-up in the same conversation and thread while the agent's turn runs is added to that turn instead
of waiting for it (C 8 inject/injected). Verify first, with the pinned CLIs on this machine (a tiny real turn is fine),
that Claude Code in stream-JSON accepts a further user message mid-turn and what it does with it; check whether the
pinned Codex app-server has a steer call. Build it for each provider that can; where one can't, nothing changes.
Run turns: decide and record. The queued dispatch is merged only when the runner confirms delivery; if the turn ends
first, the queued turn runs as today. Tests for the races.

### 4.5 RF — server side of the features (after C)
- RF-01 `dispatches.cancel` (feature 4): who may — the person the turn is for, people who may wake that agent there
  (the retry rule), burrow owners; never agents. Queued → cancelled at once; claimed/running → cancelled, the runner
  stops at its next beat (existing `ProgressResponse.cancel`), typing cleared, `dispatch.updated`, hidden signed
  `dispatch.cancelled`; a run's turn → 409 “Pause the run instead.” (the run line offers Pause). `typing.dispatchId`
  filled. Work view `stop_turn` action on queued/running items for those allowed.
- RF-02 Deployments (feature 5): table + migration **0085**, `record_deploy` MCP tool and command (no key; the turn's
  agent; posts the `deploy` card in the turn's thread; `previousId` resolved), the GitHub Actions deploy executor
  records its outcome as a deployment, the two read endpoints (conversation/message ids only for members), realtime,
  one line in the agents' deploy guidance (keep the prompt-size budget: the tool description carries the rule).
- RF-03 Thread paging (C 3).
- RF-04 Thumbnails (C 4): at upload completion PNG/JPEG get a thumbnail (longest side 720) through the existing image
  worker (`feedback/image-pool.ts`, `thumbnailMaxEdge`), stored as a derived blob, removed with the file; others none.
- RF-05 `notification.read` published by every mark-read path (C 5).
- RF-06 `work.needsYou` (C 6).
- RF-07 `canvases.content` (C 7).
- RF-08 Search answers: reuse an answer for the same viewer and the same *normalized* query (case, whitespace)
  within its current reuse window. (The web stops asking on every keystroke: WA.)

## 5. Web (whombat-app `apps/web`, `packages/client`)

### 5.1 WA — shell, performance and navigation (report A3 + C)
- WE-01 Lazy routes per feature (`lazyRouteComponent`), `manualChunks` for react/router/query/zod, default chunk
  warning limit back. Report chunk sizes before/after (raw and gzip).
- WE-02 Fixtures out of the production bundle (dynamic import behind the flag or a build-time define); prove with a
  grep of the built chunk.
- WE-03 `release:dist` / the web build emit `.br` and `.gz` next to hashed assets (SV-13 serves them).
- WE-04 Reconnect: a `burrow:` resync invalidates only what burrow events change (bootstrap/agents/sidebar) and the
  open conversation's endpoints, not every query.
- WE-05 Self-hosted build uses the local fonts (`fonts.css`), no Google Fonts; preload the two regular weights.
- WE-06 The 30 s polls (`AgentsBlockedNotice`, AI provider panel, sign-ins/clients status) run once at mount, on
  `agent.updated`, and poll only while the notice shows.
- WE-07 Bootstrap refetches narrowed: skill-card decisions and needs-you changes refetch `work.needsYou` (C 6), not
  bootstrap; review the other `needsRefetch` triggers.
- WE-08 One shared query-cache subscription per key for `useTyping`/`usePresence`/`useAgentNow`
  (`packages/client/src/react/realtime.ts`).
- WE-09 Audit log and search results windowed (`@tanstack/react-virtual` or `content-visibility`).
- WE-10 Search asks the researcher only on Enter or an explicit “Ask {researcher}” button in the answer slot
  (report C1); never on a typing pause.
- WE-11 A web **Inbox** (`/inbox`, `notifications.inbox`: Needs you · Mentions · From agents, rows open where they
  live, read state, `notification.read` reducer in `packages/client` with MN). The sidebar's vanishing “Needs you” row
  becomes a permanent **Inbox** row (warn-toned badge for needs-you, plain count for unread mentions); Work stays.
- WE-12 Esc in search returns to where you came from (delete the screen-level handler; fix `e2e/keyboard.spec.ts`).
- WE-13 Side panes take focus on open (heading) and return it to the opener on close.
- WE-14 The agent profile pane opened from a DM closes back to the DM (history back when the previous entry is in-app).
- WE-15 Below ~1024 px the sidebar becomes a drawer (header button, overlay, Esc closes, focus trapped).
- WE-16 Spend copy without “turns” (`SpendTab.tsx`).
- WE-17 Deploys (feature 5): Work view gets “Work · Deploys” (`/work/deploys`): environments board (service rows:
  current version, by, when, link, status, previous), history list, realtime.

### 5.2 WM — conversations (report A3-4/6/7 + C)
- WX-01 The room no longer re-renders at 1 Hz: the clock lives in the typing leaf; `memo(MessageRow)` with stable
  callbacks; `groupByDay` memoized; the sidebar's 30 s clock in its leaf.
- WX-02 Message rows/day sections `content-visibility: auto` with intrinsic size.
- WX-03 Thumbnails (C 4): tiles use `thumbnailUrl` (fallback to the file), `decoding="async"`, `srcset` for 2×.
- WX-04 Thread reply box = the composer (attach, paste, drop, `@`, `/`), the pane keyed by thread, drafts per thread.
- WX-05 Drafts persist (localStorage per burrow + conversation (+ thread)), cleared by `clearDrafts` and on send.
- WX-06 Copy link in the message menu (room and thread), the `#msg_…` link the room already opens.
- WX-07 Unread divider from the last-read position and a “New messages ↓” pill when scrolled up.
- WX-08 Hide `/ command` in agent DMs when there are no commands and no skills.
- WX-09 Toasts: a two-deep queue with an optional action; message delete gets Undo (the delete commits when the toast
  ends; Undo cancels; leaving the room commits).
- WX-10 Stop (feature 4): a Stop button on the “{name} is thinking” line and in the profile pane's RIGHT NOW for people
  allowed (server enforces), Stop on Work items (`stop_turn`), Pause on the run line.
- WX-11 Thread paging (C 3): threads load the newest page, “Load earlier replies” above.
- WX-12 The `deploy` card (C 2), settled one-line style (card-settle), links to the deployment and the URL.

## 6. Android (whombat-app `apps/mobile`)

### 6.1 MC — chat (report D1–D4, D12–D14 + feature 4/5 pieces)
- MX-01 Follow new content only when at the end or after your own send; otherwise a floating “New messages ↓” pill.
- MX-02 Return = newline (`submitBehavior="newline"`), a send button sends; hardware Enter keeps picking a mention;
  drafts per conversation/thread persisted (secure box like the outbox).
- MX-03 Message links and mention pushes open at the message: keep the `#msg_…` anchor, pass `messageId`, load pages
  until found (bounded), scroll to it and highlight; pinned messages and search results too.
- MX-04 Copy: `expo-clipboard`, “Copy text” and “Copy link” in the long-press menu, Copy on code blocks.
- MX-05 Day dividers and the unread marker (`lastReadMessageId` at open).
- MX-06 PR file view with syntax colours (a pure tokenizer, shared via `packages/client` if the web's is DOM-bound) and
  a deep link route for PR files.
- MX-07 Share-intent files deleted after send/cancel and on the scope guard's wipe.
- MX-08 Haptics (light, on send / approve / long-press menu).
- MX-09 Stop on the thinking line (feature 4); `deploy` card (feature 5); thumbnails in tiles (C 4); thread paging
  (C 3).

### 6.2 MN — navigation and notifications (report D5–D8, D15)
- MN-01 `initialRouteName: 'Tabs'` in linking so a notification-opened screen has the tabs beneath it; navigation
  state persisted (24 h) and restored after the process is killed.
- MN-02 Live notifications (`modules/whombat-live`): ongoing notifications get `setTimeoutAfter` (refreshed on every
  update, ~10 min), are reconciled on every push and on foreground, and end when the run/approval ends.
- MN-03 `notification.read` (C 5): the reducer in `packages/client` (shared with WA), inbox rows and badges update on
  every device.
- MN-04 Reading in the app cancels the matching notifications in the shade (native `cancel(tag)` by thread/approval
  group key, NT-15).
- MN-05 Push permission asked after a short rationale card, not cold.

### 6.3 MQ — parity screens (feature 1 + report D9–D11)
- MQ-01 Agent screen: Computer section (status, Start/Stop/Sleep/Reset, published ports with Unpublish), Schedules
  (pause/resume/remove), Notes (read, edit, delete), Always-allowed commands (list, remove).
- MQ-02 Spend: the agent line opens a Spend screen (today/7d/30d by agent and person, `spend.overview`/`spend.agent`).
- MQ-03 Audit log screen (filters actor type and kind, day groups, detail with signature verified, deep link), reached
  from Settings/More and from receipts.
- MQ-04 Hire: provider/model picker and pack choice like the web.
- MQ-05 Canvas read-only screen (`canvases.content`, C 7) rendered with the message renderer; canvas links open it.
- MQ-06 Channel administration: create (name, public/private), members (add/remove), topic, visibility, archive, leave;
  Settings → Members (invite by email, role, remove) for owners.
- MQ-07 Deploys (feature 5): Work gets a Deploys segment (environments board + history).

## 7. Lead: integration and shipping
1. Merge order per repo into `improve` (Whombat: SP, SG, SR, RF, SX; app: WA, WM, MC, MN, MQ), resolving conflicts;
   migrations 0084/0085 in that order (regenerate the drizzle snapshot/journal if needed).
2. Checks once: contracts done by C; Whombat `pnpm check` + `pnpm test:server`; app `pnpm check`. One web visual pass
   and one emulator pass of the APK in the fixture world.
3. `improve` → `main` (`--no-ff`), verify HEAD moved, push. App 0.47.0: version, tag `app-v0.47.0`, `pnpm release:dist`,
   APK published to DEV downloads; Whombat vendors app 0.47.0 (`vendor/whombat-app/0.47.0`), push.
4. Appliance candidate 0.55.0 (IN-226): pins contracts 0.55.0, Whombat main, app 0.47.0; flake input; dev stack
   `WB_MGD_PINS` → 0.55.0, restart, health; John's box: `release/ship build <id>` + twin record + `dev/publish-release`
   (see whombat-health-fixes); `whombat-dev` (CLAUDE.md step 4).
5. Report to John: what changed, where to try it, measurements, what was not done and why.
