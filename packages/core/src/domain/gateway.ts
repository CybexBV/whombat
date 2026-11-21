/**
 * The AI gateway (0.76, CT-332; Whombat docs/decisions/ai-gateway.md AIG-01…AIG-20): Claude Code and ChatGPT turns
 * sent through a gateway the burrow connected — Fusebox (a pool of Claude and ChatGPT subscriptions with a management
 * API) or any LiteLLM-style gateway. One gateway connection per burrow (AIG-01), a switch per tool on the burrow
 * (AIG-05), the pool's usage as Settings → AI → Usage shows it (AIG-13), and the codes a turn that can't go through is
 * refused with (AIG-12). The words are in `@whombat/core/text` (`text/gateway.ts`).
 */
import { z } from 'zod';
import { ConnectionId } from '../ids.js';
import { Timestamp } from './common.js';
import { USAGE_ERROR_MAX, USAGE_PLAN_MAX, USAGE_WINDOWS_MAX, UsageWindow } from './usage.js';

/** The two gateway entries of the connections catalog (AIG-01): Fusebox, and any other AI gateway. */
export const GATEWAY_KINDS = ['fusebox', 'ai_gateway'] as const;
export const GatewayKind = z.enum(GATEWAY_KINDS);
export type GatewayKind = z.infer<typeof GatewayKind>;

/** What a gateway carries, by provider: Claude Code (`claude`) and ChatGPT (`codex`, CT-1452) turns. */
export const GATEWAY_PROVIDERS = ['claude', 'codex'] as const;
export const GatewayProvider = z.enum(GATEWAY_PROVIDERS);
export type GatewayProvider = z.infer<typeof GatewayProvider>;

/** A gateway's name as people read it: its connection's label (“Fusebox”; at most `CONNECTION_LABEL_MAX`). */
export const GatewayName = z.string().trim().min(1).max(80);

/** Which tools go through the gateway (AIG-05): off at connect. */
export const AiGatewaySwitches = z.object({ claude: z.boolean(), codex: z.boolean() });
export type AiGatewaySwitches = z.infer<typeof AiGatewaySwitches>;

/**
 * `Burrow.aiGateway` (AIG-05, AIG-20): the burrow's gateway connection — its id, its name (the connection's label) and
 * kind — and the switches “Send Claude Code through Fusebox” and “Send ChatGPT through Fusebox”. While a switch is on,
 * every turn of an agent on that tool goes through the gateway, whoever asks, and the agent's own sign-in isn't used
 * (AIG-07). Owners switch them with `burrows.setAiGateway`; removing the connection clears it.
 */
export const BurrowAiGateway = AiGatewaySwitches.extend({
  connectionId: ConnectionId,
  name: GatewayName,
  kind: GatewayKind,
});
export type BurrowAiGateway = z.infer<typeof BurrowAiGateway>;

/**
 * The burrow's gateway when its switch for this provider is on, else null (no gateway, the switch off, or a provider
 * no gateway carries: `local`). What “Runs on Fusebox” (AIG-17) and a turn's route (AIG-07) follow.
 */
export function aiGatewayFor(
  burrow: { aiGateway?: BurrowAiGateway | null } | null | undefined,
  provider: string,
): BurrowAiGateway | null {
  const gateway = burrow?.aiGateway ?? null;
  if (!gateway) return null;
  if (provider === 'claude') return gateway.claude ? gateway : null;
  if (provider === 'codex') return gateway.codex ? gateway : null;
  return null;
}

/** The tools switched on, Claude Code first (AIG-14's “the tools switched on”). */
export function aiGatewayProviders(switches: AiGatewaySwitches | null | undefined): GatewayProvider[] {
  return switches ? GATEWAY_PROVIDERS.filter((p) => switches[p]) : [];
}

/** Whether any tool goes through the gateway. */
export function aiGatewayOn(switches: AiGatewaySwitches | null | undefined): boolean {
  return aiGatewayProviders(switches).length > 0;
}

/* Fusebox's client key (AIG-02, AIG-03) ------------------------------------------------------------------------- */

/** The prefix of the client key Whombat makes for itself in Fusebox: `wbgw_` + 32 random bytes, base64url. */
export const GATEWAY_CLIENT_KEY_PREFIX = 'wbgw_';
/** The longest named-client id Whombat writes into Fusebox's config. */
export const GATEWAY_CLIENT_ID_MAX = 40;

/** The id of Whombat's named client in Fusebox (AIG-02): `whombat-<burrow slug>`, `[a-z0-9-]`, at most 40. */
export function gatewayClientId(burrowSlug: string): string {
  const slug = burrowSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '');
  return `whombat-${slug}`.slice(0, GATEWAY_CLIENT_ID_MAX).replace(/-+$/, '');
}

/** The label of Whombat's named client in Fusebox (AIG-02): “Whombat · Lumio BV”. */
export function gatewayClientLabel(burrowName: string): string {
  return `Whombat · ${burrowName.trim()}`;
}

/* The relay (AIG-08, AIG-09) ------------------------------------------------------------------------------------ */

/**
 * Where a gateway turn's CLI sends its requests (AIG-08): `<server or bridge origin>/ai-gateway/<provider>`. Not under
 * `/internal/`, and served on the appliance's loopback listener too.
 */
export const AI_GATEWAY_RELAY_PREFIX = '/ai-gateway';

/**
 * The relay's base path for a provider: `/ai-gateway/claude`. ChatGPT's Responses base adds `/v1` (AIG-10): Hermes's
 * own loop calls it as an OpenAI-compatible endpoint.
 */
export function aiGatewayRelayPath(provider: GatewayProvider): string {
  return `${AI_GATEWAY_RELAY_PREFIX}/${provider}`;
}

/**
 * The paths under a provider's relay base the relay forwards (AIG-09); any other answers 404, and one ending in
 * `api/hello` (Claude Code's reachability ping) answers 200 without reaching the gateway.
 */
export const AI_GATEWAY_RELAY_PATHS: Readonly<Record<GatewayProvider, readonly string[]>> = {
  claude: ['v1/messages', 'v1/messages/count_tokens', 'v1/models'],
  codex: ['v1/responses', 'v1/responses/compact', 'v1/models'],
};

/**
 * What the relay does with a path below a provider's base (`v1/messages?beta=true`, `/v1/models`): `forward` it to the
 * gateway, answer `hello` itself, or `refuse` it (404).
 */
export function aiGatewayRelayRoute(provider: GatewayProvider, path: string): 'forward' | 'hello' | 'refuse' {
  const p = (path.split('?')[0] ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (p.endsWith('api/hello')) return 'hello';
  return AI_GATEWAY_RELAY_PATHS[provider].includes(p) ? 'forward' : 'refuse';
}

/* Watching the gateway (AIG-11, AIG-14) ------------------------------------------------------------------------- */

/** The server reads the gateway this often. */
export const GATEWAY_POLL_MS = 60_000;
/** Each call of a poll waits at most this long. */
export const GATEWAY_CALL_TIMEOUT_MS = 10_000;
/** The gateway is unreachable after this many polls in a row failed. */
export const GATEWAY_UNREACHABLE_FAILURES = 2;
/** Owners hear that it is unreachable once it has been for this long while a switch is on. */
export const GATEWAY_UNREACHABLE_ALERT_MS = 5 * 60_000;

/* The pool's usage (AIG-11, AIG-13) ----------------------------------------------------------------------------- */

/**
 * One account of the pool as Fusebox reports it (AIG-11): `ok`; `used_up` (a limit is reached until `until`);
 * `rate_limited` (busy until `until`); `signin_expired` (its sign-in in Fusebox needs renewing); `off` (disabled in
 * Fusebox). Clients show an unknown status as `ok` without a line (tolerant decoding).
 */
export const GATEWAY_ACCOUNT_STATUSES = ['ok', 'used_up', 'rate_limited', 'signin_expired', 'off'] as const;
export const GatewayAccountStatus = z.enum(GATEWAY_ACCOUNT_STATUSES);
export type GatewayAccountStatus = z.infer<typeof GatewayAccountStatus>;

/** Most accounts in one pool. */
export const GATEWAY_ACCOUNTS_MAX = 64;

/**
 * One Claude or ChatGPT account of a Fusebox pool (AIG-13, AIG-20). `key` is stable (a hash of Fusebox's id, never
 * the id); `label` is the account's email for owners and admins and “Claude account 1” / “ChatGPT account 2” for
 * members (`gatewayAccountLabel`); `windows` are the same meters as a person's subscription (`UsageWindow`).
 */
export const GatewayAccountUsage = z.object({
  key: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  provider: GatewayProvider,
  /** The plan's stable identifier (`max_20x`, `pro`); its weight in the pool. */
  plan: z.string().max(USAGE_PLAN_MAX).nullable(),
  /**
   * The plan as people read it now (“Ultra”, “Max”, “Plus”): the provider's own name when Fusebox gives it, since a
   * plan can be renamed while its identifier stays. Absent from older runtimes; then the identifier in words.
   */
  planName: z.string().min(1).max(USAGE_PLAN_MAX).optional(),
  /**
   * The provider confirmed this account has no 5-hour limit (verified Claude Ultra, ChatGPT Pro): it has no 5-hour
   * meter, and it takes what its tool's other subscriptions can't. Absent means it has one, or nobody said.
   */
  noFiveHourLimit: z.boolean().optional(),
  /**
   * Fusebox has paused every model of it, used up or busy, so it takes no request now. A pause of one model alone
   * leaves it out, though `status` then says used up or busy too. Absent means not paused, or nobody said.
   */
  paused: z.boolean().optional(),
  /**
   * An API key whose prepaid credit ran out: `status` is `used_up` and `until` is only when Fusebox tries it again,
   * which brings no room unless someone added credit. Absent means not, or nobody said.
   */
  outOfCredit: z.boolean().optional(),
  status: GatewayAccountStatus,
  /** Until when it is used up or busy; null when unknown or for other statuses. */
  until: Timestamp.nullable(),
  windows: z.array(UsageWindow).max(USAGE_WINDOWS_MAX),
});
export type GatewayAccountUsage = z.infer<typeof GatewayAccountUsage>;

/**
 * The burrow's gateway as Settings → AI → Usage shows it (AIG-13, AIG-20), to everyone in the burrow: its connection,
 * name and kind, the switches, whether it answers (`reachable`: false after `GATEWAY_UNREACHABLE_FAILURES` failed
 * polls), when it was last read and what went wrong, and a Fusebox's accounts (always empty for the generic kind, which
 * has no pool).
 */
export const GatewayPool = AiGatewaySwitches.extend({
  connectionId: ConnectionId,
  name: GatewayName,
  kind: GatewayKind,
  reachable: z.boolean(),
  observedAt: Timestamp.nullable(),
  error: z.string().max(USAGE_ERROR_MAX).nullable(),
  accounts: z.array(GatewayAccountUsage).max(GATEWAY_ACCOUNTS_MAX),
});
export type GatewayPool = z.infer<typeof GatewayPool>;

/** The pool's accounts in the order people read them: Claude, then ChatGPT; each in the order Fusebox lists them. */
export function sortGatewayAccounts<A extends Pick<GatewayAccountUsage, 'provider'>>(
  accounts: readonly A[],
): A[] {
  return [...accounts].sort(
    (a, b) => GATEWAY_PROVIDERS.indexOf(a.provider) - GATEWAY_PROVIDERS.indexOf(b.provider),
  );
}

/* Refusals (AIG-12) --------------------------------------------------------------------------------------------- */

/**
 * Why a gateway turn didn't start (AIG-12): the connection is gone or has no usable key (`gateway.missing`), it
 * doesn't answer (`gateway.unreachable`), or every enabled account of the tool's provider is used up
 * (`gateway.used_up`). Posted like the other refusals that end a dispatch before it runs. A gateway that is missing or
 * doesn't answer refuses only when none of the person's own Claude or ChatGPT subscriptions can take the turn
 * instead. The words: `gatewayRefusalText`.
 */
export const GATEWAY_REFUSAL_CODES = ['gateway.missing', 'gateway.unreachable', 'gateway.used_up'] as const;
export const GatewayRefusalCode = z.enum(GATEWAY_REFUSAL_CODES);
export type GatewayRefusalCode = z.infer<typeof GatewayRefusalCode>;
