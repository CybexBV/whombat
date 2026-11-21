# One fixture story for the final gallery

**Observation: Wednesday 23 September 2026, 14:05, Europe/Amsterdam** (`2026-09-23T12:05:00.000Z`). Use this on **all four platforms**. System-bar 09:41 is schematic OS chrome, not a reading time. This is a composed **fixture scenario**, never a real account, appliance or incident. Earlier rounds keep their original pictures and clocks; this document specifies the final set only.

`story.js` is the shared machine-readable snapshot, produced by `build-story.mjs` from existing read-only fixture factories and the committed rounds 13/14 fixture exports. No source fixture or application contract changes. The assistant is **{assistant}**, resolved by `agentWords(assistantAgent().name).name` (currently Neo); the person is Mara Okafor, burrow Burrow HQ. Renderers interpolate the helper result. Never type the assistant’s name into new UI copy.

This scenario takes Chat, Inbox and server detail from the native fixture world, valid web automation records and Files from the web fixture world, and the existing aggregate Usage/Vault snapshot. These are deliberately selected shared inputs, **not a claim that the separately shipped web/native demo backends already agree**. Every final screen must use these same selected inputs. No later screen may borrow a conflicting number from an earlier screenshot because it looks convenient.

## State vocabulary

| Subject / state | One final word or phrase | Boundary |
| --- | --- | --- |
| blackbox’s current server condition | **Disk array failed** | Thing-health level **Not working**; same failure in Overview, server detail, Inbox and a linked Chat discussion. No healthy disk-array cue. |
| pve-02’s current server condition | **Running warm** | Thing-health level **Needs a look**. Never “Running hot” in another screen at this report time. |
| pve-01, the-falcon, thetitan | **Running** | Connected; do not add green emphasis to every ordinary navigation row. |
| Home Assistant | **Needs a look** | Its recorded service-page problems stay problems; a successful credential check in Vault is not proof all integrations work. |
| Heat pump | **Learning** | It can read; its proposed changes still await the person. Do not say Connected / changes enabled before the recorded choice. |
| Chat thread | **Waiting for you** > **{assistant} is working** > **Handed over** > **Settled** | First true flag wins; settled requires the actual object. No flags means a real reply count/time or **No replies yet**, never a blank line or a guessed stage. |
| Unread | **New reply** (screen-reader “New replies”) | Independent `chats.unread` evidence only. A room/Feedback badge is not proof that a particular Chat thread is unread. |
| Run outcome | **Done**, **Skipped**, **Waiting for you** as the actual run fields support | A failed historical run is not a failed thread or proof an automation is off. |
| Read failure | **Couldn’t read…** / **Couldn’t refresh…** | Local neutral error block with warn-text. Never health “Not working”, never successful empty. |

## Servers and reading times

Use the same **associated report snapshot** in a server card and its page. The report times below continue round 13’s explicit existing-`lastSeen` scenarios, at the one chosen clock. They are seeded review values, not original captured-device timestamps. No fetch-completion / `generatedAt` / heartbeat / `asOf` fallback restamps a saved detail snapshot.

| Server | Reading time, Amsterdam | Relative at 14:05 | Current recorded values for the final story |
| --- | --- | --- | --- |
| blackbox | **13:53** | **Read 12 min ago** | Disk array failed; CPU **4%**, memory **31% · 9.8 of 32 GB**, storage **70% · 11 of 16 TB**, hottest **47 °C**, limit 85 °C. |
| pve-02 | **14:03** | **Read 2 min ago** | **Running warm**; processor **18% in use** (Quiet); **41 of 64 GB in use, 64%**; effective **23 GB free** including reclaimable cache (Plenty free); temperature **CPU package 71 °C**; storage meter **31.8%**, Full in about 5 months. |
| pve-01 | **14:03** | **Read 2 min ago** | Running; CPU **21%**, memory **69% · 44 of 64 GB**, storage **55% · 2.2 of 4 TB**, temperature **58 °C**. |
| thetitan | **14:04** | **Read 1 min ago** | Running; CPU **9%**, memory **48% · 61 of 128 GB**, storage **38% · 1.5 of 4 TB**, temperature **52 °C**. |
| the-falcon | **unknown** | **Reading time unknown** | Running; CPU **6%**, memory **39% · 13 of 32 GB**, storage **77% · 18 of 24 TB**, temperature **44 °C**. Never stamp 14:05 onto these values. |

**pve-02 conflict resolved:** rounds 13/15’s native fleet tile said 61 °C / 51 of 64 GB; the detailed fixture says CPU package **71 °C**, **41 of 64 GB**. Final uses the **detail values in both places**, not the fleet tile’s older/different fixture values. The chosen detail exposes `memFreeGb=14`, `zfsArcGb=9` and other cache 3; the shared dashboard’s “23 GB free” includes the reclaimable ARC. It is not 23 GB of strictly unused RAM. Avoid a second unlabeled “free” definition.

The detail’s numeric temperature formatter currently says Normal, while its actual server `statusNote` says running warm and the notice says **CPU running warm**. Final **condition words stay Running warm**; show **71 °C** for the current numeric temperature without a competing Normal pill. The notice’s exact historical explanation is **“It sat above 75 °C for 40 minutes during the backup.”** That is earlier history, not the current sensor value. Fold **4 updates available · 1 security update** as a heads-up. Do not import the web Inbox’s 86 °C-for-20-minutes claim, web fleet 75 °C or web detail’s different hardware into this story.

pve-02 identity: **Proxmox VE 9.0.10**, AMD Ryzen 7 5800X, 8 cores / 16 threads, 64 GB DDR5, address 10.100.1.12, from native `hosts.getServer`. Processor/address belong in folded technical facts, not extra Chat status copy.

Overview has **5 servers**, **5 connections**, **1 pinned item**, as in the selected native fixture scenario. Its headline names **blackbox’s disk array failed**, linked to that Inbox item, plus **2 other things need you** (three returned Inbox items minus that item). Do not copy the selected fixture’s inconsistent `summary.problems=0`, or a different web snapshot’s summary 7 over six rows. The final shell always derives the visible count from the actual `inbox` array. There is **no common sample time for all Overview content**; every server carries its own report time, and connections keep Used today / actual page checked time only. Unknown remains unknown.

## The Inbox · exactly three returned items

In this shared story, `home.overview.needsYou` returns these **three** records in this order. Sidebar, tab bar, Places, phone-web cue and Overview all show **3**. One record is actually broken, so the Inbox badge is `bad`/`btnfg`. This is the returned **Inbox list**, not a sum of every outstanding choice anywhere in Chat or Automations; those have their own supplied wait flags. Do not synthesize new Inbox rows from them or claim this count enumerates all pending cards.

| Item / source identity | Supplied facts at 14:05 | Existing way forward |
| --- | --- | --- |
| `hosts.alert:al_blackbox_md0` | **blackbox’s disk array failed**. **Your files have no protection now**. Opened **13:52**; still present in the 13:53 report. | Look into it; Remind me tomorrow. Investigation is a request, not a claim the array was fixed. |
| `approval:31` | **Restart arnica-prod-nest-01?** It needs its extra memory **4 → 8 GB**, down **about 40 seconds**. Asked **13:58**, subject pve-02. | Restart now; the existing tonight choice at **24 Sep 03:00 Amsterdam**; No; quiet Remind me tomorrow according to Inbox wording. No answer has been sent. |
| `device_skill:dvp_heatpump` | **Heat pump: what may I change?** **It reads fine already**. Asked **13:41**. | Choose, into its existing Chat card; still a proposed read-only skill until the person chooses changes. |

No failed backup, offline hallway AP, six routine Home Assistant Inbox items, or unprovided “ignored” incident is added to make the page look populated. Those belong to other earlier fixture worlds. Keep normal Inbox grouping, Settle rules, folded heads-ups and the flush Settled area; only show counts/entries actually present in the selected scenario.

## Chat and approvals · stored messages are history

All platforms use the same chronological `roots` and `threadBodies` in `story.js`. The arrival camera shows the recent waiting questions and the working firmware question; older roots remain above, rather than being deleted or priority-sorted.

| Local time | Stored root / replies and state |
| --- | --- |
| 07:00 | **Last night’s backups ran for all 12 guests.** Assistant root, zero replies, no stage flag. This is a historical message, not new proof all present-day backups are healthy. |
| 10:40 | HollowMere College asked for **Export invoices to CSV**, Acme dev #21. Two replies, request card waiting. Existing value 7 and proposed reply text remain in its payload; do not invent approval consequences or recommendations. |
| 11:30 / 11:31 | Shop login message is already blanked (**••••••**), saved to Vault as **Shop admin**. One reply; no working/settled inference. Show only saved metadata, never the submitted password. |
| 13:20 / 13:41 | The Daikin Altherma heat pump question; one reply/card, **Waiting for you**. This is the same heat-pump choice as Inbox. At 14:05 last reply is **24 min ago**. |
| 13:52 / 13:53 / 13:58 / 14:03 | **Why is pve-02 using so much memory?** Three replies, **Waiting for you**. At 13:53 the assistant said **91%**, **38 GB ZFS cache**; this remains historical prose. At 13:58 the person asked for a **16 GB** cap. At 14:03 the assistant said it takes effect after a restart and suggested tonight. The selected current 14:03 hardware reading is 64% / 41 GB, not a rewritten 91% reading. No cap or restart has happened. |
| 14:04 | **Is there new firmware for the access points?** Zero replies; `working=true`, hence **{assistant} is working**, even with no reply. No fake progress, result or promise. |

The final thread and primary approval screen use **approval 33 / `apr_zfs-cache`**, **Limit the ZFS cache on pve-02 to 16 GB**, pending since **14:03**. It is **not approval 31** (the guest restart), web 902, the Docker-cleanup approval 32 or an already accepted request. Condition: **You say yes**, not met. `whatHappens=[]`: do not add a new consequence paragraph to its approval card. The actual assistant’s historical restart sentence stays in its message. Web keeps its inline Yes, now / Yes, tonight / No; native keeps Review and answer into its full approval screen. Exact requested command is already supplied under technical facts; no command or answer runs in this mockup. Keep the existing lasting-permission confirmation separate, not a recommended answer or new undo.

There are four genuine settled records: Synology question (quiet), website login redirect (merged), yesterday’s Zonneplan question (person), NAS certificate (person). The shelf shows those records, not a success inferred from “Done”. A new reply would follow the existing reopen rules. Current Chat roots have no supplied per-thread unread evidence. Feedback has **one unread thread**; that supplies both the Chat tab’s **1** and Feedback’s **1**, without painting an unread dot on a guessed root.

## Automations and schedules

Use the **eight web automation records** exported in round 13’s `web-fixture.json` at **23 Sep 11:22**, identically on all platforms. `story.js.automations` contains their full trigger, draft and recent-run fields; this is a saved list at the 14:05 observation. Do not use the native exporter’s **24 Sep 11:46** completed run while claiming it already happened on 23 Sep.

| Automation | Actual latest run in the shared snapshot |
| --- | --- |
| Assess new issues and pull requests on whombat/billing | **#41, Done**, finished **23 Sep 11:06**; the published plan’s Waiting for you state remains separate from latest-run outcome. |
| Suspected bug | **#38, Skipped**, finished **23 Sep 10:44**. |
| Check whombat/infra | **#36, Done**, finished **22 Sep 09:03**; automation **Off** stays distinct from its last success. |
| Answer messages | No run; **Not on yet** from its draft field. |
| Assess and fix new issues on whombat/web | **#48, Waiting for you**, started **23 Sep 11:18**; `finishedAt=null`. |
| Assess new reports in Acme dev | **#49, Waiting for you**, started **23 Sep 11:00**; `finishedAt=null`. |
| Assess and fix new issues on whombat/docs | No latest run; use its existing draft/on fields, not a fabricated failure. |
| New pull requests on whombat/web | No latest run; use its existing published/on fields. |

Keep the two existing separate **Only tells you** schedules: backup one-line summary **weekdays 08:30, Active**, next **Thu 24 Sep 08:30**, 12 runs; weekly incident summary **Fridays 15:00, Paused**, 3 runs. The **Evening brief is on, weekdays at 18:00, Europe/Amsterdam**, from `5cf15c134:apps/mobile/src/fixtures/brief.ts` → `EVENING_BRIEF.schedule`, the same selected schedule as `settings/schedule.js`. Only that schedule is imported; the brief’s November date, person, content and run history are not. It is an assistant setting, separate from these two automation schedules. Search finds **Evening brief · Weekdays at 18:00 · Amsterdam** and opens its existing Settings page.

## Connection, controls and Settings

Home Assistant’s **con_ha** native service scenario from step 15 is the connection page: **Needs a look**, with its actual current problems and **5 heads-ups folded**. Controls use `homeAssistantControls()` from `packages/fixtures/src/servicePages.ts`: ceiling light **On · 80%**, floor lamp **Off**, Movie night, thermostat **20.8 °C now · heating / target 21.5 °C**, hall light **On**, front door **Locked**. Unlock retains its existing confirmation. The control values are fixture state, not a new reading at 14:05; no checked timestamp is added without a bound field. Do not copy the web connection’s different host/integration counts or step 10’s six heads-ups into this chosen connection.

Settings keeps Mara in **You**, the helper-named assistant, **This Whombat**, **Screens**, **Advanced**, and the actual Theme setting. Files, Vault and Usage use the canonical Places home, not three extra differently ordered Settings shortcuts. The evening-brief schedule above is the sole selected brief setting. No quota, account state, cap increase or unsupported version update is invented. Native version 3.73.0 / 3073000, if pictured, is step 08’s fixture build metadata, never a claim about the latest application release.

## Files, Vault and Usage

**Files:** the existing populated **web Files scenario**, explicitly reused across all four final platforms. The native backend’s missing `files.summary` remains an implementation gap, not permission to draw a failed Files list as if the shared story had no files. Spaces are **feat/invoice-pdf · 4 files · 136 MB · last added 23 Sep 11:20** and **Chat · 3 files · 488 bytes · last added 23 Sep 11:04**. Inside the former: **Drawings** (two files), **invoice-pdf-brief.pdf**, **invoices-q3.csv**. Metadata comes from `apps/web/src/app/filesFixtures.ts` and step 14’s committed export/drawing, not arbitrary document names. The two backend Chat IDs are source-specific; the shared displayed space name is Chat.

**Vault:** step 14’s four existing metadata records: **Grafana** (reached, last used 09:12), **Home Assistant** (reached, last used 10:48), **Printer admin** (failing: password rejected), **Weather API key** (unchecked / assistant off). Add only the existing **Shop admin** saved-record metadata named by the 11:31 Chat message (`vlt_shop`), so Chat’s Saved to your Vault destination exists in this composed scenario. Its saved record supplies name/kind/id; no secret, check result, use time, username or provider is inferred. Entries stay closed. A successful Home Assistant sign-in check does not settle its integration problem. No separate lock, secret reveal, clipboard-clear timer or copied-secret illustration is introduced.

**Usage:** exactly `spend.overview` from step 14, **prepared 23 Sep 2026 11:22 Amsterdam**. The observation is 14:05; **the numbers are still prepared at 11:22**. Do not restamp them 14:05. All providers reporting here are combined; no provider identity/dimension or quota is available. Display **USD**, not an invented euro conversion.

| Window, Europe/Amsterdam | Finished turns | Tokens (input + output) | Reported cost | Turns with no usage report |
| --- | ---: | ---: | ---: | ---: |
| Today · 23 Sep 00:00–11:22 | 5 | **92,580** | **$0.37 USD** | 0 |
| Last 7 days · 16 Sep 11:22–23 Sep 11:22 | 46 | **1,195,945** | **$4.62 USD** | 1 |
| Last 30 days · 24 Aug 11:22–23 Sep 11:22 | 177 | **4,663,485** | **$17.97 USD** | 2 |

Invoice PDF export is the only supplied plan total: **3,314,805 tokens**, recorded plan-linked use, not the whole account or an inferred provider bill. Missing usage is not zero use; costs are estimates for turns with cost reports. No per-provider breakdown or named-provider claim appears in the main design.

## Read-state scenes are alternatives

Loading: first read has no result; no fabricated count/content for that scope. Empty: successful zero result, never a failed read. Failed first read: **“Couldn’t read your Chat.” / “There’s no saved copy to show on this device yet.”** Failed refresh: **“Couldn’t refresh your Chat.” / “Showing the messages already on this device.”**, with the saved timeline in its original order. **Try again** reads only; **Ask {assistant}** prepares an unsent question; diagnostic details stay folded. These are local client query-state specimens, not simultaneous changes to the shared normal story or new real outages. Shell counts remain the independently known Inbox / Feedback result. No uncertain command is retried as though it were a read.

## Source precedence for later parts

1. `story.js` and the exact field/source selections above govern final pictures.
2. Shared existing client/core formatters govern semantics and supplied facts; use the kept decision documents for behavior.
3. Earlier steps supply anatomy and before evidence. They do **not** override a conflict explicitly resolved here.
4. An absent field stays absent/unknown in the main design. Record a real remaining gap in the screen’s NOTES; do not invent a new incident, fresh timestamp, consequence, model/provider attribution or approval recommendation.


## Search and the real-logo shortcuts

`story.js.shellThings` keeps the fixture identities from native `assistant.ts` → `SERVERS` / `otherThings`: blackbox → Unraid, pve-02 and pve-01 → Proxmox VE, the-falcon and thetitan → Debian; Home Assistant, Heat pump, UniFi, Hetzner and Mail. The real SVG marks come from `packages/brand/assets/marks`; `unifi` resolves to `unifi_network`, `google_mail` to `gmail`. Heat pump is a device without a supplied brand mark and keeps its thermometer, never a generic server. These identity/logo selections do not change condition words, reading times or the selected five-item count.

Search indexes the selected `threads`, `servers`, `shellThings`, the Evening brief schedule, existing Notifications / Theme setting labels and the canonical Places list. Result groups are **Chats · Things · Settings · Places**. The default drawing’s **pve** is an authored query example; **Evening brief**, **Files**, **e** and **garden shed** are additional query examples, not saved searches or account data. Matching uses words from the name and shown description. It never manufactures a chat or infers a service condition. There is no AI answer or answer-derived search result.

An empty query asks what to look for, a pending read says Searching, and a completed query with no matches says No results. Those are separate alternative scenes. Search result navigation keeps the query and its origin; native Back names **Search** on the opened result and the prior top-level page on Search itself. The final pve-02 thread and Evening brief are the full existing drawings; connections without a final detail drawing and other chat roots open named, read-only destination previews using their own selected metadata, never a different thing’s page. This is a mockup navigation boundary, not a new application route contract.
