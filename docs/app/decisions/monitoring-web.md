# Monitoring on the web (AP-9930 … AP-9940)

The web side of Whombat's monitoring (docs/decisions/monitoring.md MON-01…MON-16), built on 2026-11-24 from the
server's contracts at session minor 9. No mock covers these parts: they are made of the thing pages' own pieces (the ⋯
menu, a dialog with radio cards and fields, a strip row, a card of rows, toasts with Undo). What web and phone share is
in `@whombat/client` (`home/monitoring.ts`, `react/monitoring.ts`); the phone's choices are in
[monitoring-mobile.md](monitoring-mobile.md).

## AP-9930 Keep quiet… is in the page's ⋯

Every connection's, device's and server's ⋯ has “Keep quiet…” for who may change what Whombat watches there
(`things.watch` says `mayChange`), on a Whombat at minor 9. It opens a sheet: “Keep <name> quiet”, one sentence of what
that means, How long as radio cards with when each ends under it (For an hour, Until tonight, Until tomorrow morning,
Pick a time), the time field when picking one, an optional note, Cancel and Keep quiet. The toast says until when with
Undo, which ends it.

## AP-9931 Tonight is 23:00, tomorrow morning is 09:00

Until tonight ends at 23:00 and is offered from 05:00 until half an hour before it; Until tomorrow morning ends at 09:00
(Remind me tomorrow's hour), this morning's before 05:00. An hour is sent as minutes, the rest as their end; a picked
time must be at least 5 minutes ahead and at most a month (the contract's limits), said under the field.

## AP-9932 The hold is one line under the head

While a page has `keptQuiet` or `causedBy`, one row under the head says it, drawn like a row of Worth a look's strip:
the words in bold, who kept it quiet beside them, and End now for who may end it; or why it isn't answering with a link
to the cause's page (“Open homeassistant”). Worth a look's first heads-up line with the same words
(`quiet-window`, `quiet-cause`, for apps that don't draw the hold) is left out then.

## AP-9933 Held lines say why and offer End now

A line quiet because the whole thing is kept quiet says “Kept quiet by Mara until 23:00” and offers End now instead of
Undo; one quiet because of its cause says “Quiet while pve-02 is down” and offers neither (it lifts when the cause is
back). In the strip they fold under their own “Show 3 kept quiet”; in the card they count as “kept quiet” in its fold.

## AP-9934 What lists say about a held thing

Overview's tiles say a thing down because of something else (its cause's words, a grey dot) or kept quiet (“Quiet
until 23:00”) whatever view the tile shows, and don't repeat the words in the foot. The sidebar and the rows keep the
server's line, which already says the cause.

## AP-9935 What happened ends the Summary

At the end of every thing's and server's Summary (before a server's Technical details), a card “What happened” lists the
incidents of the last 30 days, newest first, five then “Show N more”: what it was, when and how long (“Mon 07:31 ·
41 min”, “still going”) and its cause. One still going has its tone, past ones are grey. The period's uptime is the
card's line beside its title; “Show 90 days” switches. A server's own alerts fold under “Show N alerts from the
server”. Nothing in the period: “Nothing went wrong in the last 30 days.” Not drawn below minor 9.

## AP-9936 The week's uptime

A server's head has its week (`HostServerDetail.uptime`) on its fact line after the read time. A thing page keeps it
where the server sends it, under More detail: the first line stays the status, what it runs on, the address and when it
was checked.

## AP-9937 Change the limit

A server's line whose check has a limit has “Change the limit” in its ⋯, above Stop watching (the gentler way to hear
less), with the limit now under it (“Now 90 %”). What Whombat watches says each check's limit under its name (“Warns
above 85 %”, an item with its own as a chip with Change) with a Change the limit link. The sheet: the check and the
item, the value with its unit, the range and what applies without one under it, Use the default when it has its own,
Cancel and Save. The toast says the new limit with Undo (`changes.undo` of the returned change).

## AP-9938 A catalog field can follow another

A catalog field may say `shownWhen` (another field and its values; that field's default counts while it is empty), so
a form asks only what fits: Website or address asks the address, the word and where it runs from only for what Whombat
probes, how late only for a check-in. The connection's page offers only the choices that fit too. Where it runs from
stays a choice the server gives when connecting (This Whombat and the servers).

## AP-9939 Nothing to sign in to, nothing to choose

A connect form for an entry with neither an address nor a sign-in titles its step “What should Whombat check?”, and an
entry whose two levels let the assistant do the same (Website or address only reads) doesn't ask for a level.

## AP-9940 The fixture world

`monitoring` (`VITE_FIXTURE_MONITORING=1`, `localStorage['whombat:fixture-monitoring']`) starts the fixture world with
blackbox kept quiet until 23:00 (“Moving the NAS”), UniFi until tomorrow 09:00, Home Assistant not answering while its
machine is stopped, pve-02's VM storage over its limit, each page's week and 30 days of what happened. Keep quiet, End
now, the history and the limits answer without it too.
