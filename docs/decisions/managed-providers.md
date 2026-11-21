# Managed providers (workstream `managed/providers`, W3-PV)

Provider adapters, their authentication and version handling on a managed appliance: pinned official runtimes,
the eligibility policy, remote-browser sign-in, credential owners and states, the Codex app-server surface,
per-user GitHub, and the managed-mode design of OAuth callbacks, polling, webhooks and the Feedback intake.
Decisions are `PV-nn`; they refine MA-03, MA-10, MA-16 (`appliance/docs/implementation/architecture.md`)
and never override them. Authoritative for what is permitted: `appliance/docs/implementation/provider-evidence.md`
(the register). Companion docs: `docs/managed/provider-login.md` (ops, flows, the manual qualification) and
`docs/managed/provider-bundles.md` (pins, digests, Nix packaging).

| # | Decision | Reason |
|---|---|---|
| PV-01 | **Pinned official runtimes, drift refused.** `packages/agent-runtime/src/providers/bundles.ts` pins the Claude Code binary `2.1.283` itself (since 2026-09-26, SUB-15; before: Agent SDK `0.3.278` with its bundled `2.1.278`): Anthropic's release bucket `downloads.claude.ai/claude-code-releases/2.1.283/<platform>/claude` by sha256 and the byte-identical npm platform package by SRI, executable sha256 `1859583c…4ae2` (x64) / `346d294f…e697` (arm64), glibc-linked; and Codex CLI `0.157.0` (release asset `codex-package-x86_64-unknown-linux-musl.tar.gz` sha256 `042f851e…2a25`, npm SRI of `@openai/codex@0.157.0-linux-x64`, native binary sha256 `1a822376…0258`, static-pie; arm64 digests of the artifacts only). `checkProviderDrift` hashes the installed executable (Codex's npm launcher is measured on its native binary), runs `--version` with an empty environment and compares both; `WHOMBAT_PROVIDER_PINS` (the release's, MSB-15) must name the same version or nothing runs. A managed turn on a drifted runtime is refused (`version_drift`, `provider_missing` when absent); managed `available()` is exactly this check. **Self-updaters off with supported settings, verified against the pins:** Claude Code — `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in the environment (both on the sandbox's allowlist) plus flag settings `env.DISABLE_UPDATES=1`, which makes even `claude update` answer “Updates are disabled by your administrator” (run offline against 2.1.278, re-run against 2.1.283; every turn, self-hosted too since SUB-17); Codex — `check_for_update_on_startup = false` in every Whombat-written `config.toml` (accepted by `codex app-server --strict-config` 0.157.0; an unknown key is refused, so the check is real) and `-c check_for_update_on_startup=false -c analytics.enabled=false` on every managed launch. No binary is patched; installs are read-only in the sandbox anyway. | Assignment §8: pinned official runtimes, “self-updaters must not race appliance releases”. |
| PV-02 | **Superseded in part by one-person.md OP-S85**: the eligibility register as code holds, with PI and NA only (no OA or organisation column). **Eligibility policy as code** (`providers/eligibility.ts`, pure). The register as data (provider × auth mode × PI/NA/OA, person vs organization credential) with its evidence ids and conditions; unknown combinations are `excluded` (fail closed). Managed mode runs `permitted` and `permitted_candidate` (with its conditions enforced) and refuses `gated` (`managed.provider_gated`) and `excluded` (`managed.provider_excluded`) with the explanation people see; a sign-in whose every workflow is refused is refused up front. Self-hosted mode refuses nothing (the operator runs their own providers). Enforced matrix: see “Eligibility as enforced” below. | Register; “gated and excluded refuse turns with a clear explanation”. |
| PV-03 | **Superseded in part by one-person.md OP-S85**: the person's sign-ins live in one credential home per provider, `<credentials root>/<provider>`, still a private 0700 directory the provider's own CLI writes. **Credential homes and sign-in.** `WHOMBAT_CREDENTIALS_ROOT/<account>/<claude\|codex\|github>` (and `<root>/org/<credentialId>/<provider>` for organization credentials, MA-17), each a private 0700 directory, never a link; the provider's own CLI writes its login there: Codex `auth.json` (`cli_auth_credentials_store = "file"`, never a shared OS keyring; `forced_login_method` = `api` / `chatgpt` per mode, verified to refuse the other kind with 0.157.0), gh's `hosts.yml` (`--insecure-storage`), and for an Anthropic key a 0600 `api-key` file. Next to it `whombat-credential.json` records mode, owner, created/expiry, verification, the creator attestation of access tokens and the last run's signal — never a secret. Sign-ins run the CLI with an environment built from nothing but PATH and the locale (no `OPENAI_API_KEY`, `ANTHROPIC_*`, `GH_TOKEN` or operator home can be picked up), secrets only on stdin, output bounded and redacted, into a staging directory moved into place on success (a failed attempt never damages an earlier sign-in). Keys are checked for free where the provider has a check that runs no model (Anthropic `GET /v1/models?limit=1`, OpenAI `GET /v1/models`): 401 → refused, anything else → kept as “unverified until first use”; access tokens and GitHub tokens have no such check (gh validates its own). | MA-10 per-identity homes; “never logged/echoed”; no paid probe. |
| PV-04 | **Superseded by one-person.md OP-S09, OP-S85**: there is no credential source; every turn runs on the person's own sign-in or API key. **Credential source, no fallback** (MA-17, supersedes the orchestrator's first NA rule). A run's provider identity is the dispatching agent's configured source: a personal agent's person; else `runtime.credentialOwnerAccountId` (CT-26, a member's own sign-in, `agents.setCredentialOwner`) or `runtime.credentialSource {kind: 'org', credentialId}` (0.5.1, an organization credential, `agents.setCredentialSource`), set by a burrow owner (signed Keys event, only to a member / credential with a sign-in for the agent's provider; kept when other commands rewrite the runtime). **A personal credential serves only its owner's own work:** PI when the owner asked in person, NA for automations the owner published; anything else on it (a colleague's request, someone else's automation, an agent, the system) is OA, which the register excludes for personal credentials — refused with the explanation, because it would silently turn a personal credential into a shared one (assignment §1). Team agents serving several people run on an organization credential (OA, permitted for API keys). The claim answer carries the contract's `DispatchContext.credential` (0.5.1: with `source` and `automationPublisherAccountId`); the runner's one resolver (`resolveTurnCredential`) reads exactly that credential's home and refuses otherwise: no requester's or other person's home, no runner/operator environment login (`managedPassEnv`), no API-key fallback. No secret travels in the environment (MSB-18): Claude Code reads the key through its documented `apiKeyHelper` in flag settings (`cat '<home>/api-key'`; 2.1.283 reports `apiKeySource: apiKeyHelper` offline), a Claude subscription is the CLI's own login in `<home>/config` (SUB-13), Codex from `CODEX_HOME/auth.json`. An owner who left the burrow → `owner_departed` until an owner reassigns. “Run now” of an automation on a personal credential is its publisher's only (MA-19g, runtime MR-31). | MA-17; assignment §1, §8; MSB-18. |
| PV-05 | **Superseded in part by one-person.md OP-S85**: credential states still come from real signals, without “owner departed”. **Credential states from real signals** (`providers/states.ts`, table below). Precedence: owner departed → policy (`gated`) → `version_drift` → `not_signed_in` → `auth_expired` (recorded expiry) → the last run's signal while it holds (`quota_exhausted`, `auth_revoked`, `auth_expired`, `outage`) → `ready`. Providers now attach `credentialState` to a failed turn's `error` event; the runner records it in the owner's home and clears it after a good turn. `appliance.status.providers[]` (CT-24) comes from the homes: members see their own rows (a `not_signed_in` row per model provider they haven't signed in to), owners everyone's. | CT-24 distinct states. |
| PV-06 | **Superseded in part by one-person.md OP-S09, OP-S85**: GitHub still signs in through the unmodified CLI, into the person's one `github` home, and the agent's git work uses the burrow's GitHub connection only. **GitHub per user, no host account.** A person's own GitHub sign-in in their home through the unmodified GitHub CLI — `gh auth login --web` (GitHub's documented device flow; the “GitHub CLI” OAuth app, scopes `repo read:org gist`, no localhost callback) or `--with-token` (a pasted PAT, validated by gh). In managed mode the GitHub service's adapter is `ManagedGitHub`: every call about a repo runs as the owner who connected that repo's burrow (their own sign-in, named in the GitHub status note; a departed connector stops polling and PR work with the reason until an owner reconnects), calls without a repo (who am I, the repo picker) as the scope's account (connecting: the connecting owner, who needs a GitHub sign-in; burrow owners may connect, no Whombat-admin requirement since no host account is involved). Agents' git tokens: their credential owner's GitHub sign-in; team agents on an organization credential use the burrow's connection owner (the burrow's named GitHub identity). Never the host's gh. **GitHub App alternative** (documented, not built): only a customer-owned App whose private key is generated and kept on the appliance; never a vendor-wide App or key in an image. | Assignment §7; orchestrator item 3. |
| PV-07 | **Codex app-server: stdio, stable API by default.** Never exposed as Whombat's API; one process per turn over stdio. Upstream: “The app-server command and WebSocket transport are experimental and aren't supported for production workloads” (E-X1; the 0.157.0 CLI also labels `app-server` `[experimental]`). Operationally: pin (PV-01), a protocol fixture generated from the pinned binary (`providers/fixtures/codex-app-server-0.157.0.json`: every method's stability, the fields of the methods Whombat calls, `codexErrorInfo`, account shapes, sha256 of both generated schema bundles), tests that everything Whombat sends and handles is in it, and a live re-generation check when the pinned binary is installed. `capabilities.experimentalApi` is negotiated only when a request carries an experimental field: of what Whombat uses only `permissions` and `runtimeWorkspaceRoots` on `thread/start`, `thread/resume`, `turn/start` (the guarded permission profile) are experimental; every method is stable. The app-server's own login methods are not used (`chatgptAuthTokens` is marked “FOR OPENAI INTERNAL USE ONLY”); logins go through the documented `codex login` commands. | E-X1; assignment §8. |
| PV-08 | *Superseded 2026-09-26 by SUB-01…SUB-04 (turns: SUB-12, SUB-13; the sign-in console is a seam, SUB-14) (`docs/decisions/provider-subscriptions.md`): subscription sign-in is permitted for Claude (unmodified binary, CLI’s own flow) and Codex (device code).* **Claude subscription sign-in: not implemented.** Through the Agent SDK it is excluded (E-C2). Through the unmodified binary (`claude auth login`, `claude setup-token`) the flow ends with a code shown on Anthropic's page that must be typed into the CLI's terminal; from a browser on another computer that code would pass through Whombat (browser → session → CLI stdin), and E-C1 forbids apps to “collect, store, or intermediate Claude.ai credentials or session tokens — sign-in … must complete through Anthropic's own flow”. It is also `gated` (X-01). The sign-in op answers `provider.login_unavailable` with the reason. | E-C1, E-C2. |
| PV-09 | **Access tokens** (`permitted_candidate`): stored only with the person's attestation that they created the token and an expiry (≤ 90 days; the earlier of the entered date and a readable JWT `exp`); past it the state is `auth_expired` and runs stop. An access-token home forces no login method (how Codex treats such a credential under a forced method can't be verified without a real token). | E-X3 “belongs to its creator”, expiry required. |
| PV-10 | **Superseded in part by one-person.md OP-S09**: the sign-in ops hold; `agents.setCredentialOwner` and `providers.org.*` are gone. **Sign-in ops**: adopted by contracts 0.5.0 (CT-26: `providers.list`, `providers.login.start\|submit\|status\|cancel`, `providers.logout`; `providers.login.submit` and `backup.configureDestination` are `secret` ops, so their receipts keep `receiptDigest` = the digest over the op alone) and REST `agents.setCredentialOwner`; mounted in the dispatcher. Contracts 0.5.1 (CT-39) adopted the former appliance extensions: `providers.org.list`, `providers.org.login.start {provider, authMode, label}`, `providers.org.remove {credentialId}` (session ops) and REST `agents.setCredentialSource` (`{params: {burrow, agent}, body: {source}}` over a session); `providers.login.start` and `providers.org.login.start` are `secret` too (CT-44). Attempts live in memory and bind to the session's account (anyone else: “not found”); sign-in and sign-out are signed appliance audit events (`provider.signed_in`, `provider.signed_out`: provider, mode, account or organization credential id, verification, expiry — never a secret). | Contracts first; MA-09 receipts must not keep secrets. |
| PV-11 | **Integration ingress in managed mode** (the audit below): no plaintext customer content through cloud ingress; outbound or customer-side designs; exceptions gated with their explanation. Google connect stayed disabled (`managed.google_connect`): Google's device flow doesn't allow Gmail/Calendar scopes and the loopback redirect can't reach the appliance. **Superseded for Google on 2026-09-26** by assistant-guides.md AG-14 (runtime MR-62…MR-65): the customer's own client redirects to the hosted UI, which hands the code over the session to `connections.finishGoogle`. **Superseded for Feedback on 2026-09-27** by feedback-drop.md (FD-03, FD-25; runtime MR-67): reports are sealed in the visitor's browser to this appliance, control keeps only ciphertext until the appliance collects it. | Assignment §7. |
| PV-12 | **Sign-ins run in the runner** (approved 2026-09-25). `LocalSignInExecutor` (agent-runtime) is the one component that runs sign-in CLIs and touches credential homes. On a managed appliance (`WHOMBAT_SIGNIN_EXECUTOR=runner`, the managed default) it runs in the runner's `SignInWorker`, as the runner's user; the server keeps attempts, policy and audit and relays each step over the runner protocol (`POST /internal/runner/signin/poll` long poll, `/answer`, `/event`; contracts 0.5.1 `runnerApi.signin*`; on the sign-in unix socket `WHOMBAT_SIGNIN_SOCKET` whose owner the runner checks, else loopback — runtime MR-34; runner token; 45–90 s timeouts; a secret crosses only this loopback hop inside one request, never logged). Status rows, sign-in checks and GitHub tokens are read through it too, so the server needs no access to the credential root. `local` (development, tests, self-hosted) runs the same executor in the server. | One owner per credential file; least privilege. |
| PV-13 | **Contracts 0.5.0 adopted with the runtime's conformance items** (single Whombat writer): `enroll.claim` requires `claimId` (kept with the claim, migration `0029_claim_id`, class `expand`) and `/v1/runtime/claimed {claimId, claimedAt}`; claim secret normalization and hash from the contracts (CT-29); push refs are `PushRef` keyed hashes (`pushRefFor`, key = HKDF of `WHOMBAT_MASTER_KEY`, label `push-ref/1`); `GET /facts` validates as `RuntimeFacts` (CT-37); backup ops from the protocol allowlist (CT-30). | Orchestrator; CT-26…CT-37. |

## Eligibility as enforced (managed mode)

Rows: provider × auth mode. Columns: a person's own credential for PI / NA / OA, then an organization credential (always OA).
✅ runs · ✅* runs under its conditions (`permitted_candidate`) · ⏸ gated (refused, `managed.provider_gated`) · ⛔ excluded (refused, `managed.provider_excluded`).

| Provider · mode | PI | NA | OA (person) | org | Sign-in offered |
|---|---|---|---|---|---|
| Claude · `api_key` (the binary's `apiKeyHelper`) | ✅ | ✅ | ⛔ | ✅ | key entry |
| Claude · `cloud` (Bedrock/Google Cloud/Foundry) | ✅ | ✅ | ⛔ | ✅ | not built (`provider.login_unavailable`) |
| Claude · `subscription_sdk` | ⛔ | ⛔ | ⛔ | ⛔ | no (no Agent SDK, SUB-14) |
| Claude · `subscription_cli` (unmodified binary) | ✅ | ✅ | ⛔ | ⛔ | Claude Code's own sign-in in a console — console pending (`provider.login_unavailable`, SUB-14) |
| Codex · `api_key` | ✅ | ✅ | ⛔ | ✅ | key entry (`codex login --with-api-key`) |
| Codex · `chatgpt` (device code) | ✅ | ✅ | ⛔ | ⛔ | device code (`codex login --device-auth`) |
| Codex · `access_token` | ✅* | ✅* | ⛔ | ⛔ | token entry + creator attestation + expiry |
| GitHub · `device` / `token` | (not in the register) | | | | device flow / token entry |

Under PV-04 (MA-17) a person's credential reaches only PI and NA (their own requests and automations); a
colleague's request to an agent on it is OA and refused; team agents run on an organization credential (OA,
API keys only). This matches the register's wording; the subscription rows follow SUB-01 and SUB-04 (2026-09-26).

## Credential state signals (pinned versions)

| State | Claude Code 2.1.283 (stream-JSON) | Codex 0.157.0 | Configuration |
|---|---|---|---|
| `auth_revoked` | `assistant.error` `authentication_failed` (401 “Invalid API key”, a subscription's 401 “Not logged in · Please run /login”), `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `cloud_credential_error`; result `api_error_status` 401/403 | `unauthorized`; connection variants with `httpStatusCode` 401/403 | — |
| `auth_expired` | text “token … expired” (a subscription's 401 “OAuth token has expired”), “log in again” (403 “Your account does not have access to Claude. Please login again”) | text “could not be refreshed”, “refresh token expired” | access-token expiry passed |
| `quota_exhausted` | `billing_error` (400 “Credit balance is too low”); `api_error_status` 402 (`unknown`); a subscription's `rate_limit_event` `status: rejected` (usage limit) — until its `resetsAt` (SUB-16) | `usageLimitExceeded`; 402 | — |
| `outage` | `server_error` (500, and 529 overloaded in 2.1.283), `overloaded`; `api_error_status` ≥ 500 | `serverOverloaded`, `internalServerError`, `httpConnectionFailed`, `responseStreamConnectionFailed`, `responseTooManyFailedAttempts`; ≥ 500 | — |
| no change | `rate_limit` (a plain 429), `invalid_request`, `model_not_found`, `max_output_tokens`, `unknown` (400) | `rateLimitExceeded`, `contextWindowExceeded`, `sessionBudgetExceeded`, policy, `badRequest`, `sandboxError`, `other`, … | — |
| `not_signed_in` | `claude auth status --json`: `loggedIn: false` (sign-in status, SUB-13) | `codex login status`: “Not logged in” | no home / no record |
| `owner_departed`, `gated`, `version_drift` | — | — | membership, PV-02, PV-01 |

Every error code of the pinned versions is mapped (tests compare with the fixtures; the Claude fixture records each
failure as the pinned binary reported it against a fake Messages API, offline). The sandbox's outcome
classifier (MSB-14, text rules) still names the turn's outcome; these states are the credential's.

## Audit: OAuth callbacks, polling, webhooks, Feedback intake (managed mode)

- **Google connectors (OAuth redirect).** Self-hosted: redirect to `PUBLIC_URL/…/callback`; a managed appliance has no
  public URL (MR-04 answers the callback path 404). Device flow: Google allows only `openid email profile`,
  `drive.file`, `drive.appdata` and YouTube scopes (“supported only for the following scopes”), not Gmail or
  Calendar. Loopback (installed-app) redirect: lands on the browser's machine, not the appliance. **Decision:
  disabled** (`managed.google_connect`, runtime MR-05); **built 2026-09-26 as below** (AG-14, runtime MR-62…MR-65). Future design: the customer's own OAuth client,
  redirect to the hosted UI origin; the browser (not the cloud server) takes the code from the URL and sends it
  through the encrypted session; the appliance exchanges it with its PKCE verifier and the client secret it alone
  holds. Needs a response mode that keeps the code out of the hosted UI's server logs, a whombat-app route and
  contract ops; the cloud never sees a token and a leaked code is useless without the verifier.
- **GitHub polling.** Outbound from the appliance (conditional requests), no ingress: compatible. Its identity must
  change: the poller and PR API use the host's gh account (`GhCliGitHub`), which a managed appliance doesn't have.
  Per-user tokens exist now (PV-06, pushes use them); the poller should use the token of the owner who connected the
  burrow — **open** (GitHub connect in managed mode isn't wired yet).
- **Automation webhooks.** Inbound HTTP; no public listener → disabled (`managed.automation_webhooks`, schedules and
  Run now instead). A cloud relay receiving webhook bodies would be plaintext ingress → not built. Customer-side
  option: the customer's own system calls an outbound-connected client with an enrolled endpoint key (a session op
  `automations.trigger`), keeping sender authentication, replay prevention (request ids, MA-09) and rate limits —
  **not built**.
- **Whombat Feedback intake.** *(Superseded on 2026-09-27 by feedback-drop.md, FD-03 and FD-25; runtime MR-67: the
  report is encrypted in the visitor's browser to a key of the appliance, pinned by the snippet; control stores and
  forwards only ciphertext, the appliance pulls, decrypts and files it. Not plaintext, not quiet.)* ~~Public widget →
  appliance needs a public listener → disabled (`managed.feedback_intake`). Routing reports through the cloud would be
  plaintext customer content in cloud ingress → refused. Customer-side option: the customer's website backend (their
  server, their TLS) forwards reports over an enrolled endpoint session, with the widget's existing sender tokens,
  replay protection and rate limits — **not built**, documented as the only acceptable shape.~~

## Evidence rechecked 2026-09-25 (differences from the register, reported to the orchestrator; register not edited)

- **E-C1** (legal-and-compliance): 3P providers now named “Amazon Bedrock, Google Cloud's Agent Platform, Microsoft
  Foundry”; new/unquoted sentences: “Customers may not pay for, resell, or intermediate Claude usage on their end
  users' behalf”; “OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and
  Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic
  applications”; the provisioning sentence (“configuring an API key … for use by the customer's own authorized
  users — provided the resulting usage is billed to the key owner”) supports organization keys for OA; “Anthropic
  reserves the right to take measures to enforce these restrictions … without prior notice”; a Claude Code
  name/logo section.
- **E-C2** (Agent SDK overview): substance unchanged; branding list (“Claude Agent”, “{YourAgentName} Powered by
  Claude”; not “Claude Code”).
- **E-X1** (app-server): unchanged; transports now also list Unix sockets; refusal text “`<descriptor>` requires
  experimentalApi capability”. The 0.157.0 CLI help marks `app-server`, `generate-json-schema` `[experimental]`; the
  generated schema marks `account/login/start {type: chatgptAuthTokens}` “FOR OPENAI INTERNAL USE ONLY - DO NOT USE”.
- **E-X2** (auth): device code is now labelled “(beta)”; access tokens described as a ChatGPT **Enterprise** feature
  there (E-X3 says Business and Enterprise); `forced_login_method`: “If the active credentials don't match … Codex
  logs the user out and exits”; “Don't expose Codex execution in untrusted or public environments”; headless
  fallbacks include copying `auth.json` (Whombat doesn't offer that).
- **E-X3** (access tokens): tokens “act as agent identities”; `CODEX_ACCESS_TOKEN` env as an alternative to storing;
  an older dialog still offers “No expiration” (so expiry isn't guaranteed — PV-09 requires one); minimum 1 day;
  removing a member's Codex permission suspends their tokens; “don't reuse the Codex access token as the transport
  token”.
- Codex 0.157.0 was published 2026-09-25 (release age < 1 day at pinning).

## Contract gaps

0.5.0 adopted the `providers.*` ops, the `secret` flag, `agents.setCredentialOwner`,
`AgentRuntime.credentialOwnerAccountId` and `DispatchContext.credential`. Still open for 0.5.1: see
`docs/managed/provider-login.md` § Contract gaps.

## NixOS requirements (for the appliance workstream)

- **Users and ownership**: the runner's user (`whombat-runner`) owns `WHOMBAT_CREDENTIALS_ROOT`
  (`/persist/whombat/credentials`, mode 0700) and everything under it; the server (`whombat`) needs no access to it
  (PV-12). Per-task sandbox uids get only the run's own home, mounted by the sandbox (MSB-13). Set
  `WHOMBAT_CREDENTIALS_ROOT` for both units and `WHOMBAT_SIGNIN_EXECUTOR=runner` (default in managed mode).
- **Binaries**: pinned Codex (`WHOMBAT_CODEX_PATH`), gh (`WHOMBAT_GH_PATH`), the pinned Claude Code binary via nix-ld
  (`WHOMBAT_CLAUDE_PATH`), and `WHOMBAT_PROVIDER_PINS=claude=2.1.283,codex=0.157.0` in the runner's unit
  (`docs/managed/provider-bundles.md`).
- **AI clients (SUB-25, CT-73)**: set `WHOMBAT_CLIENTS_FILE` (e.g. `/run/whombat-clients/clients.json`) for both
  units — the server (`whombat`) writes it after every manager push, the runner (`whombat-runner`) reads it, so its
  directory must be writable by the server and readable by the runner. Bundle executables (e.g. under
  `/persist/whombat/clients`, `WHOMBAT_CLIENTS_ROOT` on the manager's side) must be readable by the runner and on the
  task sandbox's read-only paths (`WHOMBAT_SANDBOX_RO_PATHS`), and their paths plain segments (no dot folders; the
  contract refuses them). The runner runs a bundle only from inside `WHOMBAT_CLIENTS_ROOT` (runner unit; default
  `/persist/whombat/clients`, compared by realpath) and only when no directory from `/` down to the executable is owned
  by the server's user or writable by group or others (SUB-45): keep `/persist`, `/persist/whombat` root-owned 0755 and
  the clients tree owned by `whombat-manager`, 0755/0555.
- **Sign-in console (SUB-20)**: the runner's closure needs `node-pty` built for its Node (node-gyp in the derivation);
  Claude Code's login needs Anthropic's sign-in hosts (`claude.ai`, `*.claude.com`, `*.anthropic.com`) reachable from
  the runner.
- **Network**: the runner (sign-in executor) reaches `api.anthropic.com`, `api.openai.com`, `auth.openai.com`,
  `chatgpt.com`, `github.com`, `api.github.com` for sign-ins and free key checks; the server reaches
  `api.github.com` only through the runner's tokens (no host gh).
- **Backups**: credential homes are backup class `provider_sessions` (restore may need re-login).

## Open items

- Contracts 0.5.1: `AgentRuntime.credentialSource`, `DispatchContext.credential.source` + automation publisher, the
  `providers.org.*` and `agents.setCredentialSource` ops, the runner sign-in routes in `runnerApi`, org rows in
  `ProviderStatus` (`ownerAccountId: null` + `credentialId`).
- Claude `cloud` (3P) sign-in; the Claude subscription sign-in console (SUB-03, SUB-14; turns already run on a
  subscription home); the Commercial Terms acceptance (X-01, SUB-07).
- Unrun qualification: real remote-browser sign-in with real accounts (procedure in `docs/managed/provider-login.md`).
