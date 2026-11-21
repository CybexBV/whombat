# Fresh readings, plain errors, clear automations

Mockups only, for desktop web and the native Android/iOS apps. All authored files are in this folder. No application code, tests, tokens, contracts, decision files, shared gallery or TODO changes. Base: `f3e17c528`; origin/main was fetched and merged before work (already current). No council was started.

## What to review

Open [index.html](index.html). Its before/after columns keep the same screen and theme. Use the selectors for the other states, or open a drawing at its actual viewport. [states.html](states.html) is a compact sheet of the three pages’ first-load and empty components; it is not a screenshot of an app screen.

| Fix | Apps | Proposal |
| --- | --- | --- |
| Pinned point age | Web, Android, iOS | The last plotted point says **12 min ago**, with **Last point 11:10 · 12 min ago** underneath. No extension of a line into the present. |
| Refresh in progress | All three | **Refreshing** is its own quiet status. Last values remain in place. No replacement skeleton during a background read. |
| Failed refresh with older data | All three | A local error block names the failed read and says which older content remains. The values and their order remain. Overview’s error is visible even when its query has data. |
| Failed read without a saved copy | All three | The same block says there is no saved copy on this device. No zero values, healthy status claim or empty-list message substitutes for a failed read. |
| Unclear action | All three, shown on pve-02 | **The restart may have happened.** The only recovery offered is **Ask {assistant} to check**. No blind repeat and no assurance that nothing is lost. |
| First load and empty | All three pages, all three apps | Page-shaped placeholders; explicit content that will appear and a way to add it or finish its first connection. A separate server Machines empty state explains how to add a machine. |
| Enabled automation after a failed run | All three | A labelled decision variant gives On a neutral ring and emphasizes **Last run 10:43, failed** in amber. The automation stays enabled. |

Automations already shipped the whole-name row, trigger, On/Off separate from run bars, last-run words, next-run words, waiting run, page navigation and native spoken bar counts. None is presented as a new feature. The fixture’s failed automation is event-triggered and has no `nextRunAt`; no next-run prediction is added. There is no switch, retry, Run now or extra action on a list row.

The grey Off/Not on yet rows use opaque `mut` text instead of fading a whole group: they remain visually quieter and readable. Generic server/source icons and the simplified contextual sidebar are drawing scaffolding; no shell, source-art, metric hierarchy or navigation redesign is proposed. The existing blackbox headline and its assistant action are retained as context. The server’s neutral sketch sparklines stand in for the fixture trends; the task proposes no changed values or curve.

## Decisions kept, and the one explicit decision variant

Read first: [command-safety.md](../../../decisions/command-safety.md). Also read ARCHITECTURE.md, DECISIONS.md, the decision index, ui-refresh-status/inbox/chat, quiet-notices, needs-you-list, handle-it, both phone-refresh files, automation-page and the design-handoff README. CS-06 is superseded by RRB-03 in refactor-runtime-boundaries.md, which was also checked.

**Decision for John — reopens AP-6330, AP-6380, AP-1093.** The established automation row prescribes an On indicator and the run-bar colors; the shared round asks for red only for something not working now. The variant changes the failed-run row’s green On to a neutral ring, its past failed bar to amber, and emphasizes the existing last-run words in `warn-text`. A historical failure is never the thing-health label “Not working”. The row’s On word, enabled state, run history, order and destination stay the same.

The [version that keeps those decisions](mockup.html?screen=automations&state=normal&variant=keep) preserves the green On and red past-run bar, and is labelled as the decision-preserving comparison. The index shows the captured shipped version beside the variant, and links to both HTML versions. Red in that preserved evidence is not proposed as a new exception. No decision file is changed and this variant is not treated as approved.

All other views keep the decisions in force. Thing health remains Not working · Needs a look · Learning · Connected, using each server’s own Running/warm words where shipped. Heads-ups remain folded on the server. “Needs you” is not introduced outside the Inbox. There are no new thread flags, stages, counts, Settle changes, recurring notices or duplicate loud error banners.

## Error selection and safety

The block is one component shape; its words and recovery come from the operation and outcome, never from matching a raw error string.

| Known state | Visible words and behavior | Existing evidence |
| --- | --- | --- |
| Read failed, older result exists | “Couldn’t read/refresh {scope}”; says what is shown instead; Try again repeats that read only; Ask {assistant} opens its existing conversation. | Query `error` + `data`; known endpoint/screen; `Widget.problem`, `updatedAt`; no new server field. |
| Read failed, no result | Same title; “There’s no saved copy to show on this device yet.” Same two recovery controls. | Query error with no data. |
| Action’s answer lost, unknown outcome, or accepted external continuation still pending | “The restart may have happened.” Explain the missing answer and offer to check, without sending the action again. | Session `unknown_outcome`, command receipt/outcome; CS-02, CS-04b, RRB-03. A network failure after dispatch is not proof of refusal. |
| Action completed, reply redacted | “The change was saved. Its reply isn’t available.” Check the result before another change. | `completed` + `redacted`, CS-05/CS-12, subject to RRB-03’s pending-continuation rule. Never described as “failed”. |
| Definite proof of not starting | “The restart wasn’t started.” Check the connection before a new request. | Receipt `not_executed`, runner did not take it, CS-04b. This proof is required; a timeout alone cannot select this wording. |

The action examples are seeded review scenarios, not assertions about a real restart. **Ask {assistant} to check** uses the existing question/conversation path: ask whether the restart happened, explicitly without another restart. It does not promise a new automatic verification endpoint. Opening the page or seeing it online is not necessarily proof that a restart happened. If checking still cannot establish the result, keep the uncertain state and ask the person to inspect; do not silently enable a retry. A fresh action still follows its own approval and safety rules.

More detail alone contains diagnostic route text/code. It starts folded, including on phone. A read failure is an amber, polite, local status, not a red service-health failure. The saved blackbox failure retains its existing red cue. A second alert or toast is not added for the same read error. Permission/refusal/field errors retain their actual outcome and correction path; this is not a proposal to relabel every action error as uncertainty.

## Fixture and picture record

Original before pictures were inspected first in [01-groundwork/png/](../01-groundwork/png/): desktop Overview, pve-02, Automations in light/dark, plus the phone-width web context. Those original web pictures are not native screenshots.

Eight added **before** PNGs use this checkout’s unmodified fixture app, Playwright Chromium 1.63, the repository’s `tools/visual` `openApp`/`settle` harness, real bundled fonts, en-GB, Europe/Amsterdam, device scale 1 and the frozen **23 September 2026, 11:22** clock. Desktop is 1440×900, top of each page. Flags: `VITE_FIXTURES=1 VITE_FIXTURE_HOSTS=1 VITE_FIXTURE_DASHBOARDS=1 VITE_FIXTURE_FILES=1 VITE_FIXTURE_AUTOMATIONS=1`. No account, real Whombat, real service or database was used.

`capture.mjs before` injects only these query-cache scenarios:

- Pinned: same heat-pump values, all point times shifted five minutes earlier, `updatedAt` 11:10, a `Widget.problem` read failure. Last point 11:10 and clock 11:22 make **12 min ago** true. The shipped label still says Now. This scenario uses existing contract fields.
- Overview: `home.overview` keeps its data, gets an error, and is idle. The shipped screen hides that error.
- Server: `hosts.getServer` gets a route error and no saved data. The shipped ErrorLine prints the diagnostic. The matching primary after is `state=no-copy`; `state=read` separately shows the proposed retained-data case.
- Automations: only Suspected bug’s newest last/recent run changes from skipped to failed. Published/enabled and all other runs/rows stay unchanged. All eight rendered rows, their trigger/status/last-run text, accessibility labels and bar order are copied into `fixture.js` from the shipped render.

`fixture.js` obtains the assistant using **`agentWords(theAgentOf(bootstrap.principals)?.name).name`**. All authored assistant labels interpolate that captured value; no assistant name is hard-coded into the drawing logic. The literal value in the data snapshot is fixture evidence, not a naming decision.

Twenty-four compressed **after** PNGs: 10 web views at 1440×900, 10 Android HTML drawings at 390×844, 2 iOS header drawings at 390×844, and 2 component sheets at 1440×900. Themes have matching states. Phone pinned and Automations PNGs scroll 220 CSS px to show the changed last point/failed row; their complete initial state is available in HTML. Other primary shots start at the top. iOS and Android share content but keep separate header/target/tab-chrome drawings where they differ. Action uncertainty has its own web/Android pictures in both themes. The other states are inspectable HTML, not a large set of redundant PNGs.

The matching web comparison pairs are Overview read error, server no-copy read error, Automations failed latest run, and pinned aged/read-error state. Native drawings and the new loading/empty sheet have no same-state before capture; the viewer says so. There is no claim that a normal before screenshot proves a loading/error/empty state. Screenshots are also copied into `.whombat/shots/`, excluded through `.git/info/exclude`.

Reproduce from the repository root, Node 24:

```sh
VITE_FIXTURES=1 VITE_FIXTURE_HOSTS=1 VITE_FIXTURE_DASHBOARDS=1 VITE_FIXTURE_FILES=1 VITE_FIXTURE_AUTOMATIONS=1 pnpm --filter @whombat/web exec vite --host 127.0.0.1 --port 5267 --strictPort
# In another terminal; serves files only, no app/runtime service:
python3 -m http.server 5367 --bind 127.0.0.1
node --import tsx docs/design-handoff/council-ui-2026-11/05-freshness-errors/capture.mjs before
node --import tsx docs/design-handoff/council-ui-2026-11/05-freshness-errors/capture.mjs after
```

`CAPTURE_URL` and `REVIEW_URL` select other free ports. Each capture browser closes in `finally`. Temporary servers are stopped before handoff; no existing service is rebuilt or restarted for a documentation-only change.

### Native before GAPs

**Android and iOS, light and dark: before capture and actual native verification remain GAPs.** The supplied groundwork already attempted `apps/mobile/preview-runtime.cjs`: it packages a sandboxed preview module and does not mount native screens. This checkout has neither generated native projects nor a verified fixture-only binary. Device discovery found local emulators and Mac Studio simulators, but existing running devices have no attested fixture-only build from this checkout. None was opened or used, and no real data was read. No native dependency or application change was made to manufacture evidence.

The route to close the GAP is a build with `EXPO_PUBLIC_WHOMBAT_MODE=fixtures`, on isolated emulators/simulators, then device-tool captures of `whombat://connections`, `whombat://things/server%3Apve-02`, and `whombat://automations`. Match the clock explicitly: the native demo’s own default moment is 14:05, while these static drawings deliberately use the web fixture clock 11:22. Native screenshots, platform text rasterization, VoiceOver/TalkBack trees and largest supported OS text sizes are not verified by HTML.

## Every pictured line: sources

Paths below are relative to the repository root. Scenario values are explicit cache inputs in `capture.mjs`, not invented server features. Review captions, GAPs and decision labels are author annotations, not product data.

| Pictured line family | Data / renderer source |
| --- | --- |
| Burrow HQ, person and server/service names, Settings, navigation words | `apps/web/src/app/oneFixtures.ts`, bootstrap fixture principals/sidebar; `app/shell/AssistantSidebar.tsx`; native `navigation/TabBar.tsx`. The drawing’s nav is contextual scaffolding. |
| Assistant labels in errors, empty states, Ask, headline and composer | `packages/client/src/agentName.ts`, captured helper value in `fixture.js`; native `data/useAgent.ts` uses the same agent naming. |
| Overview headline and other-things count, Servers/Connections/Pinned counts | `oneFixtures.ts` home overview; `fixture.js.summary.needsYou - 1`; client `home/greeting.ts`, `home/sections.ts`, web `HomeScreen.tsx`. Five servers/five connections/one Home widget are the fixture world, not new counts. |
| Overview server names, OS, uptime, hardware, percentages, temperatures, running-machine counts, Running/Disk array failed/Running hot | `apps/web/src/app/hostsFixtures.ts`, `packages/client/src/hosts/fixtures.ts`; web home connection card model, `packages/client/src/hosts/model.ts`. Generic “in use”, “used”, “last reading” captions describe the pictured values, not a new freshness field. |
| Heat pump · today, Daikin Altherma, series names/values/units, points, source/footer | `oneFixtures.ts`’s heat-pump Widget; `packages/core/src/domain/home.ts` Widget; `packages/client/src/home/widgets.ts`; captured `fixture.js.widget`. |
| 11:10, 12 min ago, Showing readings from 11:10 | Seeded existing `Widget.points[].t`, `updatedAt`, frozen clock and timezone. In implementation calculate from the actual latest plotted sample, not fetch completion. `updatedAt` must not replace point time. A null/missing last time should say no reading time, never Now. |
| 00:00/04:00/08:00 and 0°–50° chart axis | Existing widget axis/tick model and fixture day span. The narrow drawing suppresses intermediate clock labels that would collide. |
| pve-02 page, warm pill, tabs/counts, metric verdicts/values, guest names/CPU/memory, backups and Technical details | `hostsFixtures.ts`, client `hosts/fixtures.ts`, `hosts/dashboard.ts`; web `features/things/ServerPage.tsx`; native server page renderer. Folded head-ups are the fixture’s CPU package, local-lvm forecast and four updates with one security update. |
| Automation names, all eight triggers, On/Off/Waiting for you/Not on yet, run/plan words, times, recent-run bar order, spoken bar counts | Snapshot of rendered `AutomationRow` plus `automations.list` source. `apps/web/src/app/automationFixtures.ts`, `packages/client/src/automationView.ts` (`automationListRows`, `automationState`, `runBarsLabel`), core trigger/plan formatters; native `screens/AutomationRow.tsx`. |
| Automations title/intro/composer/three ideas | Web `features/automations/automationModel.ts`, AskBox and shared composer; native `data/automations.ts`, AP-7419; `packages/client` automation ideas. No new form or automation editor. |
| Couldn’t read/refresh {scope}; older data/no-copy explanation; Refreshing; Try again; More detail | New local presentation copy derived from known operation/screen, query `data/error/isRefetching`, and Widget.problem. Baseline problem sites: web `HomeScreen.tsx` (`error && !data`), `features/things/parts.tsx` ErrorLine, `packages/client/src/hosts/errors.ts`; native HomeScreen/AutomationsScreen. These are client states, not absent server data. |
| Raw route text | Explicit fixture Error injected by `capture.mjs`; same diagnostic family the current host error formatter exposes. It appears only inside More detail in the proposal. |
| Action may have happened / saved, reply unavailable / wasn’t started and diagnostic codes | Existing session receipt/outcome classifications, `command-safety.md` and RRB-03; operation target comes from the initiating pve-02 action. The code in More detail is a seeded protocol-state example. No genuine action is invoked. |
| Empty messages, loading labels, add/open/describe/check controls | Explicit lengths/presence of existing query results and the known destination: Overview add-connection flow, Chat pinning, automation Chat proposal, server first report/guest list. Static skeleton shapes carry no pretend data. |
| 11:22 in the phone chrome | Frozen fixture clock. Chrome is an HTML diagram, not an OS screenshot or simulated network reading. |
| Gallery text, decision annotation, preview-only dialogs, component sheet labels | This review. Dialogs describe intended destinations and send nothing. They are not new product messages. |

**Needs new data:** no unmarked after view depends on it. Per-thing “last checked” on Overview would require the field UIR-17 deliberately leaves out; no such line is added. A global “readings from 13:02” cannot be inferred from a successful page fetch or Home’s `generatedAt`, so Overview instead names the saved overview. The brief’s 13:02 example is represented by **11:10**, the frozen scenario’s real saved-reading time. A numeric progress estimate, a next run for an event trigger, or a claim that the restart completed would also need evidence and is not drawn. No new-data variant is proposed here.

## Accessibility and behavior handoff

- **Reading order:** page title/identity → tabs → error heading and fallback → Try again (reads only) → Ask {assistant} → More detail → retained content. For a pinned card: heading/source → labelled values → refresh/error → chart summary → footer. An action error has only Ask {assistant} to check → More detail. Loading announces once; skeleton shapes are hidden. A no-copy error has no phantom content after it.
- **Names:** “Try again” lives in the region named by its failed scope (implementations may use “Try reading pve-02 again” as the full accessible name). More detail reports expanded/collapsed and owns its diagnostic panel. Chart is one image named with its series, values, actual last time and age; colored strokes are not extra spoken elements. Status shapes include the thing/why. Decorative source icons are hidden. Each automation is one link whose captured shared accessibility label includes name, state, trigger, last run and `runBarsLabel`; bars are hidden from the tree.
- **Focus order and return:** keep source DOM order. A read retry leaves focus on its button, with a polite Refreshing announcement; replacement values never steal focus. If the retry control disappears after success, move focus to the refreshed section heading, not the page top. More detail expands in place and keeps focus on its summary; closing it does not move it. Ask uses the existing thing/conversation path and recorded origin. Back returns to the initiating screen/control and scroll position. The mock’s explanatory dialog traps focus, closes with Escape or its real button, and returns to its opener; six platform/theme focus journeys were checked. No modal is proposed for each read error.
- **Targets:** native iOS recovery/back/tab targets are at least 44pt in the handoff; Android at least 48dp. The HTML uses 44/48 CSS px respectively, including More detail, composer and primary actions. Rows use their full width. Web recovery buttons and summaries are at least 44 CSS px. Pills and chart labels are not interactive. Native has the iOS previous-title chevron and Android 48dp arrow with title below; iOS edge-back/Android system-back behavior stays native.
- **Expanded behavior:** More detail adds wrapped diagnostic text below the controls, without moving values horizontally or exposing a retry for an action. Heads-ups stay one fold, expand the three existing fixture items and change the control to Show fewer. No popup or new alert is added. The existing automation page remains the destination for its switch, full description and recent runs; its run opens existing outcome details. This task does not redesign that detail page.
- **Largest text:** the HTML was checked at 200% for every screen, platform and theme, with no page-wide horizontal overflow. Words wrap; metric grids collapse; action buttons stack; the largest title may wrap within a word instead of shrinking. Tabs scroll locally; rows remain in order; no label is ellipsized to make it fit. Phone pictures at normal size are 390×844. Actual maximum iOS Dynamic Type/Android font scale, keyboard avoidance and VoiceOver/TalkBack remain native GAPs, not passed tests.
- **No reordering:** last values stay in place during refreshing/error. This static review has no polling, timers, automatic sorting or live replacement. Implementation must retain AP-7454’s native order until explicit refresh and the stable sidebar order; never move a target while a finger or focus is on it. Empty is selected only after a successful empty read, not while loading or after a failed request.

## Measured contrast and verification

`verification.json` records **150 rendered state/theme/platform cases**, color pairs and minima, plus **32 interaction checks** (24 at 200% text, six detail/focus returns, two gallery/native-GAP switches). The scan is the groundwork’s WCAG sRGB foreground/background calculation, executed against the actual after DOM with the real token stylesheet. Default-state errors: zero. No new tests or baselines are written to the application suite.

| Pair / minimum | Light | Dark |
| --- | ---: | ---: |
| Lowest sampled visible text, all rendered cases | **4.641:1** | **4.904:1** |
| Muted text on sf2 | 4.854:1 | 4.904:1 |
| Warning text on sf2 | 5.418:1 | 7.606:1 |
| Existing broken-status text on sf2 | 4.641:1 | 6.364:1 |

All sampled text pairs clear 4.5:1 in both themes. Tokens, fonts, radii and shadows come from `packages/tokens/tokens.css` and the bundled web font stylesheet; there are no new hard-coded colors. Error/failed-run words use `warn-text`, not the lower-contrast mark/fill token. Off/draft text is not faded with parent opacity.

Limits: DOM sampling covers visible text and solid backgrounds, not every OS-rendered/native element, chart stroke, focus indicator, input placeholder or offscreen word. The composer placeholder explicitly uses `mut` on `sf`, the same passing token pair; its computed colors are recorded. Native contrast figures here describe the HTML proposal only. A real native conformance claim remains a GAP.

Repository checks for this documentation-only task: `pnpm lint`, `pnpm notices --check`, `pnpm typecheck`; JavaScript syntax, local link/artifact review, rendered contrast, safety wording, viewport overflow and interaction checks. No full test suite or Postgres test was run, as the brief explicitly requests. Lint reports existing informational CSS specificity diagnostics, with exit code 0. No checks, tests, safety rules or budgets were altered.

### Baselines an implementation would need

No existing reference or baseline is changed now. The primary screen references are `home-redesign/proposed.html` (Overview/pins), `connections/tabs.html`, `connections/server-cards.html`, `dashboards/index.html` (server/read states). The shared error/empty/loading component needs a new reference state; neither old .dc.html has a comprehensive freshness/error matrix. If that shared component is added to the originals, add explicit states to **`design/Whombat Desktop.dc.html`** and **`design/Whombat Mobile.dc.html`**, then corresponding web visual fixtures. Do not rebaseline unrelated Chat/card/approval states. Automations’ shipped list/page references and `apps/web/visual` built-app baselines need focused state additions only after John selects a variant. Native baselines must be captured from fixture-only builds separately.

### Picture delivery

`deliver.mjs` attempts every workstream PNG against the three supplied addresses in order, before pictures first. `delivery.json` retains each response. HTTPS cannot resolve. The first HTTP fallback accepted one before picture (Automations · web · dark); the other 31 pictures, including every after picture, were rejected by both HTTP fallbacks with HTTP 500 (“Whombat couldn’t take that picture.”). No numbered after regions or notes endpoint submission could be produced. All PNGs remain here and in `.whombat/shots/`; this external failure does not erase the visual evidence.
