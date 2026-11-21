# Brief P — the release pipeline (`release/ship`) and the DEV box (U-C1, UP-C3, UP-C4, U-D, UP-G3, U-H)

Worktree `~/Code/.wt/whombat-appliance-ru-pipeline`, branch `ru-pipeline`. Ids IN-94…IN-109
(`docs/decisions/integration.md`, table rows `| IN-nn | **Title (date; refs).** text | Reason |`) and NX-120…NX-124
for image changes. You own `release/ship`, `harness/src/ship/**`, `dev/devbox`, `harness/src/devbox/**`,
`dev/publish-release` + `harness/src/dev/publish-release.ts`, skew scenario(s) in `harness/scenarios/`,
`nix/profiles/dev-instance.nix` (dev-only affordances, NX-120+), `docs/runbooks/{shipping,dev-instance,release-build,
pilot}.md` and the pins-promotion code (not the pins' content). Ports 5800–5849 and your own harness env
(`WB_MGD_HOME=~/.cache/wb-tmp/mgd-ru-p`, own Postgres container name/port) for anything you run locally.

Read: `docs/decisions/updates.md` (all of it — the pipeline table, U-C, U-D, UP-E1, UP-G3), `release/build-proxmox`,
`harness/src/dev/publish-release.ts`, `harness/src/validate/validate.ts`, `docs/runbooks/{release-build,dev-instance,
install-proxmox,pilot}.md`, control `infra/hetzner/deploy.sh` (read-only: agent A changes it) and
`docs/implementation/verification.md` V-63 (a local QEMU VM was used as a DEV Proxmox box: how it was installed and
claimed) and V-70.

## `release/ship` (bash entry, TypeScript in `harness/src/ship/`)

- `build <prod id> [--reuse-host <prod id>] [--client-floor web=N,android=M] [--known-issue "…"]…`: clean tree; pins
  checked (`manifest/pins.json`/candidate consistency as `checks.runtime-pin` does); `tufrepo check-newer` (agent M)
  against `https://updates.whombat.com` for the PROD build and the DEV repository for the twin (UP-A3); builds the PROD
  release and its DEV twin (`pve-dev-<same YYYYMMDD>.<N>`; with `--reuse-host` both reuse their environment's host) with
  `release/build-proxmox`; asserts the twin's runtime and manager store paths equal the PROD build's; generates
  `notes.json` + `notes.md` (UP-C3: commits since the previous release of the environment per component — appliance
  `source.rev`, Whombat pin, contracts and app versions from the pins; migrations since the previous release with class
  and floors from the bundle's `migrations/compat.json`; client floor; API level and features from the bundle's
  `share/whombat/release-manifest.json` when agent R adds them, else from the Whombat source; known issues); writes
  `build.json` (existing) and the notes into `~/.cache/whombat-releases/<id>/` and the twin's directory.
- `validate <prod id>`: needs `build.json`; runs `harness validate` for the candidate's pins (gates, every scenario,
  demo; under the heavy lock), the skew check (below) and agent G's `release/upgrade-gates` (N−1, N−2 = the two newest
  PROD releases boxes run: from control's fleet summary when available, else `pve-20260928.6`, `pve-20260928.4`) →
  `gates.json`, `upgrade-gates.json`.
- `publish-dev <prod id>`: needs both records ok; publishes the twin with `dev/publish-release` into the DEV TUF
  repository, registers it with DEV control **with its record** (`record` field / `PUT …/record`, contracts 0.22.0),
  rolls it out with the **default waves** (the DEV box is `internal`, so wave 0), waits until the DEV box is Healthy on
  it or fails (reporting the rendered failure detail), then soaks (UP-D2, default `--soak 2h`) with the smoke at start
  and end → `dev-soak.json`. Extend `dev/publish-release` with `--waves default|all-at-once|<file>` and `--record`.
- `promote-prod <prod id> [--waves …] --yes`: needs `dev-soak.json` ok; prints the plan (release, waves, which
  devices get it and when, what changes, how to stop) and without `--yes` stops there; with it runs control's
  `infra/hetzner/deploy.sh release <id> <dir> --waves default --record <record.json>` and `deploy.sh iso …` for host
  releases, follows the rollout (waves, device states, pause detail) until completed or paused, exits non-zero on a
  pause, writes `promote.json`; then promotes `manifest/pins.json` to the published candidate and commits it (UP-C4).
  Refuses when the fleet check (UP-E6: devices whose manager can't take a migrating release; UP-B3d: the web floor vs
  the deployed hosted web's build number from `https://app.whombat.com/version.json` — if that file doesn't exist yet,
  say so and tell the orchestrator; agent A/W1 may add it) fails.
- `status`: one screen (UP-G3) from control's `GET /v1/operator/fleet`, open rollouts and alerts (via `deploy.sh status`
  for PROD, the DEV operator API for `--dev`).
- Records chain as `updates.md` says (sha256 of the previous record, release id, ok); every stage refuses without the
  previous record. Unit tests for the record chain, notes generation and argument handling.

## Skew check (UP-B3, verification §8)

A harness mode that runs the hosted web client against runtimes one and two releases older, and the previous web
against the new runtime: at least scenario `j-clients` plus a smoke through the session transport, with pins that swap
the runtime (or app) for the older one. Put it in `validate` for PROD candidates (it can be skipped with a flag
recorded in `gates.json`). Android: the shared client code is covered by these runs; say what isn't.

## The DEV box (UP-D1…UP-D3)

`dev/devbox create|rebuild|status|console|soak|smoke|destroy`: an Incus VM `whombat-dev-box` (q35/OVMF without enrolled
keys, 4 vCPU, 8 GiB, 128 GiB disk, virtio, bridged to the default Incus network), installed from the **DEV twin ISO of
the current PROD release** (for the first box: build the twin of `pve-20260928.6` — appliance rev `6723564`, env dev,
id `pve-dev-<today>.N` — publish it to the DEV TUF repository with `dev/publish-release` **before** the box boots, as
`release-build.md` requires), self-registered with DEV control (the instance's live self-registration setting, see
`dev-instance.md`), claimed by a DEV org the tool creates or reuses (sign-in through control's API and the magic link
from the instance's mail — find out how the harness does it; the claim needs the console code or the card: find out how
V-63 did it; if reading the console needs a dev-only affordance, e.g. the dev image printing the claim code on the
serial console, add it to `nix/profiles/dev-instance.nix` only — never to prod — and decide whether the first box then
starts from a twin built at this branch instead of `.6`'s; record it), marked internal. Everything through DEV control
(`http://127.0.0.1:4701` operator API with `~/.whombat-stack-dev/env/control/tokens/operator.token`), the DEV TUF
repository (`~/.whombat-stack-dev/env/manager/tuf`, served at `updates-dev.whombat.com`) and the real network path.
`soak`/`smoke` as UP-D2: sign in, post a message, an agent turn with the scripted provider, browser host available,
backup status read — through the relay like a user's client (reuse the harness's scenario kit / app client).

You may create, rebuild and destroy `whombat-dev-box` and its Incus volumes freely; never touch other Incus instances.
The dev instance (`whombat-stack-dev`) is shared: use its APIs, don't restart it; if it needs a restart or new pins,
tell the orchestrator.

## Docs

`docs/runbooks/shipping.md` — **the** runbook “Shipping a release, DEV to PROD”: prerequisites, the commands per stage,
what each gate proves, how to read a failure (records, rendered failure detail, where logs are), how to stop (pause,
stop, emergency stop, quarantine), roll back (custody rollback with `--allow-downgrade-from`), reinstall (UP-E5), the
expected latency (UP-X01: a box sees a new rollout within 15 minutes), the backup prerequisite for contract migrations.
Update `release-build.md` (builds now come through `ship`), `dev-instance.md` (the DEV box), `pilot.md` if it describes
publishing. Keep them short and exact.

## Done when

`release/ship build` of a dev-only rehearsal (e.g. `--dev-only` twin build, or a prod id in a scratch output dir that
you never publish) works end to end with records and notes; `validate` runs (the VM gates part may still be pending on
agent G — wire it and report); the DEV box exists, is claimed, internal and Healthy on the `.6` twin (or the branch
twin, as recorded); `publish-dev` delivered one real candidate twin to it through the default waves and a soak (a short
`--soak 10m` is fine for the proof; the orchestrator runs the 2 h soaks later); the runbook is written.
