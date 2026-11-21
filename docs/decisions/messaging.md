# Workstream: messaging and branch room (`apps/web/src/features/{messaging,branch}`)

TODO 5.1–5.6 (UI) and 10.2–10.3 (UI). Builds on `web-shell.md` (WS-01/02: screens take props, panes and
modals are URL state), `client.md` (live data, optimistic sends), `core-contracts.md` (copy and time
helpers) and `fixtures.md`.

## Layout

```
features/messaging/
  ChannelScreen, DmScreen, ThreadPane   containers (router props → queries, mutations, realtime)
  ConversationRoom                      header + tabs + scrolling list + composer, shared by all rooms
  ConversationHeader, MessageList, MessageRow, Composer, DmEmptyState, ThreadView, PrincipalAvatar
                                        presentational (contract types in, callbacks out; stories)
  model.ts                              pure view logic (history, day groups, member stack, mentions,
                                        commands) — unit-tested
  useRoom.ts, useUploads.ts             live room data, sending (+ commands), typing, read state, uploads
features/branch/
  BranchRoomScreen                      container: PR detail + its conversation + merge
  BranchTabs, FilesTable, BranchPane    presentational (stories)
  model.ts                              header chip, check/reviewer rows, staging summary, merge button
```

Cards are rendered through the seam `features/cards/MessageCard` (`<MessageCard burrow card messageId
conversationId>`), wrapped in a `display: contents` element marked `data-message-card` so an empty card
adds no gap and visual specs can hide cards.

## Decisions

| # | Decision | Reason |
|---|---|---|
| MS-01 | One `ConversationRoom` renders channels, DMs and branch rooms (header, optional tabs, list or a replacement body, composer). The branch room passes its tabs and the Files changed table as `body`; the composer stays on both tabs, as in the mock. | One scroll/typing/send implementation; the mock uses one template for all three. |
| MS-02 | A room opens at its **newest** message and follows new ones while the reader is within 120px of the bottom; loading older history keeps the reader's place; a `#<messageId>` hash scrolls to that message. The static mock shows the top of the list, so the visual spec scrolls to the top before comparing. | Chat behaviour; the mock never scrolls. |
| MS-03 | The thread pane opens at the **root** and only follows replies (and typing) that arrive later. | Matches the mock and reads top-down. |
| MS-04 | Header member stack: up to six heads in membership order; the stack is one `role="img"` labelled "8 in room: Priya Raman, …". Agent heads are drawn at the ring's **content** width (26px in the 30px ring, 20px in the 24px thread-link ring) in a box 2px taller, reproducing how the mock's 28px/22px flex item shrinks. | Pixel parity (mismatch on the header went from 0.12 % to 0.04 %); one accessible label instead of eight. |
| MS-05 | Header actions ("Plan canvas", "Branch room") are links (`linkPath` of the conversation's action) styled as the mock's secondary buttons. | They navigate. |
| MS-06 | **Slash commands**: `/topic <text>` (channels; empty clears the topic) and `/invite @Name …` (channels and branch rooms; names by mention name or handle). The list opens while the draft is a single `/word`; `//` sends a literal slash; unknown commands, commands in DMs and blocked/refused outcomes show an inline notice (the thread reply box has no commands: its text is always sent); successes show a toast ("Changed the topic of #general.", "Added Hazel to #general."). | The mock's chip only inserts `/`; these two map to existing endpoints (`conversations.update`, `conversations.addMembers`) through the commit pipeline. |
| MS-07 | **Mentions**: typing `@` (or the `@ agent` chip) opens a list of agents first, then people, without the viewer, at most 8, matching the start of the mention name or any word of the full name. ↑/↓ move, Enter/Tab pick, Esc closes (and `preventDefault`s so the shell doesn't close a pane). People are inserted by short name (`@Joris`), agents by name. | `resolveMentions` in core resolves exactly those names. |
| MS-08 | **`+ file`**: the server answers `uploads.create` with 501 until object storage lands (C-14), so the chip is `aria-disabled` with the tooltip "File uploads aren’t available yet". `VITE_UPLOADS=1` turns on the full flow (reserve → PUT → send `attachmentIds`), and messages render attachments as chips. *Superseded by `bp-attachments.md` (BP-A13): uploads are always on; `VITE_UPLOADS` is gone.* | Honest UI now, no code change needed when storage ships. |
| MS-09 | Composer: Enter sends, Shift+Enter adds a line (the input is a growing textarea, max 220px); drafts survive switching rooms (in memory, per tab); a failed or refused send restores the draft. Optimistic messages show at 72 % opacity until the server copy replaces them. | Mock behaviour plus the obvious edge cases. |
| MS-10 | Composer notices sit in the dock's 22px bottom padding (one line, ellipsis, full text in `title`), so a notice never moves the composer. | No layout jump while typing. |
| MS-11 | **Superseded in part by one-person.md OP-S14**: “{Agent} is thinking” stays, with no `mode`; nobody else types, so there is no “{Name} is typing”. "{Agent} is thinking" comes from `useTyping` (`mode: thinking`); people typing show "{Name} is typing". Without a socket (fixture mode, Storybook, tests) a send that dispatches an agent shows the indicator for the mock's 1.6 s and then refetches, where the fixture world has stored the canned reply. | Same UX with and without a server. |
| MS-12 | Reactions are buttons (`aria-pressed` = mine) that toggle through `useReaction` (optimistic). The mock has no "mine" styling, so none is added; hover darkens the text like other ghost controls. | Mocks win on visuals. |
| MS-13 | Day dividers group by calendar day in the viewer's zone (preference, else the burrow's) with `formatDayDivider` ("Today · Wednesday 23 September", "Yesterday · …"). Thread links show `formatThreadLast`: the clock for a reply today (core now never says "last just now"), then "Yesterday", weekday, date. | Real day logic. |
| MS-14 | DMs are found in the sidebar, else opened through `POST /dms` (get or create); a newly opened DM refetches the bootstrap so DIRECT lists it. The empty state shows when the DM has no messages; its three suggestions fill and focus the composer (they are not sent). | README "DM with agent". |
| MS-15 | The empty DM intro says "an" before a vowel ("Sketch is an architect") in `@whombat/core`'s `dmIntro`; the mock's template always says "a" but never renders an architect or operator DM. | Grammar where the mock is silent. |
| MS-16 | The fixtures and the seed world include Mara's empty DM with Hazel (the mock's DIRECT lists Pippa and Hazel; Hazel's DM is how the empty state is reached). Supersedes FX-02 / WS-15's "one DM". | Parity with the mock sidebar. |
| MS-17 | The typing indicator's dots pulse: a 1.2 s opacity wave (.3 → 1) runs left to right for as long as "{name} is thinking" / "is typing" shows. With reduced motion they stay still at the mock's 1, .6, .3. | Asked for by the user (2026-09-25): a long turn looked stalled with still dots; the mobile bubble already pulses. |
| BR-01 | `BranchRoomScreen` lays the room and the 340px `SidePane` (side bg) out in a row inside `<main>` (WS-02); below 1240px the pane overlays the frame like every pane. | Same geometry as the mock's sibling `<aside>`. |
| BR-02 | Tabs are ARIA tabs (buttons with `aria-selected`, ←/→ switch) driving `?tab=files` through the router's `onTabChange`; "Files changed" shows the file count in mono. | Deep-linkable, accessible, mock look (2px ink underline). |
| BR-03 | CHECKS markers follow the mock: passed/skipped = filled ok circle; queued, running **and failed** = warn ring (the note — "38/41" — and the state label say which). | The mock only distinguishes ok / not ok. |
| BR-04 | REVIEWERS show full names ("Joris de Vries"), `REVIEW_STATE_LABELS` in the state's tone. STAGING shows `approvalView().short` for `PullRequestDetail.staging`; "Review deploy" (or "Review request" for other actions) shows only while nobody has decided and opens `?approval=<n>`. No staging approval → no STAGING section. | Core owns the approval phases. |
| BR-05 | **Merge into main** is `aria-disabled` (focusable, described by why it is off and by the note) rather than `disabled`: ready = primary, blocked = sf2/mut/`not-allowed`, merged = sf2/ok "Merged into main". Outcomes: ok → cache update, bootstrap refetch, toast "Merged PR #482. Nice digging, everyone."; 409 → the server's message under the button (`role="alert"`) and a refetch; Blocked (403) → "Blocked: merging needs the “Merge into main” key."; approval required → a notice. | People-only merge; stale screens get a clear answer. |
| BR-06 | The Files changed note uses the PR author's short name (`filesNote`). The fixtures answer `prs.merge` like the server (409 `conflict` with `mergeBlock` until checks and review pass). | Mock copy; merge works in fixture mode. |

## Shared files touched

- `packages/fixtures/src/fetch.ts` (+ test): `prs.merge`; earlier in this workstream: the empty Hazel DM,
  @mention replies, thread reply bumps, `openDm` (and `apps/server/src/seed/fixtures.int.test.ts` parity).
- `packages/core/src/text/copy.ts` (`dmIntro` a/an), `packages/core/src/text/time.ts` (`formatThreadLast`), + tests.
- `tools/visual`: `prepare` hook, `setReferenceState()` and `--state` (the mock's thread link has no handler).
- `apps/web/src/app/router.test.tsx`, `apps/web/src/app/shell/keyboard.test.tsx`: expect the real DM,
  branch and thread screens instead of placeholders. `apps/web/src/vite-env.d.ts`: `VITE_UPLOADS`.

## Verification

- `pnpm visual` → `apps/web/visual/messaging.spec.ts`: everything right of the sidebar vs. the reference
  (`--screen channel|dm|branch`, `--state conv=general|incidents|dm-hazel`, `--state pane=thread`,
  `--click "Files changed"`, 1200px for the overlay panes), light and dark, cards hidden on both sides,
  thread heads/root text patched to the mock's hard-coded values, the Lucide close icon masked. Budget
  0.15 %; measured 0.01–0.05 % (avatar anti-aliasing, AV-02).
- Unit/component tests: `model.test.ts` (both folders), `components.test.tsx`, `screens.test.tsx`,
  `BranchRoomScreen.test.tsx` (live `pr.updated`, 409, merge + toast).
- Live against a real server (throwaway database, `pnpm demo:play`): @mention → "Banjo is thinking" →
  reply; empty DM suggestion → reply; thread reply with receipts; reactions toggle and persist; `/topic`,
  `/invite`, unknown command; opening a new DM adds it to DIRECT; the branch room follows the storyline
  (38/41 → 41/41, Changes requested → Approved, "Open · changes requested" → "Open · ready", Merge turns
  on) and merging shows "Merged" and the toast.

## Mentions in any case (MS-C01…, 2026-10-01)

John wrote `@banjo …` in a channel thread and nothing woke Banjo: core only knew `@Banjo`. “If I can make this mistake
any user can.” Built on contracts 0.33.0 (CT-207); assignment `docs/implementation/agent-guidance/assignment.md` § A.

| # | Decision | Reason |
|---|---|---|
| MS-C01 | **What counts.** `@` + a word whose letters equal, ignoring case, a mention target's mention name (agent name; person short name, else first name; core `mentionNameOf`) mentions that target: `@banjo`, `@BANJO`, `@Banjo`. Same order as before (agents, people, personal agents, PA-04). A non-canonical form counts only with CT-207's boundaries, stricter than first written: before the `@` the start of the text or a character that isn't a letter, mark, digit, `_`, `.`, `@`, `/`, `-`; the word all letters/marks; after it no letter, mark, digit, `_`, `@`, `/`, and no `.`/`-` + letter or digit — so `john@banjo.example`, `x/@banjo`, `@banjo.example`, `@banjo2`, `@banjo_bot`, `@whombat/core` stay text. Not inside inline code or fenced blocks. Only targets whose mention name is `[A-Z][a-z]+`, compared ASCII-only. The canonical `@Banjo` behaves exactly as before. Unknown words (`@nobody`) stay as typed; `@channel` / `@here` stay broadcasts (CT-176), never principals. | A handle-like continuation waking an agent is worse than a missed correction, which the person still sees as plain text. |
| MS-C02 | **Stored canonical.** The server's `postMessage` (`apps/server/src/domain/messages.ts`) stores `canonicalizeMentions(text, targets)` — the same `mentionTargets` list `resolveMentions` gets — before mentions, the signed event, search indexing and realtime frames, for every author (people and agents). `edit_message` does the same before comparing with the stored text, so changing only a mention's letter case (`@Pippa` → `@PIPPA`) is no edit (no `editedAt`, no event); an edit that newly mentions `@pippa` is stored `@Pippa` and wakes Pippa once (CT-173). The licence gate `wouldWakeAgent` needs nothing new: core's `resolveMentions` canonicalises itself. The seed loader stores the canonical text too (the mock world's texts already are; nothing changed). Feedback's inert text puts a word joiner after every `@`, which isn't a letter, so it never canonicalises. Same length in and out, so the 48 000-character check is unaffected. | `segmentMentions` is unchanged: stored text is canonical, so `@Banjo` renders in brand/600 on web and Android without client changes. |
| MS-C03 | **Auto-correct in the composer** (web and Android, `autocorrectMentionAt` after an insertion, `canonicalizeMentions` on send, the optimistic message canonical): the App stream, whombat-app 0.22.0. | One rule in core for both clients. |

## Agents don't link local paths (MS-L01, MS-L02; 2026-10-07)

John, 2026-10-07, on Banjo's #general message citing “the [requesting-code-review skill](/var/lib/whombat-runner/tmp/
whombat-runner-952-skills/…/SKILL.md)”: the link leads nowhere in the app. “Yes, fix that.”

| # | Decision | Reason |
|---|---|---|
| MS-L01 | **Stored as words.** `postMessage` runs an agent's text and its `more` hint through `unlinkLocalPaths` (`apps/server/src/domain/local-links.ts`) before mentions, the event, search and realtime: a Markdown link whose target is `file://…` or an absolute path under a top-level Linux directory (`/var`, `/tmp`, `/home`, `/run`, `/nix`, `/etc`, `/root`, `/srv`, `/opt`, `/usr`, `/persist`, `/work`, `/workspace`, …) becomes its label (an empty label: the path as inline code). Web addresses and Whombat's own links (`/c/…`, `/agents/…`) stay; inline code and fenced blocks are left as written. People's messages are untouched (they may mean it), agents can't edit. In the server, not core: no contracts release for one server-side rule; clients render whatever is stored. | A dead link looks like a working one; the label keeps the meaning. |
| MS-L02 | **Said in the prompt.** `WRITING_LINES` (`apps/runner/src/prompt.ts`): links are for what readers can open; a skill, a file on the computer or another local path is named in plain words or `code`. | Codex lists skills by their `SKILL.md` paths and cites them; MS-L01 catches what slips through. |

## A drawing shown once (MS-D01, MS-D02; 2026-10-08)

John, 2026-10-08, on Dusty's 24-hour CPU graph in #general on his box: “why it's showing two graphs instead of one.”
Dusty had called `upload_file` with `whombat-prod-cpu-24h.svg` and then posted the reply with that file attached and
the same SVG, byte for byte, in a ```svg block: the app drew the block (with “View code”) and showed the file under it.
The prompt offered both ways with an “or” and nothing caught a message that used both. “Yes” to fixing both.

| # | Decision | Reason |
|---|---|---|
| MS-D01 | **The file stays, the copy goes.** `sendMessage` runs an agent's text through `dropSvgCopies` (`apps/server/src/domain/svg-copies.ts`) when it attaches files: a fenced block (core's fence rule; `svg`, `xml`, `html`, `htm` or no language) holding the same SVG document as an attached `image/svg+xml` file is removed, the rest of the text is kept (one blank line where the block was). Same means `svgImageDocument` of both is equal after dropping whitespace between tags and collapsing the rest. Another drawing, other code and people's messages are left as written. A message that was only the copy becomes the file alone. In the server, not core: no contracts release; clients render what is stored. | The attached file is the better of the two: full width, in the conversation's Files, downloadable. Dropping it instead would lose the file the agent meant to share. |
| MS-D02 | **Said in the prompt.** `WRITING_LINES` (`apps/runner/src/prompt.ts`): a picture is an attached `upload_file` image or a ```svg block, “one of the two, never both, or it shows twice”, and an attached file is preferred for charts. | MS-D01 only catches an exact copy; a PNG rendered from the same SVG still shows twice unless the agent picks one. |
