# Contracts 0.44.2 for the agent-efficiency runs stream

Released as `contracts-v0.44.2` (whombat-contracts `main` 2e5dff7, pushed; artifacts in
`~/Code/.wt/contracts-ae/dist-release/0.44.2`). Vendored on `ae-runs` (`vendor/whombat-contracts/0.44.2`). Decisions:
CT-260 in the contracts repository, AE-05 and AE-06 in `docs/decisions/agent-efficiency.md`. A patch: `SESSION_API_LEVEL`
stays 30, no feature names. All from `@whombat/core`.

## Earlier runs (AE-06)

- `EARLIER_RUNS_MAX` — 3; `EARLIER_RUN_LOG_LINES_MAX` — 12; `EARLIER_RUN_LOG_LINE_MAX` — 300.
- `EarlierRun` — `{number, title, status: RunStatus, summary: string ≤ 280 | null, log: string[] ≤ 12 (each ≤ 300)}`; `log` is the run's last lines, oldest first.
- `DispatchContext.earlierRuns` — optional `EarlierRun[]` (≤ 3), newest first: with `run`, the burrow's earlier runs on its pull request (else its repository branch) the turn's audience may read, the run itself not among them. The server cuts longer log lines; the contract refuses them.

Runner rule: show them in the turn's message (PE-02), as data in a delimited block, with one line — build on what they
found, don't redo their checks unless something changed since. Absent or empty: nothing.

## start_run (AE-05)

- `MCP_TOOLS.start_run.input.prNumber` — now described: an open pull request of the repo, whose branch the run works on whatever `branch` says.
- `MCP_TOOLS.start_run.output` (`ok`) — optional `branch`: the branch the run works on.
