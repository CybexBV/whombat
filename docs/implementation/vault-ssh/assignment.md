# Vault SSH keys (2026-10-01)

John asked for SSH private keys in the Vault so agents can SSH into servers, with one key serving several servers, and
said “implement your suggestion fully”. The spec is `docs/decisions/vault.md` § “SSH keys” (**VT-S01…VT-S15**); read it
and the rest of `vault.md` (VT-01…VT-83, VT-D01…VT-D41) first. John wants choices made by us: decide open details
yourself, record them in your stream's decision file, and move on.

Ship target is **DEV** (fast path, IN-132): each repo's quick checks, merge, push, candidate pins, dev instance
restarted. No `harness/validate`, no `release/ship validate`, no VM gates, no waiting on GitHub Actions. Production is
not part of this task. Use `TMPDIR=~/.cache/wb-tmp` for every check (host `/tmp` runs out of inodes). Other agents may be
running: own throwaway databases and free ports only; never stop or reset shared containers.

| Repo | What | Today | Target |
|---|---|---|---|
| `~/Code/whombat-contracts` | `@whombat/core` (domain, contracts, text, pure rules), `@whombat/protocol` (session ops, API level) | 0.31.0 (CT-198), `SESSION_API_LEVEL` 24 | **0.32.0** (CT-199+), level 25 |
| `~/Code/Whombat` | runtime (`apps/server`, `apps/runner`, `packages/agent-runtime`) | migrations up to `0058_run_attention`, VT-D41 | migration `0059_vault_ssh`, VT-D42+ |
| `~/Code/whombat-app` | web (`apps/web`), Android (`apps/mobile`), `@whombat/client` | 0.20.0 (AP-597) | **0.21.0** (AP-598+) |
| `~/Code/whombat-appliance` | NixOS wall, candidates, dev instance | candidate 0.27.2 (IN-149, NX-127) | candidate **0.28.0** (IN-150+, NX-128+) |

## Streams

1. **Contracts** (first; the others build on it). Everything VT-S02…VT-S11 needs as schemas and pure rules in
   `packages/core/src/vault/` and `contracts/vault.ts`: kind `ssh`, template `ssh`, `auth` `ssh_key`, `VaultSshServer`
   (with its check and host key), `VaultEntryDetail.servers`, key `servers`, `VaultUse.server`/`exitCode`, check
   outcomes `host_key_unconfirmed`/`host_key_changed`, REST routes + session ops (create with generate/import, replace
   key, generate new key, servers add/update/remove/check, trust host key, key servers), MCP tool input/output schemas
   for `ssh_exec`/`ssh_read_file`/`ssh_write_file`, `vaultSshDestinationProblem`, `vaultKeyCoversServer`,
   `decideVaultUse` kind `ssh`, server-name/username/host validators, limits, all copy (verbatim from VT-S…), the
   `authorized_keys` line builder. Secret ops per VT-S03. Unit tests. Release 0.32.0 the way 0.31.0 was released
   (tag, `dist-release`), and write `docs/implementation/vault-ssh/contracts-0.32.md` in the Whombat worktree listing
   every name (like `essentials/contracts-0.26.md`). Then vendor 0.32.0 into Whombat (worktree branch `vault-ssh`) and
   whombat-app (its own branch `vault-ssh`).
2. **Runtime** (Whombat worktree `~/Code/.wt/whombat-vault-ssh`, branch `vault-ssh`). Migration, store/commands/routes/
   session ops, key generation/import with `ssh2`, `vault/ssh.ts` (connection pool, host-key verification, exec, SFTP,
   scrubbing, uses/audit), MCP tools, dispatch context + prompt (VT-S12), owner DM on host-key change, managed-mode
   ops, `WHOMBAT_VAULT_SSH_PORTS` config. Integration tests against an in-process `ssh2` server behind
   `useVaultNetForTests`: generate → add server → check → trust → exec/read/write; host key change; key not covering a
   server; someone else's turn asks; take-back closes connections; echo of the key withheld; canary (VT-80) extended.
   Record VT-D42+ in `vault.md`. `pnpm check` + `pnpm test:server`.
3. **App** (`~/Code/whombat-app`, branch `vault-ssh`, worktree of your choice under `~/Code/.wt/`). VT-S13 on web and
   Android, the approval card for `vault_use` on an `ssh` entry, the audit detail. Light and dark checked on web.
   Release 0.21.0 the way 0.20.0 was released (tag `app-v0.21.0`, `dist-release`), vendor into Whombat.
4. **Appliance** (last). VT-S14 wall + option + env, candidate 0.28.0 pinning contracts 0.32.0, app 0.21.0 and the
   merged Whombat main (new `pnpmDeps` hash: `ssh2` is a new dependency — make sure its optional native parts
   (`cpu-features`) don't break the Nix build), dev instance on 0.28.0 per `docs/runbooks/dev-instance.md`.

Only the lead merges into `main` and pushes. Push with the maintainer account’s token per command; never change the global gh
account. Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
