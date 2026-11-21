# Build and deployment time

The DEV release path is measured from `dev/candidate` starting until it has published the release, checked the
restarted stack and pushed its notes. Home's next update check is outside this interval. The starting reference is
candidate 0.261.1's `summary.json`: 88 seconds (22 candidate and backup, 2 merge, 58 release build and stack, 2 publish,
2 notes, plus setup). The target is at most 61.6 seconds, a further 30% reduction.

- Candidate preflight builds `lib.releaseRuntime` with the pin checks in one Nix invocation. This is the exact
  versioned runtime used by `release/ship`, so the release reuses it rather than compiling a second bundle.
- An explicit `--reuse-host` reads the host from the previous build record. Its early evaluation asks for the runtime,
  manager and ABI without forcing a new NixOS toplevel. Automatic host selection and host releases still evaluate
  the host. The reused host's ABI, component versions, pin checks, newer checks and final twin equality checks remain.
- DEV startup shares a clone and a pending install when components name the same repository and commit. Each keeps
  its own identity in `env.json`. Different commits, repositories and live components keep separate sources.
- The box page and hosted page build in their separate output directories while the services start. A service waits
  for its own page; startup waits for all preparation to settle even after a failure. Migrations and service startup
  keep their dependency order. The backup finishes before merging and publication still waits for the build and a
  healthy stack.
- The environment backup uses `pigz` with four workers when installed, falling back to gzip. Both use their default
  compression level and produce the same `.tar.gz` format; contents, exclusions, permissions and restoration stay
  the same. This keeps compression from delaying the completed preflight without using every core on a shared host.

Validation gates, compression levels and health requirements are retained.

The first complete run, candidate 0.261.2 (Whombat `14351dbc`), took 64 seconds: 23 candidate and backup, 2 merge,
35 release build and stack, 2 publish and 3 notes (rounded stage times). That is 27.3% faster than 88 seconds. Its
environment archive took 22.4 seconds, longer than the 16.8-second Nix preflight, so parallel gzip addresses the
remaining delay. Both runs built a fresh docs-only runtime revision with unchanged dependencies and app sources.

## Verified result

Candidate **0.261.3**, Whombat `3e286cda71dd6304a072a05a455e3b0991a1e897`, completed in **60 seconds**: **28 seconds
saved, 31.8% faster** than the 88-second baseline, meeting the 61.6-second target.

| Stage | Baseline 0.261.1 | First run 0.261.2 | Final run 0.261.3 |
|---|---:|---:|---:|
| Candidate and backup | 22 s | 23 s | 19 s |
| Merge | 2 s | 2 s | 3 s |
| Release build and DEV stack | 58 s | 35 s | 34 s |
| Publish | 2 s | 2 s | 2 s |
| Notes | 2 s | 3 s | 3 s |
| **Total** | **88 s** | **64 s** | **60 s** |

Stage times are rounded separately; the total also includes setup. All three runs built fresh docs-only runtime
revisions with the same host (`whombat-20261109.1`), unchanged dependencies and app sources. This measures the
runtime-only DEV path with existing dependency caches; host, phone and cold dependency builds are outside it.
The final archive took **6.98 seconds**, down from 22.4 seconds, and its gzip integrity check passed.

Formatting and `fast-test` passed in both changed repositories. Harness coverage includes shared clone/install
preparation and failures, independent page outputs, and real backup restoration through both automatic compression
and the gzip fallback (bytes, private permissions, symlinks and exclusions). The deployed stack's status passed;
`https://dev.whombat.com/version.json` reports build `3.115.0+3e286cd`.

`whombat-dev-20261112.18` is published for Home through the normal all-at-once rollout. The source build is
`whombat-20261112.18`; Home's next check is outside the timing. Evidence is in
`$TMPDIR/rel-0.261.3/{summary.json,candidate.log,dev-status.txt,publish.log}` and
`$TMPDIR/rel-0.261.1/summary.json`.
