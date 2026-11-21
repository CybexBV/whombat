# Claude subscription DirectSDK

## CDS-01 — Hermes owns Claude subscription turns (2026-10-24)

John asked to fully replace the custom Claude runtime with Nous’s DirectSDK method while preserving onboarding and
authentication. This supersedes the whole-turn Claude runtime and its source patch in the Hermes engine decisions.
Codex, API-key, gateway and local-model transports retain their existing choices.

Bundle the official `claude-subscription-directsdk` plugin 0.3.3 from
`NousResearch/hermes-official-plugins@54afaf5014db23346148436c4883eb64095e8060`, with licence and file checksums,
inside the existing `hermes-whombat` distribution. It runs on pinned, unpatched Hermes 0.22.5. No plugin downloads occur
on the appliance. The upstream runtime files remain unmodified; a small provider subclass preserves Whombat’s native
CLI environment allowlist and executable selection, and TO-05’s omission of `browser_cdp`.

Claude Code is a request-scoped subscription model client. Hermes owns history, tool execution, Whombat’s policy and
approval hooks, computer and browser access, compaction, memory and skills. Compression uses the same subscription
provider/model; review uses the turn’s model. Telemetry is disabled. Feedback assessments do not learn and expose no
native tools. A bounded post-answer wait recognizes DirectSDK model clients rather than the removed native review
fork. Follow-ups and Stop use Hermes’s existing ACP lifecycle.

## CDS-02 — Preserve sign-in and profile data

Keep `claude auth login --claudeai`, staged private homes, status verification, activation and sign-out unchanged.
Pass the existing `CLAUDE_CONFIG_DIR` to DirectSDK. No OAuth extraction, copied credentials or new onboarding screen.
Existing Hermes profiles, history, memory and skills remain in place; DirectSDK replays Hermes’s persisted history
rather than depending on a native Claude session id. API-key and gateway turns never enable this provider.

## CDS-03 — Move saved Claude routes through Hermes

**Superseded by HN-07 (hermes-native.md)**: a session saved on `claude-cli` is neither resumed nor moved; the turn starts a new session with the window (HN-L08).

Hermes persists the provider with each session; rewriting config alone does not change it. When ACP resume reports
`claude-cli:<model>`, the runner uses ACP `session/set_model` to select DirectSDK and the turn’s model before its
prompt. Hermes owns the policy mutation; no direct session-database edits and no conversation reset. A failed
migration follows the existing failed-resume recovery rather than silently running a retired transport.

## CDS-04 — Claude Code through the chosen gateway (2026-10-26)

John explicitly asked to keep Fusebox routing his multiple Claude subscriptions and use DirectSDK as its client.
This supersedes CDS-02's exclusion of gateway turns from the bundled plugin. The personal subscription provider
remains unchanged; a distinct `whombat-claude-gateway` provider uses the same unmodified upstream DirectSDK client
with Claude Code's documented gateway environment. Hermes still owns history, tools, policy, compression and review.

The native child receives only the Whombat relay endpoint and its credential: the turn token outside a pod, the pod
forwarder's placeholder inside one. Its private temporary Claude home contains no personal sign-in. No Fusebox key
or subscription credential enters the sandbox; the relay still substitutes Whombat's Fusebox client key and Fusebox
chooses the upstream account. Missing configuration/token fails closed. No identity spoofing, account selection,
paid-usage enablement or billing-error suppression is added. Account entitlement remains the provider's decision.

The provider name differs from both the personal subscription route and the old API gateway route, so saved sessions
start on the new route with their existing conversation window. Every pod keeps the native gateway setting available
beside its other sessions, including their background reviews. Details: [native Claude gateway](claude-native-gateway.md).

## Verification (2026-10-24)

`pnpm check` and `pnpm test:server` pass. The Python suite drives the packaged provider on unpatched Hermes,
including real tool execution on the computer wrapper, persisted memory and denied calls; Nous’s core client tests
also pass. The ACP harness answers, resumes and migrates a saved `claude-cli` route using an offline native stand-in,
with the same session id. The Python wheel contains both entry points, the complete provider runtime and licence.

A live host subscription trial reached the native client but could not authenticate: its stored OAuth session is
expired. The ordinary host `claude -p` uses `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` from user settings; with
`--setting-sources ''` it reports the same expired OAuth session as DirectSDK. No credential contents were read or
copied, and that gateway configuration was not imported into subscription turns. A live subscription answer therefore
remains unverified on this host; existing valid Whombat sign-ins use their unchanged private config directories.
