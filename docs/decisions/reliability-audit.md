# Session reliability — 2026-11-01

Local investigation of transfer lifecycle and recovery across the server and shared client. The existing session
protocol, command receipts, permissions and commit pipeline remain authoritative. No schema or wire change.

| # | Decision | Reason |
|---|---|---|
| SRL-01 | **Stream ownership spans asynchronous setup and cleanup.** Register and count an open before checking permissions. A reset handler installed after cancellation observes that cancellation immediately; a cancelled setup sends no `opened`. Reserve an upload target before filesystem setup and retain it until active writes/completion stop and its handle closes. The client sends END for its half of completed downloads/exports and RESET for failed local uploads or unfinished download iteration. Check cancellation after awaited upload reads and before further sends. | Concurrent opens both modified one partial file; resets during setup leaked resources; reset during a write released the file for another owner too early. The client left failed uploads and completed downloads open on the peer: download 33 exhausted the real server's capacity. A stopped consumer retained its bulk slot and cancellation listener. |
| SRL-02 | **Unexpected session-task failures close their connection.** Observe detached request, status, subscribe, open and idle-check tasks; catch admission/receive-loop failures inside the session lifecycle. Log the failure and close the affected session. Do not manufacture a command rejection: its durable receipt determines what a reconnecting client learns. | Permission-check rejections escaped as unhandled promises, capable of ending the server process. The admission lifecycle rejected a promise its endpoint detaches. A regression also verifies that a committed message survives a failed status lookup and a same-id retry does not duplicate it. |
| SRL-03 | **Failed event delivery must recover explicitly.** Remove a replay registration when its setup/replay fails. If live enrichment or delivery fails, close that subscription and use the existing overflow callback to request a snapshot at the head cursor. Other subscriptions continue normally. | A replay exception left an unreachable live-event buffer. A live failure advanced past an event without delivering it; later cursors could conceal the gap permanently. Existing `snapshot_required{overflow}` already tells clients to refetch and resume. |

Regression coverage is in the existing session stream, command and event suites and the shared client's secure
session suite. File races use gates and protocol ordering barriers; failures are injected at permission checks,
local reads and event enrichment. Server tests use real Postgres in throwaway databases. Baseline failures and the
actual validation results are recorded in `docs/history/BUGFIX_PROGRESS.md`.
