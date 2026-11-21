# The assessor's card: reply, verdict, decision, the full assessment folded (AP-560…AP-565)

John, 2026-09-30, on Pepper's assessment of a website feedback report: agents should sound like people — a concise reply
in the assessor's own words, always bug / not a bug / unsure for bug reports, a question with ready-made answers people
click when the next step isn't clear, and the full assessment available but folded. Contracts 0.28.0 (CT-193); the
runtime side is Whombat `docs/decisions/feedback.md` FB-32. Not in the mocks: built in the report card's language.

## Decisions

- **AP-560 The reply is the message; the card sits under it.** The runtime posts the assessor's reply as the message's
  text (inert) and the `assessment` card with it, so the message row renders it like any agent message with a card.
  Older clients drop the card (CT-136) and still show the reply.
- **AP-561 The card: `ASSESSMENT · FB-…`, the verdict as a status pill.** Bug reports: Bug (bad), Not a bug (ok), Unsure
  (warn) — `VERDICT_TONE` in `@whombat/client`; otherwise the outcome (`Duplicate of FB-…`) in the muted tone.
- **AP-562 The question in the sf2 box, the options as card buttons.** The recommended option is primary, the rest
  secondary, in the assessor's words; a fieldset whose legend is the question. Each button's description (title and
  `aria-describedby`) says what it does in Whombat's words (`DECISION_ACTION_HINTS`: “Asks an owner to approve handing
  the report to development.”). Disabled for viewers who can't decide and while a pick is on its way; a refusal is said
  under them in the bad tone.
- **AP-563 Once picked, the buttons go.** The card says who picked what, with what it did and when (`decidedLine`:
  “Joris chose “Won’t fix” · closed · 16:10”; “You” for the viewer); the runtime's `message.updated` brings it to
  everyone, and the client refetches the thread after its own pick.
- **AP-564 The full assessment is folded.** “Full assessment” with the headline (`Duplicate of FB-… · high confidence ·
  severity none`) opens the labelled rows (`assessmentDetailRows`) and the evidence list in place, the report card's
  Details region; everything is plain text.
- **AP-565 Mobile.** The card summary shows the label, the verdict in its tone, the question and who picked what (or the
  headline); the options are 44dp buttons, stacked when there are more than two; “Full assessment” is a 44dp row that
  opens the rows. Gated on `feedback.decisions` like the web.
