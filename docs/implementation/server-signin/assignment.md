# Add a server by signing in once — build brief (2026-10-18)

Decisions: `docs/decisions/server-signin.md` (SI-01…SI-13). Read it first, then §1, §2 and your stream's part of §3.
Today's flow to change: Whombat `docs/decisions/one-whombat.md` ONE-15, `docs/decisions/one-whombat-servers.md`
(ONE-DH*), `hosts/docs/WHOMBAT.md` §6 (install flow) and §3 enrollments, whombat-app
`apps/web/src/features/things/AddServer.tsx` (the dialog) and `docs/decisions/one-whombat-things.md` AP-1318.

The mockup John approved (three panes): a dialog “Add a server” with tabs **Sign in once** | **Run a command**; Sign in
once has Address + User name (`root`) side by side, Password (hint “Used once to install Whombat’s agent, then
forgotten. Or use a key from the Vault.”), “What may Whombat do on it?” as a three-way segmented control **Watch only ·
Restart and consoles · Full control** (Full control selected), a checkbox “Leave a Vault key on it, so Whombat can sign
in later without a password.” (SI-09: **unticked** by default), buttons Cancel / **Add server**. After pressing it the
dialog shows “Adding pve-03” with four steps (✓ Signed in to 10.100.0.14 · ✓ Installed Whombat’s agent, sub-line
“Proxmox VE 9.0 · Debian 13 · amd64” · spinner Waiting for its first report · Ready) and a bordered note “First time on
this server: it showed key **SHA256:q3Vx…T8w**. Whombat remembers it and warns you if it ever changes.” (only say
“remembers” when SI-09 kept a key; otherwise “It showed key SHA256:…”). Run a command shows the command in a code block,
“Run this on the server as root. It shows up as soon as it has run, with the control you chose.” and “Works for an hour,
on one server. Linux, as root.”

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`hub: …`, `agent: …`, `server: …`, `web: …`,
  `mobile: …`, `contracts: …`), every message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  Never push, never merge into `main`, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`,
  `~/Code/whombat-hosts`, `~/Code/whombat-contracts`): other sessions use them. The lead merges.
- **DEV fast** (John's rule): one quick check per repo at the end — `TMPDIR=~/.cache/wb-tmp pnpm check` (TS repos),
  `go vet ./... && go test ./...` (Go; `-race` once at the very end), `pnpm test:server` once (Whombat server). No VM
  tests, no repeated full suites, no CI waits. Own ports and throwaway databases; never stop or reset shared containers
  (`docker compose` is shared — never `down -v`). `/tmp` runs out of inodes: `TMPDIR=~/.cache/wb-tmp`.
- **Real servers to install on**: Incus system containers on The Titan (this machine), **only in your own throwaway
  project** (`whombat-test-si-h` for H, `whombat-test-si-s` for S): `incus project create <p> -c features.images=false
  -c features.profiles=false`, e.g. `incus launch images:debian/13 si-a --project <p>` (systemd, add `openssh-server`,
  a root password and a sudo user), an Alpine one for OpenRC if you have time. They sit on `incusbr0` (NAT): this
  machine reaches them and they reach this machine, so a hub you run here works. Delete the project with everything in
  it at the end. **Never touch any other Incus instance, image, profile, network or project on The Titan** (it hosts the
  DEV Whombat, `whombat-prod-box`, CI templates, `whombat-link`). Never install anything on The Titan itself, BlackBox,
  pve-01/02 or The Falcon.
- **Copy**: plain, short English a non-developer understands, curly quotes (’ “ ”), `·`, `−`, `…`. Whombat's chat words
  follow CLAUDE.md “Agents and automations talk like people”.
- **Tokens only** (`@whombat/tokens` CSS variables) for UI; match the surrounding code's style and comment density.
- **Decisions you make** go in your repo's decisions file: Whombat `docs/decisions/server-signin-server.md` (SI-S01…),
  `hosts/docs/decisions/hosts.md` (HS-93…HS-110), contracts `docs/decisions/contracts.md` (CT-373…),
  whombat-app `docs/decisions/server-signin-web.md` (AP-1677…AP-1696) and `server-signin-mobile.md` (AP-1697…AP-1716).
- **Report** at the end: what you built (by SI decision), files outside your ownership you touched, contract gaps, what
  the lead must do at merge, how you verified it.

## 2. Shared shapes (all streams build to these)

The hub speaks snake_case; Whombat's contracts are the camelCase mirror.

### 2.1 Control levels (SI-06)

| Level | Hub switches (`remote_control`) | Agent lock (`agent.toml`) | Copy (title — one line under the control) |
|---|---|---|---|
| `watch` | `diagnose` only | the agent's defaults (`diagnose` on, the rest off) | **Watch only** — “Whombat sees how it’s doing and runs read-only checks.” |
| `operate` | `console`, `power`, `diagnose` | the same three | **Restart and consoles** — “Also opens consoles and starts, stops or restarts its VMs and containers.” |
| `full` | all six (`console`, `power`, `host_shell`, `host_power`, `manage`, `diagnose`) | `all` | **Full control** — “Also changes and creates VMs and containers, opens a shell on the server and restarts it.” |

A level is **exact**: after an install the server has exactly that level's switches on both sides (lowering works too).
Default in every UI: `full`.

### 2.2 Hosts service (H)

- `POST /api/v1/enrollments` takes an optional body `{"approve": true?, "control": "watch|operate|full"?, "name":
  "pve-03"?, "group": "…"?}`. An empty body is exactly today's behaviour (old Whombats keep working).
  - `approve: true` → **pre-approved**: when an agent claims the token, the hub approves it in the same request (name =
    `name`, else the agent's host name, slugged as today; group = `group`, else Ungrouped); a taken name gets `-2`,
    `-3`, … (never a takeover); the server's hub switches are the level's (§2.1); the agent's first poll gets its
    certificate at once. Publishes `enrollment.approved {"id", "server_id", "hostname"}` (admins) and the usual server
    events. Audit `enrollment.approved` with the token's creator as the actor and `"auto": "true"`.
  - `control` → stored on the row, applied at approval (automatic or by hand), and the `install_command` ends with
    `--control <level>`.
  - Response adds `approve`, `control`, `name` next to today's `id`, `token`, `expires_at`, `install_command`,
    `install_url`, `tls_pin`, `agent_url`, `ca_sha256`.
- `GET /enrollments` items add `control`, `approve`, `name` (null when not given).
- **`GET /api/v1/agent-install.sh`** on the Unix socket (service token, any role ≥ admin): the very script the agent
  listener serves at `/install.sh`, with downloads from the agents' address and its key pinned (not from the socket's
  `Host`). Whombat streams it to the server over SSH.
- **install.sh**:
  - `--control watch|operate|full`: after enrolling (or keeping the identity) the agent's lock is exactly the level
    (§2.1), on every init system and on Unraid, then the agent reloads.
  - `--token -` reads the token from stdin (first line). It already parses this; keep it working when stdin also
    carried a `sudo -S` password line before it (sudo consumes exactly its line).
  - **Before changing anything**, when `$CONFIG_DIR/agent.crt` exists: same CA as this hub (`ca.crt`'s SHA-256 =
    `CA_SHA256`) → keep the identity, upgrade, set `hub =` to this script's `HUB_URL` if it differs (a box whose address
    changed), apply `--control`; another CA → change nothing, print the result line `other-whombat` and exit 3 (unless
    `--force`, which re-enrolls with the token).
  - The **last line on stdout** is the machine-readable result, exactly one of:
    `whombat-agent: added <server_id>` (enrolled and approved), `whombat-agent: waiting <enrollment_id>` (enrolled,
    waits for an owner: a token that wasn't pre-approved; the script then does what it does today), `whombat-agent:
    kept <server_id>` (already enrolled to this hub, upgraded), `whombat-agent: other-whombat`. Errors keep their
    `install.sh: …` stderr words; make these stable and greppable: `curl or wget is required`, `unsupported
    architecture`, `unsupported init system`, `run as root`, and a download that fails says `install.sh: cannot reach
    <url>` (curl's exit code 6/7/28/35 or wget's 4/5) so Whombat can say SI-11's “can’t reach this Whombat”.
  - The pre-approved enroll prints “Added to Whombat as pve-03.” instead of “Approve this host in Whombat …”.
  - The agent needs a way to tell its server id and CA for `kept` (e.g. `whombat-agent whoami` → `<server_id>
    <ca_sha256>`); your choice.
  - The OS line for SI-02's sub-line: print `whombat-agent: os <PRETTY_NAME> · <arch>` (and `· Proxmox VE 9.0` /
    `· Unraid 7.3.1` / `· Incus 6.0` when found) before the result line.
- Docs: WHOMBAT.md §3 enrollments and §6 install flow, REST-API.md, decisions HS-93….

### 2.3 Contracts 0.85.0 (C)

Append-only (optional fields, new enum members at the end, new ops at the end of their group).

```ts
// domain/hosts.ts
export const HostControlLevel = z.enum(['watch', 'operate', 'full']);
export const HostCreateEnrollmentBody = z.object({
  control: HostControlLevel.optional(),           // Whombat always pre-approves (SI-07); default full in the UIs
  name: z.string().min(1).max(63).optional(),
}).strict();                                       // body optional: an empty POST stays valid
// HostEnrollment gains:   control: HostControlLevel.optional(), preApproved: z.boolean().optional()
// HostPendingEnrollment gains: control: HostControlLevel.nullable().optional(), name: z.string().nullable().optional()

export const HostInstallState = z.enum(['connecting', 'installing', 'waiting', 'ready', 'failed']);
export const HostInstallErrorCode = z.enum([
  'not_allowed',          // SI-05 refused the address (message from the destination rule)
  'unreachable',          // nothing answers on that address and port
  'host_key_changed',     // SI-04: differs from the key the owner's Vault trusts
  'sign_in_failed',       // wrong user name, password or key
  'sudo_password_needed', // key sign-in, sudo wants a password
  'sudo_refused',         // the user may not use sudo
  'no_downloader',        // neither curl nor wget on the server
  'cant_reach_whombat',   // the server can't reach the agents' address of this Whombat
  'unsupported',          // not Linux, unknown architecture or init system
  'other_whombat',        // its agent reports to another Whombat (SI-08)
  'timed_out',
  'failed',               // anything else (the detail says what)
]);
export const HostInstall = z.object({
  id: Id,
  address: z.string(),                 // as typed, host[:port]
  username: z.string(),
  control: HostControlLevel,
  state: HostInstallState,
  hostKey: z.object({ algorithm: z.string(), fingerprint: z.string() }).nullable(), // SHA256:… the server showed
  hostKeyNew: z.boolean(),             // true: first contact (SI-04); false: matched the Vault's trusted key
  serverId: z.string().nullable(),
  serverName: z.string().nullable(),   // what it is called in Whombat (may be pve-03-2)
  system: z.string().nullable(),       // “Proxmox VE 9.0 · Debian GNU/Linux 13 (trixie) · amd64”
  already: z.boolean(),                // SI-08: it was added before; updated in place
  keptKey: z.boolean(),                // SI-09 done
  error: z.object({ code: HostInstallErrorCode, message: z.string() }).nullable(),
  detail: z.string().nullable(),       // failure only: the installer's last lines, password and token removed (≤ 4 KiB)
  startedAt: Timestamp, updatedAt: Timestamp, finishedAt: Timestamp.nullable(),
});
export const HostInstallBody = z.object({
  address: z.string().min(1).max(255),
  username: z.string().min(1).max(64),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('password'), password: z.string().min(1).max(1024) }),
    z.object({ kind: z.literal('vault'), entryId: Id, password: z.string().min(1).max(1024).optional() }), // for sudo
  ]),
  control: HostControlLevel,
  name: z.string().min(1).max(63).optional(),
  keepKey: z.union([z.object({ entryId: Id }), z.object({ create: z.literal(true) })]).optional(), // SI-09
}).strict();
```

- Ops (contracts/hosts.ts, group with the enrollments):
  - `hosts.createEnrollment` gets `body: HostCreateEnrollmentBody.optional()` (or the contract library's way of an
    optional body).
  - **`hosts.startInstall`**: `POST /burrows/:burrow/hosts/installs`, body `HostInstallBody`, 202 `HostInstall`.
    Owners. A **secret op** (`SECRET_API_OPS`, CT-44: no input digest, no result in the receipt), safety `NEVER`.
  - **`hosts.getInstall`**: `GET /burrows/:burrow/hosts/installs/:installId` → `HostInstall` (owners). `READ`.
- Realtime on `hosts:<burrowId>`: `ev('hosts.install', { installId: z.string(), state: HostInstallState })` — clients
  refetch `getInstall` (members get the frame, only owners can read it).
- Servers tool **`server_add`** (append to `SERVERS_TOOLS`, count 50 → 51): `access: 'read'` (it only puts a card in
  the conversation, SI-10), args `{ address: string (required), username?: string, control?: 'watch'|'operate'|'full',
  name?: string }`, description in plain words (“Ask the owner to add a server: puts a card in the conversation that
  opens Add a server filled in; the owner signs in there. You never get the password.”). Mention it in the
  `whombat_servers` guide text.
- Feature `hosts.install` in a new `SINCE_0_85` (clients offer Sign in once only on runtimes that have it; older runtimes
  get the command tab only). Bump `SESSION_API_LEVEL` if your rules say so.
- Error words for the codes if hosts errors have a words table in contracts; else the server owns the words.
- Tests, CT-373…, release 0.85.0 (tag `contracts-v0.85.0`, `pnpm release` → `dist-release/0.85.0/`).

### 2.4 Whombat server (S) — the install job

- `hosts.startInstall` (owners, `guard(…, { manage: true })`): parse the address (`host`, `[v6]`, optional `:port`,
  default 22), check it with `sshDestination(…, 'call')` (SI-05), refuse a second running job for the same person and
  address, at most 2 running per person and 4 per box (`rate_limited` words). Create the job in memory, answer 202 with
  state `connecting`, run it in the background. Jobs live in memory (like console tickets, ONE-DH19), 30 minutes after
  they finish.
- **Steps** (publish `hosts.install` frames on every state change; `updatedAt` each step):
  1. **Sign in** (`connecting`): a variant of `openSsh` that takes a **password** (ssh2 `password` and
     `keyboard-interactive` answering every prompt with it) or the owner's Vault key (`ownSshEntry`, custody open as
     `ssh-check.ts` does), and **accept-new** host keys (SI-04): no pin → sign in and report the shown key with
     `hostKeyNew: true`; when any of the person's Vault SSH servers has this host and port with a trusted key → it must
     match (`host_key_changed`, nothing sent). Keep the SHA-1-free algorithms. 30 s deadline.
  2. **Root** : `id -u`; 0 → run as is; else `sudo -n true` → passwordless sudo; else with a password `sudo -S -p ''
     true` (password on stdin) → `sudo -S`; else `sudo_password_needed` (key sign-in without password) or
     `sudo_refused`.
  3. **Enroll** (`installing`): `POST /enrollments {approve: true, control, name?}` as the person (admin actor), then
     `GET /api/v1/agent-install.sh`. Never mint a token before the sign-in worked.
  4. **Install**: write the script to `$(mktemp)` over the session (stdin to `cat`, mode 0600), run `sh <file> --token -
     --control <level>` as root (`sudo -S -p '' sh …` with stdin `password\ntoken\n`, or stdin `token\n` as root), 150 s
     timeout, remove the file after (also on failure). Parse the `whombat-agent: os …` and result lines (§2.2) and map
     stderr to SI-11 codes. Token and password never on a command line, never in `detail`.
  5. **`kept`** → `already: true`, set the server's hub switches to the level (`PATCH /servers/{id}`); **`added`** →
     `serverId`; **`other-whombat`** → `other_whombat`; **`waiting`** → can't happen for a pre-approved token: treat
     as `failed`.
  6. **SI-09** (when asked): `mkdir -p ~/.ssh && chmod 700`, append the entry's public key to `~/.ssh/authorized_keys`
     (0600) unless present, as the signed-in user; then add the server to the entry (the vault's add-server command;
     name = the server name, port, username) and trust the key it showed (the trust command), all as the person.
     `keepKey: {create: true}` first generates an ed25519 entry “Servers” owned by the person (the vault's create
     command). The 20-servers limit refuses in words.
  7. Close SSH, drop the password (null every reference). **`waiting`**: wait up to 60 s for the server's first report
     (hub events / fleet `last_seen`); then `ready`, else `timed_out` with “It’s installed, but its first report hasn’t
     come in yet. It shows up once it does.”.
  8. Sign a `hosts.change` (“Added pve-03 with full control”, `op: 'install'`, the change for Done recently, no address
     password or token) — for `already`: “Updated pve-03’s agent and set full control”.
- Words for every error code (SI-11), e.g. `sign_in_failed`: “Couldn’t sign in to 10.100.0.14: the user name or password
  isn’t right.”; `cant_reach_whombat`: “10.100.0.14 can’t reach this Whombat at 10.100.1.160:8443. Is it on another
  network?”.
- `hosts.createEnrollment` passes `{approve: true, control: body.control ?? 'full', name?}` to the hub (both tabs are
  pre-approved, SI-07) and maps `control`/`preApproved`; `toHostPendingEnrollment` maps `control`/`name`;
  `approveEnrollment` unchanged (the hub applies the stored control).
- **`server_add` tool** (SI-10): the caller's person must be an owner (else the tool answers “Only owners add servers.
  Ask <owner names>.”); posts a `guide` card into the call's conversation (author: the Whombat; topic `add_server`)
  with one line (“Add 10.100.0.40 as a server? Sign in to it once and Whombat installs its agent.”) and one action
  “Sign in…” with `href` `/things/servers?add=1&address=10.100.0.40&user=root&control=full` (only the args given);
  answers the model `{asked: true}` and says nothing else in chat. Register its words (`registerCallWords`) and add it to
  the tool args table.
- The fake hosts service (`hosts/testing/fake.ts`) answers the new body, `approve`, `agent-install.sh` and
  `enrollment.approved`; tests for the job with an in-process SSH server (ssh2's `Server`) faking `id`, `sudo`, `cat`,
  `sh` and printing result lines; one real run against a hub you start from H's branch (or main + a fake) and a Debian
  container (§1). Decisions SI-S01….

### 2.5 Web (W) and Android (M)

- **Add a server** per the mockup (top of this file): level control above the tabs and shared by both (SI-06); Sign in
  once form → progress → done (“pve-03 is added.” + **Open pve-03**; `already` → “pve-03 was already added. Its agent
  is updated and set to Full control.”; a name with `-2` → the SI-07 sentence) or failure (the error message, **Try
  again** back to the form with the password cleared and everything else kept, **More detail** folding `detail`).
  “Use a key from the Vault” swaps the password for a picker of the person's own SSH keys (name · fingerprint) plus an
  optional “Password for sudo (only if it asks)”. SI-09's checkbox with a key picker (“Make a new key” at the end).
  Run a command: the pre-approved command for the chosen level (a new one when the level changes), “Waiting for you”
  as today (approve applies the stored control). Runtimes without `hosts.install` show the command only.
- Opened with `?add=1` (today) and prefilled from `address`, `user`, `control` (the assistant's card, SI-10).
- Live: `hosts.install` frames refetch `hosts.getInstall`; poll every 2 s as a fallback while a job runs.
- Android: a native **Add a server** screen (SI-12) with the same parts; reached from Servers (owners), from Home's
  “wants to be added” Review (Waiting for you) and from the guide card's in-app href (map `/things/servers?add=…` to
  the screen instead of the browser). 44 px targets, password field with `secureTextEntry`, autofill off for the
  address.

## 3. Streams

| Stream | Repo · worktree · branch | Owns | IDs |
|---|---|---|---|
| **C** contracts 0.85.0 | whombat-contracts · `~/Code/.wt/contracts-si` · `si` | §2.3 | CT-373… |
| **H** hosts (Go) | the hosts service · `~/Code/.wt/hosts-si` · `si` | §2.2: hub enrollments, socket script, install.sh, agent `whoami`/control, docs | HS-93…HS-110 |
| **S** server | Whombat · `~/Code/.wt/whombat-si-server` · `si-server` (from `si`) | §2.4: `apps/server/src/hosts/**` + an ssh helper next to `vault/ssh.ts` | SI-S01… |
| **W** web | whombat-app · `~/Code/.wt/app-si-web` · `si-web` (from `si`) | §2.5 web: `apps/web/src/features/things/AddServer*.tsx`, client helpers `packages/client/src/hosts/install.ts`, fixtures `fixtures-si.ts` | AP-1677…AP-1696 |
| **M** Android | whombat-app · `~/Code/.wt/app-si-mobile` · `si-mobile` (from `si`) | §2.5 Android: `apps/mobile/**` (new `screens/AddServerScreen.tsx`, navigation, guide href mapping) | AP-1697…AP-1716 |

C goes first and is small; the lead vendors 0.85.0 into the `si` branches of Whombat and whombat-app and tells S, W
and M to `git merge si`. Until then build against §2 (the shapes are final; add a local `type` mirror if you must and
delete it after the merge). W and M share `packages/client/src/hosts/install.ts` (W writes it; M imports it after
merging W's commit the lead passes on, or writes only mobile-side code until then — coordinate through the lead).

### C — contracts 0.85.0
Everything in §2.3, tests (schemas, op table, safety, secret op, tool count 51, feature), CT-373…, release 0.85.0.
Report the release directory.

### H — the hosts service
§2.2 with Go tests (pre-approval incl. name suffixes and the stored control on manual approval, the socket script's
origin, install.sh paths: fresh, kept same CA with a new hub URL, other CA, `--control` exact both ways, result
lines, unreachable download words) and one real run in your Debian container against a headless hub you start here
(and Alpine/OpenRC if time allows). Docs WHOMBAT.md / REST-API.md, HS-93….

### S — Whombat server
§2.4. Decisions `docs/decisions/server-signin-server.md`. `pnpm test:server` once at the end.

### W — web
§2.5 web, verified in the fake world with servers (`VITE_WHOMBAT_TRANSPORT=session VITE_WHOMBAT_FAKE=1
VITE_FIXTURE_HOSTS=1`, signed in with `e2e-managed/support.ts` `signIn` + `claimAndSaveKit`; fixtures answer
`startInstall`/`getInstall` with a scripted job that walks the states, and one failure), 1440×900, both themes, plus
390 px wide. Match the existing dialogs (Proxmox create dialogs are the density reference).

### M — Android
§2.5 Android, verified on the emulator (`export ANDROID_HOME=$HOME/Android/Sdk`) against the fixture world, both
themes; screenshots in your report.
