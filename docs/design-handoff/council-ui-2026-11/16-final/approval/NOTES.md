# Round four · shared approval card

This round changes only the mockup folders `thread/`, `approval/` and `inbox/`, on `delegate/thread-one-approval-card-plus-plan-ejp78-3`, based on fetched main `5cf15c134`. The shell-conflict refresh merges main `7f7e90d31` and rerenders these screens with its unmodified shared shell/story/gallery files: real service logos, visible web Search and native Back first. Application code is unchanged. No CI, lint, typecheck or tests run; PNG render and visual review only. [Round-four source ledger](../thread/NOTES.md) lists every new visible line and its data source, including the inherited shell.

The primary approval 33 now uses `../approval/card.js` and `card.css` everywhere: thread, approval card, web Details sheet and both native drawings. The Inbox restart 31 uses the same renderer with its own supplied title, memory/downtime sentence and evening instant. It does not borrow approval 33's permission: the Inbox payload has no key, so its permission line says **Not supplied in this request**. The cache-limit approval keeps the actual **Change things in connected services** key label. All three answers are outlined with equal weight, ordered **Yes, now · Yes, tonight · No**, and stack equally on phones. None is filled or recommended. What happens to what, permission, exact date/time/zone all precede the answers in one scroller. Existing long command/email specimens also use neutral answer styles.

One **Details** inside the primary card holds its existing technical target/command/explainer and existing lasting-permission door. The lasting permission still has its own confirmation. No consequence or undo is added. Existing read-state alternatives and unknown-answer recovery remain. Native screenshots are HTML drawings, not new device captures.

Round-four screenshots are rerendered with current main's shell before pushing. [round4-delivery.json](../thread/round4-delivery.json) records fresh before/after picture attempts; local originals are excluded under `.whombat/shots/round4-thread/`. No accepted after picture means no returned changed-area numbers and no fabricated numbered notes. Full scope, reproduction, source selection and measured contrast are in the linked thread ledger. The earlier provenance below describes round three; this round's shared card and equal answers replace its surface-specific approval layout.

---

# Final approval · round three, part 2

Mockups only, on `delegate/final-approval-and-inbox`, created from fetched main **8870fd7cb**. `../SHELL.md` and `../STORY.md` were read first and govern these drawings. No app, token, contract, decision document, test, scoring sheet or shared task list changes. The only shared-file edit is `../shell.js`’s canonical Inbox destination pointing at the now-delivered final Inbox; navigation anatomy/order/paint stay shared. No council, subagent, real account or native device was used.

**NO CI**, following John’s updated instruction: no lint, typecheck, notices, tests, application build, CI job or PR-check wait. Chromium PNG rendering and requested colour/layout observations are design evidence, not a test suite or a built-app verdict.

## What to review and what changed

`index.html` compares freshly captured earlier HTML designs with this final design, in four platforms and two themes. Desktop is 1440×900; phone web, iOS and Android are 390×844. Normal PNGs use exactly the gallery names `<platform>-<theme>.png`. Loading, successful empty and failed-first-read pictures exist separately on every platform. The full-size/largest links open the selected static drawing; separate command/email links retain that platform and theme. `reading-proof-*.png` shows native permission/time at the existing largest cap and uncertain-answer recovery.

| App / fix | Final behavior |
| --- | --- |
| Desktop and phone web, thread card | Approval 33, its supplied permission and the exact meaning of Yes, tonight precede Yes. The action title occurs once on the card. No new consequence paragraph: this approval’s `whatHappens` is empty. The actual historical assistant restart sentence remains outside the card, as STORY requires. |
| Web Details | **Yes, now → Yes, tonight → No**, exactly the same array and order as the card. Command’s **Allow once → Allow for this task → Always allow for {assistant} → Don’t allow** likewise uses the same array in both. The previous special Details ordering / Yes, do it is intentionally replaced by the explicit part-2 instruction. |
| All four | Omit the sole-person condition box: the question and answers already ask the person. This extends native AP-6553 to web as requested, without pretending the approval has been met. These selected examples have no other unmet conditions to hide. |
| Native iOS / Android | Keep the big **24/700 question**, asker context and separate one-time answer bar; no tabs on this push screen. Answers remain outlined for an everyday ask; they stack at largest text in the same order. Android controls meet 48dp. |
| Long command / email | The card’s answers follow the full command or expanded email in normal document flow. Details/native content has its own bounded scroller **above** a separate answer bar. No overlay padding guess, line cap or truncation hides payload behind buttons. The email body remains folded under Technical details on the web card, open in Details/native. |
| Loading / empty / failed | Local read states occupy the same shell/surface and offer no approval answers. Empty means no selected/returned approval to show; it does not guess that it ran, was declined or was deleted. Retry reads only. |
| Unconfirmed answer / proven never-sent | Unknown says **Your answer may have gone through**, retains explicitly labelled last-reviewed details and offers **Ask {assistant} to check**, with no resend. Only affirmative proof of never-dispatched delivery restores the original answer choices. |

All answers/confirmations/check questions are local illustrations; no approval, command, email, permission or chat is sent. The separate lasting-yes confirmation keeps its existing meaning, with Keep asking initially focused. A confirm closes the static preview without writing anything. No recommendation, new consequence, undo promise, duration estimate or raised text cap is added. The existing historical “I’d do it tonight” is stored message history, not a new recommendation field or badge.

## Shared story and every pictured line

The main is **approval 33 / apr_zfs-cache**, from `FINAL_STORY.threadBodies['msg_chat-memory']`’s approval card, pending at **14:03**, observed at **14:05 on 23 September 2026, Europe/Amsterdam**. It is neither web 902 nor the Inbox guest restart 31. `data.js` is generated by `build-data.mjs` using the story object and the current read-only core presentation helpers. `story.js` is not copied or changed.

Command and email are explicitly labelled **separate payload specimens** in the review. They use existing step-03 action data, rendered at the same observation on all platforms; their own earlier creation times remain earlier. They are not added to the shared normal story or its Inbox count. The mail length stress repeats the existing body four times, with no new factual prose, recipient or subject. No native pending state is claimed to be an OS screenshot.

| Pictured family | Source / binding |
| --- | --- |
| Burrow, person footer, assistant name/face, Search/Places, destinations, native tabs, Inbox 3 / Feedback 1 | Shared `story.js`, `shell.js`, `shell.css`, and their exhaustive ledgers in `../SHELL.md`, `../STORY.md`, `../NOTES.md`. Assistant is `agentWords(assistantAgent().name).name`, interpolated via `S.assistant`; never an authored assistant-name literal. Production `operator-head-small.svg`. No own-person chat header is drawn. |
| Thread topic; “Sure. It takes effect after a restart, so I’d do it tonight.”; author and 14:03 | The selected memory root and actual approval-bearing reply in `S.threadBodies`; stored prose is verbatim. `createdAt` is formatted in the story’s zone, not restamped to now. |
| Cache-limit title/question, pve-02, 16 GB | Approval 33’s `title` / `question` and current core `approvalView`. No 902 restart-once fact is imported into this main. |
| Permission used and catalogue label | Approval’s `keyId=connections.write` → `KEY_CATALOG`, “Change things in connected services”. This names the permission, not an unread grant tier. Command uses deploy.production; email mail.send. |
| Yes, tonight date/time/zone | `nextAt(new Date(S.frozen), S.timeZone, '03:00')`, the existing quiet-hours fallback when no supplied change-window query exists. Result **Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam**. A real returned quiet-hours start replaces the fallback. The Inbox’s supplied `approve_later.at` agrees but is not used to relabel approval 33 as 31. |
| Exact server command under Technical details; servers · server_command; explainer | Approval 33’s `connection.argumentsPreview`, `target`, `explainer`. Full `echo 17179869184 > /sys/module/zfs/parameters/zfs_arc_max` is selectable; this connection-call is not misclassified as a run_command with command scopes. |
| Eyebrow, lasting link/title/body/Keep asking/Let {assistant} do it | Current core `approvalView`, name context from the shared story; AP-7404…08. Native changes the existing return-place phrase from Settings to pve-02’s page in Overview. No new standing permission is inferred. |
| Yes, now / Yes, tonight / No; command scope labels | Existing shared `APPROVAL_ASK_WORDS` / `approvalView.scopeChoices` and `declineCta`. The part-2 instruction explicitly makes card and Details match; one function renders both. |
| Supplemental long command, web-1, production reason, exact rsync/ssh bytes | Step 03 `fixture-world.json` / `build-fixtures.mjs`, run_command params.command/target/reason and deploy.production catalogue label. The payload is preserved without ellipses or normalized bytes. No outage duration or rollback promise is inferred. |
| Supplemental email From/To/subject/copy state/message | Step 03’s existing mail action from `ApprovalDetails.stories.tsx`: connectionEmail/to/subject/body; empty cc/bcc arrays give No Cc or Bcc. The repeated body is explicitly a length stress; its mention of an attachment supplies no attachment chip or digest. |
| Why / From / To / Subject / Copies / Permission used / Command / Message / Technical details | Authored presentation labels describing those supplied fields. They are not extra server data. The web card’s body disclosure keeps handle-it.md. |
| Loading the approval…; no approval to show; Open Inbox | Authored local query/selection-state copy. Loading has no approval result; empty is a successful absence/selection scenario, not a masked read error or assumed execution. |
| Couldn’t read/refresh the approval; saved-copy words; Try again / Ask / More detail | Known client read-error scope and presence/absence of a saved copy. Seeded folded diagnostic: “The fixture read did not answer. approvals.get”. Failed refresh labels retained details and requires a read before offering answers; no write retry is implied. |
| Unknown/never-sent heading, last-reviewed label, check-only question | Authored plain-English receipt presentation following `docs/decisions/command-safety.md` CS-01/02/04b. An unknown outcome, including rejected + unknown_outcome, is not a refusal. Missing reply alone never proves non-execution. The never-sent scenario requires explicit pre-dispatch / not_executed proof. |
| Local “Your answer was saved”, “You said no”, approved-for date | Static response illustrations for a chosen local button. They are not execution/receipt evidence or an Undo promise. Choice-specific time comes from the same stored evening instant. |
| Approval details / Close approval details / Back to Chat / gallery controls and captions | Existing navigation words; authored review apparatus and accessible control labels. Payload/large-text captions sit outside the product frame and name their limits. |
| 09:41 and OS symbols | SHELL’s schematic system chrome, not the observation, a reading timestamp or native battery data. |

## Focus, reading order and expansion

The shared shell supplies Skip, the exact nine-place navigation, phone closed drawer, Places modal containment/return and native chrome. Approval is a push screen, so it has Back to Chat and no invented tab bar. The canonical Inbox link now reaches `../inbox/mockup.html` from **all** shared-shell instances; no second Inbox home is added.

Web card order: byline/stored message → ask status → action heading → supplied facts → permission → exact evening time when offered → full command or technical/email disclosure → separate lasting yes → answers → Details. Native: Back → asker/context → big question → the same supplied facts/time → disclosures/lasting yes → separate footer. Both show full facts as readable text, not accessible-name-only hints. The scroll region is named **Approval content**, the footer **Approval answers** (or **Approval recovery**). Code/body regions are keyboard-focusable and selectable, named **The whole command**, **Requested server command**, **The whole email**. Native implementation should combine the asker context without announcing its face/name twice.

Details is an actual named HTML modal dialog. Close receives initial focus, Tab/Shift+Tab remain within it, and Close/Escape return to the card’s exact Details opener and content scroll record. Directly opened Details falls back to its matching card. This static navigation/focus record is not a native back-stack implementation. Native Back names Chat; a real app must restore the recorded originating door and scroll anchor using its existing navigation/AT APIs.

Technical details and More detail expand in place using `details/summary`, expose expansion state, keep trigger focus and grow inside the content scroller. A card’s expanded payload pushes answers **after** the text. Lasting yes opens a separate labelled dialog; Keep asking starts focused, cancel/Escape returns to its opener. HTML confirmation geometry is a proxy for the kept iOS alert/Android Material dialog. Unknown-answer recovery opens a preview of a check-only question, explicitly forbidding resending/rerunning; it sends nothing. Read retry keeps focus and announces the read attempt. Local answer selection focuses its result and removes the choice controls, without an automatic reorder or navigation.

## Targets, largest text, stability and contrast

Phone web links/buttons/disclosures are ≥44 CSS px; answers ≥48px. Native answers/lasting control ≥52pt/dp; iOS back/close/menu ≥44pt and Android ≥48dp. Android summaries inherit 48dp. Labels wrap and targets grow. Focus is the shared visible 2px token-brand outline. Native target units here are scale-1 CSS proxies, not measured OS hit regions.

Native maximum system settings retain the **effective 1.6× cap**: question 24 → 38.4, body 15.5 → 24.8, permission/time/labels/buttons all enlarge. The full fact scroller and stacked same-order answers remain. Web content can reach 200%; phone Details then uses document/modal scrolling so a tall footer cannot consume all content space. Below 650px height the design likewise falls back to scrolling through the complete content and answers. No line clamp, shrink-to-fit fact or fixed-height payload is introduced. Native tab-label fitting is only the existing shell exception; the approval push screen has no tabs.

No passive update/sort/timer runs. Facts and the evening instant are frozen during review; changing status must repaint the same keyed control without moving it under a finger. Explicit opening/closing preserves the opener and scroll. Native fonts, safe areas, gestures, keyboard, rotation, VoiceOver/TalkBack and live-update preservation remain future built-app gaps. Step 08’s real native approval captures remain separate before evidence; these afters are HTML drawings.

`renders.json`: **104 design render observations**, ordinary/largest, all four platforms/themes, primary read states, saved-read failure, both payload specimens and uncertain/never-sent answer states. Three content-scroll positions record actual text/RGB pairs; separate control/badge sampling includes numbers hidden from the accessibility text scan. No page/asset errors were observed.

| Platform | Text light / dark minimum | Control/badge light / dark minimum |
| --- | --- | --- |
| Desktop | 4.942 / 5.515 | 4.888 / 5.515 |
| Phone web | 5.190 / 5.515 | 5.190 / 5.515 |
| iOS drawing | 5.281 / 5.515 | 5.281 / 6.013 |
| Android drawing | 5.281 / 5.515 | 5.281 / 6.013 |

All sampled pairs meet **4.5:1** using WCAG sRGB luminance. Paint/font/radii/shadows use existing tokens and bundled fonts only. `warn-text` is used for read/answer uncertainty, not health Not working; shell red is justified by blackbox’s actual broken item. The scan does not certify native colours, anti-aliased pixels, avatar/provider art, focus/border graphics, scrimmed background text or every expanded confirmation. No whole-app score or native accessibility certification is claimed.

## Pictures, regeneration and delivery

Approval has **58 compressed PNGs**: eight normal, 24 loading/empty/failed, four web cards, eight long phone-web payload views, two largest/recovery contact sheets and twelve before pictures. Before pictures were captured **before authoring**, from step 12’s HTML at matching dimensions/theme/surface. They use its earlier 902 world; that change of story is labelled, not disguised as a pixel-only native comparison. New final-state scenes have no fabricated same-state before. The eight native largest payload studies and individual largest main views remain local in ignored `.whombat/shots/16-part2/`.

From repository root, Node 24 with existing dependencies:

```sh
node docs/design-handoff/council-ui-2026-11/16-final/approval/build-data.mjs
node docs/design-handoff/council-ui-2026-11/16-final/approval/render.mjs
```

The renderer also produces the owned Inbox PNGs/observations and local review pictures; it does not overwrite shared shell/Chat pictures. Paired before captures are optional local inputs; fresh-checkout rendering retains committed before PNGs. The helper bundle is written only under ignored `.whombat/`. No app/server/container/database/service or device is started, rebuilt, restarted or changed. Shared browser local-file automation failed with **“Invalid preview URL (unsupported-protocol: file:)”**; local-file Playwright Chromium produced the actual PNGs.

Delivery attempts and plain-language area notes, if an endpoint accepts an image, are recorded in `delivery.json`. Picture delivery is **partial**: 76 submissions / 225 endpoint attempts; **3 before pictures accepted**, no after picture accepted, 73 submissions failed. HTTPS could not resolve; both HTTP fallbacks returned 500, ‘Whombat couldn’t take that picture.’ No changed-area numbers were returned, so no comparison notes were invented. All final PNGs remain committed/local regardless. No CI/checks are claimed passing.
