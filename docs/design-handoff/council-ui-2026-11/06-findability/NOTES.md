# Finding things — evidence and design notes

Mockups only. Assigned folder only. The branch fetched origin and merged its default branch (`main`); it was already current at f3e17c528. No app, tests, tokens, decision documents or shared scoring files change.

## Today

Read `../SCORING.md` and `../01-groundwork/` before taking pictures. Settings is below 8 (desktop 7.0, phone web 6.6), so this work includes a small Settings front page. Files is 6.8 / 6.1, Vault 7.3 / 6.7; native marks remain GAP. These are review marks, not participant results. No future built-app score is claimed.

The twelve `png/before-web-*.png` pictures are fresh captures of this checkout before mockup authoring, not reconstructions. Fixture-only Vite, Playwright Chromium, tools/visual's `openApp`, fixed 23 September 2026 11:22 Europe/Amsterdam, en-GB, 1440×900, scale 1, fonts ready, reduced motion, light and dark. Flags: VITE_FIXTURES, VITE_FIXTURE_HOSTS, VITE_FIXTURE_DASHBOARDS, VITE_FIXTURE_FILES, VITE_FIXTURE_AUTOMATIONS = 1; local fixture looks = 1. No cache facts were patched. Each is also saved under ignored `.whombat/shots/`.

The helper name in `fixture.js` is resolved from the captured bootstrap with `agentWords(theAgentOf(principals)?.name).name`; authored UI uses that value. Its groups come from SETTINGS_GROUP_TEXT / SETTINGS_GROUPS; the five search rows come directly from packages/fixtures/src/search.ts. No assistant name is authored in the mockup.

## Capture GAPs

Native iOS and Android **before** remain separate GAPs. device_list found simulators/emulators, but no verified fixture-only native binary/project is present in this checkout. The mobile preview-runtime.cjs is an asset transformer, not an app renderer (the groundwork already records the unsuccessful Expo web export). No real device, signed-in app or real data was opened. Static HTML phone proposals are not native captures and cannot close those gaps. The available shared preview was opened on fixture Chat; final evidence uses the explicitly requested Playwright Chromium harness.

There is no evening brief in the baseline fixture. No current time/on-off state is invented. The proposal points to the existing assistant flow, with an unsent question, rather than adding a Settings schedule field. The brief card's Change time remains its shipped control (briefs.md BRF-01/05).

Overview today opens Servers when servers exist (HomeScreen + openConnectionsTab), not Connections. The requested alternative will be compared with that actual capture. Search is absent from the phone on purpose (AP-2645), and the web has no search box (AP-2274). These remain true in the main proposal.

## Before delivery

Tried all three supplied upload addresses, in their order, for every before view. None accepted a picture. `delivery.json` records each view. Pictures remain in this folder and `.whombat/shots/`. After delivery will be attempted too.

## Main version and decision boundaries

- **Web + native phone:** Files → Vault, always this name and order. Web adds Files just before the existing Vault link. Phone adds the pair to Settings’ front page. Files remains in Chat while there are files, including the More menu when it does not fit. The new global pair also has an empty state when there are no files; it does not disappear.
- **Web Chat:** the shipped phone has two orders, not one. Retention priority is Feedback → Settled → What {assistant} did → Files (AP-7460, `fitHeaderButtons`). Display order is What {assistant} did → Files → Feedback → Settled (`SHOWN_ORDER`). The wide web already matches the latter for this fixture, which has no Feedback room. It is preserved. At 390px the prototype keeps Settled and puts the other two in “More in Chat”. A built version must use the shared fit rule, including conditional Feedback; it must not put Feedback into a fixture where no such room exists. No new status sentence in Chat.
- **Web + phone Settings:** a front page above the existing group destinations, not a sixth group. Quick links expose Notifications and an evening-brief question; Your things exposes Files and Vault; the five groups retain their shared order and names. Deep links still reach the same existing group/part. No invented “most used” telemetry, recent history, brief time or notification values.
- **Main Search:** web remains keyboard-only (AP-2274), native search links still open on the web (AP-2645). A static retained screenshot represents the existing web Search after Cmd/Ctrl+K; its query controls are not reimplemented in this main mockup.
- **Decision for John — reopens AP-2274:** web Search gains a labelled navigation link, keeping the shortcut and existing index. It is a separate variant, not a change included in the main version.
- **Decision for John — reopens AP-2645:** native gains a Search screen, reached from Search links or Chat → More → Search only in the variant. It keeps the five tabs; it is not a sixth tab. iOS and Android proposals are beside the “no screen, opens on web” explanation and native GAP.
- **Decision for John — reopens CN-11 / AP-2564:** Overview opens on one Inbox link and the already-pinned widget. This also changes the default-tab rule in AP-2565 and the phone’s tab-first view in AP-2580. SBT-01’s name and address stay. Today is accurately shown on Servers in this world. The new page has no independent Needs you list, answers, Settle or urgency count; those stay in the Inbox. The Inbox link carries its one existing count and worst item. With no waiting item it would show a quiet “Open Inbox” link, not an empty urgent card. With no pins it would offer the existing pin flow, not suggested invented widgets. Those empty variants are specified, not pictured or tested.

No decision is edited or taken on John’s behalf. No council is started.

## Every pictured line and figure has a source

Paths below are repository-root relative. Fixed interface labels are authored copy or shared constants, not claims about live data. Every unchanged desktop line is kept as pixels from its named fresh before picture rather than redrawn.

| Pictured material | Source and derivation |
|---|---|
| Before Chat, its header, names, dates, times, thread messages, reply counts, statuses and composer | apps/web/src/app/chatChannelFixtures.ts and lookFixtures.ts; features/chats/ChatRoomScreen.tsx; messaging renderers; packages/client chat helpers. Before PNG is preserved as the main content of proposed desktop Chat. |
| Before/after desktop Files introduction, two conversation rows, counts, sizes, times | apps/web/src/app/filesFixtures.ts, rendered by features/files/FilesScreen.tsx. The same two rows are transcribed in phone proposals: feat/invoice-pdf · 4 files · 136 MB · 11:20; Chat · 3 files · 488 bytes · 11:04. No cross-conversation file search is promised. |
| Before/after desktop Vault introduction, privacy paragraph, Add to Vault, four entry names, kinds, addresses, use times, stopped-password reason, network link | packages/fixtures/src/vault.ts + fixtureFetch.ts; core’s Vault words/formatters; features/vault/VaultScreen.tsx. Phone uses those same four entries and facts, never a secret value. Its compact list is a proposal using this shared world, not a native baseline. The existing sealed store and entry actions are unchanged. |
| Burrow HQ, Mara Okafor, initials, assistant name; server/connection list and marks | oneFixtures.ts / bootstrap / host fixtures; AssistantSidebar model. The unchanged list region is clipped directly from the before Chat PNG; it is not reordered or recoloured. The account footer is also clipped from the original picture, preserving its shipped avatar, copy and menu. |
| Chat/Inbox/Overview/Automations/Files/Vault/Settings; keyboard hint; feedback/settled/did labels; shared navigation order | Existing shell/CHAT_WORDS/SETTLE_WORDS/route names; AP-7460 and SHOWN_ORDER. Files-before-Vault and Quick links/Your things/Settings groups are proposed fixed navigation copy. Existing destination dialogs in this prototype identify destinations only, not their shipped content. |
| Five Settings group labels | SETTINGS_GROUPS and SETTINGS_GROUP_TEXT.groups(helperName), generated into fixture.js. Sub-lines are fixed summaries of existing parts from packages/client/src/settingsGroups.ts and apps/mobile/src/settings/list.ts; they are not account values. |
| Notifications → You → Notifications | SETTINGS_GROUP_TEXT.you.notifications; existing web `?tab=you&part=notifications` / phone Profile notifications part. The prototype opens a destination-only dialog; it does not manufacture notification settings. |
| Evening brief; “Ask {assistant} to change its time”; prepared question | Proposed fixed shortcut copy. Existing BRF-01/05 and briefing_set provide the assistant route. The sentence is a user-editable unsent question, not an assistant answer or a fetched schedule. The prototype deliberately has no Send action and performs no mutation. A built app would open Chat with the draft; it would never send it on shortcut activation. |
| Search query, result type, location, receipt-independent snippets, exact euro amounts | packages/fixtures/src/search.ts: SEARCH_QUERY and SEARCH_RESULTS, copied into fixture.js. Five results: THREAD fix/credit-note-vat; PATCH PR #311; RUN #1882; CANVAS Invoicing rules v3; MESSAGE feat/invoice-pdf. Snippets are verbatim. No synthetic plan, decision or automation result. |
| Search filter names and counts | packages/core/src/domain/search.ts: SEARCH_FILTER_LABELS, searchFilterOf and countSearchResults applied to those five fixture rows: All 5; Threads 2 (includes MESSAGE); Patches 1; Runs 1; Canvases 1; Plans 0; Decisions 0; Automations 0. Today’s visual query hides the zero categories; the phone variant exposes them to make scope explicit. The web variant preserves its existing answer, receipts, filters and five rows as captured pixels, adding only the navigation link and a review annotation in the spare right column. |
| Search result-source annotations, zero-match state, preview-query explanation | Review-only annotations. Today’s index supplies none of connections, servers, settings or actions. A variant could match names against home.overview.things and hosts.fleet only while those lists are already on the device; Settings labels can use bundled SETTINGS_GROUP_TEXT / SETTINGS_GROUPS, without live values. An unavailable list means **needs new data**. Actions always **needs new data**: no search/action catalogue is supplied, and the mockup never executes one. These sources are named beside both Search variants; they are not added to the five current search results. |
| Overview link’s blackbox sentence, 7 and 6; server/connection counts 5; Pinned 1 | Same look-enabled fixture world and existing home/Inbox helpers as before screenshots. The title is the worst item, 7 is the one Inbox count, 6 the other items; no second count is computed. Host and connection totals come from the before Overview. No severity inferred from prose. |
| Heat pump · today; Daikin Altherma; Room 21 °C; Water to radiators 34 °C; Outside 9 °C; graph and updated time | oneFixtures.ts’s `wdg_heat-pump`, copied from the frozen home.overview widget into fixture.js, including every graph point and updatedAt=2026-09-23T09:22:00.000Z. Time is 11:22 Europe/Amsterdam. The timestamp describes this widget only; it is not a timestamp for the server fleet or the whole Overview. The three curves use only these stored points and chart1…3 tokens. |
| Phone status-bar clock | Frozen fixture clock 11:22. Bar glyphs are decorative chrome placeholders, not network/battery measurements. iOS/Android native chrome remains a verification GAP. |
| Gallery headings, decision labels, GAPs, contact-sheet labels and explanatory text | This review, SCORING.md and the source/decision observations above. They are review labels, not product-data claims. |

No product line in the main proposal needs a new contract or data field. Potential extra search categories are limited and marked as above. No secret contents enter any pictured search result.

## Glance-and-find tasks: before and after walkthrough

**Method:** author walkthrough, fresh Chat/nav state per task, frozen fixtures, both themes. No independent participant was available. No stopwatch result is invented; time and first-choice/wrong-turn observations required by SCORING.md remain **not measured**. Native before is a source walkthrough only, with its pixel GAP. “After” describes the static prototype route, not a built-app pass. The formal timed pass/fail gates remain unawarded.

| Shared task | Before walkthrough | After walkthrough and limit |
|---|---|---|
| In five seconds, what needs you and what do you press? | Chat has the waiting pve-02 thread; Inbox is the one place to act. Overview names blackbox above server cards. Approval stays its own review. | Main preserves those screens and Settle. In the Overview decision variant, blackbox leads to Open Inbox; there is no second Ask/Approve/Settle surface. Thread Waiting for you is from the actual waiting flag. No five-second participant result; Inbox/approval work is outside this slice. |
| Find the Vault from Chat and name an entry without revealing a secret | Web: sidebar Vault, one navigation step; four named entries already findable. Phone source: Settings → {assistant} → What it may do → sign-ins → Vault, with no native pixels. | Web: Vault remains visible, with Files immediately before it. Phone: Settings → Vault, two navigation steps; Grafana and the other named entries stay sealed. Prototype’s row opens a destination-only dialog. Time-to-find and native result remain GAP; the claim is fewer navigation layers, not a measured speed-up. |
| Find the evening brief setting without changing it | No evening brief card in this fixture. BRF-01/05 puts Change time on that card; asking the assistant is the other shipped route. Notifications has no evening-brief setting. Task-state GAP. | Settings → Evening brief prepares “Where can I change my evening brief’s time?” for the assistant. It does not guess a time or show a nonexistent global schedule page. Author verified editing, Escape and focus return; no send/mutation. A brief-card fixture or scripted assistant answer is still needed to complete the scoring task. |
| Find an automation’s last run, outcome and time; return | Existing Automations list/details route. This capture work did not exercise its run detail. | Unchanged; Automations stays reachable in the same main navigation/tab. Destination-only stub in this prototype. Full walkthrough, outcome/time and return evidence belong to 05 and remain GAP here; no claimed pass. |
| Tell whether Overview numbers are current | Before’s server figures have no sample time or explicit unknown freshness. FAIL in the snapshot, as groundwork recorded. | Main unchanged: still an unresolved 05 issue. The alternative landing shows the pinned widget’s real updatedAt, clearly scoped to that widget; it supplies no invented fleet sample time. This is not a pass for the original server-number task. |

Additional findability walkthrough: Files from web Chat is already one header link while files exist; the proposal makes the same destination visible in the sidebar even in another screen or with no files. On phone, Chat → More → Files remains; Settings → Files sits immediately before Settings → Vault. This is consistency/discovery work; it does not rename or move any file or secret.

## Accessibility and expanded behavior

**Names and reading order.** Web navigation is Chat, Inbox (existing count), Overview, Automations, Files, Vault; Search comes first only in its labelled decision variant. Existing servers/connections stay in their fixed order, then the person’s Settings link. Phone main tabs remain Chat, Inbox (“7 things need you, something is not working” in this world), Overview, Automations, Settings; the badge is decoration within the named tab. In Settings, title → Quick links → Notifications → Evening brief → Your things → Files → Vault → Settings groups → You → {assistant} → Connections → This Whombat → Advanced → Theme. File rows are named with conversation, count, size and time; Vault rows with name, kind, last use/problem, never a secret. Decorative icons are hidden. Search’s field has one name (“Search your conversations and work”); filters expose aria-pressed, results keep their types and sources, the result count is a polite status. The scope panel is expressly a **review note**. Dialogs are named by their heading.

**Focus and return.** Keyboard order follows DOM/visual order. Dialogs trap focus through the browser’s modal behavior; Escape/Back returns it to the invoking control. More returns to “More in Chat”. The brief shortcut focuses the editable question and returns to its shortcut on close. Prototype Files/Vault back links remember Chat or Settings as their origin and restore focus to the original link. Cmd/Ctrl+K and Escape preserve the originating web page; the retained main Search is static art, so its input/focus behavior is a specification, not fully simulated. A built implementation must focus the query field, restore the exact prior control on Escape, and restore result/scroll position after returning from a result. iOS edge back and Android predictive back should follow the same origin; HTML cannot verify either.

**Sizes and expansion.** New phone links/buttons are at least 44px; Android at least 48px (48dp implementation target). Chat retains Settled, then More as room runs out; the omitted entries stay in retention order. Feedback is conditional on an actual room. iOS More is a native menu; Android a sheet. This static prototype uses a named dialog to demonstrate its contents/return, not a claim to render either native surface. Settings parts, Vault entry actions, Files subfolders, Inbox actions and other destinations use intentionally small destination-only dialogs: their existing product screens are not redesigned here. File removal, Vault replacement/trust, answers, lasting permissions and Settle/Undo retain their existing safety rules; none is actionable in the mockup. Search filters have a real zero-match preview state; a different typed query says that the static preview contains only the captured query, rather than fabricating an answer.

**Largest text.** `&text=largest` shows 200% Settings content text at 390px. It wraps group descriptions, grows rows and scrolls vertically, without horizontal overflow; the five tabs remain in their system-sized region. Both themes captured locally. This is an HTML content stress check, not iOS Dynamic Type / Android maximum font-size certification. Other enlarged native states, VoiceOver, TalkBack, native menu/sheet geometry and real keyboard avoidance remain GAP.

**Stable positions.** No item reorders under the pointer/finger. The pair and five groups are fixed; incoming values may change in place. Loaded server/connection order remains unchanged; new search results should replace only on explicit submit/filter, with focus and list position preserved. Do not turn an unloaded local list into a zero count. Large-text expansion scrolls rather than moving the target to another group.

**Status and calm.** No new health scale, failure flag, unread meaning or second Needs you list. Thing health stays Not working · Needs a look · Learning · Connected. Thread-stage precedence remains Waiting for you > {assistant} is working > Handed over > Settled, with New reply only from unread. This work adds no stage calculation. Red remains for not working (the existing failed-array count and stopped password); heads-ups remain folded; the Inbox keeps Settle. The Overview alternative’s single Inbox tile, rather than a full duplicated urgent list, respects that boundary.

## Measured contrast and verification

New rendered text’s minimum sampled contrast (light / dark), WCAG 2.x sRGB. Every pair is ≥4.5:1. The full foreground/background pairs, viewport, visible text and checks are in `capture.json`.

| Static proposal | Light | Dark |
|---|---:|---:|
| web · chat | 5.190:1 | 7.803:1 |
| web · files | 5.190:1 | 7.803:1 |
| web · vault | 5.190:1 | 7.803:1 |
| web · settings | 5.190:1 | 5.515:1 |
| web · search | 5.190:1 | 5.515:1 |
| web · overview | 5.190:1 | 5.515:1 |
| ios · chat | 5.281:1 | 5.515:1 |
| ios · files | 5.281:1 | 5.515:1 |
| ios · vault | 5.281:1 | 5.515:1 |
| ios · settings | 5.281:1 | 5.515:1 |
| ios · search | 5.281:1 | 5.515:1 |
| ios · overview | 5.428:1 | 5.515:1 |
| android · files | 5.618:1 | 5.515:1 |
| android · settings | 5.281:1 | 5.515:1 |

The Search input value was also measured separately: **16.445:1 light / 13.657:1 dark** (`input-contrast.json`). Text in retained screenshot regions keeps its actual captured appearance; it is excluded from the new DOM measurement. The groundwork’s prior measurements remain the evidence for those unchanged pixels, including pre-existing failures. This work does not claim a screenshot-wide WCAG certification, native contrast measurements or to fix unrelated baseline contrast. SVG chart strokes, system chrome and focus indicators are not text-contrast samples.

`capture.mjs` uses Playwright Chromium directly on local files, with the frozen fixture clock, 1440×900 desktop and 390×844 phone. It captures light/dark, checks fonts/images/overflow, records touch target heights and exercises 14 route, focus, filter, large-text and gallery observations. All 28 screen/theme records have loaded fonts, no broken images, no horizontal overflow, no small phone targets and no sampled text failures. Android’s two pictured screens use 48px minimum targets; iOS uses 44px or larger. The six compressed phone contact sheets avoid committing many duplicate screenshots; 32 PNGs total are about 3.2 MB. Individual viewport pictures also stay in ignored `.whombat/shots/`.

To reproduce the static after set from the repository root with Node 24: `node docs/design-handoff/council-ui-2026-11/06-findability/capture.mjs`. Open `index.html` directly in a browser; no server, package build, real account or network data is needed. All fonts, tokens and pictures resolve within the checkout. `review.html` is the compact conversation view; the index is the complete side-by-side review.

Repository checks: `pnpm format` (no edits), `pnpm lint`, `pnpm notices --check`, `pnpm typecheck`, JavaScript syntax checks and `git diff --check` passed. Biome reports existing informational CSS specificity messages, with no errors/warnings. Per the task’s explicit “no full test suite”, no full test suite or server integration suite was run. No software or development service changed, so no runtime rebuild/restart or deployment applies. Only the assigned folder changes.

## Baselines and remaining work

No `.dc.html` file or baseline changes in this task. A future approved implementation would need a new **Whombat Desktop.dc.html** shell/Chat/Search reference baseline where those components are covered, the personal shell references in `one-whombat/`, and `settings-mobile/index.html` for the front page; **Whombat Mobile.dc.html** supplies component styling only and does not define the current five-tab app. The web Settings/Vault/Search screenshot baselines and a Files baseline in tools/visual would need deliberate review, without changing unrelated screen budgets. The Overview variant would also need new `connections/tabs.html` and Overview references after John’s decision. Native component snapshots/journeys need actual fixture-only iOS/Android builds, not HTML.

Still GAP: native before captures and native assistive technology; independent timed tasks; a real evening-brief fixture/assistant response; unpictured empty/loading/read-error and full entry/subfolder flows; largest native text and keyboard/safe areas. The formal app score stays blocked as in SCORING.md. These mockups do not award an after score or a built-app score.

## Final picture delivery

Retried each before/after pair through all supplied addresses in order. **Chat, Files and Overview, light and dark, were accepted at http://10.100.1.81:4480**; their after responses supplied numbered areas, and plain-language notes for every number were accepted. The first attempts failed; these final retries supersede them.

**Settings, Vault and Search, both themes, could not be delivered.** The Tailscale hostname did not resolve; both IP addresses returned HTTP 500 with “Whombat couldn’t take that picture.” The PNGs and complete attempt/response record are retained here (`delivery.json`). Native has no legitimate before picture to pair; its static proposals are in the gallery and contact sheets. No native picture is mislabelled as shipped evidence. This upload limitation does not discard any local artifact or claim the missing comparisons passed.
