# Remote help — build brief (2026-10-21)

Decisions: `docs/decisions/remote-help.md` **RH-01…RH-13**. **Read them first**, then §1, §2 and your stream's part of §3
and §4. Visual sketch (layout and words, not pixel truth): `~/.cache/wb-tmp/mockups/remote-help/index.html`; the real
UI matches the surrounding Settings sections (Diagnostics is the closest neighbour). Where this brief and the sketch
differ, this brief wins.

| Stream | Repo | Worktree | Branch | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-rh` | `remote-help` | CT-930…CT-969, release **0.119.0** |
| K control | control | `~/Code/.wt/api-rh` | `remote-help` | CL-121…CL-139 |
| A support service | the appliance | `~/Code/.wt/appliance-rh` | `remote-help` | NX-411…NX-424 |
| B manager, console, harness, docs | the appliance | `~/Code/.wt/appliance-rh-mgr` | `rh-manager` | MG-118…MG-129, CG-290…CG-309, IN-358…IN-365, LC-21…LC-24, NX-425…NX-429 |
| S server | Whombat | `~/Code/.wt/whombat-rh` | `remote-help` | RH-S01… (`docs/decisions/remote-help-server.md`), migration 0133 if needed |
| W web, client, panel, legal | whombat-app | `~/Code/.wt/app-rh` | `remote-help` | AP-4440…AP-4469 (`docs/decisions/remote-help.md` in the app) |
| M Android | whombat-app | `~/Code/.wt/app-rh-mobile` (later) | `rh-mobile` | AP-4470…AP-4499 |

All branches start from `main`. The lead merges, releases contracts and the app, vendors and ships. Peers working at the
same time: whombat-f0 (desk screen: contracts **0.118.0** first, CT-970…989, CG-310…329, DK-90…99, DK-S110…119; touches
`local/desk.ts`, `desk/*` in Whombat, console/ui desk) and whombat-1b (Fusebox page, Whombat `home/*`, `things/*`). Keep
your desk changes additive and small so they merge cleanly with f0's.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `control: …`, `support: …`,
  `manager: …`, `console: …`, `nix: …`, `harness: …`, `server: …`, `web: …`, `mobile: …`, `client: …`, `admin: …`,
  `docs: …`), every message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never
  merge into `main`, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`,
  `~/Code/whombat-appliance`, `~/Code/whombat-api`): other sessions work there.
- **Contracts 0.119.0.** C builds them first. Everyone else starts at once against §2's shapes (local stand-in types
  where you need them, clearly marked `// stand-in until contracts 0.119.0`). When the lead says 0.119.0 is released
  (`~/Code/whombat-contracts/dist-release/0.119.0/`), vendor it in your branch as the last vendoring did (Whombat and app:
  `vendor/whombat-contracts/<v>/`, `package.json`, `pnpm-workspace.yaml` overrides, `pnpm install`, commit
  `deps: @whombat contracts 0.119.0 (…)` with the lockfile; appliance: `third_party/whombat-contracts-go` from the
  release's `whombat-contracts-go-0.119.0.tar.gz`, `go.mod`, the Nix `vendorHash`, and console/ui's vendored `desk.ts`;
  control: `vendor/whombat-contracts/0.119.0/` from 0.51.0) and swap your stand-ins. Need a contract change? Don't edit
  vendored files: message the lead with the exact additive change.
- **DEV fast** (John's rule): one quick check at the end — TS repos: `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (S also `pnpm test:server` once; K its own `pnpm check`/tests per its README); appliance Go: `gofmt -l`, `go vet ./...`,
  `go test ./...` in the packages you touched; console/ui: `pnpm check` there; Nix: the `nix build` attributes named in
  your §3. Run single test files while you work. No VM gates beyond your own new test, no CI waits, no waiting for future
  data. Own ports (S 4570, W 4574/5274) and throwaway databases; the shared Postgres :55432 and Mailpit are never stopped
  or reset. `TMPDIR=~/.cache/wb-tmp` (host `/tmp` runs out of inodes). Nix needs
  `--extra-experimental-features 'nix-command flakes'`. Temporary containers or VMs only through
  `/usr/local/bin/agent-resource` (read `/home/me/Code/dashboard/docs/agent-resources.md` first); release what you lease.
- **Never touch John's real servers, DEV stack, DEV box or the Z13**, never run `dev/candidate`, `release/*`, an installer
  or a publish. Reading the DEV control database read-only is fine for K and B. The lead does the real ones after the merge.
- **Tests** (`docs/decisions/test-speed.md` in Whombat): unit-test logic (grant rules, duration/Forever checks, help-code
  normalisation, certificate checks, Look argument validation, visit grouping, step words, state lines, cert encoding).
  Fakes in process. A new `*.int.test.ts` needs a reason to need Postgres. Check facts (ids, codes, a key phrase), never
  long literal text. Inject clocks and short timeouts, never sleep.
- **Copy**: §4's words are the words (curly quotes ’ “ ”, `·`, `…`). Words shown on more than one surface live in core
  (`REMOTE_HELP_WORDS` and helpers, C); surfaces use those.
- **Tokens only** for UI colours/fonts/radii; match the surrounding code's style and comment density.
- **Security first**: this feature opens a root path into customer boxes. Validate every input strictly, fail closed,
  bound everything (sizes, counts, times), never log secrets/certificates' private parts/help codes. If something in this
  brief looks unsafe, stop and tell the lead with a concrete alternative instead of building it.
- Record your own decisions in your stream's file (see the table). When done: the quick check green, everything
  committed, a short report (what you built, what you decided, what is left, what the lead must check live). Don't wait
  for anything after that.

## 2. Wire shapes (contracts 0.119.0, all additive; C owns the exact Zod/Go, these are binding on meaning and names)

### 2.1 core (`packages/core/src/domain/remote-help.ts`, exported from the package root)

```ts
export const REMOTE_HELP_LEVELS = ['look', 'fix'] as const;            // RemoteHelpLevel
export const REMOTE_HELP_DURATIONS = ['hour', 'day', 'week', 'forever'] as const; // RemoteHelpDuration
export const REMOTE_HELP_DURATION_S = { hour: 3600, day: 86400, week: 604800 } as const; // forever → null
export const HELP_CODE_LENGTH = 6;   // alphabet: FEEDBACK_REFERENCE_ALPHABET (Crockford, no I L O U)
export function normalizeHelpCode(input: string): string | null;  // drop spaces/·/-, uppercase, map O→0 I/L→1; 6 chars or null
export function formatHelpCode(code: string): string;             // 'KQ72MX' → 'KQ7·2MX'
export const REMOTE_HELP_LOOK_COMMANDS = ['help','status','units','logs','boots','hardware','network','disks',
  'memory','processes','updates','report'] as const;               // LookCommand
export const REMOTE_HELP_WORDS = { … };                             // §4
export function remoteHelpStateLine(s: { level; until: string | null; now: Date; timeZone?: string }): string;
//   'On · Look and fix · until tomorrow 14:00' | 'On · Look · until Thu 23 Oct, 14:00' | 'On · Look and fix · forever'
export function remoteHelpStepText(step: RemoteHelpStep, who: string): string;   // §4 step words
export function remoteHelpUnitName(unit: string): string;          // 'whombat-voice.service' → 'voice'; unknown → unit without '.service'
export const REMOTE_HELP_LIMITS = { visitIdleS: 900, keepDays: 90, keepBytes: 500 * 2 ** 20, wrongCodes: 5,
  stepsPerVisit: 2000, stepsShown: 200, commandLineChars: 500, nameChars: 40, transcriptBytesPerVisit: 50 * 2 ** 20 };
```

`RemoteHelpStep` (shared by the session ops and the local socket):
`{ at: iso, kind: 'connected'|'left'|'look'|'exec'|'shell'|'restart'|'forward'|'refused'|'wrong_code', command?:
LookCommand, units?: string[] (≤ 8, unit-name pattern), line?: string (Fix command line, ≤ 500), seconds?: int,
target?: string (≤ 200: `127.0.0.1:8123` or a socket path), bytes?: int, reason?: 'level'|'code'|'certificate'|'limit'|
'unknown_command'|'bad_arguments' }`.

### 2.2 protocol: session ops (`packages/protocol/src/session/remote-help.ts`; operations.ts + operation-safety.ts rows; feature name `remoteHelp`; SESSION_API_LEVEL +1)

```ts
RemoteHelpGrant = { level, since: iso, until: iso | null /* null = forever */, grantedBy: { accountId, name },
                    helpCode: string | null /* only when helpCodeRequired; formatted on the client */ }
RemoteHelpConnected = { visitId, who: string /* certificate name */, since: iso }
RemoteHelpState = { available: boolean, foreverAllowed: boolean, helpCodeRequired: boolean,
                    grant: RemoteHelpGrant | null, connected: RemoteHelpConnected[] /* ≤ 8 */ }
RemoteHelpVisit = { id, who, level, startedAt: iso, endedAt: iso | null, steps: RemoteHelpStep[] /* ≤ 200 newest */,
                    truncated: boolean, transcriptBytes: int }

remoteHelp.get           {}                                         → RemoteHelpState          READ, owners
remoteHelp.confirmBegin  {}                                         → { options: PasskeyRequestOptionsJSON | null }  owners (null: no passkey)
remoteHelp.start         { level, duration, passkey?: PasskeyAssertionJSON } → RemoteHelpState    RECEIPT, owners
remoteHelp.stop          {}                                         → RemoteHelpState          RECEIPT, owners (idempotent)
remoteHelp.visits        { before?: visitId, limit?: 1..20 }        → { visits: RemoteHelpVisit[] }  READ, owners
remoteHelp.transcript    { visitId }   (sessionExport, text/plain; utf-8) READ, owners
```

Refusal codes (`details.code`, add to `APP_ERROR_CODES`): `remote_help_unavailable`, `forever_not_allowed`,
`passkey_required` (owner has a passkey but sent none), `passkey_failed`, `remote_help_busy` (support service didn't
answer). New passkey challenge purpose `whombat-remote-help/1`: challenge = SHA-256(canonicalJson({purpose, nonce,
endpoint, level, duration})) so an assertion only confirms this exact choice (export
`passkeyRemoteHelpChallenge(Base64url)`).

Appliance events (`APPLIANCE_EVENT_TYPES` + payload schemas): `remote_help.on` `{level, duration}`, `remote_help.off`
`{reason: 'owner'|'desk'|'expired'|'wrong_codes'}`, `remote_help.visit` `{who, level, startedAt, endedAt, steps}`.

### 2.3 control-contracts: the box's local socket (`packages/control-contracts/src/local/support.ts` + Go mirror in `go/local/`, documented in `docs/local-ipc.md`)

Socket `/run/whombat-support/api.sock`, HTTP/1.1 JSON like the bluetooth/presence sockets. Callers by uid (SO_PEERCRED):
runtime (951) everything, manager (950) `state` only, root everything.

```
SUPPORT_PATHS = { state: 'GET /v1/state', grant: 'POST /v1/grant', stop: 'POST /v1/stop',
                  visits: 'GET /v1/visits', transcript: 'GET /v1/visits/{id}/transcript', events: 'GET /v1/events' }
SupportState  = { available, foreverAllowed, helpCodeRequired, environment: 'local'|'dev'|'prod',
                  hostKey: string | null /* 'ssh-ed25519 AAAA…' */, grant: (RemoteHelpGrant & { wrongCodes: int }) | null,
                  connected: RemoteHelpConnected[] }
SupportGrantRequest = { level, durationS: 3600|86400|604800|null /* null = forever */, grantedBy: { accountId, name } }
SupportStopRequest  = { reason: 'owner'|'desk', by?: { accountId, name } }
GET /v1/visits?before=&limit=  → { visits: RemoteHelpVisit[] }
GET /v1/visits/{id}/transcript → text/plain stream (404 when none)
GET /v1/events?after=<seq>&waitS=<0..25> → { events: SupportEvent[], next: int }   (long poll)
SupportEvent = { seq, at, kind: 'grant'|'stop'|'expired'|'visit_start'|'visit_end'|'locked_out',
                 level?, durationS?: int|null, reason?, visitId?, who?, steps?: int, by?: { accountId, name } }
Errors: { error: { code } } with codes forever_not_allowed, unavailable, bad_request, not_found, forbidden.
```

### 2.4 control-contracts: desk (`local/desk.ts`, additive)

`DeskState.remoteHelp?: { level, until: iso | null, connected: string | null /* who, newest */ }` (absent when off) and
`DESK_PATHS.remoteHelpStop = 'POST /v1/remote-help/stop'` (no body; answers the new DeskState). Older consoles strip it.

### 2.5 control-contracts: device API (box → control)

- `DeviceStatusReport.support?: { state: 'off'|'look'|'fix', untilS: int | null /* seconds left; null with look/fix =
  forever */, connected: int (0..8), helpCode: boolean, hostKey: string | null /* 'ssh-ed25519 <base64>' ≤ 120 chars */ }`
  (optional; strict).
- New device op `support.ticket` (body `{}` strict) → `TicketResponse` for the device's **support route**: `rol:'appliance'`,
  `apl` = the device's support route id, `sub` = device id, `org` = its org, `chn:'app'`, class `interactive`. Refused for
  unclaimed or retired devices. Rate limit 60/min/device.

### 2.6 control-contracts: operator API

- `OPERATOR_PERMISSIONS` += `'support'`.
- `support.open` `POST /v1/operator/devices/:deviceId/support` body `{ publicKey: 'ssh-ed25519 AAAA… [comment]',
  name: string 1..40 (shown to the owner) }` → `{ certificate: string /* 'ssh-ed25519-cert-v01@openssh.com AAAA…' */,
  validBefore: iso, principal: deviceId, hostKey: string, level, untilS: int|null, helpCodeRequired: boolean,
  ticket: TicketResponse /* client ticket for the support route */ }`. Refusals: 404 `device_not_found`, 409
  `remote_help_off` (no status report in the last 15 minutes, or its `support.state` is `off`).
- `support.ticket` `POST /v1/operator/devices/:deviceId/support/ticket` body `{}` → `TicketResponse` (another client
  ticket; same refusals).
- Client tickets for support: `rol:'client'`, `sub` = a stable opaque relay subject per operator (`OpaqueId` format).

### 2.7 Terms

`APPLIANCE_TERMS_VERSION` → `'2026-10-21-draft'` (CT row; W ships the text; control and app deploy together, LC-20).

## 3. Streams

### C — contracts (start now; everyone waits for 0.119.0)
Everything in §2 with tests (Zod round-trips, help-code normalisation, state line incl. time zones and “tomorrow”,
step words, challenge bytes, Go conformance via `pnpm gen` / `pnpm gen:check` / `pnpm test:go`), CT rows in the
contracts notes, `docs/local-ipc.md` section, version **0.119.0** in the release metadata but **don't run the release**:
when done, report; the lead merges f0's 0.118.0 first, then releases.

### K — control
1. Vendor contracts 0.119.0 when released (from **0.51.0**: expect fallout; fix it minimally, note what moved). Until
   then build against stand-ins.
2. Migration: `devices.support_route_id` (opaque id, generated on first `support.ticket`, unique). Device op
   `support.ticket` (§2.5) through the existing device-op machinery (signature, nonce, rate limits).
3. `status.report.support` accepted and stored (schema does it; make sure the panel/operator device view returns it).
4. Support CA: `SUPPORT_CA_KEY_FILE` (Ed25519 private key, PKCS#8 PEM, `*_FILE` rule CL-18), `SUPPORT_CERT_TTL_S`
   (default 14400; DEV stack 28800). Write the OpenSSH user-certificate encoder yourself (no new dependency; it's a
   small wire format: `ssh-ed25519-cert-v01@openssh.com`, nonce, pubkey, serial (random u64), type 1, key id
   `"<name> (<operatorId>[ via <panel user>])"`, principals `[deviceId]`, valid after now−60 s, valid before now+TTL,
   no critical options, extensions `permit-pty` and `permit-port-forwarding`, signature key, Ed25519 signature).
   Test it against `ssh-keygen -L -f` and against `golang.org/x/crypto/ssh` semantics where you can (the appliance CI
   has `ssh-keygen`). Control without the key file answers `support.open` with 503 `support_unavailable`.
5. Operator ops `support.open` / `support.ticket` (§2.6) with the `support` permission, served on both the bearer
   listener and the panel; each issuance in `operator_audit` and the owner org's `audit_events` (actor `operator`,
   metadata only: device, name, level, certificate serial and validity).
6. `dev-init`: generate the DEV support CA key next to the other DEV keys if missing, print/write its OpenSSH public
   line (`support-ca.pub` beside it), and give the DEV operator token the `support` permission. Don't touch the running
   DEV stack's files; the lead installs the real key.
7. `APPLIANCE_TERMS_VERSION` follows contracts (claims.start uses the vendored constant).
8. Decisions CL-121… in `docs/decisions/control.md`; `docs/device-api.md` and operator docs updated; runbook note: prod
   key generated on the host at the next prod deploy (HZ-05 style), its public line goes to the appliance's
   `manifest/prod/support-ca.pub`.

### A — the support service (appliance, `support/`)
1. Go service `whombat-support` (root; `support/cmd/whombat-support`, packages under `support/internal/…`), added to
   `nix/packages/go.nix` (dirs + `mk` entry, vendorHash) and the flake overlay. Dependencies: `golang.org/x/crypto/ssh`
   (already in the module), `github.com/gorilla/websocket` (what the relay uses), a PTY (`github.com/creack/pty` or
   `x/sys/unix` — your call, note it).
2. Local socket API §2.3 (socket activation like presence; peer uid checks with `helper/pkg/peercred`). Grant store
   `/var/lib/whombat-support/grant.json` (0600, survives reboots), expiry timer, `foreverAllowed` = environment ≠ prod,
   `helpCodeRequired` = environment = prod, help code from the Crockford alphabet (crypto/rand), 5 wrong codes → grant
   ends (`locked_out`). Event log with seq for long-poll. Level downgrade/stop/expiry closes affected connections at once.
3. Relay worker while a grant is active (and only then): ticket from the manager's `POST /v1/support/ticket`
   (B adds it; returns the device op's `TicketResponse`), refreshed before `exp`; control connection
   (`hello` without session, class `interactive`), one data WebSocket per `incoming` (same ticket, must be unexpired),
   binary frames ≤ 256 KiB, answer pings; follow `packages/protocol/src/relay.ts`/`admission.ts` exactly. Reconnect with
   backoff; stop dialing the moment the grant ends.
4. SSH server over each data connection (`x/crypto/ssh`): host key ed25519 generated at first start in the state dir
   (never in the image); `CertChecker` with the pinned CA keys (`/etc/whombat/support-ca.pub`, one or more lines; absent
   → `available:false`), principal must equal the device id (`/persist/identity/device.json`), cert time window,
   user name = help code on prod (normalised compare, constant time), max 8 connections, 10 s auth timeout, 3 auth
   tries. Key id = who.
5. Look (§2.1 commands): fixed argument grammar (units `^[A-Za-z0-9@._-]{1,80}$`, `--since/--until` journalctl time
   forms, `-n` ≤ 10000, `-p` priority, `-f`, `-k`, `-b [N]`, `-g PATTERN` ≤ 100 chars), run as the unprivileged user
   `whombat-support-look` (journal group; no access to /persist content), manager reads (hardware, network state,
   update status, host metrics) done by the service itself over the manager socket (B allows uid 0). `processes` shows
   comm only, never arguments. `report` = the devbox diag set (harness/src/devbox/main.ts) minus incus internals.
   Unknown command → refused step + message listing commands.
6. Fix: PTY shell (`bash -l` as root with the system PATH), exec (`sh -c`), `restart <unit>`, `direct-tcpip` to
   127.0.0.1/::1 only, `direct-streamlocal@openssh.com` to sockets under `/run` only. No agent/X11 forwarding, no
   remote forwarding, no SFTP subsystem.
7. Records (RH-07): `/var/lib/whombat-support/visits/<id>/` (meta.json, steps.jsonl, transcript.txt with ANSI kept out
   of the owner text? keep raw, the runtime strips), visit = certificate serial, idle 15 min ends it, caps and pruning
   per `REMOTE_HELP_LIMITS`.
8. Nix `nix/modules/support.nix`: service (root, minimal sandboxing that still lets Fix be real root — explain your
   choice in NX-41x), socket 0660 with the runtime's and manager's groups, user `whombat-support-look` (next id in
   `whombat.ids`), option `whombat.support.caKeys` (path or null); `dev-instance.nix` pins
   `manifest/dev-instance/support-ca.pub` (the lead commits the real DEV line; use a test key in tests and leave a
   clearly-marked placeholder file), `prod-instance.nix` pins `manifest/prod/support-ca.pub` when it exists, else null
   (no throw); assertion: prod never pins the dev file. `WHOMBAT_SUPPORT_SOCKET` in `runtime.nix`. Module on by default
   in `profiles/appliance.nix`. Amend NX-10 with NX-411 (and the comments in `base.nix`), keep openssh disabled.
9. Tests: Go unit tests (grant rules, code checks, Look grammar, cert checks with a test CA, visit grouping, fake relay
   in process with gorilla's server, ssh client from x/crypto/ssh end to end in process); a NixOS VM test
   `vm-tests/support.nix` (socket uid checks, grant/stop/expiry, Look as the look user can't read /persist) and a
   `support-config` static check. Build `nix build .#whombat-support` and the VM test.

### B — manager, console, harness, docs (appliance)
Peer f0 is rewriting the desk page at the same time (`Glance.tsx`, `Desk.tsx`, `Sheet.tsx`, `Night.tsx`,
`desk.module.css`, `lib/deskScene.ts`, `lib/deskCopy.ts`, `lib/desk.ts`, Go `internal/desk` wire/clean): put the remote
help line in its own component and CSS module, and touch their files only with small insertions (one render line in the
glance's top part, one optional member in the parser), so the merge stays trivial.
1. Manager (MG-118…): broker `POST /v1/support/ticket` for uid 0 → `controlapi` device op `support.ticket` (new client
   method, cached until 60 s before `exp`); allow uid 0 on the read routes Look uses (hardware, network state, update
   status, host metrics); status.report gets `support` from the support socket's `GET /v1/state` (manager uid; absent
   socket or error → field omitted). `manager.nix`: whatever group/perm the support service needs to reach
   `/run/whombat-manager/api.sock`.
2. Console (CG-290…): `remoteHelp` line at the top of the glance with Stop (§4 words), pass-through
   `POST /api/desk/remote-help/stop` → desk socket `remoteHelpStop`; no unlock needed. Vendored `desk.ts` updated on 0.119.0.
3. Harness (IN-358…): `dev/support` (`harness/src/support/…`, unit tests): `dev/support list` (devices with remote help
   on, from the operator API), `dev/support <name|device id> [look command and args]`, `shell [-- cmd]`,
   `port <port> [path]` (GET through a forward), `sock <path> [http path]`. Ephemeral ed25519 key + certificate cached
   under `~/.cache/wb-tmp/support/<device>/` until 10 min before expiry; `known_hosts` from `hostKey`; OpenSSH `ssh` with
   `ProxyCommand` = a Node pipe (`harness/src/support/pipe.ts`, Node's global WebSocket, subprotocol
   `whombat-relay.v1`, hello with a fresh client ticket from `support.ticket`) and `ControlMaster auto`/`ControlPersist
   10m`; user name = `--code` on prod boxes, `support` otherwise; name on the box `--as` default `Claude`. Operator API
   URL/token as the other dev tools find them (`devbox/control.ts`, `ship/context.ts` `devOp`). Pass
   `SUPPORT_CA_KEY_FILE`/`SUPPORT_CERT_TTL_S=28800` to DEV control in `harness/src/dev/services.ts`.
4. Docs: `docs/runbooks/support.md` rewritten for remote help (customer flow: owner turns it on and reads the help code,
   operator uses the tool; what support may and may not do), `dev-instance.md` section “Remote help into DEV boxes”,
   the appliance's copy of the Appliance Terms if the repo holds one (LC-21, byte-identical to W's text), NX/MG/CG/IN rows.

### S — Whombat server
1. `managed/remote-help.ts` (+ `remote-help-client.ts` socket client modelled on `bluetooth-client.ts`; `fake` mode via
   `WHOMBAT_SUPPORT=fake|off` for dev/e2e; `WHOMBAT_SUPPORT_SOCKET`), wired into the dispatcher/runtime like diagnostics;
   feature `remoteHelp` advertised only when the socket answers.
2. Ops §2.2 with `requireOwner`; passkey step-up: begin stores a nonce in the session scope (single use, 300 s), the
   assertion must come from a passkey of this owner on this Whombat (reuse/generalise `verifyAssertion` in
   `managed/passkeys.ts`); owners with no passkey may start without one; `passkey_required` if they have one and sent none.
3. Event follower: long-polls the support socket; on `grant` by someone → tell the other owners; `visit_start` →
   security push to every owner (`ControlPush.forAccounts`) + a message from each owner's assistant (§4, core words);
   `locked_out` → tell owners; appliance events for on/off/visit (RH-08). Survives restarts without repeating messages
   (keep the last seq: migration 0133 or an existing key-value place — your call, RH-S).
4. Transcript export: stream the support socket's text through `sessionExport`, strip ANSI/control characters except
   newlines and tabs.
5. Desk: `DeskState.remoteHelp` filled from the support state, `remoteHelpStop` path → stop with reason `desk`
   (no unlock), state marked dirty on support events.
6. Tests: unit (step words use, state mapping, passkey challenge binding, follower dedupe) + extend an existing managed
   int test only where Postgres is really needed.

### W — web, client, admin panel, legal (whombat-app)
1. Client: `sessionOps` wrappers; `packages/client/src/managed/remote-help.ts` (view model: card state, choices, Forever
   only when `foreverAllowed`, confirm flow: `confirmBegin` → passkey `get` via the platform → `start`; no passkey →
   confirm dialog), refusal words; fake world support for e2e.
2. Web: `RemoteHelpSection` in This Whombat → About, above Diagnostics, owners only; the transcript opens in a modal
   (“Show”) with Download; e2e spec in the managed suite.
3. Admin panel (`apps/admin`): the device page shows the remote help line from the last status report.
4. Legal (`apps/web/src/legal/`): Privacy Policy, Appliance Terms (new version id §2.7), Terms of Service, plus
   `docs/privacy-and-security.md` (§5.3 “No remote access” → remote help). Plain words, like RH-11.
5. Then hand the client to M: report the commit that has the client part.

### M — Android (whombat-app, after W's client)
The same section on the phone's About screen (`apps/mobile/src/managed/WhombatAboutScreen.tsx`), 44 px targets,
passkey via `phonePasskeys()`, transcript in a sheet with Share/Download. Emulator: your own read-only instance on port
5622 (`emulator -avd whombat-mobile -port 5622 -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`),
`adb -s emulator-5622 emu kill` when done.

## 4. Words (verbatim)

- Card title **Remote help**. Off: “Let Whombat support look inside this Whombat for a while to find out what’s wrong.
  Nobody can get in while this is off.”
- Labels: “How much”, “For how long”.
- Look: **Look** — “Read its logs, status, hardware and network. They can’t change anything or see your chats, files or
  Vault.” Look and fix: **Look and fix** — “Also restart parts, change settings and run commands. This lets them see
  everything on this Whombat.”
- Durations: “1 hour”, “1 day”, “1 week”, “Forever” (only when allowed).
- Button “Turn on remote help”; hint when the owner has a passkey: “You’ll confirm with your passkey.” Confirm dialog
  without a passkey: title “Turn on remote help?”, body “Whombat support can {look|look and fix} {for 1 hour|for 1 day|
  for 1 week|until you stop it}.”, buttons “Turn on”, “Cancel”.
- On: state line (`remoteHelpStateLine`), button “Stop”. Help code label “Help code”, hint “Give this to Whombat support.
  They need it to connect.” Connected: “{who} from Whombat support is connected now”.
- Visits label “What support did”; empty “Nobody has used remote help yet.”; steps: connected “{who} connected”, left
  “{who} left”, look by command: status “Looked at the status”, units “Looked at the running parts”, logs “Read the
  logs” / “Read the logs of {names}”, boots “Looked at the restarts”, hardware “Looked at the hardware”, network
  “Looked at the network”, disks “Looked at the disks”, memory “Looked at the memory”, processes “Looked at running
  programs”, updates “Looked at updates”, report “Made a full report”, help “Looked at the help”; exec “Ran {line}”
  (line in code style), shell “Used a command line for {n} minute(s)” / “… for less than a minute”, restart
  “Restarted {name}”, forward “Opened a connection to {target}”, refused “Was stopped: {that needs Look and fix|wrong
  help code|not allowed}”, wrong_code “Typed a wrong help code”. Transcript link “Show”; modal title “Command line”,
  button “Download”.
- Not available: “Remote help isn’t available on this Whombat yet.”
- Refusals: forever_not_allowed “Forever is only for test Whombats.”; passkey_failed “Your passkey didn’t confirm it.
  Try again.”; remote_help_busy “Remote help didn’t answer. Try again in a moment.”
- Messages from the assistant to owners: visit start “{who} from Whombat support is looking at this Whombat now. You can
  stop it in Settings → This Whombat → About.”; another owner turned it on “{owner} turned on remote help: {Look|Look
  and fix}, {for 1 hour|…|forever}.”; locked out “Remote help turned itself off after 5 wrong help codes.”
- Desk: “Remote help is on · until {time}” (or “· forever”), connected “{who} from Whombat support is connected”, button
  “Stop”.
- Admin panel: “Remote help: off” / “Remote help: Look · {n} h left” / “Remote help: Look and fix · forever”, plus
  “{n} connected”.
