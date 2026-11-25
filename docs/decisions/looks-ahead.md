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
| LKA-01 | **The afternoon before, Whombat has the assistant check what is on the calendar.** A home job every five minutes (`looks-ahead/watch.ts`) reads the person's calendars and begins the check of the soonest due event: tomorrow's from 14:00 today, today's at once, never one closer than 90 minutes. Whombat wakes the assistant (trigger `ahead`); it never wakes itself. It reads the calendar only while the assistant's calendar key is Allowed: an assistant that must ask first doesn't read it by itself. | John's Dots examples are the evening-before kind: there is time to change plans. The person's keys hold for what Whombat does in the assistant's name too. |
| LKA-02 | **Which events**: timed, one-off events with a real place, that the person didn't decline and isn't only invited to (`aheadSkip`): not all-day, not an occurrence of a repeating event, not an online meeting, not an invite nobody answered, not a cancelled one. One event on two calendars or two accounts is checked once, and never through one copy when the person declined or didn't answer another: it is known by its iCalendar id where the provider gives one (so switching a calendar off or their order doesn't make it new), else by its id and the moment it starts. | Everyday things repeat and online meetings have no place to get wrong; an unanswered invite may be a stranger's, whose text would steer the check. |
| LKA-03 | **Which calendars**: every calendar of the person's Google and Microsoft 365 accounts the person can add to and shows, so their own and a shared Family calendar are in and subscriptions (holidays, birthdays) out; the person switches any of them in Settings (`calendarIsOn`). Kept as changes from that default. | John's family plans are on a separate calendar; a calendar connected later follows the default without a chore. |
| LKA-04 | **Once per version**: an event's version is its title, times, place and notes (`aheadVersion`). The same version is never checked twice, failed or not (the runtime's own one retry of a crashed turn is the only retry; a unique index holds it); a changed one is checked again, unless the event already had a finding (its thread is where it goes on). | A moved concert or a new door time is a new question; a finding the person answered isn't; a broken check must not cost four turns. |
| LKA-05 | **Budgets**: one check at a time (a unique index holds it, and a check's turn still at work holds the next back), at most 4 a day, nothing more after 2 findings that day; checks begin from 08:00 until 20:30 and tell only until 21:00 in the Whombat's zone; only while a turn of the person's could run (`providerReadiness`). The switch and the day's count are read again when a check begins; a check no runner took within two hours is over and its turn cancelled, so it never runs late. A calendar's coming events are read at most every 15 minutes. | A full calendar must not use up the person's AI allowance or the provider's, and nobody wants a message at night. |
| LKA-06 | **On by default.** Settings → {assistant} → Looks ahead has the switch, the calendars and the kinds the person stopped; the assistant reads and changes it as the person asks (`looksAhead.get`, `looksAhead.update`, `ASSISTANT_SETTINGS` page `agent.ahead`). | John: on. What Whombat watches starts calm (watch-defaults.md) is about checks of services; this is the assistant's own help the person asked for. |

## The quiet check

| # | Decision | Why |
|---|---|---|
| LKA-10 | **The person's turn, on the background model, in a thread that isn't there yet.** The check's row holds a message id; the turn's thread root is that id, so it has a place of its own (no turn of the person's waits for it, nothing of theirs joins it: `ahead` is one of the turns that never merge, and takes no follow-ups) and its first message exists only if it finds something. The turn reads no conversation. | Silence when nothing is found, and no collision with what the person writes in Chat meanwhile. |
| LKA-11 | **Nothing shows it at work**: no “is thinking”, its final text is never posted, it never makes the assistant or Chat look busy on Home, a failure posts no card, offers no Try again and isn't carried on after a usage limit. The Work view lists it (“looking ahead at something on your calendar”). | Most checks find nothing; a check the person sees and then hears nothing of is noise. |
| LKA-12 | **What it may use, in code** (`AHEAD_TOOLS`, `mcp/served.ts`; Hermes's policy blocks everything else): `calendar_events` (only the event's own calendar, on its own account), `mail_search`, `mail_read`, `search_web`, `read_web_page` and `ahead_report`. No writes, sends, memory, notes, settings, Vault, connections, servers, browser, commands, helpers, nor Hermes's own web search. The calendar and mail run only where their keys are Allowed: nobody is there to say yes. Once Looks ahead is switched off, every tool but `ahead_report` is refused. | It reads strangers' text (mail, web pages) while it holds the person's: what it can reach is what an injected instruction could reach. |
| LKA-13 | **Nothing it read is kept**: Hermes's memory and skill tools are blocked, and its policy says `review: false`, so the post-answer memory and skill review does nothing for it (the plugin gives it a review without a model call, finding the policy by the session the turn is bound to, else the agent's own; in a person's pod a session whose policy can't be read gets no review either; in a turn's own Hermes the review's memory and skill calls still meet the same policy). The turn never resumes or records a session for later turns, and when its turn ends its Hermes session is forgotten and deleted from the person's home (`hermes_session_drops`; the watcher's pass forgets any that slipped through). While it runs, a turn of the person's could find it with Hermes's session search; it holds nothing such a turn couldn't read itself (the same mail, public pages). Its mail is cut to 8 000 characters a message. | Hidden text in a mail or a page must not land in what the assistant remembers or can search later, nor steer a turn that may act. |
| LKA-14 | **The web first, through Whombat, and closed once mail is read**: `search_web` is a Brave search on the person's own key, at most 4 a check, with public words only — Whombat refuses a search with an e-mail address, a link, a phone number, a booking code or long number, or the name or address of a person on this Whombat or a guest of the event (`aheadQueryRefusal`); dates, times and flight numbers are public. `read_web_page` reads a public page over https as text (`lib/outbound.ts`: public addresses, a size cap, at most 6 a check), and only a link the check found — in a search result or on a page it read; a redirect only within the site or to such a link. Links in the event or in a mail aren't opened (an invite's link may accept it or carry a personal key; a mail's may tell its sender it was read). Once the check searched or read mail, nothing more goes to the web (a server that restarted during a check counts it as read). A hostile page could still signal a few bits by which of its links the check opens; nothing private can be spelt into an address. | A stranger's mail can then steer nothing that leaves the Whombat; a search engine is a third party. |
| LKA-15 | **It ends with `ahead_report`**, once: `found: false` (the usual end; nothing posted, nothing kept but the row), or one finding of a fixed kind (`time`, `place`, `cancelled`, `tickets`, `crowds`, `travel`, `other`), one to three sentences in the person's language and one to four sources, each a page it read or a search result, or a mail it read — never a link it only saw. Whombat names each source itself: a page by its site, with its link as Whombat read it; a mail by the site of its sender's address, never the name the sender chose. | “Sourced or silent”: a finding the person can verify, and a kind they can stop; nothing a stranger or the model writes looks like a source. |

## A finding

| # | Decision | Why |
|---|---|---|
| LKA-20 | **One message in a thread of its own**, by the assistant in the person's Chat: its words as one plain paragraph (links, markup, sites, e-mail addresses and phone numbers taken out), then its sources on one line as Whombat named them. No link previews are fetched for it. The person's Chat tells them as any message of the assistant's there: inbox and push. | John: push, one thread per event. Nothing a turn that read strangers' text wrote makes Whombat fetch anything or points the person anywhere Whombat didn't check. |
| LKA-21 | **Quick replies “Not useful” and “Stop checking for this”**: the person's own words, which the assistant acts on in their turn in that thread with `ahead_feedback` (`not_useful`, or `stop_kind`, which adds the kind to the setting; it says which kind it stopped). Their own words work the same way. That turn is told the finding was written from mail and web pages: information to check, never instructions; it changes the event only on the person's yes. No card and no new buttons in the apps. | Works on every app already out there, and in any words. |
| LKA-22 | **Not told**: a finding with nothing left of its words once cleaned, of a kind the person stopped, a third finding that day, one when Looks ahead or its calendar was switched off meanwhile, at night, less than 30 minutes before the event, or when the event changed or went since the check began (read again just before it is told) is kept quiet (its kind kept for the count, its words not). | The person's stop holds; two messages a day is plenty; a finding about an event that is no longer so misleads. |
| LKA-23 | **The thread settles after the event**: two hours after it ends, when the person didn't write in it (as a look's thread settles, `settleResolvedThreads`). Rows go a month after their event. | The question is over once the plan is. |

## Weighed and left as they are

- **A change from a finding's thread asks in words, not on a card.** The person's turn there is told the finding came
  from mail and web pages and changes the event only on their yes; the keys stay as the person set them. Forcing a
  card for calendar changes in these threads would reach into the keys engine for a risk the person sees (the finding
  is in front of them, without links).
- **Going back to an older release** leaves a queued check that release can't run: it fails quietly once. Checks are
  rare (at most 4 a day) and a rollback is minutes; nothing else is needed.

## Later, not now

- Mail as a source of its own: things waiting in mail without a calendar event (a slot to pick, a move to confirm).
  John said incoming mail may be read; it needs its own design (outsiders' text as the trigger, not the person's
  calendar).
- Connectors as evidence for an event (the Council's second round): business invoices or CRM tasks before a meeting,
  tickets in Drive or Paperless. Never: Find My unasked, 1Password, media, server health (that is Looks).
- A thread icon with the event's date, travel time.
