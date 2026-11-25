# Looks ahead (LKA)

John, 2026-11-25: ChatGPT's “Dots” posted unasked that a concert starts at 20:45, not 20:00 as in his calendar, that a
football match is next to the venue, and that a booked event is full with no confirmation in his mail. He asked the
Council how Dusty could do this. The Council's design, a sibling of Looks for the person's calendar, and a mockup
followed. John chose: **on by default**, Dusty may **read mail and use the Brave key unasked**, family plans are on a
**separate Family calendar**, a finding **pushes**, **one thread per event**. A second Council round looked at the other
connectors and advised none in this first version (calendar and mail first). He then said: build it; incoming mail may
be read; for the rest my own judgement. Mail as a source of its own (things waiting in mail, like a slot to pick) comes
later.

The morning and evening brief stays removed (`brief-removed.md`): Looks ahead posts only a finding, never a summary.

## What it does

| # | Decision | Why |
|---|---|---|
| LKA-01 | **The afternoon before, Whombat has the assistant check what is on the calendar.** A home job every five minutes (`looks-ahead/watch.ts`) reads the person's calendars and begins the check of the soonest due event: tomorrow's from 14:00 today, today's at once, never one closer than 90 minutes. Whombat wakes the assistant (trigger `ahead`); it never wakes itself. | John's Dots examples are the evening-before kind: there is time to change plans. |
| LKA-02 | **Which events**: timed, one-off events with a real place, that the person didn't decline and isn't only invited to (`aheadSkip`): not all-day, not an occurrence of a repeating event, not an online meeting, not an invite nobody answered. One event on two calendars is checked once. | Everyday things repeat and online meetings have no place to get wrong; an unanswered invite may be a stranger's, whose text would steer the check. |
| LKA-03 | **Which calendars**: every calendar of the person's Google and Microsoft 365 accounts the person can add to and shows, so their own and a shared Family calendar are in and subscriptions (holidays, birthdays) out; the person switches any of them in Settings (`calendarIsOn`). Kept as changes from that default. | John's family plans are on a separate calendar; a calendar connected later follows the default without a chore. |
| LKA-04 | **Once per version**: an event's version is its title, times and place (`aheadVersion`). The same version is never checked twice; a changed one is checked again, unless the event already had a finding (its thread is where it goes on). A check whose turn failed is tried once more. | A moved concert is a new question; a finding the person answered isn't. |
| LKA-05 | **Budgets**: one check at a time, at most 4 a day, nothing more after 2 findings that day, and only from 08:00 to 21:00 in the Whombat's zone; only while a turn of the person's could run (`providerReadiness`). | A full calendar must not use up the person's AI allowance, and nobody wants a message at night. |
| LKA-06 | **On by default.** Settings → {assistant} → Looks ahead has the switch, the calendars and the kinds the person stopped; the assistant reads and changes it as the person asks (`looksAhead.get`, `looksAhead.update`, `ASSISTANT_SETTINGS` page `agent.ahead`). | John: on. What Whombat watches starts calm (watch-defaults.md) is about checks of services; this is the assistant's own help the person asked for. |

## The quiet check

| # | Decision | Why |
|---|---|---|
| LKA-10 | **The person's turn, on the background model, in a thread that isn't there yet.** The check's row holds a message id; the turn's thread root is that id, so it has a place of its own (no turn of the person's waits for it, nothing of theirs joins it: `ahead` is one of the turns that never merge, and takes no follow-ups) and its first message exists only if it finds something. The turn reads no conversation. | Silence when nothing is found, and no collision with what the person writes in Chat meanwhile. |
| LKA-11 | **Nothing shows it at work**: no “is thinking”, its final text is never posted, a failure posts no card and isn't carried on after a usage limit. The Work view lists it (“checking something on your calendar ahead”). | Most checks find nothing; a check the person sees and then hears nothing of is noise. |
| LKA-12 | **What it may use, in code** (`AHEAD_TOOLS`, `mcp/served.ts`; Hermes's policy blocks everything else): `calendar_events`, `mail_search`, `mail_read`, `search_web`, `read_web_page` and `ahead_report`. No writes, sends, memory, notes, settings, Vault, connections, servers, browser, commands, helpers, nor Hermes's own web search. The calendar and mail run only where their keys are Allowed: nobody is there to say yes. | It reads strangers' text (mail, web pages) while it holds the person's: what it can reach is what an injected instruction could reach. |
| LKA-13 | **Nothing it read is kept**: Hermes's memory and skill tools are blocked in the turn, and the post-answer review runs under the same policy; the turn never resumes or records a session, so the person's reply in a finding's thread starts a fresh session from what was posted. | Hidden text in a mail or a page must not land in what the assistant remembers or steer a turn that may act. |
| LKA-14 | **The web, through Whombat**: `search_web` is a Brave search on the person's own key (public words only, at most 4 a check); `read_web_page` reads a public page as text (`lib/outbound.ts`: public addresses, a size cap, at most 6 a check) and only a link the check saw exactly — in the event, in a search result or on a page it read; a redirect only within the site or to a link it saw. Mail links aren't opened. | A made-up address could carry private words out; a mail's link could tell its sender the mail was read. |
| LKA-15 | **It ends with `ahead_report`**, once: `found: false` (the usual end; nothing posted, nothing kept but the row), or one finding of a fixed kind (`time`, `place`, `cancelled`, `tickets`, `crowds`, `travel`, `other`), one to three sentences in the person's language and one to four sources, each a page it read or found or a mail it read (checked by the server). | “Sourced or silent”: a finding the person can verify, and a kind they can stop. |

## A finding

| # | Decision | Why |
|---|---|---|
| LKA-20 | **One message in a thread of its own**, by the assistant in the person's Chat: its words, then its sources on one line (a page as a link, a mail by name). The person's Chat tells them as any message of the assistant's there: inbox and push. | John: push, one thread per event. |
| LKA-21 | **Quick replies “Not useful” and “Stop checking for this”**: the person's own words, which the assistant acts on in their turn in that thread with `ahead_feedback` (`not_useful`, or `stop_kind`, which adds the kind to the setting). Their own words work the same way. No card and no new buttons in the apps. | Works on every app already out there, and in any words. |
| LKA-22 | **Not told**: a finding of a kind the person stopped, or a third finding that day, is kept quiet (its kind kept for the count, its words not). | The person's stop holds; two messages a day is plenty. |
| LKA-23 | **The thread settles after the event**: two hours after it ends, when the person didn't write in it (as a look's thread settles, `settleResolvedThreads`). Rows go a month after their event. | The question is over once the plan is. |

## Later, not now

- Mail as a source of its own: things waiting in mail without a calendar event (a slot to pick, a move to confirm).
  John said incoming mail may be read; it needs its own design (outsiders' text as the trigger, not the person's
  calendar).
- Connectors as evidence for an event (the Council's second round): business invoices or CRM tasks before a meeting,
  tickets in Drive or Paperless. Never: Find My unasked, 1Password, media, server health (that is Looks).
- A thread icon with the event's date, travel time.
