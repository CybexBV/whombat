# Brief M — manager, helper, release tools, versions

Worktree `~/Code/.wt/whombat-appliance-ru-manager`, branch `ru-manager` (from `robust-updates`). Ids MG-44…MG-59
(`docs/decisions/manager.md`, `## MG-nn Title (date; refs)` + prose) and NX-105…NX-109 (`docs/decisions/nixos.md`,
same format). You own `manager/`, `helper/`, `release-tools/`, `nix/packages/go.nix`, `nix/packages/runtime/`, the
version plumbing in `flake.nix` (`releaseRuntime`, `proxmoxRelease`, `checks.runtime-pin`), `nix/modules/manager.nix`
(version only), `third_party/whombat-contracts-go/`, `docs/runbooks/{updates,rollback,updates-release-signing}.md`.
Agent G edits `vm-tests/**` and the VM-test wiring in `flake.nix`; agent P edits `release/**`, `harness/**`, `dev/**`:
coordinate through the orchestrator if you need their files.

Contracts: agent C is cutting **0.22.0** with `CompareVersions`, `CheckCompatibleActivation`, `UpdateFailureDetail` (Go
types in `go/device`), `UpdateFacts` additions (read `…/briefs/C-contracts.md` for the exact shapes). Until the release
exists, develop against the contracts worktree (`~/Code/.wt/whombat-contracts-robust-updates/go`, e.g. a temporary
`replace` or `go.work` you don't commit); when the orchestrator tells you 0.22.0 is cut, vendor it into
`third_party/whombat-contracts-go` exactly as MG-01/MG-26 describe (tarball from `dist-release/0.22.0/`, SHA-256 in
`VENDORED.md`) and commit that.

## Tasks

1. **UP-A1 versions (NX-105).** Runtime: `nix/packages/runtime/default.nix` version becomes
   `"${releaseVersion}-${src.lastModifiedDate}.${shortRev}${patchTag}"` (14-digit UTC commit time of the flake input);
   `releaseRuntime` keeps appending `.<label>`. Release builds (`proxmoxRelease`) assert the runtime's package.json
   version is ≥ `0.2.0` (agent R bumps Whombat to 0.2.0; until the pin moves the assertion stops a release build with a
   clear message — that is intended) and that the resulting version is ≤ 64 chars (contracts `VersionString`). Manager:
   `proxmoxRelease` overrides the manager package's version to `0.2.0-${self.lastModifiedDate}.${self.shortRev or
   self.dirtyShortRev}` (appliance semver `0.2.0` defined once in `flake.nix`); every other build keeps a static
   `0.2.0-dev` (so VM tests don't rebuild per commit). The version reaches the manager's config (`managerVersion`) and
   the tuple (`release/build-proxmox` reads `manager.version`). Check `harness/src/dev/services.ts`'s dev version string
   (`0.0.0-dev+<commit>`) still compares sensibly and tell the orchestrator if P should change it. Update
   `checks.runtime-pin` if it compares versions.
2. **UP-A2 transition proof.** A Go test in `helper/pkg/trust` over a checked-in testdata file listing every version
   in the field: every `tuple.json` in `~/.cache/whombat-releases/*/`, the release-tools fixtures, the tuples in the DEV
   TUF repository (`~/.whombat-stack-dev/env/manager/tuf/…/targets.json`, `custom.whombat.tuple`; read-only) — record
   them with their release ids. Assert: the first new-scheme runtime (`0.2.0-<14 digits>.<rev>`) and manager
   (`0.2.0-…`) compare newer than every recorded runtime/manager version; host ids order by day then counter;
   `CheckForward` accepts old → new for each recorded tuple. Replace the helper's `CompareVersions` body by a call to
   the contracts' `release.CompareVersions` if identical (keep the helper exported name), or keep it and add a test that
   both agree on the contracts' vectors.
3. **UP-A3 nothing older is signed (MG-44).** `tufrepo publish-release` (and `add-release`) refuse when, among the
   repository's published releases **of the same id family** (NX-67 patterns `pve-YYYYMMDD.N` / `pve-dev-YYYYMMDD.N`;
   other ids — fixtures, harness fakes like `rt-dev-…` — are not compared), the newest has a higher host, runtime or
   manager version than the candidate, or the candidate's id doesn't sort after it. Message names the component, both
   versions and that release. `--allow-downgrade-from <id>[,<id>…]` permits it and writes the TUF-signed
   `custom.whombat.allowDowngradeFrom` (the helper already parses it; `devtuf.AddReleaseAllowingDowngrade` exists).
   New `tufrepo check-newer --tuple tuple.json (--dir <repo> | --metadata-url <url>)`: the same check read-only, from a
   local repository or a published one over HTTPS (verify the metadata chain against the repo's root when it is a
   `--dir`; over a URL read `timestamp → snapshot → targets` and check hashes; say plainly what it verified). `tufrepo
   status` lists releases with their three versions. Prod mode flags as the other commands. Tests.
4. **UP-B2 exit 0 uses the floors (MG-45).** `checkSchema`: exit 0 with `s.Target != nil` →
   `release.CheckCompatibleActivation(cur, cand, db, {Readers, Writers})`; without → `CheckActivation` as before. Look at
   `knownGoodAccess` and every other `CheckActivation` call for the same question. testworld tests: a custody rollback
   after an expand (installed runtime writes schema 12, the older candidate writes 11, database 12 with floors 11/11,
   the release carries `allowDowngradeFrom` the installed id) activates and is healthy; the same without
   `allowDowngradeFrom` is refused as a downgrade; a contract-floored database refuses the older candidate
   (`candidate_read_only`), nothing changed. (Agent G adds the VM case with real runtimes.)
5. **UP-E3 failure detail (MG-46).** `Failure` gains the structured fields (`Reasons`, schema numbers, failed checks,
   rollback access); every place that builds a `Failure` or a rollback code fills what it knows (grep `Code:` and
   `beginRollback(`). `contractRecord`/status/progress send `update.failureDetail` (contracts `UpdateFailureDetail`) and
   `status.report` sends `runtimeVersion` (the current tuple's runtime version). Codes, ids and numbers only — never
   `Message` text, never paths. **Tolerate an older control:** control validates device bodies strictly, so a control
   before 0.22 answers 400 to these new members; on a 400 validation answer for `status.report`/`update.progress`,
   resend once without `failureDetail`/`runtimeVersion` and remember that for the process lifetime (log once). Tests with
   the fake control (`manager/internal/controlapi/fakecontrol`), including the old-control fallback.
6. **UP-E4 owner facts (MG-47).** The runtime facts' `UpdateFacts` gain `failureDetail`, `waiting {reason, since,
   blockers (kind → count)}` (from the candidate's `Deferral`), `lastUpdate {release, from, at}` (persist in the
   journal state when a candidate becomes the healthy current release). Tests in `broker`.
7. Docs: MG entries; `updates.md` runbook sections “Versions” (the scheme, the transition, how to read an ordering
   refusal), “Custody rollback” (`--allow-downgrade-from`, what exit 0 with floors means) and the failure detail;
   `rollback.md` updated.

## Tests to pass

`go vet ./... && go test ./...` at the module root (all packages), `nix eval` of
`(builtins.getFlake "git+file://$PWD").lib.proxmoxRelease { env = "dev"; releaseId = "pve-dev-20260929.1"; }`'s
`runtime.version` and `manager.version` (expect the assertion message at the current Whombat pin 0.1.0 for the runtime;
prove the format with `--override-input whombat` of a local Whombat checkout at a commit whose package.json you set to
0.2.0 in a throwaway worktree, or by evaluating the version expression directly), and `nix build
.#checks.x86_64-linux.runtime-pin` if it exists, under the heavy lock. Don't run the big VM tests; agent G does.
