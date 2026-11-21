# Assignment: the assistant runs the Vault for its person

Spec: `docs/decisions/vault-self-serve.md` (VS-01…VS-14) in this branch. Background: `docs/decisions/vault.md` (keys
VT-20…VT-33, tools VT-40…VT-44, SSH VT-S01…VT-S15, agents without a key VT-G01…VT-G07), `vault-asks.md` (VA-01:
`onlyOwnerReads`), `agent-computer.md` AC-30…AC-34 (scrubbing what agents write, `computer/secrets.ts`),
`server-signin.md` SI-04/SI-09 and `apps/server/src/hosts/install.ts` (`vaultPins`, `KEEP_KEY_COMMAND`, `#keepKey`:
the first-contact trust and key-leaving code to reuse), `assistant-name-server.md` AN-S26 (`giveAssistantsTeamKeys`:
the boot-step pattern).

Lead: this session (merges, releases, ships). Integration branches `vs`: Whombat `~/Code/.wt/whombat-vs`, contracts
`~/Code/.wt/contracts-vs`, app `~/Code/.wt/app-vs`.

## Streams and worktrees

| Stream | Worktree (branch) | Items | Numbers |
| --- | --- | --- | --- |
| C contracts 0.112.0 | `~/Code/.wt/contracts-vs` (vs) | every schema, tool and copy change below | CT-780…CT-799 |
| S server | `~/Code/.wt/whombat-vs-s` (vs-s) | VS-01, VS-02, VS-04…VS-14 | VS-S01…VS-S40, migration 0129 |
| W app: shared client + web | `~/Code/.wt/app-vs-web` (vs-web) | VS-03, VS-07's line, VS-10's copy | AP-4000…AP-4029 |
| M app: phone | `~/Code/.wt/app-vs-mobile` (vs-mobile) | VS-03, VS-07's line on Android | AP-4030…AP-4059 |

Contracts first: C lands everything below and builds `dist-release/0.112.0` (`pnpm release`, from a clean tree); the lead
vendors it into Whombat `vs` and app `vs`, and S, W and M merge `vs` then. Until then build what needs no new contract
(S: VS-01, VS-02, VS-10, migration; W/M: the key row VS-03 on today's API).

Rules for every stream:
- Read the repo's CLAUDE.md / ARCHITECTURE.md / DECISIONS.md first; follow its conventions, decision files and test rules.
- Commit on your branch (small, imperative, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
  **Never push, never merge into main, never tag or release**: the lead does that.
- DEV is fast: one quick check per repo when you finish (`pnpm format` then `pnpm check`; S also `pnpm test:server`
  once, or only the integration files you touched plus the vault ones when the full run is slow). No VM tests, no CI.
  One repo's full check at a time on this machine.
- `TMPDIR=/home/me/.cache/wb-tmp`, Node 24 (`export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`).
  Server tests use the shared Postgres :55432 with your own throwaway databases; never stop or reset shared containers.
- Never connect to a real server or service while building: tests use the existing fakes (the Vault's SSH test server,
  `hosts/testing/fake-install-ssh.ts`, the outbound seam). Check facts in tests (codes, names, ids, a short key phrase),
  not long sentences.
- Visible words are plain and short (concise-replies.md); copy here is verbatim (curly quotes ’ “ ”, `·`, `…`, `•`).
- Record decisions you take under your number range: Whombat `docs/decisions/vault-self-serve.md` (“Runtime as built”),
  contracts `docs/decisions/contracts.md`, app `docs/decisions/vault-self-serve.md` (create it).

## C — contracts 0.112.0 (CT-780…)

All packages to 0.112.0. Additive only: older runtimes and apps keep working.

1. **`vault_save`** (`contracts/mcp-vault.ts`, in `VAULT_MCP_TOOLS`, `personal: true`, `requiredKey: null`,
   `readOnly: false`). `VAULT_SAVE_KINDS = ['login', 'token', 'basic']`.
   `VaultSaveInput = { kind, name?: VaultEntryName, description?: VaultEntryDescription, address?: string ≤ 2000,
   username?: VaultUsername, secret: VaultSecretValue, entry?: VaultEntryRef, made: boolean = false }` with refinements:
   without `entry`, `name` and `address` are required and `username` too for `login`/`basic`; with `entry`, no
   `address`, no `name`, and `made` must be false. Each field `.describe()`d for the model (kind: login = a website
   signed in to in the browser, token = an API token sent as Bearer, basic = an API with a username and password;
   secret = “exactly as the person wrote it”; made = “true only for a password you made yourself”).
   `VaultSaveOutput = ok {entryId, name, created: boolean, blanked: int ≥ 0} | VaultToolRefusal`. Description:
   “Save a login, password or API token to the Vault of the person this turn is for, so it can be used from now on. Use
   it right away when they send you one in a room only they read; Whombat blanks it in their message. Never repeat the
   secret in your reply.”
2. **`vault_add_server`** (same place, `personal: true`). `VaultAddServerInput = { entry?: VaultEntryRef, address:
   string 1–260 (host or IP, `:port` optional), username?: VaultSshUsername, name?: VaultSshServerName, password?:
   string 1–1024 }`, described (entry: “leave out when the person has one SSH key or none”; password: “only when the
   person sent this server’s password in this chat and the key isn’t on it yet: used once to add the key, never kept”).
   `VaultAddServerOutput = ok {entryId, entryName, server, target ('user@host:port'), outcome: 'signed_in' |
   'key_added' | 'key_refused' | 'already', publicKey: string | null} | VaultToolRefusal` (`publicKey` only with
   `key_refused`: the `authorized_keys` line). Description: “Add a server to an SSH key in the person’s Vault and sign in
   to it, so ssh_exec and the other SSH tools reach it. Use it before working on a host the key doesn’t list yet.
   Whombat trusts the server’s key the first time it connects.”
3. `VAULT_SELF_SERVE_TOOL_NAMES = ['vault_save', 'vault_add_server']`; `isVaultActivityTool` true for both (neutral
   rows, no evidence). Not in `isVaultToolName` (they aren't uses of an entry).
4. **`Message.vaultSaved`** (`domain/message.ts`): `z.array(MessageVaultSave).max(5).optional()`, `MessageVaultSave =
   {entryId: VaultEntryId, name: VaultEntryName, kind: VaultEntryKind, how: 'saved' | 'used_once', server: string | null,
   at: Timestamp}`. `VAULT_BLANKED = '••••••'` (six U+2022). Copy `vaultSavedLine(s)`: saved → `Saved to your Vault ·
   {name}`; used_once → `Used once to put “{name}” on {server}, not kept`.
5. **Audit**: new types `vault.entry.saved` and `vault.keys.own_given` (kind Vault, `domain/audit.ts`);
   `vaultAuditText('entry.saved')` = `Saved a private Vault entry`; `vaultOwnKeysText(agentName, n)` = `Whombat gave
   {agent} a key to a private Vault entry` (n = 1) / `Whombat gave {agent} keys to {n} private Vault entries`.
6. **Copy for apps** (`vault/copy.ts`): `vaultAssistantAccessCopy(agentName)` → `{ title: '{agent} can use this',
   choices: { can: 'Allowed', ask: 'Ask me first', off: 'Off' }, hints: { can: '{agent} uses it whenever it needs to.',
   ask: '{agent} asks you once each time it needs it.', off: '{agent} can’t use it.' } }`. `VAULT_SAVED_INTRO` for the
   Vault's intro (VS-08): `When you send {agent} a login in your chat, it saves it here and blanks it in your message. The
   AI provider has seen that one message.` (function of the agent's name).
7. **Agent guidance** (CT-785; `vault/copy.ts`, `vault/request.ts`, tool descriptions): see VS-13.
   - `VAULT_SAVE_RULES` (personal assistants), in order:
     “When the person sends you a login, password or API token in a room only they read, save it with vault_save right
     away, the secret exactly as they wrote it, then say in one line what you saved. Never repeat the secret.” ·
     “In a room other people read, don’t take one: ask them to send it to you in your own chat with them, or to add it in
     the Vault.” · “A new password for something already saved goes to that entry (vault_save with entry). You can’t
     change where a saved login or token points; the person can, in the Vault.” · “A password you make yourself (say, for
     a new database user) goes in with made: true, never into chat.” · “For SSH use vault_add_server: a server’s password
     is used once to put the key on it and never kept.”
   - `VAULT_SSH_ADD_SERVER_RULE` (personal): “When you’re asked to use a key on a host that isn’t one of its servers, add
     it with vault_add_server first, then carry on, and say so in one line. If they mean a listed server under another
     name, use that one.” Team agents keep today's last rule of `VAULT_SSH_AGENT_RULES` (move it to its own export).
   - `vaultSshSetupSteps(agentName, { personal })`: personal → “Vault → Add → SSH key (generate a new key, or use your
     own private key).”, “On the entry, Servers → Add server, or tell {agent} the address: Whombat trusts the server’s key
     the first time it connects.”, “Add the public key line the entry shows to ~/.ssh/authorized_keys of that user on the
     server, or send {agent} the server’s password once in your chat and it adds the key.”; not personal → today's steps
     without “Check, compare the fingerprint … Trust this server”.
   - `vaultUnheldAskLine(facts, { personal })` and `VAULT_UNHELD_NOTE_OFF = 'switched off for you'`: personal → `{Owner}
     switched you off for it: they can switch “{agent} can use this” back on in the Vault → “{entry}”.`; else today's.
   - `VAULT_ACCESS_RULES` 2nd: “… never ask for a secret in a room other people read …”. `vault_request` and
     `request_vault_key` descriptions: “Never ask for a password or token in a room other people read.”
   - `vaultNoServerText(names, { canAdd })`: canAdd → `That host isn’t one of this key’s servers yet: add it with
     vault_add_server{, or use one of: a, b}.`
8. Tests for the refinements, the copy functions' facts and `isVaultActivityTool`. Decisions CT-780…CT-799 in
   `docs/decisions/contracts.md`. Then commit and `pnpm release` (clean tree) → `dist-release/0.112.0`; tell the lead.

## S — server (VS-S01…, migration 0129)

1. **VS-01** `vault/commands.ts`: `giveOwnAssistantKey(ctx, row)` after `insertEntry` in `vault.create` and
   `vault.create_ssh` (Sign in once's `#keepKey` goes through `createVaultSshEntry`, so it follows), for kinds other than
   `secret`; the person's personal agent (`principals.ownerId`, active, `keyHolderProblem` null); tier `can`, servers
   null, delivery `whombat`; signed `vault.key.given` by the actor.
2. **VS-02** boot step `giveAssistantsVaultKeys` (next to `giveAssistantsTeamKeys`, through the pipeline), with
   migration **0129** adding a partial index for the `vault.key.taken` look-up (e.g. on `(payload->>'agentId')` where
   `type = 'vault.key.taken'`) if the events table needs one; signed `vault.keys.own_given` by the assistant.
3. **Migration 0129** also: `vault_entries.saved_by_id text` (the assistant that saved it, VS-07) and
   `messages.vault_saved jsonb` (`MessageVaultSave[]`). Expand only; `compat.json` as the repo's migration rules say.
4. **VS-04…VS-08** `vault_save`: handler in `apps/server/src/vault/` (new file), registered in `mcp/tools.ts`, served per
   VS-12 in `mcp/served.ts`. Checks: personal agent of the requester (`ctx.onBehalfOf.principalId`), `onlyOwnerReads`
   on the dispatch's conversation, the anchor (VS-05: SQL `strpos(text, $secret) > 0` on the requester's messages of
   that conversation, last 7 days, not deleted), destination check as the REST create does (outside the transaction),
   then one commit signed **as the agent** (`vault.save`: insert the entry owned by the requester with `saved_by_id`,
   the key, `vault.entry.saved`; or `replaceSecret` + `vault.entry.secret_replaced`), then the blanking (VS-07: the
   messages, `vault_saved`, `message.updated` frames) in the same or a following commit. `insertEntry` today requires a
   person actor: give it an explicit owner instead of weakening `requirePerson` for people's routes. Scrub list:
   `computerNeedles` (or a sibling the choke points read) also holds the forms of entries `saved_by_id = agent`, and a
   per-dispatch in-memory set for VS-11's passwords; forget them as today. Make sure the Vault part of the session
   fingerprint changes (a new held entry does; a replaced secret must too, e.g. `updatedAt`).
5. **VS-09…VS-11** `vault_add_server`: reuse `openSshSignIn` / `openSsh`, `vaultPins` (move it into `vault/` and use it
   from both), `KEEP_KEY_COMMAND`, `generateSshKey` + `createVaultSshEntry` for the “Servers” key, `addVaultSshServer` +
   `trustVaultSshHostKey` (or one agent-signed command that adds a trusted server; owner-only commands stay owner-only
   for REST). Name from `hostname -s` over the new connection. The password path: anchored like VS-05, sign in with it
   (accept-new with the owner's pins), `KEEP_KEY_COMMAND` with the public line on stdin, close, sign in with the key to
   confirm; blank the password in the messages with `vaultSaved {how: 'used_once', server}`; never log, sign or store
   it.
6. **VS-10** accept-new everywhere: `openSsh` gains a first-contact mode (no pin → accept the key shown, report it);
   `ssh-use.ts` uses it for a server without a pin and records the trust (signed by the agent, `vault.entry.changed`);
   the owner's Check (`runSshCheck`) does the same; both check the owner's other pins for that host and port first.
   `host_key_unconfirmed` disappears from normal use; `host_key_changed` is unchanged. Update the prompt's “Not confirmed
   yet …” turn line (`vaultTurnLines`) to only changed keys.
7. **VS-12, VS-13** `mcp/served.ts` (SSH tools + the two new tools for personal agents in their owner's turns),
   `vault/context.ts` (unheld = switched off for personal assistants), `packages/agent-runtime/src/persona/vault.ts`
   (the rules from C.7, `vaultShortLines` for a personal assistant: its person's entries are its own, send it here or
   add in the Vault, no “give you a key”), `vaultNoServerText` with `canAdd`. Run `pnpm prompt:size` if it exists and
   note the change.
8. **VS-14** activity: both tools neutral in `runtime/activity.ts` and `apps/runner/src/activity.ts` (via
   `isVaultActivityTool`).
9. `loadMessages` returns `vaultSaved`.
10. Tests (`*.int.test.ts` with a reason to need Postgres): auto key on create (and none for `secret`), the boot step
    (gives, skips taken-back, idempotent, one event), `vault_save` (refused in a shared room and for a non-owner turn,
    anchor, made, replace without address, blanking + `vaultSaved` + frame, scrub of the agent's next post, destination
    refusal), `vault_add_server` (only key, none → “Servers”, several → refused, already, first-contact pin, pin
    mismatch refused, key refused → added + publicKey, password → key added + blanked, name from hostname), accept-new on
    use and Check. Then `pnpm format`, `pnpm check`, `pnpm test:server`.

## W — shared client + web (AP-4000…)

1. **VS-03** `apps/web/src/features/vault/VaultEntryDetail.tsx` `Keys`: in the assistant shell, replace the section with
   one row: the assistant's avatar and `vaultAssistantAccessCopy(name).title`, a segmented control Allowed / Ask me
   first / Off (giveKey `can` + `servers: null`, giveKey `ask` + `servers: null`, takeKey), the chosen hint under it, and
   the existing How it's used chooser beneath while a key is held and computers run. No “Give a key to…”, no picker, no
   servers chooser. Crew shell untouched. Remove now-dead assistant-shell branches.
2. The Add to Vault flow and empty states: no “give a key” step or wording in the assistant shell (the key exists).
   SSH servers: Check no longer shows “Is this your server?” for a new server (server-driven); make sure the add-server
   hint and any “Trust this server” copy only speak of a **changed** key (VT-S05 card stays for that).
3. **VS-07** message line: under a message with `vaultSaved`, a small line per item with a lock glyph and
   `vaultSavedLine(item)`, the saved kind linking to the entry (`/vault?entry=<id>` or the app's Vault route); `••••••`
   in the text renders as text. Shared helpers in `packages/client` if the phone needs them too.
4. VS-08's intro line on the Vault page in the assistant shell.
5. Tests (vault.test.tsx, ssh.test.tsx, message rendering) and a visual check of the Vault entry page and a message with
   the line at 1440×900, light and dark. `pnpm format`, `pnpm check`.

## M — phone (AP-4030…)

1. **VS-03** `apps/mobile/src/screens/VaultEntryScreen.tsx`: the same row (segmented Allowed / Ask me first / Off with
   44px targets, the hint), replacing the keys list in the assistant shell; How it's used as today.
2. **VS-07** the `vaultSaved` line under messages (lock glyph, tap opens the entry), `••••••` as text.
3. Tests; render on the emulator if one is available, else say so. `pnpm format`, `pnpm check`.
