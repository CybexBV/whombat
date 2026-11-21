# A thread shows no checkpoint (AP-675)

John on DEV (2026-10-03), about “CHECKPOINT · BANJO” at the end of a thread: “This card should not be displayed, this
seems to be an internal checklist for Banjo.”

## AP-675 The thread pane has no checkpoint footer

The web thread pane no longer shows the agent's open checkpoint under the replies (`ThreadPane` passed `TaskCheckpoint`
as `ThreadView`'s `footer`; the prop is gone). This amends Whombat's BP-B20 “The open checkpoint shows under a run's
STEPS and at the end of a thread”: it still shows under a run's STEPS (the run screen, where people watch the agent
work) and in a conversation's Knowledge → Checkpoints, and agents still get it in their turns. Android never showed it
in a thread. Visual check: the thread pane against the reference, which draws no checkpoint there.
