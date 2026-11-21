# Phone comfort and large text

## Scope and assumptions

Mockups only, in this folder. No application code, tests, tokens, decisions, shared gallery or scoring sheet changed.
The branch was fetched and merged with `origin/main` before work (already current at
`f3e17c5286cfda043fd69f3af79922f2314bf6a3`). This is a proposal for step 07, not an implemented accessibility fix.

Open `index.html`. Its three columns show before evidence, the buildable version and its explicitly marked variant.
Choose the app, screen and theme. Each phone drawing has a 390×844 viewport and scrolls independently. `plates.html`
makes the ten compressed 1440×900 PNG contact sheets; each phone in a plate is still exactly 390×844, with no scale
transform. The gallery itself adapts to a narrow browser with a named, horizontally scrollable comparison region;
that review surface is not a proposal for sideways scrolling in the app.

The buildable native version keeps the **effective 1.6× text cap**, including at iOS’s largest accessibility category
and Android’s largest system setting. These HTML drawings model that limit with linear font sizes. They do not
establish the native platforms’ actual glyph metrics, Android’s nonlinear scaling, safe areas or screen-reader tree.
The native platform render and assistive-technology checks remain GAPs below.

The work focuses on Chat, the approval door and its review screen, live council members and a working delegation.
It does not restyle settled score tables, offered-task AI pickers, other app screens or desktop Chat. Card fields stack
under their names; the provider, state and elapsed time no longer compete in a right-hand 42% column. Names and
button labels wrap. Content grows and scrolls; it is never made smaller to fit a card.

The native approval already stacks its one-time answers above 1.3× (AP-7409): the proposal **keeps** this, the door
to review, outlined Yes now/tonight choices, the lasting yes’s separate confirmation, and no duplicate conditions
card when the person’s yes is its only condition (AP-6553). Council answers and completed delegation tasks keep
their existing folds. The task’s ⋯ stays on its link line under its status (AP-7731).

## Evidence and capture GAPs

Before web evidence is linked from `../01-groundwork/png/phone-web-{chat-list,thread,approval}-{light,dark}.png`,
not rewritten. The groundwork used Playwright Chromium, the repository’s `tools/visual` harness, fixture data and
the frozen 2026-09-23 11:22 Europe/Amsterdam clock. Its capture manifest records the helper’s assistant name.

For the web action proposal, `web-snapshot.mjs` also captured the current fixture Chat at the same 390×844, theme,
clock and initial scroll position, before changing the snapshot’s markup. Its before images are in
`.whombat/shots/phone-comfort-before-web-{light,dark}.png` (local, excluded from Git). The after is a **static DOM/CSS
snapshot** of that fixture render: same 7-item count, messages, dates, header, composer and fonts. Only the message
toolbar becomes one persistent 44px button, with room reserved in the author line. The app itself is untouched.
The open sheet is the same first, waiting assistant message; it has no Edit or Settle action. Available actions
remain conditional per message, including Settle only when allowed. There is no new thread `failed` flag.

Native **before: GAP N-IOS and GAP N-ANDROID, independently, light and dark**. Neither is represented by a web picture.
`apps/mobile/preview-runtime.cjs` exports a sandboxed JavaScript module/data URL for preview assets, not a screen
renderer. There are no generated `apps/mobile/ios` or `apps/mobile/android` projects or verified fixture-only binaries
in this checkout. Device discovery found Android emulators locally and iOS simulators on Mac Studio, but none had
attested fixture-only provenance for this checkout. No real device, real account, existing booted app or real data
was opened. The groundwork’s attempt to export the native app to web also required `react-native-web`, and such an
export would not verify native layout anyway. Installing or publishing an app is outside this mockup-only task.

All native after pictures are labelled **static HTML, not native captures**. They are drawn separately: iOS previous
page title and chevron, system-style rounded bottom tabs; Android 48dp arrow target and plain app bottom bar. Actual
SF Symbols, UIKit glass/menus, Material dialogs, predictive/edge back, accessibility font maxima and VoiceOver/TalkBack
must be checked in a fixture-only native build before implementation is accepted. No native screenshot/contrast
coverage or whole-app score is claimed. iOS and Android confirmations in the HTML are layout proxies, not replicas
of their system dialogs.

## What changes in which app

| App / scene | Buildable version | Decision boundary kept |
| --- | --- | --- |
| Native iOS and Android Chat | Name then time, wrapping waiting/reply row; content and cards keep the available width at 1.6×. | AP-7410/11 combined message reading and custom actions; AP-7417 waiting in the replies row; no new Chat status sentence. |
| Native approval door / review | Full-width review door; growing title/consequence and one-time answers stacked in the existing order. | AP-7400…09, AP-6553. The yes is not preselected; a lasting yes still asks first. |
| Native council | Name, provider, state/time in reading order; full-width answer expansion. A no-answer row uses `mut` at full opacity. | AP-7640…46. Still working is a reduced-motion ring; no-answer is a local card outcome, never a thread failure. Lower opacity is avoided to meet contrast. |
| Native delegation | Same one-column reading order, actual task step below status, ⋯ on the link line, merged tasks folded below. | AP-7730…37. No Settle while handed-over work goes on; no AI picker invented on a working checklist. |
| Web at phone width | One always-visible 44×44 message button, replacing the 28px hover toolbar. It opens a labelled action sheet. | Existing permissions, confirmation rules, Reply, reactions, Copy link, Pin, Edit/Delete and conditional Settle remain. No new data. |
| Native side tabs / desk | A 390px excerpt shows the side-tab case separately. The 72pt rail keeps its shipped fit-to-width labels in main. Desk preview is a fixed-size miniature in both sizes. | AP-6550’s exception is retained in main. Ordinary phone bottom tabs retain their shipped local fit/cap; they are not redesigned. |

“Needs you” remains the Inbox’s group, not a Chat/card heading. Thing health stays Not working · Needs a look ·
Learning · Connected. Where a thread stage is drawn it is selected from flags in this order: Waiting for you >
{assistant} is working > Handed over > Settled; unread alone may add New reply. Waiting is drawn for pve-02’s pending
approval; firmware uses its working flag, without inventing a reply count. The web snapshot keeps the shipped wording.
Settle remains available where permitted, never on the waiting or working examples. Heads-ups remain folded; no new
heads-up is drawn. A waiting card has one amber frame; red is not used for timeouts, a person’s No or no-answer members.

## Decision for John — reopens AP-6550, AP-7460

**Proposed shared text cap: 2.4×**, beside the 1.6× main version on every native gallery scene. This is a choice for
John, not a change to either decision. It increases the cap by 50%. The iOS drawing reaches 2.4×; the Android drawing
stops at its 2.0× system maximum, so it does not promise 2.4× from a system that only offers 200%.

| Consequence | Keeps decisions: 1.6× | Raised-cap variant |
| --- | --- | --- |
| Chat header at 390 | Feedback fits; Settled, What {assistant} did and Files in ⋯. | iOS 2.4×: all four in ⋯. Android 2.0×: Feedback still fits, the other three in ⋯. |
| Fit budget from `data/headerFit.ts` | Chat estimate 89.6pt; 268.4pt available. Feedback plus menu 183.52pt; adding Settled exceeds it. | iOS: 223.6pt available, Feedback plus menu 237.28pt does not fit. Android: 246pt available, Feedback plus menu 210.4pt fits. No priority order changes. |
| Side tabs (Duo excerpt) | 72pt rail, labels shrink to fit down to the existing 60% rule and explicit 1.6× maximum. | 184pt rail lets the 11pt base labels reach 26.4pt on iOS without shrinking. It leaves only 206pt for the page at a total width of 390pt: a visible cost, not a recommended default. |
| Body / approval | 15.5 → 24.8pt body; 24 → 38.4pt question. | iOS: 37.2pt body / 57.6pt question. Android: 31pt / 48pt. Longer content needs more scrolling; footer answers remain reachable. |
| Desk miniature | 346×216.25, a 1280×800 drawing at 0.2703125. | Identical bounds and drawing text/tile dimensions; the surrounding page labels grow. The preview is one accessible image, not tiny individual targets. |

The side-tab proposal deliberately changes its local `maxFontSizeMultiplier={1.6}` as well as the shared cap; merely
changing `theme/Text.tsx` would not change that local override. Ordinary bottom-tab fitting stays as shipped. The
drawer/tab priorities and the five destinations keep their order. A raised shared cap would also require reviewing
`dynamic-type.test.ts`’s current `<= 2` guard and native header/side-tab measurements; none are changed here.

Desk preview is an isolated, schematic fixture excerpt to demonstrate the no-scaling exception, not a redesign or a
native before image. Its source is `DeskPreviewScreen.tsx`’s 1280×800 drawing and its `T` text helper with
`allowFontScaling={false}`. Its example server names/lines come from the fake desk world. Native pixel parity of the
miniature remains part of N-IOS/N-ANDROID; the identical HTML bounds are measured in `verification.json`.

## Every pictured line and its source

Paths here are relative to the repository root. `fixture.mjs` rebuilds the card/desk snapshot using existing fixture
constructors and shared view helpers, with no API/session. `fixture.json` and `fixture.js` are the readable snapshot
and browser form. The assistant value is copied from groundwork’s actual
`agentWords(theAgentOf(bootstrap.principals)?.name).name`; templates interpolate `assistant`. No authored assistant
name is hard-coded. The static web snapshot naturally contains the fixture helper’s rendered value.

| Pictured line family | Existing source / binding |
| --- | --- |
| Assistant name and operator face | `apps/web/src/app/oneFixtures.ts`, bootstrap principals; `packages/client/src/agentName.ts`; production `five-agents/svg/operator-head.svg`. |
| Mara Okafor / MO, author and message times | `packages/fixtures` Mara principal; `apps/web/src/app/chatChannelFixtures.ts` messages, person and `createdAt`. |
| Native memory question, pve-02 subject, three replies, waiting | `chatChannelFixtures.ts` `PVE_THREAD`, its three replies and pending ZFS approval; `ChatThread.waiting`, shared subject status helpers. |
| Firmware question / {assistant} is working | `chatChannelFixtures.ts` `FIRMWARE_THREAD` and its working state; no reply count is supplied or invented. |
| Today, 11:22; native status-bar symbols | Frozen fixture date/clock, `tools/visual`; native OS chrome is illustrative. “Today” is the existing date-divider label. |
| Chat, Feedback, Settled, What {assistant} did, Files; native tab words | `apps/mobile/src/screens/ChatRoomScreen.tsx`, `data/headerFit.ts`, `navigation/TabBar.tsx`, `data/shell.ts` (`TAB_WORDS`); name helper for interpolations. |
| Ask {assistant} anything / Reply…, File, AI, mic/send names | Native Chat composer and `packages/client` Chat words; Attach a file / Choose AI / Dictate a message / Send message are static control labels, not new server facts. |
| Approval question and “pve-02 restarts once to apply it” | `chatChannelFixtures.ts` ZFS `Approval` #902: `question`, `whatHappens`; its assistant reply is verbatim. |
| {assistant} needs your OK / Review and answer / Technical details | AP-7404/05 renderer and shared `approvalView`; title/source fields already present. |
| servers · server_command / Restarting a server always asks a person. | The same approval’s `action.params.handle`, `tool`, `explainer`; kept folded. |
| Yes, now / Yes, tonight / No | `@whombat/core` `APPROVAL_ASK_WORDS`; native `ApprovalScreen`, AP-7400/01/02/09. |
| Don’t ask again for pve-02… / confirmation / Keep asking / Let {assistant} do it | Existing lasting-yes helpers and AP-7407/08; server target from approval. No suggested answer or unsupported consequence is added. |
| Council heading, Researching, all model/provider names, statuses, times and 8/10 | `apps/web/src/app/councilFixtures.ts` NAS council; `councilCardView` / `councilMemberView` at the frozen clock. In particular Muse’s elapsed time is the helper’s **57 min**, not a guessed 58. |
| Read/Hide its answer, NAS answer, The rest is in T3 Code, Stop, Change who sits on it | The same fixture member’s `answer`; `packages/client/src/council.ts` `COUNCIL_WORDS`. Expanded answer shows its first full fixture paragraph; continuation stays linked, as shipped. |
| Delegation title, 1 of 3 merged · 1 working, task numbers/names, Working, After 2, Merged, provider, elapsed, step | Login checklist in `councilFixtures.ts`; `delegationCardView` supplies active and folded rows. No new progress fields. |
| 1 merged / Pull request / More for … / Open in T3 Code / Stop this task / confirmation | `packages/client/src/delegation.ts` `DELEGATION_WORDS`, per-task `pr`, `url`, `stoppable`; AP-7730/31. |
| Screen / Preview / miniature name, time, server names and system lines | Native desk settings labels; `packages/client/src/desk/fakeWorld.ts` `defaultFakeDeskWorld`, frozen clock. The miniature is a labelled excerpt, not a whole new screen state. |
| Every line in the web before/after, including 7, Yesterday, research lines, reply ages and composer | Unpatched fixture snapshot: `oneFixtures.ts`, `chatChannelFixtures.ts`, `lookFixtures.ts`, core date formatters; the complete visible text is retained in `verification.json`. Same sources as groundwork’s Chat capture. |
| Message action sheet choices and names | Web `features/messaging/messageActions.ts`, `useMessageActions.tsx`, `MessageParts.tsx`, `canEditMessage` and current Settle offer. Static sheet labels are generated for each pictured fixture message. |
| Gallery/plate headings, GAP explanations, dimensions, “buildable” and decision labels | Review annotations authored for this task; they are outside the pictured product screens and do not represent server data. |

No pictured product fact requires new server data. There is no new-data variant. The raised-cap variant changes
layout policy only. The fixture NAS answer is displayed as existing fixture prose, not evaluated as current advice.

## Names, order, focus and expanded behaviour

**Native intent:** preserve AP-7410…14. A message is one accessible element with author, time and words, followed by
its separate subject, approval/card and replies controls. Custom actions are Reply (also activate), Settle/Open again
only when permitted, More, Copy, and its links. The illustration’s selectable text is not a second native editable
element. Long press continues to select words on iOS and open its existing message menu where appropriate. No new
long-press gesture replaces selection. The illustration’s semantic HTML is a review proxy; native tree inspection
and rotor/custom-action verification remain GAP.

The replies row’s name is “3 replies, Waiting for you, open the thread”; its subject is “pve-02, Needs a look”. A
council member is read name → provider → state → elapsed → Read its answer. A delegation task is read number/title →
provider → state/time → current step → Pull request if present → “More for {title}”. Provider marks and rings are
decorative; “Working” supplies their meaning. The combined message and row labels must not be announced twice in
the native implementation.

**Web actions:** the persistent button is named “Actions for {author}’s message at {time}”, with `aria-haspopup=dialog`,
`aria-expanded` and `aria-controls`. Tab reaches it in document order. Enter, Space or a tap opens “Message actions”;
focus starts on the first available action (Reply in thread on the pictured waiting message). Tab/Shift+Tab stay in
the modal dialog. Escape, visible Close (44×44), or scrim dismissal closes it and returns focus to that exact button
without changing the scroll position. Focus has a 2px brand outline. Its actions are full-width, at least 48px tall.
Settle, when allowed, remains the first menu item; no extra Settle icon competes with the one button. The existing
confirmation/Undo rules still govern real actions; the static demo never executes them.

**Approval focus:** back → review heading/byline/consequence → Technical details → separate lasting yes → Yes now →
Yes tonight → No. iOS back names Chat; Android is “Back to Chat”. Review and answer opens this screen; native back
returns to its originating card. If the lasting yes is used, its system confirmation returns to that opener on Keep
asking; it does not accidentally decide. The prototype’s dialog demonstrates the separation, but does not mutate
approval state. Android predictive back closes a sheet before leaving; iOS keeps the edge gesture.

**Folds:** Read its answer opens below that member, changes to Hide its answer, and keeps focus on its trigger.
Technical details expands in the approval’s content scroller. “1 merged” reveals completed tasks in place beneath
active tasks. The task’s ⋯ opens its existing per-task choices; Stop asks first. Closing a native menu/sheet returns
to its opener (AP-7413), never the top of Chat. No live sorting or fold opening changes row order; new status/elapsed
values replace text in place. Nothing moves under the finger. A refresh/navigation may apply the existing list order.

**Targets:** new web action button 44×44 CSS px; sheet rows ≥48px. Native interactive controls ≥44pt iOS / ≥48dp Android,
including icon-only header/menu/back buttons, summaries, composer and task overflow. Approval answers are ≥52pt/dp
and grow for wrapping text. The bottom tabs keep full-column touch targets while their labels retain shipped fitting.
Desk-preview contents are one image; its small drawing text and tile boundaries are not individual touch targets.

## Largest text and contrast

`capture.mjs` measures every native scene at effective 1.6×, then iOS 2.4× / Android 2.0×, in light and dark (56
renders), plus the two fixture web renders (58 total). It checks 390px width, loaded bundled fonts, new target sizes,
no sideways page overflow, the identical desk-preview bounds and the top/bottom of each scroller. It also opens
Technical details, the council answer and merged-task fold. The main version’s bottom tab text and side-tab fit
are the shipped explicit exceptions, not a claim that they enlarge to the body’s size.

Measured WCAG 2.x sRGB contrast, target **≥4.5:1 even for large text**. `verification.json` keeps raw RGB pairs and
foreground/background samples for each render, using groundwork’s `contrast.js` over actual rendered text; status
words use the shipped `warn-text` and normal text uses `ink`, `ink2`, `mut`, `brand`, `btnfg`. No new colour tokens.

| Rendered HTML text | Light minimum | Dark minimum |
| --- | --- | --- |
| iOS proposal, all sizes/scenes/top and bottom | 4.854:1 | 4.904:1 |
| Android proposal, all sizes/scenes/top and bottom | 5.281:1 | 5.515:1 |
| Web static fixture proposal | 4.888:1 | 6.013:1 |
| Open web action sheet (unobscured content) | 16.445:1 | 13.657:1 |

These are HTML text measurements, not native WCAG certification. The scan excludes SVG/bitmap text, shadows,
icons, placeholder values and focus-ring contrast; it does not certify graphics or assistive technology. The fixed
desk miniature, actual native system controls and iOS glass need their native/background measurements. Known
unmodified web header buttons and tiny existing subject chips are outside this message-action fix; it does not
claim all of today’s web touch targets became 44px. Browser text resize/200% zoom, a software keyboard covering a
native page, and all-content native scroll/focus journeys remain verification GAPs before implementation.

## References and regeneration

Read the current architecture, decisions/index, design handoff, `ui-refresh-*.md`, `quiet-notices.md`,
`needs-you-list.md`, `handle-it.md`, `command-safety.md`, both `phone-refresh-*.md`, `duo-polish.md`, and native
council/delegation decisions. No decision file or baseline was changed. The main version keeps current decisions.

A future implementation needs a new phone-size baseline for the shared message/card/approval portions of
`docs/design-handoff/design/Whombat Mobile.dc.html` and the web message toolbar in
`docs/design-handoff/design/Whombat Desktop.dc.html`; neither old mock covers the new personal council/delegation
cards or Duo side-tab fit. Their native fixture baselines and `chat-channel/index.html` must accompany those updates.
The web snapshot is based on the built current UI; this mockup round does not overwrite any visual test image.

Run from the repository root, Node 24:

```sh
node --import tsx docs/design-handoff/council-ui-2026-11/07-phone-comfort/fixture.mjs
node --import tsx docs/design-handoff/council-ui-2026-11/07-phone-comfort/capture.mjs
```

To regenerate just the web snapshot, start this checkout’s Vite on a free port with
`VITE_FIXTURES=1 VITE_FIXTURE_HOSTS=1 VITE_FIXTURE_DASHBOARDS=1 VITE_FIXTURE_FILES=1 VITE_FIXTURE_AUTOMATIONS=1`;
the snapshot driver also sets `whombat:fixture-looks=1`. Run
`CAPTURE_URL=http://localhost:<port> node --import tsx docs/design-handoff/council-ui-2026-11/07-phone-comfort/web-snapshot.mjs`.
It uses `tools/visual`’s `openApp`/clock and waits for fixture queries/fonts, without patching data. Stop only that
temporary server afterward. No box, database, container or shared development service is needed for the static
capture driver. The capture driver opens local files in Playwright Chromium; no web server is started for review.

## Checks and delivery

Repository checks: `pnpm lint`, `pnpm notices --check`, `pnpm typecheck`, Node 24 and the project’s requested TMPDIR.
The task explicitly excludes the full test suite; no app/server code changes require new tests or Postgres.


Visual verification passed: **58 renders**, 24 expanded native HTML states, the web sheet in both themes (Enter,
Space, Escape, Close, focus return), 24 picture-viewer selections and JavaScript syntax. No page errors, failed
assets, undersized new controls, sideways phone overflow or sampled text contrast failures. All ten PNGs are
1440×900 and losslessly compressed. `preview.html` provides a compact picture viewer; the full before/after and
interactive scene drawings remain in `index.html`. T3’s HTML preview reported no console errors.

Whombat picture delivery was **partial**. HTTPS failed DNS. The first HTTP fallback accepted both web before/after
pairs (four images), their two numbered plain-language notes, and four native HTML after pictures. It then returned
HTTP 500. The other HTTP fallback also rejected the remaining **52 native after pictures** with
“Whombat couldn’t take that picture.” Both HTTP fallbacks rejected the four new gallery/viewer after pictures too.
There is no fabricated native before image. The eight accepted pictures and two notes are distinct from native
runtime verification: they are still design drawings. `shot-delivery.json` records every result; all after images
remain locally in the excluded `.whombat/shots`, and the ten compressed contact sheets remain in `png/`.

The task’s own fixture Vite on port 5279 was stopped after snapshotting. No shared services, containers, databases,
leases or native devices were created or changed. There is no application/service rebuild for these static documents.
