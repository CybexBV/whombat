# Native Claude Code through the AI gateway

## Request and evidence (2026-10-26)

John uses Fusebox to route several Claude subscriptions and asked whether DirectSDK could use it correctly. The
original failure and billing research are in [Claude subscription routes](claude-extra-usage.md). That investigation
described the old gateway transport: Hermes's Anthropic API client. It did not establish that the native CLI could
not work through Fusebox.

[Fusebox's documented Claude Code setup](https://github.com/DigitalPals/Fusebox#connect-your-tools) uses
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. The pinned DirectSDK implementation accepts an explicitly supplied
client environment and sends the official CLI through its request-scoped admission relay to that endpoint. Its
ordinary inherited-environment guard protects the personal OAuth provider; it is not a protocol impossibility.

Two small live checks against the existing host-configured Fusebox succeeded with Opus 5.5: the official CLI answered
“OK”, and the pinned DirectSDK client using the same endpoint answered “OK”. DirectSDK used an empty temporary Claude
home, so it could not fall back to a local subscription sign-in. No keys were printed, gateway settings changed, paid
usage enabled or subscription credentials extracted. The native cost estimate is API list-price equivalent; these
answers alone do not establish invoice treatment or meter movement for every pooled account.

The implemented `WhombatClaudeGatewayProfile` was then tested with the appliance's pinned Claude Code **2.1.302**,
through an isolated loopback relay fixture that authenticated the probe turn and substituted the existing Fusebox
client key. The response was HTTP 200 / “OK”; the request carried the real 2.1.302 CLI user agent, and Fusebox returned
its answering-account header. No account label or credential was printed. This checks the actual provider factory,
native client, relay path and Fusebox account selection, rather than only DirectSDK's low-level client constructor.
The fixture and native config homes were stopped/removed at the end of the probe.

## Decision (CDS-04, AIG-D33)

Use the bundled DirectSDK client for Claude gateway turns under a separate provider, `whombat-claude-gateway`. Keep
the person's `claude-subscription-directsdk-experimental` provider separate and keep the upstream vendor files pinned
and unchanged. The gateway mode is explicitly configured in the existing plugin's settings; it never adopts
inherited Anthropic keys/endpoints or probes a personal sign-in for model discovery or usage.

The path is Hermes → DirectSDK → official Claude Code → DirectSDK admission → Whombat's forwarder/relay → Fusebox.
Whombat authorizes each turn and substitutes its gateway client key exactly as before. Fusebox owns account choice,
session affinity, quota balancing and account rotation. No subscription tokens move into Whombat or Claude Code.
Codex gateway turns and ordinary API-key/local-model turns keep their existing clients.

Only a loopback Whombat relay URL with the Claude gateway path is accepted. Outside a pod the native client receives
the active turn token as `ANTHROPIC_AUTH_TOKEN`; in a pod it receives `whombat-pod`, which the pod forwarder replaces
for the active turn. The child gets a private temporary config directory with no login, and no MCP/Vault credentials
other than that relay credential. Commands continue to have provider credentials stripped. A gateway failure inside a turn isn't moved onto a personal login there; the server's claim moves the turn's retry and the next turns onto the person's own subscription (superseded in part by ai-gateway.md AIG-22). Existing AIG-D32 billing guidance remains valid if Anthropic rejects this route too.

The native gateway has a distinct session provider name, forcing a fresh Hermes session with the conversation window
when switching from the old API transport or the personal subscription. A pod always defines the gateway plugin's
non-secret relay settings, so an older session's background review still uses its selected route after another
session changes the pod's default provider.

Technical compatibility does not change the account owner's gateway opt-in or Anthropic's terms. The implementation
does not imitate native identity in an API client, rewrite billing classifications or add ways around entitlement
checks; it uses the real, unmodified Claude Code executable and leaves upstream refusals intact.
