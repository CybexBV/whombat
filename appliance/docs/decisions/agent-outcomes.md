# Agent outcomes

- Extend `dev/devbox ra-check` with independent preference correction, recovery from a deliberate command failure, and Lead coordination with two tracked reports.
- Keep the existing report of interventions, questions, activity, time, token usage and cost. Local harness tests check the evaluation logic; live provider runs remain opt-in and are not claimed by a DEV deployment.
- Deploy the runtime and app using a new candidate on the managed DEV stack. This work does not change the host, manager or production release channel.

- Candidate 0.41.0 pins runtime 17dc081c, contracts 0.45.1 and app 0.34.0 (API 31). Harness quick checks: 156 tests passed. DEV database backups precede the migration; deployment verification is recorded after restart.

## DEV verification (2026-10-04)

- Managed DEV restarted on candidate 0.41.0. Public `https://dev.whombat.com/version.json` reports app 0.34.0, contracts 0.45.1, API 31. Runtime 17dc081c reports schema 70, current migrations, read-write DB and status ok. Control, relay service and web health probes pass.
- The managed stack's local appliance identity remains retired in control: relay admission is denied (`device_retired`), and the development manager uses its stand-in. The same error was already logged at 06:16 UTC, before this deployment. The local runtime is healthy but this identity cannot serve end-to-end relay sessions. No retirement was reversed.
- Legacy DEV `whombat-dev` was also updated/restarted: `/api/v1/health` on port 4420 reports runtime 17dc081c, schema 0069, read-write and ok. Its startup upgraded six existing bundled workflow attachments.
- Database backups are under `~/.cache/wb-tmp/agent-outcomes-dev-backup/`. Microsoft real-account consent and live five-role evaluations were not run. No production deployment or appliance update-channel release was made.
