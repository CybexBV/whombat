# Brief A — control and `deploy.sh` (U-E, UP-B4, U-G, UP-X01…X03)

Worktree `~/Code/.wt/whombat-api-robust-updates`, branch `robust-updates`. Ids HZ-30…HZ-39 (`docs/decisions/hosting.md`,
table rows) and CL-82…CL-99 (`docs/decisions/control.md`, its format). You own everything in control. Ports
5600–5649; tests use throwaway databases on the shared Postgres :55432 (`pnpm test:int`, as the README says).

Read `README.md`, `docs/decisions/control.md` (CL-19…CL-22 rollouts), `docs/decisions/hosting.md` (HZ-15…HZ-29),
`src/rollout/service.ts`, `src/devices/*`, `src/metadata/service.ts`, `src/admin/app.ts`, `src/panel/app.ts`,
`src/index.ts`, `src/mail.ts`, `infra/hetzner/deploy.sh` and `infra/hetzner/README.md`, `docs/device-api.md`, and
`docs/decisions/updates.md` in the appliance worktree (UP-B4, UP-E1…E6, UP-G1…G3, UP-X01…X03).

Contracts: the repo vendors **0.19.0**. Agent C is cutting **0.22.0** (shapes in `…/briefs/C-contracts.md`: release
`compareVersions`, `UpdateFailureDetail`, `DeviceStatusReport.update.failureDetail`/`runtimeVersion`,
`UpdateProgressReport.failureDetail`, `ReleaseRecord` + `PUT /v1/operator/releases/:release/record`, `ROLLOUT_PRESETS`,
`Rollout.pauseDetail`, `GET /v1/operator/rollouts/:rollout/devices`, `GET /v1/operator/fleet`, alerts endpoints,
registrations endpoints, `GET /v1/releases/:release/summary`, `describeUpdateFailure`). Start with everything that
doesn't need the new shapes; develop against the contracts worktree (`~/Code/whombat-contracts/scripts/link-contracts.sh`
or a local `file:` link you don't commit); when the orchestrator says 0.22.0 is cut, vendor it with the procedure in
`~/Code/whombat-contracts/docs/publishing.md` (0.19 → 0.22: check what 0.20/0.21 changed for control).

## Control

1. **Failure detail (UP-E3)**: store `failureDetail` from `update.progress` (a jsonb column on `device_updates`) and
   from `status.report` (the report is stored whole); keep `failedChecks` (dropped today). Expose per rollout
   (`GET …/rollouts/:rollout/devices`) and per device.
2. **Automatic stop (UP-E2)**: `evaluate` pauses a rollout when a device in the **current wave** reports `Failed`,
   `RolledBack`, `Quarantined` or `ForwardRepairRequired` (`pauseReason device_failed`, `pauseDetail` with the device
   and failure detail), or a health regression (runtime or database `down` in two consecutive status reports of a
   device that activated the release, within the wave's observation window → `health_regression`). Keep the threshold
   logic for waves that set one. Alert (below). Tests in `rollout.int.test.ts` including emergency stop.
3. **Waves (UP-E1)**: nothing to change in promotion (automatic when the window passes, empty waves at once) — verify
   it and test the default preset end to end with a `ManualClock`.
4. **Old managers (UP-E6)**: `computeDesired` holds (`hold` assignment, a stored hold reason `manager_too_old`) a device
   whose last reported `managerVersion` compares below `0.2.0` from a release whose `runtime.schemaWrites` is above the
   device's current release's (unknown current release → treat as migrating). The rollout devices view shows the hold.
5. **`notOlder` by versions (UP-X03)**: compare the tuples' host, runtime and manager versions with contracts'
   `compareVersions` (any lower component → hold `older`), not registration times.
6. **Idle polling (UP-X01)**: `CHECK_IDLE_S` 3600 → 900. Update `docs/device-api.md`.
7. **Release records (UP-X02, UP-C3)**: `releases.record` jsonb; `record` on register; `PUT …/record`; the operator
   release list/detail returns record, versions, schemaWrites, createdAt. `GET /v1/releases/:release/summary`
   (session) for owners: `record.notes.summary` and the publish time; 404 without a record.
8. **Fleet summary (UP-B4, UP-G3)**: `GET /v1/operator/fleet` — devices (live = reported within 24 h), releases with
   device counts, API level (from the record) and manager versions, open rollouts, open alert counts.
9. **Alerts (UP-G2)**: an `operator_alerts` table (kind, subject, severity, detail, opened/lastSeen/resolved/
   acknowledged), opened/refreshed/resolved by a check every 5 minutes (the in-process `every` runner) and by rollout
   events: rollout paused or stopped, device failed/rolled back/quarantined, device unseen for 24 h (claimed devices
   only), TUF timestamp older than 12 h or root/targets within 14 days of expiry (read the public repository:
   `TUF_PUBLIC_URL`, e.g. `https://updates.whombat.com/metadata/`; timestamp → snapshot → targets versions and expiries;
   the newest `N.root.json` by probing), the client channel (`/clients/channel.json`) within 7 days of expiry, backups
   `failing` or `stale` in the latest status. Mail each newly opened alert (and a daily reminder for open critical
   ones) to `OPERATOR_ALERT_EMAILS` (comma list, env; nothing mailed when unset) via the existing `Mailer`, plain
   text with what, since when, and the panel link. `GET /v1/operator/alerts`, `POST …/:alert/ack`. Config in
   `src/config.ts`, documented in the README and `docs/operations.md`.
10. **Reinstall (UP-E5)**: when `POST /v1/devices/self-register` is refused because a live record holds the same
    hardware serial, record a pending re-registration (serial never stored in clear if it isn't already — follow what
    the directory does), list them (`GET /v1/operator/registrations`) and `POST …/:id/retire-existing {reason}` retires
    the old record (the box's next attempt then registers). Retention: delete self-registered devices never claimed
    for 14 days (with their registrations), audited.
11. Everything new is audited like the existing operator actions and gated by the existing permissions.

## `infra/hetzner/deploy.sh`

- `release <id> <dir> [--waves default|all-at-once|<file>] [--record <record.json>] [--rollout]` (`--rollout` =
  `--waves all-at-once` for compatibility, but with threshold 0); `record <id> <record.json>` (PUT);
  `rollout list|show <id>|devices <id>|pause <id> <reason>|resume <id>|promote <id> <wave> <reason>|stop <id> <reason>`;
  `emergency-stop on|off|status`; `alerts [--all]`; `device retire|release <id> <reason>`;
  `registrations [retire-existing <id> <reason>]`.
- `status` (UP-G3): hosted components with versions (control's `/v1/health` version, web/embed/admin tags deployed —
  record them at deploy time on the host, e.g. `/srv/whombat/<component>/current` → tag), the fleet by release and
  state, open rollouts with their wave, open alerts — one screen.
- **Fleet check (UP-B4)** before `web|embed|admin|control|relay`: read `GET /v1/operator/fleet`; for web/embed the new
  build's API level (from the app tag's contracts version → `SESSION_API_LEVEL` of the vendored `@whombat/protocol`;
  agent W1 also writes it to the build's `version.json`) must have every live device's release API level within
  −2…+1 (unknown → 21); for control/relay the device API contract they vendor must be ≥ what the fleet's managers send
  (a control older than the fleet's managers is refused). Refuse with the order to use; `--force` overrides (logged).
- Serve `https://app.whombat.com/version.json` from the hosted web build if agent W1 produces it (`{version, build,
  apiLevel, contracts}`), and let `status` read it.
- Update `infra/hetzner/README.md` (commands, the order rule, alerts config).

## Done when

`pnpm check` and `pnpm test:int` pass; `infra/hetzner/deploy.sh` changes are exercised against the local stand-in
(`infra/hetzner/standin/`, HZ-21) where possible (say what couldn't be); HZ/CL entries written.
