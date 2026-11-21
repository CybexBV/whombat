# Service pages in slots on the web (AP-7100…AP-7129)

John, 2026-11-04: the Plex page redesign (`~/.cache/wb-tmp/mockups/plex-redesign/`, its `#desktop` section) is
approved, “Implement this fully”. Whombat's decisions are `docs/decisions/service-slots.md` (SLT-01…SLT-12); these are
the web's. The renderer is `apps/web/src/features/things/dashboard/` (`NoticeStrip.tsx`, `Gallery.tsx` rows and shelf,
`Panels.tsx` counts, people and the machine, `TrendCard.tsx`, the pure parts in `slots.ts`, the styles in
`Slots.module.css`).

| id | decision | why |
|---|---|---|
| AP-7100 | **The head is two lines on every thing page** (`PageHead`): the icon (52 px) beside the name, badge, chips and the verdict on one line and the facts under it; Ask, Open and ⋯ on the right. The verdict is a plain sentence without a dot (the badge says the tone); with no room it wraps under the name. A server's page gives its verdict the same way. | SLT-10; one head for servers and connections. |
| AP-7101 | **The fact line is set apart by middle dots** (CSS `::before`, silent to screen readers); the address pill sits in its own span so the dot stays outside it. | The mock's `Runs on thetitan · … · 10.100.0.20:32400`. |
| AP-7102 | **Under 760 px of page the buttons go under the name's two lines** (from the name's edge), under 560 px from the left. | A long name, verdict and three buttons can't share one line on a narrow page. |
| AP-7103 | **A `notices` panel placed `top` draws as a strip** (`NoticeStrip`): one line per notice with its icon on a tile of its tone, “Worth a look” over the first, its link as a small button, its own button and the quiet ⋯ (Undo on a quiet line). A strip with no line draws nothing. | SLT-08. Also a server's “Right now” banner, the other top notices panel. |
| AP-7104 | **The strip shows every line, in the card's order** (what asks, a heads-up with a button, the other heads-ups, the quiet ones; `stripLines`), the first three, then “Show N more”. Heads-ups aren't folded behind their own row as in the card. | A strip is one place to look; quiet lines stay one press from Undo. |
| AP-7105 | **The strip takes the colour of its most serious line that isn't quiet** (`stripTone`): bad, warn, else the info blue; only quiet lines, the plain card colours. Each line's tile keeps its own tone. | The mock's warn wash, without a strong colour for a page of heads-ups. |
| AP-7106 | **Two or more lines that ask get “Ask {assistant} to handle these”** in the strip's foot, beside “Show N more”, as the card has. | Handing everything over stays one press. |
| AP-7107 | **Rows of slots are the existing chart rows**: `placePanels` already packs every chart-placed panel; a two-and-one row keeps its 1.85 · 1 split so its edges line up with the main and side columns of other pages. | SLT-09 without a second grid. |
| AP-7108 | **Live rows** (`gallery` `look: 'rows'`): a 62 px picture, the title (a link when the item has one), sub, the person's initial with name · note and the badge as a small mono tag, then a progress column (272 px at most) with `note` left and `noteEnd` right; grey when `paused`, and a paused item's tag is quiet whatever its tone. In a card under 560 px the progress goes under the words. | SLT-02. |
| AP-7109 | **A row's wash is a warm tint from tokens** (`--brand` 13 % into `--sf2`, fading out), not the poster's colour. | The data has no colour for a picture. |
| AP-7110 | **“1:10:12 of 2:46:00”: the part before “ of ” is set in the ink.** | The mock's emphasis; the rest of the note stays quiet. |
| AP-7111 | **The shelf** (`gallery` `look: 'shelf'`) measures its width and draws as many pictures as fit at 110 px or more with 16 px gaps (`shelfFit`: 8 at 1440 px), never a second row; the ones that don't fit aren't drawn at all, so nothing hidden takes focus. Unmeasured (tests), eight. | SLT-04. |
| AP-7112 | **A shelf picture's person is a small dark-glass tag on it**: their initial and `note` (“Anna asked”), else their name; the link's name ends with it. | SLT-04; the mock's “Anna asked”. |
| AP-7113 | **A person's initial sits on one of the five human avatar tones, picked from their name** (`personTone`), so Anna has one colour in Now playing, on the shelf and in Who watches. | The data has no tone for people outside Whombat. |
| AP-7114 | **Counts** (`list` `look: 'counts'`): a 38 px icon tile, title and detail, `figure.value` large with `figure.note` under it (green for `ok`, warn and bad by tone, else quiet), then the line's buttons as glyphs named by their label (Scan Movies). Without a figure, `right` stands in. | SLT-03. |
| AP-7115 | **`ThingButton` has an `icon` look**: its glyph alone in a 30 px ghost button, the label as its name and its title; a reason stays as before. | Counts need a quiet Scan beside every line. |
| AP-7116 | **The library icons**: film → Film, tv → Tv, music → Music, photo → Image, video → Video (Lucide). | SLT-03's new names. |
| AP-7117 | **People** (`bars` items with `person`): a 30 px initial, name over the note, the value in mono on the right, a 4 px bar under the words in the blue at 60 %. | SLT-05. |
| AP-7118 | **A chart with `labels` is a Trend card** (`TrendCard`): the card's own head (title, meta, Ask), the figure large with its rest and each stats line as a quiet tag beside it, then bars with the words under them, the last bar and word in full colour; hovering a bar shows “Thu · 5 plays”, and each bar is a list item named so for a screen reader. Stacked series stack. A line chart with labels draws on the chart engine with the words as its ticks and tooltip. | SLT-06. |
| AP-7119 | **A chart with labels keeps out of the range picker** (`rangeInTabRow` skips it), and `chartModel` uses the labels for ticks and tooltips. | Its words aren't times; a page whose only chart is the week has no picker. |
| AP-7120 | **The week's change has no colour** (“+18 % on last week” on `--sf2`): a stats line carries no tone, and up isn't always good. | The mock's green can't be told from the data. |
| AP-7121 | **A one-column `bars` panel in a row of slots draws as the machine**: name over note and sub, the value with a 64 px meter (green unless its tone says otherwise) on the right, a hairline between lines. | SLT-07; the mock's “status words right, small meters”. |
| AP-7122 | **A card whose link names its meta** (“thetitan” and “See thetitan”) makes the meta the link and drops the corner link; the link keeps its full words for a screen reader. | SLT-07's “meta linked to its page”; a narrow card's head stays on one line. |
| AP-7123 | **The web fixture's Plex page asks about Recently added, This week and The machine too**, as the mock shows Ask on them. | The visual check against the mock. |

Not done: the mock's machine rows have icons and status words (“Quiet”, “Plenty left”) the data doesn't carry; the
Libraries footer (“Plex scans by itself every 2 hours”) isn't in the data. The head's Plex mark stays on its plain tile
(no brand colours outside `@whombat/brand`).

Checked with `pnpm check` and the fixture world at 1440×900 in light and dark against `shot-desktop-*-1400.png`, plus
1100 and 760 px wide and the Seerr, SABnzbd, Home Assistant and Pi-hole pages.
