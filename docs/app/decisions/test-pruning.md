# Test pruning — 2026-09-26

This repository participates in the [combined six-repository reduction](../../decisions/test-pruning.md):
**900 / 4,501 passing tests removed (20.0%, rounded)**, with a maximum two-percentage-point
coverage drop per metric in each repository.

Here: **1184 → 781 passing tests; 403 removed**.
Count Vitest passing cases and Go top-level `Test…` functions; nested Go subtests are
part of their parent. Existing skips and opt-in browser/VM/live acceptance suites remain.
Tests are deleted rather than skipped or consolidated; production source is unchanged.
Prefer overlapping fixture/schema, copy/shape and positive-path smoke assertions, while
retaining negative security, recovery and regression checks.

## Coverage

Baseline commit: `1acbff3921775088740b8a7cb55e9fd0d0f1993f`. Same source files, denominator,
runners and instrumentation before and after. Vitest includes unimported source files.

| Runner / metric | Before | After | Drop (points) |
| --- | ---: | ---: | ---: |
| Vitest / statements | 57.69% | 56.04% | 1.65 |
| Vitest / branches | 52.73% | 50.76% | 1.97 |
| Vitest / functions | 53.21% | 51.47% | 1.74 |
| Vitest / lines | 59.19% | 57.68% | 1.51 |

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
```

For the baseline, use the recorded commit in a separate checkout with this same
coverage config, coverage dependency and lockfile changes, but the original tests.
