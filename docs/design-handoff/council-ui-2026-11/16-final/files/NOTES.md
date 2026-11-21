# Files · final handoff

## Scope

These are static HTML designs for desktop web (1440×900), phone web (390×844, Places closed), iOS and Android (390×844 drawings), light and dark. They import the actual token stylesheet and bundled Bricolage Grotesque / DM Mono fonts. Native pictures are not simulator screenshots or evidence that an app change shipped.

Base: `origin/main` 8870fd7cb, with binding [SHELL.md](../SHELL.md), [STORY.md](../STORY.md) and `story.js`. The observation is **23 Sep 2026, 14:05 Europe/Amsterdam**. `story.js.assistant` comes from `agentWords(assistantAgent().name).name`; new UI interpolates it. Mara Okafor and Burrow HQ come from the same story. No new account, device, incident, health flag, quota, permission or provider attribution is invented.

The shared `shell.js`/`shell.css` are used directly. A small shared-shell **link map only** replaces the five destination previews (Settings / Vault / Files / Usage / the Search setting-match scene) with these drawings. This is the integration contemplated by SHELL’s “Later screen owners replace the corresponding preview”; no sidebar, badge, order or other owner’s screen was redrawn. The final gallery discovers the 32 normal PNGs without a gallery edit.

Primary Places order is **Search, Chat, Inbox, Overview, Automations, Files, Vault, Usage, Settings**. Files → Vault → Usage is consecutive, with one home each. No copies in Chat overflow or Advanced. Native top-level Settings keeps **Chat / Inbox / Overview / Automations / Settings** tabs. Native utility screens hide tabs and show the recorded **Back to Chat** (or actual origin); Places remains in the top chrome. The shell’s 3 Inbox items and 1 unread Feedback reply are independent of every page’s read state.

Before evidence: fresh Chromium captures of the earlier **static proposals**, saved under ignored `.whombat/shots/` before creating these final screens, then copied into `png/before-<platform>-<theme>.png`. They are not recaptured running-app evidence. The underlying shipped fixture screenshots remain in [01-groundwork](../../01-groundwork/index.html) and [08-native-capture](../../08-native-capture/index.html). Earlier proposals have earlier clocks, counts and navigation; their disagreements do not override the final story. Normal before/after use identical viewport, theme and scale. The viewer explicitly reports no matching before picture for new state / large-text scenes.

No application code, tests, tokens, contracts, decision documents or SCORING.md change. No lint, typecheck, notices, tests, CI, build or PR-check wait: John explicitly requested **NO CI**. Chromium rendering, pixel-preserving PNG compression, colour observations and a visual route walkthrough are the verification here.

One Files home, same label and order on all four platforms. Phone web fills the 390px viewport with Places closed. Native Files is a utility push with origin Back and reachable Places, without an invented sixth tab or a second Files in Chat’s actions.

## Pictured lines and sources

| Pictured line/family | Source / boundary |
| --- | --- |
| Files / intro / no-files explanation / Go to Chat | `packages/client/src/files.ts` `FILES_COPY`, existing Files anatomy. Empty is a successful zero summary. |
| **feat/invoice-pdf · 4 files · 136 MB · Last added 23 Sep 11:20** | Binding `story.js.files.spaces[0]`, selected `apps/web/src/app/filesFixtures.ts`, same scenario across all four platforms. Not a native backend success claim. |
| **Chat · 3 files · 488 bytes · Last added 23 Sep 11:04** | `story.js.files.spaces[1]`; source-specific Chat ids share this display name. |
| **Drawings · 2 files**, **invoice-pdf-brief.pdf · PDF**, **invoices-q3.csv · CSV** | `story.js.files.names`, exact selected populated web scenario. Names/type labels are present, never invented documents. Space disclosure is accessible at `?view=space&space=feat/invoice-pdf`. |
| Chat space metadata / Open Chat | The selected summary only; the final story supplies no individual Chat filenames here. The detail shows that supplied summary rather than making up three files. It is not a completed file-browser detail implementation. |
| Loading your files / Couldn’t read your files / no saved copy / Try again | Shared STORY local query-state pattern; no failed health state or successful zero on a failed read. |
| Upload / file chooser | Existing Files-space Upload action. Static control does not upload or save. Existing folder/save/download/move/remove behavior is outside this home/state drawing and must remain when implemented. |

## Expansion, accessibility and recovery

Desktop reading/focus order: Skip → Burrow HQ → nine named Places links → page heading → content in visual order. Phone web: Skip → Places → Search → “3 things need you, open Inbox” → page content. Native: Search → Places → origin Back on a utility push → content → five tabs when present. Chat’s accessible shell badge says “Chat, 1 unread reply in Feedback”; Inbox says “Inbox, 3 things need you, one is not working”. Decorative glyphs do not repeat those names.

Places is named **Places**, `aria-haspopup=dialog`, `aria-controls`, expanded state; open focuses Close Places, contains focus, scrolls at large text, and Close/Escape/scrim returns to its opener. Selecting a destination names/focuses its heading. Origin is recorded in the link; Back targets that origin. The local drawing retains a saved scroll/focus record for its own pages. **Cross-owner Chat scroll restoration, actual root-stack Back, iOS edge swipe, Android predictive Back, safe areas, keyboard avoidance and native accessibility focus remain implementation verification gaps.** No claim of OS certification is made.

Disclosures are real `details`/`summary` elements; their names and expanded state are exposed, content expands in place without moving trigger focus. Dialogs have a named heading, Close and Cancel; Escape/Close restores the opener. Blank new-secret fields never reveal a stored value, are not sent, and are cleared when closed. No clipboard function, secret reveal or timer is added. Screen state changes are explicit; there are no live timers or sorting changes under a finger. Passive shell badge updates must not move focus.

Web/iOS interactive targets are at least **44px/pt**, Android **48dp** in the drawings, including Close, rows, disclosures and fields. Largest text is **200% web** and the kept **1.6× native effective cap**; native tab labels retain SHELL’s fitting exception. Labels and buttons wrap, actions stack, fields shrink within the available width, and content/dialogs scroll instead of overlapping. No cap increase is proposed.

Measured WCAG 2.x solid text/background minimum across the 212 viewports: **4.942:1 light / 5.515:1 dark**, above 4.5:1. Per-view pairs, fonts, target geometry and overflow observations are in [render.json](../settings/render.json). No horizontal page overflow or undersized visible target was observed. The DOM method is [01-groundwork/contrast.js](../../01-groundwork/contrast.js); it omits images, scrimmed content and input values, and is not an OS accessibility audit. Blank input text uses `ink` on `sf`; the separately calculated nominal pair is **16.445:1 light / 13.657:1 dark**, in [input-contrast.json](../settings/input-contrast.json). Native rasterization, OS select menus and real screen-reader journeys remain gaps. Use `warn-text` for local read trouble; red appears only for the supplied Not working item and the shell’s real broken-item count.

Files order: recorded origin Back → Files heading/intro → conversation-space list, feat/invoice-pdf then Chat. Each whole row is named by the visible conversation, count, size and last-added time; enter opens the supplied space anatomy. Space Back names Files. Folder/file disclosures expand in place; Upload is explicit and opens a named file chooser. No new order is applied while a person touches a row. First loading/error scenes have no made-up count/list content. Try again reads **files.summary** only; opening a space reads **files.list**. Neither operation repeats an upload. Empty offers Go to Chat, not a fabricated upload target before a space exists.

## Native today-score and evidence boundary

The final normal design deliberately uses STORY’s **populated web Files fixture on every platform**. The native fixture app disables `useFilesSpace` in `apps/mobile/src/data/useFiles.ts`. In round two the explicitly permitted local uncommitted switch flip exposed a **files.summary read error**, because the native fixture backend lacks that operation. The source was restored; no switch flip, build or device change is made in this round.

The original SCORING remains **GAP N-FILES-IOS / N-FILES-ANDROID**; it is not edited. The round-two Android gate-enabled error scene’s descriptive today-score was **6.5 (7/6/4/5/6/7/8/8/6/8)**; this scores that observed error surface, not a populated list. iOS populated-content score remains GAP. See [14 NOTES](../../14-find-files/NOTES.md) for source/build evidence. Current task is static design; neither native populated success nor OS integration is certified by these PNGs.

## Glance-and-find walkthrough

The SCORING.md protocol requires an unfamiliar human participant, timing, first choice and wrong turns. **No such study was run; no timed pass or future built-app score is claimed.** These are route/content walkthrough observations, separately recorded in [walkthrough.json](../settings/walkthrough.json), repeated in both themes on all four platform drawings.

| Task | Before walkthrough / evidence | Final walkthrough / boundary |
| --- | --- | --- |
| Find Vault from fresh Chat; name an entry, keep secrets closed | Web sidebar already named Vault; native shipped capture used a different Settings/deep-link path. Earlier proposal’s homes/order differed. See SCORING and 06/09. | Desktop Chat → Vault; phone Chat → Places → Vault. **Grafana** is the first entry, with no visible secret field. Same order and spelling on all four. |
| Find evening brief time without changing it | No brief card in groundwork. 06/14 prepared an assistant question and did not reach Change time: task completion gap. | Chat → Settings → Evening brief → **Change time**, or Chat → Search → type **Evening brief** → result → schedule → **Change time**. Actual selected schedule **weekdays 18:00 Amsterdam**; editor opens with 18:00; Escape returns to Change time. No question is sent and no time changed during the walkthrough. |
| Find last run from Automations, state outcome/time, show Back | Earlier proposals had a run path but different native/web fixture snapshots; round 14 native’s next-day run cannot be treated as already finished at this story’s clock. | This part preserves the **Automations** destination, rather than drawing another owner’s page. Binding shared record: “Assess new issues and pull requests on whombat/billing”, latest **#41, Done, 23 Sep 11:06**. Its full final run/detail/back journey belongs to the Automations part and is **not independently completed here**. No substituted next-day native run or fake success. |
| Five-second needs-you / action and Overview freshness tasks | Groundwork participant study unrun; server sample-time evidence incomplete there. | These four screens retain the independently known 3-item Inbox cue. Chat/Inbox/Overview/approval and sample-time participant tasks remain with their owners. Usage explicitly keeps its own 11:22 prepared time. |

The visual walkthrough also activated Settings’ Try again in the failed scene: only the local scope becomes Loading settings, while its five group names, theme, Places/sidebar and native tabs remain available. No retry repeats a command or claims a successful response.

## Baselines and delivery

Existing Files-space anatomy is the specific reference (`files-space.md`, client FILES_COPY); there is no claim that crew-era **Whombat Desktop.dc.html** has a complete matching Files-space screen. Its sidebar/list primitives and **Whombat Mobile.dc.html**’s touch/modal primitives would need a revised reference/baseline when implemented. Add fixture Files home and read-state baselines at 1440 and 390, both themes; do not raise diff budgets or mask the new navigation. No reference/baseline changed here.

The original Whombat shot endpoint was tried for **64 normal before/after images**: HTTPS tail5e6f7 first, then 10.100.1.81 and 10.100.1.97. **0 delivered / 192 attempts** (DNS/HTTP failures); [delivery.json](../settings/delivery.json) records every attempt. No after response supplied numbered changed regions, so there were no region notes to post. All PNGs remain reviewable in this handoff; failed delivery did not block the PR.
