# A reply that names nobody reaches its agent: the “To Banjo” chip (AP-750…AP-753)

John, 2026-10-05: in a thread where he talks only with Banjo he still had to type `@Banjo` for Banjo to answer; in a
channel with several people a reply meant for the agent should reach it too. Agreed: one rule decides who a message that
names nobody is for (contracts 0.46.0 `replyAddressee`, CT-263), the server applies it when a client doesn't say
(Whombat `docs/decisions/reply-to.md` RT-01…RT-04), and the composers show it as a chip the person can remove, sending
what they saw as `SendMessageBody.to`.

| ID | Decision | Why |
|---|---|---|
| AP-750 | **`replyTarget` in `@whombat/client` builds core's rule from what a client has; `to` is what the chip showed.** `replyTarget({ viewerId, draft, messages, principals, place, thread, now }): Principal \| null` (`packages/client/src/replyTo.ts`): the place's messages (a thread: root and replies; the top level: the loaded pages' top-level messages, thread replies left out), each author's kind from the principals (an author the client doesn't know counts as a person, so no agent is guessed), deleted messages left out (nobody answers a tombstone), the draft's mentions by `resolveMentions` over the composer's targets (`composerMentionTargets`, the `@` list's and the send's, AP-607) minus the viewer, `parseBroadcast`, the agents that may be woken (`replyAgents`: the conversation's agent members, active, not a system principal, not someone else's personal agent — the `@` list's agents, AP-721), the viewer as the only active person member, and now. `replyChipApplies(place)`: channels and branch rooms and their threads only. `replyTo(applies, chip)`: the chip's agent id, `null` where the chip applies but none shows (none found, or removed), `undefined` (the field left out) elsewhere: in an agent's DM (the DM wakes its agent anyway; `null` there must not read as “wake nobody”), in a direct conversation (no agents), while the place is loading, and on a runtime without `messages.reply_to`. `useSendMessage` carries `to` and remembers it per client id, so Resend (the same request) sends the same `to`; Android's outbox keeps it with the message across a restart. Quick replies leave `to` out (they mention their agent, or the server's rule decides). | One rule for server and composers, and the send does what the person saw, including “no chip, nobody extra”. |
| AP-751 | **Web: “To Banjo” beside Send**, in the composer's tool row (after the hint “Agents act when you mention them”, before Send) and in the thread's reply box (between the field and Send). The attachment chip's pill (`--sf2`, `--radius-pill`, 500 12px mono, `--ink2`) with the agent's 18px head (decorative), the words `To {name}` (`replyChipText`, the agent's name) and a real `<button>` × (`--mut`, focus ring `--brand` 2px like the attachment chip's ×) labelled “Don’t send to Banjo”. × hides the chip for this draft and keeps focus in the field; the dismissal holds in that conversation or thread until a send goes through. The chip goes while the draft mentions anyone or broadcasts (`@channel`, `@here`) and comes back when the mention is removed (unless removed with ×). It shows with an empty draft too: it says ahead where the next message goes. The top level's 10-minute window closes on the room's minute clock. Shown only where the Whombat advertises `messages.reply_to` (`useFeature`; fixtures and the legacy server have every feature). `pnpm visual` hides it (`[data-reply-chip]` in `hideAdditions`): the mock has no chip. | Beside Send it reads as what Send does, and adding or removing it never moves the text the person is typing. |
| AP-752 | **Android: the same chip above the composer's pill**, in a conversation and a thread (`ChatView` → `Composer`): the upload chips' pill (44dp, radius 22, `sf2`), the agent's 22dp face, `To Banjo` in 13 ink2 and a 44×44 × with the accessibilityLabel “Don’t send to Banjo”. `ChatView` passes `replyTo` only where `replyChipApplies` and the runtime has `messages.reply_to` (`useFeature`, as `messages.edit` and `runs.recovery` are gated; the demo world and the legacy server have every feature); the composer computes the chip from its own text, sends `to` with the text and resets the dismissal after each send. The clock is the app's (`useBurrow().clock`, the server's time). | No room beside the 32dp send button on a phone; above the pill is where the upload chips already sit. |

### AP-753 Release 0.38.0

AP-750…AP-752 with contracts 0.46.0 (CT-263: `replyAddressee`, `SendMessageBody.to`, feature `messages.reply_to`;
`FEATURE_NAMES` calls it “replies that reach the agent without @”). The server side is Whombat `reply-to.md`
RT-01…RT-04. Checks: `pnpm check` once, a look at the #billing-v2 composer and the PDF libraries thread with the chip at
1440×900 in both themes (DEV fast). No emulator run; the orchestrator releases.

### AP-965 A channel's top level doesn't carry the last-named agent over (0.58.1)

John, 2026-10-09: “I am considering adding a 3rd Proxmox server” in #general on his box went to Dusty with a “To Dusty”
chip: he is the only person there, so the only-person rule chose the agent he had named hours earlier (agents answer
in threads, so the top level holds only his messages). `replyTarget` passes core's `channel` (contracts 0.65.1,
CT-321): at a channel's top level the chip no longer shows that agent, and the area suggestion (AP-950, SA-01…SA-04)
decides; in a channel's threads and at a branch room's top level the rule is unchanged. Whombat `reply-to.md` RT-07.

