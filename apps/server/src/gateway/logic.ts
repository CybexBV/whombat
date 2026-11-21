/**
 * The AI gateway's decisions, the pure part (docs/decisions/ai-gateway.md AIG-07, AIG-11, AIG-12, AIG-14): whether a
 * turn that should go through the gateway may start (and why not), whether the pool is used up for a tool, which
 * alerts the person is due, and when the gateway counts as unreachable. No I/O.
 */
import {
  GATEWAY_UNREACHABLE_ALERT_MS,
  GATEWAY_UNREACHABLE_FAILURES,
  type GatewayAccountUsage,
  type GatewayAlert,
  type GatewayKind,
  type GatewayProvider,
  type GatewayRefusalCode,
} from '@whombat/core';
import type { StoredGatewayFault } from '../db/schema/gateway';

/** What the poller last knew of a gateway's reachability. */
export interface Reachability {
  failures: number;
  failingSince: Date | null;
}

/** Unreachable = this many polls in a row failed (AIG-11). */
export function unreachable(r: Pick<Reachability, 'failures'> | null | undefined): boolean {
  return (r?.failures ?? 0) >= GATEWAY_UNREACHABLE_FAILURES;
}

/** A time that hasn't come yet (null: unknown, counts as not passed). */
function ahead(until: string | null, now: Date): boolean {
  return until === null || Date.parse(until) > now.getTime();
}

/**
 * Whether every enabled account of a tool's provider is used up (AIG-12), and the earliest `until` among them (null:
 * none said). Null when it isn't: no enabled account (Fusebox answers for itself then), or one has room. An API key out
 * of credit counts as used up, but its `until` is only when Fusebox tries it again, so it names no time.
 */
export function usedUpUntil(
  accounts: readonly Pick<GatewayAccountUsage, 'provider' | 'status' | 'until' | 'outOfCredit'>[],
  provider: GatewayProvider,
  now: Date,
): { until: string | null } | null {
  const enabled = accounts.filter((a) => a.provider === provider && a.status !== 'off');
  if (!enabled.length) return null;
  if (!enabled.every((a) => a.status === 'used_up' && ahead(a.until, now))) return null;
  const times = enabled
    .flatMap((a) => (a.until && !a.outOfCredit ? [Date.parse(a.until)] : []))
    .filter(Number.isFinite);
  return { until: times.length ? new Date(Math.min(...times)).toISOString() : null };
}

/** Why a gateway turn may not start (AIG-12), with the time it has room again for `gateway.used_up`. */
export interface GatewayRefusal {
  code: GatewayRefusalCode;
  until: string | null;
}

/**
 * The claim's check of a turn the switch sends through the gateway (AIG-12), in this order: the connection is gone or
 * has no usable key (`gateway.missing`), it doesn't answer (`gateway.unreachable`), every enabled account of the
 * provider is used up (`gateway.used_up`, a Fusebox only). Null: it may start.
 */
export function gatewayRefusal(input: {
  /** The connection exists and has a key to send (or needs none: an open Fusebox). */
  usable: boolean;
  kind: GatewayKind | null;
  usage: (Reachability & { accounts: readonly GatewayAccountUsage[] }) | null;
  provider: GatewayProvider;
  now: Date;
}): GatewayRefusal | null {
  if (!input.usable) return { code: 'gateway.missing', until: null };
  if (unreachable(input.usage)) return { code: 'gateway.unreachable', until: null };
  if (input.kind === 'fusebox' && input.usage) {
    const used = usedUpUntil(input.usage.accounts, input.provider, input.now);
    if (used) return { code: 'gateway.used_up', until: used.until };
  }
  return null;
}

/* The person's own sign-in when the gateway can't help ------------------------------------------------------------ */

/**
 * The sign-ins that are a subscription the person has anyway: Claude's own sign-in, ChatGPT's. Never an API key or a
 * cloud account, which cost money per turn: a turn only falls back onto what is already paid for.
 */
const SUBSCRIPTION_MODES: Readonly<Record<GatewayProvider, readonly string[]>> = {
  claude: ['subscription_cli', 'subscription_sdk'],
  codex: ['chatgpt', 'access_token'],
};

/** What the server knows of one of the person's own sign-ins (`CredentialMeta`'s part that matters here). */
export interface OwnSignIn {
  authMode: string;
  signal: { state: string; until: string | null } | null;
}

/**
 * Whether the person's own sign-in can take a turn the gateway can't: a subscription, not expired or revoked, and not
 * out of room (or down) until a time still ahead. A signal without a time doesn't stop it: only a turn that runs on the
 * sign-in clears one, and while the gateway is on, none would.
 */
export function usableOwnSignIn(
  provider: GatewayProvider,
  signIn: OwnSignIn | null | undefined,
  now: Date,
): boolean {
  if (!signIn || !SUBSCRIPTION_MODES[provider].includes(signIn.authMode)) return false;
  const signal = signIn.signal;
  if (!signal) return true;
  if (signal.state === 'auth_expired' || signal.state === 'auth_revoked') return false;
  return !(signal.until && Date.parse(signal.until) > now.getTime());
}

/**
 * Whether a turn the gateway can't take falls back to the person's own sign-in: when the gateway is gone or doesn't
 * answer. A pool that is used up refuses as before: the person's own accounts are usually in it.
 */
export function fallsBack(code: GatewayRefusalCode): boolean {
  return code === 'gateway.missing' || code === 'gateway.unreachable';
}

/**
 * Whose own sign-in takes a turn of `provider` the gateway can't: the same tool's first, then the other's; only a
 * provider the claiming runner runs. Null: none, the turn is refused.
 */
export function fallbackProvider(input: {
  provider: GatewayProvider;
  signIns: Partial<Record<GatewayProvider, OwnSignIn | null>>;
  claimable: readonly string[];
  now: Date;
}): GatewayProvider | null {
  const order: GatewayProvider[] = input.provider === 'claude' ? ['claude', 'codex'] : ['codex', 'claude'];
  return (
    order.find(
      (p) => input.claimable.includes(p) && usableOwnSignIn(p, input.signIns[p] ?? null, input.now),
    ) ?? null
  );
}

/** The person's own sign-ins that could take turns while the gateway doesn't answer (the alert names them). */
export function fallbackSignIns(
  signIns: Partial<Record<GatewayProvider, OwnSignIn | null>>,
  now: Date,
): GatewayProvider[] {
  return (['claude', 'codex'] as const).filter((p) => usableOwnSignIn(p, signIns[p] ?? null, now));
}

/* Alerts (AIG-14) ------------------------------------------------------------------------------------------------- */

/** One alert to the person (core's `GatewayAlert`, its words `gatewayAlertText`), times as ISO. */
export type GatewayAlertDue = GatewayAlert;

const UNREACHABLE_KEY = 'unreachable';
const isProvider = (p: string): p is GatewayProvider => p === 'claude' || p === 'codex';

/** A time to the minute, for alert keys: a fault's `until` that moves by seconds is the same fault. */
function minuteOf(until: string | null): string {
  if (!until) return '';
  const t = Date.parse(until);
  return Number.isFinite(t) ? new Date(Math.round(t / 60_000) * 60_000).toISOString() : '';
}

/** A fault whose line was quiet when it came: nothing was said about it, and nothing will be. */
const QUIET_SUFFIX = '|quiet';
const quietKey = (key: string) => `${key}${QUIET_SUFFIX}`;

/** Most alert keys a gateway keeps (open faults; a handful). */
export const GATEWAY_ALERT_KEYS_MAX = 128;

/**
 * The alerts a poll is due (AIG-14), once per fault and `until`, and the keys to keep:
 * - Fusebox's `provider:<p>` fault while that tool's switch is on: no room left until …; when it is gone after an
 *   alert, the room is back;
 * - a `signin` fault of an account of a switched-on tool: its sign-in in Fusebox expired (once while it lasts);
 * - unreachable for 5 minutes while a switch is on; when it answers again after that alert, it is back.
 * `labelOf` names an account by Fusebox's id (its email: alerts go to the person only).
 * `quiet` says whether its line on Fusebox's page is ignored, snoozed or not watched (quiet-notices.md QN-S19): then
 * nothing is said, now or when it is over, and the fault counts as said (`|quiet`), so no message comes later either.
 */
export function dueGatewayAlerts(input: {
  switches: { claude: boolean; codex: boolean };
  faults: readonly StoredGatewayFault[];
  labelOf: (accountId: string) => string | null;
  reachability: Reachability;
  sent: readonly string[];
  now: Date;
  /** The fault's line on Fusebox's page (`fusebox.used_up` of the tool, `fusebox.signin` of the account) is quiet. */
  quiet?: (fault: Pick<StoredGatewayFault, 'kind' | 'provider' | 'accountId'>) => boolean;
  /** The person's own sign-ins that take the turns while it doesn't answer (`fallbackSignIns`). */
  fallback?: readonly GatewayProvider[];
}): { alerts: GatewayAlertDue[]; keys: string[] } {
  const { switches, now } = input;
  const sent = new Set(input.sent);
  const keep = new Set<string>();
  const alerts: GatewayAlertDue[] = [];
  const down = unreachable(input.reachability);
  // While it doesn't answer, the faults are as last read: nothing new is said and nothing is over.
  if (down) {
    for (const k of sent) if (k !== UNREACHABLE_KEY) keep.add(k);
  } else {
    const open = new Set<string>();
    for (const f of input.faults) {
      if (!isProvider(f.provider)) continue;
      if (f.kind === 'provider') {
        const key = `${f.key}|${minuteOf(f.until)}`;
        open.add(key);
        if (sent.has(key)) keep.add(key);
        else if (sent.has(quietKey(key)) || input.quiet?.(f)) keep.add(quietKey(key));
        else if (switches[f.provider]) {
          alerts.push({ kind: 'used_up', provider: f.provider, until: f.until });
          keep.add(key);
        }
      } else if (f.kind === 'signin' && f.accountId) {
        const key = `${f.key}|`;
        open.add(key);
        if (sent.has(key)) keep.add(key);
        else if (sent.has(quietKey(key)) || input.quiet?.(f)) keep.add(quietKey(key));
        else if (switches[f.provider]) {
          alerts.push({
            kind: 'signin_expired',
            provider: f.provider,
            account: input.labelOf(f.accountId) ?? 'an account',
          });
          keep.add(key);
        }
      }
    }
    // A provider alert that is over: its room is back (once per provider, whatever `until` it had).
    const back = new Set<GatewayProvider>();
    for (const k of sent) {
      if (open.has(k) || !k.startsWith('provider:') || k.endsWith(QUIET_SUFFIX)) continue;
      const provider = k.slice('provider:'.length).split('|')[0] ?? '';
      if (!isProvider(provider)) continue;
      const stillOut = [...open].some((o) => o.startsWith(`provider:${provider}|`));
      if (!stillOut) back.add(provider);
    }
    for (const provider of back) alerts.push({ kind: 'back', provider });
  }
  const providers = (['claude', 'codex'] as const).filter((p) => switches[p]);
  const since = input.reachability.failingSince;
  if (down && since && now.getTime() - since.getTime() >= GATEWAY_UNREACHABLE_ALERT_MS && providers.length) {
    if (!sent.has(UNREACHABLE_KEY))
      alerts.push({
        kind: 'unreachable',
        providers,
        ...(input.fallback ? { fallback: [...input.fallback] } : {}),
      });
    keep.add(UNREACHABLE_KEY);
  } else if (down && sent.has(UNREACHABLE_KEY)) keep.add(UNREACHABLE_KEY);
  else if (!down && sent.has(UNREACHABLE_KEY)) alerts.push({ kind: 'reachable' });
  return { alerts, keys: [...keep].slice(-GATEWAY_ALERT_KEYS_MAX) };
}
