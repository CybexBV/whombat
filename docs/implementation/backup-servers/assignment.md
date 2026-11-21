# Servers in backups, agents that follow their Whombat, restore fixes — build brief (2026-10-21)

Decisions: `docs/decisions/backup-file.md` BF-13…BF-23 (read BF-01…BF-12 and the details too). **Read them first**,
then §1, §2 and your stream's part of §3. §2's shapes are what every stream builds against.

| Stream | Repo | Worktree | Branch (from) | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-bkx` | `bkx` (main) | CT-900…CT-929, 0.117.0 |
| H hosts | the hosts service | `~/Code/.wt/hosts-bkx` | `bkx` (main) | HS-170…HS-189 |
| P appliance | the appliance | `~/Code/.wt/appliance-bkx` | `bkx` (main) | NX-407…NX-419, BK-31…BK-39 |
| R server: restore fixes | Whombat | `~/Code/.wt/whombat-bkx-restore` | `bkx-restore` (`bkx`) | BF-S01…BF-S29 |
| V server: servers | Whombat | `~/Code/.wt/whombat-bkx-servers` | `bkx-servers` (`bkx`) | BF-S30…BF-S59 |
| U web + phone | whombat-app | `~/Code/.wt/app-bkx` | `bkx` (main) | AP-4410…AP-4439 |

The Whombat integration branch `bkx` (`~/Code/.wt/whombat-bkx`) is the lead's; R and V work on their own branches and
the lead merges them into `bkx`. C, H, P and U commit straight to their `bkx`.

## 1. Rules for every stream

- Work only in your worktree on your branch; small commits (`contracts: …`, `agent: …`, `hub: …`, `nix: …`, `backup: …`,
  `server: …`, `web: …`, `mobile: …`, `client: …`), every message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main` or another stream's
  branch, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`,
  `~/Code/whombat-hosts`, `~/Code/whombat-appliance`): other sessions work there. The lead merges, vendors and ships.
- **Contracts 0.117.0 arrives on `bkx`** (Whombat and app). R, V and U start with what doesn't need the new types;
  when the lead says it is vendored, `git merge bkx`. Need a contract change? Don't edit vendored tarballs: tell the
  lead the exact additive change in your report or message.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (H: `go vet ./... && go test ./...`; P: the Go tests of the module you touched and the `nix build`/eval named in §3),
  plus the server test files you touched (R, V; `pnpm test:server` once at the end). Run single test files while you
  work. No VM gates, no CI waits. Node 24: `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`.
  `/tmp` runs out of inodes: `TMPDIR=~/.cache/wb-tmp`. Own ports (R 4501, V 4503, U 4505/5205) and throwaway
  databases on the shared Postgres :55432, which is never stopped or reset. Temporary containers or VMs only through
  `/usr/local/bin/agent-resource` (read `/home/me/Code/dashboard/docs/agent-resources.md` first).
- **Never touch John's real servers, services or DEV box** from tests or scripts (pve-01, pve-02, the-falcon, blackbox,
  The Titan's agent, the `whombat-dev-box` VM, `whombat-link`, the frozen `rackoon` container). Never run an agent or
  an installer against anything real, never scan the real network from a test. The lead does the live checks.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic; fakes in process. A new `*.int.test.ts` needs a reason
  to need Postgres. Check facts (ids, codes, counts, a key phrase), never long literal text. Inject clocks and short
  timeouts, never sleep.
- **Copy**: plain, short English a non-developer understands (`docs/decisions/concise-replies.md`), curly quotes
  (’ “ ”), `·`, `…`. The words in BF-13…BF-23 are the words. No ids, paths or commands in visible words.
- Record your own decisions with your ids: H in `hosts/docs/decisions/hosts.md`; P in the appliance's
  `docs/decisions/` where NX and BK live; R and V in Whombat `docs/decisions/backup-file.md` under a new
  “## Server details (2026-10-21)” table (R takes BF-S01…, V BF-S30…; keep to your own rows); U in whombat-app
  `docs/decisions/backup-file.md`; C in the contracts repo's notes as it does them.
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. Shapes

### 2.1 Hosts service API (H builds, V calls; all over the unix socket with the service token)

- `GET /api/v1/hub` gains `agent_url` (string), `agent_url_previous` (string|null), `agent_url_changed_at`
  (RFC 3339|null), `restored_at` (RFC 3339|null). The previous address is kept when `--agent-url auto` picks a
  different address at start than the one stored; it stays until the next change.
- `GET /api/v1/hub/backup` exists (admin, `.tar.gz`). Its `manifest.json` gains `agent_url` and `ca_sha256`.
- `POST /api/v1/hub/restore` (admin; body the `.tar.gz`, at most 1 GiB) → `202 {"ca_sha256", "servers": n,
  "agent_url": string|null}`, then the service stops on its own within 2 s and systemd starts it again
  (`Restart=always`); at start it applies the staged backup before anything listens. Refusals:
  `409 {"code":"hub_not_empty"}` (it has servers or pending enrollments), `409 {"code":"same_hub"}` (the backup's
  CA is this hub's), `400 {"code":"bad_backup"}`, `400 {"code":"newer_schema"}`. The service token file and the
  agents' listener certificate are this box's own, never the backup's (the listener is made again for this address).
  The data from before is kept as `hub.db.pre-restore-<time>.bak` beside it.
- **Staged restore file**: `<data dir>/restore-staged.tar.gz` (0600, the service's user). Whatever puts a backup
  there (the API, P's console restore) gets it applied at the next start; a backup that fails to apply is renamed
  `restore-failed-<time>.tar.gz` and the hub starts with what it had (logged, and `GET /hub` answers
  `restore_error`).
- **Adoption after a restore** (HS): for 14 days after `restored_at`, a server the restored database knows that
  presents an unexpired client certificate signed by the CA, with its machine id, is accepted even when the
  certificate's serial is newer than the one stored; that serial becomes its own (audited). After 14 days, the
  normal rule.
- **Agent addresses**: `HelloAck` gains `addrs` (`[]string`, wss URLs, omitempty) — every address of the box an agent
  may reach the listener on (the agent URL first; physical interfaces' IPv4 and global IPv6, not loopback,
  link-local, container or VM bridges such as `wbc*`, `incusbr*`, `docker*`, `br-*`, `veth*`, `virbr*`); a new
  control message `hub_addrs` (same list) is sent when the set changes (checked every 30 s). Old agents ignore both.

### 2.2 The agent (H)

- Keeps the list in `<state dir>/hub-addresses.json` (atomic, 0600).
- **Finding the hub**: when dialling the saved `hub` fails with a network or TLS error (not a rejection) three times
  in a row over at least 60 s, it tries the remembered addresses, then its own networks: every up, non-loopback
  interface with a private IPv4 address (skip `docker*`, `br-*`, `veth*`, `virbr*`, `lxcbr*`, `lxdbr*`, `incusbr*`,
  `cni*`, `flannel*`, `cali*`, `vxlan*`, `tailscale*`, `wg*`, `zt*`, `tun*`, `tap*`, `kube*`, `podman*`; keep `vmbr*`,
  `br0`-style bridges), its subnet when the prefix is /22 or longer, else the /22 around its address; the ports of the
  saved and remembered URLs (8443 when none). TCP connect (300 ms), 64 at a time, then the TLS handshake against its
  stored CA (the same check as a connection). The first that passes wins: the agent rewrites only the `hub = …` line
  of its `agent.toml` (atomic, same mode and owner; on unRAID the flash path), logs “found the hub at …” and connects.
  While not connected it searches again after 2, 4, 8 and then every 15 minutes. Never when the hub rejected it.
- Nothing else about the agent changes; it updates itself from the hub (AU-01…AU-10) once a box serves it.

### 2.3 Backup file (C defines, R and V build, U shows)

- **Category `servers`**: id, label “Servers”, meta “Your servers, what Whombat may do on them and their history”
  (C's words may tighten it), in `BACKUP_SECRET_CATEGORIES`, in the default categories. A category the Whombat can't
  offer (no hosts service, not the servers' burrow) is absent from the make panel's list and from the defaults the
  server applies — the server's estimate says which are offered (C adds `offered: boolean` or an equivalent to the
  estimate's categories if there is no such flag yet).
- **Entries**: `servers/hub.tar.gz` (the hosts service's backup as it is, streamed; size in the manifest) and
  `servers.jsonl` records: `servers_hub` `{caSha256, agentUrl, address, madeAt, servers: [{id, name, address|null}]}`
  (one), `server_ask` (one per `server_asks` row, the server's id and the row's fields).
- **Restore preview** for `servers`: `state` `new` | `here` (same CA) | `blocked` (this Whombat watches other
  servers: `blockedBy: n`) | `unavailable` (no hosts service here); `address: {from, to} | null` (the file's address
  and this Whombat's when they differ); the restore request takes `servers: {pointHere: boolean}` (default true when
  `address` is set).
- **Restore summary**: servers brought back (n), pointed here (n), to point by hand (names), and the existing lines.
- **Default categories**: agents, memories, automations, connections, skills, people, vault, messages, servers
  (BF-21). `backupDefaults` allows the eleven ids.
- **Record additions** (all optional/nullable so older files still read): connection `tools[].limits`,
  `runsOn` (server ids), `builtin` (true for `device`/`whombat_servers`), `device` (`device_skills`' profile, host, port
  and choices); conversation directory entry `taskKey`, `chatTitle`, `chatSubject {kind, id, name}`,
  `chatArchivedAt`; message `subject {kind, id, name}`; a `chat_thread_runtime` record (thread root message,
  provider/model/effort/fast); agent `look` and runtime `fast`; `command_allowance` (agents: agent, the allowance's
  fields); `widget` (people: owner, place, connection or server it reads, its settings); `canvas_comment` (messages);
  `account_profile` (people: the maker's preferences and photo blob); connector account `needsSignIn` (no token);
  Vault caps raised to the Vault's own limits.
- **Schema version** bumped; older runtimes keep refusing newer files with the existing words.
- **API**: `hosts.repoint` — `{servers: string[]}` (owners) → a job like `hosts.install`, one result per server:
  `pointed` | `no_key` (no Vault SSH key for its address) | `failed` (+ the sign-in's reason code). And a read
  `hosts.addressChange` → `{from, to, changedAt, waiting: [{id, name}]} | null` for the Needs you item if Home
  sources aren't generic enough (V decides; tell C early).

## 3. Streams

### C — contracts (0.117.0)

Everything in §2.3 in `@whombat/core/backup` (categories, records, manifest/schema version, restore preview/request/
summary, copy), the `api.hosts.repoint` op and its job/result shapes, `hosts.addressChange` if V needs it, and any
Home/Needs-you kind for BF-16 if Needs-you items are typed. Tests for the parsers (old files still parse, new fields
optional). Then `pnpm check` and `pnpm release` (a clean tree; `dist-release/0.117.0/`). Report the commit and the
release directory. Don't tag or push — the lead does.

### H — hosts service

§2.1 and §2.2: `HelloAck.addrs` + `hub_addrs`, the agent's address memory and search (inject the dialler, the
interface list and the clock; a test hub on loopback with two addresses; never scan real networks in tests), the
`hub = …` rewrite (preserving the rest of the file byte for byte), previous address in meta + `GET /hub`, backup
manifest `agent_url`/`ca_sha256`, `POST /hub/restore` + the staged file applied at start (reuse `Restore`), keeping
the service token and making a fresh listener certificate, the 14-day adoption, the fake/simulator where it helps.
Decisions HS-170…. Report what changed in the API exactly.

### P — appliance

BF-18: before each restic snapshot a consistent copy of the hosts service's data (its backup: the API over the socket
as the service's user, or `whombat-hosts backup` offline-safe, whichever respects BK-26 — root never acts on a path the
backup user controls) lands where the snapshot reads it, as a new source `hosts` (coverage, `SourceNames`, the
manifest, the restore plan); the console restore puts it at `/persist/hosts/restore-staged.tar.gz` (owner
`whombat-hosts`, 0600) so the service applies it at its next start. Boxes without the hosts service skip the source.
Coverage words for the source (“Servers”). Go tests for the new source and the restore placement; eval the NixOS
module. Decisions NX-407…, BK-31…. Don't ship — the lead runs the candidate (`dev/candidate --minor --hosts <rev>`).

### R — Whombat server: restore fixes (BF-19…BF-22, minus the servers category)

Start from the 2026-10-21 review findings, each with the file:line where it happens:
1. Built-in connections: `restore/connections.ts` recreates `device`/`whombat_servers` rows and `job.ts` rechecks
   them → `needs_reauth` (`connect.ts` refuses built-ins). Never recheck built-ins; never add a `whombat_servers` row
   (match the existing one and apply tiers/limits on “Use the backup”); a device comes back with its `device_skills`
   and works; tiers for built-ins applied directly.
2. Tool limits (`collect/connections.ts` keeps name/tier/hash only) and `runsOn` carried and restored.
3. Chat: `collect/messages.ts` drops task key/title/subject; `restore/run.ts` (~591) maps every DM to the
   `task_key IS NULL` one. Carry and match by (agent, person, task key); make task chats and the Feedback room as they
   were; message subjects; `chat_thread_runtimes`.
4. Agents: `restore/agents.ts` (~130–160) compares the name but never writes it (nor `agent_look`) → apply the
   assistant's name and face (decide how keep/replace treats an assistant that still has its automatic name — a fresh
   box should get the file's name back; record it); retired crew: in the one-assistant Whombat don't hire agents it
   no longer has (the same check hiring uses), with a note; keys (`agents.ts` ~190/253) through the hiring limits and
   with the event the apps hear; model checked against what this Whombat offers; `fast`.
5. Schedules lose their thread (agents restore before messages, `agents.ts` ~312): fix up after messages, also on a
   second restore.
6. Silent drops at make time (`collect/connections.ts` ~172/200: accounts and connector apps whose token doesn't open;
   feedback token; `collect/vault.ts` ~46 caps; message files without Files) → carried as “sign in again” or a
   preview note.
7. BF-20's additions (widgets, command allowances, canvas comments, the maker's profile) and BF-21's defaults.
8. BF-22 into BF-05's list in the docs.
Tests: extend `backup-file.int.test.ts`/`cross-box.int.test.ts` (or a new file) **in the assistant shell** with a
device, the Servers connection, Chat threads + a task chat + the Feedback room, a renamed assistant, a crew agent,
a widget, tool limits; check facts, not words.

### V — Whombat server: servers (BF-13…BF-17)

- `hosts/client.ts`: the new `GET /hub` fields, `GET /hub/backup` streamed, `POST /hub/restore`; the fake hosts
  service (`hosts/testing/fake.ts`) serves them.
- Make: `collect/servers.ts` — the `servers_hub` record from the live `/hub` and `/servers`, `server_ask` rows,
  `servers/hub.tar.gz` streamed into the file (it is big: never buffer it whole); only where offered (BF-13).
  The estimate counts it (the hub's backup size if the service can tell, else the database size from `/hub`).
- Restore: `restore/servers.ts` — preview states (BF-14), the address question (BF-15), `POST /hub/restore`, wait for
  the service to answer with the new CA (90 s), then `server_ask` rows; with `pointHere` the repoint job for every
  restored server. Order: after connections and the Vault (the keys), before automations.
- `hosts.repoint` (owners): per server, its address from the hub; the restorer's Vault SSH servers with that host →
  Sign in once with that key (`hosts/install.ts` + `vault/ssh-signin.ts`), level from the server's current switches,
  update in place to this Whombat's agent URL. No key → `no_key`.
- BF-16: the Needs you item from `GET /hub`'s previous address and the servers still offline five minutes after the
  change (`hosts/sources.ts`), “Point them here” → `hosts.repoint` for those servers; gone when they are back.
- Never add a Servers connection where the hosts service isn't (`ensureServersConnection` already handles making it;
  coordinate with R, who owns connection restore — V only makes sure provisioning still runs after a hub restore).
Tests with the fake hosts service: make/restore round trip with servers (new / here / blocked / unavailable), the
address question both ways, repoint results, the Needs you item appearing and clearing.

### U — web + phone (whombat-app)

- Make panel: the Servers tick (only when offered), its meta line; Messages on by default comes from the server.
- Restore preview: the Servers row with its state (new / already here / can't come back + the sentence /
  unavailable), the address question (“Your servers look for your Whombat at … This Whombat is at …” — Point them
  here · Leave them); the request's `servers.pointHere`.
- Summary: servers back, pointed here, the ones to point by hand (each opens Add a server filled in with its address).
- Needs you: BF-16's item with Point them here → the repoint job's progress per server (Pointed here · Needs a
  password → Add a server filled in).
- Web and Android; the reference mocks don't cover these screens: follow the existing Backup file and Servers
  screens' components exactly. Decisions AP-4410….
