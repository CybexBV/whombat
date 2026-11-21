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
