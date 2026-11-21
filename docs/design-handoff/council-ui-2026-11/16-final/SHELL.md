# Final shell · one navigation contract

Round four, phone shell finish and Search. This is the shell for **all twelve final screens and Search**, not another variant of steps 11–14. Mockups only. The final drawings use `shell.js` and `shell.css`; subsequent screen authors should use those files rather than copy a sidebar from an earlier round. [Pictures, including Places open](shell-review.html) · [fixture story](STORY.md).

## Names, order and homes

The primary navigation order is exactly:

1. **Search**
2. **Chat**
3. **Inbox**
4. **Overview**
5. **Automations**
6. **Files**
7. **Vault**
8. **Usage**
9. **Settings**

Files → Vault → Usage is the same consecutive group everywhere. Each name identifies **one destination**. Do not add another Usage under Advanced, a separate Spend page, a Vault under the assistant’s settings, or a second Files page in Chat. Settings may refer to these places in explanatory copy, but the navigation home is the sidebar / Places. A file attached to a message still opens that file; that is not a second Files home.

| Label | Product destination / scope | Final gallery identity |
| --- | --- | --- |
| Search | Existing Search; a visible **link**, no navigation search box. All platforms open the same dedicated Search screen and groups. | `search`; ancillary gallery row, outside the twelve scoring rows |
| Chat | `/chat`, chronological root messages with replies underneath each question | `chat-list` (the scoring name does not replace the timeline) |
| Inbox | `/inbox`; the existing needs-you list and Settled | `inbox` |
| Overview | Existing Overview destination (`CONNECTIONS_HREF` in the app shell); Servers / Connections / Pinned remain content tabs | `overview` |
| Automations | `/automations`; the existing automation list and schedules | `automations` |
| Files | `/files`, the one cross-conversation Files index; a conversation opens within it | `files` |
| Vault | `/vault`, sealed entry metadata; never secret values | `vault` |
| Usage | The existing Spend content destination, `/settings?tab=advanced&part=spend`, **displayed as Usage**. Implementation may alias this one route; the old `tab=usage` AI-sign-in alias is not a second usage screen. | `usage` |
| Settings | `/settings`; You / {assistant} / This Whombat / Screens / Advanced | `settings` |

These product destinations describe the app; they are not implemented here. Static navigation opens each existing final drawing, with platform, theme and largest-text choice retained. Search opens `search/mockup.html`, including from the visible desktop/phone-web Search link, native top-level chrome and Places. Older specimen Search URLs converge on this same page. Where a thing or chat root has no final detail drawing, its named read-only preview keeps that identity; no result opens an unrelated page.

The sidebar and phone Places retain **Servers** and **Connections** shortcuts below the nine primary places. Each server/connection shows its **real service/OS logo**, just as today’s app does: Proxmox, Unraid, Debian, Home Assistant, UniFi, Hetzner and Mail use the existing `packages/brand/assets/marks/*.svg` assets. Never replace a known logo with a generic server glyph. The device Heat pump retains its thermometer because no device mark is supplied. Source identities and aliases are in `story.js.shellThings` and STORY.md. All shortcuts open that named thing; these extra links do not create a second page or change the primary order. The sidebar and Places scroll so every shortcut remains reachable at the kept text maximum.

## Desktop web · 1440 × 900

- One **256px** sidebar, `side` surface, 1px `line` right edge; 12px horizontal inset. Main workspace fills the remaining width.
- Burrow HQ: 48px brand row, 20px/700 title, 27px line mark; 18px gap before the first destination. The drawing’s line mark is a navigation specimen, not new brand artwork.
- Nine links in the order above, **44px minimum** each, 12px inner horizontal padding, 12px icon/label gap, 20px icons, 15px labels, token `radius-button`. No per-section reordering. Selected Chat uses `sel`, `ink`, 600 and `aria-current=page`.
- The noninteractive person footer names Mara only here, outside Chat messages. Settings is the explicitly labelled ninth link; the footer does not hide a second Settings menu.
- Body content has its own scroller. Sidebar scrolls independently on shorter windows. Primary links never get clipped or replaced with icon-only buttons.

## Phone web · 390 × 844

One **56px** top bar, 12px side padding, 8px gaps, `bg` surface and 1px `line` bottom edge:

1. **Places**, menu glyph plus word, ≥44px target. Accessible name “Places”, `aria-haspopup=dialog`, `aria-controls=places-menu`, expanded state.
2. **Search**, magnifier plus text link, ≥44px high. Always visible, including with the drawer closed. No input box in this bar.
3. **3 need you ›**, ≥44px high, right aligned; accessible name “3 things need you, open Inbox”. It opens Inbox. Hidden on Inbox itself. The short visible phrase fits all three controls at 390 without shrinking a target; it is the same Inbox count as desktop/native.

The normal screen starts with the drawer **closed** and no desktop sidebar. Open Places is the web drawer: `min(85vw, 320px)` wide (**320px at 390**), full viewport height, left aligned, token right corners, `side` surface. It has a Places heading and visible **44px Close Places** control first, then the exact nine-link sequence above. Rows are ≥44px and grow for wrapped labels. Escape, scrim, Close and selecting a destination dismiss it. This keeps UIR-11/12/13’s needs-you door, width, focus containment and target rules; “Places” is the single visible menu name chosen for this round.

## Native iOS / Android · 390 × 844 drawings

Both use the **same five tab identities**, left to right: **Chat · Inbox · Overview · Automations · Settings**. Files, Vault and Usage belong in Places, never a sixth tab. The tab order is the corresponding subsequence of the primary sidebar destinations.

Above Chat: schematic **44px OS area**, then a **48px navigation row** with a Search text link at left and **Places** at right. Both labelled controls have ≥44pt iOS / ≥48dp Android targets. The content’s Chat title and Feedback / Settled / More in Chat follow in their own header. Places is not Chat’s ⋯; room actions never contain a duplicate Files destination.

- **iOS:** token-surface floating tab bar, 12px side inset, 16px bottom inset, 62px minimum height, pill radius, 1px `line2` border. Icons 22pt, labels 10pt (the shipped tab fitting exception), targets ≥44pt. Previous-title chevron is drawn in the first row on pushed pages; edge back remains a native implementation requirement.
- **Android:** full-width tab bar, 72dp minimum, 1px `line` top edge, 6dp top and 14dp bottom padding, 22dp icons, 10sp fitting labels. Targets ≥48dp. Arrow-back is drawn in that first row; predictive back remains Android’s.
- **Places open:** one sheet, 12px side inset, 16px bottom inset, token modal radius, `side` surface. Its Close target is ≥44pt / 48dp, followed by all **nine primary destinations in desktop order**, then the same real-logo Servers / Connections shortcuts. At 390 the sheet is 366px wide. Its max height is viewport minus 24px; the menu scrolls at large text instead of compressing targets. A native implementation uses its platform sheet/menu and accessibility-modal semantics, not an HTML dialog.
- Top-level Chat, Inbox, Overview, Automations and Settings keep tabs. Thread, approval and utility push screens (Files, Vault, Usage) keep the recorded origin and **Back to Chat** when opened there; no tab bar is invented on those root-stack screens. **Back comes first in the first navigation row below the OS area. Do not stack the top-level Search / Places row above Back.** iOS uses the chevron plus the actual previous title (**‹ Chat**, **‹ Search**, **‹ Settings**, **‹ Files**, **‹ Overview**); Android uses the arrow with an accessible “Back to …” name. A Places control can share the right side of this one Back row; Search is inside Places on these pushed pages. The recorded origin, not a fixed Chat label, supplies the previous title. Shared HTML accepts `hideTabs: true` and moves the existing back link into this single shared row.

These are geometry drawings, not OS screenshots. Real device safe areas, keyboard avoidance and system gesture areas must be applied by implementation; 390 CSS pixels here stand for scale-1 pt/dp.

## Badges: one source and one meaning

| Where | Fixture value / accessible meaning | Paint |
| --- | --- | --- |
| Chat in sidebar, tabs and Places | **1**, the unread Feedback thread from the fixture room state. Name: “Chat, 1 unread reply in Feedback”. It is not a working count or a fake unread dot on pve-02. | `btnfg` on `ink`, pill, 11px mono (10px in tabs) |
| Inbox in sidebar, tabs and Places | **3**, the **three returned Inbox items** in STORY.md. Name includes “one is not working” because blackbox’s disk array failed. It does not count every pending card elsewhere in Chat. | `btnfg` on `bad`; red is justified by an actual broken item |
| Phone-web top bar | Same **3**, the compact word cue described above | `bad` text on `bg`, no extra notification bubble |
| Feedback room action | **1**, the same unread Feedback thread, not a second event | `btnfg` on `ink` |

The consolidated Chat home aggregates Chat + Feedback using the native `chatTabCount` semantics on all platforms. Web’s former separate Feedback sidebar row now lives in Chat’s header; the fully named badge makes that scope explicit. Per-room and per-thread unread/read-marker behavior remains TU-05’s.

Suppress zero badges; do not render “0”. Badge glyphs are decorative inside the fully named link, so a screen reader hears the number once. Never derive an Inbox count by adding Chat’s wait flags, a usage total, run bars or a heads-up count. `needsYouCount = inbox.length` in the export. The prototype has no timer or live update.

## Focus, expansion, largest text and stability

Reading/focus order on desktop: Skip → Burrow HQ → the nine links → main header/actions → main content → composer. On phone web: Skip → Places → Search → Inbox cue → content header/actions → content → composer. On native top-level screens: Search → Places → content → composer if present → the five tabs. Screen-reader traversal follows the same named regions; native intended messages retain the existing combined element/actions.

Opening Places sets expanded=true and focuses **Close Places**, followed by Search, Chat, Inbox, Overview, Automations, Files, Vault, Usage, Settings. The real-logo Servers and Connections shortcuts follow Settings. Tab/Shift+Tab stay inside the dialog. Escape/Close/scrim returns focus to the exact Places opener with its scroll position. Selecting a destination closes the modal, names/focuses the new screen’s heading and records origin; a pushed utility screen’s Back restores the original Chat control and scroll anchor. The HTML demonstrates modal containment and navigation locations; actual native focus/back is not certified.

At 200% web content text and the kept native effective **1.6× cap**, labels wrap and the menu scrolls. Controls do not shrink; native tab labels retain their existing fitting exception. Chat’s full waiting facts remain in its scroll area. Keep selections and rows keyed to identity; a count or stage update repaints the same control, with no priority sorting under a finger. Screen navigation is explicit. Do not move focus on a passive badge change.

## Decision authority

- **Reopens AP-2645 — decided by Dusty for John's review.** Native Search screen; its entry is Search in shared chrome/Places. Its dedicated four-platform screen and states are in `search/`.
- **Reopens AP-6412 — decided by Dusty for John's review.** Readable token-coloured iOS badges, as on Android. AP-7463’s system-red exception is affected too; no decision doc is edited.
- **Reopens STG-03 — decided by Dusty for John's review.** Usage is the display name for the existing Spend content.
- **Reopens STG-10 — decided by Dusty for John's review.** Usage is findable outside Advanced.
- **Reopens STG-12 — decided by Dusty for John's review.** Existing Spend links converge on that one named home, not the old AI-sign-in Usage alias.
- The visible web Search link keeps **AP-2274** (no navigation box). Android’s 48dp targets and the same Files/Vault/Usage home follow the explicit round-three task. Native tab identities and order remain unchanged. AP-7460’s Feedback / Settled retention order is kept; Files moves from room actions to its consolidated Places home as explicitly requested here.

Connection heads-up folding and council/delegation presentation remain Dusty’s accepted rules, but those cards are not drawn in this part. No recommendation, invented consequence, approval undo or raised text cap is approved by these shell pictures.


## Search and finish details

- **Search is visible on desktop and phone web.** It is a link, never a second navigation input. It opens the same Search result screen as native. Typing matches chats, things (servers / connections), settings and places, grouped with those plain words. The Evening brief result includes **Weekdays at 18:00 · Amsterdam** and opens its schedule. Clear, initial empty, loading, no-results and failed-read scenes are distinct. Opening a result keeps its query and Back restores that query, scroll position and result focus.
- The phone Chat header leaves **8px between Feedback, Settled and More**. If the controls need more room, the header grows; targets stay ≥44pt / ≥48dp. Largest text keeps the existing Settled overflow policy.
- Suppress **all zero badges**, including the Inbox **Settled 0** count. Keep the Settled disclosure and its chevron; a nonzero number returns when something is actually settled.
- The brief’s time entry is explicitly **24-hour `18:00`**, matching its time-choice buttons. Its labelled field accepts `HH:mm`; do not let a browser locale redraw it as “06:00 PM”.
- Desktop Settings rows use distinct existing line symbols: clock (brief), bell (notifications), half-lit circle (theme), person (You), assistant face (assistant settings), box (This Whombat), display (Screens), sliders (Advanced).
- In Chat, a thing-health dot remains **amber `warn`** for pve-02’s Running warm; **Waiting for you uses blue `chart1`**, so health and conversation state have different colours. Words and accessible names still carry their separate meanings. Red stays reserved for Not working; real brand artwork keeps its source colours.
