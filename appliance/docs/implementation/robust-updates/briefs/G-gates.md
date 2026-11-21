# Brief G — upgrade gates in VMs with the real previous releases (UP-C2, UP-F2)

Worktree `~/Code/.wt/whombat-appliance-ru-gates`, branch `ru-gates`. Ids NX-110…NX-119 (`docs/decisions/nixos.md`,
`## NX-nn Title (date; refs)` + prose). You own `vm-tests/upgrade-gates/**`, `vm-tests/update-migration.nix`,
`vm-tests/default.nix` and the VM-test/check wiring in `flake.nix`, and a new runner `release/upgrade-gates`. Agent M
changes version plumbing in `flake.nix` (`releaseRuntime`, `proxmoxRelease`) and the Go code; agent P writes
`release/ship` which calls your runner. **All VM tests and big builds only under the heavy lock** (common brief).

This is the gate that was missing on 2026-09-28: nothing installed a candidate as an **update** of the release boxes
actually run. Read first: `vm-tests/update-migration.nix` (real runtimes, fake control, fixture TUF repo, placeholder
artifacts with bundles in the VM store; 332 s), `vm-tests/install-proxmox-vm.nix` (ISO install into a disk, host update
by hand with `nix-store --import`; 1133 s), `vm-tests/common/*`, `release/build-proxmox`, `flake.nix`
(`proxmoxRelease`, `releaseEnvs`, `releaseRuntime`), `docs/decisions/nixos.md` NX-66…NX-71, NX-100…NX-104,
`docs/decisions/manager.md` MG-06, MG-09, MG-20, MG-41, MG-43, the release records in
`~/.cache/whombat-releases/*/build.json` (`source.rev` = the appliance commit, `runtime.whombatRev`, `class`,
`reusedHostFrom`, tuple, store paths).

## What to build

A runner `release/upgrade-gates --candidate <build.json> [--previous <build.json> …] [--gates 1,2,…] --out
<upgrade-gates.json>` and the NixOS tests it runs. The candidate is a build of the current tree (or a given appliance
rev); previous releases are the real ones: **N−1 = `pve-20260928.6`** (production's box), **N−2 = `pve-20260928.4`**
(the release before it that boxes ran; its manager predates MG-43). The gates:

1. N−1 → candidate, through the real manager, helper, TUF (fixture keys) and the fake control, with a populated
   database (create an org/burrow/messages through the runtime, or seed the DB directly and verify rows after); ends
   Healthy on the candidate, rows intact.
2. N−2 → candidate (a box that skipped one; its old manager must accept a candidate without a migration).
3. Fresh install from the candidate's ISO (gate env), self-registration with the fake control, claim if the fake
   control supports it (else record what first boot proves), first boot healthy.
4. A candidate made to fail verification (e.g. its runtime reports another version, as `rt-new-bad` does) → automatic
   rollback to N−1, Healthy on N−1, no data lost.
5. Migration classes on the candidate's runtime: expand without a checkpoint; contract with a backup destination
   (checkpoint, then migrate — a local restic repository in the VM is fine); contract without one (waits with the
   checkpoint explanation, nothing changed); **custody rollback after an expand** (UP-B2: an older runtime release with
   `allowDowngradeFrom` activates on the migrated database and is healthy; agent M adds the manager logic — until it
   lands on `robust-updates`, write the case and expect it to fail, then re-run when the orchestrator says). Extend
   `update-migration.nix` for these (it already has most).
6. A runtime-only release on the previous host (`--reuse-host` shape: same host store path, new runtime) and a host
   release that keeps the runtime.
7. (UP-F2) Restore drill: take the checkpoint of a contract migration (gate 5), make the migration fail, restore that
   checkpoint onto a fresh box (`docs/runbooks/restore.md`, `whombat-backup` drill/quarantine apply), data intact.

**How to get “the real previous releases”.** The published PROD closures pin production's TUF root and endpoints, so a
VM can't be fed a candidate signed for them. Build the previous releases **from their recorded sources**:
`builtins.getFlake "git+file:///home/me/Code/whombat-appliance?rev=<source.rev>"` → its `lib.proxmoxRelease { env =
"dev"; releaseId = …; }`, then `.appliance.extendModules { modules = [ ./vm-tests/upgrade-gates/gate-env.nix ]; }`
pointing TUF (metadata/targets URLs, pinned root = the fixture repository's root), control and relay at the test's
nodes. The runtime store path is then **identical** to the published one (check it against `build.json` and record it);
the host differs only by the environment module. If the old flake's private input `whombat` must be fetched, use the
maintainer account’s token (common brief) or `--override-input whombat git+file:///home/me/Code/Whombat?rev=<whombatRev>`.
Decide how artifacts move: real `nix-store --export` streams through TUF (most faithful; host streams are ~4.8 GB) or
placeholders with the closures in the VM's store (as `update-migration` does). Prefer real streams at least for gate 1's
host update if the run time stays acceptable; record the choice and its reason (NX entry). The DEV box (agent P)
exercises real downloads over the network in any case.

**Run time.** Share work: one installed disk image per previous release (built once as a derivation, cached in the
store; gates boot copy-on-write overlays), one candidate build shared by every gate, and one fixture TUF repository
build per candidate. Target: all gates in well under 2 hours on this machine, most of it cached on a re-run.
`upgrade-gates.json`: `{v:1, releaseId, buildSha256 (of the candidate build.json), previous: [{releaseId, rev,
runtimeStorePath, matchesPublished: bool}], gates: [{id, name, ok, seconds, log}], ok, at}`.

## Done when

Every gate passes against the candidate built from the `robust-updates` tree (use `release/build-proxmox dev
pve-dev-<today>.9xx --allow-dirty --out ~/.cache/wb-tmp/gate-candidate` or your own derivation if you don't need the
exported directory), a deliberately broken candidate fails gate 4's expectation the right way, the runner writes the
record, and the NX entries explain the design. Keep the existing `checks.update-migration` green.
