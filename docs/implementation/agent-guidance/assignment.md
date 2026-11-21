# Mentions in any case, and agents that guide people to the Vault (2026-10-01)

John wrote `@banjo are you able to connect to root@203.0.113.44 using the private ssh key in the vault?` in a channel
thread on dev.whombat.com. Nothing happened, and two things were wrong:

1. **`@banjo` is not a mention.** Core's `MENTION_PATTERN` is `@` + a capital + lowercase letters, so the message was
   stored with `mentions = {}` and no dispatch was made. Nothing told him: `@banjo` just renders as plain text.
2. **An agent with no Vault key knows nothing about the Vault.** `vaultContextFor` returns null when the agent holds
   no key, so `vaultLines` adds nothing. Banjo wouldn't have known that John's SSH key “Server Access Key” exists (it
   had no servers and no key for Banjo), that SSH goes only through the Vault, how to set it up, or even the rule
   “never ask anyone to paste a secret into chat”. Most likely he'd have tried `ssh` in his sandbox (port 22 is closed
   there, MSB-06) and asked for credentials.

John: “if I can make this mistake any user can”; lowercase must wake the agent, “or even better auto-correct it in
the chat”. Both are fixed below. John wants choices made by us: decide open details yourself, record them in your
stream's decision file, and move on.

Ship target is **DEV** (fast path, IN-132): each repo's quick checks, merge, push, candidate pins, dev instance
restarted. No `harness/validate`, no `release/ship validate`, no VM gates, no waiting on GitHub Actions. Production is
not part of this task. Use `TMPDIR=~/.cache/wb-tmp` for every check. Other agents may be running: own throwaway
databases and free ports only; never stop or reset shared containers.

| Repo | Today | Target |
|---|---|---|
| `~/Code/whombat-contracts` | 0.32.0 | **0.33.0** |
| `~/Code/Whombat` (worktree `~/Code/.wt/whombat-agent-guidance`, branch `agent-guidance`) | main 53fa4984 | runtime changes |
| `~/Code/whombat-app` (branch `agent-guidance`) | 0.21.0 | **0.22.0** |
| `~/Code/whombat-appliance` | candidate 0.28.0 | candidate **0.29.0** |

## A. Mentions in any letter case (record as `docs/decisions/messaging.md` § “Mentions in any case”, MS-C01…)

- **MS-C01 What counts.** `@` + a word whose letters equal, ignoring case, a mention target's mention name (agent
  name; person short name or first name) is a mention of that target: `@banjo`, `@BANJO`, `@Banjo`. Same resolution
  order as today (agents, then people, then personal agents, PA-04). Boundaries for a non-canonical form: the `@` is at
  the start of the text or after a character that isn't a letter, digit, `_`, `.`, `@`, `/` or `-` (so
  `john@banjo.example`, `x/@banjo` aren't mentions); the word ends at a non-letter and isn't followed by `.` + letter/digit
  (`@banjo.example` isn't). Non-canonical forms inside inline code and fenced code blocks stay text. The canonical form
  `@Banjo` keeps today's behaviour exactly. Unknown words (`@nobody`) stay as typed. `@channel` / `@here` stay
  broadcasts (CT-176) and are never principals.
- **MS-C02 Stored canonical.** Core `canonicalizeMentions(text, targets): string` rewrites every resolved
  non-canonical mention to its canonical form (`@banjo` → `@Banjo`) and leaves everything else byte-identical.
  `resolveMentions` resolves on the canonicalised text, so `wouldWakeAgent` (the licence gate), `postMessage`,
  message edits, Feedback rendering and seeds agree. The server's `postMessage` and message edits store the
  canonicalised text (before mentions, signing, search indexing, events) for every author, people and agents.
  `segmentMentions` is unchanged: stored text is canonical, so `@Banjo` renders in brand/600 on web and Android.
- **MS-C03 Auto-correct in the composer** (web and Android, `@whombat/client` if shared). When the person ends a word
  (space, punctuation, newline) right after `@word` that matches a mention target (the composer's member list, the same
  rule as core) case-insensitively but not exactly, the composer replaces it in place with the canonical form, caret
  kept. On send the whole text goes through `canonicalizeMentions` too. The `@` autocomplete matches case-insensitively
  (verify; MS-07). An optimistic message shows the canonical text.
- Unit tests in core (boundaries, code spans, emails, ambiguity, idempotence: canonicalising twice changes nothing);
  server integration test: `@banjo hi` in a channel thread wakes Banjo and is stored as `@Banjo hi`; edit to
  `@pepper` is stored as `@Pepper` and wakes Pepper per the existing edit rules.

## B. Agents guide people to the Vault (record as `docs/decisions/vault.md` § “Agents without a key”, VT-G01…)

- **VT-G01 Always a Vault section.** Every turn that may use the Vault (not `vaultless`: not search answers, Feedback
  assessments, `mode: 'answer'`) carries `DispatchContext.vault`, also when the agent holds no key (`entries: []`), and
  the prompt's `## The Vault` section with the existing rules (never ask for secrets in chat, pending_approval,
  blocked, rooms) plus:
  - “You can’t reach SSH servers or other private services from your sandbox. SSH goes only through an SSH key in the
    Vault, with ssh_exec, ssh_read_file and ssh_write_file; never try ssh, scp or rsync yourself.”
  - “When you need access you don’t have, don’t look for another way: tell the person exactly what is still missing in
    their Vault (the steps below) and stop.”
  - The SSH setup steps (core constant, e.g. `VAULT_SSH_SETUP_STEPS`), told as “say only the steps still missing”:
    1. Settings → Vault → Add → SSH key (generate a new key, or use your own private key).
    2. On the entry, Servers → Add server: a name, the host, port and the username to sign in as.
    3. Check, compare the fingerprint with the server's, and Trust this server.
    4. Add the public key line the entry shows to `~/.ssh/authorized_keys` of that user on the server (unless the key
       already opens it).
    5. Give a key to… → you (`{agent name}`), with All servers or that server.
  Keep it short; it's in every turn. Both prompt builders (runner `apps/runner/src/prompt.ts` and
  `packages/agent-runtime/src/persona`) share `vaultLines`.
- **VT-G02 The requester's own entries without a key.** Contract: `VaultDispatchContext.unheld` (optional, default
  `[]` for older runtimes): in the **owner's own turn only** (`dispatch.onBehalfOfAccountId` = the entry owner's
  account), the requester's entries the agent holds no key to, kinds `http`/`mcp`/`login`/`ssh` (never `secret`), at
  most 20 by name: `{id, name, description, kind, site?, servers?}` with `servers: {name, target, ready}[]` (all of the
  entry's servers; targets are fine in the owner's own turn). Always empty in anyone else's turn: no other person's
  entry is ever named or hinted at (VT-D27). Unheld entries are never usable: no tools, no `decideVaultUse` change.
- **VT-G03 How they read.** Each as `[[vault entry · {kind} · the requester’s own · you hold no key to it]]`, name, the
  description, servers for SSH (`Servers:` list as VT-D53, or “No servers yet”), and “To use it, ask {Owner} to give
  you a key: Settings → Vault → “{name}” → Give a key to… → {agent name}.” Delimited data like the held entries
  (defuse, BP-07).
- **VT-G04 Held SSH keys, wrong or missing server.** Prompt: when the person names a host that isn't one of a key's
  servers, don't guess: tell them to add it (step 2) or which listed server it is. The tool answer for `no_server` names
  the entry's servers the key covers (“That Vault entry has no server by that name. Its servers: web-1, nas.”) — in
  someone else's turn names only, as VT-S12.
- **VT-G05 Freshness.** The session fingerprint's vault part includes the unheld entries (id, last change, servers'
  ready), so a key given, a server added or a host key trusted shows up in the next turn.
- Tests: persona/runner prompt unit tests (no keys → section with rules and steps; unheld SSH entry without servers;
  someone else's turn → no unheld); server integration: `vaultContextFor` for an owner's turn with an unheld `ssh`
  entry, a vaultless dispatch stays null, another person's turn has `unheld: []`.

## Streams

1. **Contracts** (first). A's core functions and tests; B's `unheld` schema, copy constants and the `no_server` copy.
   Release 0.33.0 the way 0.32.0 was released (tag `contracts-v0.33.0`, `dist-release`); write
   `docs/implementation/agent-guidance/contracts-0.33.md` in the Whombat worktree listing every new name. Vendor 0.33.0
   into the Whombat worktree (branch `agent-guidance`) and whombat-app (branch `agent-guidance`).
2. **Runtime** (Whombat worktree). MS-C02 server side, VT-G01…G05, tests, decisions recorded. `pnpm check` +
   `pnpm test:server` (the affected suites at least).
3. **App** (whombat-app, branch `agent-guidance`). MS-C03 on web and Android, check `@banjo` renders `@Banjo` after
   send. Release 0.22.0 (tag `app-v0.22.0`, `dist-release`), vendor into the Whombat worktree.
4. **Appliance** (last, by the lead). Candidate 0.29.0 pinning contracts 0.33.0, app 0.22.0 and the merged Whombat
   main; dev instance on 0.29.0 per `docs/runbooks/dev-instance.md`.

Only the lead merges into `main` and pushes. Push with the maintainer account’s token per command; never change the global gh
account. Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
