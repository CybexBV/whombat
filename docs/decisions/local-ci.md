# Shared CI on The Titan — 2026-10-18

Buildbot at http://100.64.0.18:18091/ schedules ordinary CI and publishes GitHub
commit statuses. Artifacts are at http://100.64.0.18:18092/. The old September
Actions runner fleet is retired. Shared controller source is
`/home/me/Code/ci-platform`; the running installation is `/opt/ci-platform`.
Its `config/projects.json` is authoritative for triggers, nightly schedules,
resources and timeouts. The workflow adapter reads supported job steps from
`.github/workflows/ci.yml`; YAML `on`, concurrency and job timeouts do not control
Buildbot scheduling. The runtime check and package each have a 3600-second guest
budget and four vCPUs / 12 GiB; source/admission/export add separate time.

Owner policy remains same-repository PR/manual CI, quick checks for DEV, and
required full validation before production. The October 18 config generated
unwanted main work; its correction (`repair/confirmed-shared-ci`) is installed
since 2026-10-19. Existing nightly schedules remain.
Do not treat this document as proof the new policy has been installed: inspect
installed configuration/provenance.

Use `ci-platform run whombat-runtime --job check --revision FULL_SHA --ref REF`
and `--job package` when needed. Check existing exact-input work before submitting
again. The CLI reuses compatible pending/running work; `--rerun` is an
explicit separate attempt. GitHub Actions dispatch is for the separately retained
release/signing workflows, not ordinary shared CI. Production signing, native
ARM checks and production approval are unchanged. The four-worker integration
limit and documented systemd-user-scope skips remain; green runtime CI does not
prove the skipped sandbox coverage.

PR unit-test scope follows `ci-selection.md`: ordinary source changes may run their transitive unit-test importers,
with a full-suite fallback for shared or uncertain inputs. This supersedes the unit-test scope of the historical
complete-check requirement below at the owner's request. The full Postgres suite and two-minute soak remain gates;
non-PR runs use the complete unit suite, and `WHOMBAT_CI_FULL=1` explicitly requests it.

## Historical migration record

The following describes the retired September setup, not current scheduling.

# Local CI — 2026-09-29

The owner requested local execution, dependency caches and build storage across the six Whombat repositories,
while keeping GitHub repositories, pull requests and their checks. GitHub Actions remains the scheduler and log
interface; regular Linux CI runs on `thetitan`. The repositories’ owner is a user account, so the runners are scoped to each
repository rather than an organization. Existing Whombat Check Runs integration continues to work unchanged.

## Execution

Each repository has a dedicated Ubuntu 24.04 Incus VM, separate from development checkouts, credentials and
Postgres. Workers have four vCPUs; contracts, API and relay have 6 GiB RAM, while runtime and app have 12 GiB
for parallel TypeScript and browser/native builds. The Nix/KVM appliance worker has eight vCPUs and 16 GiB.
Each guest has 2 GiB emergency swap; the six-worker RAM allocation totals 58 GiB. Toolchain provisioning, resource bounds and cleanup are documented in `local-ci-infra.md` and
`scripts/ci/infra/README.md`. Jobs use disposable checkouts and explicit persistent dependency caches. No
GitHub `actions/cache`, setup-action caching, or artifact upload is used in ordinary CI. Outbound requests to
GitHub for source, Actions and scheduling, and to upstream dependency registries remain necessary.

Workflows run on same-repository PRs and manual dispatch (`gh workflow run ci.yml`); since 2026-09-30 no longer on main
pushes, at the owner's request (CI on request only; appliance IN-132). Superseded runs are cancelled. Tag
pushes no longer repeat the same contracts checks. Fork contributions require review and a maintainer branch
before execution on these private workers. No production publishing or deployment is triggered by CI.

The existing runtime checks, real PostgreSQL integration tests, two-minute idle-memory soak, reproducible
package build and package smoke test remain required. The prior runtime failures were ambient-environment
assumptions in tests; see `local-ci-tests.md`. The full integration run also exposed invalid PostgreSQL
`ORDER BY 0` for short/emoji-only requests: memory now omits the absent text-rank sort and retains recency
ordering, with a real database regression test. Four repositories gain repeatable CI around their existing checks.

## Build storage

`/opt/whombat-ci/bin/artifact save NAME PATH...` writes a compressed archive and a manifest identifying its
repository, commit, run, attempt, SHA-256 and retention. Paths are relative to the command's current directory, or to `RUNNER_TEMP` for job diagnostics.
`artifact restore NAME DIRECTORY` validates the archive checksum before extracting. Storage is mounted into
only that repository's worker at `/srv/whombat-ci/artifacts`; on the host it is under
`/var/lib/whombat-ci/artifacts/<repository>`. Names cannot be replaced by the helper within a run attempt, but
this is ordinary build storage, not a release trust boundary: a repository's worker controls its own disk.
Production signing must never treat an unsigned artifact manifest as authorization to publish a release.

Artifacts are browsable at https://thetitan.tail1a2b3.ts.net:10444/ while connected to Tailscale. nginx has a
read-only mount, forbids symlinks and binds host loopback; Tailscale Serve exposes it to the tailnet only.
Workflow summaries link to each artifact. There is no public tunnel or anonymous internet access.

Default retention is 14 days; `--retention-days N` supports explicitly retained outputs up to 365 days. A daily
systemd timer removes expired artifacts with valid manifests and mirrors retained data to
`/hdd/backups/whombat-ci/artifacts`. This is a second-disk copy on the same server, not an off-site backup.
Source and workflow definitions remain on GitHub. Disposable dependency caches are not backed up.

## Release boundaries

The existing manually dispatched Release workflow remains separate from ordinary CI. Its native ARM64 smoke
validation and protected signing/publishing environment are preserved. The x86 server cannot provide native
ARM execution, and ordinary PR workers must not acquire release-signing credentials. That workflow is not
triggered by any push and has never been run as of this migration. Its GitHub-hosted ARM/signing and artifact
handoff are explicit exceptions; all routine checks/builds and their artifacts are local.

Existing GitHub artifacts were downloaded, ZIP-validated, SHA-256-checked and copied to the HDD pool before
removing their GitHub copies. `scripts/ci/storage/import-github.py` records original run/commit/expiry metadata.
