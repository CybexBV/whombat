# Asks and answers stay in the chat they came from

John, 2026-10-18, on the chat “the-titan: 24 failed services”: he had to approve Whombat's commands in the default DM
with it instead of the chat he was in, and after each yes Whombat couldn't read what the command printed.

| ID | Decision | Why |
| --- | --- | --- |
| CA-01 | **Superseded in part by one-person.md OP-S62, OP-S72**: every room is the person's, so every ask stays where it was asked (no move to the Chat), and the yes still wakes the agent there. **A personal agent asks where it was asked when only its owner reads that room.** `personalOwnerOf` (`approvals/create.ts`) keeps the approval in the conversation the ask came from when `onlyOwnerReads` says nobody but the owner can read it (one of their task chats, their DM, a private room of theirs: the Vault's rule from VA-01, now shared in `domain/personal-dm.ts`); only an ask from a room others read still goes to the owner's default DM (PA-09). A personal connection's ask does the same (`ownerRoomOf` in `connections/call.ts`). The yes wakes the agent in the card's conversation, as before (EA-07), so the answer lands in the chat too. Replaces ONE-06's “the personal DM is where approval cards land”. | Task chats (ONE-06) came after PA-09: every ask of a chat's work went to a different conversation and the person had to switch to answer it and come back. PA-09's point was privacy, which a room only the owner reads already has. |
| CA-02 | **A Servers command's output goes to the agent that asked.** `serversDoneWords` returns null for `server_command`, so after a yes the result is sealed on the approval and the agent is woken with it (HR-04) and explains it, instead of the server posting “I ran it on X. Ask me if you want to see what it printed.” Other Servers calls keep their one sentence (ONE-DH21). | The sentence promised something nobody could do: the output was never kept, so the agent asked again (approvals #13–15 on John's box) and still couldn't read it. A command is run for what it prints. |

John, 2026-10-26, same thread on The Falcon: he approved Dusty's read-only check, and the check never ran. The agent's
`connection_call` had left out `server_command`'s `reason`, the card was made anyway, and after the yes the tool refused
the call for the missing argument.

| ID | Decision | Why |
| --- | --- | --- |
| CA-03 | **A call that leaves out a required argument is refused before anything is asked or signed.** `connection_call` checks the tool's input schema's `required` (for Whombat's own tools an empty text counts as missing, as they refuse it) right after reading the arguments, and answers the agent `invalid_arguments` naming what is missing, so it calls again in the same turn. | A yes must run what it approved; a card for a call that can only fail costs the person a click and a second card. |


John, 2026-10-28, on Dusty's card “Run a destructive command on the-falcon”: the card showed the command and the key,
never what Dusty needed it for, so he couldn't judge it. The runner had a place for a reason (Claude's Bash
`description`), but Hermes's terminal has no such field and the runner sent none.

| ID | Decision | Why |
| --- | --- | --- |
| CA-04 | **A command that needs a yes says why in its first line, `# why: <one plain sentence>`.** The comment lines a command starts with (not `#!`) are its why (`commandWhy` in core, `why:` dropped); the runner sends them as the request's `reason` and the command after them as the command, which the guard reads and the card shows. The shell skips the lines, so nothing else changes. The commands turn's prompt asks for the line. | Hermes's terminal tool takes only the command, and adding an argument to a tool that isn't ours means patching Hermes. A comment travels with the command through Hermes, the wrapper and the runner unchanged, in any engine. |
| CA-05 | **No card for a command that doesn't say why.** When `commands.authorize` would post a new card and the command has no reason, it answers `blocked` with `commandWhyNeededText` (the key, and the line to add), and the agent runs it again with one. A standing yes, a card that already waits, Off and On don't need a why. A web or browser tool call is exempt: it has no way to give one, and its card shows what it looks at. | A card without a why is answered blind or not at all. One more step for the agent costs a few seconds; the person decides with what they need. |
| CA-06 | **The why is under the card's title, and under WHY in Details and on the phone.** `approvalView().why` (a `run_command`'s reason, first letter capital; null for web and browser calls). The phone's chat card shows it instead of “… won’t run the command without a person.” while it waits. The runner reads a command of several lines out of Hermes's `eval '…'` too (`hermesCommand`), so a why line doesn't make the card show Hermes's whole script. | The why is what the person reads first; the command below it is for checking. |
