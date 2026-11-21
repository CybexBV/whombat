# Overview and server reading times · round two

Mockups only. All changes are in this new folder. No app code, tests, tokens, contracts, decisions, shared index, scoring sheet or previous step is changed. New branch: `delegate/overview-server-reading-times`, created directly from freshly fetched `origin/main`, `382f0597e`. Step 05 is already merged. No council, deployment or native device was started.

Read the notes and evidence in steps 01–10 and [SCORING.md](../SCORING.md), the design handoff README, current UI refresh and phone refresh decisions, quiet-notices, needs-you-list, handle-it and command-safety. This continues 05’s error treatment and uses 08’s actual native captures, rather than repeating 05’s missing-native-before claim. It keeps 07’s native text cap and 10’s readable warning text. No future design or built-app score is awarded.

## What changed, by app

| App | Change |
| --- | --- |
| Desktop web | Every Overview **server** card shows its report time before the figures. The server page shows the same kind of reading line above the figures. Both have a real “Reading time unknown” example. |
| Phone-width web | Overview, pve-02 and Automations at 390×844, with the drawer closed and no desktop sidebar. Overview puts the reading time above the figures so the first card’s freshness is visible on arrival. Loading, saved-data read failure and successful empty states have full page layouts. |
| Native iOS and Android | The same three screens and state families, using native fixture values at their own 14:05 moment. Server cards keep the compact native four-figure row, then the machine count and reading time. The server page retains platform back conventions. Android actions are 48dp; the iOS badge follows Dusty’s token-colour decision. |

Open [index.html](index.html) for before/after selections. [mockup.html](mockup.html) is the static drawing. Main states are `normal`, `read`, `loading`, `empty`, `unknown`, `refreshing`, and `no-copy`; pve-02 also has `action`. All use existing query/receipt states and fields. Buttons describe their existing destination in a preview dialog and send nothing.

## Time provenance and limits

**The source is `HostServer.lastSeen`, not the request clock.** `packages/core/src/domain/hosts.ts` defines the nullable timestamp. `apps/server/src/hosts/map.ts`’s `toHostServer` copies the hosts service’s `card.last_seen` into it. `apps/web/src/features/home/connectionCards.ts` currently limits its `seen` line to offline servers. The new server-card line uses that field for every server, including connected ones. Uptime, Used today, a moving line and “Live · every 10 s” are not substituted for it.

The local scenarios change only this existing nullable field: blackbox’s report is 12 minutes old, pve-02 and pve-01 two, thetitan one; the-falcon has no report time. At web’s frozen 11:22 these are 11:10, 11:20, 11:21 and null. At native’s 14:05 they are 13:53, 14:03, 14:04 and null. The values themselves come from the unchanged fixtures. These are deliberately seeded review cases, not claims about a real server or the original native capture’s hidden timestamps.

On the **server page**, join the existing fleet row by the same server id. Native already reads the fleet in `ServerScreen.tsx`; web can use the existing `hosts.fleet` query. Keep the report time **with the values it describes**. The saved-read scenario retains the pve-02 value snapshot with its older 11:10 / 13:53 report, producing “Read 12 min ago” and “Showing readings from 11:10.” / “13:53.” A new independent fleet/heartbeat response must never restamp an older detail snapshot. If the timestamp cannot be associated with the retained readings, show **Reading time unknown**, including on the server page. This is a client presentation/cache requirement, not a proposed new wire field. The line describes the server report; individual chart points, backups and update checks keep their own times.

**No single sample time exists for the saved Overview.** `HomeOverview.generatedAt` is set from `services.clock()` in `apps/server/src/home/overview.ts` when assembling that response. Its server cards are separately read from `hosts.fleet`. `HostFleet.asOf` and detail `asOf` are not a safe replacement: the mapping can fall back to `now.toISOString()`. Widget `updatedAt` or the latest point describes one widget only. A query’s `dataUpdatedAt` describes cache receipt, not the sample. None supplies a common sample time for this mix of readings.

The **main** Overview error therefore says: “Couldn’t refresh Overview. Showing saved readings. Each server’s reading time is shown below.” Values stay, with their individual known/unknown times. The exact “Showing readings from 11:10” **global Overview** example appears only in the separately marked [needs-new-data variant](mockup.html?screen=overview&state=read&variant=snapshot), beside a link back to the existing-data version. Its review caption states that 11:10 is assumed. A real variant would need a defined snapshot/sample-time field and its scope; fetch completion must not populate it. No absent-data fact enters the main design.

Connection cards retain **UIR-17**: only their existing Used today/usedAt foot, omitted when never used. They get no Checked or Read timestamp. The Overview Connections tab’s preview explicitly states this boundary. No connection freshness field is invented.

## Decisions kept and Dusty’s round-two choices

- **Reopens AP-6412 - decided by Dusty for John's review.** iOS’s badge uses the same readable token foreground/background approach as Android, replacing the system-red colour in 08’s before evidence. Numeric badge content still comes from the fixture. It is in the main drawing, not an undecided variant.
- Web has the decided visible **Search** link; no search box is added, so AP-2274 remains intact. The sidebar/drawer also shows **Usage** outside Advanced. These are shared navigation context, following 06/10 and Dusty’s update, not additional destinations implemented here.
- Android recovery, back, composer, folds, tabs and actions have **48dp** minimum targets. iOS keeps 44pt. The static drawings express those units as CSS pixels; actual native measurements remain an implementation task.
- The native text cap stays **1.6×**. A raised cap, recommended answers, new consequences and undo promises on approvals are not introduced. No approval is drawn here.
- Automations keeps its existing On/Off, separate run bars, Last run/Next run wording and list destinations. AP-6330/AP-6380/AP-1093 are **not reopened** by this task. No historical failed run is called “Not working”; step 05’s optional colour change is not silently promoted. Off/draft words remain readable opaque muted text.
- Thing health, Inbox’s ownership of Needs you, folded heads-ups, Settle and thread-stage flags are unchanged. No new stage or “failed” flag is added. The ordinary read error is amber and local; it does not make a server red. The existing blackbox failure retains its actual health cue.

## Loading, empty and error behavior

Loading uses shapes from the actual page: server-card figures on Overview, a metric strip and lower panel on pve-02, and automation rows on Automations. Skeletons are hidden from accessibility; there is one named loading status. They appear only on a first load, not instead of retained values during a refresh.

Empty means a **successful** zero/no-first-report result. Overview says what will appear and offers Add a connection; pve-02 says its readings will appear after its first report and offers Ask {assistant}; Automations explains the plan-in-Chat path and offers Describe an automation. It never calls a failed read an empty list or fills absent readings with zeroes. The native successful-empty Automations scenario assumes both the automation and schedule lists are empty. A failure of only `automations.list` keeps the separately supplied schedules below the retained list.

The failed-read block names the scope and what is shown instead. Try again repeats only that **read**; Ask {assistant} opens its existing conversation. Diagnostics start folded under More detail. Overview shows the block even when its query still has cached data. Refreshing is a separate quiet state and retains the data/order. No-copy says there is no saved copy and draws no phantom metrics or healthy pill.

The server `action` specimen keeps command-safety’s uncertain outcome: **“The restart may have happened.”** It explains the missing answer and offers only **Ask {assistant} to check**, followed by folded detail. It has no blind Try again and no “nothing is lost” assurance. Checking is not another restart; if checking remains inconclusive, uncertainty remains. Definite not-executed and completed/redacted outcomes retain the separate treatments documented in 05 and CS-04b/CS-05/CS-12/RRB-03. This task does not add or execute a restart control.

## Every pictured line and mark: sources

`fixture.js` is generated by read-only fixture factories/shared formatters and the captured public web inputs. It uses **`agentWords(theAgentOf(bootstrap.principals)?.name).name`** on web and **`agentWords(assistantAgent().name).name`** on native. Templates interpolate that captured helper value; no assistant name is hard-coded in the renderer. All times are frozen and all data is fixture-only.

| Pictured family | Data/source and scope |
| --- | --- |
| Burrow HQ, Mara Okafor, navigation/server names, Settings, existing badge and title context | Web fixture bootstrap in `oneFixtures.ts`, the newly captured before PNGs and `before.json`; native canonical titles/tab names from `RootNavigator.tsx`, `GlassTabs.tsx`/TabBar and 08’s captures/trees. Generic line icons and simplified sidebar are drawing scaffolding, not a proposed logo or shell redesign. |
| Search, Files, Vault, Usage and drawer destinations | Existing routes/navigation, 06/10’s proposals and Dusty’s explicit shared navigation decisions. Drawer closed initially. The drawer/destination dialog is review apparatus, not a new product message or a write. |
| Overview title, blackbox headline, remaining-things count and Inbox count | Web `home.overview.summary` from `oneFixtures.ts`; native `createAssistantFixtures().handle('home.overview')`. Remaining count = needsYou − 1. Native Chat’s one unread badge is the fixture’s captured 08 tab context, not a new count. |
| Servers 5, Connections 5, Pinned 1; server names, OS/uptime, CPU descriptions, metric values/units/subtitles, machine counts, health words | Web `hostsFixtures.ts`/client `createHostsFixtures`; native `assistant.ts`’s `SERVERS`/`hostServer`; shared web `serverCard`/`serverTiles` copied into `fixture.js.cards`. Counts use this fixture’s actual lists. Server card status remains Running/Disk array failed/Running hot or warm as its shipped source supplies, not a new health scale. |
| Read 1/2/12 min ago; Reading time unknown; exact report time in time’s accessible name | Explicit existing-field `lastSeen` scenarios above, the frozen per-platform clock, en-GB / Europe/Amsterdam. `build-data.mjs` records sampleAt as a **drawing alias of lastSeen**, not a new contract. `state=unknown` additionally sets pve-02’s local report time to null. |
| pve-02 identity, Running warm, Summary/Machines/Backups, Ask and More; Technical details OS/processor/address | Existing server detail and heads, `serverDashboardHead`, `ServerPage.tsx`/`ServerScreen.tsx`; actual `server.os/cpu/address`. The separate reading line uses the associated fleet record, not `lastSyncSAgo` or `asOf`. |
| Quiet, Plenty free, Normal; 18% in use, 23 GB free, forecast and CPU package reading; actual sparklines/meter | Shared `serverDashboardView` on the fixture `HostServerDetail` and `hosts.serverMetrics`; `dashboard.panels` in `fixture.js`. Curves are generated from its sampled series, not arbitrary new trends. The storage meter uses its actual `meter` share. |
| Worth a look, CPU running warm, heads-up titles/details/count, Busiest machines, names/CPU/memory and running count | Shared `serverDashboardView` notices/table panels. `nature==='fyi'` goes into the closed heads-up fold; existing current problem stays outside. Web fixture has three heads-ups, native one plus its current warm-CPU problem. No cross-platform count or metric is borrowed. |
| Automations heading/intro/composer; complete names, triggers, On/Off/Waiting for you/Not on yet, last/next words, bars and accessible row labels | Web `automationFixtures.ts`; native `createAutomationFixtures` in `fixtures/automations.ts`; shared `automationListRows`, `automationState`, `runBarsLabel`. Web has eight automations, native three. The normal fixtures are unchanged; no invented failed run, next time or list switch. |
| Only tells you, native schedule prompts, times/states and Pause/Resume/Remove | `createParityFixtures().handle('schedules.list')` plus `onlyTellsYouRows`/`scheduleRows`, native `data/automations.ts` and `data/schedules.ts`. Actions are destination-only previews, not successful action receipts. |
| Loading…, empty guidance, Couldn’t read/refresh, saved/no-copy explanation, Refreshing, Try again, More detail | Authored local presentation selected from existing query status/data/isRefetching, operation scope and successful list/report absence; continues 05. Static interface labels are not new server facts. |
| Action uncertainty and diagnostic; “The fixture read did not answer.” | Explicit review receipt/read scenarios, command-safety and RRB-03. Raw diagnostic strings are visible only under More detail. No real command or read failure occurred. |
| Exact **global Overview** 11:10 line | **Needs new data**, only in `variant=snapshot`; visibly labelled, never inferred from generatedAt/asOf/dataUpdatedAt. Server-page 11:10 has a separate existing lastSeen source and is not this global claim. |
| 09:41 and status-bar shapes | 08’s normalized native OS chrome; not the sample clock or an actual network/battery measurement. |
| Gallery captions, selector labels, GAP statements, contact-sheet labels and preview dialog text | Authored review apparatus, outside the proposed product facts. |

## Accessibility, focus and expansion

**Reading order:** page identity → local failure/loading state and recovery → retained readings/list. Overview server card: name/status/OS → hardware on web → report time → figures → machine count; native keeps its compact figures and count before the report line. The report is included in each figure’s accessible name. Server page: Back → name/status/actions → reading time → tabs → error → figures → current notices/fold → machines → Technical details. Automations: title/intro → existing composer → failure/loading/empty or list → separate native schedules → tabs. A page’s reading line is not a recurring live announcement.

**Names:** “Open pve-02”; “Try reading Overview again”; “Back to Overview”; “More for pve-02”; a time says “Read 2 min ago. 23 September 2026, 11:20, Europe/Amsterdam.” Unknown says exactly Reading time unknown. Each automation retains the shared complete accessibility label and spoken run counts; its decorative bars are hidden. Inbox’s accessible name includes the existing count. Decorative clocks/source icons and skeletons are hidden; the adjacent words carry meaning. In the implementation, native cards should expose the report time in their existing combined row name, not as a duplicate stop for every decorative element.

**Focus:** DOM order matches the visual sequence. New web recovery/fold/drawer controls have visible token focus rings. Retry leaves focus on itself while a polite Refreshing status is announced once; when a successful read removes that control, focus moves to the recovered section heading. More detail and heads-ups expand in place, keeping focus on their summary. Ask opens the existing conversation with a recorded origin; Back returns to the same control and scroll position. The review dialog has a real Close/Back button, native modal focus trapping and Escape dismissal; close returns to its opener. Drawer preview starts closed, exposes its expanded state and returns to its menu button. Actual native VoiceOver/TalkBack, edge/predictive-back and keyboard behavior are not certified by HTML.

**Targets:** web phone recovery/buttons/menu/tabs are at least 44 CSS px; native iOS 44pt, Android 48dp, represented at scale 1. Whole automation rows and metric tiles are large targets. Targets grow with wrapped text; nothing is made smaller to fit. Reading times, pills and bars are not independent tap targets. Desktop sidebar sizing is context, not a claim that all of the existing app’s desktop controls changed.

**Expanded behavior:** diagnostics wrap below the same recovery controls, never exposing a repeat action. Heads-ups open their existing fixture lines and destinations, below the current problem. Technical details starts closed and carries OS/processor/address and the same scoped reading time. No global timestamp is smuggled into this fold. The static destination dialog explains navigation and sends nothing. No new confirmation, standing permission or automatic retry is added.

**Largest text:** the PNG sheets’ final row is actual **200% root text on phone web** and **1.6× on native**, retaining 07’s effective cap. Figures/actions stack, long labels wrap, tabs scroll within their own row and the content remains vertically scrollable. The native footer’s system-size labels are schematic chrome; at large text it participates in document flow so it does not cover the drawing. The cap is not raised. HTML does not establish maximum OS text rasterization, safe areas, keyboard avoidance, native hit slop or assistive-technology focus; these remain implementation GAPs. No approval facts are drawn or removed.

**No reorder under a finger:** the snapshot uses the existing initial worst-first server order, held for the whole view. There are no timers, polling, sorting on age, automatic arrivals or actual mutations. New readings update the same card in place, preserving focus/scroll. Explicit refresh may accept the next order; returning from a server restores the originating card/position, per AP-7454. Expanding a fold adds content below its opener.

## Pictures and sampled WCAG contrast

Before: `capture-before.mjs` uses the unmodified latest-main web app with `VITE_FIXTURES=1`, hosts/dashboards/files/automations fixture switches, `tools/visual`’s `openApp`/`settle`, Playwright Chromium, bundled fonts and frozen 23 September 2026 **11:22 Europe/Amsterdam**. Twelve normal pictures cover all three pages at 1440×900 and 390×844, light/dark; six phone pictures also capture an existing-query failed read with its data retained. Scenario injection changes only cached fixture inputs, not app source. The drawer remains closed.

Native before images link to 08’s genuine fixture-only iOS/Android captures at 390×844 and 14:05. App/native UI source is unchanged between that capture and this main revision. No shared simulator or real data was opened. **GAP:** same-state native loading/error/empty screenshots, and same-state web loading/empty screenshots, are not captured here. The viewer labels that gap; a normal picture is explicitly context, not evidence of that state. Desktop saved-read before also uses clearly labelled normal context; the phone failed-read evidence is captured.

After: four 1440×900 desktop PNGs and six contact sheets, for **28 PNGs total including the 18 before images**. Each sheet has three separate 390×844 phone viewports per row (Overview, server, Automations) and five rows (normal, failed read, loading, empty, largest text). The 1250×4515 sheet is review apparatus, not a claim of a 1250px phone screen. Native afters are HTML drawings, not native-app screenshots. Individual viewport exports also remain in the locally ignored `.whombat/shots/round2/`. PNG encoding is lossless; an attempted recompression found no smaller lossless representation with the installed encoder.

`render.json` records 94 render/color observations, with no application test runner. The scan uses 01’s WCAG sRGB calculation over rendered text and composited solid backgrounds, at the top and bottom. Badges and controls have separate measured color pairs, including the badges hidden from the text-tree sampler. Minimums remain above 4.5:1, including small words and controls:

| Observed pair / minimum | Light | Dark |
| --- | ---: | ---: |
| Sampled visible text | **4.641:1** | **4.904:1** |
| Sampled control text / meaningful control foreground | **4.641:1** | **5.515:1** |
| Inbox token badge, bg text on bad | **5.190:1** | **7.803:1** |
| Chat badge, bg text on ink | **15.888:1** | **14.891:1** |

This is nominal rendered-HTML color sampling, not every antialiased pixel or native WCAG certification. Gradients/images/OS chrome and non-text border geometry are excluded; the drawings add no new gradient-backed text. Focus rings and touch sizes are handoff requirements. Colors, type, radii and shadows use the real token/font stylesheets via 05’s stylesheet; no token or hard-coded component colour is added. Visual inspection found the report time visible on the first phone-web card and the native compact card, with retained values still in place.

## Reproduction, skipped checks and baselines

From the repository root, Node 24, use free local ports:

```sh
VITE_FIXTURES=1 VITE_FIXTURE_HOSTS=1 VITE_FIXTURE_DASHBOARDS=1 VITE_FIXTURE_FILES=1 VITE_FIXTURE_AUTOMATIONS=1 pnpm --filter @whombat/web exec vite --host 127.0.0.1 --port 5283 --strictPort
python3 -m http.server 5383 --bind 127.0.0.1
node --import tsx docs/design-handoff/council-ui-2026-11/13-overview-server/capture-before.mjs
node --import tsx docs/design-handoff/council-ui-2026-11/13-overview-server/build-data.mjs
node docs/design-handoff/council-ui-2026-11/13-overview-server/render.mjs
```

The first two commands run in separate terminals. `CAPTURE_URL`/`REVIEW_URL` allow other free ports. The helper’s temporary bundled module is confined to ignored `.whombat/`. Browser instances close in finally. The task’s two local preview servers and its T3 browser tab are closed before handoff. No container, VM, lease, native device or persistent service was created or changed; no app/dev-service rebuild is needed for these documents.

**John explicitly requested skipping CI, lint, typecheck, notices, all tests and waiting for PR checks. None is run for this round.** PNG rendering, fixture snapshots and the required contrast measurements are design production work, not a claimed passing test suite. The PR records this and is handed back without monitoring checks.

No existing baseline is changed. An implementation would need focused additions to `home-redesign/proposed.html`, `connections/server-cards.html` and `dashboards/index.html`, plus phone-width fixture pictures. Shared error/loading/empty component references in **Whombat Desktop.dc.html** and **Whombat Mobile.dc.html** would need their new states; those old mocks are not direct baselines for every modern Overview/Automations screen. Native report-time/badge/state baselines must come from fixture-only native builds after implementation. 08’s current evidence and the scoring sheet remain intact.

## Picture delivery

`delivery.json` records 44 attempted normal before/after pictures with distinct round-two view names. HTTPS cannot resolve. The first HTTP fallback accepted **five complete pairs**: both desktop screens in both themes, plus phone-web Overview in light. Their numbered areas all received short plain-language notes, which were accepted. The other **34 images** were rejected by both HTTP fallbacks with HTTP 500. No missing numbered notes are invented. All images remain in this folder or the referenced native evidence, with individual after exports under ignored `.whombat/shots/round2/`.
