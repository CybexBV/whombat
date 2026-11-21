# The phone shows work in a thread that has no replies yet (AP-830)

John, 2026-10-08: agents now answer a person's top-level message in a channel in a thread under it (Whombat
`docs/decisions/channel-threads.md` CH-01). The web's reply row already shows “Banjo is thinking” under a root without
replies (`ThreadWorkLine` with `alone`, AP-735); the phone showed its reply row only for roots with replies, so between
sending and the first reply nothing said that Banjo was at work.

| ID | Decision | Why |
|---|---|---|
| AP-830 | **Android: the reply row shows for work alone.** In a room (not inside a thread), `ThreadRepliesRow` shows under a root when it has replies or when `threadWork` finds work in its thread; without replies it has no `N replies ›` text, only the agent's face and `Banjo is thinking` / `is working · 38%` / `needs you`, and still opens the thread (44dp, the label says what it shows). `useThreadWork` is asked for in every channel (live runs and the conversation's typing entries), not only when a root there has replies. | The answer to a top-level message starts in a new thread: the person must see that the agent is on it, where its answer will appear. |
