# Test pruning — 2026-09-26

This repository participates in the [combined six-repository reduction](../../../docs/decisions/test-pruning.md):
**900 / 4,501 passing tests removed (20.0%, rounded)**, with a maximum two-percentage-point
coverage drop per metric in each repository.

Here: **253 → 241 passing tests; 12 removed**.
Count Vitest passing cases and Go top-level `Test…` functions; nested Go subtests are
part of their parent. Existing skips and opt-in browser/VM/live acceptance suites remain.
Tests are deleted rather than skipped or consolidated; production source is unchanged.
Prefer overlapping fixture/schema, copy/shape and positive-path smoke assertions, while
retaining negative security, recovery and regression checks.

## Coverage

Baseline commit: `e6ee51e37bdf8c6bdd3949b1d3f18f07828146b6`. Same source files, denominator,
runners and instrumentation before and after. Vitest includes unimported source files.

| Runner / metric | Before | After | Drop (points) |
| --- | ---: | ---: | ---: |
| Vitest / statements | 6.84% | 6.84% | 0.00 |
| Vitest / branches | 5.23% | 5.23% | 0.00 |
| Vitest / functions | 8.01% | 8.01% | 0.00 |
| Vitest / lines | 6.80% | 6.80% | 0.00 |
| Go / statements | 65.9% | 65.8% | 0.1 |

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
cd harness
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage --maxWorkers=4
cd ..
go vet ./...
go test -race -count=1 -p=4 -coverpkg=./... -coverprofile="$TMPDIR/whombat-coverage.out" ./...
go tool cover -func="$TMPDIR/whombat-coverage.out"
```

For the baseline, use the recorded commit in a separate checkout with this same
coverage config, coverage dependency and lockfile changes, but the original tests.

Use `go tool cover` from this Go module directory; do not sum duplicate raw blocks
from `-coverpkg=./...` profiles or run it from the parent JavaScript repository.
