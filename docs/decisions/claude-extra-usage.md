# Claude subscription routes and extra usage

Researched 2026-10-26 after John's Dusty conversation on Home failed. This records what the inspected sources and
runtime establish, not a promise about Anthropic's future billing or approval of an integration.

**Follow-up:** John subsequently requested a native Claude Code client through Fusebox. CDS-04 / AIG-D33 implement
that explicit gateway mode after live CLI and DirectSDK checks succeeded. The gateway API route below describes the
original failure, before that change; see [native Claude gateway](claude-native-gateway.md) for the current transport.

## What happened on Home

Home's status was healthy, with no failed units and ample memory. Its runner journal explicitly records
“through the AI gateway Fusebox · claude” and “hermes · on the AI gateway” for both attempts at 07:39 UTC. The server
received the same failure twice:

> HTTP 400: Third-party apps now draw from your extra usage, not your plan limits. Add more at
> claude.ai/settings/usage and keep going.

Hermes surrounded that with “custom rejected this request as malformed” and suggestions for `/new`, `/model` and
`hermes doctor`. Whombat did not recognize the more specific billing reason. This is different from the previous
day's Fusebox 429 saying every account for the model was rate limited until a named time (AIG-D31).

The evidence establishes the route and the rejection returned through it. It does not identify Anthropic's internal
classification signal, prove that every account in Fusebox would be rejected, establish the account's balance, or
demonstrate a successful direct subscription answer on Home today. No account credentials were inspected, routing
switches changed, paid extra usage enabled or real inference probes issued during this investigation.

## Three different integrations

| Route | What makes the model request | What the sources say about payment |
|---|---|---|
| Whombat's own Claude sign-in, gateway off | Hermes's experimental `claude-subscription-directsdk-experimental` plugin drives the unmodified official `claude` binary on the person's own sign-in. Hermes owns tools, memory, history and compaction. | Nous's plugin README reports subscription-backed tests and allowance metering comparable to `claude -p`. Entitlements and extra-usage settings remain the account's and service's. This is not a guarantee that every model/request is included or an Anthropic certification. |
| Hermes's built-in Anthropic OAuth provider | Hermes's Anthropic API client with OAuth credentials; distinct from DirectSDK. | Current Hermes provider documentation says its Max OAuth route needs purchased extra-usage credits and does not consume the base Max allowance. That paragraph describes the built-in provider, not the separate experimental plugin. |
| Whombat with “Send Claude Code through Fusebox” on | Hermes's named gateway provider calls Whombat's relay; the relay replaces the turn token with Whombat's Fusebox client key; Fusebox selects its upstream account. | A working gateway connection does not guarantee that Anthropic will admit a request against the selected account's included allowance. In the observed attempt Anthropic required extra usage. |

Whombat already ships DirectSDK plugin 0.3.3 from
[`NousResearch/hermes-official-plugins@54afaf5014db23346148436c4883eb64095e8060`](https://github.com/NousResearch/hermes-official-plugins/tree/54afaf5014db23346148436c4883eb64095e8060/claude-subscription-directsdk),
with pinned Hermes 0.22.5 (CDS-01, CDS-02). Its subscription provider keeps authentication with the official CLI and
rejects inherited custom Anthropic endpoint/API-key overrides. It is not a provider to chain through a Fusebox pool.
The current upstream README still describes the same subscription method; its latest inspected directory commit
was `20048e6e2c1c48d6023e73ae6951595f58352b20` (2026-10-24).

The code agrees with the distinction: `turn/prepare.ts` selects the gateway instead of resolving a local credential;
`hermes/own-loop.ts` selects an Anthropic Messages client pointed at `/ai-gateway/claude`; `gateway/relay.ts` forwards
the request and response to/from the configured gateway. `hermes/config.ts` selects DirectSDK for the subscription
route. Session route checks (`hermes/route.ts`) refuse to resume a session on a different provider, so an old direct
session does not override a newly enabled gateway.

## What the public guidance establishes

- [Nous's official DirectSDK plugin README](https://github.com/NousResearch/hermes-official-plugins/tree/main/claude-subscription-directsdk#readme)
  describes an **experimental** subscription provider, using the unmodified Claude Code binary as a request-scoped
  model client. Its “Subscription usage” section reports real Pro and Max metering tests. Its authentication section
  leaves entitlements and extra usage with the native account/service and says list-price estimates do not prove
  subscription charges. These are upstream's measurements, not tests repeated on John's account.
- [Hermes's provider guide](https://hermes-agent.nousresearch.com/docs/integrations/providers#subscription-plans-what-your-plan-pays-for)
  explicitly distinguishes successful OAuth sign-in from included usage: its built-in Anthropic Max OAuth path uses
  purchased extra credits rather than the base allowance. The page's “Anthropic (Native)” section covers that route.
- [Anthropic's Claude Code legal and compliance guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
  says OAuth is intended for ordinary Claude Code/native-app usage and directs third-party product integrations to
  API keys or supported cloud providers. The same page permits a person to sign into the unmodified Claude Code
  binary hosted by a platform under specified conditions. It does not certify DirectSDK or a token-pooling proxy.
  “Uses the official CLI” and “Anthropic approves this entire integration” are different claims.
- [The Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
  says third-party products may not offer claude.ai login or rate limits without prior approval. An SDK-compatible
  transport alone establishes neither approval nor an included-allowance entitlement.
- [Anthropic's usage-credit documentation](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)
  explains that credits are separate paid usage at API rates, with their own balance/spend controls; enabling them
  changes billing. It must be the person's choice, not an automatic fallback.
- [Hermes PR #82361](https://github.com/NousResearch/hermes-agent/pull/82361)
  independently reports the same HTTP 400 billing refusal being misclassified as `format_error`. It was **open and
  unmerged** when inspected. This corroborates the classification problem; it is not evidence that our pinned
  Hermes already contains a fix.

## Decision: report the actual refusal and preserve the chosen route

AIG-D32 fixes the user-facing explanation and pointless server retry with the existing contract; no wire-schema or
vendored-source change is needed. Paid extra usage has no ordinary reset time. The explanation says what Claude
returned for this request, rather than claiming a new universal policy or that a specific account's ordinary
allowance is exhausted. Raw upstream instructions remain technical detail, not instructions for a Whombat user.

The gateway switch continues to mean use the gateway (AIG-07, AIG-12). Do not bypass it on a rejection, substitute
another sign-in, change upstream identity/prompt fields to evade entitlement checks, or enable spending. Turning it
off selects the already implemented direct subscription route on the person's own Claude sign-in. That is the route
Nous designed for using Claude Code through Hermes, with its experimental and account-dependent limits; it is a
separate choice from keeping all Claude traffic in Fusebox.

Verification covers the exact refusal through the runner and a Postgres-backed chat thread: one attempt, a clear
message and matching short card reason, the route named, original detail preserved, no reset scheduled, old runner
classification corrected. Unit cases retain unrelated HTTP 400s, long-context refusals and timed pool limits.
