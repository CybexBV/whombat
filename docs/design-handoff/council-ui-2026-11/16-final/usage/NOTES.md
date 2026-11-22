# Usage · final handoff

## Scope

These are static HTML designs for desktop web (1440×900), phone web (390×844, Places closed), iOS and Android (390×844 drawings), light and dark. They import the actual token stylesheet and bundled Bricolage Grotesque / DM Mono fonts. Native pictures are not simulator screenshots or evidence that an app change shipped.

Base: `origin/main` 8870fd7cb, with binding [SHELL.md](../SHELL.md), [STORY.md](../STORY.md) and `story.js`. The observation is **23 Sep 2026, 14:05 Europe/Amsterdam**. `story.js.assistant` comes from `agentWords(assistantAgent().name).name`; new UI interpolates it. Mara Okafor and Burrow HQ come from the same story. No new account, device, incident, health flag, quota, permission or provider attribution is invented.

The shared `shell.js`/`shell.css` are used directly. A small shared-shell **link map only** replaces the five destination previews (Settings / Vault / Files / Usage / the Search setting-match scene) with these drawings. This is the integration contemplated by SHELL’s “Later screen owners replace the corresponding preview”; no sidebar, badge, order or other owner’s screen was redrawn. The final gallery discovers the 32 normal PNGs without a gallery edit.

Primary Places order is **Search, Chat, Inbox, Overview, Automations, Files, Vault, Usage, Settings**. Files → Vault → Usage is consecutive, with one home each. No copies in Chat overflow or Advanced. Native top-level Settings keeps **Chat / Inbox / Overview / Automations / Settings** tabs. Native utility screens hide tabs and show the recorded **Back to Chat** (or actual origin); Places remains in the top chrome. The shell’s 3 Inbox items and 1 unread Feedback reply are independent of every page’s read state.

Before evidence: fresh Chromium captures of the earlier **static proposals**, saved under ignored `.whombat/shots/` before creating these final screens, then copied into `png/before-<platform>-<theme>.png`. They are not recaptured running-app evidence. The underlying shipped fixture screenshots remain in [01-groundwork](../../01-groundwork/index.html) and [08-native-capture](../../08-native-capture/index.html). Earlier proposals have earlier clocks, counts and navigation; their disagreements do not override the final story. Normal before/after use identical viewport, theme and scale. The viewer explicitly reports no matching before picture for new state / large-text scenes.

No application code, tests, tokens, contracts, decision documents or SCORING.md change. No lint, typecheck, notices, tests, CI, build or PR-check wait: John explicitly requested **NO CI**. Chromium rendering, pixel-preserving PNG compression, colour observations and a visual route walkthrough are the verification here.

One page named **Usage**, using the existing Spend destination (`/settings?tab=advanced&part=spend`), not the old `tab=usage` AI-sign-in alias. Its only home is Places; no second Spend/Advanced shortcut. It leads with plain cost and the number of times the assistant worked. Provider coverage is inside **More**, never a misleading selected-provider heading.

## Pictured lines and sources

| Pictured line/family | Source / meaning |
| --- | --- |
| Usage / What it cost and how much {assistant} worked / Times {assistant} worked | Approved display name from SHELL; editorial plain-language labels over the existing Spend fields, not a count of finished tasks. |
| Today: **$0.37 USD**, **5**, cost reported for **4 of 5** finished turns | `story.js.usage.totals.today`, `costUsd=0.3737`, `turns=5`, `costTurns=4`. Four reports estimating cost is distinct from five usage reports; no inference that missing cost was free. |
| Today window **23 Sep 00:00–11:22 · Europe/Amsterdam** | Selected snapshot’s timezone and generatedAt; prepared **23 Sep 2026 at 11:22 Amsterdam**. Never restamped 14:05. |
| Last 7 days **$4.62 USD / 46**; **29 of 46** cost reports; window **16 Sep 11:22–23 Sep 11:22** | `.totals.week`, generatedAt/timezone. |
| Last 30 days **$17.97 USD / 177**; **111 of 177** cost reports; window **24 Aug 11:22–23 Sep 11:22** | `.totals.month`, generatedAt/timezone. |
| “A turn is one go at answering or working for you. It can include several steps; it isn’t a count of completed tasks.” | Plain-language explanation of `SpendOverview.turns` / finished turns. No task count or time saved is claimed. |
| More → **Provider coverage** / all providers reporting here combined / report doesn’t name or split them | Existing `SpendOverview` (`packages/core/src/domain/spend.ts`) has no provider dimension. This explains coverage honestly; it is not new provider data or selected-AI attribution. No quota. |
| More → Text used: **92,580 / 1,195,945 / 4,663,485 tokens** | Sum of each window’s `inputTokens` + `outputTokens`; “small pieces of text … reads or writes” is plain-language unit copy, not an unsupported work/time measure. |
| All finished turns supplied a usage report / **1** or **2** missing reports | `unreportedTurns` 0 / 1 / 2, respectively. Missing usage is never displayed as zero use. |
| More → Recorded by plan: **Invoice PDF export · 3,314,805 tokens** | The only supplied `plans[0]`. Explicitly separate saved plan-linked use from selected window and whole-account bill. No fabricated per-provider/per-plan cost. |
| Loading Usage / No usage reported for this window / Couldn’t read Usage / Try again | Local read-state alternatives. A successful zero report list supplies neither a $0 claim nor a zero work claim. |

## Expansion, accessibility and recovery

Desktop reading/focus order: Skip → Burrow HQ → nine named Places links → page heading → content in visual order. Phone web: Skip → Places → Search → “3 things need you, open Inbox” → page content. Native: Search → Places → origin Back on a utility push → content → five tabs when present. Chat’s accessible shell badge says “Chat, 1 unread reply in Feedback”; Inbox says “Inbox, 3 things need you, one is not working”. Decorative glyphs do not repeat those names.

Places is named **Places**, `aria-haspopup=dialog`, `aria-controls`, expanded state; open focuses Close Places, contains focus, scrolls at large text, and Close/Escape/scrim returns to its opener. Selecting a destination names/focuses its heading. Origin is recorded in the link; Back targets that origin. The local drawing retains a saved scroll/focus record for its own pages. **Cross-owner Chat scroll restoration, actual root-stack Back, iOS edge swipe, Android predictive Back, safe areas, keyboard avoidance and native accessibility focus remain implementation verification gaps.** No claim of OS certification is made.

Disclosures are real `details`/`summary` elements; their names and expanded state are exposed, content expands in place without moving trigger focus. Dialogs have a named heading, Close and Cancel; Escape/Close restores the opener. Blank new-secret fields never reveal a stored value, are not sent, and are cleared when closed. No clipboard function, secret reveal or timer is added. Screen state changes are explicit; there are no live timers or sorting changes under a finger. Passive shell badge updates must not move focus.

Web/iOS interactive targets are at least **44px/pt**, Android **48dp** in the drawings, including Close, rows, disclosures and fields. Largest text is **200% web** and the kept **1.6× native effective cap**; native tab labels retain SHELL’s fitting exception. Labels and buttons wrap, actions stack, fields shrink within the available width, and content/dialogs scroll instead of overlapping. No cap increase is proposed.

Measured WCAG 2.x solid text/background minimum across the 212 viewports: **4.942:1 light / 5.515:1 dark**, above 4.5:1. Per-view pairs, fonts, target geometry and overflow observations are in [render.json](../settings/render.json). No horizontal page overflow or undersized visible target was observed. The DOM method is [01-groundwork/contrast.js](../../01-groundwork/contrast.js); it omits images, scrimmed content and input values, and is not an OS accessibility audit. Blank input text uses `ink` on `sf`; the separately calculated nominal pair is **16.445:1 light / 13.657:1 dark**, in [input-contrast.json](../settings/input-contrast.json). Native rasterization, OS select menus and real screen-reader journeys remain gaps. Use `warn-text` for local read trouble; red appears only for the supplied Not working item and the shell’s real broken-item count.

Usage-specific order: origin Back → heading/intro → **Usage time window** group (Today / Last 7 days / Last 30 days, each `aria-pressed`) → explicit local time window → Estimated cost → Times {assistant} worked → turn definition → 11:22 prepared time → More. More expands Provider coverage, Text used and Recorded by plan in that order. The time selector keeps focus and position when changed; it never reorders a list under the finger. Data are a saved read, not live counters. Loading/empty/failed states retain the window controls, shell and Back. Try again repeats **spend.overview** only, not an AI turn or payment.

Normal PNGs show Today. All three windows are drawn and interactive from the same supplied snapshot. More is intentionally below the plain numbers, with an additional phone-platform PNG sheet showing its expanded content. At largest text metrics stack, count/price wrap, USD stays a labelled unit and More stays reachable by scrolling.

## Glance-and-find walkthrough

The SCORING.md protocol requires an unfamiliar human participant, timing, first choice and wrong turns. **No such study was run; no timed pass or future built-app score is claimed.** These are route/content walkthrough observations, separately recorded in [walkthrough.json](../settings/walkthrough.json), repeated in both themes on all four platform drawings.

| Task | Before walkthrough / evidence | Final walkthrough / boundary |
| --- | --- | --- |
| Find Vault from fresh Chat; name an entry, keep secrets closed | Web sidebar already named Vault; native shipped capture used a different Settings/deep-link path. Earlier proposal’s homes/order differed. See SCORING and 06/09. | Desktop Chat → Vault; phone Chat → Places → Vault. **Grafana** is the first entry, with no visible secret field. Same order and spelling on all four. |
| Find evening brief time without changing it | No brief card in groundwork. 06/14 prepared an assistant question and did not reach Change time: task completion gap. | Chat → Settings → Evening brief → **Change time**, or Chat → Search → type **Evening brief** → result → schedule → **Change time**. Actual selected schedule **weekdays 18:00 Amsterdam**; editor opens with 18:00; Escape returns to Change time. No question is sent and no time changed during the walkthrough. |
| Find last run from Automations, state outcome/time, show Back | Earlier proposals had a run path but different native/web fixture snapshots; round 14 native’s next-day run cannot be treated as already finished at this story’s clock. | This part preserves the **Automations** destination, rather than drawing another owner’s page. Binding shared record: “Assess new issues and pull requests on whombat/billing”, latest **#41, Done, 23 Sep 11:06**. Its full final run/detail/back journey belongs to the Automations part and is **not independently completed here**. No substituted next-day native run or fake success. |
| Five-second needs-you / action and Overview freshness tasks | Groundwork participant study unrun; server sample-time evidence incomplete there. | These four screens retain the independently known 3-item Inbox cue. Chat/Inbox/Overview/approval and sample-time participant tasks remain with their owners. Usage explicitly keeps its own 11:22 prepared time. |

The visual walkthrough also activated Settings’ Try again in the failed scene: only the local scope becomes Loading settings, while its five group names, theme, Places/sidebar and native tabs remain available. No retry repeats a command or claims a successful response.

## Baselines, gaps and delivery

Today’s unchanged marks: desktop **6.7**, phone web **6.2**, iOS **6.7**, Android **6.6**. No future built-app score. Current reference is existing Spend (`SpendTab.tsx`, `packages/fixtures/src/spend.ts`); the Spend/settings reference in **Whombat Desktop.dc.html** and numeric/disclosure styling in **Whombat Mobile.dc.html** need review, and `baselines.spec.ts`’s Spend PNGs need intentional replacement when implemented. No provider dimension, currency conversion or billing reconciliation is added. Actual OS text/VoiceOver/TalkBack and timed participant studies remain gaps.

The original Whombat shot endpoint was tried for **64 normal before/after images**: HTTPS tail1a2b3 first, then 10.100.1.81 and 10.100.1.97. **0 delivered / 192 attempts** (DNS/HTTP failures); [delivery.json](../settings/delivery.json) records every attempt. No after response supplied numbered changed regions, so there were no region notes to post. All PNGs remain reviewable in this handoff; failed delivery did not block the PR.
