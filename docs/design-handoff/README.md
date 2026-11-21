# Handoff: Whombat — one person’s device and one AI agent

## Product and authority

A Whombat is one person’s box with one workplace (“burrow”) and one agent. The person talks to the agent in Chat,
uses connected services and servers, and follows its plans, runs, approvals and automations. The person chooses
the agent’s name and one of five faces. The faces describe its voice and appearance; they do not add agents or roles.
Only the person’s devices sign in. Incoming website feedback, customer reports and mail stay separate from their work.

`ARCHITECTURE.md` describes the running system. `DECISIONS.md` and its indexed decision files define behavior.
This handoff defines visual tokens and maps the references to the current product. For a screen, use the most
specific applicable reference below. Its visuals, copy and layout win within that scope; product decisions define
which controls and behavior exist. Resolve an uncovered behavior in the relevant decision workstream.

## Reference map

Where two rows cover the same screen, the row higher in the table wins.

| Area | Reference | Applies to |
| --- | --- | --- |
| Final design (the 2026-11 UI council) | `council-ui-2026-11/16-final/`: `SHELL.md` and `STORY.md`, then one folder per place (`chat-list/`, `thread/`, `approval/`, `inbox/`, `overview/`, `server/`, `connection/`, `automations/`, `settings/`, `vault/`, `files/`, `usage/`, `search/`), each with `mockup.html`, its pictures and `NOTES.md` | The web sidebar, the phone-width bar and Places, the phone app’s tabs and Places, Search, Chat’s thread list and threads, cards, approvals, the Inbox, Overview, a server’s and a connection’s page, Automations, Settings, Vault, Files and Usage, on the web (desktop and phone width), iOS and Android. It ranks above every row below for these screens. The numbered folders `01-…` to `15-…` and `scoring.html` are the council’s working rounds, not references. |
| Settling threads | `chat-settle/index.html` | Settle and Undo on a thread, the Settled list and its count, and what settles by itself; its layout, order and words rank above `chat-channel/` (the final design wins where it draws the same screen). |
| The agent’s faces | `whombat-crew/agents.json`, `whombat-crew/svg/`, `whombat-crew/reference/crew-reference.html` | The five faces’ art in each size (bust, head, small head), their names and accents; it ranks above `five-agents/`. `whombat-crew/expressions/` and `png/` are not used by the apps. |
| Personal shell and dashboard | `one-whombat/index.html`, `home-redesign/proposed.html` | Navigation, the person’s Home, connections, needs-you cards and assistant settings. |
| Chat and threads | `chat-channel/index.html` | The person’s threaded Chat, full-width thread, thread list and Ask panes. |
| Model choice | `chat-runtime/index.html` | Provider/model choice for Chat and its threads. |
| Service and server pages | `dashboards/index.html`, `connections/index.html`, `connections/tabs.html`, `connections/server-cards.html` | Service dashboards, connection forms, server lists and details. |
| Phone settings | `settings-mobile/index.html` | Mobile Settings navigation and groups where the final design’s `settings/` does not draw them. |
| Skills | `all-skills/settings-skills.html` | Hermes skills in Settings. |
| The agent’s five faces, earlier art | `five-agents/agents.json`, `five-agents/svg/` | One selected face per Whombat; `whombat-crew/` wins wherever they differ. |
| Shared components and code-work screens | `design/Whombat Desktop.dc.html` | Message rows, cards, approvals, runs, pull requests, audit, search and canvases where a newer reference does not cover them. |
| Shared phone components | `design/Whombat Mobile.dc.html` | Touch sizing, approval detail and message styling where a newer reference does not cover them. |
| Avatar construction | `design/WhombatAvatar.dc.html`, `design/Whombat Avatar System.dc.html` | Shape and palette reference alongside the production art. |

The original desktop’s roster, hiring, team invitations, role permissions, room membership and multi-person
onboarding are outside the product. Their controls and example copy are not requirements. Keep the HTML files and
seed data for visual comparison of the components that still apply. The desktop’s `<script data-dc-script>` holds
the original example world; application fixtures define the current one-person world.

The HTML files in `design/` need `support.js` alongside them and load React from unpkg. Their `start` and `theme`
props select screen and theme. Compare at 1440×900 in both themes unless the screen specifies another viewport.
`tools/visual/README.md` describes `pnpm visual`, `pnpm ref:shot` and `pnpm visual:diff`.

## Fidelity

Match the applicable reference’s type, spacing, sizes, radii and words. Preserve curly quotes, `·`, `−` and euro
formatting. Colors, fonts, radii and shadows come through `@whombat/tokens`; the fixed color exceptions below remain.
Use the shared components, production SVG avatars, bundled fonts and Lucide icons already in the repository.

---

## Design tokens

### Fonts (Google Fonts)
- **Bricolage Grotesque** (opsz 12–96, weights 400/500/600/700) — all UI text.
- **DM Mono** (400/500) — metadata, labels, timestamps, code, branch names, counts.
- `-webkit-font-smoothing: antialiased`; `box-sizing: border-box` everywhere.

### Type scale (px / weight / letter-spacing)
- Display: 44/700/-.03em (onboarding h1), 42/700/-.03em (canvas h1), 36/700/-.02em (page h1), 32/700/-.02em (run h1)
- Headings: 28/700/-.02em, 26/700/-.02em, 23–24/700, 21/700/-.01em (header titles, canvas h2), 19/700/-.01em (card titles)
- Body: 17/1.55–1.65 (canvas, sub), 16/1.55 (messages), 15–15.5 (lists, names 600), 14–14.5 (secondary), 13–13.5 (meta)
- Mono labels: 500 10.5–11px, letter-spacing .05em, UPPERCASE (section labels like `CHANNELS`, `PLAN · 4 STEPS`)
- Mono meta: 400 11.5–12.5px (timestamps, paths)
- Mobile: large title 34/700/-.02em; body 15–15.5; buttons 15–16

### Colors — light / dark
| token | light | dark | use |
|---|---|---|---|
| bg | #fbf9f5 | #1c1815 | app background |
| side | #f3eee6 | #171411 | sidebar, secondary panes |
| sf | #fffdf9 | #24201c | cards, inputs |
| sf2 | #f1ece4 | #2e2925 | chips, badges, tracks |
| ink | #221d18 | #f1ebe3 | primary text |
| ink2 | #3d352e | #d8cfc4 | body text |
| mut | #6e655c | #a0958a | meta text |
| line | rgba(34,29,24,.09) | rgba(255,255,255,.08) | dividers, card borders |
| line2 | rgba(34,29,24,.18) | rgba(255,255,255,.16) | input/button borders |
| brand | #7d6353 | #d2b49a | links, @mentions, sha |
| btn / btnfg | #221d18 / #f5f2ed | #f1ebe3 / #1c1815 | primary button, active chips |
| code | #2b221d | #120f0d | code/log blocks |
| ok | #3e7b58 | #6fcf97 | success, additions |
| warn | #8d6d2d | #e0b75e | needs a person, pending |
| bad | #9f5540 | #e59a85 | errors, deletions, declined |
| sel | rgba(34,29,24,.06) | rgba(255,255,255,.07) | sidebar hover/selected |
| ov | rgba(34,29,24,.32) | rgba(0,0,0,.55) | modal overlay |
| hi | rgba(84,145,196,.10) | rgba(84,145,196,.16) | live-edit highlight on canvas |
| mark / mark2 | rgba(143,127,201,.16) / rgba(201,118,95,.14) | .24 / .22 | canvas highlights (researcher / reviewer) |

Code block text: base #ece4d9, added #9fd7b4 on rgba(90,163,122,.18), removed #f0a893 on rgba(201,118,95,.2), `$` commands #b8ada1, ✓ #8fd1a8, ✗ #f0a893, timestamp #7e746a.

Status dots: working #6fcf97, waiting #d9a84a, idle #a0958a. Presence dot #6fcf97.

Human avatar tones: #d9c3a9, #bfd0bf, #dcc0cc, #c3cad9, #cfd2b8 (text #221d18, initials 600).

### Original avatar palettes
| palette | label | accent | deep | fur | accessory | expression |
|---|---|---|---|---|---|---|
| architect | Architect | #5491c4 | #3b6d99 | cocoa | pencil | thoughtful |
| developer | Developer | #5aa37a | #3e7b58 | ash | headphones | focused |
| researcher | Researcher | #8f7fc9 | #6a5aa3 | sandy | round glasses | curious |
| reviewer | Reviewer | #c9765f | #9f5540 | cocoa | half glasses | skeptical |
| operator | Operator | #b99346 | #8d6d2d | ash | antenna | calm |
| support | Support | #3fa0a6 | #2b777c | sandy | headset | warm |

Fur: cocoa #7d6353 (muzzle #dcc6ab, inner ear #b58c78, brow #46372d); ash #8c857f (#e0d8cd, #bb9c92, #4c4541); sandy #b3977a (#eddfc9, #cc9f87, #6a5442).

### Radii
999px pills/chips · 22px modals · 18–20px large cards / mobile groups · 16px cards, composer · 14px inputs/panels · 12px buttons (large), list items · 10px buttons (default), sidebar rows · 8–9px small buttons · 5–6px tags/receipt numbers. Phone frame 56/46px.

### Spacing
Base rhythm 2/4/6/8/10/12/14/16/18/20/22/24/28/32/36/40/48/56. Page padding 28–40px desktop, 22px mobile. Content max-widths: messages 880px, run/roster 1120px, log 1040px, onboarding 720px, canvas article 680px.

### Shadows
Modal `0 30px 80px -20px rgba(0,0,0,.45)` · toast `0 12px 30px -10px rgba(0,0,0,.4)` · overlay pane (narrow) `-20px 0 50px -20px rgba(0,0,0,.3)` · live dot halo `0 0 0 4px rgba(111,207,151,.22)`.

### Icons
The mocks use geometric glyph placeholders (circle, rounded square, square outlined 1.7px). Replace with a single line-icon set (e.g. Lucide, 1.75px stroke) at 16–18px; keep the same slots.

---

## Components

**WhombatAvatar** — use `@whombat/avatars` and the five faces’ SVGs. The original CSS drawing explains construction and palette. Use head variants at small sizes and bust variants for larger portraits; keep them recognizable at 22px.

**Human avatar** — circle, tone bg, 2-letter initials, 600 weight, font size ≈ 0.35× diameter.

**Buttons** — Primary: bg btn, fg btnfg, 600. Secondary: transparent, 1px line2 border, 500. Sizes: 7–9px × 12–16px (14px text), 11–12px × 18–22px (15px text). Mobile min-height 44/52px.

**Chip/filter** — pill, 1px line2 border; active = btn bg + btnfg text + btn border; optional mono count at 70% opacity.

**Segmented control** — 3px padded container, 11px radius, line2 border; items 8px radius.

**Toggle** — track 36×22 (or 34×20), knob 16px #fffdf9, on = ok, off = line2, 150ms translateX.

**Section label** — DM Mono 500 10.5–11px, .05em tracking, mut.

**Role badge** — sf2 pill, 7px accent dot + role name in DM Mono 11px.

**Message row** — grid 40px avatar + 1fr, 14px gap, 28px between messages. Header: name 15.5/600, face badge where the reference shows one, mono time. Body 16/1.55 ink2; `@Name` segments rendered brand/600.

**Chat cards** (max-width 640px, 16px radius, 1px line, sf bg, 18–20px padding):
- **Plan**: label `PLAN · N STEPS` + due date, title, rows [state marker · step · state label]. Markers: done = filled ok circle; active = developer-green outline; queued = line2 outline; **gate** = warn outlined diamond (rotated square) — steps needing a person. CTA "Open plan canvas".
- **Research**: label + source count; rows [name · verdict pill (Pick = green tint, No = sf2) · note].
- **Run**: live dot + `RUN · LIVE`/`RUN · DONE`, branch, title, 6px progress bar (#5aa37a, width transition .6s), current step + test count (warn→ok), buttons Watch run / Branch room, +/− diff stat.
- **Review**: `REVIEW · N CHANGES REQUESTED` in bad, file:line, diff block, numbered comments.
- **Approval**: 1.5px **warn border while pending**; label NEEDS A PERSON / APPROVED · WAITING FOR CHECKS / DEPLOYED / DECLINED; conditions checklist (18px circles, ✓ when met); explanatory message; Approve (+Details) or Undo.
- **Commits**: sha (brand, mono) + message rows, footer diff stat "signed by Banjo".
- **Status pill**: dot + mono text (e.g. checks result).
- **Receipts** (answer citations): `RECEIPTS` label, numbered rows [n in 22px sf2 square · source · where], clicking opens Search. Optional "Open in search".
- **Reactions**: sf2 pills, mono.
- **Thread link**: stacked 24px heads, "5 replies" brand/600, last time.

**Composer** — 16px radius card, line2 border; input 16px; tool chips (`@ agent`, `/ command`, `+ file`) sf2 mono; hint from the applicable Chat reference; Send primary.

**Toast** — bottom-center, btn bg, 14px radius, auto-dismiss 2.6s.

---

## Screens and behavior

- **Shell and Home:** one person, one agent, connected services and servers, needs-you cards and ongoing work.
  Navigation follows the personal shell reference. Settings → Agent changes the name, face, model and keys.
- **Chat:** Enter sends. Each top-level message starts a thread; the agent replies under it. Replies carry on that
  thread. “More detail” asks once for a separate expansion of an agent reply. A message answering a waiting run
  resumes that run in the same place. Status and typing describe the agent’s actual work.
- **Runs and pull requests:** steps, log, checks, reviews, diff and outcome update live. Merging follows the Merge
  key and the repository’s checks/review rules. A manual or approved GitHub merge waits for confirmation; a lost
  answer says it is uncertain and asks the person to inspect the pull request before another attempt.
- **Approvals:** show what the action does, its conditions and current state. Approving in advance waits for all
  conditions. Decisions and execution outcomes are signed; follow the current action’s rules for cancellation.
- **Keys:** Allowed, Asks and Off. The keys engine and the current key catalog decide grantability and scope.
- **Search and canvases:** search answers link to their sources; canvases hold the person’s and agent’s work,
  comments and live edits. The audit log is append-only, signed, filterable and exportable.
- **Getting in:** a claimed box admits the person’s devices by pairing, device link, screen sign-in, passkey or
  recovery kit. The box’s own development page has development sign-in. Identity changes stop the ceremony before
  any recovery proof is sent. Follow the current enrollment screens rather than the original team onboarding.
- **Mobile:** use the current personal navigation and phone references. Controls have labels, visible focus and
  at least 44px touch targets. Approval and message components retain the original mobile reference’s sizing where
  no specific phone reference supersedes it.
- **Theme and keyboard:** light/dark, respecting the system on first use; ⌘K opens search, Esc closes overlays.
  Panes, grids and canvas columns follow the applicable reference’s responsive rules.

## Data and verification

`@whombat/core` defines product schemas; `@whombat/protocol` defines the encrypted session. Reuse those contracts
and the shared `@whombat/client` ceremonies. Visual references are not database models or transport implementations.

`pnpm e2e:managed` and `pnpm e2e:box` cover browser journeys against the fake world. `pnpm e2e:runtime` signs into a
real disposable development runtime, sends a turn through an encrypted session, receives the scripted Hermes reply
and reloads it from Postgres. These complement the visual comparisons and server integration tests.

`TODO.md` belongs to the orchestrator. Preserve it and all reference assets.
