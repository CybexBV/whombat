# Whombat essentials (2026-09-30): thirteen fixes from the product review

John asked for a list of what is missing or broken and very important for a good product, then said: “Implement fixes
for: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14”. He wants choices made by us (feedback-decide-yourself): decide open
details yourself, record them in your stream's decision file (§5), and move on. Ship target is **DEV** (fast path,
IN-132): each repo's quick checks, merge, push, candidate pins, dev instance restarted. Production is not part of this
task. No `harness/validate`, no `release/ship validate`, no waiting on GitHub Actions.

Repositories (all on `main`, private, the maintainer account’s token per command for pushes, never change the global gh account;
only the lead merges and pushes):

| Repo | What | Version today |
|---|---|---|
| `~/Code/whombat-contracts` | `@whombat/core` (domain, contracts, text), `@whombat/protocol` (session ops, features, API level) | 0.25.0 (CT-165), `SESSION_API_LEVEL` 23 |
| `~/Code/whombat-app` | web (`apps/web`), mobile (`apps/mobile`, Expo/RN), `@whombat/client` | 0.15.0 (AP-436) |
| `~/Code/Whombat` | runtime (`apps/server`, `apps/runner`, `packages/agent-runtime`, `apps/cli`) | migrations up to `0051_feedback_reporters` |
| `~/Code/whombat-appliance` | candidates (`manifest/candidates/`), dev instance | candidate 0.22.1 (IN-133) |

Target versions: contracts **0.26.0** (`SESSION_API_LEVEL` 24), app **0.16.0**, candidate **0.23.0** (IN-134).

## 1. The items

Numbers are John's.

### 1. Approvals never claim work that didn't happen
Today `ApprovalEngine` installs a `simulated` executor (`apps/server/src/approvals/engine.ts`) for `deploy`, `refund`,
`push_shared_branch`, `merge_pr`, `create_channel`, `message_external` and `custom`, and the signed
`approval.executed` / `action.performed` events then say “Refunded €…”, “Deployed …”, “Pushed …”, “Merged PR #…”.
`perform_action` (agent tool) calls the same executors.
- No production path may sign success for something Whombat didn't do. Simulated executors exist only in demo mode
  (the scripted demo storyline, `WHOMBAT_DEMO`/`DemoDirector`, and tests that ask for them explicitly).
- Real executors: `merge_pr` (merge through GitHub as the person who approved; people only, `merge.main` rules kept),
  `create_channel` (the real `create_channel` command), `deploy` only when a deploy workflow is configured
  (`GITHUB_DEPLOY_WORKFLOW`, existing), `grant_key`, `vault_use`, connector actions (existing).
- `refund`, `message_external`, and `deploy` without a workflow have no executor: `request_approval` and
  `perform_action` refuse them up front with a sentence the agent can act on (“Whombat can’t issue refunds here: no
  payment system is connected. Ask a person to do it, and say what exactly.”); an old pending approval of such a type
  that gets approved fails honestly (`approval.failed`, text says nothing happened and why).
- `custom`: a yes means “a person agrees the agent may do this itself”. Signed text: “{Person} approved: {title}” —
  never “done”. The requesting agent is woken (item 2's `approval_granted` dispatch) to carry on.
- `push_shared_branch`: see item 2; executed text is “Allowed {Agent} to push {branch}”, not “Pushed”.
- Unit and server tests prove each type's truthful outcome.

### 2. Approving an agent's push to a shared branch lets it push
Today the approval only signs `git.credentials_issued` (`apps/server/src/runtime/git.ts`), the runner already ended
the turn with `pending_approval` (`apps/runner/src/workspace.ts`), and nothing wakes the agent on a yes.
- On yes (and when all conditions are met), queue a dispatch with the new trigger **`approval_granted`** (contracts) to
  the requesting agent, in the approval's conversation and thread, for the person the original turn was for; its
  prompt says what was approved and that it may now do it (push allowed for that branch). No duplicate wake when a turn
  of that agent is already live there for the same approval.
- The credentials route issues the push token for that agent and branch while the approval is approved (bound to the
  approval; existing checks stay). The next turn pushes; the approval is marked executed when the push is recorded
  (`record_push`) or, if you decide otherwise, when the credential was used — record it.
- The same wake applies to `custom` approvals and to any agent-requested approval whose yes should let the agent go on.
- Test end to end in `test:server` with the fake GitHub: ask → yes → wake → push accepted → executed.

### 3. Long turns keep their Whombat tools
Agent tokens last 30 min and are issued once (`apps/server/src/auth/agent-tokens.ts`); a sandbox turn may run 120 min.
- While a dispatch is live (queued/claimed/running with a current lease), every runner heartbeat or lease renewal and
  every authenticated MCP call slides the token's expiry to now + 30 min, bounded by the dispatch's wall time
  (`WHOMBAT_SANDBOX_WALL_MINUTES` + a margin). Finished or cancelled dispatches still invalidate at once.
- The runner's final post (`apps/runner/src/turn.ts` `postFinal`) works after a 60+ minute turn. Test with a fake clock.

### 4. A failed turn says why and can be tried again
Today the agent posts “I couldn’t finish this. Something went wrong on my side…” and the cause stays in
`dispatches.error` and the log; failure classification exists only in managed mode (`apps/runner/src/turn.ts`).
- Classify every final failure (both modes) into a small set with a readable, safe sentence (no paths, secrets or
  stack traces in the public message): `signin` (Claude/Codex not set up or signed in for this person), `usage_limit`
  (with the reset time when known), `provider` (the provider errored or is unavailable), `sandbox` (the sandbox or
  workspace couldn't start, e.g. a read-only path), `timeout` (wall time), `runner` (no runner / lost lease),
  `workspace` (git/checkout), `internal`. Map the real Codex/Claude error infos; include the dev monolith's real case
  “fs sandbox helper failed … Read-only file system” → `sandbox`.
- The failure message carries a **`turn_failed` card** (contracts): reason sentence, code, the dispatch it belongs to,
  retried state. It shows **Try again** to people who may wake that agent there (a personal agent: its owner only).
- New endpoint **`dispatches.retry`**: queues a new dispatch with trigger **`retry`**, same agent, conversation,
  thread, triggering message and person; the card updates to “Tried again” (one retry per failed dispatch; a second
  press answers with the existing retry). The Work view's FAILED items offer the same (`WorkAction` `retry_turn`).
- Burrow owners and admins see the technical detail (redacted of secrets, ≤ 2000 chars) in the Work item (detail
  field), never in the channel.

### 5. Branch rooms are addressed by repo and number
Today `/pr/:number` picks the first room with that number; with two repos, one is unreachable (dev: PR #1 of Whombat and PR #1 of
another repository).
- `LinkRef`/`ConversationLink` `pr` gain an optional `repo` (`owner/name`); `BranchRoomSummary` gains `repo`. Every
  link the runtime makes to a branch room includes it. `prs.get` already accepts `?repo=`.
- Web: `/pr/:number?repo=owner/name` (search param, so old links still open); the sidebar, cards, notifications, Work
  and run links pass it; with no `repo` and more than one room with that number the screen asks which one (a short
  list), never silently picks. Mobile deep links and routes the same.

### 6. Managed Whombats can connect GitHub
Today Settings → Software Dev tells the owner to run `gh auth login` on a box they have no shell on. The runtime
already supports a person's own GitHub sign-in on managed boxes (`github:device`, `github:token`,
`apps/server/src/managed/providers/service.ts`, managed-providers.md PV-06), but no screen offers it.
- Web (managed mode): Software Dev shows “Sign in to GitHub” (device code: show the code and the github.com link,
  copy button, waiting state; alternatively paste a token) using the existing sign-in flow components
  (`features/ai/DeviceCode.tsx`, `SignIn.tsx`), then “Connect GitHub” for the burrow as that person (owners), then
  the repo list. Settings → AI accounts lists GitHub next to Claude and Codex with its status and Sign out. Self-hosted
  keeps the host `gh` flow and text. Mobile: shows status and “Sign in on the web”.
- Runtime: whatever is missing so `github.status` tells a managed owner they need to sign in (instead of the host
  `gh` text), and connect works with that sign-in. Real GitHub device flow can't be completed by us (it needs John's
  GitHub); test with the fake and verify the UI up to the code screen on dev.

### 7. Codex updates flow again
The tested-client job (`whombat-clients-latest-tested.service` on this machine) fails for every Codex 0.159.x since
2026-09-29: `packages/agent-runtime/src/providers/bundles.test.ts:128` (“every Codex error info of the pinned version
maps to a state”) — `CODEX_ERROR_STATES` lacks `flexUnavailable` and `tooManyDenials`.
- Map both (and anything else in 0.159.2's schema) to the right states; use them in item 4's classification. Check
  `~/.local/state/whombat-clients/logs/` for the exact failure. The lead reruns the job after the candidate moves.

### 8. Messages can be edited and deleted
- Contracts: `messages.edit` (PATCH, `{text}`) and `messages.delete` (DELETE); `Message.deletedAt` (optional,
  nullable) for tombstones; `message.updated` / `message.deleted` events (exist).
- Rules: people edit their own messages (text only; not cards; an attachment-only message can gain text); people delete
  their own; burrow owners may delete anyone's (moderation). Agents don't edit or delete through the API. Edits set
  `editedAt` (clients show “(edited)”). An edit that adds a new `@Agent` mention wakes that agent once, like a send; an
  edit that adds a person's mention notifies them once; nothing else is re-sent.
- Delete: a message without replies is removed (`message.deleted`); a thread root with replies becomes a tombstone
  (“This message was deleted.”, `deletedAt`, text and attachments and card gone, replies stay). Attachment bytes go
  when nothing else uses them. Search index rows and link previews of the message go. Signed events
  `message.edited` / `message.deleted` (kind `Messages`) carry ids only, never text (the message text is not in any
  signed payload today; keep it that way).
- Agents' context reads the edited/deleted state (no stale text in their prompt from the messages table).

### 9. Direct messages between people and group DMs
- Contracts: `ConversationKind` gains **`direct`** (people only, 2–9 members; agent DMs stay `dm`). `LinkRef` /
  `ConversationLink` gain `{type: 'direct', id: ConversationId}`. `Sidebar.direct` (optional) lists the viewer's
  direct conversations; `ConversationSummary.memberIds` (optional) for names and faces. Endpoint
  **`conversations.openDirect`** (`{principalIds}`: the other people, 1–8): get-or-create by exact member set.
- The member set is fixed; “add someone” starts a new group conversation. Title shown = the other members' short
  names (clients compute it from members, excluding the viewer; server stores a neutral title).
- Agents are never members; mentioning an agent there wakes nobody (the composer hints “Agents aren’t in this
  conversation”). Messages notify the other members (item 12, kind `direct`, default level `all`).
- Web route `/direct/:id`; DIRECT section shows people and agent DMs together by recent activity; “New message”
  (a people picker) opens or creates one. Mobile: listed with DMs, open, new message.

### 10. Offboarding people and retiring agents
- Contracts: **`members.remove`** (owners; a person may also remove themselves = leave the burrow; never the last
  owner), **`members.setRole`** (`owner`|`member`; at least one owner always), **`agents.retire`** (owners, and the
  person who hired it). `Person.removedAt`, `Agent.retiredAt` (optional, nullable): history keeps their names
  (“former member”, “retired”), lists and pickers leave them out.
- Removing a person: membership ends at once; their sessions for this burrow stop working (REST 403, sockets closed);
  they leave every conversation of the burrow; their personal assistant retires with them; their Vault entries in this
  burrow are deleted (their own secrets) and their pending approvals they asked for are cancelled; their direct
  conversations stay readable to the others. On a managed box, also revoke that account's enrolled devices on this box
  (`managed/trust.ts`). Their principal row stays (signed history). Signed `member.removed`, `member.role_changed`.
- Retiring an agent: live runs stop, queued dispatches cancel, grants go, it leaves every channel, its DM stays
  readable but closed, handle stays reserved, it no longer appears in the roster, sidebar or pickers. Signed
  `agent.retired`. Personal assistants retire only with their owner.
- Web: Settings → Members: role menu (Make owner / Make member), Remove from burrow (confirm, says what happens),
  Leave burrow for yourself. Agent settings get the **Danger zone** tab (UI-06 follow-up): Retire {Name}. Mobile:
  nothing required beyond showing removed/retired names correctly.

### 11. Channels: browse, join, private, archive, members, threads
- Contracts: `Conversation.visibility` (`public`|`private`, channels; optional — absent = private, today's behaviour),
  `Conversation.archivedAt` (optional); `createChannel` body gains `visibility` (default `public`); `conversations.update`
  may change `visibility` (owners); **`conversations.browse`** (channels the viewer can see: every public one and
  private ones they're in; `joined` flag, member count, topic; `q` filter; archived only on request);
  **`conversations.join`** (public channels, people); **`conversations.archive`** (`{archived}`; owners and the
  channel's creator; `#general` can't be archived). Leaving = existing `removeMember` of yourself.
- Existing channels are migrated to `private` (they behave that way today), except `#general` (`public`). New
  channels default to public in the create dialog, with a private switch.
- Archived channels: read-only (no sends, no dispatches, no automations triggered), hidden from the sidebar, findable
  in Browse with the archived filter, can be unarchived.
- Web: “Browse channels” (sidebar CHANNELS header and ⌘K), create dialog with visibility and a people picker, a
  members pane from the header's member stack (add people, remove, leave), channel menu Archive/Unarchive/Leave,
  **Reply in thread** on every message's hover menu (and mobile long-press), so a thread can start on any message.
  Mobile: browse and join, start threads.

### 12. Notifications people can control
- Contracts: per-conversation level **`notify`** (`all`|`mentions`|`none`) on `ConversationSummary` /
  `ConversationDetail` (optional; defaults: `direct` and `dm` → `all`, channels and branch rooms → `mentions`),
  endpoint **`conversations.setNotify`**; `Preferences.notifications` (optional): `dndUntil` (timestamp or null),
  `schedule` (quiet hours: enabled, start, end `HH:MM`, days, in the person's zone), `email` (`off`|`hourly`|`daily`),
  `threadReplies` (bool, default true); `NotificationKind` gains `direct` and `reply`; `@channel` / `@here` recognized
  by the core parser (`Message.broadcast`: `channel`|`here`|null, optional); Bootstrap `capabilities`
  (`{emailNotifications, webPush}`, optional) so the settings show only what works on this Whombat.
- Rules: `none` = nothing from that conversation except needs-you items addressed to you; `mentions` = mentions,
  `@channel`/`@here` (here = members currently active), replies in threads you're in (if `threadReplies`); `all` =
  every message by someone else. DND and quiet hours hold back push and email (the inbox still fills); they end on
  time. `@channel`/`@here` never wake agents.
- Email (self-hosted with SMTP): at most one email per person per hour (or a daily one at 08:00 local) listing
  unread direct messages, mentions, replies and needs-you items that stayed unread 30+ minutes, none during DND/quiet
  hours, with links; plain, short, unsubscribe link to the setting. Managed boxes have no mail: capability false.
- Self-hosted web push works out of the box: `whombat init` generates the VAPID keys; `whombat start` (and
  `doctor --fix` if it exists) adds missing keys to an existing `config.env` once and says so; `doctor` reports push.
- Web: Settings → **Notifications** (DND with quick durations 30 min/1 h/until tomorrow/custom, quiet hours, email,
  thread replies, browser push status); a bell menu in each conversation header (All / Mentions / Nothing); muted
  conversations look muted in the sidebar; the sidebar footer shows a DND moon while on. Mobile: the same per
  conversation (menu) and DND + quiet hours in the settings sheet.

### 14. The smaller gaps
- **Emoji reactions**: a picker (web: popover with search and recent; mobile: sheet) using a shared list in contracts
  (`@whombat/core/text` `EMOJI` — ~250 common emoji with names and keywords, pure data); reactions from the thread
  pane too; mobile gets reactions.
- **Presence for people**: the existing `presence` event and hooks drive dots on people (sidebar DIRECT, members pane,
  DM header, mentions picker); your own dot follows your connection; Bootstrap `presence` (optional list) seeds it.
  Server: make sure people's presence is tracked and published (active / idle after 10 min / offline), per burrow.
- **Search filters**: `search.query` gains `from` (person or agent handle), `in` (conversation id), `after`,
  `before` (dates); web filter chips/menus; results paging if cheap (`limit` up to 100 exists).
- **New canvas**: the Canvases list gets “New canvas” (title prompt, optional channel), using `canvases.create`.
- **Link previews**: `Message.previews` (optional, ≤ 3: `{url, title, description|null, siteName|null}`, no images —
  CSP and privacy). The server fetches after posting (http/https, standard ports, public addresses only — reuse the
  existing SSRF-safe fetch/guard; 5 s, 512 KB, `text/html` only, title/og:title/og:description/og:site_name; skip
  code blocks and Whombat's own links; every conversation kind), caches per URL for 24 h, and
  sends `message.updated`. Failures leave no preview. A burrow setting to turn previews off (owners), default on.
  Web and mobile render a compact card under the message.
- **Pinned messages**: `messages.pin` (`{pinned}`, members), `Message.pinnedAt`/`pinnedById` (optional),
  **`conversations.pins`** (list, newest first, ≤ 50 per conversation); signed `message.pinned`. Web: Pin in the message
  menu, a “Pinned · N” header button opening a pane; mobile: pin from long-press, list from the conversation menu.

(Item 13 — data export/deletion/retention — is not part of this task.)

## 2. Contracts 0.26.0 (stream C) — everything the others build on

All additive and optional so older apps and runtimes keep working (tolerant decoding, CT-136); a new enum member is
fine (tolerant clients leave out what they don't know). Bump `SESSION_API_LEVEL` to 24; new features (open strings)
announced by the runtime: `messages.edit`, `messages.pins`, `messages.previews`, `conversations.direct`,
`channels.browse`, `members.manage`, `agents.retire`, `notifications.levels`, `dispatches.retry`, `search.filters`,
`prs.repo`, `presence`. Exact names are C's call; list them in CT decisions. Follow `docs/publishing.md`'s release
checklist (schema, vectors, Go where applicable: `pnpm gen:check`, `pnpm test:go`).

Shapes (names are the proposal; C may refine them, but keep them additive, and record every choice):
- `DispatchTrigger` + `approval_granted`, `retry`. `WorkAction` + `retry_turn`. `DispatchSummary` (+`failure?`
  `{code, reason}`).
- Card `turn_failed`: `{kind, dispatchId, agentId, code: TurnFailureCode, reason (≤ 200), retriedAt|null,
  retryDispatchId|null}`; `TurnFailureCode` enum from item 4; `dispatches.retry` POST
  `/burrows/:burrow/dispatches/:dispatchId/retry` → `{dispatchId}`.
- `LinkRef`/`ConversationLink`: `pr.repo?`, new `direct {id}`. `BranchRoomSummary.repo?`.
- `Message`: `deletedAt?`, `pinnedAt?`, `pinnedById?`, `previews?`, `broadcast?`. `messages.edit`, `messages.delete`,
  `messages.pin`, `conversations.pins`. Parser: `@channel`, `@here` (`parseBroadcast` or in the mention parser).
- `ConversationKind` + `direct`; `Conversation.visibility?`, `archivedAt?`, `createdById?` (if useful);
  `ConversationSummary.memberIds?`, `notify?`; `ConversationDetail.notify?`; `Sidebar.direct?`;
  `conversations.openDirect`, `.browse`, `.join`, `.archive`, `.setNotify`; `createChannel.visibility`,
  `update.visibility`.
- `NotificationKind` + `direct`, `reply`. `Preferences.notifications?` (item 12). `Bootstrap.capabilities?`,
  `Bootstrap.presence?`.
- `Person.removedAt?`, `Agent.retiredAt?`; `members.remove`, `members.setRole`, `agents.retire`.
- `search.query` query `from?`, `in?`, `after?`, `before?`.
- `EMOJI` data in `@whombat/core/text` (name, char, keywords, group), pure.
- Link preview schema; a burrow setting `linkPreviews` (optional bool) on `Burrow` and `burrows.update`.
- Realtime: reuse `message.updated`/`message.deleted`/`conversation.updated`/`person.updated`/`agent.updated`; add
  events only where needed (e.g. `conversation.notify` to the viewer's `me:` topic if you think it's needed).

## 3. Hard rules

- CLAUDE.md of each repo applies (tokens only, copy style with curly quotes and `·`, accessibility, contracts first,
  commit trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`).
- `export TMPDIR=~/.cache/wb-tmp` (host `/tmp` runs out of inodes). Other agents and sessions run at the same time:
  use free ports (pick random ones in 20000–29999), your own throwaway databases, never stop, reset or `down -v`
  shared containers, never stop `whombat-prod-cloudflared-1`, never touch the dev instance's units or databases.
- Work only in your own worktree on your own branch; commit small; do not merge into `main`, push, deploy or publish.
  The lead merges. When the lead asks, merge the current `main` into your branch and fix conflicts.
- **Migrations are `expand` only** (new tables, new nullable/defaulted columns, backfills that don't drop): the
  production box has no backup destination, so a `contract`/`incompatible` migration would stall its updates. Add each
  migration to `apps/server/src/db/migrations/compat.json` and keep the floors rules (UI-R17: readers/writers floors
  stay at the oldest schema that still works). Assigned numbers: R1 `0052_…`, R2 `0053_…`, R3 `0054_…` (skip yours if
  unused; the lead renumbers at merge if needed).
- Pass the repo's full check (`pnpm check`; runtime also `pnpm test:server`) before you report.
- UI: verify visually (Playwright screenshots at 1440×900, light and dark, and 390×844 for mobile-facing web) against
  the app's existing style; include screenshot paths. Mobile: typecheck + unit tests; render on the emulator if you
  can (`ANDROID_HOME=$HOME/Android/Sdk`), say so if you didn't.
- Report: what you built per item, decisions (numbers), tests run with counts, anything left open, and the exact
  commit range of your branch.

## 4. Streams

| ID | Repo / worktree / branch | Items | Needs |
|---|---|---|---|
| C | contracts · `~/Code/.wt/contracts-essentials` · `essentials` | §2 | — |
| R1 | runtime · `~/Code/.wt/whombat-es-agents` · `es-agents` | 1, 2, 3, 4, 6 (runtime), 7 | C for 2, 4 |
| R2 | runtime · `~/Code/.wt/whombat-es-conversations` · `es-conversations` | 8, 9, 11, 14 (server: pins, previews, search filters, presence), 5 (links) | C |
| R3 | runtime · `~/Code/.wt/whombat-es-people` · `es-people` | 10, 12 (server, CLI VAPID, email) | C |
| W1 | app web · `~/Code/.wt/app-es-messages` · `es-messages` | 8, 14 (emoji, pins, previews, search filters, new canvas), 11 (reply in thread) | C |
| W2 | app web · `~/Code/.wt/app-es-conversations` · `es-conversations` | 9, 11 (browse/join/private/archive/members pane), 12 (conversation bell), 14 (presence) | C |
| W3 | app web · `~/Code/.wt/app-es-settings` · `es-settings` | 4, 5, 6, 10, 12 (Settings → Notifications) | C |
| M | app mobile · `~/Code/.wt/app-es-mobile` · `es-mobile` | mobile parts of 4, 5, 8, 9, 11, 12, 14 | C |

## 5. Decision numbering (no collisions)

- contracts: CT-166…CT-189 in `docs/decisions/contracts.md`.
- runtime (Whombat): R1 `docs/decisions/essentials-agents.md` (EA-01…), R2 `docs/decisions/essentials-conversations.md`
  (EC-01…), R3 `docs/decisions/essentials-people.md` (EP-01…); lead `docs/decisions/essentials.md` (ES-01…).
- app: W1 AP-440…AP-459 (`docs/decisions/essentials-messages.md`), W2 AP-460…AP-479
  (`essentials-conversations.md`), W3 AP-480…AP-499 (`essentials-settings.md`), M AP-500…AP-519
  (`essentials-mobile.md`).
- appliance: IN-134 (candidate 0.23.0, lead).
