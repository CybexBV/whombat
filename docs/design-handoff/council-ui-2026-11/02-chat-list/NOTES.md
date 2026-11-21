# 02 · Chat list rows

## Scope and assumptions

Mockups only, for desktop web, phone-width web, native iOS and native Android. All committed changes are inside this folder. No app code, tests, tokens, decision files, shared index, scoring sheet or TODO was changed. No council was started. These are proposals for John, not new decisions in force.

The main design is buildable with **existing fields**: the first message’s topic, one stage, an independent unread label, and last-activity time. The person’s own face/name leaves their rows; this study omits repeated author furniture on all list rows. Full messages and their authors still belong inside the thread. There is one navigation target per row, named **Open thread**. It never submits an answer.

No flags means **no stage word**, even when the first message says “I’m looking into it”. The field `replyCount === 0` permits **No replies yet**, which is a count fact, not a stage or a promise. A reply error permits no invented Failed, Retry, Done or Waiting label. The distinction between an error and an uncertain command outcome remains in the existing thread/request UI.

Settled threads remain in the separate **Settled** shelf; their specimen is not inserted into the open list. Keep **Settle**, its refusal while waiting/working/handed over, **Open again**, and Undo. A neutral tick means the `settled` field is present, not that an action succeeded. No new red appears in these rows. The existing shell is untouched, including its health marks and Inbox badge. Heads-ups stay folded in their existing home; this proposal adds no heads-up group or “Needs you” heading to Chat.

## Files and reproduction

- `index.html`: side-by-side before/after selector, four platforms, both themes, decision boundaries.
- `mockup.html`: static responsive row study. `platform=web|ios|android`, `theme=light|dark`, `view=examples|settled`, `text=large`. Defaults to the baseline open list.
- `states.html`: all eight required cases, with provenance outside each product row; the flag-overlap table is expandable.
- `variant.html`: **needs new data / Decision for John**, beside the existing-data version, with the proposed matching Inbox identity.
- `png/`: 12 viewport PNGs, eight platform/theme after pictures plus two state sheets and two variant sheets; about 0.9 MB total. Existing before PNGs are referenced, not duplicated.
- `fixture-data.js`: generated, immutable reads of the shipped fixture factories. `rows.js` renders the static specimens; neither app imports it.
- `verification.json`: Chromium dimensions, fonts, minimum row sizes, text contrast pairs, keyboard focus return, all 16 flag combinations and 200% text geometry. These are mockup checks, not an app test suite.
- `shot-delivery.json`: requested Whombat image-upload attempts and their errors.

From the repository root, with Node 24 and frozen-lockfile dependencies installed:

```sh
node --import tsx docs/design-handoff/council-ui-2026-11/02-chat-list/build-data.mjs
node --import tsx docs/design-handoff/council-ui-2026-11/02-chat-list/capture.mjs
```

`build-data.mjs` bundles the fixture factories temporarily into ignored `.whombat/`, with `import.meta.env={}` so optional Vite switches stay off. It changes no source. Baseline reads combine `createChatChannelFixtures({now})` and `createLookFixtures({now})`, matching Groundwork’s default Chat + enabled look fixtures. Extra examples use the existing `handoff:'working'` and `newReplies:true` options in a **separate** factory instance. There are no requests to a running Whombat, no real account and no real device/data.

## Before and after evidence

Before: `../01-groundwork/png/desktop-chat-list-{light,dark}.png` (1440×900) and `phone-web-chat-list-{light,dark}.png` (390×844). Groundwork used `VITE_FIXTURES=1` and `tools/visual`’s frozen clock, 23 September 2026, 11:22 Europe/Amsterdam. See its `capture.json` and `NOTES.md` for the full setup and revision. Before images were copied into this worktree’s ignored `.whombat/shots/` before authoring the proposal.

After: Playwright Chromium 1.63, scale 1, `en-GB`, Europe/Amsterdam, fixed `2026-09-23T09:22:00.000Z`, reduced motion, actual bundled Bricolage Grotesque and DM Mono. Desktop 1440×900; phone web and both native studies 390×844. The web shell is the exact before PNG behind a replacement of the list region. The original header, sidebar, composer and names are not redrawn. Raster shell text is outside the new DOM contrast/focus checks; Groundwork’s checks still describe it.

**GAP N-IOS / N-ANDROID, light and dark:** no native before PNG exists in Groundwork. This checkout has no fixture-only app binary to attest. `apps/mobile/preview-runtime.cjs` is the sandboxed card JavaScript byte wrapper, not a screen renderer; reading it does not yield a native Chat screen. No simulator or someone else’s booted app was borrowed. The native after PNGs are **static HTML layout studies**, using the same frozen fixture data and native token/font values, not screenshots of native implementation. Native rendering, safe areas, the actual iOS system tab bar, Android system navigation, Dynamic Type, VoiceOver/TalkBack and native contrast remain unverified. The index displays the missing-before GAP instead of substituting a web screenshot.

Native rows share the same content. Only schematic chrome/touch conventions differ: iOS’s tab-bar silhouette versus Android’s divider/bar and 48dp controls. This does not propose changing their shipped navigation. Future verification needs isolated fixture-only iOS/Android builds (`EXPO_PUBLIC_WHOMBAT_MODE=fixtures`) with the same frozen moment, using `whombat://chat` and `whombat://threads/msg_chat-pve-memory`; no managed build or real data is an acceptable substitute.

## Every pictured line and mark: data source

Paths below are relative to the repository root. Literal fixture prose is copied from the fixture factories; authored UI labels are separately identified.

| Pictured words / marks | Existing source and binding | Apps |
|---|---|---|
| All unchanged web shell words: Burrow HQ; Chat; Inbox and 7; Overview; Automations; Vault; servers and connection names/marks; Mara Okafor / Settings; What {assistant} did; Files; Settled; composer and File | Exact Groundwork before screenshot. Its `capture.json` and source table cover every line. No new shell facts. | Both web widths |
| Assistant name in stage, composer, native More and variant | `agentWords(ASSISTANT_NAME)` from client `agentName.ts` and the web fixture’s `oneFixtures.ts`. `fixture-data.js.assistant` records the helper result, the same value Groundwork read from bootstrap. Authored text uses that helper value; no literal assistant name in mockup templates. | All |
| pve-03 is ready. I’m working out how to look after it. · 11:06 | `lookFixtures.ts`, `msg_care-pve-03`, `ChatThread.text` and `lastAt`. No working/waiting field is supplied for that row; its prose does not set one. | All baseline studies |
| pve-02 is running warm. I’m looking into it. · 10:58 | `lookFixtures.ts`, `msg_look-pve-02`, text/lastAt; working=true and replyCount=0. “Running warm” here is quoted message text, not an inferred thread stage. | All baseline studies |
| Is there new firmware for the access points? · 10:12 | `chatChannelFixtures.ts`, `FIRMWARE_THREAD`; text, lastAt, working=true, replyCount=0. | All |
| Why is pve-02 using so much memory? · 09:44 | Same file, `PVE_THREAD`; text and lastAt. Pending ZFS approval makes waiting=true. The base fixture has no unread entries; only the marked example instance enables newReplies, with unread=2. | All; unread in examples/variant |
| pve-01 needs a look. I’m looking into it. · 09:41; UniFi… · 08:31; Home Assistant… · 07:14 | `lookFixtures.ts` look roots and lastAt. Its `chats.threads` adapter does not send waiting for these rows, even when an underlying card waits. Do not infer Waiting for you from the card text or a separate Inbox item. | All baseline studies |
| Last night’s backups ran for all 12 guests… · 07:00 | `chatChannelFixtures.ts`, `msg_chat-backups`, text, lastAt, replyCount=0; all flags false. | All / state sheet |
| Install the updates on thetitan and the-falcon tonight? Both restart once after. · 22 Sept | Same file, `UPDATES_THREAD`; text, lastAt, waiting=true. Accessible time includes the complete date and 22:30. | All, below initial phone fold |
| Waiting for you · amber dot | `ChatThread.waiting === true` only. `--warn-text` words, 8px `--warn` mark. Authored stage label from the brief. | All |
| {assistant} is working · partial ring | `working === true`, only when waiting is false/absent. A neutral 11px partial ring; not a service-health learning ring. Shape and text together carry the meaning. | All |
| Handed over · branching arrow; Settle on the phone does nothing in the Feedback room. Can you fix it? · 11:15 | Existing `handoff:'working'` fixture, `T3_THREAD`; handedOver=true. Arrow is a proposed presentation of that flag; no provider or progress claim is inferred. Clock rounds 11:15:30 to minutes. | All via examples |
| Settled · neutral tick; Renew the certificate on the NAS · 22 Sept; Zonneplan question · 22 Sept | `CERT_THREAD` / `ZONNEPLAN_THREAD` with `settled:{at,how}`, from the `state=settled` response. Shipped shelf order by settled.at retained; row time still describes last activity. Tick is the proposed mark for this flag. | All via shelf/state sheet |
| New reply | `chats.unread.threads[rootId].unread > 0` independently of stage; settled rows suppress it. Production also suppresses it for the currently open thread via the shipped unread helper. The static dialog does not write a read marker. The main screenshot has none because its baseline unread is empty. The optional newReplies fixture shows it beside Waiting for you. | All |
| No replies yet | `replyCount === 0`; literal UI label, no timing or lifecycle claim. Also remains true when a turn failed before posting a reply. | All |
| Date, time, Latest activity | Frozen fixture date and `ChatThread.lastAt`, en-GB / Europe/Amsterdam, clock today, short date otherwise. Full timestamp is in the link’s accessible name and the time’s title. The date header says Wednesday 23 September without grouping yesterday under Today. “Latest activity” is a static column label. | All |
| Open thread, chevron | Static navigation label. Destination uses conversationId/rootId (web’s thread route or native `threads/:messageId`); never an approval or a write in the main version. | All |
| Native Chat, Settled, More Chat options, What {assistant} did, Files; Chat / Inbox / Overview / Automations / Settings | `ChatRoomScreen.tsx`, `phone-refresh-status.md` AP-7460 and the actual TabBar names. Schematic preview controls/chrome only. The footer and composer are not a working native app. | iOS / Android studies |
| Thread preview, its full question and stage; Chat return; Settle | Full stored text and same flags. “Thread preview” and explanatory paragraph identify the prototype boundary. Opening is simulated; Settle is visibly disabled only in this preview so it cannot be mistaken for a real write. The intended app retains its actual Settle command, menu, restrictions and Undo. | All HTML studies |
| All review headings, captions, selectors, source labels, GAP text and overlap table | Authored review explanation, not product data. Explicitly outside the pictured product row. | Review pages |

### Local sample inputs, not new contract fields

The following are clearly captioned **local sample** cases in `states.html` and isolated to `view=examples` in `mockup.html`. They use existing fields in the same Mara/pve-02/NAS/backups fixture world. They are not claimed to be present in the baseline app or native before picture. Values live in `rows.js.localScenarios`.

| Sample | Complete row inputs that differ from the baseline pve-02 thread | What is shown |
|---|---|---|
| Unfinished, not working yet | text “Can you check last night’s backups?”; createdAt=lastAt=2026-09-23 10:08 local; replyCount=0; all flags false/null; no unread entry | Question · No replies yet · 10:08. No “Waiting for {assistant}” or pending-stage invention. |
| Very long question | Authored pve-02 question, exactly 200 characters (the `CHAT_THREAD_TEXT_MAX` limit); replyCount=1; lastAt=09:40 local; all flags false/null; no unread | Two-line topic then ellipsis at ordinary text size; full stored 200 characters in the accessible name and opened preview. The full first message beyond the API’s 200-character summary would require the existing thread read. |
| Reply errored before posting | Text “Why did the NAS wake up at 04:00?” from the older fixture questions; replyCount=0; lastAt=09:30 local; all flags false/null; no unread. The fact that the attempted reply errored is **scenario context**, not a fake ChatThread field. | Question · No replies yet · 09:30. No error mark, inferred success or retry. An error after a posted reply would keep its real replyCount instead. |

These samples use the existing person author and pve-02 subject as a structural base; neither author nor subject is used to invent a label. The NAS sample’s subject is cleared in the renderer’s sample input to avoid associating it with pve-02.

## Marked variant: needs new data / Decision for John

`variant.html` places the current-data row beside the **needs new data** alternative. The authored line is “{assistant} needs your OK: cap the cache tonight.” The button says **Review the cache limit**, naming what opens rather than “Answer”. This is navigation only.

The fixture’s existing approval is 902, “Limit the ZFS cache on pve-02 to 16 GB”; its reply suggests tonight. Neither that approval reference nor the suggestion is carried by `ChatThread.waiting`. The concise sentence, chosen decision label, current summary version and typed target are **needs new data**, not silently derived from a flag or a guessed newest card. The sample remains a proposal; no new fields or decision docs are implemented.

To match a card ask to its Inbox item, both should resolve the same typed ask identity: approval 902 here, plus the real thread/card anchor and Inbox reference. Opening re-reads the ask’s current state, uses the existing web card/modal or native approval screen, and keeps its single set of answer semantics. A stale summary must fall back to Open thread or the answered state, never leave a second yes active. Other ask kinds need their own typed identity. Multiple asks need a deterministic chosen target plus a real remaining count, or neutral “Review requests”. This list cannot supply that from waiting=true. Keep one-time answers, standing-permission confirmation, unknown-outcome handling and platform differences as shipped.

## Accessibility, expansion and ordering

**Screen-reader names and reading order:** one link per proposed row: full stored topic → winning stage (if any) → New reply (if any) → No replies yet (if true) → “Last activity”, complete local date/time → “Open thread”. For example: “Why is pve-02 using so much memory? Waiting for you. New reply. Last activity Wednesday, 23 September 2026 at 09:44. Open thread.” No initials or repetition of the viewer’s name. Marks/chevrons are decorative inside the named link; the words carry their meaning. In a future native implementation expose one accessible row with Open thread as activation plus existing Settle/Open again/More actions (AP-7410), not nested duplicate accessibles. Messages inside the opened thread keep their real author and actions.

**Focus order:** review navigation/theme → platform/theme selectors → Open HTML → before/after image links → example/variant links → disclosure. Row study: Skip to Chat threads → Settled header control → row links in visual order. Native study header: Settled → More Chat options → row links. The raster shell is decorative evidence, not a keyboard-rebuilt app. Proposed production navigation retains the actual shell’s keyboard order.

**Open / expanded:** desktop opens the existing thread pane, phone-width web/native the existing full thread at its preserved position/end. Main Open thread never guesses which pending card to focus: UIR-65’s precise card targeting belongs to the existing Answer action and is not promised by this label. Full long text is available on open; there is no separate truncation expander. The prototype uses a labelled dialog with first focus on Chat/Back, Escape closes, and focus returns to the same row. Nested shelf/thread previews retain separate opener references. Variant Review the cache limit opens a labelled review-destination preview; close/Escape returns to that exact action. It cannot approve anything. Review disclosures use native details/summary; opening changes no focus or order.

**Touch sizes:** whole rows are links: minimum measured 79px desktop, 92px phone web, 96px native studies, all well above 44px / 44pt / 48dp. Native header controls are 44px on iOS and 48px Android in this scale-1 study. Gallery controls, summary targets and navigation links are ≥44px; native OS chrome is not claimed verified. Existing desktop Settle/shelf header evidence keeps its shipped dimensions; mobile shelf hotspot is 44px high. There are no tiny independent status targets.

**Settle:** preserve the real action in the thread menu/native swipe and accessible row actions, only when permitted. Return focus to the next row, the previous at the end; Undo restores the same row and focus. Preserve 8s Undo, paused on web hover/focus and extended by the native accessibility rules. Nothing in the new row turns Settle into Delete or adds an answer shortcut.

**Largest text:** `text=large` is an explicit 200% **HTML layout study**, not a Dynamic Type certification. Topic is 32px, metadata 24px, secondary action 27px; time/action move below the topic; no line clamp; page/list widths are checked at 390px and 1440px in both themes. Native schematic footer is omitted in that stress study to isolate rows; the shipped native tab/keyboard safe-area behaviour still needs native verification. Production must retain real navigation, wrap rather than truncate stage/action labels, use content-driven row heights and scroll clear of the composer/tab bar. Native largest supported accessibility text remains a GAP. The 200-character API summary limit still applies at any size.

**No reorder under the finger:** on initial open or explicit refresh, open threads use server `lastAt` descending, keeping the response order for ties. While viewing, apply stage/unread/text/time changes **in place**, hold arrivals for an explicit refresh, preserve the scroll anchor and focused rootId, and never sort by waiting/unread. Back from a thread returns to the same list, row and scroll position. The existing `patchChatThreads` policy moves rows on replies (AP-2408); this stability requirement would change that implementation, so it is explicitly included in the decision boundary below. The static mock has no live updates and cannot certify that future implementation. Settled remains its separate server-ordered shelf, not a priority bucket mixed into Chat. Inbox is where items that need the person come first.

## Measured WCAG contrast

The existing Groundwork `contrast.js` scans rendered solid foreground/background pairs using sRGB relative luminance and (L1+.05)/(L2+.05). All sampled text, even large text, uses ≥4.5:1. `verification.json` contains the exact pairs and minima. There are no text-opacity fades or gradient-backed new words.

| New DOM / static study | Light minimum | Dark minimum |
|---|---:|---:|
| Desktop rows | 5.281:1 | 6.013:1 |
| Phone-width web rows | 5.428:1 | 6.013:1 |
| Native iOS HTML study, including schematic tabs | 4.854:1 | 4.904:1 |
| Native Android HTML study | 5.428:1 | 6.013:1 |
| Eight-case sheet | 5.281:1 | 6.013:1 |
| Decision variant | 5.281:1 | 5.515:1 |

Stage text on `--bg`: Waiting uses `--warn-text`, 6.059:1 light / 9.325:1 dark; neutral stage uses `--ink2`, 11.431:1 / 11.456:1. New reply uses `--ink`, 15.888:1 / 14.891:1. Time/no-reply use `--mut`, 5.428:1 / 6.013:1. The smallest iOS value is the schematic inactive-tab `mut` on `sf2`. Native token pair ratios are measured in HTML only, not on-device glyphs. Raster web chrome and SVG non-text marks are outside this scan; Groundwork covers the existing chrome, and stage words provide the accessible meaning. This is not a complete WCAG audit.

## Decisions and reference boundaries

Read the current `ARCHITECTURE.md`, decision index, `ui-refresh-chat/inbox/status.md`, `quiet-notices.md`, `needs-you-list.md`, `handle-it.md`, `command-safety.md`, both `phone-refresh-*.md`, Chat/settle/unread rules and `docs/design-handoff/README.md`. The task’s requested design is not silently treated as a shipped decision.

The index explicitly labels the proposed layout **Decision for John — reopens UIR-64, UIR-66, AP-7417, AP-2454, TU-05**, beside the unchanged before version that keeps them: replacing the waiting chip/Answer, faces/reply-count/time link, joined native waiting/replies row, sender-led phone row, and dot-only unread presentation. The newest-first API thread list exists (CHT-07); the captured web room is an oldest-first message timeline. Converting that surface to the new list also needs John’s layout decision. Preserving positions during live updates instead of AP-2408’s move-on-reply is a separate explicit **Decision for John — reopens AP-2408**; it keeps the user’s no-movement requirement. No decision document is changed here.

The current more-specific reference is `docs/design-handoff/chat-channel/index.html`, with Chat-settle/runtime refinements. If approved, that reference needs the primary list baseline updated. The shared fallback references that would require new row baselines are **`design/Whombat Desktop.dc.html`** (Chat/message thread-link specimens) and **`design/Whombat Mobile.dc.html`** (phone message/thread-link specimens), in light/dark at their prescribed sizes. Do not update the rest of either mock, approvals, composer, shell, Inbox, or health scale. No existing baseline is replaced by this proposal.

## Checks and remaining gaps

The scoped Chromium capture checks the static renders, bundled fonts, zero page errors, dimensions, all 16 stage overlaps, full long-question length, keyboard open/Escape/focus return, no horizontal overflow at 200% text, and the native GAP selector. It writes the evidence above. Repository lint, third-party notice freshness and typecheck run before push. Per this task’s explicit “no full test suite”, `pnpm check`’s whole-repository unit suite and native/browser app suites are not run locally. No app behaviour changed. Pull-request checks are monitored separately.

Remaining gaps: native before captures/real rendering/accessibility as above; live-update/gesture behaviour in an implementation; app-level error/empty/loading journeys (not designed here); no native phone largest-text certification; untouched raster shell is not a fresh DOM audit. The extra local error case intentionally cannot reveal the error in its row.

Whombat screenshot delivery: before and after web pairs are attempted at the three requested addresses, in order. The HTTPS name does not resolve here; both IP endpoints return HTTP 500. Without a successful after response there are no numbered changed areas to annotate, so no numbered notes were invented. PNGs remain committed here and mirrored under ignored `.whombat/shots/`; exact attempt responses are in `shot-delivery.json`.
