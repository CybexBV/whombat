# Vault · final handoff

## Scope

These are static HTML designs for desktop web (1440×900), phone web (390×844, Places closed), iOS and Android (390×844 drawings), light and dark. They import the actual token stylesheet and bundled Bricolage Grotesque / DM Mono fonts. Native pictures are not simulator screenshots or evidence that an app change shipped.

Base: `origin/main` 8870fd7cb, with binding [SHELL.md](../SHELL.md), [STORY.md](../STORY.md) and `story.js`. The observation is **23 Sep 2026, 14:05 Europe/Amsterdam**. `story.js.assistant` comes from `agentWords(assistantAgent().name).name`; new UI interpolates it. Mara Okafor and Burrow HQ come from the same story. No new account, device, incident, health flag, quota, permission or provider attribution is invented.

The shared `shell.js`/`shell.css` are used directly. A small shared-shell **link map only** replaces the five destination previews (Settings / Vault / Files / Usage / the Search setting-match scene) with these drawings. This is the integration contemplated by SHELL’s “Later screen owners replace the corresponding preview”; no sidebar, badge, order or other owner’s screen was redrawn. The final gallery discovers the 32 normal PNGs without a gallery edit.

Primary Places order is **Search, Chat, Inbox, Overview, Automations, Files, Vault, Usage, Settings**. Files → Vault → Usage is consecutive, with one home each. No copies in Chat overflow or Advanced. Native top-level Settings keeps **Chat / Inbox / Overview / Automations / Settings** tabs. Native utility screens hide tabs and show the recorded **Back to Chat** (or actual origin); Places remains in the top chrome. The shell’s 3 Inbox items and 1 unread Feedback reply are independent of every page’s read state.

Before evidence: fresh Chromium captures of the earlier **static proposals**, saved under ignored `.whombat/shots/` before creating these final screens, then copied into `png/before-<platform>-<theme>.png`. They are not recaptured running-app evidence. The underlying shipped fixture screenshots remain in [01-groundwork](../../01-groundwork/index.html) and [08-native-capture](../../08-native-capture/index.html). Earlier proposals have earlier clocks, counts and navigation; their disagreements do not override the final story. Normal before/after use identical viewport, theme and scale. The viewer explicitly reports no matching before picture for new state / large-text scenes.

No application code, tests, tokens, contracts, decision documents or SCORING.md change. No lint, typecheck, notices, tests, CI, build or PR-check wait: John explicitly requested **NO CI**. Chromium rendering, pixel-preserving PNG compression, colour observations and a visual route walkthrough are the verification here.

Vault has one obvious home: desktop Places row, phone web Places drawer, native Places sheet. The final main view uses the same five records and order everywhere; the single actual failing credential gets the loud cue. “Add to Vault” sits in a wrapping header flow and takes its own row at narrow/large text, fixing the 200% collision without changing a token or native text cap.

## Pictured lines and data sources

| Pictured line/family | Source / boundary |
| --- | --- |
| Vault / Add to Vault / intro / secret stays closed / Replace secret | Existing `packages/core/src/vault/copy.ts`, `apps/web/src/features/vault/copy.ts`, VT-04/70/71; editorial short intro interpolates the shared assistant name. |
| Grafana — Sign-in reached; Last used **09:12** | `story.js.vault[vlt_grafana]`, step 14’s metadata, `check.status=reached` / `lastUsedAt`, Amsterdam. Expanded description and URL are that record’s metadata; checked **23 Sep 10:20**. |
| Home Assistant — Sign-in reached; Last used **10:48** | `vlt_homeassistant`; metadata reached check at **23 Sep 11:19**. Its **connection still needs a look** from STORY: a credential check does not settle the integration problem. |
| Printer admin — **Not working · Password rejected** | `vlt_printer.check.status=failing`, actual rejected secret (401); last checked **19 Sep 11:01**. Never render this as ordinary healthy/no-data. |
| Weather API key — Not checked / {assistant} is off | `vlt_weather.check.status=unchecked`, `agentOn=false`. Existing older secret retained; not a type newly offered by Add. |
| Shop admin — Saved from Chat | `vlt_shop`, explicitly added to STORY from its **11:31** blanked Chat message. Only id/name/kind/saved metadata; no URL, username, last use, check result or secret inferred. |
| Entry expanded descriptions, addresses, check dates | Same entry fields. All entries start closed; there is no stored-value reveal. “Secret saved” comes from `secret.set`, not a fictional password. |
| Add modal/form labels; native three-choice list | Shipped web `AddToVaultModal.tsx` / `copy.ts`; native `AddToVaultSheet.tsx` / `data/vaultForm.ts`; template labels/descriptions from `packages/core/src/vault/schemas.ts`. Web keeps automatic selection and Advanced; native starts with Sign-in key / Password / Website login and keeps SSH-on-web wording. No new raw-Secret or MCP-Connection creation option. This is preserved form anatomy, not a replacement specification for its full validators. |
| Loading / Nothing in your Vault yet / Couldn’t read your Vault / Try again | Local alternative list-read states. Empty is successful zero entries; failure is not empty and does not mean every credential stopped working. |

## Expansion, accessibility and recovery

Desktop reading/focus order: Skip → Burrow HQ → nine named Places links → page heading → content in visual order. Phone web: Skip → Places → Search → “3 things need you, open Inbox” → page content. Native: Search → Places → origin Back on a utility push → content → five tabs when present. Chat’s accessible shell badge says “Chat, 1 unread reply in Feedback”; Inbox says “Inbox, 3 things need you, one is not working”. Decorative glyphs do not repeat those names.

Places is named **Places**, `aria-haspopup=dialog`, `aria-controls`, expanded state; open focuses Close Places, contains focus, scrolls at large text, and Close/Escape/scrim returns to its opener. Selecting a destination names/focuses its heading. Origin is recorded in the link; Back targets that origin. The local drawing retains a saved scroll/focus record for its own pages. **Cross-owner Chat scroll restoration, actual root-stack Back, iOS edge swipe, Android predictive Back, safe areas, keyboard avoidance and native accessibility focus remain implementation verification gaps.** No claim of OS certification is made.

Disclosures are real `details`/`summary` elements; their names and expanded state are exposed, content expands in place without moving trigger focus. Dialogs have a named heading, Close and Cancel; Escape/Close restores the opener. Blank new-secret fields never reveal a stored value, are not sent, and are cleared when closed. No clipboard function, secret reveal or timer is added. Screen state changes are explicit; there are no live timers or sorting changes under a finger. Passive shell badge updates must not move focus.

Web/iOS interactive targets are at least **44px/pt**, Android **48dp** in the drawings, including Close, rows, disclosures and fields. Largest text is **200% web** and the kept **1.6× native effective cap**; native tab labels retain SHELL’s fitting exception. Labels and buttons wrap, actions stack, fields shrink within the available width, and content/dialogs scroll instead of overlapping. No cap increase is proposed.

Measured WCAG 2.x solid text/background minimum across the 212 viewports: **4.942:1 light / 5.515:1 dark**, above 4.5:1. Per-view pairs, fonts, target geometry and overflow observations are in [render.json](../settings/render.json). No horizontal page overflow or undersized visible target was observed. The DOM method is [01-groundwork/contrast.js](../../01-groundwork/contrast.js); it omits images, scrimmed content and input values, and is not an OS accessibility audit. Blank input text uses `ink` on `sf`; the separately calculated nominal pair is **16.445:1 light / 13.657:1 dark**, in [input-contrast.json](../settings/input-contrast.json). Native rasterization, OS select menus and real screen-reader journeys remain gaps. Use `warn-text` for local read trouble; red appears only for the supplied Not working item and the shell’s real broken-item count.

Vault order: origin Back when present → heading/intro → **Add to Vault** → Grafana → Home Assistant → Printer admin → Weather API key → Shop admin → quiet note. Each entry is an independently named disclosure; its line includes the credential words and actual use time. Expanded content follows that entry, then Replace secret / Check sign-in only where metadata supports a check. Replace is a new write-only field, not a current-value input. A new check would be an explicit request; this HTML only shows saved check metadata and a preview explanation. Keep actual current credential/permission/network validation and confirmations when implemented.

At 200% the heading/action never share an overlapping absolute-positioned strip. Add is full width below the title/intro; the dialog heading wraps beside its fixed Close target, and the form scrolls. Native retains its shipped initial choice list; iOS/Android share its content and differ only in shell/chrome/target sizing. Large-text evidence includes the header and opened Add surface. No secret was entered or saved during capture.

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

Today’s unmodified SCORING marks: desktop **7.3**, phone web **6.7**, iOS **7.1**, Android **7.0**. No future built-app score awarded. Before drawings use step 09; shipped fixture evidence stays in 01/08. If implemented, **Whombat Desktop.dc.html**’s shared modal/row reference and **Whombat Mobile.dc.html**’s modal/touch reference need review; the actual one-person Vault uses `baselines.spec.ts`’s Vault fixture baseline, which needs intentional replacement in both themes. Existing references and baselines are untouched. Native secret-entry keyboard/OS menus, full creation validators and assistive technology remain gaps.

The original Whombat shot endpoint was tried for **64 normal before/after images**: HTTPS tail5e6f7 first, then 10.100.1.81 and 10.100.1.97. **0 delivered / 192 attempts** (DNS/HTTP failures); [delivery.json](../settings/delivery.json) records every attempt. No after response supplied numbered changed regions, so there were no region notes to post. All PNGs remain reviewable in this handoff; failed delivery did not block the PR.
