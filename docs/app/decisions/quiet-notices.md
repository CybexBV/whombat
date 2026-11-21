# Quiet notices on the web and in the shared client (AP-4800…AP-4859)

John, 2026-10-22 (main checkout): UniFi said “Access point offline” for an access point he took offline on purpose, and
the only way out was “Look into it”. Every Worth a look line is now a Problem, Only you or a Heads-up, and who may manage
a thing can Ignore a line until it changes, be reminded tomorrow, or stop watching it. What each line is and does is
Whombat's `docs/decisions/quiet-notices.md` (QN-01…QN-24, QN-S*); the wire is contracts 0.122.0 (CT-1060…CT-1068:
`nature`, `check`, `subject`, `ignore`, `quiet` on a line, `things.quiet`, `things.watch`, `things.setWatch`, feature
`things.quiet`, `HOST_WATCH_CHECKS`, `HostAlert.quiet`, `HostHint.quiet`, `HostBanner.alertId`). The client part
(AP-4800…AP-4819) is shared with the phone (AP-4860…, its own file); the web's is AP-4820…AP-4859.

## Shared client (`packages/client`)

### AP-4800 The ⋯ menu is the line's

`quietMenu(line)` is what both apps draw: Ignore with Ignore's own words under it (“Until it’s back online.”), Remind
me tomorrow, and Stop watching {item} (or “Stop watching this” for a line about the whole thing) with the mock's line
under it (`STOP_WATCHING_WORDS`, “Whombat won’t warn about it until you turn this back on.”), with the button's label
“More for {title}”. Only a line with `ignore` (the server sends it to who may manage the thing) and not quiet
already has one: Look only, guests and an older server's lines get no menu.

### AP-4801 Only problems ask

`noticeLink(line)` drops an ask link (“Look into it”) from an only-you line and a heads-up, keeps their other links
(where it's done, what shows more), and gives a quiet line no link at all (its Undo is its button). An older server's
line reads its kind from its tone and link (`noticeNature`), so its links stay as they were.

### AP-4802 A quiet line

Greyed at the bottom of its panel with `quietLine` (“Ignored by John until it’s back online”, “Snoozed by John until
tomorrow 09:00”, “Ignored until …” when the hosts service acknowledged it without a person), and Undo for who may quiet
it (`quietUndo`: the line still carries `ignore`). It counts for nothing: the panel's count is the active lines only
(`activeCount`).

### AP-4803 What Whombat watches as rows

`thingWatchView(watch)`: one switch per check in the server's order, “Off since 20 Oct (John)” under one switched off,
and the exceptions under it as chips, “Garage AP until it’s back”, “Attic AP always”; one about the check as a whole is
called “Ignored” or “Snoozed”. Each chip's Undo watches the item again (`stopped`) or takes back the ignore or snooze
(`things.quiet` `undo`). Without `mayChange` the same rows without switches or Undo.

### AP-4804 One hook for every quiet action

`useQuietActions(burrow, thing, {timeZone, note})`, per thing (a connection, a device, `server:<id>`): `ignore`,
`snooze`, `stop` (a line), `undo` (a ref), `watch` (a switch or an item, on or off) and `busy`. The line changes the
moment it is pressed — greyed and moved to the bottom (`withNoticeQuiet`, `expectedQuiet`: Ignore's words, or 09:00
tomorrow in the Whombat's zone), or gone (`withoutWatchedLines`) — on a connection's page (`things.page`) and a server's
(`hosts.getServer`: `withServerNoticeQuiet`, `withoutServerNotices`) and in What Whombat watches (`withWatched`); the
answer's `quiet` (with who) or watch list replaces the guess; a refusal or failure puts everything back and says the
server's words (`note(message, {failed})`). Afterwards the page, What Whombat watches, the server's fleet, Home, Watch
and Activity are read again.

### AP-4805 The toasts

`QUIET_TOASTS`: Ignore “Ignored. You’ll hear if it changes.”, Remind me tomorrow “I’ll remind you tomorrow.”, both with
Undo; Stop watching “Whombat stopped watching Hallway AP.” with Undo (watch it again); a check switched on again “Whombat
watches … again.” without. A line about the whole thing is named in quotes (“Firmware 7.1 for 3 switches”), never by the
check's lower-cased name (it holds product names). Undo on a greyed line has no toast: the line moving back says it.

### AP-4806 Needs you asks only about problems

`needsYouRows` draws `needsYouActions(item)`: “Look into it” is left out of an item whose `nature` is only-you or a
heads-up; without `nature` (older servers, asks) the server's buttons as they are.

### AP-4807 Needs you's shared Ignore says so

`needsYouIgnoreDone(ref, shared)`: on a server alert or a connection, where the Whombat has `things.quiet`, Ignore is the
shared one (QN-21) and its toast is “Ignored. You’ll hear if it changes.”; on an approval or a question, and on an older
Whombat, “Ignored. It won’t show here again.” as before.

### AP-4808 Watch asks only about problems

*Superseded in part by AP-4809.* `watchRows` leaves “Look into it” out of an item whose `nature` is only-you (QN-22
keeps heads-ups out of Watch altogether); without `nature`, as before.

### AP-4809 Watch's Ignore, Bring it back and Ask {assistant} to fix it

`watchActionKinds` (web and phone): an open item *Remind me tomorrow* · *Ignore* after what asks the assistant, a
snoozed or ignored one *Bring it back*. What asks: *Look into it* on a problem (or an item without `nature`), **Ask
{assistant} to fix it** (`watchActionLabel`, the agent's name) on an only-you item with `fixable`, nothing otherwise.
Fix it starts a chat as Look into it does, with `fixText` (title, the item's words, “Can you fix it?”). Ignore says
“Ignored. You’ll hear if it changes.” on a server's, connection's or device's line, “Ignored.” on a failed run
(`watchIgnoredText`); Bring it back is `useBringBackWatch`, “It’s back on Watch.”. A quiet item reads “Ignored” where it
read “Acknowledged”, in the group “Snoozed or ignored”. Whombat quiet-notices.md QN-25, QN-26.

### AP-4810 A server's lines are built here, from `HOST_WATCH_CHECKS`

A server's page has no `things.page`: `serverDashboard` (Summary) and `serverWatch` (a tab's notices) give each open alert
and hint its check (`hostAlertCheck`, `hostHintCheck`), its kind (a hint's warning may differ, `hostHintNature`), its item
(`hostNoticeSubjectId` of the entity, alerts and hints alike; a hint's entity from its id when an older field is empty;
named as people know it: a guest by its name, a sensor by its label, else the entity without its prefix;
`serverNoticeOptions`), Ignore's words when the viewer may quiet it (`quiet`: the runtime has
`things.quiet` and `things.watch` says `mayChange`), and its quiet: the runtime's `quiet` on the alert or hint (CT-1068),
else an older runtime's acknowledged alert, read as ignored (or snoozed until its time) by nobody named. Lines of checks
switched off never arrive (the runtime leaves them out).

### AP-4811 Their order and links

Worth a look on a server: what asks by tone (serious first), then heads-ups, then quiet lines; alerts before hints within
each. A problem alert asks (“Look into it”); an only-you alert or a heads-up opens its tab instead (Open Storage), none
without one. A hint keeps its way to a fix; a problem hint without one asks with its own question.

### AP-4812 “N to look at” counts what asks

`lookCount`: open alerts that ask for attention (not acknowledged, muted, suppressed or quiet) and warnings among the
hints that aren't heads-ups or quiet. pve-02's warm CPU (`sensor.near_limit`, a heads-up) no longer makes it “1 to look
at”; its badge is the hub's own words (“Running warm”). Muted and suppressed alerts stay as lines in their colour but
don't count.

### AP-4813 The banner is its alert's

The banner is matched to its alert by `alertId` (an older hub's by title, then severity and section), carries that
alert's check, item, kind and Ignore (its ⋯ menu quiets the alert) and its kind's link; a quiet alert has no banner (it is
greyed in Worth a look instead), and the banner's alert isn't said twice.

### AP-4814 Fixtures

`withQuietFixtures` (hosts fixtures) answers `things.quiet`, `things.watch` and `things.setWatch` for `server:<id>` and
reads a server's page through them as the runtime does; What Whombat watches lists the checks the server raises now and
four every server has.

## Web (`apps/web`)

### AP-4820 The ⋯ is the app's menu button

`NoticeMenu`: `MenuButton` and `ContextMenu` (which gained a `width`; 264 px here, so “Until there’s a newer version.”
fits on one line under Ignore) opened from a 30 × 28 bordered icon button at the line's end, after its link and its own
button; arrow keys, Esc and a click outside as in every menu. Its name is “More for {title}”. Stop watching is apart, a
line above it.

### AP-4821 Toasts

`useThingQuiet` gives the shared hook the app's toast: Undo in it (6 s, WX-09) where the action can be taken back, a
refusal or failure in the server's words for 6 s. Without `things.quiet` there are no actions at all.

### AP-4822 A line in Worth a look

The link its kind keeps (`noticeLink`: no “Look into it” on an only-you line or a heads-up), its own button, then the ⋯
menu for who may quiet it. A quiet line: its icon without colour (on `--sf2`), its title in `--mut`, “Ignored by Mara
until it’s back online” in place of its detail, and Undo (a text link like the line's own) instead of its link, button
and menu. Banners (“Right now”) are drawn the same way, so a server's banner has the menu of its alert.

### AP-4823 What counts in the panel

The count after “Worth a look” is the lines that aren't quiet; with none, “Nothing needs a look.” shows above the greyed
ones. The fold after five (DS-05) counts every line.

### AP-4824 Older Whombats

On a Whombat without `things.quiet` nothing changes: no menu, no Undo, no What Whombat watches; a connection's Settings
tab says it has nothing to set as before; a server tab's alert keeps “Remind me tomorrow” (the hosts service's
acknowledgement for a day).

### AP-4826 What Whombat watches on Settings

`WatchSettings` (`things.watch`): a card after what Settings → Connections shows for the connection or device (alone
when there is nothing else to set): a row per check with the app's small switch, “Off since 22 Oct (Mara)” under one
switched off, “Not for:” and a chip per exception (“AP Paardenstal until it’s back online”, Undo in it, who and when as
its tooltip). Look only and guests (`mayChange` false): the switches greyed, no Undo. Switching or Undo goes through the
same hook (toast: “Whombat stopped watching “Firmware updates waiting”.” with Undo, “Whombat watches … again.”).

### AP-4827 A server's What Whombat watches is on System

Servers have no Settings tab on the web; their settings (what Whombat may do there, its agent) are on System, every
kind's (plain, Proxmox, Unraid, Incus, QEMU/KVM): What Whombat watches goes there, before the agent's card, for
`server:<id>`.

### AP-4828 A server's lines

The Summary (Worth a look and the banner) and the notices on Sensors, System and Unraid's Array get the same menu and
Undo. Who may quiet them is read once a minute from `things.watch` (`mayChange`, owners) with the feature
(`useServerQuiet`); the lines and their quiet come from the client (AP-4810…AP-4813). On a tab, “Look into it” is a
problem's only.

### AP-4830 Needs you

Home's Ignore on a server alert or a connection says “Ignored. You’ll hear if it changes.” where the Whombat has
`things.quiet` (`needsYouIgnoreDone`); Undo as before. Look into it is left out of only-you items (AP-4806).

### AP-4831 Fixtures

UniFi's lines carry their kind, check, item and Ignore (the firmware line is a heads-up now), and the web's own pages
read through a small quiet store (`quietFixtures.ts`: quiet, watch, setWatch, the page fine once its problems are
quiet); the service pages' quiet is `@whombat/fixtures`', a server's `withQuietFixtures`. Mara is who quiets.

### AP-4832 Against the mock

Checked at 1440 × 900 in both themes (UniFi's Summary with the menu open and a line ignored, its Settings, pve-02's
Summary and System). Where the app differs from the quiet mock, on purpose: Ignore is just “Ignore” with its words under
it (John, 2026-10-22); the ⋯ is the app's icon button and the menu the app's; a quiet line keeps its own icon, greyed,
instead of “–”; Undo and the chips' Undo are the app's brand-coloured text links; the switches are the app's small
`Toggle`; in the Summary's side column Worth a look is narrow, so the menu opens over the card. There is no mock
comparison spec: the quiet mock isn't a design-handoff reference.

### AP-4833 Narrow cards keep the title readable

A line's link, button and ⋯ stay together. In a card at least 420 px wide they sit at the line's end as before; in a
narrower one (the Summary's side column at 1440 × 900) they take a row of their own under the words, the link at the
left and the ⋯ at the right, so “4 updates available” keeps the card's width instead of wrapping word by word next to
“Install them on the System tab”. A line with only its ⋯ or Undo keeps it at its end. A size container query on the
card (`card`), so it follows the card, not the window: at 1280 the side column goes under the main one and is wide again.

