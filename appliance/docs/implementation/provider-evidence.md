# Provider-mode evidence register

Eligibility by **provider × authentication mode × workflow**. Workflows: **PI** personal interactive (a person
asks their own agent and watches), **NA** named-owner automation (schedules/automations that run as one named
person's credential while they're away), **OA** organization automation (work on behalf of several people or
the org). Classification values: `permitted` (documented), `gated` (technically implemented but disabled in
managed mode until the named external confirmation exists), `excluded` (documented as not permitted).
Technical login success and billing behavior never establish commercial permission. This register is not
legal advice; qualified review is required before commercial launch (release checklist).

Evidence fetched 2026-09-25 by the orchestrator (pages show no last-updated date unless noted).

## Sources and verbatim evidence

- **E-C1** https://code.claude.com/docs/en/legal-and-compliance — “preinstalling or running Claude Code in your
  products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our
  Commercial Terms of Service and complying with the conditions below: The Claude Code binary must not be
  modified … customers may not remove, disable, or restrict any authentication method built into it … Each end
  user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference
  provider credential … billed directly to the end user”. Also: “Developers building products or services that
  interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication
  … Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to
  route requests through Free, Pro, or Max plan credentials on behalf of their users … developers may not
  collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must
  complete through Anthropic's own flow.” and “Nor does it prevent an end user from signing in to the unmodified
  Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code”.
  “Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.”
- **E-C2** https://code.claude.com/docs/en/agent-sdk/overview — “Unless previously approved, Anthropic does not
  allow third party developers to offer claude.ai login or rate limits for their products, including agents
  built on the Claude Agent SDK. Use the API key authentication methods …”. SDK use is governed by the
  Commercial Terms. Branding: not “Claude Code”; “Powered by Claude” allowed.
- **E-X1** https://learn.chatgpt.com/docs/app-server — “The app-server command and WebSocket transport are
  experimental and aren't supported for production workloads.” stdio (JSONL) is the default transport;
  generated schemas are “specific to the Codex version you ran”; experimental methods require
  `capabilities.experimentalApi`.
- **E-X2** https://learn.chatgpt.com/docs/auth — ChatGPT sign-in and API key; device code
  (`codex login --device-auth`) “recommended option when you're remote or headless, or when the localhost
  callback is blocked”, must be enabled in ChatGPT security settings / workspace permissions; credentials in
  `CODEX_HOME/auth.json` (or keyring/ephemeral); “API keys are still the recommended default for automation”;
  access tokens `codex login --with-access-token` for “trusted scripts, schedulers, and private CI runners”.
  No explicit statement on ChatGPT plans inside third-party products.
- **E-X3** https://learn.chatgpt.com/docs/enterprise/access-tokens — Business/Enterprise workspaces;
  “Each token belongs to its creator”; owner enables creation; scoped tokens must expire (7–90 days); “Use access
  tokens only on trusted runners”; “Avoid sharing one person's token across teams.”

## Register

| Provider | Auth mode | PI | NA | OA | Notes / open classification |
|---|---|---|---|---|---|
| Claude | End user's own **API key** (Console), via Agent SDK or unmodified CLI | permitted (E-C1, E-C2) | permitted if the key owner is the run's named owner (E-C1 “billed to the key owner”) | permitted only with an org-owned key whose owner is the org (not a person's key) | Whombat must accept Commercial Terms (external gate, product owner). |
| Claude | 3P (Bedrock / Vertex / Foundry) customer credential | permitted (E-C1) | permitted, same rule | permitted with org credential | Adapter configuration only; not built in this slice. |
| Claude | **Subscription OAuth** via the **Agent SDK** (current `ClaudeProvider`) | **excluded** (E-C2 unless previously approved) | excluded | excluded | Managed mode refuses SDK + subscription auth; self-hosted legacy mode unchanged (the operator runs it for themselves). |
| Claude | Subscription OAuth, user signs in to the **unmodified hosted Claude Code binary** through Anthropic's own flow | **permitted** (E-C1 “Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code”) | **permitted** for the subscriber's own automations | excluded — routing plan credentials on behalf of others (E-C1); team agents use subscriptions per requester | Decided 2026-09-26 (Whombat `docs/decisions/provider-subscriptions.md` SUB-01…07): run the binary directly (`-p`), never the Agent SDK, on a subscription; sign-in in the CLI's own console; Whombat never reads the credential files. Remaining: Commercial Terms acceptance (X-01). |
| Codex | End user's own **API key** | permitted (E-X2) | permitted (E-X2 “recommended default for automation”) | permitted with an org key | Billing to key owner. |
| Codex | **ChatGPT sign-in** (device code) by the named person | **permitted** (E-X2: ChatGPT sign-in “for subscription access”, device code for remote/headless) | **permitted** for the person's own automations | excluded (sharing one person's credential); team agents use subscriptions per requester | Decided 2026-09-26 (SUB-01, SUB-03, SUB-04). X-02 resolved. |
| Codex | **Access token** (Business/Enterprise), created by the named person | permitted-candidate (E-X3 “trusted app-server automation”) | permitted-candidate: token belongs to its creator; appliance must be a “trusted runner” | excluded unless a service-account token (separate doc, not reviewed) | Expiry required → token-expiry state in UI. |
| Codex | app-server over **stdio** | — | — | — | Transport choice; E-X1 says the app-server **command** is experimental/unsupported for production. Choosing stdio gives no support guarantee; pin version + protocol fixtures; never expose it as Whombat's API. |
| any | Whombat-owned pooled credential / central proxy / token extraction | excluded | excluded | excluded | Assignment §1/§8. |

## Consequences implemented in managed mode (target; see requirements R-39…R-42)
- Every run records its credential owner (person + provider + auth mode). No silent reassignment, no paid
  fallback. Distinct states: owner departed, quota exhausted, auth revoked/expired, provider outage.
- Modes marked `gated` are implemented as adapters and tested with synthetic fixtures but disabled by the
  managed-mode eligibility policy until the confirmation is recorded here.

## Updates 2026-09-25 (W3-PV evidence recheck, see Whombat `docs/decisions/managed-providers.md` PV-01…PV-12)
- Codex device code is now labelled "(beta)"; the auth page says access tokens are Enterprise-only while the
  access-tokens page says Business and Enterprise (inconsistent — treat as Business/Enterprise with confirmation).
- An older access-token dialog still offers "No expiration": Whombat requires an explicit expiry ≤ 90 days.
- Codex `forced_login_method` now "logs the user out and exits" on mismatch; the app-server `chatgptAuthTokens`
  login is "FOR OPENAI INTERNAL USE ONLY" → not used.
- Claude legal page adds "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf"
  and a sentence supporting customer-provisioned keys for their own authorized users (→ org credentials for OA).
- Claude subscription via the CLI is **not offered**: its sign-in ends with a code typed back into the terminal, which
  from a remote browser would pass through Whombat (credential intermediation). Classification stays gated.
- MA-17: personal credentials never serve other people's requests (OA with personal credential = excluded).
