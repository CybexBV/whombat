# Final server · one associated report

[Before/after and states](index.html) · [static page](mockup.html) · [binding story](../STORY.md). Shared scope, all-shell provenance, render inventory, measurement method, focus/touch rules, Dusty decision labels and limitations are in [Overview’s common handoff](../overview/NOTES.md). Applies to **desktop web, phone web, native iOS and Android**, light and dark. Mockups only; no CI/lint/typecheck/notices/tests or PR-check waiting.

The main server is **pve-02**, the same 14:03 report used by Overview at 14:05. It says **Running warm**, CPU package **71 °C**, processor **Quiet / 18% in use**, memory **Plenty free / 23 GB free including reclaimable cache / 41 of 64 GB in use · 64%**, storage **Plenty free / Full in about 5 months / 31.8% in use**. There is no Temperature: Normal tile. The warm notice’s 75 °C is clearly historical prose, not a competing current reading.

The blackbox scene shows **Disk array failed**, the same consequence and investigation action as the Inbox/Overview, **Read 12 min ago**, and the same figures. The-falcon scene keeps **Reading time unknown**. No healthy disk-array label, different pve-02 condition or guessed reading time is introduced.

## Round four changes

The real Proxmox, Unraid or Debian mark returns in the page head, matching Overview. All four figures retain their plain words and story values, with today's segmented block bars underneath: 20 blocks on desktop, 10 on phones, lit from the actual saved percentages / sensor limit. blackbox’s Not working ring/dot and “Disk array failed” condition are red; its alert heading and Overview’s linked heading use the same `bad` token.

Summary keeps **Machines** and **Backups**, plus the web's **Storage, Sensors and System** tabs. Native keeps its existing platform-specific tabs (Unraid: Array / Apps / Plugins). Each figure opens its existing history or storage destination; **See reading history** is explicit. The iOS back control is a chevron with “Overview”; Android keeps its 48dp arrow. The parent shell/story and app code remain untouched.

| New pictured line / mark | Source |
| --- | --- |
| Platform/OS logos and segmented meters | Existing local SVGs and current app meter geometry, detailed in [Overview's ledger](../overview/NOTES.md). Readings stay `FINAL_STORY.servers` / `pve02`, not a separate source. |
| Summary / Machines / Storage / Sensors / Backups / System; native equivalents | Current web server page and `apps/mobile/src/screens/ServerScreen.tsx`, `data/serverSummary.ts`. These destinations surround the summary instead of disappearing. |
| Machines tab names | Read-only native `createAssistantFixtures` → `hosts.listGuests?server=pve-02`, exported in `../overview/fixtures.js`. No new guest count, status, restart result or hardware figure is inferred. Temporary machine names remain hidden. Links preview existing machine pages. |
| Backups: No backup plan covers this server yet | Round 13's **native** dashboard `backups.empty`, exported in the local supplement. Do not borrow the different web snapshot's “14 of 14 backed up”. Other servers retain their existing destination without asserting pve-02's backup state. |
| CPU / Memory / Temperature reading history | Round 13's native dashboard chart panels, unchanged points/timestamps in `../overview/fixtures.js`. The latest history point is 14:00 (5 min ago), distinct from the 14:03 associated current report above it. No “Now”, point restamping or fabricated history for another server. |
| See reading history; links on figures; local destination-preview copy | Authored labels for existing chart/storage/tab destinations. These HTML drawings execute no server action. |

## Every pictured line

| Lines | Source |
| --- | --- |
| Server title, condition, reading label and figures for each selected server | `FINAL_STORY.servers`, `pve02.state/readingAt/figures/live/server`; all values and their associated report times are enumerated in the common source ledger. This page and Overview read the same objects. |
| CPU running warm; It sat above 75 °C for 40 minutes during the backup.; Ask {assistant} | `story.pve02.notices[0]` title/detail/link.question. Its name comes from `story.assistant`’s helper export. No current 86 °C / 20-minute or “running hot” web scenario is borrowed. |
| 4 updates available · 1 security update; See updates; Show 1 heads-up | `story.pve02.notices[1]`, nature fyi; count is one supplied informational notice. It starts folded, keeps its existing updates destination and never changes current health. |
| Proxmox VE 9.0.10; AMD Ryzen 7 5800X; 8 cores / 16 threads; 64 GB DDR5; 10.100.1.12 | `story.pve02.server.os/cpu/memory/address`, from the selected native `hosts.getServer`. All are in Technical facts, not extra top-level status prose. |
| Why is pve-02 using so much memory?; Waiting for you; Chat link | `story.roots` / `story.threads` for `msg_chat-memory`, waiting flag. Link returns to the Chat timeline’s existing question. This does not rewrite the stored 13:53 91%/38 GB message or imply the 16 GB cap/restart happened. |
| blackbox’s disk array failed; Your files have no protection now; Look into it | `story.inbox[0]` and corresponding `story.servers` report. Same failure/consequence/action as Overview and Inbox; no unsupported diagnosis, fix or command is drawn. |
| Couldn’t refresh pve-02’s readings; Showing readings from 14:03 on 23 Sep; equivalent blackbox 13:53 | Known saved query + the **selected server’s own associated reportAt**. Unknown report time instead says the saved readings’ time is unknown; it never falls back to pve-02’s time or the fetch time. |
| No readings yet; readings appear after first report; Ask {assistant}; Loading readings…; no saved copy; recovery labels | Local first-read/successful-no-first-report/error state presentation, not a host-health verdict or a fabricated zero reading. More detail contains authored diagnostic scenario copy only. |
| Back/Overview, Ask, Technical facts, figure labels, gallery/preview text | Existing page destinations and authored presentation labels. Real local platform marks are identified in the round-four ledger; shared shell data/authority are in the common ledger. |

## Accessibility and behavior

Order: shared chrome → Back to Overview → server heading/actions → condition and reading time → local read problem if any → existing server tabs → current notice and its Ask → labelled figures and segmented bars → reading history → Technical facts → folded heads-up → existing Chat question. Blackbox replaces pve-02’s notice/facts with its actual failure and corresponding readings; no pve-02 hardware is copied to it. Each figure is a named section; the temperature section says “Temperature, 71 degrees Celsius, CPU package”, without Normal. Relative time exposes its exact report date/time and timezone to assistive technology.

Native server detail is pushed from Overview: no extra tab bar is invented; Back is first in main’s single native navigation row, Places shares that row, and Search stays reachable inside Places. iOS keeps the previous-title back treatment; Android arrow is a full **48×48dp** target named **Back to Overview**. Back restores the original server row/scroll anchor. Ask prepares an unsent question, focuses it and returns to its initiating button on Close/Escape. No restart/cap is executed or offered as a blind retry. Uncertain actions must retain command-safety’s “may have happened”, offer to check, and preserve receipt uncertainty; a server read retry cannot resend a command.

Technical facts and the heads-up open in place, retain focus on the summary and preserve order. Updates and Chat are existing destinations, not new background actions. Largest text uses 200% web / kept 1.6× native; figures become one column, complete memory facts remain, and nothing is sorted on refresh. All targets are 44px/pt web/iOS or 48dp Android minimum, including the arrow, disclosures and updates action.

`png/story-{theme}.png` supplies all four platform columns for blackbox, unknown time, open facts/heads-up and saved blackbox read failure. Normal and loading/empty/two-error pictures are in the standard files/state atlas. Source/contrast measurements are in `../overview/renders.json`. Genuine step 01/08 before evidence is linked unchanged; no matching before exists for the new read states. Native after/accessibility/gestures remain GAPs, not an implementation claim.

Future baseline ownership: server dashboard/`connections/server-cards.html`, shared **Whombat Desktop.dc.html** and **Whombat Mobile.dc.html** components, native server fixture pictures. No reference or baseline is edited here.

## Recorded design measurements and delivery

Minimum sampled visible text across this screen’s platform/state/large-text drawings: **4.641:1 light / 4.904:1 dark**. Inbox badge **4.888 / 7.803**; lit Home Assistant state **10.231 / 8.816** where present. Both themes clear 4.5:1. No undersized drawn targets, page overflow or page errors were recorded. The [common render evidence](../overview/renders.json) and [measurement/delivery notes](../overview/NOTES.md#render-evidence-and-picture-delivery) give the full method, limits, RGB pairs and all 416 observations. This is not a passing app-test or native accessibility claim.

The current picture-delivery addresses were tried: the hostname failed DNS; both IP endpoints returned HTTP 500 (“Whombat couldn’t take that picture”). No numbered areas were returned to annotate. No CI, lint, typecheck, notices, tests or PR-check wait were run.
