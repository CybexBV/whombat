# Final thread and cards · round four

Mockups only, on `delegate/thread-one-approval-card-plus-plan-ejp78-3`, starting from fetched main `5cf15c134` and incorporating main `7f7e90d31` for the shell refresh. [Card views](index.html) · [interactive drawing](mockup.html). Only `16-final/thread/`, `approval/` and `inbox/` change. `SHELL.md`, `STORY.md`, shared shell/story files, the main gallery, folders 02–15, application code and decision documents stay with their owners.

## This round

- Shell-conflict refresh: merge main `7f7e90d31`, retain its shared shell/story/gallery files exactly, and rerender all owned Thread, Approval and Inbox views. The real service logos, visible web Search and native Back-first row now accompany these approval/plan cards. Source: main's `shell.js`, `shell.css`, `SHELL.md` and `STORY.md`; no local shell edits or new product words.
- One shared approval drawing (`../approval/card.js`, `card.css`) replaces the short thread variant and native Review and answer door. Its title says what happens to what; permission and the complete meaning of **Yes, tonight** precede the answers. Every surface uses **Yes, now · Yes, tonight · No**, all outlined, with equal weight and no selected answer. The three phone answers stack in that order. Facts and answers share the same scroller, including at largest text; an answer never floats over unread facts. Phone arrival waits for fonts and starts at the whole message when it fits, otherwise at the whole card boundary. Earlier messages remain above it.
- The primary approval remains **33**, limiting pve-02’s ZFS cache to **16 GB**. Inbox’s distinct restart remains **31**, with **4 → 8 GB** and **about 40 seconds**. Its payload has no permission key: the shared permission position explicitly says **Not supplied in this request** instead of borrowing approval 33’s key. It is not a second cache-limit request.
- New current-step and blocked-step plan cards use the exported invoice plan. A status mark, status word and recorded time lead a plain title and one sentence of what and why. The main action and at most one secondary action occupy the same position. Technical identifiers, original technical step wording, run and approval references are in Details.
- **Brief scope removed by Dusty.** The required pre-push merge brought in `c2d995103`, including John’s “Remove this entirely” instruction in `docs/decisions/brief-removed.md`. Dusty explicitly answered **“Omit morning/evening brief mockups”**. No brief/digest card, gallery entry, schedule control or related PNG is added. No removed feature is proposed for reintroduction.
- Phone plan cards start folded to four text lines at normal text (status, title, two-line summary), with their main action visible. **Show more** opens the same card in place; **Show less** restores it. Separate folded/open PNGs include the kept largest text. Large text wraps naturally instead of cutting facts to a line cap.
- Council text continues through the escaped Markdown formatter: paragraphs, lists, bold, emphasis and inline code render; raw `**` is absent. A council title and status mark now follow the common card layout. Delegation keeps exactly **one Details** containing task records, PR rows and pictures. Its title is already visible in the thread header, avoiding a duplicate above Hand over at largest text.
- iOS keeps its chevron **and previous title Chat**, including largest text; Android keeps its arrow. Own messages still have no own name or face. Loading, empty, failed read and failed refresh remain separate.

## Facts and every line’s source

The normal pve-02 thread is still the shared **23 September 2026, 14:05 Europe/Amsterdam** scenario. Supplemental card scenes are explicitly separate examples; they do not append messages, create Inbox items, change counts or claim work happened.

| Visible line family | Data source / presentation mapping |
| --- | --- |
| Shell, assistant name, person, Chat 1 / Inbox 3, Places, Search, native chrome | Unmodified `../story.js`, `../shell.js`, `../shell.css`; `../SHELL.md` and `../STORY.md`. `{assistant}` resolves through `S.assistant`, the existing name-helper export. OS 09:41 is schematic chrome. |
| Thread topic, stored messages, times, subject, model change | `S.threadBodies['msg_chat-memory']`, its selected root/replies and `ranOn`. Historical 91% / 38 GB stays historical. No current report is substituted into a stored message. |
| Approval title, pve-02 / 16 GB, 14:03, target and exact command | The reply’s `card.approval`, also exported as `FINAL_APPROVAL.primary.approval`. `whatHappens=[]`: no consequence or extra restart promise is added. The target, command and explainer are folded into Details. |
| “Permission used” / “Change things in connected services” | `FINAL_APPROVAL.primary.keyLabel`, generated from `KEY_CATALOG[approval.keyId]` in `../approval/build-data.mjs`. The label is a fact, not a new permission grant. |
| “{assistant} needs your OK” / status mark | Existing ask wording plus `S.assistant`; outlined circle denotes waiting, never a health failure. |
| “Yes, tonight means Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam” | `FINAL_APPROVAL.tonight` (`2026-09-24T01:00:00.000Z`), the same existing `nextAt` meaning, formatted with full date, year and named zone. Inbox uses its own supplied `approve_later.at`, the same instant in this snapshot. |
| Yes, now / Yes, tonight / No | Existing approval ask words, in their existing order. Shared neutral answer controls; no recommendation, consequence or undo is introduced. |
| Approval Details / Don’t ask again for pve-02… / lasting-permission preview | Existing technical facts and `FINAL_APPROVAL.primary.view.lasting`. The existing lasting-permission door stays under Details, away from the three answers. Its own confirmation is retained; no lasting permission is inferred from a one-time answer. |
| Invoice PDF export, 11:22, current/blocked step, all four steps, due date, run and approval records | Existing `../../04-cards/fixture.js`, `CARD_FIXTURE.states.plan` and `plan-go-ahead`, through `Cards.dataFor`. Time is `plan.updatedAt`. `plan` chooses the first recorded active step; `plan-go-ahead` chooses its recorded gate. These are alternatives, not simultaneous stages. |
| Now: building the invoice export so invoices can be downloaded as PDFs | Authored plain-language summary of the fixture title and **Build the export endpoint** step. The original technical title remains in Details. The other visible step mappings are “Pick a PDF library” → “Choose how to make PDFs” and “Deploy to staging” → “Try it before publishing”. No completion/progress percentage is invented. |
| Waiting for your review against the brief so the next step can start / Blocked step | Authored summary of the fixture’s **Review against the brief**, `state=gate`, **Waiting for your go** note. **Waiting for you** is amber, not Not working. Deployment’s separate approval remains separate. |
| Open plan / Go ahead / Change something | Existing step-04 plan actions. Open plan exposes the same plan in place; Go ahead is a read-only action preview; Change something focuses an unsent reply. |
| Council members, answer/plan words, provider marks, result, completion time and pictures | Existing `../../04-cards/fixture.js` council-done card. Provider marks are real bundled assets. Verdicts are words; numeric source scores are not reintroduced as the result. Escaped Markdown handles its literal bold/emphasis/list source. |
| Delegation selected tasks, dependency, AI, statuses, task records, PRs, More, pictures and notes | Existing step-04 delegation-offer / delegation-working fixtures. Selected 1, 2, 4 and task-4-after-1 remain above Hand over. One Details per card; no nested record/picture disclosures. |
| Loading / No replies yet / Couldn’t read or refresh / saved-copy explanation / Try again / Ask | Existing final local read-state alternatives and `STORY.md`. Retry only reads; Ask prepares an unsent question. Failed refresh keeps original message order. |
| Show more / Show less / Current step / Blocked step / Details / gallery controls and captions | Authored presentation/review labels. Native `<details>` preserves trigger focus, reading order and in-place expansion. No live timer sorts or opens anything. |

## Rendered evidence and reproduction

Run the existing drawing drivers with Node 24 and installed repository dependencies:

```sh
node docs/design-handoff/council-ui-2026-11/16-final/thread/render.mjs
node docs/design-handoff/council-ui-2026-11/16-final/approval/render.mjs
```

Desktop is 1440×900; phone web, iOS and Android drawings are 390×844. Both themes are rendered. `text=largest` uses phone-web 200% and native’s kept 1.6× cap. Thread’s `captures.json` / `captures.js` map all scenes into the local card-view gallery. Existing primary PNG names remain; new files follow `<platform>-<theme>-<scene>[-largest].png`. Each new plan has folded and open phone drawings; desktop starts open. Earlier before atlases stay untouched.

`observations.json` records geometry and token paint across 196 thread views. The approval renderer also renders the changed approval and Inbox pages, their kept read states, long payload specimens, and maximum-text proof sheets. It records 104 approval and 48 Inbox observations in their folders. These are design render observations, not tests. All sampled text meets 4.5:1; the recorded minimum is 4.942:1. Android interactive targets are at least 48 CSS px; iOS/phone web at least 44. New folded everyday-card main actions fit the initial viewport at normal and largest kept text. Long open cards scroll normally; largest text is never shrunk to force a four-line fit.

Native PNGs are HTML geometry drawings, not new device captures. They do not certify native safe areas, keyboard behavior, rotation or VoiceOver/TalkBack. No native device, service, database, container or appliance was changed. Static mockups have no service to rebuild or restart.

## Before/after delivery

Fresh matching before pictures were taken **before editing**, in `.whombat/shots/round4-thread/`, excluded through `.git/info/exclude`. All four platforms and themes cover the existing thread, council/answers, delegation/working/records, approval card and Inbox approval view. New plan cards have no fabricated before screen. Matching afters use the same viewport and scenario; new plan-card pictures are sent as additional after views.

The shared browser returned **“Invalid preview URL (unsupported-protocol: file:)”**. The repository’s Playwright renderer opened local files directly; no server was started. Whombat picture delivery tries the requested HTTPS address followed by both HTTP fallbacks. [round4-delivery.json](round4-delivery.json) records **64 before + 138 after submissions**, **606 endpoint attempts**, and **zero accepted pictures**. HTTPS could not resolve; the HTTP fallbacks returned 500, 503 or 429. No changed-area numbers were returned, so no numbered notes could be sent. All final PNGs are committed regardless of delivery failure.

**NO CI**, as instructed: no lint, typecheck, tests, notices, build/CI request or PR-check wait. Render and visual review only; no application check is claimed passing.
