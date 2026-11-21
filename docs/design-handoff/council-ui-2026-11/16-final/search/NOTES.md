# Search · round four

Mockups only, in the existing final design. This adds the dedicated Search screen to desktop web, phone web, iOS and Android in light and dark. The visible Search link, native chrome, Places and the keyboard shortcut converge on this screen. Earlier design rounds and application code are untouched.

Typing searches the shared fixture snapshot in **Chats · Things · Settings · Places**. Whole results open by keyboard or tap. Clearing restores the initial empty query; loading and no results have their own words and pictures. A failed read is a neutral local state, with Try again. No AI answer, remote request or write runs. The initial query **pve** is an authored example. The **e** example demonstrates all four groups; its Settings / Places are further down the results. Separate **Evening brief** and **Files** pictures show those exact matches.

The Evening brief result says **Weekdays at 18:00 · Amsterdam** and opens the existing schedule. Native shows **‹ Search** / arrow there, without Search / Places chrome above Back. Search itself returns to its recorded origin, normally Chat. The prototype preserves query, scroll and result focus when returning. The full pve-02 thread is linked directly. Other chat roots and connections without a final detail drawing open their own named read-only metadata previews; they never masquerade as pve-02 or Home Assistant. Their full application journeys remain outside this screen assignment.

## Pictures

- `<platform>-<theme>.png`: the pve query, with Chat and server matches.
- `-empty.png`, `-loading.png`, `-no-results.png`, `-failed.png`: distinct read/query states.
- `-settings.png`: Evening brief with its 18:00 time; `-opened.png`: that result opened.
- `-things.png`, `-places.png`, `-groups.png`: server matches, the Files destination, and lower groups of the broad **e** query.
- `-largest.png`: 200% phone-web / kept 1.6× native text. Each phone state also has `-largest-<state>.png`. Controls grow and the results scroll; native targets stay 48dp on Android / 44pt on iOS.

Desktop is 1440×900; phone drawings are 390×844, Chromium scale 1, bundled fonts, Europe/Amsterdam. These are HTML designs, not app screenshots. This is a new Search screen, so there is no matching previous Search picture; existing shell/screens were captured before changing them under ignored `.whombat/shots/round-four/`.

## Every pictured line: data source

| Line / element | Source |
| --- | --- |
| Search; Chats, Things, Settings, Places; input/clear labels and group headings | Existing product destination vocabulary and this task’s explicit grouping; authored navigation copy, no server field. |
| Chat titles and reply / waiting / working descriptions | `story.js.threads`: exact stored `text`, `waiting`, `working`, `replyCount`; assistant from the exported name helper. No guessed unread marker or historical reading rewritten as current. |
| Server names, systems and condition words | `story.js.servers` and `shellThings`; selected native `assistant.ts` → `SERVERS`. The current shared pve-02 condition stays Running warm. |
| Home Assistant / UniFi / Hetzner / Mail / Heat pump identities | Native `assistant.ts` → `otherThings`; the shared connection’s Needs a look and heat pump’s Learning selection from STORY. No invented connection reading time or fresh sign-in check. |
| Real Proxmox, Unraid, Debian, Home Assistant, UniFi, Hetzner and Mail marks | Existing `packages/brand/assets/marks/*.svg`; aliases in STORY. Heat pump retains its existing thermometer. Source artwork keeps original colours. |
| Evening brief; Weekdays at 18:00; Amsterdam | `5cf15c134:apps/mobile/src/fixtures/brief.ts` → `EVENING_BRIEF.schedule`, the same selection as `settings/schedule.js` and `story.js.briefSchedule`. No November content/person/date is imported. |
| Notifications, Theme and their descriptions | Existing `settings/screens.js` presentation labels; setting destinations, not inferred current notification/account values. |
| Places names and descriptions | `FinalShell.places`, the canonical SHELL order; Files / Vault / Usage descriptions agree with their current final drawings. |
| Results count | Exact matching rows in this static catalogue, not an Inbox/unread/health count. |
| pve, e, Evening brief, Files, garden shed | Authored typed-query examples, not account searches or new fixture objects. |
| Empty, Searching, No results, Couldn’t search, clear/retry/help text | Authored query-state copy; alternatives, not simultaneous outages or mutation outcomes. |
| Back labels; 09:41; Places; navigation badges | Shared shell and STORY, actual recorded origin; schematic OS area; existing Inbox / Feedback counts. |

The renderer records text/solid-background contrast, page errors, document overflow and visible target geometry in `renders.json`. Provider/logo artwork and real OS gestures, keyboard avoidance, safe areas and VoiceOver/TalkBack are not certified by these drawings. No tests, lint, typecheck, CI or PR-check wait runs, per the explicit NO CI instruction.

Reproduce with Node 24 and the repository’s existing rendering dependencies: `node docs/design-handoff/council-ui-2026-11/16-final/search/render.mjs`. This produces PNGs and design observations only; it starts no service.

Final sampled visible-text contrast: **4.942:1 light / 5.515:1 dark**, with no sampled pair below 4.5:1, page error, document overflow or undersized visible target in the recorded scenes. Picture upload failure is recorded in the parent NOTES; it does not affect the committed PNGs.
