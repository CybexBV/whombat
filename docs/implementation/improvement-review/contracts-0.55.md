# Contracts 0.55.0 — what the improvement-review streams build on

Stream C, 2026-10-07. Release `contracts-v0.55.0` (whombat-contracts merge `709c61f`), decisions CT-295…CT-308 in
whombat-contracts `docs/decisions/contracts.md`. Vendored on `improve` in Whombat and whombat-app
(`vendor/whombat-contracts/0.55.0/`). Everything is additive and optional for old peers; **`SESSION_API_LEVEL` is 34**
(a level-34 client serves runtimes 32…35; the apps in the field, level 33, serve a level-34 runtime). The skew pin
(`vendor/whombat-contracts/previous`, protocol 0.20.3, MD-16) does not move.

Imports: everything below is exported from `@whombat/core` (and its `/domain`, `/contracts`, `/text` subpaths) unless it
says `@whombat/protocol`.

## Runtime features (`RUNTIME_FEATURES`, `@whombat/protocol/session`, `SINCE_0_55`)

| Feature | Covers | Item |
|---|---|---|
| `dispatches.cancel` | `dispatches.cancel`, `typing.dispatchId`, `WorkAction` `stop_turn` | 1 (feature 4) |
| `deployments` | `deployments.list`, `deployments.environments`, `deployment.recorded`, card `deploy`, `record_deploy` | 2 (feature 5) |
| `messages.thread_paging` | `messages.thread` `before`/`limit` → `more` | 3 |
| `attachments.thumbnails` | `Attachment.thumbnailUrl` + the thumbnail route | 4 |
| `notifications.read_events` | realtime `notification.read` | 5 |
| `work.needs_you_count` | `work.needsYou` | 6 |
| `canvases.content` | `canvases.content` | 7 |

Feature names are lowercase (the wire's `FeatureName` regex): the assignment's `messages.threadPaging`,
`notifications.readEvents`, `work.needsYouCount` are `messages.thread_paging`, `notifications.read_events`,
`work.needs_you_count` (CT-301). The runner-protocol items have no feature (runner and server ship together).

**Where they sit now:** Whombat `apps/server/src/managed/runtime-features.ts` lists all seven in `NOT_IMPLEMENTED`
(one line each, naming the RF item). **RF moves each to `IMPLEMENTED_FEATURES` when it lands** (the test requires every
name in exactly one of the two). Clients gate UI with `runtimeHasFeature(runtime, '<name>')`; whombat-app's
`FEATURE_NAMES` (`packages/client/src/managed/updates.ts`) has a name for each (“Update your Whombat to use Deploys.”).

## 1. Stop a turn — CT-295

- **Endpoint `dispatches.cancel`**: `POST /api/v1/burrows/:burrow/dispatches/:dispatchId/cancel`, no body →
  `CancelDispatchResponse {dispatch: DispatchSummary}` (state `cancelled`, or how it had already ended; a second call
  just answers). Session op `dispatches.cancel` (safety `receipt`, not destructive).
- Who: the person the turn is for, people who may wake that agent there (the retry rule), burrow owners; agents never
  (403). A run's turn: **409** with `TURN_STOP_RUN_REFUSAL` = “Pause the run instead.”.
- Queued → cancelled at once; claimed/running → cancelled and the runner stops at its next beat via the existing
  `ProgressResponse {cancel: true, reason: 'cancelled'}` (no runner change); clear typing, publish `dispatch.updated`.
- **`typing` event** gains `dispatchId?: DispatchId | null` (the agent's turn that thinks; null/absent for people).
- **`WorkAction` `stop_turn`** (calls `dispatches.cancel` with `refs.dispatchId`), on QUEUED/RUNNING turn items for
  people allowed.
- Pure helpers (`domain/work.ts`): `isTurnLive(state)` (queued | claimed | running), `canStopTurn(turn: {state, runId},
  agent: {kind, ownerId?}, viewer: {id, kind, role?})` — live, no `runId`, viewer a person and (`role === 'owner'` or a
  team agent or its personal owner).
- Copy (`text/turns.ts`): `TURN_STOP_LABEL` “Stop”, `turnStoppedText(name)` → “Stopped by Mara” (use as the cancelled
  `DispatchSummary.reason`), `TURN_STOP_RUN_REFUSAL`.
- Audit type **`dispatch.cancelled`** (`System`, hidden: `text: null`, payload `{dispatchId, agentId}`).

## 2. Deployments — CT-296, CT-297

- **Id** `DeploymentId` (`dpl_…`, `newId('deployment')`).
- **`Deployment`** (`domain/deployment.ts`):
  `{id, environment, service, status: 'succeeded'|'failed', how: 'github_actions'|'ssh'|'computer'|'other', repo, ref,
  sha, url, summary, byId, runId, conversationId, messageId, previousId, createdAt}` — `repo` (`owner/name`), `ref`
  (≤ 255), `sha` (7–64 hex), `url` (http/https ≤ 2048), `runId`, `conversationId`, `messageId`, `previousId` are
  **nullable with default null**; `environment` 1–60, `service` 1–80 (trimmed, no control characters), `summary` ≤ 500.
  Limits: `DEPLOY_ENVIRONMENT_MAX` 60, `DEPLOY_SERVICE_MAX` 80, `DEPLOY_SUMMARY_MAX` 500, `DEPLOY_REF_MAX` 255,
  `DEPLOY_ENVIRONMENTS_MAX` 50, `DEPLOY_SERVICES_MAX` 200.
- Names: stored as `normalizeDeployName(name)` (trim + collapse whitespace), grouped by `deployGroupKey(name)`
  (lowercase); the newest record's spelling is shown. `previousId` = the deploy of the same service and environment that
  **succeeded** before this one.
- Visibility: every burrow member reads deployments and summaries; `conversationId`/`messageId` only for members of that
  conversation (null for everyone else).
- **`deployments.list`**: `GET /api/v1/burrows/:burrow/deployments?environment&service&before&limit` (limit default 50,
  ≤ 200; environment/service case-insensitive) → `DeploymentsPage {deployments: Deployment[] (newest first), before:
  Cursor | null}`.
- **`deployments.environments`**: `GET /api/v1/burrows/:burrow/deployments/environments` →
  `DeployEnvironmentsResponse {environments: DeployEnvironment[]}`; `DeployEnvironment {environment, lastAt, services:
  DeployServiceState[]}`; `DeployServiceState {service, current: Deployment | null, failed: Deployment | null, previous:
  Deployment | null}`. `current` = newest succeeded, `failed` = newest attempt when it failed (newer than `current`),
  `previous` = succeeded before `current`. Environments newest-deployed first, services by name.
  **`deployEnvironmentsFrom(deployments)`** is the pure reference builder (fixtures use it; RF may too).
- **Realtime `deployment.recorded {deployment: Deployment}`**, topic **`burrow`** (`conversationId`/`messageId`
  personalized per viewer).
- **Card `deploy`** (`DeployCard`, in `MessageCard`, `StoredCard` — same shape stored —, `CARD_KINDS`; never
  `PostableCard`): `{kind: 'deploy', deploymentId, environment, service, status, sha: string | null, url: string |
  null, runId?: RunId | null}`. Settled one-line card. Copy: `deployLine(card)` → “Deployed api to production · 3f9c2a”
  / “Deploy of api to production failed · 3f9c2a” (6-char `shortSha`), `deployCardText(card)` → `[deploy: api to
  production, succeeded]` (inbox, search, agents' windows), `DEPLOYMENT_STATUS_PILLS` (`DEPLOYED`/`FAILED`),
  `DEPLOYMENT_STATUS_LABELS`, `DEPLOYMENT_HOW_LABELS` (GitHub Actions, SSH, Computer, Other). `runId` set: show it
  inside that run's line (CT-261 rule).
- **MCP tool `record_deploy`** (`contracts/mcp-deploy.ts`, `DEPLOY_MCP_TOOLS`): input `RecordDeployInput {environment,
  service, status, how, summary (1–500), sha?, ref?, url?, repo?, runId?}` (`runId` absent: the turn's run, if any);
  output `RecordDeployOutput = commitOutcome({deploymentId, previousId: DeploymentId | null, messageId: MessageId |
  null})`. `requiredKey: null`, not read-only, in `WHOMBAT_TOOL_NAMES`, **not** in `MCP_POSTING_TOOLS`. Description:
  “Call it after every deploy you do, whether it succeeded or failed: it records the deploy on the burrow’s Deploys
  board and posts a deploy card here. The summary is visible to everyone in the burrow, so keep secrets out of it.”
  Activity verbs “Recording a deploy” / “Recorded a deploy”.
- **Audit type `deploy.recorded`** (`Code`): payload ids, names, status, how, sha; never summary or URL; text like
  “Deployed api to production”.
- Links: `WorkLink {type: 'work', section: DEPLOYS_SECTION ('deploys')}` → `linkPath` gives `/:burrow/work/deploys`.
- Fixtures (`@whombat/fixtures`): `DEPLOYMENTS` (5: production api ×3 with the newest **failed**, staging api,
  production web over SSH), `deploymentsPage(query)`, `deploymentEnvironments()`; `createFixtureFetch()` serves both
  endpoints.

**Placeholders on `improve`:** Whombat `apps/server/src/mcp/tools.ts` has `record_deploy` answering 409 “Recording deploys
isn’t available on this Whombat yet.”, and `apps/server/src/mcp/server.ts` doesn't list it (`if (name ===
'record_deploy') return false;`) — **RF-02 replaces the handler and deletes that line** (and the matching line in
`connectors/tools-mail.int.test.ts`).

## 3. Thread paging — CT-299

- `messages.thread` (`GET /api/v1/burrows/:burrow/messages/:messageId/thread`) takes **`query: ThreadQuery {before?:
  MessageId, limit?: 1…200}`** (`THREAD_PAGE_MAX` 200; strings coerce).
- `ThreadView.more?: {before: MessageId} | null`. No `limit`: every reply and `more` null (old clients unchanged). With
  `limit`: the newest `limit` replies before `before` (oldest first); `more.before` = the oldest reply of the page while
  earlier ones exist. Older servers omit `more` and send everything.
- Pure reference: `pageThreadReplies(replies, {before?, limit?}) → {replies, more}` (an unknown `before` pages from the
  newest). Fixtures page with it.

## 4. Thumbnails — CT-298

- `Attachment.thumbnailUrl?: string | null`, `thumbnailWidth?: number | null`, `thumbnailHeight?: number | null`.
- `THUMBNAIL_MAX_EDGE` = 720 (longest side). Route (raw bytes, like the download):
  `ATTACHMENT_TRANSFER.thumbnail` = `GET /api/v1/burrows/:burrow/attachments/:attachmentId/thumbnail`;
  `attachmentThumbnailUrl(burrow, attachmentId)` builds it. Authorized exactly like the file; 404 without one;
  `Cache-Control: private, max-age=31536000, immutable`; the thumbnail's own content type.
- Over a session nothing new: the thumbnail is the download stream's existing `variant: 'preview'`
  (`variant_unavailable` when none). Clients fall back to `url`.

## 5. Read state across devices — CT-300

- Realtime **`notification.read {ids: NotificationId[] | null, before?: Timestamp, unread?: Count}`**, topic **`me`**.
  `ids` ≤ `NOTIFICATION_READ_IDS_MAX` (200; the server splits larger sets into several events); `ids: null` = every
  notification up to `before` (`markRead {all: true}`); `unread` = the viewer's unread count after it.
- Every mark-read path publishes it (RF-05).

**Placeholder on `improve`:** whombat-app `packages/client/src/query/apply.ts` handles it by invalidating
`notifications.inbox` — **MN-03/WE-11 replace it with the reducer.** Same file: `deployment.recorded` invalidates
`deployments.list` and `deployments.environments` — WE-17/MQ-07 may keep or replace it.

## 6. Needs-you count — CT-302

`work.needsYou`: `GET /api/v1/burrows/:burrow/needs-you` → `NeedsYouResponse {count}` (= bootstrap's
`sidebar.counts.needsYou`). Session op, `safe`. Fixtures answer `{count: 1}`.

## 7. Canvas for phones — CT-303

`canvases.content`: `GET /api/v1/burrows/:burrow/canvases/:slug/content` → `CanvasContentResponse {canvas: Canvas,
markdown: string, updatedAt: Timestamp}` (the text `canvas_read` gives agents; `canvas` added so one request is enough).
Session op, `safe`. Fixtures serve `CANVAS_MARKDOWN`.

## 8. Runner protocol — CT-304, CT-305, CT-306 (`@whombat/core/contracts`, `runner.ts`, `packs.ts`)

- **`ProgressBody.computerBegun?: boolean`** — sent once, with the beat after the turn's first command on the computer
  (TE-04). **`COMPUTER_WAIT_TOOL`** = `'whombat.computer_wait'` (`domain/activity.ts`): the runner's activity row while a
  turn waits for the computer; `describeActivity` says “Waiting for the computer” / “Got the computer” / “Couldn’t get the
  computer”.
- **`DispatchContext.forkFrom?: ForkFromSession {providerSessionId (1–200), promptHash: PromptHash} | null`** — only
  when `dispatch.providerSessionId` is null; the runner forks only if its stable prompt hashes to `promptHash`, else
  fresh. **`ProgressBody.forked?: boolean`** (with `providerSessionId`) says the fork took (TE-03's measurement).
- **`DispatchContext.workspace.headSha?: GitSha | null`** (full 40/64 hex) — skip `git fetch` when the clone has it
  (TE-10).
- **`runner.packSkills`** body gains **`knownHashes?: Sha256Hex[]`** (≤ `PACK_SKILL_KNOWN_HASHES_MAX` 200); each
  `PackSkillFiles` gains **`hash?: Sha256Hex`** and **`cached?: boolean`** (`files: []` when cached).
  **`packSkillHash(files)`** = sha-256 hex over files sorted by path, each `path` NUL `data` NUL (TE-09).
- **Steering (SX):** `ProgressResponse.inject?: TurnInjection[]` (≤ `TURN_INJECT_MAX` 8, oldest first, repeated every
  beat until delivered or the turn ends); `TurnInjection {dispatchId, messageId, message: Message, attachments:
  AttachmentRef[] (default [])}`; **`ProgressBody.injected?: DispatchId[]`** (≤ 8) = delivered. The server then cancels
  each delivered queued dispatch with reason **`TURN_MERGED_REASON`** = “Answered in the running turn” (`text/turns.ts`)
  and a server-only link to the turn that took it; an undelivered one runs as its own turn. A runner that can't steer
  ignores `inject`.

## What each stream implements

- **RF (Whombat server):** `dispatches.cancel` (rules above, typing `dispatchId` on every thinking event, `stop_turn` on
  Work items via `canStopTurn`'s rule plus the turn's person, `dispatch.cancelled`, reason `turnStoppedText`);
  deployments (migration 0085 table with the `Deployment` fields, `record_deploy` handler + remove the listing skip in
  `mcp/server.ts`, `deploy` card in the turn's thread, `previousId`, the GitHub Actions deploy executor's records,
  both endpoints with per-viewer conversation/message ids, `deployment.recorded` on `burrow`, `deploy.recorded` audit);
  `messages.thread` paging (`pageThreadReplies` semantics, `more`); thumbnails (`thumbnailUrl`/size on `Attachment`,
  the `/thumbnail` route, `preview` variant over sessions); `notification.read` from every mark-read path;
  `work.needsYou`; `canvases.content`; move each feature from `NOT_IMPLEMENTED` to `IMPLEMENTED_FEATURES`.
- **SR (turn efficiency):** `computerBegun` (runner) + claim exclusion (server) + `COMPUTER_WAIT_TOOL` row; `forkFrom`
  (server picks a warm session) + fork in the runner + `forked`; `workspace.headSha`; `packSkills` `knownHashes` /
  `hash` / `cached` with `packSkillHash`.
- **SX (steering):** `ProgressResponse.inject` (server), delivery + `ProgressBody.injected` (runner), merge with
  `TURN_MERGED_REASON`; `runnerFetch` must allow an injected message's attachments for the running dispatch.
- **WA (web shell):** `work.needsYou` for needs-you refetches (gate `work.needs_you_count`, else bootstrap); Inbox +
  `notification.read` reducer in `packages/client` (with MN; replaces the invalidate placeholder); Work · Deploys at
  `/work/deploys` (`deployments.*`, `deployment.recorded`, `deployLine`, `DEPLOYMENT_STATUS_PILLS`, gate `deployments`).
- **WM (web conversations):** Stop on the thinking line (`typing.dispatchId`, `canStopTurn`, `TURN_STOP_LABEL`,
  `dispatches.cancel`), in RIGHT NOW, and on Work items (`stop_turn`: `apps/web/src/features/work/workModel.ts`
  `actionReady` returns false for it today — wire it), Pause on the run line; thumbnails (`thumbnailUrl` with fallback);
  thread paging (`limit`, “Load earlier replies” with `more.before`; gate `messages.thread_paging`); the `deploy` card
  (`MessageCard.tsx` renders nothing for it today; `cardDisplay` → `'line'` for `deploy`).
- **MC (mobile chat):** the same Stop, thumbnails, thread paging and `deploy` card on the phone
  (`apps/mobile/src/data/work.ts` `workCommand` returns null for `stop_turn` today; `messages.ts` shows no card for
  `deploy`).
- **MN (mobile notifications):** `notification.read` reducer in `packages/client` (shared with WA), shade cancel on
  read.
- **MQ (mobile parity):** canvas screen from `canvases.content` (gate `canvases.content`); Work → Deploys segment
  (`deployments.*`).

## Vendoring commits

- Whombat `improve`: `93f0d85a deps: contracts 0.55.0 (…)` — tarballs, `package.json`, `pnpm-workspace.yaml`,
  lockfile, `contracts:verify` path, the seven `NOT_IMPLEMENTED` entries, the `record_deploy` placeholder and listing
  skip; `bec101f2` leaves `record_deploy` out of `connectors/tools-mail.int.test.ts`'s expected tool list (**RF-02
  removes that line too**).
- whombat-app `improve`: `5787b49 deps: contracts 0.55.0 (…)` — tarballs, `package.json`, `pnpm-workspace.yaml`, lockfile, the
  recovery-ceremony test's version, `FEATURE_NAMES` for the seven features, `apply.ts` handlers for
  `deployment.recorded` and `notification.read`, the `stop_turn` labels (web `workModel.ts`, mobile `work.ts`, not
  offered yet).
