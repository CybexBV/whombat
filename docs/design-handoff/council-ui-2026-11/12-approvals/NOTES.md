# Approvals on the phone and in the phone browser

Mockups only. This folder revises step 03 using step 07’s phone-comfort rules and step 08’s actual native evidence. No app, contract, token, test, decision, scoring sheet or shared task-list file changes. The branch was fetched and merged with origin/main before authoring; it was already current at 382f0597e. No council or subagents were started.

## Review and scope

Open `index.html` from a repository-root static server, or open its local file in Chromium. Choose web/phone browser/iOS/Android, the five approval kinds, details, theme, state and text size. The full-size link preserves the selected parameters. Every answer is a local illustration: nothing sends an approval, runs a command, grants a key, sends mail or asks an assistant.

The before side is explicitly **step 03’s HTML design**, not a screenshot of today’s native app. Sixteen ordinary pending before pictures were taken before changes, in both themes, at matching 1440×900 desktop or 390×844 phone dimensions. Their after pictures keep the same kind, surface and viewport. New loading/recovery states and the four-times-long mail stress have no equivalent before; the viewer says so. The ordinary before beside “largest” is labelled ordinary, never presented as maximum-size evidence.

Actual iOS/Android approval evidence already exists in `../08-native-capture/`: approval 33, ordinary and largest system text, light and dark. The gallery links it separately. Those captures use a 14:05 native world; this drawing uses step 03’s approval 902 and 11:22 fixture clock. Step 03/07’s earlier blanket “no native before” gap is therefore superseded by step 08’s evidence, without rewriting those folders. The proposed facts/layout and native assistive-technology behavior still need verification in a future fixture build. No future built-app score is claimed.

## What changes in each app

| App / surface | Revision |
| --- | --- |
| Native iOS and Android, ApprovalScreen | Keep the left-aligned 24/700 question. Put the supplied facts, named permission, exact evening date/time/zone and genuine unmet conditions in the scrollable content under it. Keep the existing separate answer footer. Remove the redundant sole-person condition box, preserving AP-6553. |
| Native ordinary answers | Yes, now / Yes, tonight / No remain equal outlined buttons. At large text they stack in that order. Deploy/key retain Decline / Approve normally and approve-first when stacked, as AP-7409 requires. Command retains all existing scopes. |
| Web desktop, approval card | State the action once in the title. Remove the duplicate surrounding message/action paragraph and repeated “What will happen” action. Additional supplied facts remain. Search is a visible link, with no search box. Usage is named and visible outside Advanced. |
| Web details | The question and additional facts precede the existing answers. A real modal dialog contains the review, with a separate answer footer and Close. Everyday details keep Yes, do it / No; no new tonight answer is invented here. |
| Phone-width web, 390px | Drawer starts closed; compact Chat/Search/Inbox navigation replaces the desktop sidebar. Card and full-height details wrap the exact long command or whole mail body, with a bounded content scroller and separate answer footer. Details is reachable from the card, including everyday/mail cards. |
| All four platform drawings | Explicit loading, failed read, uncertain answer and proven-never-sent answer scenarios. Unknown outcome removes all answer/resend controls and offers a check only. |

Native Chat’s Review and answer door is not redesigned. There are no own-person chat rows, no added recommendation, generic consequence, undo promise, duration estimate, attachment chip or blank stage label. The existing 1.6× text cap stays. The only rollback/migration statements are the supplied deploy fixture facts, never claims added to other kinds.

Assumptions resolved locally: a sole `person_approves` condition is redundant whenever the native question/footer already asks that person, including command/key; deploy retains its complete multi-condition list. Native back goes to the originating Chat/Inbox approval door in an implementation; the static link returns to this gallery. Read failure is drawn with **no cached approval**, while uncertain-answer scenes retain the last reviewed facts; those retained conditions are not a claim that status is fresh.

Dusty’s main-design directions applied here: visible web Search link (AP-2274’s **no search box** rule remains intact); the name Usage outside Advanced; Android targets at least 48dp. None of these requires reopening an approval decision. The other authorized main-design reopenings belong to other screens and are not pictured here: Reopens AP-2645 — decided by Dusty for John's review; Reopens AP-7626 — decided by Dusty for John's review; Reopens AP-7718 — decided by Dusty for John's review; Reopens AP-7704 — decided by Dusty for John's review; Reopens AP-7730 — decided by Dusty for John's review; Reopens AP-7731 — decided by Dusty for John's review; Reopens AP-6412 — decided by Dusty for John's review. No implementation or evidence for those changes is claimed by this folder. No new approval decision is proposed.

## Every pictured line and its source

Paths below are relative to the repository root. `fixture.js` is a read-only browser snapshot of step 03’s `fixture-world.json`, made by its `build-fixtures.mjs`. No live account, mailbox, box or device data is used. All five kinds remain separate in the gallery, including every recovery state. Static section/control names are authored UI labels, not extra server fields.

| Pictured line family | Source / binding |
| --- | --- |
| Assistant name, face and interpolated words | Step 03 snapshot of `agentWords(theAgentOf(bootstrap.principals).name).name`, from `apps/web/src/app/oneFixtures.ts` and `packages/client/src/agentName.ts`; selected production avatar in `packages/avatars/svg`. No authored assistant name literal. |
| Everyday question/title, pve-02, 16 GB, restart once | `apps/web/src/app/chatChannelFixtures.ts`, ZFS approval 902: `question`, `action.params.words/server`, `whatHappens[0]`; core action-copy title for the web card. Restart once is additional supplied information below the action. |
| Everyday permission | `Approval.keyId = connections.write`; `packages/core/src/keys/catalog.ts` label “Change things in connected services”. The label names the permission used, not an unread grant tier. |
| Yes, tonight and exact evening date/time/zone | Shared `APPROVAL_ASK_WORDS`; step 03 `nextAt(frozen now, Europe/Amsterdam, changeWindow.get.start)`, using the shipped 03:00 fallback when no change-window query is supplied. The stored `world.tonight` formats to Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam. A real supplied start would replace that fallback. |
| Command question/title, web-1, reason, exact command | `apps/web/src/app/commandFixtures.ts`, `FIXTURE_COMMAND` / `runCommandApproval`, serialized by step 03: `action.params.command/target/reason/category`. All rsync/ssh bytes are retained; wrapping never substitutes ellipses. |
| Command permission and scope answers | `keyId deploy.production` and key catalogue label; core `commands/copy.ts` `commandScopeLabels`, `approvalView.scopeChoices` and `declineCta`. Allow once / task / always are distinct existing choices. |
| Deploy title, service, staging, ref, latest commit | `packages/fixtures/src/work.ts` `deployApproval`, `action.params.service/environment/ref/sha`. `sha` is null, so it says latest commit on the supplied branch, not the old example SHA as a pinned revision. The service/environment formatting is authored from those fields. |
| Deploy migration, two pods and rollback lines | The same approval’s supplied `whatHappens[1…3]`. Their wording is kept verbatim. An approval without those facts omits them. |
| Unmet checks, review and person; counts/reviewer/fixing/waiting notes | `Approval.conditions` (`ChecksPassCondition`, `ReviewApprovedCondition`, `PersonApprovesCondition`) and core `approvalView.conditions`, desktop/mobile label and note. Met / Not yet are state labels from the boolean. Native omits only the sole-person box. Web retains the supplied conditions. |
| Mail question/title, From, To, subject and message | `apps/web/src/features/approvals/ApprovalDetails.stories.tsx`, `emailApproval` / `emailBody`; `MailSendAction.params.connectionEmail/to/subject/body`. Full message is shown in details/native; web card keeps body under Technical details (`handle-it.md`). |
| No Cc or Bcc; mail permission | Empty `cc` and `bcc` arrays; `keyId mail.send` catalogue label “Send emails”. No invented attachment metadata is added even though the source body mentions an attachment. |
| Long-mail stress | `length=long` repeats that same fixture body four times, separated by blank lines. No new recipient, subject or factual prose is invented. The gallery and PNG captions explicitly label this length stress; it is not a distinct server approval. |
| Key request/title, “To use without asking”, permission | Step 03’s schema-shaped `GrantKeyAction`, `params.keyId web.browse`, key catalogue “Browse the web”, core action-copy/requested tier. It grants at the catalogue cap; it is not one-run command permission. |
| Approval eyebrows, question/CTA/scopes, approval confirmations | Core `approvals/display.ts` `approvalView`, `APPROVAL_ASK_WORDS`, `v.label/mobileLabel/question/cta/mobileCta/declineCta/lasting/toasts`. “{assistant} needs your OK” follows AP-7404/05. |
| Permission used/requested, Why, Applies to, From/To/Subject/Copies, Message, Command, Technical details | Authored static labels describing the adjacent existing fields; not extra data. `a.target`, `connection.argumentsPreview` and `a.explainer` remain in Technical details when supplied. |
| Don’t ask again for pve-02…, title/body/Keep asking/Let {assistant} do it | `approvalView.lasting`; AP-7407/08. Native replaces the Settings destination with pve-02’s page in Overview, as shipped. The dialog keeps the action’s standing-permission meaning. |
| Loading the approval…; Couldn’t load the approval.; no saved approval; Try again / Back to Chat | Authored copy for explicitly seeded local query states: pending read; read error without cached data. Retry re-reads only. `More detail` identifies the fixture read failure. These are scenario inputs, not invented live incidents. |
| Your answer may have gone through.; didn’t get a reply; check first | Authored plain-language copy for an unconfirmed command/answer receipt, following `docs/decisions/command-safety.md` CS-01/02/04b and its `unknown_outcome` discussion. Command’s More detail names that receipt; other kinds describe missing answer delivery. Unknown/rejected-with-unknown is not a refusal. |
| Ask {assistant} to check; check-only explanation and preview question | Authored recovery control backed by the unknown receipt scenario. The local dialog previews asking whether the answer was saved and what happened, explicitly forbidding resending or rerunning. No new recovery API is claimed. |
| Your answer wasn’t saved.; The request wasn’t sent. You can answer again. | Separate scenario with affirmative proof the request was never dispatched, not a generic timeout. The original choices may return only with that proof (`not_executed` / pre-dispatch failure), following command-safety. No retry is offered for uncertainty. |
| Local answered illustrations | Existing core `v.toasts.approve`, plus shared Running, Scheduled for tonight, You said no and supplied deploy waiting state. 11:22 is the frozen illustration’s decision time; 03:00 is the stored evening fixture’s fallback. These clicks are local only; no Undo is added. |
| Author/time, subject chips, native chrome | Helper-derived assistant; `Approval.createdAt` formatted in Europe/Amsterdam; pve-02/web-1/billing-api/Invoice 1042 from the selected target/subject. Native 11:22/battery/back symbols are illustrative fixture chrome, not an OS capture. |
| Burrow HQ, navigation destinations and Close/Back/Details names | Existing fixture burrow from `oneFixtures.ts`; existing app routes/labels. Search visibility and Usage placement follow Dusty’s instructions. This is a reduced contextual shell with no invented counts. Navigation links return to the static gallery; they do not implement those pages. |
| Static sidebar preview text; gallery headings/selectors/captions/dimensions/evidence explanations | Authored review UI. The sidebar preview is a local labelled dialog, not a new app flow. Contact-sheet captions sit outside product screens and distinguish HTML drawings from native evidence. |
| Before-side text | Unmodified step 03 design and its source ledger; the separate actual native reference is step 08. The new-state comparison has no fabricated before. |

No main-design fact requires new server data. There is no recommendation/consequence/undo variant and no raised-cap alternative in this step.

## Reading order, focus and expanded behavior

Native intended order: Back to Chat → assistant face/name, ask status, who/place/time → bold question → supplied facts → named permission → exact evening time when offered → genuine conditions → whole command/message → Technical details → separate lasting yes → one-time answers. Web omits the duplicate assistant action message: navigation/byline → status → action heading once → additional facts/permission/time/conditions → payload/disclosures → answers → Details when on a card. The command is named “The command”; the email body “The whole message”. Both are selectable and wrap without horizontal page scrolling or truncation. Native implementation should avoid announcing the avatar/name twice as a combined header.

The content is a labelled keyboard-focusable scroll region before the separate “Approval answers” footer. All fact text is visible text, not accessible-name-only content. Headings are real headings; conditions have Met / Not yet words and notes, not colour alone. Back’s accessible name is “Back to Chat”, the menu “Open the sidebar”, close “Close approval details”. Details uses a real modal `dialog` named “Approval details”, trapping Tab/Shift+Tab; the initial close link is focused by modal opening. Close or Escape restores the exact card Details opener and its content scroll position via a local stored return record. Directly opened details fall back to the matching card.

Technical details and More detail use `details/summary`: Enter/Space expands in place, exposes expanded state, and retains trigger focus. Full mail body remains folded on the web card, but is open in details and native. Nothing automatically opens over a moving finger. A separate lasting-yes button opens a named modal with the existing title/body; Keep asking receives initial focus. Escape/cancel returns to that exact opener. Confirm also closes this **static** preview; it never grants permission. Native implementation must use its iOS alert / Android Material dialog and existing back gestures rather than this HTML proxy.

Loading uses a polite status and decorative skeletons, with no answer controls. Read failure has a named heading/status and Try again (read only), then Back to Chat. Unknown answer is announced before the retained question/facts; only “Ask {assistant} to check” and an explanation occupy the recovery footer. That button opens a check-only question preview; it never resends an answer. For never-sent proof, the failure status precedes the original choices. Real asynchronous implementations should move accessibility focus to the new local status without navigating or moving another item; initial scenario drawings do not simulate that platform event. Local answer illustrations focus their updated status result and remove the choices.

The fixed fixture never live-sorts, replaces a row under a finger, or changes the exact evening time during review. Dialog return restores scroll. Real updates replace status in place; refresh/navigation may adopt new order. Unknown-answer recovery must reconcile a receipt before making a fresh decision available.

## Touch targets and largest text

Web touch controls/back/close/disclosures are at least 44 CSS px; answer buttons at least 48px. Native HTML answer buttons are at least 52px and grow for wrapping. Native back is 44pt iOS / 48dp Android; Android links and summaries are at least 48dp. Lasting permission is a full-width text control, at least 52px high. These HTML CSS sizes are design proxies for pt/dp, not native hit-target measurements. Focus uses a visible 2px token-brand outline. No hover-only answer or Details control is used.

At the largest iOS accessibility setting and Android 200% system text, current app text is capped at **1.6×**. The drawing preserves that cap: question 24 → 38.4, body 15.5 → 24.8, labels and answer words also enlarge. It never substitutes step 03’s 200% stress for actual native maximum evidence. Every kind is rendered at ordinary and effective largest text in both themes, with scroll samples through its facts. The native ordinary/large pair and bottom-of-content fact contact sheets show the question and the permission/time/deploy-condition/mail continuation separately. All facts remain in the scroller at full size; there is no line cap or shrink-to-fit.

At 390×844 the answer footer has its own layout space and the content scrolls above it. Long commands and long email details use the same split. Browser 200% text and viewports below 650px height fall back to document/modal scrolling: the footer is reachable by scrolling instead of consuming all content height. That is an HTML layout fallback, not a native keyboard/safe-area claim. Native platform line breaking, AX5/Android font metrics, safe areas, device rotation, software keyboard, VoiceOver/TalkBack and gesture journeys remain future built-app verification gaps.

## Pictures and contrast

Fourteen losslessly compressed PNGs in `png/` contain both themes: desktop, long browser command, long browser email, native ordinary/largest, fact continuations, distinct kinds and recovery states. Contact sheets are 1440×900 with unscaled 390×844 inner drawings. Extra local individual largest-text pictures and the sixteen same-state before/after pairs are in ignored `.whombat/shots/`. No old PNG is overwritten.

`render.mjs` uses Playwright Chromium, en-GB, Europe/Amsterdam, device scale 1, reduced motion and bundled fonts. It generates pictures and design observations only; it runs no application test suite. `render-measurements.json` records 126 render observations, answer rectangles, question sizes, five content-scroll samples and unique rendered sRGB pairs, using step 01’s `contrast.js`. The render has no page/asset errors. Sampled visible text, including amber state text, muted labels, links and button words, meets **≥4.5:1** in both themes:

| All recorded drawing states | Light minimum | Dark minimum |
| --- | ---: | ---: |
| Rendered text, all five kinds / four platforms / details / largest / recovery | 4.808:1 | 5.515:1 |

Colours/fonts/radii/shadows come from `packages/tokens/tokens.css` and bundled font CSS. No new token or component colour is added. Warning text uses `warn-text`; frames use `warn` only for pending approvals, neutral `line` for loading/read errors/unknown outcomes. Local errors are amber, never a red failed-thread stage. These measurements cover sampled DOM text and solid backgrounds, not SVG/bitmap text, focus-ring/graphic contrast, platform glass, all expanded-dialog combinations or native WCAG certification. Step 08’s actual native contrast remains separate evidence; it cannot certify this future layout.

Regenerate from the repository root with Node 24:

```sh
node docs/design-handoff/council-ui-2026-11/12-approvals/render.mjs
```

No running app, database or native device is needed. Paired after captures additionally use the optional local `.whombat/before-manifest.json`; fresh checkouts still regenerate the committed PNG set and design observations. The fixture snapshot intentionally stays tied to step 03; refresh it only by deliberately rebuilding that source world and reviewing the resulting facts. A future implementation would need corresponding approval portions of the desktop/mobile `.dc.html` references updated; this task does not change them.

## Delivery and checks

John’s later instruction takes priority over the original request to run checks and wait on PR checks: **“skip CI. Don’t run lint, typecheck, notices or any tests, and don’t wait for pull request checks.”** No lint, typecheck, notices, tests or CI jobs were run or awaited. PNG rendering, visual inspection and recorded contrast/layout observations are the verification for this mockup-only delivery. No check is claimed passing.

Picture upload results are recorded separately in `delivery.json`; any failed destination is retained there. The HTTPS picture endpoint did not resolve; the first HTTP fallback accepted the initial web before/after pair. It also accepted the one numbered plain-language note for that pair. A subsequent batch of all 66 picture submissions (including that pair again) failed: both HTTP fallbacks returned 500, “Whombat couldn’t take that picture.” No further changed-area numbers were returned, so no extra notes are invented. Delivery is partial: two initially accepted pictures and one accepted note; all fourteen compressed PNGs and the local before/after/individual captures remain available.

No shared dev service, database, container, lease or native device was created or changed. Only this task’s temporary static review server was used; it is stopped before handoff. Static documentation needs no application build/restart or deployment.
