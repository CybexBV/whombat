# Test pruning — 2026-09-26

The user chose a **combined 20% reduction across all six repositories**, with coverage
within **2 percentage points**. This removes **900 of 4,501 passing tests (20.0%, rounded)**,
leaving **3,601**. The limit is enforced separately for every measured coverage metric in
each repository, so a larger suite cannot hide a regression in a smaller one.

## Counting and selection

Count Vitest's reported passing cases (including `it.each` rows) and Go's top-level
`Test…` functions. Nested Go subtests belong to their parent and are not double-counted.
Existing skipped tests are excluded from both counts and remain skipped. Browser/VM,
release acceptance and opt-in live-provider suites were outside these baseline runners
and remain intact. Deleted cases are removed, not disabled or folded into larger tests.

Candidates were ranked by per-test coverage overlap and reviewed for assertion value.
Prefer repeated fixture/schema examples, static copy/render smoke checks and positive
paths exercised by retained interaction/integration tests. Retain security boundaries,
named regressions, rejection paths and tests needed to initialize shared integration
state. Coverage is evidence of execution, not proof of equivalent assertions; the audit
lists every deletion for review. Dedicated signing, secure-channel, authorization,
recovery and race suites remain, including negative key-parser/development-key checks.

Only tests, coverage tooling/dependencies and documentation change. Production source
and the coverage denominator are unchanged. The concurrent console resize-race fix on
runtime commit `5361f92` is retained; it changes neither the test count nor source coverage.

## Test counts

| Repository | Before | Removed | After | Largest drop (points) |
| --- | ---: | ---: | ---: | ---: |
| Whombat (this file) | 2,032 | 309 | 1,723 | 1.89 |
| [the app](../app/decisions/test-pruning.md) | 1,184 | 403 | 781 | 1.97 |
| control (the private whombat-cloud repository) | 162 | 8 | 154 | 0.00 |
| [the contracts](../contracts/decisions/test-pruning.md) | 798 | 163 | 635 | 1.86 |
| [the appliance](../../appliance/docs/decisions/test-pruning.md) | 253 | 12 | 241 | 0.10 |
| the relay (the private whombat-cloud repository) | 72 | 5 | 67 | 0.00 |
| **Combined** | **4,501** | **900** | **3,601** | **1.97 maximum** |

## Coverage

Baseline commit: `0219f81e7d6bb25824ad2ef2dd0f490d49327034`. Same source files, denominator,
runners and instrumentation before and after. Vitest includes unimported source files.

| Runner / metric | Before | After | Drop (points) |
| --- | ---: | ---: | ---: |
| Vitest / statements | 81.95% | 80.61% | 1.34 |
| Vitest / branches | 73.06% | 71.17% | 1.89 |
| Vitest / functions | 83.94% | 82.71% | 1.23 |
| Vitest / lines | 85.35% | 84.10% | 1.25 |

The [machine-readable audit](test-pruning-audit.json) records baseline/final counts,
raw coverage totals and the names of every removed test. Vitest thresholds are the
baseline minus two points for statements, branches, functions and lines.

Validation passed: the repository check (lint, types and unit tests), the coverage
run above, and Go race/vet checks where applicable. Runtime also passes its separate
PostgreSQL server integration command.

## Reproduce

Measured with Node 24.18.0, pnpm 12.3.4, Go 1.26.8 and the lockfile-pinned Vitest.

```sh
export TMPDIR="$HOME/.cache/wb-tmp"
export VITEST_MAX_WORKERS=4
mkdir -p "$TMPDIR"
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage --maxWorkers=4
pnpm test:server
# test:coverage also includes the CLI and server integration projects.
```

For the baseline, use the recorded commit in a separate checkout with this same
coverage config, coverage dependency and lockfile changes, but the original tests.

Integration tests use a real PostgreSQL server and their own throwaway databases.
