# Chat channel — build brief (2026-10-18)

Decisions: `docs/decisions/chat-channel.md` (CHT-01…CHT-23) — read it first, then §1, §2 and your stream's part of §3.
Mockup John saw and agreed to: whombat-app `docs/design-handoff/chat-channel/index.html` (layout, order and words; the
app's tokens and component sizes win on details; the figures are made up). Background on what exists:
`docs/decisions/channel-threads.md` (CH-01…05, the channel threading this reuses), `one-whombat-assistant.md`
(ONE-DW14…DW16 task chats, which this replaces in the assistant shell), `chat-asks.md` (CA-01), `feedback` in
`less-is-more.md` (LM-F01…), `channel-clear.md` (CC-01…05), whombat-app `docs/decisions/one-whombat-shell.md`,
`home-simplify.md`, `feedback-chat.md`, `slack-thread-link.md`.

Integration branches `chat`: contracts `~/Code/.wt/contracts-chat`, Whombat `~/Code/.wt/whombat-chat`, app
`~/Code/.wt/app-chat`. Reserved: contracts **0.93.0** (CT-440…CT-469), whombat-app **0.91.0** (AP-2400…AP-2499),
Whombat migration **0116**, appliance candidate **0.102.0**. Another session (whombat-8f) is shipping skills work today
(app 0.90.2, candidate 0.101.2); it touches Whombat `apps/server/src/skills/*`, the app's
`packages/client/src/skillLibrary/*`, `apps/web/src/features/skills/AddSkillsDialog.tsx` and the persona's skills lines
in `packages/agent-runtime/src/persona/packs.ts` — don't edit those.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `server: …`, `runner: …`,
  `client: …`, `web: …`, `mobile: …`), every message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main` or `chat`, never touch
  the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`, `~/Code/whombat-appliance`) or
  other sessions' worktrees. The lead merges (and tells you when to `git merge chat`).
- **DEV fast** (John's rule): one quick check at the end — `TMPDIR=~/.cache/wb-tmp pnpm check` in your repo, plus
  `pnpm test:server` once for the Whombat stream. No VM tests, no repeated full suites, no CI waits, no sleeping to wait
  for data. Run single test files while you work. Own ports (S: `PORT=4494`, W: `PORT=4495 WEB_PORT=5201`) and
  throwaway databases; never stop or reset shared containers (`docker compose` is shared — never `down -v`). `/tmp` runs
  out of inodes: `TMPDIR=~/.cache/wb-tmp`.
- **Tests check facts, not sentences** (CLAUDE.md, `docs/decisions/test-speed.md`): names, ids, statuses, a short key
  phrase — no long literal text. Wait on events or inject short timeouts, never sleep. A new integration test file needs
  a reason to need Postgres; prefer adding cases to an existing file.
- **Never touch John's DEV box or real services from tests or scripts.** The lead does the live checks after the merge.
- **Copy**: plain, short English a non-developer understands (concise-replies.md): curly quotes (’ “ ”), `·`, `…`. No
  ids, paths or hashes in visible words. Instructions meant for the agent go to the agent, never into the chat.
- **Tokens only** for UI colours; match the surrounding code's style and comment density.
- Contract change needed after 0.93.0 is vendored? Don't edit vendored tarballs: message the lead (SendMessage `main`)
  with the exact additive change; prefer solving it on your side.
- Record your own decisions in your stream's file (S: Whombat `docs/decisions/chat-channel-server.md`, CHT-S01…; W:
  whombat-app `docs/decisions/chat-channel.md` AP-2400…AP-2449; M: the same file AP-2450…AP-2499; C: contracts
  `docs/decisions/contracts.md` CT-440…).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is left,
  what the lead must check live).

## 2. The wire shapes (contracts 0.93.0 — stream C makes them; everyone codes against these names)

Additive only; old servers and clients keep working.

- **CT-440 `Message.subject`**: `ChatSubject.nullable().optional()` — set on a thread's first message only (CHT-05).
- **CT-441 `ChatSummary.room`**: `z.enum(['chat', 'feedback', 'task']).optional()`; absent means `task` (a `default:
  true` row is `chat`). Export `type ChatRoom = 'chat' | 'feedback'` and `CHAT_ROOMS`.
- **CT-442 `ChatThread`** = `{ conversationId, room: ChatRoom, rootId: MessageId, authorId: PrincipalId, text:
  string ≤ 200 (the first message's start, plain), subject?: ChatSubject | null, createdAt, replyCount: Count, lastAt:
  Timestamp (last reply, else createdAt), working: boolean (the assistant has a turn on it now) }`.
- **CT-443 `chats.threads`**: `GET /burrows/:burrow/chats/threads`, query `{ room?: ChatRoom (default 'chat'),
  subjectKind?, subjectId?, before?: Timestamp (page by lastAt), limit?: 1…50 (default 30) }` → `{ threads:
  ChatThread[], next: Timestamp | null }`, newest `lastAt` first. Session operation safety READ.
- **CT-444 `chats.start`**: same body and response; its summary says it starts a thread in the caller's Chat (CHT-06).
  `chats.rename`/`archive`/`unarchive` stay for older apps.
- **CT-445 Links**: pure helpers in core `chatRoomHref(room)` → `'/chat' | '/feedback'`, `chatThreadHref(room,
  rootId)` → `'/chat?thread=<rootId>'`, `DASHBOARD_HREF = '/dashboard'`, and `parseChatHref(href)` → `{ room, thread:
  rootId | null } | null` (accepts `/chat`, `/feedback`, with or without `?thread=`). Unit-tested.
- **CT-446 Runtime feature `chat.channel`** (protocol `session/features.ts`, with the other features).
- **CT-447 Dashboard words**: every user-visible “Home” in contracts copy becomes “Dashboard” (feature labels,
  `HOST_ASKS_FIRST_WORDS.hint.never`, `report_change` / `home.overview` / widget tool descriptions, AP-2276's leftover
  “Done recently” copy goes too). Field and endpoint names stay.
- **CT-448 Contracts 0.93.0**: every package 0.93.0, `docs/decisions/contracts.md` entry, tag `contracts-v0.93.0` on
  branch `chat` (the lead pushes and merges).

## 3. Streams

### C — contracts 0.93.0 and vendoring (worktree `~/Code/.wt/contracts-chat`, branch `chat`)

Make §2 in whombat-contracts (with unit tests for the pure helpers and schema round trips), bump every package to
0.93.0, build the release tarballs the way 0.92.1 did (see the repo's `docs/publishing.md` and the previous release
commits), tag `contracts-v0.93.0` locally. Then vendor 0.93.0 into Whombat `~/Code/.wt/whombat-chat` and whombat-app
`~/Code/.wt/app-chat` on their `chat` branches exactly as 0.92.1 was vendored (`deps: @whombat contracts 0.93.0 …`
commits, lockfiles with them), with `pnpm install` and a typecheck in each. Report the commits; the lead tells S, W and M
to `git merge chat`.

### S — Whombat server, runner, persona (worktree `~/Code/.wt/whombat-chat-server`, branch `chat-server`)

Everything server-side of CHT-01…CHT-11, gated on the assistant shell (`WHOMBAT_SHELL=assistant`; tests ask for it with
`env: { WHOMBAT_SHELL: 'assistant' }`); the crew shell is unchanged. Code against §2's names; until C has vendored
0.93.0, keep the contract-dependent edits small or behind local types and `git merge chat` when told.

1. **Migration `0116_chat_channel`**: `messages.subject_kind/subject_id/subject_name` (nullable), whatever marker the
   fresh-start step needs (reuse an existing once-per-burrow boot marker if there is one). Expand only.
2. **Threaded rooms** (CHT-02): a person's top-level message in their Chat or Feedback room opens a thread exactly as a
   channel's does (`domain/messages.ts` `opensThread`, dispatch `opensThread` / CH-02 coalescing in `domain/dispatch.ts`,
   `runtime/context.ts` `earlierThread` for the opening turn, the runner's “reply in the thread” in
   `apps/runner/src/prompt.ts` / `turn.ts` `finalThreadOf`). Replies in a thread wake the assistant there. Agent posts
   without a thread stay top-level. Check cards (`runtime/dispatch-scope.ts` `turnThread`/`cardThread`), approvals
   (`approvals/create.ts`), Vault (`vault/use.ts`), connection asks (`connections/call.ts` `ownerRoomOf`) land in the
   turn's thread. Typing/“thinking” and the run line work per thread.
3. **Subjects and the turn topic** (CHT-05): store the subject on the root; `chats/view.ts` `chatContextTopic` /
   `chats/title.ts` `chatTopic` give the per-thread line; `toConversation`'s `chat` is gone for Chat (it is the default
   DM). `Message.subject` in every message read model.
4. **`chats.start`** (CHT-06) in `chats/commands.ts`: post in the caller's Chat (`ensurePersonalDm`) with the subject on
   the root, signed as a message (no `chat.started`), answer `{conversation, message}`. Subject resolvers as today.
5. **`chats.list`** returns the Chat (`default: true`, `room: 'chat'`) and the Feedback room (`room: 'feedback'`) when it
   exists; archived task chats only with `archived=true`. **`chats.threads`** (CHT-07) new read with paging and the
   subject filter, `working` from the dispatch/turn state.
6. **Feedback room** (CHT-03) in `feedback/chat.ts`: `ensureFeedbackRoom(ctx, person)` (key `feedback`, title
   “Feedback”, `chat_retitled_at` set); integrations point at it (`ensureFeedbackChat` callers, `destinationOf`,
   `isFeedbackChat`, `destinationLabel`); the boot step `moveFeedbackToChats` moves integrations from `fb-…` chats (and,
   in the assistant shell, from channels the shell hides) to their person's Feedback room. Reports keep posting one
   thread each.
7. **Automations** (CHT-09) in `automations/steps.ts` (BP-C40): resolve the room when a run posts. `recipe.job ===
   'assess'` → the publisher's Feedback room (made when missing), else their Chat. Tests with a recipe that names a
   hidden channel.
8. **Fresh start** (CHT-04): a boot step run once per burrow after migrations (like `moveFeedbackToChats` in
   `index.ts`), through the pipeline: for each active personal assistant's default DM and task chats, remove messages
   the way `clear_conversation` does (factor the removal out of `commands/message-edits.ts` into a helper both use;
   `clear_conversation` itself keeps refusing non-channels), keeping `threadsWithWork` and threads that are a feedback
   report's root; archive the task chats. One signed event per burrow with counts. Test it on a seeded burrow.
9. **Home links** (CHT-08): `home/overview.ts` `questionItems` / Working on / chat turns read threads of the Chat (an
   assistant message that asks something in a thread until the person writes in that thread again), `home/changes.ts`
   and `domain/links.ts` link with `chatThreadHref`. Watch's `investigate` and things' `ask` links keep their intent; the
   client calls `chats.start`.
10. **Feature** `chat.channel` in `managed/runtime-features.ts` (assistant shell only), the release manifest list.
11. **Persona** (CHT-11, CHT-02): `packages/agent-runtime/src/persona/whombat.ts` — one task per thread (no
    `set_chat_title` in Chat; keep the tool for older task chats or drop it from the assistant's list, your call, write
    it down), Dashboard instead of Home. Not `persona/packs.ts`.
12. Tests: one integration case per numbered item above where it needs Postgres, unit tests for pure parts. Then
    `TMPDIR=~/.cache/wb-tmp pnpm check` and `pnpm test:server` once.

### W — web and `packages/client` (worktree `~/Code/.wt/app-chat-web`, branch `chat-web`)

You own `packages/client` for this build. **First** (within your first commits, and tell the lead when they are in so
M can merge them): the shared client pieces —
`useChatThreads(room, subject?)` (paged, live on the room's conversation topic), the room ids from `chats.list`
(`useChatRooms()` → `{ chat, feedback }` with unread counts), the `chat.channel` gate, link parsing for `/chat`,
`/feedback`, `/dashboard` and `?thread=` (core's `parseChatHref`), “Dashboard” in `assistantWords` / `managed/updates.ts`
labels, and `homeSections` unchanged except words.

Then the web (CHT-20, CHT-21, CHT-23): `apps/web/src/app/shell/assistantSidebarModel.ts` + `AssistantSidebar.tsx`
(Chat, Feedback, Dashboard, Watch, Automations, Vault; no Conversations, no Ask), `router.tsx` (`/` → `/chat`,
`/feedback`, `/dashboard`, old `/chats…` redirects, `FeatureGate chat.channel` with the old shell kept for older
servers), a `ChatRoomScreen` built from `ConversationRoom` in channel look with threads (`MessageRow` reply row,
`ThreadPane` via `?thread=`, subject chips on roots, “is looking into it” under a root while `working`), opening the new
thread after a top-level send, a **Threads** list (header button; newest first, subject chips, paging), the empty state
(“Ask Dusty anything. Each question gets its own thread.” in the assistant's name), the thing pages' Ask pane (CHT-23),
and every visible “Home” → “Dashboard” (`HomeScreen`, `WidgetCard` “Unpin from Dashboard”, errors, titles, tests).
Visual check against the mockup in both themes at 1440×900 (the repo's Playwright/visual tooling; fake world
`VITE_WHOMBAT_TRANSPORT=session VITE_WHOMBAT_FAKE=1` with fixtures — add Chat/Feedback/threads fixtures). Then
`TMPDIR=~/.cache/wb-tmp pnpm check`.

### M — Android (worktree `~/Code/.wt/app-chat-mobile`, branch `chat-mobile`)

CHT-22 in `apps/mobile`: `data/shell.ts` `ASSISTANT_TABS` = Chat · Dashboard · Things · Watch, `homeTab` → Chat,
`navigation/TabBar.tsx` labels/icons, `RootNavigator.tsx` initial route Chat on every cold start (`navigation/persist.ts`:
don't restore another tab at launch; migrate saved Home → Dashboard, Chats → Chat), a Chat screen on the shared
`ChatView` as a threaded room (`ThreadRepliesRow` → `Thread`, subject chips, working line), header buttons Threads and
Feedback (badge), sending a top-level message opens its `Thread` screen, a Threads list screen, the Feedback room screen,
links (`navigation/routes.ts`, `one-links`) for `/chat`, `/feedback`, `/dashboard`, `?thread=`, old `/chats…`, every
visible “Home” → “Dashboard” (`HomeScreen`, `DoneScreen` back bar, `NeedsYouSheet`, `ServersCard`, `ThingsCard`, tests),
`NewChatSheet` and the Chats tab gone in the `chat.channel` shell. Use W's client pieces (merge `chat` when the lead says
they are in; until then code against the names in W's brief). Check it on the emulator with the fixtures APK
(`EXPO_PUBLIC_WHOMBAT_MODE=fixtures EXPO_PUBLIC_WHOMBAT_SHELL=assistant`, `android:apk --variant release`, AVD
`whombat-mobile` `-read-only`, under `agent-resource run`; see `~/.cache/wb-tmp/mockups/home-simplify/emu.sh`), screenshots
of Chat, a thread and Dashboard. Then `TMPDIR=~/.cache/wb-tmp pnpm check`.

## 4. After the streams (the lead)

Merge S into Whombat `chat`, W and M into app `chat`; app release 0.91.0 (+ APK on DEV downloads), vendor it into
Whombat `chat`; merge contracts/app/Whombat `chat` into `main`, push; whombat-dev restart; live check on whombat-dev;
appliance candidate 0.102.0 runtime-only `--reuse-host` to the dev stack and John's box; check on the box that the fresh
start ran, Feedback holds the Whombat Website integration and the tracker/Fusebox automations, and Chat opens first.
