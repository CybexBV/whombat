# Provider runtime bundles (pins, digests, packaging)

The provider runtimes a managed release runs, exactly and unmodified (docs/decisions/managed-providers.md PV-01).
Source of truth in code: `packages/agent-runtime/src/providers/bundles.ts`.

Since 2026-10-25 there is no Codex pin: ChatGPT runs on Hermes's own `openai-codex` provider, its sign-in, usage and
models are Hermes's, and no Codex CLI ships with Whombat or runs (`docs/decisions/hermes-native.md` HN-02…HN-04,
HN-C08). The Codex rows below are history.

## Pins (Claude Code 2026-10-25; Codex 2026-09-25, retired 2026-10-25)

Claude Code runs as the unmodified binary for every auth mode, without the Agent SDK
(`docs/decisions/provider-subscriptions.md` SUB-10, SUB-12, SUB-15). Since 2026-10-24 Hermes runs Claude's turns through
Nous's DirectSDK, which drives that binary per model request (`docs/decisions/claude-directsdk.md` CDS-01); the pin is the
newest version DirectSDK 0.3.3 handles (`docs/decisions/hermes-native.md` HN-K08).

| Runtime | Version (`--version`) | Artifact | Digest | Executable sha256 | Linkage |
|---|---|---|---|---|---|
| Claude Code, linux-x64 | `2.1.302 (Claude Code)` | release bucket `downloads.claude.ai/claude-code-releases/2.1.302/linux-x64/claude` (what `claude.ai/install.sh` fetches; the version's `manifest.json` checksum) | `sha256:60d7eb7f12fbb28a52533fe8be5884097403562aa02dc73991a021c7067e29a5` | same (the artifact is the executable) | glibc (`/lib64/ld-linux-x86-64.so.2`) |
| (same binary from npm) | | `@anthropic-ai/claude-code-linux-x64@2.1.302` (`package/claude`; also in `pnpm-lock.yaml`) | `sha512-+d4RUq3E3K+3/J4MysB3z4QXA4rkDNt70VYpTLE6kJCnUe/Z6SB8VJsVJG/NV4bECrvkxkLHjXk+vrgBstfZkw==` | identical (checked) | |
| Claude Code, linux-arm64 | same | release bucket `…/2.1.302/linux-arm64/claude` | `sha256:2bd4f4e5ed5cb09955b490098f745321cb5491e7ea8c752ba1e3bb010cdadb10` | same | glibc (`/lib/ld-linux-aarch64.so.1`) |
| (same binary from npm) | | `@anthropic-ai/claude-code-linux-arm64@2.1.302` | `sha512-eRgp1cK2oSC7vK1/Dha9EsfSxNb6b/LyduzBxRW02c0X+C6xtyAzeGMmRobQSNuTazRxsr/Cf2/l4Sf/LMgxCA==` | identical (checked) | |
| Codex CLI, linux-x64 | `codex-cli 0.157.0` | release `rust-v0.157.0/codex-package-x86_64-unknown-linux-musl.tar.gz` | `sha256:042f851ea3fc1083c45157520520944fc790632b53ebc580fc98eaca55862a25` | `bin/codex`: `1a822376d4634ac32dddc030e5117c63359f7f8cd4b1b64382c68190287d0258` | static-pie |
| (same binary from npm) | | `@openai/codex@0.157.0-linux-x64` | `sha512-3TEPslRaNmlgJST5xMJJ9ZWXW1hr4RlVEpF0tO4NULNGj4b5naWlHa6PlSRiDpnMz322aJkz0uvyyKqc37rLJQ==` | identical `bin/codex` (checked) | |
| Codex CLI, linux-arm64 | same | release `codex-package-aarch64-unknown-linux-musl.tar.gz` | `sha256:c1c36beab0b4f72779adf53ba9e9e494bf7cbfbe4f3506a08ff67a24f5f00d08` | not recorded | static-pie |
| GitHub CLI | `gh version 2.101.0` | release `v2.101.0` | to be recorded on the Nix side | — | static (Go) |

The Codex release asset digests were read from GitHub's release API (`assets[].digest`) and the x86_64 package was
downloaded and re-hashed; npm integrities from the registry. Codex 0.157.0 was one day old at pinning. Claude Code:
both npm platform tarballs were downloaded and their `claude` hashed; the hashes equal the release manifest's
`platforms[linux-x64|linux-arm64].checksum` (`https://downloads.claude.ai/claude-code-releases/2.1.302/manifest.json`,
build 2026-10-16); 2.1.302 was nine days old at pinning (2.1.310 is the newest; DirectSDK's code knows up to 2.1.302).
`minimumReleaseAgeExclude` names exactly these two packages in `pnpm-workspace.yaml`.

## Nix packaging notes (for the NixOS workstream, written when the appliance was a repository of its own)

- **Fetch by hash, install unmodified.** `fetchurl { url = …; hash = "sha256-…"; }` (SRI of the sha256 above) for
  the Codex package tarball; unpack with `runCommand` + `tar`, **no** `autoPatchelfHook`, `patchelf`,
  `wrapProgram` rewriting the binary or `strip` (`dontStrip = true; dontPatchELF = true; dontFixup = true;`).
  E-C1: “The Claude Code binary must not be modified”; the same discipline for Codex.
- **Codex** is static-pie: runs as is. Keep the package layout (`bin/codex`, `codex-resources/bwrap`, `codex-path/rg`)
  — Codex finds its bundled bubblewrap and ripgrep relative to itself. Point the runner at it with
  `WHOMBAT_CODEX_PATH=/nix/store/…-codex-0.157.0/bin/codex`.
- **Claude Code** is glibc-linked with interpreter `/lib64/ld-linux-x86-64.so.2`. Don't patch the interpreter and
  don't launch it through `ld.so` (it's a Bun single-file executable that reads its payload through
  `/proc/self/exe`). Provide the loader path with `programs.nix-ld.enable = true` (libraries: glibc only; its NEEDED
  are libc, libm, libpthread, libdl, librt, ld-linux), or run it in a `buildFHSEnv`. Fetch it by hash from the release
  bucket (`fetchurl { url = "https://downloads.claude.ai/claude-code-releases/2.1.302/linux-x64/claude"; hash =
  "sha256-…"; }`, the SRI of the sha256 above; `dontStrip`, `dontPatchELF`, `dontFixup`, mode 0555) and point the
  runner at it with `WHOMBAT_CLAUDE_PATH`; or take it from the runtime closure's pnpm store, where
  `@anthropic-ai/claude-code-linux-<arch>/claude` is pinned by `pnpm-lock.yaml` (`pnpm.fetchDeps` with a fixed
  output hash). Without `WHOMBAT_CLAUDE_PATH` Whombat runs that npm copy, else `claude` on PATH.
- **Read-only installs**: everything under `/nix/store`; the managed sandbox mounts the install read-only, so no
  self-update could write even if one ran.
- **Pins**: set `WHOMBAT_PROVIDER_PINS=claude=2.1.302,codex=0.157.0` in the runner's unit (MSB-15). A pin that
  disagrees with this build's bundle refuses every turn (`version_drift`) rather than guessing.
- **Self-updaters** (verified against the pins): Claude Code `DISABLE_AUTOUPDATER=1`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (environment) and `env.DISABLE_UPDATES=1` (flag settings, set by the
  provider); Codex `check_for_update_on_startup = false` (each home's `config.toml`) and `-c
  check_for_update_on_startup=false -c analytics.enabled=false` on launch. Nothing to add in Nix beyond the pins.
- **Update class**: a provider bump is a runtime/provider bundle update (MA-11): new closure, new pins, regenerated
  fixtures, the tests below green.

## Bumping a pin

1. Install the new version where the tests run: `pnpm --filter @whombat/agent-runtime add -O -E
   @anthropic-ai/claude-code-linux-x64@<v> @anthropic-ai/claude-code-linux-arm64@<v>` and the same versions in
   `minimumReleaseAgeExclude`.
2. Claude Code has no fixture since CDS-01: check that the DirectSDK vendored in `packages/hermes-whombat` handles the
   version (its README and relay name the versions it knows) and run `pnpm hermes:test`.
3. Update `bundles.ts` (versions, npm SRIs, release digests — for Claude Code the version's `manifest.json`
   checksums —, executable sha256) and this table.
4. `pnpm --filter @whombat/agent-runtime test`: the live tests (when the pinned CLI is installed and `unshare -rn`
   works) check that the installed Claude Code is the pinned binary and its home-only sign-in offline.
5. Re-verify the self-updater switches (see the live tests) and record the date in `bundles.ts`.
