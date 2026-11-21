# Contracts 0.32.0 — what the Vault SSH streams build on

Released 2026-10-01: whombat-contracts main `b7328d9` (merge of `vault-ssh`), tag `contracts-v0.32.0`, decisions
CT-199…CT-206 in `~/Code/whombat-contracts/docs/decisions/contracts.md` (CT-205 lists every name and where it differs
from VT-S…). Not pushed: the lead pushes. Vendored into Whombat `vault-ssh` (`d63e58c9`) and whombat-app `vault-ssh`
(`4ed5500`, worktree `~/Code/.wt/app-vault-ssh`); the stubs each left are listed at the end.
Source of truth: `~/Code/whombat-contracts/packages/core/src/vault/{schemas,ssh,decide,copy,entry,request,tools}.ts`,
`packages/core/src/contracts/{vault,mcp-vault}.ts`, `packages/protocol/src/session/*`. Everything a reader parses is
defaulted or optional; code that *builds* the views adds the new fields (see “Type-level” below).

## Enums and unions
- `VAULT_ENTRY_KINDS` + `ssh` (`mcp|http|login|ssh|secret`); `VAULT_TEMPLATES` + `ssh` before `secret`;
  `VAULT_TEMPLATE_DEFS.ssh` {kind ssh, label “SSH key”, description “A private key your agents use to sign in to
  servers over SSH. They never see the key.”, auth `ssh_key`}; `vaultTemplateOf('ssh', …)` → `ssh`.
- `VaultAuth` + `{type:'ssh_key', keyType: ed25519|rsa|ecdsa, publicKey, fingerprint, origin: generated|imported}`
  (type `VaultSshKeyAuth`). Server-written only. `vaultCredential` throws for it.
- `VAULT_CHECK_OUTCOMES` + `host_key_unconfirmed`, `host_key_changed`.
- `VAULT_FAILURES` (+ `VAULT_FAILURE_TEXT`) + `withheld` (VT-D22's sentence), `no_server`, `host_key_unconfirmed`,
  `host_key_changed`, `rejected` (“The server refused the key.”), `file_error`.
- `VAULT_ERROR_CODES` + `server_name_taken` (conflict), `host_key_mismatch` (conflict, `details.hostKey`);
  `VaultLimit` + `servers` (`VAULT_LIMIT_MESSAGES.servers`).
- `VaultUseDecision` blocked reasons + `wrong_kind`, `server_not_covered` (with `serverName`);
  `VAULT_USE_MESSAGES.wrong_kind`.
- Ids: `ID_PREFIXES.vaultSshServer` `vss`, `VaultSshServerId`.

## Views (`@whombat/core/vault`)
- `VaultSshServer {id, name, host, port, username, hostKey: {algorithm, fingerprint, trustedAt}|null, seenHostKey:
  {algorithm, fingerprint, seenAt}|null, check: VaultSshServerCheck {status, outcome|null, summary, checkedAt},
  createdAt, updatedAt}`. `hostKey` = the pin; `seenHostKey` = what the last check saw that isn't trusted (unknown or
  changed) — the trust card shows it. `VaultSshHostKey {algorithm, fingerprint}`.
- `VaultSshCheckResult {serverId, outcome, status, summary, hostKey|null, checkedAt}`.
- `VaultEntryDetail.servers` (default `[]`), `VaultEntry.serverCount` (default 0), `VaultKeyView.servers:
  VaultKeyServers` (default null = All servers; array may be empty after removals), `VaultUse.server` and `.exitCode`
  (default null).
- Schemas: `VaultSshKeyType`, `VaultSshKeyOrigin`, `VaultSshPublicKey`, `VaultSshFingerprint`, `VaultKeyServers`,
  `VaultKeyServersChoice` (bodies: null or 1–20 distinct ids), `VAULT_SSH_PUBLIC_KEY_ALGORITHMS`.
- Limits: `VAULT_SSH_SERVERS_MAX` 20, `_SERVER_NAME_MAX` 40, `_HOST_MAX` 253, `_USERNAME_MAX` 32, `_DEFAULT_PORT` 22,
  `_PORTS_DEFAULT` [22], `_PRIVATE_KEY_MAX` 16 000, `_PASSPHRASE_MAX` 1024, `_RSA_MIN_BITS` 2048, `_COMMAND_MAX`
  16 000, `_STDIN_MAX` / `_OUTPUT_MAX` 256 KiB, `_TIMEOUT_DEFAULT_S` 120, `_TIMEOUT_MAX_S` 900, `_FILE_MAX` 1 MiB,
  `_PATH_MAX` 4096, `_WHAT_COMMAND_MAX` 160, `_CONNECT_DEADLINE_MS` 30 000, `_KEEPALIVE_MS` 15 000, `_IDLE_MS`
  300 000, `_CHANNELS_MAX` 4 (all `VAULT_SSH_…`).

## REST routes and session ops (`api.vault.*`; all `wrong_kind` on a non-`ssh` entry)
| Op | Route | Body | Answer | Safety |
|---|---|---|---|---|
| `vault.create` (changed) | POST `/burrows/:burrow/vault` | `+ sshKey?: VaultSshKeySource` (`{mode:'generate'}` \| `{mode:'import', privateKey, passphrase?}`), required for `ssh`; no `url`/`auth`/`secret` | `VaultEntryWriteResponse` | secret, never |
| `vault.generateSshKey` | POST `…/vault/:entryId/ssh-key/generate` | — | `VaultEntryWriteResponse` | destructive, receipt |
| `vault.replaceSshKey` | PUT `…/vault/:entryId/ssh-key` | `ReplaceVaultSshKeyBody {privateKey, passphrase?}` | `VaultEntryWriteResponse` | **secret**, never |
| `vault.addSshServer` | POST `…/vault/:entryId/servers` (201) | `AddVaultSshServerBody {name, host, port=22, username}` | `VaultSshServerWriteResponse {entry, eventId, serverId}` | receipt |
| `vault.updateSshServer` | PATCH `…/servers/:serverId` | `UpdateVaultSshServerBody` (any, ≥1) | `VaultSshServerWriteResponse` | receipt |
| `vault.removeSshServer` | DELETE `…/servers/:serverId` | — | `VaultEntryWriteResponse` | destructive, receipt |
| `vault.checkSshServer` | POST `…/servers/:serverId/check` | — | `VaultSshCheckResponse {entry, result, eventId=null}` | receipt |
| `vault.trustSshHostKey` | POST `…/servers/:serverId/trust` | `TrustVaultSshHostKeyBody {fingerprint}` | `VaultSshCheckResponse` (signs in once after trusting; `eventId` set) | receipt |
| `vault.setKeyServers` | PUT `…/keys/:agent/servers` | `SetVaultKeyServersBody {servers: null \| ids}` | `VaultEntryWriteResponse` | receipt |
| `vault.giveKey` (changed) | PUT `…/keys/:agent` | `+ servers?: VaultKeyServersChoice` (absent: keep / All for a new key) | as before | as before |
- `vault.check` and `vault.setSecret` on an `ssh` entry: `wrong_kind`. Server ops sign `vault.entry.changed`, trust too;
  generate/replace sign `vault.entry.secret_replaced`; key servers `vault.key.changed`; Check signs nothing.
- Import problems: `validation_failed` on `privateKey` / `passphrase` (`sshKey.privateKey` at create) with
  `VAULT_SSH_KEY_PROBLEM_TEXT`; destinations: `address_not_allowed` with `details.problem` a
  `VaultSshDestinationProblemCode`.
- `SECRET_API_OPS` + `vault.replaceSshKey`. `SESSION_API_LEVEL` **25** (window 23…26). `RUNTIME_FEATURES` + `vault.ssh`
  (`SINCE_0_32`).
- Fixture fetch serves all eight; `createFixtureFetch({vaultEntries: [vaultSshDeployKey]})` adds the SSH fixture.

## Pure rules (`@whombat/core/vault`, `vault/ssh.ts`)
- Fields: `VaultSshServerName` / `vaultSshServerNameProblem` / `VAULT_SSH_SERVER_NAME_PATTERN`, `VaultSshUsername` /
  `vaultSshUsernameProblem` / `VAULT_SSH_USERNAME_PATTERN`, `VaultSshHost` / `parseVaultSshHost` → `{host, hostKind}`
  (canonical; store this), `VaultSshPath` / `vaultSshPathProblem`, `VaultSshFileMode` (`^0?[0-7]{3}$`),
  `VaultSshCommand`, `VaultSshPrivateKeyText`, `VaultSshPassphrase`, `VAULT_SSH_FIELD_TEXT`.
- `vaultSshDestinationProblem({host, port, resolved, networks, sshPorts?, at?})` → `{code: bad_host|unresolved|
  port_not_allowed|never|mixed|not_listed, message, suggestion?}` | null; `VAULT_SSH_DESTINATION_PROBLEMS`;
  `VAULT_SSH_ADDRESS_NOT_ALLOWED_ANY_MORE` (at `call`); `parseVaultSshPorts(env)` for `WHOMBAT_VAULT_SSH_PORTS`.
- `vaultKeyCoversServer(key, serverId)`, `vaultKeyCoveredServers(key, servers)`.
- `decideVaultUse({…, use?: VaultUseKind, entryKind?})` — `VaultUseKind` = `{kind:'tool'|'request'|'sign_in'}` |
  `{kind:'ssh', serverId, serverName}`; order: search → no key → wrong kind → server not covered → pass → tier.
  `VAULT_USE_ENTRY_KIND`, `vaultServerNotCoveredText(name)`, `vaultUseMessage(decision)` handles both new reasons.
- Keys: `parseVaultSshPublicKey`, `vaultSshFingerprint(line)`, `vaultSshFingerprintOfBlob(bytes)`,
  `vaultSshAuthorizedKeysLine(publicKey, entryId)` = `restrict <key> whombat-<entry key>`, `vaultSshKeyComment`,
  `vaultSshHostKeyLabel`, `vaultSshHostKeyFile`, `bytesToBase64`, `base64ToBytes`.
- Import: `inspectVaultSshPrivateKey(text)` → `{format, encrypted, algorithm, publicKey}` or `{code, message}`;
  `VAULT_SSH_PRIVATE_KEY_FORMATS`, `VAULT_SSH_KEY_PROBLEMS` / `VAULT_SSH_KEY_PROBLEM_TEXT` (`empty`, `too_long`,
  `not_a_key`, `public_key`, `putty`, `certificate`, `several_keys`, `fido`, `unsupported_type` from core;
  `rsa_too_short`, `passphrase_needed`, `wrong_passphrase`, `unreadable` for the runtime's parser).
- Scrubbing (VT-S10): `vaultSshKeyForms({privateKeys, raw?, passphrase?})`, `holdsVaultSshKey(text, forms)`,
  `vaultSshPrivateKeyLines(text)`, `VAULT_SSH_KEY_LINE_MIN` 24, `VAULT_SSH_PASSPHRASE_FORM_MIN` 8.
- Uses: `vaultSshUseWhat({tool:'exec', server, command} | {tool:'read'|'write', server, path})`; RECENT USE
  `vaultUseWhatText`, `vaultUseOutcomeText` (“exit 0”), `vaultUseRow` (uses both).
- Servers: `vaultSshServerTarget`, `vaultSshServerReady`, `vaultSshEntryCheck(servers)` (fills an `ssh` entry's
  `check`), `vaultSshCheckSummary(outcome, {username?, reason?})`, `vaultSshCheckStatus(outcome)` (unconfirmed →
  `unchecked`, changed → `failing`), `VAULT_SSH_NO_SERVERS`.
- SFTP: `VAULT_SSH_FILE_ERRORS` (`no_such_file|permission_denied|is_a_folder|failure`), `VAULT_SSH_FILE_ERROR_TEXT`.

## MCP tools (`VAULT_MCP_TOOLS`, `requiredKey: null`; `VAULT_SSH_TOOL_NAMES`)
- `ssh_exec` `VaultSshExecInput {entry: VaultEntryRef (id or 8-letter key), server, command, stdin?, timeoutSeconds=120}`
  → `VaultSshExecOutput` = `ok` + `VaultSshExecResult {exitCode|null, signal|null, stdout, stderr, stdoutCut,
  stderrCut, timedOut, ms}` | `VaultToolRefusal`.
- `ssh_read_file` `VaultSshReadFileInput {entry, server, path, offset?, maxBytes?}` → `ok` + `VaultSshReadFileResult
  {content, encoding text|base64, size, cut}` (`readOnly: true`).
- `ssh_write_file` `VaultSshWriteFileInput {entry, server, path, content, encoding=text, mode?, append=false}` → `ok` +
  `VaultSshWriteFileResult {bytes}`.
- `isVaultToolName` / `isVaultActivityTool` include them (activity: “Used a private Vault entry”).
- `VaultContextEntry.servers?: VaultContextSshServer[] {name, target (owner's turn) | null, ready}`;
  `VaultDispatchContext.tools` lists the three when an `ssh` entry is present.
- Prompt: `vaultSshServerLine(server, ownersTurn)`, `VAULT_SSH_NO_SERVERS_FOR_AGENTS`, `VAULT_SSH_AGENT_RULES`.

## Copy (`vault/copy.ts`)
- `VAULT_SSH_COPY` (key, generate, useOwn, privateKey, passphrase, generateHint, passphraseHint, publicKey,
  authorizedKeysHint, copy, copied, generateNew, replaceOwn, replaceWarning, servers, noServers, addServer, editServer,
  serverName, serverNameHint, host, port, username, check, edit, remove, removeServer, hostChangeNote, trustQuestion,
  trust, hostKeyChanged, serversChooser, allServers, sshOnWeb).
- `vaultSshTrustCopy(hostKey)` → `{question, fingerprint, compare, command, after, text, action}`;
  `VAULT_SSH_KEY_TYPE_LABELS`; `vaultKeyServersText(servers, entryServers)`; `vaultSshServerCheckLine(server, now, tz)`;
  `vaultEntryMeta` for `ssh` (“SSH key · ED25519 · 3 servers · 2 agents”, takes `serverCount`);
  `vaultCheckSummary(outcome, {kind:'ssh', username?})`.

## Fixtures (`@whombat/fixtures`)
- `vaultSshDeployKey` (opt-in, not in `VAULT_ENTRIES`): web-1 trusted/signed in, staging waiting for trust; Dusty All
  servers, Pippa staging only at Asks. `FIXTURE_SSH_PUBLIC_KEY`, `FIXTURE_SSH_FINGERPRINT`, `FIXTURE_SSH_HOST_KEY`.
- `FixtureFetchOptions.vaultEntries`; `createVaultWorld(extra?)`.

## What the runtime and app streams must know
- **Type-level**: building `VaultEntry` needs `serverCount`; `VaultEntryDetail` `servers`; `VaultKeyView` `servers`;
  `VaultUse` `server`, `exitCode`; `VaultAgentKey` `serverNames`. Switches over `VaultAuth['type']`,
  `VaultTemplate` and `VaultCheckOutcome` gain cases. `TOOL_HANDLERS` needs the three SSH handlers.
- **Vendoring stubs to replace**: Whombat — `apps/server/src/mcp/tools.ts` answers the SSH tools with
  `SSH_NOT_YET`; `mcp/server.ts` never lists them (list them with the Vault's tools for an agent holding a key to an
  `ssh` entry); `vault/store.ts` fills `serverCount: 0`, `servers: []`, key `servers: null`, use `server/exitCode:
  null`, `serverNames: null`; `managed/runtime-features.ts` has `vault.ssh` in `NOT_IMPLEMENTED` (move it to
  `IMPLEMENTED_FEATURES`). whombat-app — the Add to Vault tiles leave out `ssh` (`AddToVaultModal.tsx`), `signsInText`
  reads “Signs in with an SSH key” (web and mobile), `FEATURE_NAMES['vault.ssh']` “SSH keys in the Vault”.
- Names that differ from the spec: two host-key fields (`hostKey`, `seenHostKey`) instead of one with a nullable
  `trustedAt`; “key servers” is both `vault.setKeyServers` and `giveKey.servers`; the create body's key is `sshKey`;
  `decideVaultUse` takes `use` + `entryKind`; a server waiting for first trust is `unchecked`, not `failing`;
  `vault.check` on an `ssh` entry is `wrong_kind` (the entry's dot comes from `vaultSshEntryCheck`); trusting signs in
  once and answers like a Check.
