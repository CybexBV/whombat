# Local CI (2026-09-29)

GitHub keeps the repository, pull requests, workflow dispatch and check results. Builds run on the
repository's dedicated Linux runner VM on thetitan, selected by the `whombat` and repository labels.
`ci` runs on main pushes, same-repository pull requests and manual dispatch. Foreign PR jobs do not run
on workers with persistent caches. Superseded runs for the same ref are cancelled; there are no
additional tag-triggered copies of the main checks.

The runner provisions Node 24, pnpm 12.3.4, Go 1.26.8, Docker and required test tools. The workflow uses
persistent local pnpm, Go and browser caches under `/srv/whombat-ci/cache`; temporary files use
`/var/tmp/whombat-ci`. Tests use at most four workers and Go builds use at most four parallel packages.
There are no GitHub cache or artifact actions. `/opt/whombat-ci/bin/artifact` stores immutable build
outputs and diagnostics locally by repository, run and attempt (with a checksum manifest). GitHub
still keeps workflow logs and check results. Runner provisioning owns cache cleanup, artifact
retention and backup policy.

The exact checks are `scripts/ci/check.sh`; each command must succeed. The CI infrastructure is separate
from development services: database jobs get a disposable PostgreSQL 17 container on a dynamic port.
CI never deploys or signs releases and never resets shared development databases.

Standard CI runs Go formatting/vet/race tests and builds, the vendored contracts and stand-in tests,
and both the integration harness and console UI lint/types/unit checks. Backup/recovery tests use the
job's PostgreSQL container and provisioned PostgreSQL 17, restic, rest-server, sshd and MinIO tools;
missing tools or unavailable nftables user/network namespaces fail the job instead of silently making
those integration tests disappear. MinIO is the existing S3 test fixture from `backup/scripts/test-tools.sh`,
bound to loopback only for the duration of the test; CI does not deploy a backup storage service.

The separate standard `nix` job builds `runtime-pin`, `proxmox-config`,
`eval-aarch64`, `console`, `browser-config`, `vault-wall-config` and `containers-config` (`computers-config`
until NX-455). The appliance worker alone has a read-only deploy key for fetching the flake's private runtime input; it has no deployment or signing
credentials. Nix retains its local store and builds with at most two jobs of two cores each.

The nightly/manual `virtual-machines` workflow runs manager units, the real runtime, real-runtime
backup isolation and Vault wall, the real browser, update migrations, restore drill and console VM
suites. Drivers run sequentially using KVM outside the Nix build sandbox, following NX-26. Logs and
small test reports are retained locally; temporary guest disks are removed. This selection does not
replace image-installation/TPM tests, candidate-specific upgrade gates, product scenarios, live-provider
checks or hardware qualification in the release process.
