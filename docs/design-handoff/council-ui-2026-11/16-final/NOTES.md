# 16 · Final shell, shared fixture story, Chat and Search

Round-four changes and their sources are recorded below. The retained round-three evidence follows.

Mockups only. Round three, part 1, on `delegate/final-shell-story-and-chat`, created directly from fetched `origin/main` **d5f14d2bc**. Earlier rounds are retained. This task changes only `16-final/` and the explicitly requested top-level gallery links for 08–16. No app code, contracts, tokens, tests, decision documents, SCORING or TODO changes. No council, subagents, native build, real account or running appliance was used.

**John’s updated instruction is NO CI:** no lint, typecheck, notices, test suite, `pnpm check`, build gate, CI request or PR-check wait. Chromium renders and the requested WCAG colour calculations are design evidence, not an application test run. No service changed; no rebuild/restart or temporary server is needed. The drawings open directly from local files.

## Deliverables and ownership

- [SHELL.md](SHELL.md): one exact sidebar, phone-web bar, native tabs and **open Places** menu, with names/order/sizes/badges/focus. [Shell picture viewer](shell-review.html).
- [STORY.md](STORY.md): one time, selected fixture records and explicit resolutions of the mismatches in earlier rounds. `story.js` is its generated read-only data companion; later screen owners should use it.
- [index.html](index.html): **12 rows × 4 platform cells**, an `img` for each `<screen>/<platform>-light.png`, dark toggle, one NOTES link per row. Missing files show quiet **coming**, without a broken-image glyph or a substitute from another round.
- [Chat](chat-list/index.html): before/final review, interactive HTML, four platforms, light/dark, loading, successful empty, failed first read and failed refresh with saved messages. PNG names match the final gallery contract exactly.
- The parent gallery now leads with **16 / Final design**, links **08–15**, and corrects the obsolete statement that all native captures are missing. No score or built-app verdict changes.

The other eleven final screen folders/pictures/NOTES are intentionally owned by the following parts. Their links are reserved and their images remain **coming**. Utility navigation previews in `shell.html` show the selected Files/Vault/Usage home with actual fixture metadata so the path from Chat is inspectable; they are not delivered as those final screens. The thread link there provides a labelled destination preview, not a new competing final thread design; the thread owner must adopt the selected root/approval from STORY and its own retained thread anatomy.

## App per fix

| App | Main change |
| --- | --- |
| Desktop web | One 256px places sidebar, Search as a link, Files → Vault → Usage in the canonical order, Settings explicitly named; chronological Chat and the separate waiting/Answer treatment stay. |
| Phone-width web | 56px bar with **Places · Search · 3 need you**; drawer closed on normal pictures and drawn open separately. All message actions use one 44px ⋯ on the author line. No squeezed desktop sidebar. |
| Native iOS | Existing five tab identities, readable token-coloured badges, labelled Places menu in desktop order; self name/face removed from own message headers. Long-press/accessibility actions stay; no extra ⋯ raises the native author line. |
| Native Android | Same content/navigation order, Android tab/back treatment, **48dp targets**, including the composer field, buttons, rows and menu dismissal. |
| All four | Shared helper-named assistant, same 14:05 story, same Inbox count and pve-02 wording/readings. Empty/loading/failed query states remain distinct and inside the shell. |

Native afters are **HTML drawings**, with scale-1 CSS pixels representing pt/dp. iOS’s floating bar and Android’s full-width bar keep different chrome geometry, while names/order are identical. Actual native gesture, safe-area, keyboard and screen-reader journeys are not certified here.

## Decision authority

The exact shell authority and affected decisions are in [SHELL.md](SHELL.md#decision-authority), repeated here for the required record:

- **Reopens AP-2645 — decided by Dusty for John's review.** Native Search screen entry; final Search content remains the findability owner’s responsibility.
- **Reopens AP-6412 — decided by Dusty for John's review.** iOS token-coloured readable badge; also affects AP-7463’s old system-red exception.
- **Reopens STG-03 — decided by Dusty for John's review.** Usage display name.
- **Reopens STG-10 — decided by Dusty for John's review.** Usage outside Advanced.
- **Reopens STG-12 — decided by Dusty for John's review.** One Usage destination, converging the Spend links.

The user explicitly requested one Files/Vault/Usage navigation home and one chosen shell: this consolidates earlier Settings/Chat shortcuts into Places and Overview’s server/connection lists without creating a sixth native tab. AP-7460’s Feedback/Settled fit priority stays. AP-2274’s no-navigation-search-box rule stays. UIR-64/65/66, AP-7417, AP-2454, TU-05, AP-2408 and the chronological Chat decisions stay; **no thread-row-list variant** is substituted for the shipped timeline.

Dusty’s accepted council/delegation presentation changes remain for the following card parts: **Reopens AP-7626 — decided by Dusty for John's review; Reopens AP-7718 — decided by Dusty for John's review; Reopens AP-7704 — decided by Dusty for John's review; Reopens AP-7730 — decided by Dusty for John's review; Reopens AP-7731 — decided by Dusty for John's review.** No council/delegation card is drawn or claimed implemented in this part. Folded connection heads-ups remain accepted. No recommended approval answer, new consequence, new undo or raised native text cap is introduced.

## Every pictured line: source ledger

Paths are repository-root relative. The data selections and all conflicts are detailed in STORY.md; per-render wording and RGB pairs are in `renders.json`. Authored navigation/empty/error/control labels are presentation copy selected from known scope/route/query state, not invented server fields.

| Pictured family | Source and derivation |
| --- | --- |
| Burrow HQ; Mara; assistant; Ask/reply interpolations; person’s initials | `packages/fixtures/src/principals.ts`; `assistantAgent()` and **`agentWords(...).name`** in the exporter. Burrow display name agrees with fixture bootstrap/earlier captures. Person appears only in the sidebar footer, not own Chat headers. |
| Search, Places, Chat, Inbox, Overview, Automations, Files, Vault, Usage, Settings; selected state; “One place for your questions, connections and work” | Existing app destination labels plus Dusty’s explicit shell consolidation/Usage/Search instructions. The quiet sidebar sentence is authored explanatory UI copy, not a service status. `shell.js` has the single ordered destination table. |
| Inbox **3**, red cue, **1** Chat/Feedback badge | Native `createAssistantFixtures(...).handle('home.overview')` → exactly three `needsYou` records; `inbox.length`, not inconsistent summary fields. Native `chatChannel.ts` Feedback room’s supplied `unread=1`, matching 08/15 tab context. Badge counts are not per-root unread evidence. |
| Normal Chat message words, local times, subjects, saved-as label, replies/counts | Native `chatChannel.ts` via `messages.list`, `messages.thread`, `chats.threads`; all six open roots and ten thread bodies are exported. `Intl.DateTimeFormat` in Europe/Amsterdam; last reply differences computed from 14:05. |
| Waiting, working, no-reply / last-reply words, marks and navigation chevron | The exported `ChatThread.waiting`, `working`, `handedOver`, `settled`, `replyCount`, `lastAt`. No prose inference. Count zero says No replies yet; mark and stage are both supplied when a flag proves the stage. |
| Assistant participant face; self author omission; provider mark in composer | Existing production `operator-head-small.svg`, consistent with the fixture face and steps 11/15; `packages/brand/assets/marks/claude.svg`. Self name/face omission is the shared design instruction. No claim that all historical replies used that provider. |
| Feedback, Settled, What {assistant} did, More in Chat, message actions | Existing Chat/Settle affordances, UIR-64…68, AP-7460 and step 11’s action policy. Settle only on eligible roots; four shelf records come from real `settled` objects. Preview controls send no command. |
| Ask {assistant} anything; Attach a file, File, AI mark, mic, Send | Existing UIR-60/61/62 and native composer conventions/AP-7418. Web phone uses the named icon-only attachment control; native retains no added File button. Send is outlined with no text; form submission is prevented in this static drawing. |
| Loading/empty/failed/saved-read headings, explanation, Try again, Ask, More detail | Authored query-state presentation, step 05’s **exact** “There’s no saved copy to show on this device yet.” structure and step 11 Chat words. Fixture diagnostic is explicitly seeded: “The fixture read did not answer.” / `messages.list`. No real outage or command failure is asserted. |
| Destination previews: Files names/counts/sizes/times | Web `filesFixtures.ts` and step 14’s already exported/visible Files scenario. See STORY for source IDs and counts; populated native remains a layout scenario, not repaired backend evidence. |
| Destination previews: Vault entry names/checks and Shop admin | Step 14 `vault.entries` snapshot; Shop admin adds only `vaultSaved` name/kind/id from the actual 11:31 Chat message. No check result/time/secret is inferred for that record. |
| Destination previews: Usage windows, totals, USD and prepared time | Step 14 `spend.overview`; totals are input+output, cost rounded only for display. Scope remains all reporting providers combined. Prepared time is **11:22**, not restamped to the observation clock. |
| Destination preview: thread words | Selected native `messages.thread` body/root/card; labelled navigation preview only. It does not stand in for a final thread screenshot or answer a card. |
| 09:41; OS signal/battery shapes | Step 08’s normalized illustrative chrome. Not a sample time, battery measurement or actual native after capture. |
| Line icons / drawer, selected row, 44/48 targets | Existing simple line vocabulary in steps 11/14, token-only paint, explicitly chosen shell geometry in SHELL. Not a new logo/token system. |
| Before captions, final/coming labels, dimensions, gallery controls and explanatory gaps | Authored review apparatus, outside product facts. Before images are fresh **step 11 HTML design captures**, never mislabelled running-app screenshots. |

## Accessibility, focus, expansion and largest text

[SHELL.md](SHELL.md#focus-expansion-largest-text-and-stability) specifies exact navigation focus and modal order. Chat’s order, actions, expansion and return behavior are in [chat-list/NOTES.md](chat-list/NOTES.md). Before authoring, screenshots were saved for all affected existing designs and the parent gallery. The open Places drawings show the first focused Close control; active links/badges include names rather than relying on colour.

Every new phone web target is ≥44 CSS px; iOS ≥44pt and Android ≥48dp. Menu rows grow; content and menu have bounded scrollers. Native combined message accessibility actions/word selection must remain. A screenshot of a native-looking dialog does not establish OS focus, gesture or hit-slop implementation.

Web largest content text is **200%**; native remains the kept **1.6× effective cap**, with its existing tab-label fitting exception. Largest Chat pictures are local evidence under `.whombat/shots/16-final/`; no cap increase is silently shown as approved. No approval fact is drawn away in this task; the following approval owner must retain all facts at the existing maximum.

No timer, poll, automatic sorting, mutation or write runs in these static documents. Chronological roots retain identity/order. Stages/counts update in place in an implementation; defer a visual reorder during a pointer operation rather than change AP-2408’s separate thread-list cache policy. Explicit navigation/folds retain the initiating control and scroll anchor.

## PNGs, colours and evidence limits

Playwright **Chromium**, scale 1, en-GB, Europe/Amsterdam, reduced motion, local bundled fonts and real token CSS. Desktop **1440×900**, other platforms **390×844**. Before captures precede authoring; `.whombat/` is in `.git/info/exclude`. Native-looking before and after pictures here are both **HTML designs**; step 08 remains the actual native capture evidence.

Committed: **40 final Chat PNGs** (normal plus four read states × four platforms × two themes), **8 before PNGs**, and **6 open Places PNGs**. Closed-shell pictures reuse the final Chat images instead of another duplicate set. PNGs use lossless compression. The normal arrival camera anchors to the heat-pump question; older messages remain above. The desktop has additional bottom breathing room so the latest stage can remain visible with the composer. Before and after have matching dimensions/themes; changed story/arrival framing is explicitly not a pixel-only comparison. Newly drawn query states have no matched previous-state PNG; the review says so and links to the earlier same-state HTML.

`renders.json` records normal/read-state/largest/menu geometry, actual words and sampled solid colour pairs; no assertion suite is run. The shared preview reported unavailable, then rejected local files with **“Invalid preview URL (unsupported-protocol: file:)”**. Playwright renders local files directly; no preview tab, service, container, database, simulator or emulator was created.

Measured WCAG 2.x sRGB contrast, `(lighter + .05)/(darker + .05)`, using step 01’s `contrast.js`. Minimum sampled visible text, including shell and controls:

| Platform, across rendered states | Light | Dark |
| --- | ---: | ---: |
| Desktop | **4.942:1** | **5.515:1** |
| Phone web | **5.190:1** | **5.515:1** |
| iOS drawing | **5.281:1** | **5.515:1** |
| Android drawing | **5.281:1** | **5.515:1** |

All sampled text pairs meet **4.5:1**. The separately sampled badge/control minimum is **4.888:1 light / 5.515:1 dark** across the four platforms; this includes the Inbox badge excluded by the general text-tree scan. Badge paint and control foregrounds are separately recorded by the renderer because decorative badge numbers are excluded from the general text-tree sampler. Text/solid-background samples are not every rasterized pixel or native accessibility certification. Provider/avatar art, OS shapes, scrimmed background content and non-text focus/border geometry are outside a full WCAG audit. Quiet read errors use warn-text, actual failure red remains tied to blackbox, and unread remains neutral.

Remaining gaps: the eleven following final screen deliverables; independent glance/find participant results; actual native implementation, largest-system-text rendering, keyboard, gestures and VoiceOver/TalkBack journeys; live-update/focus preservation; fixture backend parity for native Files. No score, application baseline or built-app verification column is filled.

## Reproduction and delivery

From repository root with installed dependencies and Node 24:

```sh
node --import tsx docs/design-handoff/council-ui-2026-11/16-final/build-story.mjs
node docs/design-handoff/council-ui-2026-11/16-final/render.mjs
```

This rebuilds design data/pictures only. The source bundler writes its intermediate file into ignored `.whombat/`; no source dependency or generated token changes. No install, lint, typecheck, notices, test, CI or deployment command is required. Picture delivery attempts and any accepted numbered notes are recorded in `delivery.json`.

All **36 before/after uploads** were attempted at each supplied address in order (**108 attempts**). HTTPS failed hostname resolution; both HTTP fallbacks returned **500**. No picture was accepted, so no numbered comparison areas or notes were available. All final PNGs are committed regardless; no successful upload is claimed.


## Round four · phone shell finish and a real Search screen

Workstream `delegate/phone-shell-finish-and-a-real-dc1dm-3`, based on fetched main’s final design. Only shared shell/story/gallery source, the new `search/` folder and refreshed final PNGs change. Existing screen authors’ source is retained. The brief schedule metadata is also kept in the existing story exporter so rerunning it preserves the selection. No app code, decision docs, earlier rounds, TODO or scoring changes. Dusty merges; no deploy or persistent service changes.

What changed this round:

| Change / pictured line family | Data source and rule |
| --- | --- |
| Real-logo Servers and Connections shortcuts in every sidebar / Places | Native `assistant.ts` → `SERVERS` and `otherThings`; exported identity/OS mapping in `story.js.shellThings`. Exact existing Proxmox, Unraid, Debian, Home Assistant, UniFi, Hetzner and Mail SVGs in `packages/brand/assets/marks`. Heat pump retains its thermometer. No generic server replaces a known logo. |
| Native Back first, including thread, approval, Files, Vault, Usage and settings children | Existing screen back links supply their destinations/titles; shell moves them into the first row below OS chrome and removes the stacked top-level Search row. Opening a result records the true previous title/URL. iOS chevron plus title, Android arrow; Places shares that row. Existing header content, actions and tabs policy stay. |
| Dedicated Search and gallery row | New `search/`, all four platforms and both themes, grouped Chats / Things / Settings / Places, typed matching, correct named result destinations and query return. Its complete per-line ledger is in `search/NOTES.md`. Examples are authored queries; matches come from shared story records and existing Settings/Places labels. |
| Feedback / Settled spacing | Authored geometry: 8px gaps in the phone Chat actions, with header growth to retain targets. Largest-text overflow rule stays. |
| Weekdays at 18:00 and deterministic 24-hour entry | Existing `EVENING_BRIEF.schedule` from native `brief.ts` at `5cf15c134`, already selected by `settings/schedule.js`. `STORY.md` and `story.js.briefSchedule` now agree. The field accepts HH:mm and cannot redraw as 06:00 PM. No November brief content is imported. |
| Settled without a zero badge | Existing Inbox `data-settled-count`; only its zero is suppressed. The disclosure and chevron stay, and a genuine nonzero value returns. |
| Distinct Settings row symbols | Existing labels select clock, bell, theme, person, assistant, box, screens and sliders in the shared line-icon vocabulary. No new colour or logo system. |
| Different Chat dots | Current pve-02 health stays amber `warn`; Waiting for you uses blue `chart1`. The real thread flag and health accessible name stay independent. Red remains for Not working; brand art is retained as supplied. |
| Regenerated affected pictures | All existing final renderers use current shared shell: normal desktop pages, native pushes, open Places, state/detail atlases and largest-text pictures, both themes. Existing before pictures remain intact. No source change in another owner’s screen folder. |

The shared shell keeps the primary nine-place order and the existing five native tabs. Native pushed screens use a single Back row; Search remains reachable through Places there. Shortcuts after Settings add existing things without inventing a sixth tab. Other chat roots and connections without a final detail drawing use correctly named metadata previews; the current full thread/schedule drawings demonstrate opening a result. Full native implementation is still a gap.

Before editing, **120 existing-screen/shell/gallery PNGs** were captured in `.whombat/shots/round-four/` at matching platform sizes, themes and states. `.whombat/` is excluded locally. There was no prior dedicated Search to capture. After pictures repeat the same 120 scenes; new Search examples are additional design evidence. The shared preview rejected local files with **“Invalid preview URL (unsupported-protocol: file:)”**; the tab was closed and local Chromium rendered the files without a server. Existing installed rendering dependencies were reused; no service, container or database was created, so no service rebuild/restart applies.

No lint, typecheck, tests, CI, build gate or waiting for PR checks: the explicit task instruction **NO CI** controls this mockup-only delivery. PNG production, contrast and geometry observations are recorded locally and in Search’s render evidence. No real phone, gesture, keyboard or accessibility-session verdict is claimed.

Current-main refresh: fetched and fast-forwarded to **c2d995103** before the final full render. That main revision removes runtime briefs, including the original native `brief.ts`. This task explicitly retains the already-drawn Evening brief setting at 18:00, so its source is pinned to **5cf15c134:apps/mobile/src/fixtures/brief.ts**, with the selected schedule still in `settings/schedule.js`. The mockup does not restore or change runtime briefs.


Final rendering evidence: all six existing/final render commands completed on the refreshed main, producing **1,022 design observations** across normal, state, detail and largest-text scenes. The shared summary is `shell.observations.json`; it preserves per-family minima without rewriting another screen owner’s render metadata. Sampled visible text minima are **4.641:1 light / 4.904:1 dark** overall; Search itself is **4.942:1 / 5.515:1**. No sampled text pair fell below 4.5:1; no page error or document overflow was recorded. Search reports no undersized visible controls, including largest text. These are design observations, not test-suite results.

Both sets of **120 matching captures** were sent to each supplied address in order: **240 pictures, 720 attempts, zero accepted**. HTTPS failed hostname resolution. The HTTP addresses returned **500 / 503 / 429** for the before set and **429** for the after set. No after response supplied numbered change areas, so no numbered notes could be posted. `shell.delivery.json` records the outcomes; the complete captures and individual attempts remain under ignored `.whombat/shots/round-four/`. The requested PNGs are committed independently of that service failure.
