# Round four · shared approval card

This round changes only the mockup folders `thread/`, `approval/` and `inbox/`, on `delegate/thread-one-approval-card-plus-plan-ejp78-3`, based on fetched main `5cf15c134`. The shell-conflict refresh merges main `7f7e90d31` and rerenders these screens with its unmodified shared shell/story/gallery files: real service logos, visible web Search and native Back first. Application code is unchanged. No CI, lint, typecheck or tests run; PNG render and visual review only. [Round-four source ledger](../thread/NOTES.md) lists every new visible line and its data source, including the inherited shell.

The primary approval 33 now uses `../approval/card.js` and `card.css` everywhere: thread, approval card, web Details sheet and both native drawings. The Inbox restart 31 uses the same renderer with its own supplied title, memory/downtime sentence and evening instant. It does not borrow approval 33's permission: the Inbox payload has no key, so its permission line says **Not supplied in this request**. The cache-limit approval keeps the actual **Change things in connected services** key label. All three answers are outlined with equal weight, ordered **Yes, now · Yes, tonight · No**, and stack equally on phones. None is filled or recommended. What happens to what, permission, exact date/time/zone all precede the answers in one scroller. Existing long command/email specimens also use neutral answer styles.

One **Details** inside the primary card holds its existing technical target/command/explainer and existing lasting-permission door. The lasting permission still has its own confirmation. No consequence or undo is added. Existing read-state alternatives and unknown-answer recovery remain. Native screenshots are HTML drawings, not new device captures.

Round-four screenshots are rerendered with current main's shell before pushing. [round4-delivery.json](../thread/round4-delivery.json) records fresh before/after picture attempts; local originals are excluded under `.whombat/shots/round4-thread/`. No accepted after picture means no returned changed-area numbers and no fabricated numbered notes. Full scope, reproduction, source selection and measured contrast are in the linked thread ledger. The earlier provenance below describes round three; this round's shared card and equal answers replace its surface-specific approval layout.

---

# Final Inbox · round three, part 2

Mockups only. The new `delegate/final-approval-and-inbox` branch starts from fetched main **8870fd7cb** and uses the binding `../SHELL.md`, `../STORY.md` and `story.js`. Normal is exactly the three returned Inbox items, in their supplied order. No app, token, contract, test, decision, scoring or task-list file changes. `../shell.js` has only the needed canonical Inbox link update, so all nine-place menus and native Inbox tabs reach this final page. No navigation order/anatomy is copied or changed.

**NO CI** per John: no lint, typecheck, notices, tests, build gate, CI request or pull-request-check wait. PNG rendering and colour/layout observations are design evidence only. No council, subagent, real mailbox/account, appliance or native device was opened.

## What changes in each app

| App / fix | Final behavior |
| --- | --- |
| Desktop web | Shared 256px sidebar; Needs you shows exactly blackbox, restart 31 and the heat-pump choice. Broken item is first with one prominent **Look into it** button; secondary Settle/discussion/reminder live in More. |
| Phone web, 390×844 | Shared closed drawer with Places/Search; the Inbox cue is omitted while already in Inbox. The restart row shows **all** of “4 → 8 GB” and **about 40 seconds**, source/time and the **full exact evening date/time/zone before its Yes buttons**. No line clamp or nested card scroller cuts off its explanation. |
| Native iOS / Android | Same records, full decision facts, exact time and outlined answers, in the common order. The existing five tabs stay in the shared shell; iOS floating / Android full-width geometry remains distinct. Android targets meet 48dp. Native gestures/custom actions remain implementation work; visible More keeps the actions inspectable in HTML. |
| All four, local read states | Separate loading, successful empty, failed first read, plus a linked saved-refresh-failure drawing. Failed read is local amber copy, never a successful empty or a new broken thing. Settled remains a flush bar below the scrolling list, above native tabs. |

The first row’s single **way forward** is investigation, not an assertion that blackbox is fixed. To honor the explicit “with its one button” instruction, Settle is available within More rather than another prominent row button. Settle remains limited to the watched alert; approval and device-skill rows never get Settle. Their own answers/Choose remain. More retains talk/reminder affordances supplied or required by the Inbox rules. No new stop-watching permission is inferred from this legacy three-record payload.

## One story and every pictured line

The observation is **23 September 2026, 14:05, Europe/Amsterdam** on every platform. The normal badge is **3**, derived from `S.inbox.length`; exactly one is a real broken item. No rows from earlier six-item web Inbox worlds, no invented heads-ups, Later entries, work-in-progress group or ignored incident are added. No empty group is drawn as a blank stage. Settled’s initially empty area contains no supplied record; its zero is not a notification badge. The four settled **Chat** threads are not borrowed as Inbox items.

| Pictured family | Source / binding |
| --- | --- |
| Shared shell, names, avatars, navigation, token badges / Chat 1 and Inbox 3 | `story.js`, `shell.js`, `shell.css`, and the source ledgers in `../SHELL.md`, `../STORY.md`, `../NOTES.md`. Assistant interpolates `S.assistant`, the name-helper result. Person’s name/initials occur only in the desktop shell footer, never an own Chat row. 09:41 is schematic OS chrome. |
| Inbox / subtitle / Needs you / More / Settled / empty copy | Existing `NEEDS_YOU_WORDS` / Inbox UI conventions and authored presentation labels for the selected query scope. Heading says what the Inbox is, not a new server condition. |
| blackbox’s disk array failed; Your files have no protection now; blackbox · Opened 13:52 | `S.inbox[0]`, identity `hosts.alert:al_blackbox_md0`: title/body/subject/at. STORY’s 13:53 report still has the fault. Red remains tied to this actual broken item. |
| Look into it | That item’s existing investigate action and label, explicitly retained by STORY. Its local preview prepares the same investigation question; nothing is sent and no repair/progress is claimed. |
| Restart arnica-prod-nest-01?; complete memory/restart/downtime sentence | `S.inbox[1]`, identity `approval:31`, title/body. Exact body: “It needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds.” This supplied duration is retained, never generalized to approval 33 or other kinds. |
| pve-02 · Asked 13:58 | The restart’s `subject.name` and `at`, formatted in Europe/Amsterdam. This guest restart is **31**, not the main cache-limit approval 33. No extra permission label is invented because this Inbox record does not supply `keyId`. |
| Yes, tonight means Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam | The **actual `approve_later.at`** on record 31: `2026-09-24T01:00:00.000Z`. No new schedule is guessed. `Intl.DateTimeFormat` gives date/year/clock in the story’s zone. |
| Yes, now / Yes, tonight / No | Shared `APPROVAL_ASK_WORDS` / `needsYouButtons` semantics (UIR-38, AP-7400/02). These are the existing approve / approve_later / decline actions, normalized from the legacy payload’s Restart now / Tonight at 03:00 / No labels. They are equal outlined choices, not a recommendation. |
| Heat pump: what may I change?; It reads fine already; Heat pump · Asked 13:41; Choose | `S.inbox[2]`, identity `device_skill:dvp_heatpump`; title/body/subject/at and existing open action to `msg_chat-heat`. It remains Learning/read-only until the person chooses changes. No connected/changes-enabled result is invented. |
| Talk to {assistant} about it; Remind me tomorrow; reminder preview’s 09:00 | Existing Inbox More semantics, `docs/decisions/inbox.md` IBX-04…07 and `quiet-notices.md` QN-12. Record snooze actions are kept quiet as Remind me tomorrow, never a fourth approval answer. Preview names the established tomorrow-09:00 zone meaning and performs no mutation. |
| Settle, recurrence explanation, Bring it back, Undo, It’s back. | IBX-03/06/09 and shared settled wording. Only the explicitly selected local Settle scenario moves blackbox into Settled and shows the recurrence toast/Undo; no automatic health change occurs. Questions retain no Settle. |
| Loading the Inbox…; skeletons | Known local first-read state with absent rows. Skeletons are decorative, not pretend records. Shell’s separately known cached aggregate is not recomputed from skeletons. |
| All good. Nothing needs you.; successful empty; Back to Chat | Explicit successful-zero Inbox alternative, not the normal three-row story or a failed read. Inbox notification badges are suppressed and their accessible name updated for this alternative; no “0” badge is painted. Chat’s independent Feedback count stays. |
| Couldn’t read/refresh the Inbox; saved-copy explanation; Try again / Ask / More detail | Local query error with absent/saved list data. Folded seeded diagnostic says “The fixture read did not answer. home.overview”. A failed refresh retains saved rows in their original order. Retry reads only; Ask prepares an unsent diagnostic question, not an approval or command retry. |
| No saved-copy words while shell still knows 3 | Query scope is the locally unavailable list detail; shell has its independently known aggregate from the selected story, as SHELL/STORY specify. It is not a newly fabricated count or a claim that new item data was fetched. Successful empty explicitly reconciles that scope to no badge. |
| Local answer result words and date | Static selected-button illustration, not a real receipt or execution. Tonight uses the same supplied instant. No undo or successful restart result is invented. |
| Gallery headings, before/final captions, controls, picture dimensions, proof labels | Authored review apparatus outside product facts. Before uses the earlier world and is labelled as such. |

## Focus, accessibility and expansion

Shared shell order/focus/Places behavior is inherited directly, including Search and the nine canonical destinations. Inbox’s content order is heading → Needs you/count → each row’s title → **complete** reason → subject/time → exact evening explanation when applicable → its existing answers / one way forward → More. The fixed Settled region follows the main scroller in the reading order, then the five native tabs. Row headers are real headings labelled by the full item title; no description is put only into a hidden name to excuse visible truncation.

A native implementation should retain its combined row accessibility name with full reason/time, swipe/custom Settle/More actions on the alert, and the existing item sheet. This HTML uses semantic title/body/controls to inspect the complete facts; it does not certify native combined elements, swipes or VoiceOver/TalkBack. Approval and device-skill questions are answered and never settle. More summaries are named **More for {title}**, expose expansion and retain trigger focus; their controls expand in place. No live update opens More or moves a row under a finger.

Settled is a full-width flush ≥44px bar (48dp Android), `aria-expanded` / `aria-controls` bound to an upward panel. It opens even when empty, giving the existing explanation. Populated content scrolls separately at at most 42dvh. Local Settle moves only blackbox, changes the normal known count 3 → 2 and uses an amber badge because the remaining items are choices, not a broken thing. Focus moves to Undo; Bring it back/Undo restores the exact same row/order and its investigation control, announcing It’s back. The toast is the single polite status for the Settle event. The local example never sends `needsYou.ignore`.

Question answers focus their local result; nothing is silently re-sorted. The read retry keeps focus and announces reading again; real read success should focus the restored group heading if that recovery control disappears. All modal question previews have a name, description, Close, HTML focus containment and opener return. Native implementations keep their own sheets/menu/gesture/back APIs. No unsupported network/retry result is implied.

## Touch, largest text and measured contrast

Phone web controls/summaries are ≥44 CSS px; approval buttons ≥48px. Native answers ≥52pt/dp; Android menus/summary/Settle bar ≥48dp and iOS controls ≥44pt. Text wraps; no button shrinks a label. The shared visible token-brand focus outline remains. Empty state navigates explicitly, never auto-jumps from a count update.

At native largest system settings, the kept **effective 1.6× cap** enlarges complete row title/reason/source/time/date/buttons. Web content reaches 200%. The list scrolls above its **separately allocated** Settled region and tabs. No absolute answer layer or three-line clamp hides “about 40 seconds”. Long descriptions can push their answers below the initial camera; they remain next in normal scroll/reading order. The proof sheet’s iOS view shows the full reason, Android its continued exact time and answers, while the phone-web view shows facts and choices together. All three native row facts remain present at full size. Native tab labels retain the shipped fitting exception; no raised text cap is proposed.

`renders.json` records **48 design render observations** across normal/read states, largest text and saved-refresh failure, with three scroll positions and separate rendered control/badge pairs. Chromium observed no page/asset errors. Actual token paint, bundled fonts and WCAG sRGB ratios:

| Platform | Text light / dark minimum | Control/badge light / dark minimum |
| --- | --- | --- |
| Desktop | 4.942 / 5.515 | 4.888 / 5.515 |
| Phone web | 5.281 / 5.515 | 5.281 / 5.515 |
| iOS drawing | 5.281 / 5.515 | 4.888 / 5.515 |
| Android drawing | 5.281 / 5.515 | 4.888 / 5.515 |

All sampled text/controls/badges meet **≥4.5:1**. Read errors use `warn-text`; only the real disk-array fault/shell badge uses the actual failure tone. Native screenshots, safe areas, platform metrics, keyboard/rotation, assistive technology, graphical/focus-ring contrast, rasterized pixels, every expanded menu and live updates are not certified by these HTML colour measurements. No score or whole-app verdict changes.

## Pictures, delivery and reproduction

Inbox has **42 compressed PNGs**: eight normal, 24 loading/empty/failed, two full-fact/maximum-size contact sheets and eight before images. Before captures were taken before changes: step 09 desktop/native HTML and step 14’s phone-web wrapper, at matching sizes/themes. Their earlier six-item world is labelled; it does not override the final three-item story. New final read states have no fabricated same-state before. Native afters are drawings, not new OS captures; step 08 remains genuine native evidence.

Run Node 24 from repository root with existing dependencies:

```sh
node docs/design-handoff/council-ui-2026-11/16-final/approval/render.mjs
```

That driver renders both owned folders, using `story.js` directly, without regenerating shared Chat/shell images or changing source fixtures. Local individual largest/review PNGs are under excluded `.whombat/shots/16-part2/`. Shared-browser local-file automation rejected **“Invalid preview URL (unsupported-protocol: file:)”**; Playwright Chromium rendered the local files directly. No server, service, database, container, lease, simulator or emulator was started or changed. There is no app rebuild/restart for static mockups.

Picture attempts and any numbered area notes are recorded in `delivery.json`; Picture delivery is **partial**: 54 submissions / 160 endpoint attempts; **2 before pictures accepted**, no after picture accepted, 52 submissions failed. HTTPS could not resolve; both HTTP fallbacks returned 500, ‘Whombat couldn’t take that picture.’ No changed-area numbers were returned, so no comparison notes were invented. All final PNGs remain committed/local regardless. No check is reported passing, and CI/PR checks are not awaited.
