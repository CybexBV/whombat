# Brief W2 — the admin panel: releases, rollouts, alerts, reinstalls (UP-G1, UP-E2, UP-E5)

Worktree `~/Code/.wt/whombat-app-ru-admin`, branch `ru-admin` (the orchestrator merges it into whombat-app's
`robust-updates`, where agent W1 works on the clients). You own `apps/admin/**` only. Ids AP-280…AP-299
(`docs/decisions/app-managed.md`; the admin decisions are AP-140…AP-157 — read them). Ports 5700–5749.

Contracts: the app vendors 0.20.2; agent C is cutting **0.22.0** with the operator shapes you need
(`…/briefs/C-contracts.md` §4: `ReleaseRecord`, `PUT …/record`, `RegisteredRelease` extras, `ROLLOUT_PRESETS`,
`Rollout.pauseDetail`, `GET …/rollouts/:rollout/devices`, `GET /v1/operator/fleet`, alerts, registrations,
`describeUpdateFailure`). Develop against the contracts worktree (`~/Code/.wt/whombat-contracts-robust-updates`, link
without committing); agent W1 vendors 0.22.0 on `robust-updates` when it's cut — you then merge `robust-updates` into
`ru-admin` (the only merge you do) to pick it up.

## Tasks

1. **Releases page** (new nav entry, or a rework of Fleet's Releases/Rollouts tabs — decide by what reads best):
   - release list: id, state, created, versions (host/runtime/manager), schema, API level, record badges (build,
     gates, upgrade gates, DEV soak: ok/failed/missing), devices on it;
   - release detail: notes (markdown, rendered safely: no raw HTML), migrations with class, gates records, known
     issues, quarantine action;
   - rollout detail: waves (cohorts, share, observation window, threshold, state, started/observing since, promote
     eligibility), counts, pause reason and `pauseDetail` rendered with `describeUpdateFailure`, the devices table
     (device, org, cohort, wave, state, attempt, failure rendered, hold reason such as `manager_too_old` explained
     “Needs a host release without a database change first, or a reinstall.”), actions pause / resume / promote wave /
     stop / emergency stop with the existing confirm dialogs and reason codes; create a rollout from a release with a
     preset (default, all at once) — only if AP-154's rule (creation stays on bearer-token tools) should change: decide
     and record.
2. **Alerts**: a list (open / all), severity, subject, detail, since, acknowledge; an alert count in the shell nav.
3. **Pending re-registrations (UP-E5)**: list with the existing device and “Reinstalled — retire the old record”
   (typed confirm), explained in one sentence.
4. **Fleet summary** at the top of Fleet (or the overview): devices live/unseen, by release, open rollouts, alerts.
5. Permissions: new screens/actions in `src/lib/permissions.ts` with the contract's permissions; the fake API
   (`src/fake/world.ts`, `seed.ts`) models everything new (a paused rollout with a failed device carrying the
   2026-09-28 failure detail, a `manager_too_old` hold, an alert of each kind, a pending re-registration) so the panel
   can be seen and tested without control.
6. Tests (the admin app's vitest/Playwright setup) and a visual check with the fake API (screenshots of each new
   screen in light and dark if the panel has both).

## Done when

`TMPDIR=~/.cache/wb-tmp pnpm check` passes for the workspace; the new screens work against the fake API; AP entries
written; commits on `ru-admin`.
