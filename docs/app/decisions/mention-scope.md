# The `@` list offers the conversation's agents (AP-721, AP-722)

John, 2026-10-04, on Android: “When there is only one agent in the channel or in a thread and I type @ then only the
agent that is active should be visible in the selector, not every agent.” Agreed: the list offered every agent in the
burrow (AP-662 on the web, AP-710 on the phone), and an agent mentioned outside its channels wakes with nothing to read
(the runtime gives a non-member no window, trigger or thread: Whombat `runtime/context.ts`, IN-12). No contract or
server change.

| ID | Decision | Why |
|---|---|---|
| AP-721 | **The `@` list offers the conversation's agents only; in a thread, `@` alone offers the agents taking part in it.** One rule for the web and Android, `mentionPool` in `@whombat/client`: a channel, branch room or agent DM offers the agents among its `memberIds` (one agent in the channel: that one); in a thread, with nothing typed after `@`, the agents that wrote in it or are mentioned in it (`threadAgentIds`; a person's `@Banjo` brings Banjo in before he answers), any of the conversation's agents once a letter is typed, so a second one can be brought in; a thread no agent has joined offers the conversation's. People stay offered (a mention is how someone is pointed at a conversation), the conversation's members first. A direct conversation offers its people, as before (AP-462). Members not known yet (the conversation still loading) offer every agent, as before. With nobody to offer, a query that names an agent outside the conversation says “Waffle isn’t in this channel.” (“… branch room.”) instead of “Nobody by that name here.” (`mentionOutsider`, `outsiderNote`). Typing the name in full still sends the mention and still corrects its case (the autocorrect keeps every principal, AP-607): the list only stops suggesting it. | The list suggested names that do nothing useful here, and in a one-agent channel the agent you meant was one of six. |

### AP-722 whombat-app 0.35.1

AP-721, no contract change (contracts stay 0.45.1). Checks: `pnpm check` once (DEV fast); Android APK published to dev
(AP-720). The web gets it with the next appliance candidate.
