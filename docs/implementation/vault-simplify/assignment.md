# The Vault for one person, and asking for sign-ins — assignment

Spec: `docs/decisions/vault-simplify.md` (VLT-01…VLT-49). Read it, `CLAUDE.md`, the Vault section of
`ARCHITECTURE.md`, `docs/decisions/connect-in-chat.md` (CIC-10…CIC-15, the card this extends),
`docs/decisions/vault-self-serve.md` (VS-09…VS-11, `vault_add_server`) and the Vault parts of `one-person.md`.

Integration branch: `vault-simplify` (lead's worktree `~/Code/.wt/whombat-vsa`). Each stream works in its own worktree on
its own branch made from `vault-simplify` (`git switch -c vsa-<stream> vault-simplify` in the checkout you were given,
or `git worktree add -b vsa-<stream> ~/Code/.wt/whombat-vsa-<stream> vault-simplify`). The lead merges.

## Streams

| Stream | Branch | What | Starts from |
|---|---|---|---|
| K — contracts | `vsa-k` | `packages/core` (and `packages/protocol` if a session op changes) for VLT-40…46: `vault_ask` kinds `server` and `code` with their inputs (address, username, reason, entry) and answers; the guide card's `GuideVaultAsk` for them (the server's three ways, the file field for a private key, the passphrase field); `totp` settable on login entries (bodies, `VaultEntry.totp` meaning), a server's kept password state; `vault_add_server`'s `password` documented as ignored; the card's words (VLT-49) as core copy both apps use; the runner↔server internal shapes the waits need if they live in core. Contracts version 3.14.0 in the seven packages, `pnpm contracts:gen` if a cross-language form changed. Unit tests for the new schemas and words. | `vault-simplify` |
| A — asks | `vsa-a` | Server, runner, Hermes plugin, commands for VLT-20, VLT-40…48: `vault_ask` for the new kinds in any room of the person's; the `server` card's three ways on the server (reuse `add-server.ts`, `ssh-keys.ts` import, VS-10 first contact); the kept password used by the commands' SSH through an askpass helper reading the turn's tmpfs (`packages/commands`, `packages/agent-runtime` sandbox); `code` held in memory for the turn; TOTP from the runner's logins service; the plugin as a registered login backend (`ctx.register_login_backend`) serving Hermes's save-login and code prompts through the runner and server with the waits of VLT-45; `vault_add_server` ignoring `password`; the agent's Vault lines (VLT-48); migration for the kept password and the authenticator key. Tests: unit for logic, Postgres integration for the card's save paths and the CIC-15 canary for each kind, Python tests for the plugin (`pnpm hermes:test`). | `vsa-k` once K is done |
| W — app | `vsa-w` | `packages/client`, `apps/web`, `apps/mobile`: the card for `server` (three ways as a choice, password field, private key paste or file pick with passphrase, errors on the field, retries), `code`, `login` with the authenticator key; the locked card's words; the entry page's Authenticator key field for website logins and a server's kept password shown as set; Add to Vault without Connection and an `mcp` entry's “Move it to Connections” note (VLT-30); the desk's “Answer on your phone or computer” (VLT-41). Visual check on web in both themes; phone on the fixture server. App decisions in `docs/app/decisions/vault-asks.md` (create), ids AP-6650+. | `vsa-k` once K is done |
| C — clean-up | `vsa-c` | VLT-10…12 and VLT-30: the switch on the entry (migration folding `vault_keys`, `giveKey`/`takeKey` setting it, every reader of `vaultKeys` moved), the person's words in the Vault's code, `vault.md`'s “What holds today” and Superseded marks, `mcp` entries moved to Custom MCP server connections at start (and Add to Vault's templates without `mcp` in core: the one core change C makes). Don't touch `ask.ts`, `add-server.ts`, `logins.py`, the runner's logins service (stream A's). | `vault-simplify` |

## Numbers

- Decisions: server-side rows as `VLT-S01…` in `docs/decisions/vault-simplify.md` under a section of your stream
  (A: `VLT-S01…S39`, C: `VLT-S40…S69`); K: `CT-1660…CT-1699`; W: `AP-6650…AP-6699`; plugin `HE-S302…S319`.
- Migrations: A `0035_vault_asks`, C `0036_vault_switch` (renumbered at merge after main's backup places migrations).

## Rules for every stream

- Work only in your worktree. Never `git stash` (it is shared by every worktree); compare with old code through
  `git show <rev>:<path>`. Never search from `/` or `$HOME`; search inside the repository.
- `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`, `export TMPDIR=/home/me/.cache/wb-tmp`.
  Use the shared Postgres on :55432 with throwaway databases of your own; a free `PORT` if you run a server. Never
  stop or reset shared containers.
- Before you finish: `pnpm format`, then `pnpm check` must pass; streams A and C also `pnpm test:server` (A also
  `pnpm hermes:test`). Run one check at a time.
- Small commits on your branch, imperative messages, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't merge into `vault-simplify` or `main`, don't push.
- Visible words follow CLAUDE.md (“Agents and automations talk like people”) and VLT-49. Tests check facts, not long
  sentences.
- Finish with: your branch and head, what you built, decisions you added, what you couldn't do and why.
