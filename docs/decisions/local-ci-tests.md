# CI runtime test fixtures

| Decision | Reason |
|---|---|
| CI-T01 | Runtime permission tests construct their own explicit directory modes, executable entry points and home contents. Production permission checks remain unchanged. A developer's private temporary directory and restrictive umask must not hide failures that appear on a clean CI host. |
| CI-T02 | The client-path test that distinguishes private from publicly traversable trees uses a disposable directory directly beneath `/var/tmp`, and removes it in `finally`. The runner's per-file private `TMPDIR` remains intact; changing a descendant's mode cannot make it accessible through that private ancestor. |
| CI-T03 | ACP handshake fixtures use an owner-only shell entry point that executes the current Node binary. Whether a CI tool cache is group-writable is separate from whether a fake ACP agent negotiates the expected capabilities. ACP command-permission tests still exercise rejection of writable commands and parent directories. |
| CI-T04 | The Codex scratch-profile test uses a newly created home with one known toolchain and asserts the entire permission map. Installed tools in the CI user's actual home must not change its expected allowlist. |
| CI-T05 | The integration suite passes its configured `DATABASE_URL` into the production smoke helper. Its throwaway database must use the same isolated PostgreSQL service as the other integration tests, including a dynamic CI port. The standalone `smoke:prod` command retains its separate `SMOKE_ADMIN_DATABASE_URL` override. |
| CI-T06 | Tests compare git dates as Unix seconds (`%at`), not ISO text: whether git writes a UTC offset as `Z` or `+00:00` depends on its version, and the CI VM's git differs from a developer's. |
| CI-T07 | The package smoke makes its temporary directory writable before removing it: installed packs are read-only on purpose (`packs/store.ts`), so a plain recursive remove fails with `EACCES` after an otherwise passing smoke. |
| CI-T08 | A test that hands input to a command it spawns ignores `EPIPE` on that stdin: a command may exit without reading it, and Vitest fails the whole run on the unhandled stream error even when every test passed. |
| CI-T09 | `pnpm check` and `pnpm lint` fail on Biome warnings (`--error-on-warnings`). Warnings that never fail anything piled up to 14 between 2026-10-01 and 2026-10-18; failing them keeps the tree clean. |
