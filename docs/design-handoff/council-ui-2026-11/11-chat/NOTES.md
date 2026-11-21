# 11 · One Chat, including empty and failed reads

Mockups only. All committed files are in this folder. No app, token, contract, test, decision document, shared gallery, scoring sheet or TODO changes. Branch `delegate/one-chat-design-with-its-empty-dvl8b` fetched origin and merged its default branch before authoring; `origin/main` was already current at `382f0597e`. No council or subagent was started.

John subsequently asked to skip CI, lint, typecheck, notices and all tests, and not wait for pull-request checks. None of those commands is run. Chromium rendering, visual inspection and the requested color measurements are design evidence only, not an application test run. No software service changed; the temporary fixture Vite is stopped at handoff. Existing development/production services are untouched.

## The one main design

Open [index.html](index.html). Select desktop web, phone-width web, iOS or Android, Chat or thread, read state, light/dark and kept-largest text. The before and after are next to each other at their real dimensions: desktop **1440×900**, each phone **390×844**. Desktop comparison scrolls within its named review region. The phone-width web drawing has a closed drawer and its 56px navigation bar, with no squeezed sidebar. The native designs are **HTML drawings**, separately labelled beside actual native before evidence from step 08.

The chronological Chat timeline stays. This does **not** adopt step 02’s replacement thread-row list, its refresh-only ordering policy, or its new-data summary. Those alternatives still belong to that earlier review. No replacement-list variant is offered here: the task explicitly chooses the shipped timeline. Step 07’s message actions and text policy join that timeline rather than a second main layout.

Every root has a readable link line, including roots with no replies. Its winning stage is `waiting` → **Waiting for you**, else `working` → **{assistant} is working**, else `handedOver` → **Handed over**, else an actual `settled` object → **Settled**. The marks are an amber dot, partial neutral ring, branching arrow and neutral tick respectively. **No flag does not mean Settled.** With no stage evidence, keep the real count and last-reply time; zero says **No replies yet**. A stored sentence saying “I’m looking into it” is never used to infer working. The warm pve-02 root has `working=true` and gains the working line; the Home Assistant/UniFi/pve-01 roots do not claim work from their prose. The original messages remain verbatim historical messages.

The entire replies row is a navigation link with its right chevron. There is no repeated visible “Open thread ›”. The row’s accessible name still explains its destination. Unread remains the **TU-05 dot**; the name says “New replies”, corresponding to the brief’s New reply. It is independent of stage, has no second per-row numeric badge, and is suppressed for the open thread and Settled. The component sheet’s unread case comes from step 02’s explicitly unread-enabled fixture, not the baseline’s empty unread result.

| App | Fix and decision kept |
| --- | --- |
| Desktop web | Keep full messages, date dividers, the reply link with participant face/count/time, separate waiting chip and **Answer**. The waiting stage is stated **once**, in that existing chip immediately above its link; its link’s name also includes waiting. Do not add another visible waiting word to the link. UIR-64/65/66 stand. Other flag stages sit in the link. |
| Phone-width web | Same timeline and web waiting/Answer behavior. Each message has **one persistent 44×44 ⋯ on its author line**; it opens the message’s conditional actions in a sheet. No hover-only strip or separate Settle icon. |
| Native iOS | Keep **3 replies · Waiting for you** in the thread link (AP-7417), the native approval **Review and answer** door, long-press/word selection and message accessibility actions. Omit a visible message ⋯: a 44pt button would raise the 24pt author line in these scenes. Header More is a different existing control. |
| Native Android | Same content and conditional long-press/More behavior, distinct arrow-back and app bottom bar. All new native controls use **48dp** targets, including composer, links, Back, header More and recovery. |
| All four | The viewer’s own name/face leave their message headers, including replies inside a thread; the timestamp stays. Accessible self messages say **Your message**, not the person’s name again. Participant stacks omit the viewer too; this fixture therefore has one eligible assistant face. The person’s name remains in Settings. |

UIR-67 and AP-7461 keep the thread’s question in the header only once the root has scrolled away; its full accessible heading remains available. Threads open at their end, so the waiting card and its actual CTA are reachable (AP-2409/AP-7417). Back names Chat; iOS keeps its previous-title chevron and Android its 48dp arrow. Actual navigation/gesture rendering remains a native verification gap.

**Settle stays conditional.** Waiting, working and handed-over work cannot settle. Settle remains in an eligible root’s actions, and Settled remains its own shelf with **Open again**. The static shelf shows only records whose `settled` field is present. The neutral tick proves that field, not that a command succeeded. The mock sends no Settle/Open again/approval command. Keep existing confirmations, 8s Undo (web hover/focus pause; native recommended timeout/VoiceOver dismissal), next-row focus after Settle and the original row on Undo. No new undo or suggested answer is attached to approvals.

## Dusty’s accepted main-design changes

These are the user’s shared design instructions, not new decisions made by this task:

- **Reopens AP-2645 — decided by Dusty for John’s review.** Native More includes Search as the route to the shared phone Search design. The Search screen itself is owned by the findability work; this Chat mock uses a destination-only preview.
- **Reopens AP-6412 — decided by Dusty for John’s review.** iOS uses the readable token-colored badge convention. AP-7463’s “iPhone keeps iOS’s red badges” clause is affected as well. The Inbox badge retains the known broken-item color and the Feedback unread badge uses neutral ink.
- **Reopens STG-03, STG-10, STG-12 — decided by Dusty for John’s review.** The existing Spend destination is named **Usage** and is findable outside Advanced in desktop navigation. Its canonical route/content are not changed here; the page is the Usage workstream’s responsibility.

The visible **Search** link on desktop and in the phone-web navigation menu has **no search box**, keeping AP-2274. Files before Vault builds on step 06. Android’s 48dp requirement is applied. Folded connection heads-ups, council results in words and delegation PRs under Details are accepted shared rules, but no connection/council/delegation card is drawn in this task. No new decision about those unpictured surfaces is inferred. The effective native **1.6× cap stays**; there is no raised-cap variant, recommendation, invented consequence or additional approval undo.

The six requested Chat decisions remain in force: UIR-64’s separate web waiting/Answer; UIR-66’s full-row navigation and count/time/participant structure; AP-7417’s native joined waiting/replies; AP-2454’s separate thread-list surface; TU-05’s dot; AP-2408’s cache updates and newest-activity order **for thread lists**. That list is not substituted for Chat’s message timeline. Step 02 would reopen all six; it is not the main design here.

## Empty, loading and failed reads

All five states are inspectable for **both Chat and thread on every platform and in both themes**. [The compact state sheet](mockup.html?screen=states) shows six components together, not a fifth app design.

| Read state | Selection and words |
| --- | --- |
| Successful empty Chat | Successful zero open roots: **Your Chat starts here.** “Ask {assistant} anything. Each question gets its own thread.” **Ask a question** focuses the unsent composer. Settled remains reachable. |
| Successful empty thread | The selected root is known; successful zero replies: **0 replies**, **No replies yet.**, “Replies to this question will appear here.” **Write a reply** focuses the composer. This is a local query-state specimen, not the populated fixture rewritten as fact. |
| First loading | No prior result; **Loading your Chat…** / **Loading the thread…**, one polite status and decorative message-shaped placeholders. No fabricated question, zero count, waiting flag or progress. |
| Failed first read | Step 05’s exact structure: **Couldn’t read your Chat.** / **Couldn’t read this thread.** “There’s no saved copy to show on this device yet.” **Try again**, **Ask {assistant}**, folded **More detail**. |
| Failed refresh with saved result | **Couldn’t refresh your Chat.** / **Couldn’t refresh this thread.** “Showing the messages/replies already on this device.” Retain those messages and their order. Never substitute a successful empty state or skeleton for saved content. |

The error block follows 05: neutral `sf`, `line2` border, local `warn-text` heading, plain explanation, no red health cue or second banner. Diagnostics are folded. **Try again reads only** (`messages.list` or `messages.thread`); the static button announces Reading again without inventing a successful response. Ask focuses an **unsent** question in the known conversation. A read failure is not a failed agent turn, failed approval or proof a command did not happen. Unknown command outcomes retain command-safety’s check-before-another-action behavior; no action retry is added here.

## Every pictured line and mark: source ledger

Paths are repository-root relative. `fixture.js` is a read-only snapshot; `renders.json` records rendered wording and exact computed color pairs. No product fact in the main design requires new data. Review headings, specimen captions, GAP text, selectors and Preview only dialogs are review apparatus, not messages from Whombat.

| Pictured family | Source and exact binding |
| --- | --- |
| Assistant name in every authored stage, Ask, composer, eyebrow and action | `packages/client/src/agentName.ts`: **agentWords(theAgentOf(bootstrap.principals)?.name)**, resolved by `build-data.mjs` into `fixture.js.assistant`. Templates interpolate it; no authored fixed assistant name. |
| Assistant face | Captured agent’s `face=neo`, `packages/avatars/src/index.ts` mapping to `operator-head.svg` / `operator-head-small.svg`; actual production SVG files under `packages/avatars/svg`. The small variant is used in reply stacks/native. |
| Burrow HQ, Mara Okafor, MO, web Inbox 7 | Fixture `conversations.bootstrap.burrow`, `me/principals`; `home.overview.summary.needsYou`, from `apps/web/src/app/oneFixtures.ts`. The Settings initials are derived fixture identity; no human face remains on a message row. |
| Chat, Inbox, Overview, Automations, Files, Vault, Settings, Servers/Connections, the five native tabs | Existing shell, `CHAT_WORDS`, native `navigation/TabBar.tsx`, step 06’s Files/Vault pair. Navigation icons are a Lucide-path drawing; server logo art is contextual schematic chrome, not a service-page redesign. |
| Visible Search, Usage, phone More entries | Existing web Search / Spend destinations plus Dusty’s accepted presentation changes above. Native Search destination is the marked shared AP-2645 change. No additional search results or Usage values are invented. |
| Server/service names and three amber sidebar marks | The same fixture shell as groundwork: thetitan, pve-01, pve-02, blackbox, the-falcon, Home Assistant, UniFi; pve-02/Home Assistant/UniFi need a look. The diagram does not make new health claims from a thread’s tone. |
| All nine web root messages, complete words, time and chronological order | `apps/web/src/app/chatChannelFixtures.ts` and `lookFixtures.ts`; captured `messages.list`, filtered to roots in open `chats.threads`, then sorted by root `createdAt`. No first-message summary truncation is imposed. |
| Yesterday/Today, Tuesday 22 / Wednesday 23 September; web 22:30, 07:00, 07:12, 08:29, 09:31, 09:41, 10:12, 10:58, 11:04 | Each stored root `createdAt`, the harness’s fixed **2026-09-23 11:22 Europe/Amsterdam**, existing date-divider vocabulary. The older update question is not grouped under Today. |
| Waiting for you, working, Handed over, Settled and their marks | `ChatThread.waiting`, `.working`, `.handedOver`, `.settled`, in that precedence. Only the component sheet uses the existing optional handoff fixture (`02-chat-list/fixture-data.js.examples`). Actual settled specimens filter `.settled`, because the look fixture’s mixed response also contains open roots. |
| Reply counts, No replies yet and last-reply ages | Real `ChatThread.replyCount`, `lastAt`; last-reply labels only with positive count. Zero is a count fact, not a lifecycle stage. Native waiting replaces the age, per AP-7417. |
| Unread component dot / New reply | Step 02’s existing `newReplies:true` fixture, pve-02 unread=2. That count is not displayed. Baseline web `chats.unread.threads=[]`. The dot remains dot-only visually; accessibility carries New replies. An open/settled thread suppresses it. |
| No-flag question / overlap specimens | Clearly captioned local existing-field samples: clear the memory thread’s four flags; zero-reply case uses step 02’s local “Can you check last night’s backups?”; overlap sets all four existing flags and demonstrates waiting winning. No new field or baseline claim. |
| Native memory/firmware question, own timestamps 13:52 and 14:04; thread 13:53, 13:58 and 14:03 | `apps/mobile/src/fixtures/chatChannel.ts`, `CHAT_ROOTS.memory/firmware` and stored message times. Main native Chat is a focused excerpt of those two questions; older roots remain above. The shared web prose is byte-identical for the shown questions/replies. Native uses root `msg_chat-memory`, approval **33**, rather than web `msg_chat-pve-memory`/**902**. `fixture.js.native` explicitly records this mapping. |
| Native Feedback 1 and Inbox 3 | `fixtures/chatChannel.ts` Feedback unread and fixture needs-you count; actual iOS/Android before evidence and trees in step 08 show those values. They are **not** borrowed from web’s seven. |
| Why is pve-02 using so much memory?; 91%, 38 GB, 16 GB; the three complete replies | Web `PVE_THREAD`, `messages.thread.root/replies`; the native counterpart’s exact same prose. The viewer’s cache-limit reply retains its time and words while its own name/face leave. |
| Switched to ChatGPT | Native `chatRuntime.ts` / `DEMO_RAN_ON.memoryFirst/memoryLast`, captured in step 08’s thread tree. Web memory replies do not switch, so the web drawing adds no divider. Provider marks in the composer use shipped `claude.svg` and `openai.svg`. |
| pve-02 subject; About other subjects | Stored `Message.subject`; pve-02’s known fixture health is Needs a look. Other chips say **About {name}** to accessibility and omit a health mark when this drawing has no bound status value. No “Needs a look” is inferred for every subject. |
| Limit the ZFS cache on pve-02 to 16 GB; needs your OK; native Review and answer | The existing pending `Approval` and core/native AP-7404 door. Native `whatHappens=[]`: **no new consequence is added to its card**. The actual assistant reply already mentions a restart. |
| Web “pve-02 restarts once to apply it”; Yes, now / Yes, tonight / No; Don’t ask again…; technical lines | Web approval’s actual `whatHappens`, `target`, `explainer`, shared core approval words and separate lasting-yes rule. No suggested answer or new consequence field. The native door keeps its existing approval-screen destination, represented by a destination-only preview here; no second approval-screen design or inline answer is introduced. |
| ⋯, Message actions, conditional Reply/Edit/Pin/Delete, Add reaction, Copy link; conditional Settle | Web `features/messaging/messageActions.ts` is called when exporting data, with the real fixture owner and room/thread place. `useMessageActions.tsx` supplies Copy link; busy flags govern Settle. Native keeps its shipped custom Reply/Settle/Open again/More/Copy/link actions; HTML contextmenu/Shift+F10 is a review proxy. |
| Error headings, saved/no-copy explanation, Try again, Ask, More detail, Loading, empty messages | New presentation copy selected only by known client query scope and `data/error/isLoading`; step 05’s exact no-copy sentence/shape. The diagnostics “The fixture read did not answer.” / `messages.list` / `messages.thread` are explicit seeded read failures, not fetched incidents. |
| Ask a question / Write a reply; Ask {assistant} anything / Reply… / Reply to {assistant}…; File/model/mic/Send | Existing Chat/native composer words, UIR-60…62 and AP-7418. Empty send remains outlined; HTML submission is prevented. No message or action leaves the prototype. |
| 09:41, top phone symbols and native bar outlines | Step 08’s normalized OS chrome time, illustrative system shapes. They are not a battery/network measurement. iOS/Android chrome is a layout proxy, not a device screenshot. |
| All before pixels | Groundwork’s web fixture screenshots and step 08’s actual fixture-only iOS/Android captures, with their source/build/clock manifests. Fresh web before captures here use the same harness, routes and data before this mockup was authored. |

## Accessibility, expansion and stability

**Screen-reader order:** header and origin → day → combined message author/time/body (self: Your message, time, body) → subject → separate waiting/Answer on web → replies link → next message → composer → native Chat tabs. Native implementation must retain AP-7410’s one combined message element and hidden selectable-text duplicate; cards/subject/replies remain their own elements. An assistant face is labelled by its helper name, participant faces/marks/chevrons are decorative inside the named link, and color never replaces a stage word. No initials or the viewer’s name are read for self messages.

Example native link: **“3 replies, Waiting for you, Why is pve-02 using so much memory?, Open thread.”** The real unread variant includes **New replies**. A no-flag line names its count/time and question, never an invented stage. Topic chips name the known status or About; the thread’s complete question is the header’s accessible name even when visually truncated. Android back says **Back to Chat**; iOS retains the previous screen name while it fits.

**Focus:** DOM/keyboard order follows the pictured order. ⋯ is named **Actions for your/{assistant}’s message at {time}**, declares its dialog and expanded state. Enter/Space opens Message actions with the first available action focused. The labelled native HTML dialog contains focus; Escape, Close or scrim dismissal closes it and returns to the exact opener without moving the stream. Native intended More/long-press closes back to the same combined message, retaining word selection rather than replacing it with a new gesture. The HTML contextmenu and Shift+F10 demonstrate that destination, not UIKit/Material gesture behavior.

**Expanded behavior:** Technical details and More detail expand in place below their own summaries and keep focus on the trigger. They wrap diagnostics/command lines. Answer opens the existing thread at its waiting card and focuses its first action (UIR-65), never answers it. Native Review and answer keeps its existing review-screen destination; its static preview identifies that destination. Preview-only actions describe their destination rather than falsely recording success. The approval’s facts remain visible at largest text; web buttons stack; the native card keeps the full title and full-width door. Closing a native review must return to that door; real OS focus and back gestures need implementation verification.

**Touch:** phone web targets ≥44 CSS px; iOS ≥44pt and Android ≥48dp (represented by CSS px in this scale-1 study). The native message’s 24pt author line is not raised by a new action button. The combined message exposes its existing accessible actions. New reply rows are at least 44/48 high; desktop retains UIR-66’s 40px link. Header Back/More, composer buttons, recovery, disclosures and native tabs use their platform minimums. Header More contains items that do not fit. Static OS bar symbols and status marks are not individual targets.

**Largest text:** native remains at its effective **1.6×** cap at the largest system setting, following step 07; web content is drawn at **200%**. Content grows and scrolls; no approval fact or action label is line-clamped. Thread titles keep the shipped single-line header treatment, with their complete accessible name. Header Chat actions keep the established fit/priority: Feedback longest, then Settled, What {assistant} did, Files; a largest-text Settled moves into More. Tabs retain their local fitting exception. These are HTML geometry studies, not actual Dynamic Type/nonlinear Android scaling, keyboard, safe-area or VoiceOver/TalkBack certification. Step 08 remains the actual shipped largest-text evidence.

**No reorder under the finger:** Chat roots keep message order. Stage/unread/count changes do not turn it into a priority list. Preserve stable message/root IDs, scroll anchor and focus; append incoming roots without re-sorting older roots. AP-2408’s thread-list cache still updates and uses newest activity first on its separate list surface. While an actual pointer/gesture/focus operation is in progress, defer a visual move until it ends, then apply the pending cache order and restore the anchored item; do not change the cache policy or wait for a manual refresh. No sorting or timer runs in this static document. Settle/Undo are explicit changes, not background reshuffles.

## Pictures, colors and limitations

Before authoring: fresh Playwright **Chromium** captures for desktop/phone-web Chat and thread, light/dark, frozen **23 September 2026, 11:22 Europe/Amsterdam**, scale 1, en-GB, bundled fonts, reduced motion. The web fixture flags are `VITE_FIXTURES=1 VITE_FIXTURE_HOSTS=1 VITE_FIXTURE_DASHBOARDS=1 VITE_FIXTURE_FILES=1 VITE_FIXTURE_AUTOMATIONS=1`, with fixture looks in local storage. Native before images are copied from step 08’s actual fixture-only builds at **14:05**, not mislabelled web pictures. Both sets are in ignored `.whombat/shots/`; `.whombat/` is in `.git/info/exclude`.

The gallery links existing committed before images instead of duplicating them. Native historical-before views show a wider slice of history than the two-question after excerpt. Native phone screenshots and drawings use their own 14:05 times; web uses its own 11:22 times. A newly drawn empty/error/loading state has **no matching before capture**, and the gallery says so. A normal screenshot is not substituted as proof of those states. Web before capture deliberately starts at the top; thread after starts at its end per the retained opening rule, with the same loaded question/replies/card. This camera difference is explicit, not a claimed pixel-only diff.

**16 compressed PNGs**: four desktop Chat/thread images, six phone Chat+thread pairs (each individual pane is exactly 390×844), two phone-web action sheets, two read-state sheets and two flag-case sheets. Individual matching after viewport pictures, read-failure pictures and largest-text thread pictures are also kept under `.whombat/shots/`. Main captures use real token CSS, font files, production avatar and provider assets; no new hard-coded component colors, radius or shadow palette.

The shared preview first reported unavailable; `preview_open` rejected the local file with **“Invalid preview URL (unsupported-protocol: file:)”**. The requested Playwright Chromium path renders local files directly. No preview tab was opened or borrowed. The 38 render records have no page errors; color measurements and visual inspection cover normal Chat/thread, the error block, largest text, sheets and stage cases. No app suite or interaction tests were run.

WCAG 2.x sRGB luminance, `(lighter + .05)/(darker + .05)`, measured with step 01’s `contrast.js` over rendered solid text/background pairs, scrolling normal timelines to include lower messages/cards. Target **≥4.5:1 even at large text**, including badge/control text. Raw RGBs and text pairs are in `renders.json`.

| Drawn surface, sampled minimum | Light | Dark |
| --- | ---: | ---: |
| Desktop, including shell and approval controls | **4.888:1** | **5.515:1** |
| Phone-width web, including action sheet | **5.190:1** | **5.515:1** |
| Native iOS HTML design | **5.281:1** | **5.515:1** |
| Native Android HTML design, including tab controls | **4.722:1** | **5.515:1** |
| Shared read-state / flag sheets | **5.428:1** | **5.515:1** |

All sampled pairs pass. Waiting words use `warn-text`; marks use `warn`; muted text remains opaque. The Android minimum is active-tab brand on `sf2`. Icons/focus boundaries, avatar/provider artwork, native system rasterization/transparency and hidden/offscreen words outside the sampled scroll positions are not a full WCAG audit. Badge colors are token pairs measured in HTML, not a claim to have changed iOS’s actual OS badge.

Remaining gaps: native implementation, gestures, screen-reader/focus journeys and keyboard avoidance; unseen long histories/attachments and a real live-update gesture; same-state built-app empty/loading/read-error before evidence; independent glance/find participants. No app score or built-app verification column is filled. No original `.dc.html` baseline is replaced. An implementation would update the specific `chat-channel/` Chat/thread reference plus shared message/action and read-state specimens in **Whombat Desktop.dc.html** / **Whombat Mobile.dc.html**, then deliberately capture web/native baselines.

## Reproduction

From the repository root with Node 24 and frozen-lockfile dependencies installed:

```sh
# A temporary fixture-only Vite, not a Whombat/runtime/database service:
VITE_FIXTURES=1 VITE_FIXTURE_HOSTS=1 VITE_FIXTURE_DASHBOARDS=1 VITE_FIXTURE_FILES=1 VITE_FIXTURE_AUTOMATIONS=1 pnpm --filter @whombat/web exec vite --host 127.0.0.1 --port 5307 --strictPort
node --import tsx docs/design-handoff/council-ui-2026-11/11-chat/capture-before.mjs
node --import tsx docs/design-handoff/council-ui-2026-11/11-chat/build-data.mjs
node docs/design-handoff/council-ui-2026-11/11-chat/render.mjs
```

The HTML opens directly from disk. No static server is needed for after drawings. Stop the fixture process afterwards. No container, database, native build or deployment is needed for these mockups.

## Picture delivery

`delivery.json` records attempts at all three supplied addresses, in order, for the 16 before/after viewport views. HTTPS fails DNS resolution; both HTTP fallbacks sometimes return **500**. Six before views and an earlier four desktop after views were accepted at `http://10.100.1.81:4480`. The final revised after retry was rejected for all 16 views. Accepted comparison areas still receive their numbered plain-language notes, separately recorded in `notes-delivery.json` (all four sets accepted); their earlier accepted pictures are not claimed to be the final uploaded revision. Final PNGs and local shots are retained regardless of upload failures.
