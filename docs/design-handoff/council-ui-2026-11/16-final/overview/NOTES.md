# Overview · round four

[Review all scenes](index.html) · [Drawing](mockup.html) · [Binding shell](../SHELL.md) · [Binding story](../STORY.md)

Mockups only. This round edits only `16-final/overview/`, `server/` and `connection/` on `delegate/overview-server-and-connection-block-bar-gzvp7-3`. The shared shell, story, gallery, app, contracts, decision documents and rounds 02–15 are unchanged. No council, CI, lint, typecheck, application build or tests were run. Rendering, colour and target measurements are the design checks.

## What changed

- The segmented block bars are back below CPU, Memory, Storage and Temperature readings, alongside the plain words. They use today's 20 blocks on desktop and 10 on phones. Native bars are neutral ink2; web bars use chart1. Unlit blocks use line2. A quiet figure does not turn the failed disk array healthy.
- Server cards show their real local Proxmox, Unraid or Debian SVG. Connections now has its final five cards, with Home Assistant, UniFi, Hetzner and Gmail SVGs; Heat pump keeps its device glyph. Each detail page keeps the same mark as its card.
- blackbox’s **Disk array failed** pill has the **Not working** red ring/dot and accessible name, matching its server page. Both alert headings use the same bad token. The visible supplied condition stays “Disk array failed”; ordinary “Running” stays neutral.
- Pinned has its actual **Power use** widget, two series, current saved figures, its Home Assistant source and existing Open in Chat / Unpin controls. The last point says **5 min ago · 14:00**, calculated from the actual point timestamp; no “Now” is drawn. Failed refresh keeps identical points and figures and says **Couldn’t refresh; showing readings from 14:00 on 23 Sept.** Retry only reads.
- Server Summary keeps Machines and Backups, the web's other existing tabs, clickable figures and **See reading history**. The improved summary does not replace those destinations.

## Shared-shell merge

Merged main’s completed shell and retained its `shell.*`, shell helpers, SHELL.md, STORY.md, story.js and final gallery index exactly. Re-rendered only Overview, server and connection. Desktop and Places now include the real-logo server/connection shortcuts; pushed native detail pages use main’s single **Back first / Places** row, with Search inside Places. This screen’s bars, marks, story readings, Pinned states and server destinations remain intact. The separate Automations rectangle in the largest-text atlas comes from main and is retained exactly.

## Every pictured line and mark: source ledger

| Visible facts / copy | Data source |
| --- | --- |
| Burrow HQ, Mara footer, Search and eight other place names/order, Chat 1, Inbox 3, phone chrome, five native tabs | Unchanged `../shell.js`, `../shell.css`, SHELL.md and `FINAL_STORY`. Inbox is the three returned records; Chat 1 is Feedback unread. The native badge colour is Dusty's explicit shell decision. |
| blackbox’s disk array failed; Your files have no protection now; Look into it; 2 other things need you | `story.inbox[0]`, its action and `story.inbox.length − 1`. Same selected failure as Inbox and server detail. Investigation is an unsent request, never a claim of repair. |
| Servers 5 / Connections 5 / Pinned 1 | STORY.md’s selected Overview scenario. Server list reads `story.servers`; five connections and the one widget come from the existing native fixture at the same frozen observation, exported locally in `fixtures.js`. |
| All five names, condition words, percentages, memory/storage amounts, temperature limits and average sublines | `story.servers[].figures/state`, unchanged. pve-02 uses `story.pve02.live/figures/server.memory`, including 18% CPU, 41 of 64 GB (64%), 23 GB free **including reclaimable cache**, storage 31.8% and CPU package 71 °C. No competing “Normal” or old fleet value. |
| Read 12 min ago / Read 2 min ago / Read 1 min ago / Reading time unknown | The **associated** `story.servers[].reportAt` against `story.frozen`, Europe/Amsterdam: blackbox 13:53, both pve servers 14:03, thetitan 14:04, the-falcon null. Each card and page reads the same object. Absolute report time/date is available to assistive technology. No shared fleet time or fetch-completion fallback. |
| Segmented bars | Today's `packages/client/src/hosts/tiles.ts` `litSegments`, 20/10 block counts; web `features/home/Connections.module.css` 7px/2px spacing; native `screens/home/ServersCard.tsx` 5px/1.5px spacing. Shares are the displayed percentage; temperature divides the saved reading by its 85 °C limit. pve-02 uses 18%, 64%, 31.8%, 71/85. Bars are decorative duplicates of the numbers. |
| Proxmox, Unraid, Debian, Home Assistant, UniFi, Hetzner, Gmail logos | Existing `packages/brand/assets/marks/*.svg`, unchanged. Server platform/system mapping comes from native `fixtures/assistant.ts` SERVERS: pve-01/02 Proxmox; blackbox Unraid; the-falcon/thetitan Debian. Connections use catalog marks; no logo is fetched or redrawn. Brand colours are the existing SVG artwork. |
| Home Assistant Needs a look, 102 integrations, 4 things need a look | Binding `story.connection` plus selected native `fixtures/thingPages.ts` Home Assistant page, the same four current problems and 102 integrations as connection detail. The incompatible Overview export's 169/171 figures are deliberately not imported. |
| Heat pump Learning; {assistant} is learning what it can do; It reads fine already | `story.inbox[2]`, STORY.md and the selected native learning fixture. No proposed changes are enabled. `{assistant}` is `FINAL_STORY.assistant`, originally resolved with `agentWords(assistantAgent().name).name`. |
| UniFi Connected, Devices 38, New 1; Hetzner Connected; Mail Connected / Used today | `createAssistantFixtures` → `home.overview.things`, exported in `fixtures.js`, at `story.frozen`. Only Mail has today's `usedAt`; yesterday's Hetzner use is not called today. Connection cards acquire no “Checked” time. |
| Power use, House / Heat pump, 0.47 / 0.71 kW, series and 14:00 final point | Native `fixtures/homeRedesign.ts` `widgets()` through the same read-only `home.overview` factory at **23 Sep 2026 14:05 Amsterdam**, exported in `fixtures.js`. All 96 original points and latest values are retained; the factory's last point is **14:00**, independently of its `updatedAt`. “5 min ago” is deliberate: “12 min ago” in the task is an example of honest elapsed time, while this supplied widget is five minutes old. No point is shifted or invented to fit that example. |
| Last 24 hours, From Home Assistant, Open in Chat, Unpin | The widget's subtitle, series/range and `fromConversationId`, plus existing widget destinations/actions. Unpin is a labelled design preview; the fixture is not mutated. |
| Loading Overview; Nothing connected yet; Nothing pinned yet; failed first read / failed refresh, saved readings, Try again, Ask {assistant}, More detail | Authored local query-state copy, not a new health verdict or persisted event. Successful empty differs from failure. Pinned empty opens Chat; first-read failure has no fake saved chart. Failed refresh retains each report/point's original time. Diagnostic scenario text stays folded. |
| Server tabs, machine rows, backups, history, technical facts and notices | [Server source ledger](../server/NOTES.md). |
| Connection page, controls, current problems and folded heads-ups | [Connection source ledger](../connection/NOTES.md). |
| Gallery selectors/captions, Design preview messages | Review apparatus, not account data. |

## Behavior and accessibility

Shared shell order, focus, Places containment/return and badge meanings remain SHELL.md. Overview reading order: heading → linked broken-item title/consequence/action → other Inbox link → three tabs → selected list/widget. Cards stay in fixture order; passive refresh does not sort, move focus or change tabs. Relative labels expose the saved absolute time. Unknown remains unknown.

Ask/Look into it prepares an **unsent** question using the helper-named assistant. Close/Escape returns to the exact opener with its scroll position. Retry reads only; it cannot resend an uncertain action. The static drawing never fabricates a successful refresh. Pinned series use both colour and a dashed second line, named legend values and an accessible chart name. Decorative logos/meters do not repeat the adjacent entity's identity in speech except the logo's useful platform name.

Targets are at least **44×44** web/iOS or **48×48** Android. Content scales to **200% web / 1.6× native**, retaining the existing cap and tab-label fitting exception. Figures stack, full labels wrap, tab strips scroll and content remains in its own scroller. Native afters are HTML drawings; real safe areas, OS back gestures, VoiceOver/TalkBack and command receipts remain implementation gaps.

## Render evidence and picture delivery

Run from the repository root: `node docs/design-handoff/council-ui-2026-11/16-final/overview/render.mjs`. `WHOMBAT_RENDER_DEPS` may point to a checkout with the existing Playwright/pngjs dependencies; all inputs and outputs still come from this worktree. The renderer touches only these three screen folders. The separate Automations rectangle in the legacy largest-text atlas is preserved byte-for-byte.

Normal PNG names remain `<platform>-<theme>.png`, desktop **1440×900**, phoneweb/iOS/Android **390×844**. States use `<platform>-<theme>-<state>.png`. Review selectors cover read states, largest text, Connections, Pinned and its failed refresh, all five server reports, Machines, Backups and reading history. Legacy state/story/expanded atlases are refreshed for existing review links.

The complete run records **416 viewport observations** in `renders.json`: no page errors, missing assets, horizontal document overflow or undersized drawn targets. Minimum sampled visible text: **Overview 4.641:1 light / 4.904:1 dark; server 4.641 / 4.904; connection 4.942 / 5.515**. All clear 4.5:1. This is design evidence, not an app test or native-accessibility certification.

Matched before/after captures are in ignored `.whombat/shots/`. The three supplied Whombat addresses were tried in order: the hostname did not resolve; both IP endpoints returned HTTP 500, “Whombat couldn’t take that picture.” No picture was accepted and no numbered areas were returned to annotate. `delivery.json` records the attempts. The PNGs remain available in these screen folders.
