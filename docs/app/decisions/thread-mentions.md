# The thread's reply box lists who can be mentioned (AP-662, AP-663)

John: typing `@` in a thread should list the agents available there. The conversation's composer has had that list
since MS-07; the thread pane's reply box only corrected the letter case of a typed name (AP-607).

| ID | Decision | Why |
|---|---|---|
| AP-662 | **The reply box opens the composer's `@` list**: the same rows (`MentionList`, now shared with `Composer`), the same `mentionOptions` (agents first, then people, no viewer, retired agents, system agents or someone else's personal agent, at most 8), the same keys (↑/↓ move, Enter/Tab pick, Esc closes only the list) and the same `combobox` wrapper. It offers whom the conversation's composer offers: everyone in the burrow, or in a direct conversation its active people (AP-462), read from the cached `conversations.get`. The list sits above the reply box at its width. No `/` commands: the reply box still has none (MS-06). Android's composer has no `@` list anywhere yet; not part of this change. | One list, one rule: an agent offered in the room is offered in its threads. |

### AP-663 whombat-app 0.28.4

AP-662, no contract change. Checks: `pnpm check` once and a look at the thread pane at 1440×900 in both themes (DEV
fast). Released like 0.28.3.
