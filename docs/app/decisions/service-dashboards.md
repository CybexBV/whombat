# Service dashboards on the web and in the shared client (AP-4530…AP-4629)

John, 2026-10-21 (main checkout): a service's page shows what is in it, what is happening, what is wrong and a few
buttons, not only how it runs (“when we have Plex connected and I click on Plex I would rather see the current movie
library, issues it may have, etc … Home Assistant, we should show a dashboard with buttons and lights that we can
operate”). What each page shows is Whombat's `docs/decisions/service-dashboards.md` (SD-01…SD-70, SD-S*); the
building blocks are contracts 0.121.0 (CT-1000…CT-1014: pictures, buttons, galleries, controls, `refreshS`). The
client part (AP-4530…AP-4559) is shared with the phone (AP-4630…, its own file); the web's is AP-4560…AP-4629.

## Shared client (`packages/client`)

### AP-4530 One view of a button

`thingButtonView` turns a `ThingPageButton` into what both apps draw: its label, icon, tone (`primary` filled, `danger`
in the bad colour), whether it is disabled, the server's reason, and its question. `thingButtonKey` (action, target,
value) tells buttons apart: which one runs, a list's key; a switch's key carries the value it sends.
`thingActionBody` is what `things.action` gets: the button's action and target, and its value or the one the client
chose (a switch's `!on`, a stepper's figure).

### AP-4531 Not allowed is visible

A button the viewer may not press (Look only, not theirs to manage) is drawn in place, greyed, never hidden, with the
server's `reason` as its tooltip and its description (SD-07). Pressing it does nothing. Without a reason it is still
greyed: the server always sends one, and the app doesn't invent words for it.

### AP-4532 A switch sends the state it isn't in

A control's `toggle` sends `value: !on` (`switchValue`), as CT-1005 says; the toggle's own `value` is ignored.

### AP-4533 A stepper waits for the presses to stop

Each − or + moves the shown figure one step on the stepper's grid (from `min`, by `step`; `stepperNext`, kept within
`min`…`max`); 700 ms after the last press (`STEPPER_SEND_MS`) the last figure is sent once (`useStepperDraft`). Coming
back to where it was sends nothing; leaving the page with a figure not sent yet sends it. The figure has as many
decimals as the step (`21.0 °C`, `21.5 °C`) so it doesn't jump in width.

### AP-4534 What a control shows while its change is on its way

A switch or stepper shows what the person set at once (`useControlGuesses`) and keeps it until the page is read again
after the server answered (the query's `dataUpdatedAt` past the answer's time, `settleGuesses`); then the page's own
state shows, whatever it is. A refusal, a failure or a cancelled question puts the page's state back at once. No Undo:
the switch is the way back (SD-08).

### AP-4535 Live pages

An open page reads again every `refreshS` seconds, never more often than every 5 seconds, a minute without one
(`thingRefreshMs`; CT-1010, SD-09). Reading waits while the page isn't shown (the web's hidden tab: TanStack Query's
interval waits for focus; the phone: while the screen isn't focused), and a live page (`thingPageIsLive`, under a
minute) reads at once when it is shown again.

### AP-4536 Galleries' shapes and links

`THING_IMAGE_RATIO` (2 / 3, 16 / 9, 1 / 1) is the box a picture keeps; `thingItemLink` says where an item leads (the
app's page when it has `href`, else the service's own page, `url`, in a new tab; CT-1004); `thingProgressPct` whole
percent within 0…100; `thingImageInitial` the letter an empty box shows (the title's first letter or digit);
`thingGalleryWords` an item's name for screen readers (title · sub · badge · note).

### AP-4537 Pictures load like attachment images

A picture is a resource, `{kind: 'thing-image', burrow, thing, ref}` (`thingImageResource`): `things.image` over HTTP
(`thingImagePath`), the session's `thing-image` download where the client talks through a session, and the fake
appliance's download for tests. Its cache key is a hash of burrow, thing and ref (a ref is up to 600 characters; the
phone's cache file names are cut at 120). The client never builds or reads a ref (SD-06). A picture is the same picture
as long as its ref is: one that changes (a camera's snapshot) comes with a new ref from the server.

### AP-4538 One runner per page

`useThingButtons(burrow, thing, note)` presses a page's buttons: one with a question opens it (`asking`, the web's
dialog, the phone's sheet) and runs on “yes”, busy until the answer; one without runs at once. Several may run at once
(two lights switched quickly), each busy by its key (`running`). `press` takes the value to send and two hooks:
`onSend` (after the question, just before it is sent) and `onDone` (answered, failed, or the question cancelled).

### AP-4539 After a press

The page is read again at once (SD-09: every answer, whether or not it says `refresh`), and its Activity
(`changes.list`); Home is read again only when the press left a change in Done recently (`changeId`; everyday switches
don't, SD-08).

### AP-4540 The server's words, either way

`note(message, outcome)` gets the server's `message` on success, and on a refusal or failure its words too: an
approval waiting (“That needs an approval first …”), a refused change, or the error's message (`hostErrorInfo`). The
app shows them as it shows a change's outcome (the web's toast, the phone's toast).

## Web (`apps/web`)

### AP-4560 Buttons

Small outlined buttons with their icon first, the size of a table's cell buttons (13 px, 4×10, small radius): on a
panel's head, in a table cell, on a list line, under a gallery item, on a control; `primary` filled, `danger` in the bad
colour (and its question's button the serious one). A page's own buttons (CT-1014: Check for updates, Arm) sit in the
head beside Restart, the same size. The question is Restart's dialog (`ConfirmDialog`), one per page, busy while it
runs; it closes when the answer came, and the toast says how it went — a failure in the server's words, up for 6 s.

### AP-4561 Disabled but reachable

A disabled button is `aria-disabled`, not `disabled`: it stays in the tab order, so a keyboard or screen reader user
hears it and its reason (`aria-describedby`), as a mouse user sees the tooltip. The same for a switch and a stepper's
− and +.

### AP-4562 Pictures through the session

Every picture is read through the client's session into a `blob:` object URL (`thingImages`, a bounded cache of
32 MB): HTTP `things.image` on the self-hosted server and in fixture mode, the `thing-image` stream on a managed
Whombat (sharing the attachments' cache, cleared with it). One path for every transport, a loading and a failed state
in every one, and a picture already held draws at once. The CSPs already allow `blob:` images.

### AP-4563 The box, a shimmer, the picture or a letter

A picture keeps its shape's box from the start (`aspect-ratio`), with a quiet shimmer while it loads (still with
reduced motion); it is read once the box comes within 300 px of the screen (`IntersectionObserver`; at once without
one). One that fails, or an item without a picture, shows the title's first letter in the box; nothing else on the page
changes. `alt` is the server's; an empty box with an `alt` is an image of that name.

### AP-4564 Galleries

A grid that fills the card: posters and thumbnails at least 100 px wide (six a row in the main column, two rows for a
dozen), snapshots 200 (three a row), as many a row as fit (under 420 px three posters or thumbnails, one snapshot).
Under each picture: the title and `sub` (two lines each at most), a 4 px progress bar with its note, then the buttons,
stacked the picture's width at the foot of the row's tallest item so a row's buttons line up. A badge sits on the
picture's top left, solid (it must read over any poster), its dot in its tone. The picture and its words are one link —
the app's page, or the service's page in a new tab, whose small outside-link mark shows in the picture's top right on
hover and focus (on every title it was noise, and it took a line) — named by its words in order; the buttons stay
outside it. `at` shows only when there is no `sub`. A muted item (an offline camera) is greyed.

### AP-4565 Controls

A section per group (its title in the label face), tiles at least 200 px wide. A tile: its icon on a small square,
label, state words (warn or bad in their colour), and a switch on the right, a −/+ stepper under the words, buttons under
the words, or a picture on top (a camera). A tile that is on is lit in the second chart colour (orange): its icon and a
faint wash, never the status colours. The panel's `hint` is a line under its title.

### AP-4566 Icons

Lucide, like every icon on the page: buttons (`restart` RotateCcw, `play`, `pause`, `stop` Square, `check`, `close` X,
`retry` RefreshCw, `search`, `lock`, `unlock` LockOpen, `shield`, `up`/`down` arrows, `open` ArrowUpFromLine, `clean`
Eraser, `speed` Gauge, `power`), controls (`light` Lightbulb, `switch` ToggleRight, `fan`, `scene` Sparkles, `script`
ScrollText, `button` CircleDot, `thermostat`, `blind` Blinds, `lock`, `alarm` Siren, `sensor` Gauge, `camera` Cctv,
`plug`, `door` DoorOpen, `media` Tv, `power`) and the new notices (`download`, `camera`, `door` DoorOpen, `media` Film,
`money` Banknote, `shield` ShieldCheck, `certificate` BadgeCheck). A name this app doesn't know: no icon.

### AP-4567 Panel heads

A table's, list's, bar list's, gallery's and controls' `buttons` sit after the title on the right, before the corner
link.

### AP-4568 Live while shown

The page's query reads every `thingRefreshMs` (AP-4535) and, for a live page, again when the tab is shown after it was
hidden and its copy is stale.

### AP-4569 Rows

A cell with `action` draws its button instead of its words (the words are the same, for older apps); a cell or a list
line with `url` opens it in a new tab (`href` wins). A list line with `image` shows it small before its words (a poster
30 px wide, a thumbnail 38, a snapshot 64) instead of its dot or icon; its `actions` sit at its end, under its words in
a narrow card. A notice's `action` sits after its link.

### AP-4570 Marks and names

Sonarr and Radarr draw their Simple Icons marks (16.35.0, CC0) in their own colours. Overseerr's entry is shown as
“Seerr” (CT-1009): the name comes from the catalog everywhere; the mark keeps Overseerr's disc and eye, now named Seerr.

### AP-4571 Fixture mode

The service pages of `@whombat/fixtures` (`createServicePages`, CT-1011) answer `things.page`, `things.action` and
`things.image` for Plex, Seerr, SABnzbd, UniFi Protect and Pi-hole by address, always; their buttons change what the
next read shows. `VITE_FIXTURE_SERVICES=1` (option `services`) also lists them in the sidebar and Connections and puts
Home Assistant's Controls at the top of its page's main column, read every 10 s, its switches, steppers and buttons
answered by the same world (Restart stays the page's own). Off, Home Assistant's page stays as the mock draws it. Their
Settings tabs read `connections.tools` like the other fixture connections. Check them with
`VITE_FIXTURES=1 VITE_FIXTURE_SERVICES=1 VITE_FIXTURE_SHELL=assistant`.

### AP-4572 A badge on a narrow poster

A gallery badge's words sit in their own box that ends in an ellipsis (“Convert…”), so a long badge on a narrow poster
is cut cleanly instead of mid-letter; the tone's dot stays whole.

### AP-4573 Nothing that does nothing

From the end-to-end check against real services: a thing's Activity and its “Changes here” offer no **Review** on a
change that links to the page itself (`doneRows`' `here`; Review only switched to Summary), and the range picker stays
out of the tab row when nothing on the page draws over the range — no chart left and no figure with a small line
(Seerr). The server offers a single range for Pi-hole and AdGuard, which hides the picker (Whombat SD-S21).

## Phone (`apps/mobile`)

The same panels on the phone, stacked in the order given as every Summary (dashboards-mobile.md AP-2120), through the
shared client above. Checked on the emulator (368 × 822 dp, light and dark) in the demo world: Plex, Seerr, SABnzbd,
Home Assistant's Controls, UniFi Protect and Pi-hole.

### AP-4630 Buttons

A button on a panel's head, a row, a gallery item or a control is small and outlined (32dp, padded to 44 with
`hitSlop`; 13/500, its Lucide icon first, 8dp corners; `ThingButton.tsx`); `primary` filled (`btn`), `danger` in the
bad colour, border included. A page's own buttons (CT-1014: Check for updates, Arm) sit in the head beside Restart and
“Open Plex”, 44dp like them, each as wide as its words with the row sharing what is left (“Check for updates” was cut
at a third of the width).

### AP-4631 Disabled, and still answering

A button the viewer may not press is greyed in place and keeps answering a press: the server's reason as a toast
(“Scanning now.”, “Look only: …”), the same words as TalkBack's hint. A switch and a stepper's − and + likewise. A
phone has no hover, so a press is how a person asks why; nothing is hidden. The head also lists its buttons' reasons
under them, as Restart's (CP-12).

### AP-4632 One question sheet, the toast

A button with `confirm` opens Restart's sheet (`OneSheet`: the page's name, the server's title, words and button,
Cancel), busy while it runs, closed when the answer came. The answer's words are Android's toast, a failure's too;
a failure without words says “That didn’t go through.”. A press that is on its way shows a spinner where its icon
was, so the button keeps its width.

### AP-4633 Panel heads

A table's, list's, bar list's, gallery's and controls' `buttons` sit in a row under the card's title and grey words,
wrapping (Pause · Pause 30 min · Half speed). The header's right has room for its link only.

### AP-4636 Galleries

Posters (2:3) in one row that scrolls sideways inside the card, 116dp each so two and a bit show — it says it
scrolls; snapshots (16:9) two by two; thumbnails (1:1) three by three; a short last row keeps its columns' widths.
Under each picture: the title (two lines), `sub` (or when, `doneWhen`), a 4dp progress bar and its note (mono, two
lines: “1 h 10 min of 2 h 46 min · Direct play” doesn't fit one). The badge sits on the picture's top left, solid
`sf` with a dot in its tone, its words ending in an ellipsis on a narrow poster (AP-4572). A muted item (an offline
camera) has its picture at 40 % and its words in `mut`.

### AP-4637 One link, buttons outside

The picture and its words are one link (`accessibilityRole="link"`, named by `thingGalleryWords`): the app's page
(`href`), or the service's own page in the browser with a small outside mark after the title and “Opens in your
browser” for TalkBack. The buttons are outside it, so TalkBack reaches each; a poster's are one under the other at
its width (Approve and Decline don't fit side by side in 116dp), others side by side.

### AP-4640 Controls

A section per group, its title in the label face, tiles two per row of equal height (`sf`, a hairline, 12dp corners,
12dp padding): the icon on a 30dp square, the label (14/600, two lines), the state words (warn or bad in their
colour). A tile that is on is lit in the second chart colour — its icon and a `chartWash` wash —, never the status
colours. The panel's `hint` is a grey line under its title.

### AP-4641 A switch is its whole tile

A `toggle` tile is one 44dp-and-more target with the switch role (checked or not; its state words as the hint):
pressing anywhere on it sends `switchValue(on)`; the Android switch at its top right only shows the state (no presses
of its own, hidden from TalkBack). What the person set shows at once and holds until the page is read after the
answer (`useControlGuesses`).

### AP-4642 A stepper

The figure it is set to on its own line (20/600 mono, as many decimals as its step), − and + under it sharing the
tile's width (36dp, padded to 44). Half a row (about 123dp inside) can't hold “− 21.5 °C +” in one line: the figure was
cut to “21…”. Presses move the figure a step and the last one is sent once they stop (`useStepperDraft`); TalkBack
swipes the figure up and down (`adjustable`, increment and decrement).

### AP-4643 Buttons, pictures and values

A tile with `buttons` draws them under its words, side by side and wrapping (a lock's Unlock in the bad colour, an
alarm's Arm home and Arm away greyed with “This alarm needs its code …”); a camera's picture fills the tile's top at
its shape; a sensor is its value. Those without buttons are read as one (“Outside, 12.4 °C”).

### AP-4644 Table rows

A cell's `action` is a button of the row instead of its words (the words were its label): beside the row when it is
the row's only button (Plex's Scan), else under its words (Approve, Decline). A row without a page of the app opens
its `url` in the browser (the title's first, else a cell's), with an outside mark where the chevron goes.

### AP-4645 List lines and notices

A list line with `image` shows it small before its words instead of its mark (a poster 30dp wide, a thumbnail 38, a
snapshot 64); with `url` the line opens the service's page (an outside mark after its title); its `actions` sit under
its words, lined up with the title (beside them a list's long title kept two words: “Subtitles out of s…”). A notice
with `action` keeps its line and link, its button under its words. A line or notice without these is drawn as before.

### AP-4646 Live while shown

The page reads again every `thingRefreshMs` (its `refreshS`, a minute without one) while its screen is focused; the
app's `focusManager`, bound to AppState, holds it while the app is in the background. Back on a live page whose copy
is older than its interval, it reads at once (`readOnShow`); a page that isn't live waits for its minute.

### AP-4650 Pictures

A picture comes as attachment images do on the phone (`data/thingPictures.ts`): a self-hosted server's `things.image`
with the token on the request (an array source, so Android sends the header); a managed Whombat's `thing-image`
stream through the session into the scoped cache (`resourceToCacheFile`, cleared on sign-out with the rest; two boxes
of one picture share one download); the demo world's drawn here (AP-4651). The ref goes out as it came.

### AP-4651 The demo world's pictures

Fixture mode hands `fixturePictureDataUrl` to the screens through a context (`DrawnPictures`) from its on-demand
import, so the fixtures stay out of the bundle's first load; a ref it doesn't draw shows the title's letter.

### AP-4652 A camera doesn't fill the phone

A snapshot has a new ref every read (SD-S09), so an open Protect page would leave a file every 10 seconds until
sign-out: the phone keeps the 96 pictures last shown and removes older ones' cache directories (`createPictureLru`).

### AP-4653 The old picture until the new one

A picture whose ref changes (a snapshot read again) keeps the one on screen and loads the new one out of sight,
swapping when it has loaded; one that fails leaves the old one. No flash every 10 seconds.

### AP-4654 The box and the letter

The shape's box in `sf2` from the start (`aspectRatio`), so nothing moves when a picture arrives; no spinner (a
gallery of twelve would spin twelve). A picture that can't be had, or an item without one, shows the title's first
letter quietly in the box. TalkBack reads `alt` where the picture is its own element; inside a link the link's words
say it.

### AP-4660 The demo world

`fixtures/thingPages.ts` answers Plex, Seerr, SABnzbd, UniFi Protect and Pi-hole from `createServicePages` (its
`things.action` too: pausing, approving and switching change the next read), and Home Assistant's page has the
Controls first in its main column, read every 10 seconds (SD-30). The five are listed on Home and the Connections tab
only with `EXPO_PUBLIC_WHOMBAT_SERVICES=1`, as the web's `VITE_FIXTURE_SERVICES` (AP-4571), so the demo world's Home
stays mock 4's; their pages open by address either way (`whombat://things/connection%3Acon_plex`).
