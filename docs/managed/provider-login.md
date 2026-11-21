# Provider sign-in on a Whombat appliance

How a person connects Claude, Codex and GitHub to Whombat from the web UI, in a browser on any computer, without a
terminal — and what Whombat does with it. Decisions: `docs/decisions/managed-providers.md` (PV-03 … PV-13) and
`docs/decisions/provider-subscriptions.md` (SUB-01 … SUB-26). Code: `apps/server/src/managed/providers/` (service,
console relay, REST and session ops, handlers, credential owner, GitHub), `apps/server/src/clients/` (AI clients) and
`packages/agent-runtime/src/providers/` (policy, homes, sign-in drivers and console, turn credential, clients).

In development (`pnpm dev`) the runner's sign-in executor keeps the same per-person homes under
`WHOMBAT_CREDENTIALS_ROOT` (default `$WHOMBAT_HOME/credentials`); there is no host or operator login (HE-48).

## What each person can connect

| Provider | Mode | Flow | Stored in `WHOMBAT_CREDENTIALS_ROOT/<account>/…` | Checked |
|---|---|---|---|---|
| Claude | Anthropic API key | key entry | `claude/api-key` (0600), read by Claude Code's `apiKeyHelper` | `GET /v1/models?limit=1` (no model) |
| Codex | OpenAI API key | key entry → `codex login --with-api-key` (stdin) | `codex/auth.json` (by Codex) | `GET /v1/models` (no model) |
| Codex | Access token (Business/Enterprise) | token entry + “I created this token” + expiry → `codex login --with-access-token` | `codex/auth.json` | not verified until first use |
| Codex | ChatGPT (device code) | `codex login --device-auth`, code relayed | `codex/auth.json` | by OpenAI (permitted for a person's own work, SUB-01) |
| GitHub | device flow | `gh auth login --web`, code relayed | `github/hosts.yml` (by gh) | by GitHub |
| GitHub | personal access token | `gh auth login --with-token` (stdin) | `github/hosts.yml` | by gh |
| Claude | subscription (`subscription_cli`) | Claude Code's own `claude auth login --claudeai` in a console (SUB-03, SUB-20, CT-71): the person signs in on claude.ai and types the code into the console | `claude/config/` (by Claude Code; Whombat never opens it) | `claude auth status` |
| Claude | Bedrock / Google Cloud / Foundry | — | — | not built |

Owners can also add **organization credentials** (an Anthropic or OpenAI API key with a label, stored under
`<root>/org/<credentialId>/<provider>`) for team agents that serve several people; a person's own sign-in serves only
their own requests and automations (MA-17).

The CLIs run in the runner's sign-in executor, as the runner's user (PV-12); the server relays each step.
Each sign-in belongs to the signed-in account. Nobody else can see, continue, cancel or use it; logout removes the
directory and any sign-in of theirs still being staged; no Claude or Codex CLI runs on it first (SUB-41: a turn may
have written in it, and those CLIs would run outside any sandbox). The person revokes a ChatGPT or claude.ai session
at the provider if they want it gone there too. Secrets travel only inside the
encrypted session (`providers.login.submit`), reach the CLI only on stdin and are never echoed, logged, audited or
stored anywhere else.

## Session ops (contracts 0.5.0 CT-26, 0.5.1 CT-39/CT-44)

Shapes: `@whombat/protocol/session` (`providers.ts`) and `@whombat/core` (`agents.setCredentialSource`, `runnerApi.signin*`).
The `providers.*` ops act for the session's own account; the organization ops are owners'.

| Op | Input | Output | Mutating |
|---|---|---|---|
| `providers.list` | `{}` | `{signIns: ProviderSignIn[], logins: ProviderLogin[], modes: {provider, authMode, available, reason}[]}` | no |
| `providers.login.start` | `{provider: 'claude'\|'codex'\|'github', authMode}` | `ProviderLogin` | yes, `secret` (0.5.1) |
| `providers.login.submit` | `{loginId, secret, expiresAt?, creatorAttested?}` | `ProviderLogin` | yes, **`secret: true`** (no receipt digest, no stored result) |
| `providers.login.status` | `{loginId}` | `ProviderLogin` | no |
| `providers.login.cancel` | `{loginId}` | `ProviderLogin` | yes |
| `providers.logout` | `{provider}` | `{removed}` | yes |
| `agents.setCredentialOwner` (REST, CT-26) | `PUT /burrows/:burrow/agents/:agent/credential-owner {accountId \| null}` | `{agentId, eventId}` | yes (Keys event, `burrow.manage`) |
| `providers.org.list` (0.5.1) | `{}` | `{credentials: {credentialId, label, provider, authMode, createdAt, verified, state, explanation}[]}` | no |
| `providers.org.login.start` (0.5.1) | `{provider: 'claude'\|'codex', authMode: 'api_key', label}` | `ProviderLogin & {credentialId}` | yes (owners), `secret` |
| `providers.org.remove` (0.5.1) | `{credentialId}` | `{removed}` | yes (owners) |
| `agents.setCredentialSource` (REST, 0.5.1) | `PUT /burrows/:burrow/agents/:agent/credential-source {source: {kind: 'account', accountId} \| {kind: 'org', credentialId} \| null}`; over a session `{params: {burrow, agent}, body: {source}}` | `{agentId, eventId}` | yes (Keys event, burrow owners) |

An organization sign-in continues with `providers.login.submit|status|cancel`.

`ProviderLogin = {loginId: 'plg_…', provider, authMode, state: awaiting_secret|awaiting_user|completed|failed|expired|cancelled, device: {verificationUri, userCode, expiresAt} | null, error: {code, message} | null, verified: valid|unverified|null, expiresAt}`.
`ProviderSignIn = {provider, authMode, ownerAccountId, createdAt, expiresAt, verified, login, state, explanation}`.
A client polls `providers.login.status` (every 2–5 s) while `awaiting_user`; a `provider.login` event on the
account topic is a possible later addition.

### Flows

- **Key entry:** `start` → `awaiting_secret` (10 minutes) → the UI asks for the key → `submit` → `completed`
  (`verified: valid|unverified`) or `failed` (`provider.secret_invalid`, `provider.login_failed` with the CLI's
  reason). Access tokens need `creatorAttested: true` and `expiresAt` within 90 days.
- **Device code:** `start` → `awaiting_user` with `device` → the UI shows “Open `verificationUri` on any device and
  enter `userCode`” (copy button, expiry countdown) → the appliance's CLI polls the provider → `completed`, or
  `expired` (`provider.login_expired`), `failed` (`provider.login_denied`, `provider.login_disabled` — device login
  not enabled in the account's security settings —, `provider.login_network`), `cancelled`.

### New app error codes (`error.details.code`)

`managed.provider_gated`, `managed.provider_excluded` (policy, with `managed: true, reason: '<provider>:<mode>'`);
`provider.login_unavailable`, `provider.not_configured`, `provider.login_not_found`, `provider.login_not_waiting`,
`provider.login_expired`, `provider.login_failed`, `provider.login_denied`, `provider.login_disabled`,
`provider.login_network`, `provider.login_missing`, `provider.login_cancelled`, `provider.secret_invalid`,
`provider.token_creator_required`, `provider.token_expiry_required`; turn refusals `provider.not_signed_in`,
`provider.owner_required`, `provider.owner_departed`, `provider.auth_expired`, `provider.auth_revoked`,
`provider.quota_exhausted`, `provider.outage`, `provider.version_drift`.

### Contract status (0.5.1)

0.5.1 adopted everything this workstream had as appliance extensions: `AgentRuntime.credentialSource` (read with
`credentialSourceOf`; `credentialOwnerAccountId` is still written next to an `account` source for 0.5.0 readers),
`DispatchContext.credential.source` and `automationPublisherAccountId` (the claim answer's `credentialExtension` is
gone), `providers.org.*`, `agents.setCredentialSource`, organization rows in `ProviderSignIn`, the runner's
`signin.poll|answer|event` with `SIGNIN_METHODS` (params checked by the runner, results by the server) and the
`secret` flag covering results (CT-44). Remaining gap: the contract's `CredentialMeta` (a `list` row) doesn't name
the last run's `signal`, `login` or `creatorAttested`; the server validates the runner's answer against the
contract and keeps those fields.

## Sign-ins over REST (contracts 0.9.0, CT-70)

The same service answers `api.signins.*`, as `api` ops of the same names over the session (the session-native
`providers.*` ops went with contracts 1.0.0, HE-52). Organization credentials: owners of the appliance. Secret routes
(`loginStart`, `loginSubmit`, `orgLoginStart`, `consoleRead`, `consoleWrite`) write no request line and log nothing of
their body or answer; over the session they are `secret` ops (no receipt digest, no kept result).

| Endpoint | Op |
|---|---|
| `GET /sign-ins` | `signins.list` → `{signIns, logins, modes, consoles}` |
| `POST /sign-ins/logins` · `GET …/:loginId` · `POST …/:loginId/submit` · `POST …/:loginId/cancel` | `signins.loginStart\|loginStatus\|loginSubmit\|loginCancel` |
| `DELETE /sign-ins/providers/:provider` | `signins.logout` |
| `GET /sign-ins/org` · `POST /sign-ins/org/logins` · `DELETE /sign-ins/org/:credentialId` | `signins.orgList\|orgLoginStart\|orgRemove` |
| `POST /sign-ins/consoles` | `signins.consoleStart {provider: 'claude', authMode: 'subscription_cli', cols, rows}` → `ProviderConsole` (201) |
| `GET /sign-ins/consoles/:consoleId?cursor&waitMs` | `signins.consoleRead` → `{console, from, data (base64), next, more}` |
| `POST /sign-ins/consoles/:consoleId/input` | `signins.consoleWrite {seq, data}` |
| `POST /sign-ins/consoles/:consoleId/resize` · `…/cancel` | `signins.consoleResize {cols, rows}` · `signins.consoleCancel` |

### The Claude sign-in console (CT-71, SUB-20)

1. `consoleStart` → the executor starts `claude auth login --claudeai` in a PTY with a private staging home
   (`CLAUDE_CONFIG_DIR` = its `config/`). A running console of the same account is cancelled first (a second tab takes
   over); a pending Claude key entry of the account is cancelled too.
2. The UI reads with a byte cursor (`consoleRead`, `waitMs` ≤ 25 s; over the session set `deadlineMs` above it),
   renders the bytes in a terminal emulator, and sends keystrokes with `consoleWrite` (`seq` from 1; a resent `seq`
   is answered without typing again; a gap answers `provider.console_input_gap` with `details.inputSeq`). The server
   keeps the newest 64 KiB of output; an older cursor is answered from `from`.
3. The person opens the URL Claude Code prints, signs in on claude.ai and pastes the code into the console.
4. After exit 0 the executor asks `claude auth status`; only `loggedIn: true` makes the console `completed` and moves
   the staging home into place (the sign-in appears in `signins.list`, audited `provider.signed_in`). Exit 0 without a
   sign-in: `failed`, `provider.login_missing`; otherwise `provider.login_failed`. After 10 minutes: `expired`.
5. Ended consoles stay in `signins.list` until their `expiresAt`, so a reloaded page shows how it ended.

On an appliance the console runs in the runner's `SignInWorker` (`signin.poll` `consoleStart|consoleInput|consoleResize|
consoleStop`, output and the exit reported with `POST /internal/runner/signin/console`).

New codes: `provider.console_not_found`, `provider.console_ended`, `provider.console_input_gap`; turn refusals
`provider.requester_not_signed_in`, `provider.no_requester`, `client.not_installed`.

## Team agents on each requester's sign-in (CT-69, SUB-04, SUB-23)

On a managed appliance new team agents (onboarding, hiring) get `{kind: 'requester', fallback: null}`: each turn runs on
the sign-in of the person the work is for (`DispatchCredential.onBehalfOfAccountId`) — their own request, an automation
they published, an agent chain they started, a run they asked for. A person without a sign-in for the agent's
provider is refused (`provider.requester_not_signed_in`, a reply addressed to them); work for nobody runs on the
optional organization fallback or is refused (`provider.no_requester`). An owner sets it with
`agents.setCredentialSource {source: {kind: 'requester', fallback: {kind: 'org', credentialId} | null}}` (the
fallback must be an organization credential for the agent's provider). Personal agents are unchanged.

A feedback assessment is for the owner who set up the integration (the intake snapshot's `configuredById`, SUB-58):
their own automation (NA), so a `requester` assessor runs on that owner's sign-in, and one who hasn't signed in gets
`provider.requester_not_signed_in` with a sentence for the report's channel (sign in under Settings → AI accounts,
then Retry).

## A member's own sign-in shared with everyone (CT-159, SUB-57)

`{kind: 'account', accountId, shared: true}`: everyone's requests to the agent run on that person's own sign-in. Only
that person sets it (`agents.setCredentialSource` by the account it names; anyone else: `forbidden`); it is an
override against the providers' terms, and the app says so where it is chosen. The runner checks the policy for a
colleague's request (OA) as the owner's own use (PI); everything else (not signed in, lapsed, drift, a departed
owner) refuses as for any personal sign-in. Runtimes that have it advertise `signins.shared` in `welcome.runtime`.

## AI clients (CT-72 … CT-74, SUB-09, SUB-25, SUB-26)

Claude Code is the only AI client (DirectSDK's model client); ChatGPT runs on Hermes's own loop with nothing installed
(`docs/decisions/hermes-native.md` HN-04, HN-A01…HN-A03). `GET /clients` (`clients.list` → `{clients: ClientStatus[],
checkedAt, canManage}`, Claude Code's row only), `POST /clients/claude/install`, `DELETE /clients/claude` (burrow owners
who are admins; `codex` is refused with `validation_failed`). The manager installs signed bundles (manager socket
`GET /v1/clients`, `POST /v1/clients/install|remove`) and pushes changes to the admin socket (`POST /clients`); the
runtime writes the latest to `WHOMBAT_CLIENTS_FILE`, asks the manager to remove a Codex it still has, and reports
`RuntimeFacts.clientAdapters` (`{claude: 1, codex: 1000000}`: no Codex bundle names that level). The runner runs exactly
`installed.executable.path`, checked against its sha256 — and only when its realpath is inside `WHOMBAT_CLIENTS_ROOT`
(default `/persist/whombat/clients`) with nothing on its path changeable by the server's user (SUB-45); sign-ins check
the same. Whether the runner is ready for Claude Code (its claims, the heartbeat's `ProviderCheck.version`) is the
installed client's too, re-checked when the file changes; the image's pins only without a clients file (SUB-49);
ChatGPT is ready whenever Hermes is. An unreadable clients file refuses turns and
sign-ins (`client.status_unreadable`, SUB-46). A development box has no client bundles (its stand-in manager lists
none; the scripted Hermes needs none).

## How a run uses a sign-in

The runner gets the credential from the claim (`DispatchContext.credential`, its `source`), resolves
exactly that credential's home (`resolveTurnCredential`), checks the policy for the workflow (a person's credential:
PI when they asked, NA for their own automations, anything else refused unless they shared it, SUB-57; an
organization credential: OA), the pinned
runtime and the sign-in's state, and runs the provider in the sandbox with that home as its only login: Codex `CODEX_HOME=<home>`; Claude
Code (the unmodified binary, SUB-12) `CLAUDE_CONFIG_DIR=<home>/config` — for a subscription its own login lives and is
refreshed there, and it is the only writable part of the home in the sandbox (SUB-13) — and for an API key
`--settings {"apiKeyHelper": "cat '<home>/api-key'", "env": {"DISABLE_UPDATES": "1"}}` (the key file mounted
read-only). No key is in any environment variable. A failed run records `quota_exhausted`,
`auth_revoked`, `auth_expired` or `outage` in the home until the next good run; nothing switches to another login.

## Qualification not run here (needs real accounts): exact manual procedure

No real provider credentials were used in this workstream; everything above is tested with fake CLIs that
reproduce the pinned versions' observed output, plus offline checks of the real binaries. The following is the
named unrun qualification (assignment §14 item 9). Record date, versions (`codex --version`, `claude --version`,
`gh --version` on the appliance), who ran it and each outcome.

Setup: an appliance (or the appliance's dev stack) reachable only through the relay; a laptop browser signed in to
the hosted UI as member **A**, a second browser profile as member **B**; A's own Anthropic key, OpenAI key, GitHub
account with 2FA, and — for the gated check only, on a test appliance with the policy overridden in code — a ChatGPT
account with device code login enabled.

1. A: Settings → AI providers → Claude → “Anthropic API key”: paste the key. Expect `completed`, `verified: valid`;
   on the appliance `ls -l $ROOT/<A>/claude` shows `api-key` 0600, `whombat-credential.json` has no key; `journalctl`
   and `appliance_events` contain no part of it.
2. A: Codex → “OpenAI API key”: same; `codex login status` with `CODEX_HOME=$ROOT/<A>/codex` says “Logged in using an
   API key”.
3. A: GitHub → “Sign in with GitHub”: the UI shows a code and `https://github.com/login/device`; open it on the
   laptop (not the appliance), enter the code, approve. Expect `completed` with A's login; `hosts.yml` in A's home
   only; no process listening on a new port on the appliance (`ss -ltnp`) at any point.
4. Repeat 3 and let the code expire (15 minutes): `expired`. Repeat and cancel: the gh process is gone.
5. Personal agent of A: ask it (as A) to run a small task on Claude, then on Codex. Expect one model call each, on
   A's key (check each provider's usage page for A); the run header names A's sign-in.
6. Team agent: as owner, add an organization OpenAI key and put the team agent on it (`agents.setCredentialSource`);
   B asks it something → it runs (OA) on the organization key. Put it on A's own sign-in (`agents.setCredentialOwner`)
   → B's request is refused (a personal credential serves only A), A's own request runs (PI).
6b. GitHub: as owner, connect the burrow (Settings · GitHub) with your own GitHub sign-in; the status names you;
   polling and PRs run as you; remove you from the burrow → GitHub work stops with “… is no longer a member”.
7. Revoke A's OpenAI key in the OpenAI dashboard; ask again → the turn fails, A's Codex row shows `auth_revoked`;
   no other key is used (B's usage unchanged). Sign in again → `ready`.
8. Exhaust or disable billing on a test Anthropic key → `quota_exhausted`, no fallback.
9. Remove A from the burrow → A's agent turns refuse with `owner_departed`.
10. Update the appliance (runtime bundle) → sign-ins persist (homes are under `/persist`), `version_drift` never shows
    for the pinned versions; swap the Codex binary for another version → turns refuse with `version_drift`.
11. Logout of each provider → home removed, no CLI started on it (SUB-41).
12. Gated check (test appliance, policy override in code only): Codex ChatGPT device code from the laptop browser
    completes without a terminal. Record it as technical evidence only — not permission (X-02).
