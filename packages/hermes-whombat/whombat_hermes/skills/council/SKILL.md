---
name: council
description: The council — put a question or a goal to several AI models of different companies at once, each working on its own in T3 Code, led there by one thread to one answer, plan or result (review something, research something, improve a project until they score it high enough). Use when the person asks for the council, or for several AIs to look at something independently.
---

# The council

A council runs in T3 Code, on the person's computer: Whombat starts one thread there that leads it. That thread starts
a reviewer on each seat (AI models of different companies, each on its own, none hearing another), brings their
findings together, runs the rounds, and for a council that improves a project also builds and fixes, where the code is.
How it runs its reviewers is T3 Code's own council method; it isn't yours to steer round by round.

Yours: what the council is asked, the person's go-ahead, and every word the person reads. Whombat shows each reviewer
and its score on the council's card while it works, and wakes you when the lead is done.

## The person's council

Who sits on the council is always T3 Code's own council: the members its council skill names, at the efforts it gives
them. Whombat follows who its lead starts. To change who sits for good, the person changes that skill in T3 Code;
Whombat can't. In Settings → the assistant → Council they choose only the rounds and the score to reach. To change those
for them, read it with `settings_read` `councils.setup` and change it with `settings_change` `councils.saveSetup` (the
whole council, as read, with the change), or open the page with `settings_open` `agent.council`.

## When

- Only when the person asks for it (“ask the council”, “let a few AIs look at this”). For a big job you may suggest it
  in one line, and start only on their yes: a council costs several strong models per round.
- It needs T3 Code connected at Manage and two AI providers T3 Code can run. When `council_start` refuses, say why in
  one line and offer to do it yourself.

## Start

`council_start` with:
- `kind`: `review` (each reviews and scores, one round, nothing is changed), `research` (each researches, one answer
  they agree on), `improve` (each looks and proposes, one plan they agree on, the person's go-ahead, then the lead
  builds it and the reviewers check and score the result until the target).
- `title`: what it is about, in the person's words (“Improve the Settings page”).
- `intro`: your words for the person, shown above the council's card: what you asked the council, in a sentence or
  two (“I asked the council whether the Settings page reads well on a phone.”).
- `question`: what the council is asked. It goes to the lead as you write it, so keep the person's own words in it
  where you can and add what they couldn't know: which screens or files matter, what good looks like, what they care
  about, what was settled earlier in this thread.
- `project`: the T3 Code project for anything in code (find it with `t3_project_list`); leave it out for plain research.
  A review looks at the person's checkout as it is now, uncommitted changes included.
- Who sits on it: leave `members` out for T3 Code's council. When they name the AIs for this time only (“ask
  Claude and ChatGPT, high effort”), pass `members` (provider, and a model and an effort when they said one). One
  company may sit twice with different models, but different companies make a better council: suggest that when they
  ask for two of one.
- `target` and `rounds` only when they gave a number (else the council's own); `goAllTheWay` when they said to build
  without asking first.

Your intro and the card under it say what you asked and who sits on it: post nothing else, and end your turn with the
no-reply word.

Cards move to the end of the thread when they change, so in your words never point at a card with “below”, “above” or
“under”: name it, “the council’s card”. Call reviewers by the names on the card.

## While it works

- You aren't woken for each reviewer: the card shows them. When the person asks how it goes, `council_read` has every
  answer so far.
- The lead asks a question (a T3 Code thread wake): answer it yourself from what the person asked, in a line.
- The person wants something changed or looked at again while it works: `council_tell` passes it to the lead.

## The plan and the go-ahead (improve)

Unless they said to go all the way, the lead stops once the reviewers agree on a plan, and you are woken with it. Tell
the person the plan in plain words in a short reply and ask whether to have it built; pass nothing on in that turn.
In the turn they answer in: their yes goes to the lead with `council_tell` and `goAhead: true` (only there: the
go-ahead is theirs), and the card says it is being built; changes they want go with `council_tell` without `goAhead`,
and the council changes the plan and comes back with it. When they don't want it built, end the council with
`council_finish` and `stopped`.

## Finishing

You are woken when the lead is done. `council_finish` with your conclusion for the person, from the lead's answer: what
the council found or did, where the reviewers agreed and where not, the scores in words, what is still open and what
is theirs to do next. Short and plain: no ids, paths or logs. It goes under the council's card and the person is told;
post nothing else. When there is an obvious next step (putting what landed live, trying it), offer it as a quick
reply: `next` (“Put it on dev”).

When the lead stopped short (a seat that couldn't run, the round limit, it ran out of time), say so; when telling it to
go on can fix that, `council_tell` instead of finishing.

When the person asks to stop: `council_finish` with `stopped` and one line of where it got to.

When a review or research came up with a list of things to do in a project, offer them right after `council_finish`,
in the same turn, as a checklist the person can hand to T3 Code: `delegate_offer` (the `whombat:delegate` skill, without
`council`: that council has ended), one task per item, its brief from the findings. Your intro says they are the
council's, and the person ticks what they want.
