# Design system

Everything here was extracted from the mockup. Exact values live in `design/tokens.css` (use the names, not the hex) and `design/tokens.json`. When a number here and the static HTML disagree, the static HTML in `design/static/` is right: it is the resolved DOM.

## 1. Principles

1. **Dark, calm, spacious.** One dark theme. Cards on a near-black page, generous padding (24 to 28 px), 24 px gaps, 40 px between sections. The user asked for a "spacious overview"; do not tighten it.
2. **Numbers first.** Big tabular values with small labels. Units and "of N" go on a quieter second line instead of crowding the value.
3. **Color means something.** Status colors (good, warning, serious, critical) are reserved for state. Series colors identify an entity (CPU, memory, a sensor) and never change with the data. Neither is ever the only carrier of meaning.
4. **Thin and quiet charts.** 2 px lines, hairline grid, direct labels, hover for detail.

## 2. Color

### 2.1 Roles

| Token | Value | Use |
|---|---|---|
| `--bg` | #0b0c0e | Page, console tiles, text on primary button |
| `--panel` | #111215 | Cards, segmented control track |
| `--raised` | #181a1e | Hover, selected row, selected platform card, icon squares |
| `--seg-active` | #23262c | Selected segment |
| `--track` | #1b2330 | Meter and progress tracks (blue tinted so blue fills read) |
| `--terminal-bg` | #06080b | Console screen |
| `--tooltip-bg` | #1c1e23 | Chart tooltip |
| `--line` | rgba(255,255,255,.07) | Card borders, dividers, chart grid |
| `--line-strong` | rgba(255,255,255,.14) | Controls, chips, inputs, tooltip border |
| `--line-selected` | rgba(255,255,255,.32) | Selected platform card border |
| `--ink` / `--ink-2` / `--ink-3` | #eceef1 / #aab0ba / #868c97 | Primary, secondary, labels and captions |
| `--focus` | #6da7ec | Focus ring |

### 2.2 Series colors (identity)

Fixed per entity, assigned in this order, never cycled. A filter that removes a series must not repaint the others.

| Entity | Token | Where |
|---|---|---|
| CPU, default single accent | `--series-cpu` #3987e5 | CPU chart, CPU sparklines, vCPU meter, CPU bars in tables, storage meter, CPU temperature line |
| Memory | `--series-memory` #9085e9 | Memory chart, MEM sparklines, memory meter |
| NVMe sensor, disk I/O | `--series-aqua` #199e70 | Temperature line, guest disk I/O sparkline |
| Board / VRM sensor | `--series-orange` #d95926 | Temperature line |
| DIMM sensor, network | `--series-yellow` #c98500 | Temperature line, guest network sparkline |
| HDD / SATA SSD sensor | `--series-magenta` #d55181 | Temperature line |

Sensor order in the temperature chart and table: CPU blue, VRM orange, NVMe aqua, DIMM yellow, HDD magenta.

### 2.3 Status colors (state)

| Token | Value | Meaning | Used for |
|---|---|---|---|
| `--good` | #0ca30c | Online, Running, Healthy, Connected | Dots |
| `--warning` | #fab219 | Warning, above threshold | Dots, bars, banner border, warning icon |
| `--serious` | #ec835a | Past the second threshold | Dots, bars (disk 90%+, wear 90%+), destructive buttons (Force stop) |
| `--critical` | #d03b3b | Offline, critical alert | Dots, alert badge fill |
| `--critical-text` | #ef6b6b | Critical alert icon and title on dark | Text and icons only |
| `--muted` | #4a4f58 | Stopped, offline stat dots, no data | Dots |

Alerts have two severities only (critical, warning). `--serious` is a data color, not a third alert level. Never use a status color as a series color or the other way round.

### 2.4 Heatmap ramp

Seven bins of one hue (`--heat-0` to `--heat-6`), upper bounds exclusive: 8, 20, 35, 50, 65, 80, and 100 inclusive for the last bin. No data = transparent with `inset 0 0 0 1px rgba(255,255,255,.08)`. Lightness increases with load, so the ramp reads without hue.

## 3. Typography

- **Geist** (400, 500, 600) for UI, **Geist Mono** (400, 500) for hostnames, device names, IDs, IPs, sensor sources, guest names, and all console text. Files in `design/fonts/` (SIL OFL 1.1; licenses included). The static snapshots load them from there.
- Base: 14 px / 1.45. Line height 1 for big numbers.

| Role | Size / weight | Notes |
|---|---|---|
| Caption, label (`.lbl`) | 12 / 400, `--ink-3`, +0.01em | Field labels, axis labels, chart captions |
| Table and control text | 13 / 400 or 500 | Table body, segmented control, buttons, sub-lines |
| Body | 14 / 400 | Default |
| H2 (section title) | 16 / 600, -0.01em | "Servers", "Storage" |
| Card hostname (fleet card) | mono 20 / 500, -0.01em | |
| Sidebar brand | 17 / 600, -0.02em | |
| Disk device | mono 17 / 500 | |
| H1 page title | 30 / 600 ("Overview"); mono 30 / 500, -0.02em (hostname) | |
| KPI value | 34 / 600, -0.025em | `white-space: nowrap` |
| Card metric (CPU/MEM on a card) | 18 / 600, -0.02em | |
| Chart current value | 40 / 600 | |
| Platform count | 44 / 600 | |

Minimum text size is 12 px. Do not go below it on mobile.

## 4. Space, shape, layout

- Radius: card 14, tile/panel 12, control 10 to 11, chip 999, meter 3. Selected/focus rings follow the element radius.
- Card padding 28 (24 for dense cards and KPI tiles). Grid gaps 24 (20 for the KPI row). Section gap 40. Main padding 36 / 48 / 80.
- Sidebar 240 px; below about 800 px it wraps above the main column.
- Breakpoints are fluid (`auto-fit` and `minmax(min(Npx,100%),1fr)`), not fixed media queries. The mockup was checked at 1440 and 390 px. Never produce horizontal page scroll; tables scroll inside their card (`overflow-x: auto`).

## 5. Components

Each component's measured sizes are in `SCREENS.md`; this is the catalog.

| Component | Spec |
|---|---|
| **Card** | `--panel`, 1 px `--line`, radius 14. Clickable cards raise to `--raised` + `--line-strong` on hover (150 ms). |
| **Segmented control** | Group with `role="group"` and an `aria-label`. Track `--panel`, 1 px `--line`, radius 11, padding 3, gap 2. Buttons: 36 px min height, 0 14 px padding, radius 8, 13 px; selected = `--seg-active` + `--ink`, others `--ink-2`; hover `--raised`. `aria-pressed` on each button. |
| **Primary button** | `--ink` bg, `--bg` text, 500, radius 11, 44 px high, 0 18 px padding, 16 px leading icon, 8 px gap. |
| **Ghost button** | Transparent, 1 px `--line-strong`, radius 9 to 10, 13 px; 32 px (row action) or 36 px (toolbar). Disabled = 40% opacity. |
| **In-card primary button** | Same look as the primary button but 40 px high, radius 10, 14 px (the console's "Start VM"). |
| **Chip** | 12 px `--ink-2`, 1 px `--line-strong`, radius 999, padding 3 x 10, no wrap. Optional leading dot. |
| **Status dot** | 8 px circle. Always next to a text label or inside a labeled row. |
| **Meter** | Track 6 px, radius 3, `--track`; fill same height and radius. Fill color per threshold rule. The vCPU meter adds a 1 px tick at the 1 : 1 position (50% of width). |
| **KPI tile** | See `SCREENS.md` 2.2. |
| **Sparkline** | `viewBox 0 0 200 36`, `preserveAspectRatio="none"`, `vector-effect: non-scaling-stroke`, 1.5 px line, 12% area. No axes, no hover. Decorative: `aria-hidden`, the value beside it carries the meaning. |
| **Table** | Header 12 px `--ink-3`; rows 13 px, 14 px vertical padding, 1 px `--line` dividers; stopped rows dim their numbers to "—". Row hover `--raised` for link rows. |
| **Banner** | Card with 1 px border in the severity color at 35% opacity, 18 x 24 padding, icon + bold title + detail + underlined link. |
| **Platform card (tab)** | Card with `aria-pressed`; selected = `--raised` + `--line-selected`. |
| **Disk / guest / cluster rows** | See `SCREENS.md` sections 3 and 4. |
| **Input (filter)** | 40 px high, 240 px wide, `--bg` fill, 1 px `--line-strong`, radius 10, 13 px, padding 0 14 px 0 36 px (leading search icon). Has an `aria-label`. |
| **Tooltip (chart)** | `--tooltip-bg`, 1 px `--line-strong`, radius 10, padding 10 x 14, shadow `0 8px 24px rgba(0,0,0,.4)`. |
| **Icon** | 24 px viewBox, stroke `currentColor` 1.6 px, round caps and joins, no fill. Sizes 15 to 22 px. Outline style similar to Lucide; the exact paths are in the static HTML if you want identical glyphs. Icons are decorative (`aria-hidden`) unless they stand alone (alert severity icons carry `role="img"` and a label). |
| **Console screen** | `--terminal-bg`, 1 px `--line-strong`, radius 10, 16:10. Terminal text uses `--term-*` colors, mono, font size 1.7% of the screen width (container query units), blinking block cursor. |

## 6. Chart rules

1. **One y-axis per chart.** Never dual axes. CPU and memory are separate cards; temperature is one chart with a shared °C axis.
2. **Lines**: 2 px, round joins and caps. **Area** fill: series color at 10% (12% in sparklines).
3. **Grid**: solid hairline `--line`, horizontal only, four intervals. Y labels 12 px `--ink-3` in a 44 px gutter. Percent charts fixed 0 to 100; temperature fixed 20 to 100 °C.
4. **X axis**: five labels (oldest to Now), format by range (`SCREENS.md` 7.3).
5. **Limit lines** are solid 1 px with a text label ("85 °C warning"), not dashed.
6. **Direct labels**: the temperature chart labels the end of each line (CPU, VRM, NVMe, DIMM, HDD) in `--ink-2` text with the line color shown as a swatch; text is never colored with the series color.
7. **Hover**: 1 px crosshair `rgba(255,255,255,.22)`, one 10 px dot per series with a 2 px ring in the card color, tooltip with time and every series' value. Keyboard users get the same through arrow keys on the focused plot (not in the mockup; required in `ACCEPTANCE.md`).
8. **Text equivalent**: show current, average and peak next to every chart; add a "View as table" toggle that lists time and values.
9. **Gaps**: `null` samples break the line; do not interpolate across a missing heartbeat.
10. **Peak** must come from the stored maximum, not from the plotted averages.

## 7. Accessibility facts

### 7.1 Contrast (computed against the token values)

| Pair | Ratio | Verdict |
|---|---|---|
| `--ink` on `--panel` | 16.1 : 1 | Pass |
| `--ink-2` on `--panel` | 8.6 : 1 | Pass |
| `--ink-3` on `--panel` / `--bg` / `--raised` | 5.5 / 5.8 / 5.2 : 1 | Pass for text (AA 4.5) |
| `--focus` on `--panel` | 7.5 : 1 | Pass (needs 3) |
| `--critical-text` on `--panel` | 6.2 : 1 | Pass |
| White on the `--critical` alert badge | 4.8 : 1 | Pass |
| `--bg` on the `--ink` primary button | 16.8 : 1 | Pass |
| `--term-fg` / `--term-dim` on `--terminal-bg` | 13.0 / 5.4 : 1 | Pass |
| Series colors on `--panel` | 4.75 to 6.0 : 1 | Pass (graphics need 3) |
| `--good` / `--warning` / `--serious` on `--panel` | 5.6 / 10.2 / 7.1 : 1 | Pass |
| `--critical` on `--panel` | 3.9 : 1 | Pass for a dot or icon (3.0); do not use for text, use `--critical-text` |
| `--muted` on `--panel` | 2.3 : 1 | **Below 3 : 1.** Acceptable only because every muted dot sits next to a text label (Stopped, Offline) or a dash. Do not use `--muted` for anything that stands alone. |
| `--line-selected` on `--panel` | about 2.8 : 1 | Selection is also shown by the `--raised` fill and `aria-pressed`; consider raising the border to 3 : 1 in your implementation. |

### 7.2 Series palette check

Running the dataviz palette validator on the five **temperature** colors against `--panel` passes all checks (lightness band, chroma, color-blind separation with a worst adjacent pair of dE 8.4, normal-vision separation, contrast). The CVD result is in the "legal only with secondary encoding" band, which the chart has: direct end labels, a legend/table with names, and a tooltip with names.

**Known caveat:** `--series-cpu` (blue) and `--series-memory` (violet) are too close for color-blind users (protan dE 1.9). They are never drawn on the same axes. They appear together only on server cards and the KPI row, where each sparkline has a text label ("CPU", "MEM") in front of it. Keep that pairing, and do not put CPU and memory in one chart without a different mark or texture.

### 7.3 Rules

- Keyboard: every control reachable in visual order; focus ring `2px solid var(--focus)` with 2 px offset on links, buttons and inputs (`:focus-visible`); no focus traps; Esc leaves fullscreen and releases console key capture.
- Targets: 36 px minimum height for buttons and segments; 44 px for the primary button and nav items; table row buttons are 32 px but sit in 44 px rows (WCAG 2.2 target size minimum is 24 px).
- Names: icon-only buttons need an accessible name; segmented controls need an `aria-label` on the group; platform cards use `aria-pressed`; status dots are `aria-hidden` and the adjacent text is the state.
- Live data: do not announce every 10 s refresh. Announce status changes (a server going Offline, a new alert) through a polite live region.
- Motion: the cursor blink and any thumbnail refresh animation stop under `prefers-reduced-motion`.
- Zoom: layout must hold at 200% zoom and 320 CSS px reflow without horizontal page scroll.
- Language and time: set `lang`; render times in the viewer's zone; give relative times a `title` with the absolute timestamp.
