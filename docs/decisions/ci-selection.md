# Unit tests affected by a pull request — 2026-11-07

| # | Decision | Reason |
|---|---|---|
| US-01 | A PR runtime check may select affected unit tests for ordinary TypeScript/JavaScript source changes under server, web and mobile. Use Vitest's transitive dependency graph against one exact merge base. Full Postgres integration tests, lint, types, contracts, storage tests and the full two-minute soak still run. | The owner requested that small changes avoid unrelated unit tests while improving CI. This supersedes ci-performance.md CIP-02's requirement to run every unit test on every PR, and the equivalent unit-test scope in local-ci.md; it does not change the other gates or merge verification. Local `pnpm check` stays complete. |
| US-02 | Selection requires `refs/pull/N/head`, an exact `GITHUB_SHA` checkout, the controller-bundled `origin/ci-base` commit, one merge base and clean tracked inputs. Missing or uncertain inputs run every unit test. `WHOMBAT_CI_FULL=1` forces the complete suite. | Compare all changes in the PR, not just its latest commit. Non-PR refs, including ordinary manual/main/benchmark runs, remain complete. The existing controller bundles the admitted PR base; no ci-platform configuration change is needed. |
| US-03 | Shared packages, contracts, configuration, CI scripts, database/commit/auth/approvals/vault/managed/runtime code, test setup, seed and bootstrap inputs require every unit test. Deletions, renames, unknown file types or failed/empty discovery do too. | Imports do not describe every runtime relationship. Workspace packages may be externalized by the test graph, so shared changes cannot safely narrow coverage. Default to the full suite whenever that graph is insufficient. |
| US-04 | Markdown under `docs/`, the root README and LICENSE do not add unit tests. A PR changing only those inputs records a documentation-only unit phase; all other gates still run. Save selection mode, reason, exact commits, changed paths, discovery duration and selected files in `ci-reports/`. | Make omitted work explicit and reviewable. HTML references and executable/configuration inputs are not documentation-only. Full-suite benchmark comparisons reject scoped or omitted unit runs. |

The selector calls `vitest list --filesOnly --changed MERGE_BASE` to resolve transitive imports, aliases and literal
dynamic imports, then passes the selected file paths to the ordinary unit command. Discovery time belongs to the
unit phase. Its execution-contract tests cover exact base/head validation, fallback paths and real Vitest dependency
discovery with unrelated Proxmox tests excluded.

The focused Python suite passed 20 tests before the owner requested that testing stop and the changes be committed.
No full repository check or CI measurement was run for this follow-up after that instruction. Selection savings have
not been benchmarked; the separate CI audit measures full-suite scheduling only.
