# Whombat improvement review — 2026-10-07

Four angles John asked for: efficiency, new features, overall UI/UX, mobile UI/UX. Six read-only review passes
(server/DB/realtime, web client, agent-turn cost, product gaps, web UX, Android UX) over `~/Code/Whombat` main 9d385b8d,
`~/Code/whombat-app` main ef85c6a (0.46.0), `~/Code/whombat-contracts` 0.54.1. Nothing was changed, built or run against
a database. File references are repo-relative. Sizes: S = hours, M = days, L = a week or more.

I verified these claims directly in the code before reporting: search asks the researcher on every query change
(`SearchScreen.tsx:116-141`, `content.ts:95-141`); the profile part of the session fingerprint hashes every entry's
`updatedAt` (`memory/learning.ts:246-253`) while `session-retire.ts:10-16` says an agent's own writes retire nothing;
`publishUnread` loops members with one COUNT each (`domain/messages.ts:477-497`) and the only index is
`(conversation_id, created_at, ord)`; the router has 34 static imports and no lazy routes, main chunk 3 100 kB;
`services.ts` statically imports the fixture world; `web/static.ts` has no compression; the Android chat scrolls to the
end whenever the last item or the typing count changes (`ChatView.tsx:554-572`); the composer has
`submitBehavior="submit"` / `returnKeyType="send"` (`ui/chat.tsx:1705-1708`); `appScreenUrlForPath` drops the `#msg_…`
anchor (`routes.ts:320`); contracts have no `dispatches.cancel` and the web has no Stop control.

Earlier reviews this stands on (not repeated here): 2026-10-07 appliance health review F1–F15 (items 1–6 shipped as
candidate 0.54.0), 2026-09-27 competitive analysis (A/B/C built; D-list re-evaluated below), 2026-09-30 essentials
(items 1–12, 14 built; 13 open).

## Consolidated top ten

| # | Improvement | Category | Size |
|---|---|---|---|
| 1 | Stop retiring agent sessions on safe changes (profile writes, key grants, Vault edits, joins, burrow facts, teammates' skills) | efficiency | S–M |
| 2 | Web bundle: lazy routes, fixtures out of prod, precompressed assets, local fonts | efficiency | S–M |
| 3 | Send path: one grouped unread query + partial index; push/notify off the response path | efficiency | S–M |
| 4 | Event-driven claim/automation ticks; adaptive GitHub polling; zero-checks mark | efficiency | S–M |
| 5 | Search asks the researcher per typing pause → ask on Enter / explicit button, reuse answers | web UX + cost | S |
| 6 | Schedules, Computers, Spend, Audit on the phone (endpoints exist) | feature | M |
| 7 | Android chat basics: at-end guard + “New messages” pill; Enter = newline + persisted drafts; deep links land on the message | mobile UX | S–M |
| 8 | A web inbox (Needs you · Mentions · From agents) | web UX | M |
| 9 | Stop an agent's chat turn (`dispatches.cancel` + Stop on the typing line) | feature + UX | L |
| 10 | Token budgets that pause only machine-paced triggers + cost on the run page; team digest card | feature | M |

---

## A. Efficiency

### A1. Agent-turn cost and latency

Baseline: a Claude chat turn ≈ 4.7–9 k tokens of Whombat system prompt + 18–23 k served tool schemas + Claude's own
≈ 9.5 k; Codex ≈ 23 k per call. A resumed session pays only what is new (~250 tokens); a cold one re-sends everything and
Codex caches nothing across threads. So the lever left after PE/AE is how often a turn is cold, then what people wait on.

1. **Every profile write retires the session.** `memory/learning.ts:246-253` puts `#profile:<person>:<entry>:<updatedAt>` per
   entry into the `instructions` session part (`memory/sessions.ts:95-101`); landed 17dc081c (2026-10-04) as a deliberate
   correctness choice, but `session-retire.ts:10-16` already handles a person's corrections and says the agent's own writes
   retire nothing. Result: the agent's own `memory` profile add (RA-20) and every reflection that keeps something about the
   person make the next turn cold. Direction: part = `#profile:<personId>` only. **S.**
2. **Other fingerprint parts retire sessions when nothing narrowed.** (a) a yes to a key request writes grants → `keys` part →
   the `approval_granted` continuation turn is cold exactly when context matters (`approvals/grant-key.ts:11`,
   `commands/agents.ts:555`, `sessions.ts:79-83`); (b) `vault` part hashes `updatedAt`, SSH readiness and the requester's
   unheld entries (`vault/context.ts:379-404`); (c) `members` part: any join/leave in the room (`sessions.ts:102-106`);
   (d) People/Agents facts sit in the stable prompt (`runtime/context.ts:818-836`, `prompt.ts:309`) so a hire or a join
   changes every agent's prompt hash. Direction: retire on narrowing only; facts into `turnStateLines`. **S–M.**
3. **Sessions are per thread, so every new thread is cold; on Codex uncached.** `conversationKeyFor` keys `thread:<root>`
   (core `domain/memory.ts:194-196`); the prompt tells agents to answer in threads (`prompt.ts:323`). Direction: fork the
   conversation's warm Claude session (`--resume <conv> --fork-session`, PE-DCA01) for a thread's first turn. Measure first:
   `select session_reason, count(*) from dispatch_memory group by 1`. **M.**
4. **AC-20's claim-time exclusion blocks every other person's turns for the whole run** (`runtime/service.ts:494-499`),
   although AC-61 made the computer lazy (shares reach it at the first command, `apps/runner/src/computer.ts:385`). A
   6–9 min run for John blocks Mara's DM. Direction: enforce one-person at `computerd.begin`, or count only turns that began
   on the computer. **M.**
5. **`pnpm prompt:size` measures a tool list the server no longer serves** (`scripts/prompt-size/src/tools.ts:15,41` vs
   `apps/server/src/mcp/served.ts`): 54/60/74 tools vs the served 43/…/59, ~7 k tokens off per call; chars/4 undercounts
   JSON by ~⅓. Fix before trimming anything else. **S.**
6. **Teammates' skills in the stable prompt, resume decided after the expensive setup.** ≤ 12 skill names per teammate
   (`persona/handoffs.ts:71-85`); any agent learning a skill changes every other agent's prompt hash → `fresh`/`requeue`
   (`prompt.ts:380-387`) after the runner already fetched skills and prepared the checkout (`turn.ts:842-876` after
   `:298-335`). Direction: skills into the user turn; hash before `prepareCwd`. **S–M.**
7. **A follow-up while the agent works waits for the whole turn** (one turn per agent+conversation, coalescing;
   `service.ts:483-490`); measured 166–239 s waits. Claude's stdin stays open (`claude/index.ts:1238-1244`), so a same-person
   follow-up could be injected as a further user message. Not verified for Codex (`turn/steer`?). **M–L, measure first.**
8. **CI results reach the agent 30–60 s late by poll granularity** (`config.ts:362`, `poll-plan.ts:174-181`). Direction:
   10 s polls while an agent's PR has pending checks or a run is live (ETags make it cheap). **S.**
9. **Pack skill files and attachments re-fetched every turn.** `apps/runner/src/skills.ts:170` calls `packSkills` before
   checking the content-named folder (`:191-204`); Pippa's ten packs ≈ 2.3 MB → ~3 MB JSON per turn. Attachments
   re-downloaded and re-hashed per attempt (`attachments.ts:101-138`). Direction: hashes first, files on miss; sha256 cache. **S.**
10. **Every run turn fetches from GitHub again** (`agent-runtime/src/workspace/index.ts:404-445`, `:1354-1363`). The server
    knows the head (`pull_requests.head_sha`); pass it and skip the fetch when the mirror has it. **S.**
11. **`post_card` (11.6 k chars raw) and the action tools served in every turn shape** (`mcp/server.ts:98-116` hides only
    `post_answer` and run reports). Measure with #5 fixed, then serve by kind per shape. **S.**
12. **Turn setup is sequential and unmeasured** (credential resolve → ComputerSession.open → GhService.open → sandbox.open →
    bwrap ×2 → CLI; `turn.ts:1004-1123`); `chooseSession`'s six parts run under the global `CLAIM_LOCK` (`service.ts:464,572`).
    Direction: one timing line per step. **S.**

Checked and fine: #general welcome, guides and summaries spawn no model turns; reflections bounded; checks-wake once per head;
queue latency ~0 (claim wakes on enqueue); MCP rate limits far above the CLIs' call rate.

### A2. Server, database, realtime, GitHub

1. **Unread badges: one COUNT per member per message, no usable index.** `domain/messages.ts:477-497` awaits `unreadCounts`
   per member; `read/conversations.ts:176-191` counts `ord > last_read_ord` with only `messages_conversation_idx
   (conversation_id, created_at, ord)` (`db/schema/conversations.ts:156`); awaited before the sender's response
   (`commit/pipeline.ts:361-367`). Bootstrap does the same for every conversation. Direction: one grouped query; partial index
   `(conversation_id, ord) include (author_id, mentions) where thread_root_id is null and deleted_at is null`. **S–M.**
2. **The post-commit hook chain holds the response for notifications and push.** `notifyForMessage` → per recipient, in
   sequence: load approval, `push.control`, devices query, `push.sendAll` (`domain/notify.ts:176-239`); failed transports
   sleep 250 ms + 1 s (`push/sender.ts:38,67-77`). Direction: keep dispatch enqueue synchronous; run independent hooks
   concurrently; push and badge fan-out as tracked background work (the `UsageService.track` pattern). **S–M.**
3. **≈ 30–40 k idle DB round trips per hour from fixed tickers.** Claim long-poll re-checks every 500 ms under the global
   `CLAIM_LOCK` although `wake()` resolves waiters (`runtime/service.ts:118,355-371,429,457-497`) = 7 200/h; automations
   `tickMs: 1000` + `lockCheckMs: 500` with zero automations (`automations/engine.ts:114,238,264-278,465-478`) = 18 000/h,
   and `scanBurrow` takes the burrow advisory lock every second when any automation is published (`:502-510`); runtime sweep
   5 s, feedback source 5 s, welcome 15 s, hub revalidate 25 s, usage tick bypasses its TTL every minute
   (`usage/service.ts:48,414`). Direction: event-driven with slow safety ticks; one 15 s housekeeping tick. **S each, M together.**
4. **GitHub poller: fixed 30 s, 1 + 2·P requests per repo per cycle, never adaptive** (`github/poller.ts:111-131,403,560,573,
   670,740`); a PR with no check runs never gets `checks_handled_sha` (`poll-plan.ts:179`) so it's polled forever
   (`poller.ts:616-621`); forced no-ETag cycle every 10 min. 3 repos × 5 PRs → ~1 560 requests/h, 24/7. Direction: 30 s while a
   run/push grant/deploy is live or a person is active, 2–5 min otherwise; mark zero-check heads. **M / S.**
5. **Every realtime frame written 2–3×; outbox pruned only at boot.** INSERT … RETURNING (`pipeline.ts:130-144`), UPDATE
   `published_at` (`:346-360`), prune at startup only (`:374-386`, `index.ts:59`); managed mode appends to `session_events`
   again (`managed/events.ts:197-217`). Direction: drop the UPDATE, prune hourly; consider not persisting the outbox. **S.**
6. **Bootstrap over-fetches.** All `conversation_members` rows for `memberCount` (`read/conversations.ts:240-244,272`); every
   branch room's PR files and commits for a status dot (`read/views.ts:131-142`, `read/work.ts:299-346`); full pending
   approval rows to count decidable ones (`views.ts:162-174`). **S.**
7. **`threadView` loads every reply, unbounded** (`read/views.ts:317-322`; `api.messages.thread` has no cursor,
   `routes/conversations.ts:268`). Contract change first. **M.**
8. **Integration tests migrate 84 migrations per file, 254 files** (`test/db.ts:82-111`). Direction: one template database per
   migrations hash, `create database … template …` per file. **S–M.**
9. **Audit log page: full-history `count(*) group by kind` per view** (`read/audit.ts:133-137`), only `events_actor_idx`
   usable. Partial covering index `(burrow_id, kind) where text is not null`. **S.**
10. **Hub fan-out: one global delivery chain, five awaited personalizers per frame, per-recipient stringify**
    (`realtime/hub.ts:70-76,139-142,210-247`, `personalize.ts:16-31`); `typing` costs an `isMember` query each (`:309-318`).
    Direction: dispatch by event type synchronously; stringify once; short membership cache. **S.**
11. **Three auth queries on every REST/file request, uncached** (`auth/request.ts:46-59`, `auth/service.ts:535-556,67-90`).
    30–60 s cache keyed by token hash + slug, invalidated by existing bus controls. **S.**
12. **Work view open questions: correlated scan per candidate** (`read/work-overview.ts:254-282`). One grouped query or
    partial index `(conversation_id, thread_root_id, ord)`. **S.**

Checked and fine: attachments stream with hashing; image sniff reads headers only; canvas edits debounced; web subscribes
only to the open room + burrow + me; signing is one SELECT + one INSERT per event; MCP tool list built only on `tools/list`.

### A3. Web client

Measured from `apps/web/dist` (matches HEAD): JS+CSS 8 882 kB raw / 2 528 kB gzip; main `index-*.js` 3 100 kB / 947 kB
gzip; CSS 286 kB / 51 kB; lazy: pdf.worker 1 203 kB, pdf 400 kB, terminal 327 kB, highlight 69 kB; mermaid 3 489 kB is an
`?url` asset for the sandbox iframe only.

1. **One 3.1 MB main chunk; every screen is a static import.** `apps/web/src/app/router.tsx:63-119`, no `lazyRouteComponent`;
   `vite.config.ts` has no `manualChunks` and `chunkSizeWarningLimit: 2048`. Tiptap/ProseMirror/Yjs/Hocuspocus in the main
   chunk for one route. Every deploy = full re-download. **M for the big wins, L for a full split.**
2. **The mock world ships to production.** `app/services.ts:20-26` statically imports `./fixtureFetch` → `@whombat/fixtures`,
   14 `*Fixtures.ts` modules, `managed/fake/ai`; the switch is a runtime `if`. Proof in the chunk: `fixtures.local` ×26,
   `October release notes` ×5. Direction: `await import()` behind the flag or a build-time `define`. **S.**
3. **Self-hosted origin serves assets uncompressed.** `apps/server/src/web/static.ts` streams raw; no `@fastify/compress`.
   Direction: emit `.br`/`.gz` at build, pick by `Accept-Encoding`. 3.1 MB → < 1 MB on the wire. **S.**
4. **The room re-renders at 1 Hz while an agent thinks.** `useTicker(…, 1000)` inside `useTypingLines`
   (`features/messaging/useRoom.ts:109-135`) called by `ConversationRoom.tsx:116`; `MessageList.tsx:131` unmemoized
   `groupByDay`, fresh closures per row (`:139-160`); no `memo(` in messaging/cards/components; `Sidebar.tsx:713`
   `useNow(30_000)` re-renders the 819-line sidebar. Direction: clock into the typing leaf; `memo(MessageRow)`. **S–M.**
5. **Every reconnect invalidates the entire query cache.** `packages/client/src/realtime/realtime.ts:221-228,270-282`;
   `query/connect.ts` `invalidateForResync` on a `burrow:` topic → every endpoint query; reconnect on every
   `visibilitychange`/`online` (`web/index.ts:22-32`). Thundering herd on every deploy. Direction: scope the resync; later
   cursor resume (protocol has per-connection `seq`). **S / M.**
6. **Image thumbnails download the original.** `MessageAttachments.tsx:200-205,166-170`; contract has no thumbnail
   (`contracts/attachments.d.ts:61-69`); `THUMB_MAX` 360×240 vs 250 MiB uploads. Server-side thumbnail at upload. **M.**
7. **No windowing except the PR file view** (`features/branch/FileView.tsx:33`); audit log and search flatten all pages.
   `content-visibility: auto` first, a virtualizer for audit/search. **S / M.**
8. **Self-hosted build loads fonts from Google, render-blocking** (`apps/web/index.html:22-26`); local woff2 already in
   `src/app/fonts/` but only the managed build uses them (`main.tsx:15`). **S.**
9. **Shell-wide 30 s polling for a rarely shown notice** (`app/shell/AgentsBlockedNotice.tsx:29-31`,
   `features/agents/AiProviderPanel.tsx:32`, `features/ai/useAi.ts:15-25`): 1–3 requests/30 s per tab. **S.**
10. **Bootstrap is the whole world and refetched wholesale** on `conversation.updated` with `needsRefetch`
    (`query/apply.ts:440`), on skill-card decisions (`:763-765`) and on reconnect. **M, needs numbers.**
11. **Each `useTyping`/`usePresence`/`useAgentNow` consumer subscribes to the whole query cache**
    (`packages/client/src/react/realtime.ts:56-70`). One shared subscription per key. **S, unmeasured.**

Checked and fine: avatars `<img loading="lazy">`; markdown parse memoized; highlight/xterm/pdf lazy; reducers preserve
identity; `staleTime 30 s`, `refetchOnWindowFocus: false`; channel open ≈ 4 requests; hashed assets immutable.

---

## B. New features (ranked by value-to-effort for a small self-hosting team)

Re-evaluation of the 2026-09-27 D-list: closed since — D-2 (`schedule` tool, RA-30/31), D-3 (reflection, RA-24), D-4
(`completion_evidence`, AO-04), D-5 (“Always allow”, RA-06, GF-10), D-6 browser, D-8 mostly, D-9 (handoff `outputSchema`),
D-10 (Files space), D-13 (retire). Partially open: D-1 (spend shown, no guardrails/no per-run cost), D-7 (semantic recall;
no longer worth it), D-11 (no cheap auxiliary slot; low value), D-12 (Microsoft 365 built; email-in/IMAP not,
`connectors.md:98`), D-14 (API tokens + `http_callback` exist; SSO, iOS, SIEM don't). Essentials item 13 still open.

1. **Supervise self-scheduled and background work from the phone.** Web has Schedules, Computers (status, allowances,
   ports), Spend, Audit, Canvases; mobile has none of them (`grep Schedule|Computer|Spend|Audit|Canvas src/screens` → only
   `AgentScreen.tsx`). Agents can wake themselves every 5 min (`SCHEDULES_ACTIVE_MAX = 20`) and the only off switch is the
   web. Mobile screens over existing endpoints; no contract change. **M.** NEW
2. **Team digest: “what the agents did today.”** Work view is live state only (`read/work-overview.ts`), spend has windows
   (`read/spend.ts`), a `digest` card kind exists (`domain/cards.ts:145`). Server read `work.digest(since)`, a burrow
   schedule, the digest card in a channel/DM, web Work “Today”, mobile Work. **M.** NEW
3. **Spend guardrails for machine-paced turns.** Per-agent/burrow token budget that alerts and pauses only
   `schedule|reflect|notify|automation` triggers; cost/tokens on the run page and schedule card (`Run` has no usage; only
   `dispatches.usage`). Tokens-only keeps the “no intermediating usage” stance. **M.** D-1 remainder
4. **Stop an agent's chat turn.** No `dispatches.cancel` in contracts; only run pause/take-over, thread deletion and handoff
   stops cancel turns. Stop on the typing line and in RIGHT NOW; Pause/Stop on the run line. **L** (contract, server,
   runner abort, web, mobile). NEW
5. **Deploy record and environments board.** `github_deploys` only for Actions `workflow_dispatch` (`github/deploy.ts`);
   SSH/computer deploys since GF-01…11 leave `vault_uses` lines only. `Deployment {environment, service, sha, how, by, at,
   evidence, previous}` + “what is live where” + rollback pointer. **M.** NEW
6. **Quality feedback loop on agent work.** One-tap good / not what I wanted + why on a message or run, stored per agent,
   fed into the next `reflect` turn, counted on the agent page. **S–M.** NEW
7. **Data export, deletion and retention** (essentials 13): per-burrow export, account deletion, message+attachment
   retention. Only whole-instance backup/restore, `audit.export` CSV and channel clear exist. **M–L.**
8. **Email-in and IMAP/CalDAV** (D-12 remainder): inbound address per channel/agent reusing the feedback intake model. **L.**
9. **GitLab / Forgejo / Gitea as a code host for runs** (REST connections exist, no MR rooms/checks/merges). **L.** NEW
10. **First-run sample project and first-week playbook** (mention → run → PR → checks → merge in ten minutes). **S–M.** NEW
11. **OpenAPI reference + a people CLI** (`whombat say #ops …`, `whombat ask @banjo …`). **S–M.** D-14 narrowed
12. **OIDC single sign-on** beside Tailscale identity. **M.** D-14
13. **iOS app** (Expo config exists; ActivityKit “later”). **L.** D-14
14. **Audit sink for a SIEM** (NDJSON/syslog off the outbox) + “verify chain” button. **S–M.** D-14, low value
15. **`/metrics` for the operator** (queue depth, failures by `TurnFailureCode`, outbox lag). **S.** NEW, low-medium
16. Slack-class leftovers: saved items, send later, persisted drafts, `has:` filters. **S each**, lowest value.

Left out deliberately: pgvector recall, auxiliary model slot, Slack/Teams bridge, huddles, run comparison, a `database`
Vault kind, shared SSH servers at burrow scope.

---

## C. Web UI/UX (paths relative to whombat-app)

1. **Search wakes the researcher on every pause in typing.** `features/search/SearchScreen.tsx:116-141` asks whenever `q`
   changes without an answer; server always inserts a new answer row and enqueues a `search` dispatch
   (Whombat `commands/content.ts:95-141`); reuse only for the exact same query (`read/search.ts:660-661`). Ask on Enter or an
   explicit button; reuse recent answers. **S.** Also an efficiency/cost item.
2. **No web inbox.** `notifications.inbox` used only by `managed/ApplianceApp.tsx`; Work lists approvals/runs; badge is a
   plain unread count (`packages/client/src/conversations.ts:75-81`); Settings copy promises an inbox
   (`NotificationsTab.tsx:136,454`). A `/inbox` with Needs you · Mentions · From agents. **M.**
3. **Thread reply box: no attachments; draft leaks between threads and is lost on close.** `ThreadView.tsx:452-497`
   (no `+ file`, paste or drop); `ThreadPane.tsx:60` state never reset on `threadId`; `app/shell/hosts.tsx:24` no `key`.
   Reuse `Composer` + `useUploads`; key the pane; draft map. **S–M.**
4. **No way to stop a thinking agent** (see B4). **L.**
5. **Esc in search drops you on the first channel.** `SearchScreen.tsx:191-195` navigates to `/` without `preventDefault`;
   the shell then also navigates to `lastOutsideSearch` (`app/shell/hooks.ts:126-131,146`); `e2e/keyboard.spec.ts:149`
   codifies `/`. Delete the screen-level handler. **S.**
6. **No message permalink** although `#msg_…` links are accepted (`ConversationRoom.tsx:228-230`) and the memory editor
   asks for one (`MemoryEditor.tsx:135`). “Copy link” in the message menu. **S.**
7. **“Needs you” is a vanishing, unstyled row that duplicates Work** (`sidebarModel.ts:196-208`, `Sidebar.tsx:243`). **S.**
8. **Side panes take no focus and return none** (`components/SidePane/SidePane.tsx`, 39 lines). Modals already do (SM-06). **S.**
9. **Profile pane opened from a DM dead-ends on the roster** (`hosts.tsx:71`). **S.**
10. **Drafts don't survive a reload** (`ConversationRoom.tsx:44-45` per-tab Map). **S.**
11. **No unread divider or “jump to latest”** (`ConversationRoom.tsx:231,236`; day dividers only). **M.**
12. **`/ command` offered in agent DMs with nothing behind it** (`Composer.tsx:527,354`; `model.ts:218-233`). **S.**
13. **Toasts: one at a time, no action, delete has no undo** (`components/Toast/Toast.tsx:21`). **S–M.**
14. **Fixed 256 px sidebar at every width** (`ShellLayout.module.css:28`, no `@media`). Collapse below ~1024 px. **M.**
15. **Spend copy counts “turns”** (`SpendTab.tsx:39-45`). Otherwise runtime jargon doesn't leak. **S.**

---

## D. Mobile (Android) UI/UX (paths relative to whombat-app/apps/mobile)

Screens exist for: Inbox, Channels, Agents, Search; Conversation/DM/Thread, Approval, Run, Work, Plans, Agent,
AgentSettings, Hire, Packs, Memory, Automations, Vault, Connections, Files, PullRequest(+File), Pins, Browse, NewMessage,
Share, SignIn, Devices, Settings sheet. No counterpart for: canvases, audit log, channel create/archive/visibility/members,
Members/invitations, email/thread notification prefs, Repositories, feedback reports, burrow usage, Computer control,
schedules, notes, allowed commands, automation editor. The four known open items are all still open.

1. **Any new message or “is thinking” change yanks the reader to the bottom; no “New messages ↓” pill.**
   `screens/ChatView.tsx:554-572` (`tail` = last id + `typing.length`; `toEnd` scrolls whenever `tail` changed even when not
   at end), `:882-883`. Follow only when at end or own send; else a floating pill. **S.**
2. **Enter sends, so no newlines/lists/code blocks from the phone; typed text lost on leaving.** `ui/chat.tsx:1705-1708`;
   draft only in component state (`:1561-1563`); no draft store. Return = newline; drafts per conversation/thread. **S.**
3. **A mention push or message link opens the conversation at the bottom, not the message.** `navigation/routes.ts:320`
   drops the `#msg_…` anchor, `:167-174`; `ChatView.tsx:883`. Pass `messageId`, load around it, `scrollToIndex`, highlight. **M.**
4. **Nothing on a message can be copied.** `data/messageActions.ts:16`; no clipboard module; `selectable` only in
   `htmlPreview.tsx:35`. `expo-clipboard`, “Copy text/link”, Copy on code blocks. **S.**
5. **Cold start forgets where you were; a notification-opened screen has nothing beneath it.** `RootNavigator.tsx:275` (no
   persisted state), `routes.ts:209-239` (no `initialRouteName`). **S/M.** System-back behaviour inferred, not run.
6. **Managed live notifications only move while the app's JS runs.** `managed/ApplianceRoot.tsx:448`,
   `live/LiveActivityBridge.tsx:48-91`; control's `clear` push cancels `GENERIC_TAG` only. `setTimeoutAfter` on ongoing
   notifications or a `clear` push for live keys; reconcile on push. **M.**
7. **Read state isn't realtime across devices** (no `notification.read` event in contracts; `android-inbox.md` Open). **M, server.**
8. **Notifications stay in the shade after reading in the app** (`setAutoCancel(true)` only; JS API has no cancel by tag). **S/M.**
9. **Canvases, audit log, web-only pages open the system browser with no sign-in hand-off** (`navigation/hooks.ts:100-118`,
   `routes.ts:484-494,198-201`). Read-only canvas screen; audit list screen. **M/L.**
10. **Channel administration and people management are web-only** (only Browse/Join; AP-515). **M.**
11. **Agent management gaps**: Computer as a status line only (`AgentScreen.tsx:127-133,171,279-283`), hire uses the default
    provider and all packs (`HireAgentScreen.tsx:64-66,158-159`); no schedules/notes/allowed commands. **M/L.**
12. **No day dividers and no unread marker in chat** (`data/messages.ts:535,575`; nothing in `ui/chat.tsx`). **S.**
13. **PR file view: no syntax colours, no deep link** (`PullRequestFileScreen.tsx`; `routes.ts:209-239`). **M.**
14. **Share-intent files pile up in the app cache** (`ShareScreen.tsx:104` clears memory only). **S.**
15. **Polish**: no haptics; push permission asked cold (`managed/usePush.ts:90-94`). **S.**

Confirmed fine on the phone: approvals (approve/decline/undo/conditions/Always allow), Vault asks, Try again, run
Pause/Resume/Take over, reply-to, reactions, edit/delete/pin, files/camera/share-in, link previews, search chips, Work view,
DND, APK self-update, QR + passkey sign-in, 44 dp audit, font scaling cap 1.6, tokens-only colours.

Not verified without an emulator: system-back on deep-linked stacks, browser sign-in state, JS background lifetime,
keyboard-avoidance interaction (`ChatView.tsx:919`, `app.config.cjs:74`), FlatList performance on long channels.
