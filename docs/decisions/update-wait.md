# Using the box while an update waits (UW-01…UW-03)

John, 2026-10-29: after a DEV release, the app couldn't connect to Home for minutes. The update was waiting for
Dusty's code run to finish, and the manager held the runtime drained for its ten-minute window: the session endpoint
refused every new session while draining (MR-17), and every command answered `unavailable` (MR-15). Running work isn't
interrupted for an update, so a long run kept the box out of reach for ten minutes in every twenty-five. John asked to
fix it. The manager's part is `appliance/docs/decisions/manager.md` MG-137.

| # | Decision | Why |
| --- | --- | --- |
| UW-01 | **Sessions are admitted while the runtime drains**, through the relay and directly. Reads work as before; a drain only holds back new turns, executions, automation steps and commands. | Being drained is the box getting ready, not the box being gone: the person sees their Whombat instead of “can’t connect”. |
| UW-02 | **A command waits up to 5 s for a drain to end** (`MaintenanceGate.opened`, `settleMs`) before it answers `unavailable`; enrolment's ephemeral ops and mutating exports too. A waiting command is not a drain blocker, so the boundary the manager found isn't lost to it. | While an update waits, the manager drains only for the moment it asks for a safe boundary (MG-137); a message sent in that moment goes through instead of failing. |
| UW-03 | **No contract change.** The manager keeps `POST /drain` and `POST /resume` as they are: a drain it gives back at once is its way to ask what runs. | Old runtimes and new managers (and the reverse) keep working together; a probe-only request would need a contracts release across both repositories. |
