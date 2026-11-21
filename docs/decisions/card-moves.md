# A live card moves to the end of its thread (CM-01…CM-12)

John, 2026-11-06: in a council thread on Home, the council card and the checklist card are updated where they were
posted while the chat goes on, so he had to scroll up to see where they stood. A strip above the reply box that repeated
each live card (archived `archive/live-card-strip.md`) was not good: “When the card is active again we should simply
show a new card as if it were a new chat.” The box moves the card; the web and the phone draw it as any new message.

| ID | Decision | Why |
|---|---|---|
| CM-01 | **Superseded in part by CM-08: news its checklist brings changes a council's card where it is.** **Real news moves a live card to the thread's end**: when a council's or a checklist's card changes and someone's message came in its thread after the card's message, the card is posted again as the thread's newest message, by the agent that posted it (`placeCard`, `domain/card-move.ts`; `refreshCard` of `council/commands.ts` and `delegate/commands.ts`), and `councils.live_message_id` / `delegations.message_id` follow it. A card that is still the thread's last, or on a thread's first message, changes where it is. | Where the work stands is always at the end of the chat, where the person reads, as a new message; nothing new to learn on the web or the phone. |
| CM-02 | **News is what the person reads on the card** (`cardNews`, `domain/card-news.ts`): a council's stage, round, end, plan and pictures, each member's state, score and verdict; a checklist's stage and end, each task's title, state, the OK it waits for, its merge, its checks and its pull request. Not what a task or the builder does now (its step), a clock or Whombat's status line under the card: those change it in place. | A card that jumps for every step would push the agent's notes around and never let the thread rest. |
| CM-03 | **The person's own press never moves it** (a tick, Hand over, Stop, a task's Stop): the card changes where it is. | They are looking at the card; it must not leave from under their finger. The next news after it moves it. |
| CM-04 | **Superseded in part by CM-10: where the person talked after it, the card as it was stays there, folded.** **Superseded in part by CM-07: the words left behind link to the card.** **One card, not copies**: the old message keeps only the agent's words above the card (its intro); its card, pictures, quick replies and its question go with the card. A message that held nothing but the card (one moved before) is removed from the thread. | A thread of old snapshots is what the agent's notes already tell better; one place to read and press. |
| CM-05 | **A move is quiet**: no inbox row, no push, nobody woken; the thread shows it as new, like the agent's notes. Only the needs-you moments and the conclusion tell the person, as before. | Moving is about where the card is, not news of its own. |
| CM-06 | **The agent's words go under the card's thread, not its message** (`postUnderCard` takes the thread's first message): its message may have moved on or gone since the council or checklist was read. A council's or checklist's end answers the message that holds the card now. A council's checklist ends after the council's conclusion, so its final card and quick replies are the thread's last. | The rows a command read at its start can name a message that moved in the same commit. |

## Pointing at a moved card (John, 2026-11-08)

A council of three models (GPT 6.1 Sol, Claude Opus 5.5, Muse Wonder Full) rated how a code job reads in a long chat
thread 6/10 each: the words a moved card left (“Tick what you want and hand them over”) pointed at nothing ten messages
up, the council's card jumped under its own checklist when the checklist was offered and said its tasks were “below”,
and the council said it was building before anyone said go. John: “yes” to the first three fixes.

| ID | Decision | Why |
|---|---|---|
| CM-07 | **The words a moved card leaves link to it.** When a card moves on from a message with the agent's words, that message keeps which card it held (`messages.moved_card`, `Message.movedCard`: `council` or `delegation` and its id; migration `0059`), and the web and the phone show a quiet link under the words, “The council’s card is further down” or “The Tasks card is further down”, that scrolls to the thread's message holding that card now and highlights it (`movedCardLink`, `@whombat/client`). No link when the card isn't in the thread as loaded. | The intro stays where it was said (CM-04), but its instructions need a way to what they are about. |
| CM-08 | **A council's card changes where it is when its checklist brings the news**: its checklist offered (the council waits for the go-ahead, `council.md` CNL-68) or handed over (it builds). `refreshCard`'s `inPlace`. Its own news (a check round, a member's answer, its end) still moves it. | The stage change at the offer was the agent's news, so the council's card was posted again under the checklist it points to, and the checklist's first task update swapped them back. |
| CM-09 | **Words never point at a card by where it is**: Whombat's own say “the Tasks card” and “the council’s card”, never “below” or “above”, and the council and delegate skills tell the agent the same. The checklist's card is called Tasks everywhere (its head, its name for screen readers, the council's words). | Cards move; “the card below” is wrong after the next move, and “the T3 Code card” named a card whose head says Tasks. |

## The card as it was where the person talked about it (John, 2026-11-09)

A second council review of the same long thread (GPT 6.1 Sol 7/10, Claude Opus 5.5 and Muse Wonder Full 6/10): after the
Tasks card changed twice, nothing showed what Mara had talked about (“Why is task 3 there?” sat next to a link), and the
intro “Here is the plan as four tasks” sat above a card of three. John: “when a card gets updated why not make the
previous card it displayed inactive (folded for example, saying there is an updated card or something) and show a new
updated card in the thread where it belongs”. As T3 Code does with a plan: the old one stays where it was as a record,
the new one comes after it, and only the newest can be acted on.

| ID | Decision | Why |
|---|---|---|
| CM-10 | **Where the person wrote after a card, the card as it was stays there, folded and read-only.** When a card moves on (CM-01) and someone other than its author wrote in the thread after its message, that message keeps a copy of the card as it was (`messages.earlier_card`, `Message.earlierCard`; migration `0060`), a message that held only the card too; the web and the phone fold it into one quiet line, “Tasks · earlier version · 5 tasks” or “Council · earlier version · 2 of 3 answered”, with “Newest ↓” to the card now (`earlierCardLine`, `@whombat/client`). Opened, it shows as the card did then under “Earlier version”, with a dashed line, no buttons, menu, Details, clocks or answers to open, and nothing in it reacts to a press; nothing on it turns or ticks; screen readers hear it in words, its title and each task (which weren't ticked, or each one's state once handed over) or member (`earlierCardText`). Where only the agent's own words came after it, the move is as before: the words keep their link and a message that held only the card goes. | What the person talked about stays next to their words, and the words above it match the copy; the agent's notes alone don't leave a trail of copies behind a council's card. A copy, never the live card on two messages: an older app shows the link alone and can't press an old version's Hand over. |
| CM-11 | **What moves a card stays as CM-02 says**, a member's answer too, and the agent's notes stay replies of their own (CNL-67). Moving only when a card waits for the person, ends or fails, and folding the notes into one line, were weighed and not taken. | CM-10 already keeps what the person talked about in place; a council's card that stays above its notes while members answer would leave the live state out of view, as before CM-01. |
| CM-12 | **In a thread with more than one council, a council's folded line names it**: “Council · Review the new Inbox tasks · earlier version · 1 of 3 answered” (its title, cut at 48 characters; `earlierCardLine` with the thread as loaded). With one council the line stays short. | “Council · earlier version” alone didn't say which of two councils a copy was. |
