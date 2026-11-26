/**
 * Fusebox, the pure part (docs/decisions/ai-gateway.md AIG-02, AIG-03, AIG-11): what its management API answers, read
 * defensively — the accounts of `GET /api/accounts` mapped to `GatewayAccountUsage`, the faults of `GET /api/faults`
 * and `GET /api/faults/dismissed`, and the `named-clients` list of `GET /api/config/settings` with Whombat's own client
 * put in or taken out (every other entry untouched). No I/O.
 *
 * The settings' values hold every client key of that Fusebox: nothing here logs or keeps them, and the list goes back
 * to Fusebox exactly as it was read but for Whombat's entry.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  GATEWAY_ACCOUNTS_MAX,
  GATEWAY_CLIENT_KEY_PREFIX,
  type GatewayAccountStatus,
  type GatewayAccountUsage,
  type GatewayProvider,
  gatewayAccountLabel,
  sortGatewayAccounts,
  sortUsageWindows,
  USAGE_PLAN_MAX,
  USAGE_WINDOW_LABELS,
  USAGE_WINDOWS_MAX,
  type UsageWindow,
  type UsageWindowKind,
  usagePct,
  usageStatus,
} from '@whombat/core';
import type { StoredGatewayFault } from '../db/schema/gateway';
import { normalizeWindow } from '../usage/logic';

/* Accounts and faults (AIG-11) ------------------------------------------------------------------------------------ */

const PROVIDERS: readonly GatewayProvider[] = ['claude', 'codex'];

/** Fusebox's window names → the usage meters' kinds (AIG-11); any other is `other` under Fusebox's own name. */
const WINDOW_KINDS: Readonly<Record<string, UsageWindowKind>> = {
  '5h': 'five_hour',
  week: 'seven_day',
  'week opus': 'seven_day_opus',
  'week sonnet': 'seven_day_sonnet',
};

/**
 * A model's own week that isn't one of the kinds above (`week fable`): Fusebox 0.15+ keeps Claude's Fable week whenever
 * the account has one, also while another limit binds. Named like the same window read from a person's own sign-in.
 */
const MODEL_WEEK = /^week ([a-z][a-z0-9 .-]{0,38})$/i;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** An ISO timestamp of a Fusebox time (RFC 3339), or null. */
function timeOf(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** One of Fusebox's quota windows as a usage window, or null (unreadable, or its reset has passed). */
export function fuseboxWindow(raw: unknown, now: Date): UsageWindow | null {
  const w = obj(raw);
  const name = str(w?.name);
  if (!w || !name) return null;
  const used = typeof w.used === 'number' ? usagePct(w.used) : null;
  const resetsAt = timeOf(w.resets_at);
  // A window whose reset has passed is over: Fusebox keeps the old share until it reads the next.
  if (resetsAt && Date.parse(resetsAt) <= now.getTime()) return null;
  const kind = WINDOW_KINDS[name.toLowerCase()] ?? 'other';
  const model = kind === 'other' ? MODEL_WEEK.exec(name)?.[1] : undefined;
  return normalizeWindow({
    kind,
    label: model
      ? `${model[0]?.toUpperCase()}${model.slice(1)} 7-day`
      : kind === 'other'
        ? name.slice(0, 80)
        : USAGE_WINDOW_LABELS[kind],
    usedPct: used,
    resetsAt,
    status: usageStatus(used),
    ...(model ? { windowMinutes: 10_080 } : {}),
  });
}

/** Fusebox's faults (`GET /api/faults`) as the poller keeps them; anything unreadable is skipped. */
export function parseFuseboxFaults(body: unknown): StoredGatewayFault[] {
  if (!Array.isArray(body)) return [];
  const out: StoredGatewayFault[] = [];
  for (const raw of body.slice(0, 500)) {
    const f = obj(raw);
    const key = str(f?.key);
    const kind = str(f?.kind);
    if (!f || !key || !kind) continue;
    out.push({
      key: key.slice(0, 300),
      kind: kind.slice(0, 40),
      provider: (str(f.provider) ?? '').slice(0, 80),
      accountId: str(f.account_id)?.slice(0, 300) ?? null,
      until: timeOf(f.until),
    });
  }
  return out;
}

/**
 * Fusebox's faults from several reads, once each by key, in the order read: `GET /api/faults` and the ones someone
 * dismissed in its dashboard (`GET /api/faults/dismissed`). Dismissing only hides a fault from Fusebox's own lists; the
 * account is still signed out or used up, so the statuses, the pools and the “room is back” message still count it.
 */
export function mergeFaults(...lists: readonly (readonly StoredGatewayFault[])[]): StoredGatewayFault[] {
  const out = new Map<string, StoredGatewayFault>();
  for (const list of lists) for (const f of list) if (!out.has(f.key)) out.set(f.key, f);
  return [...out.values()];
}

/** The faults in an order of their own, to tell whether they changed when only Fusebox's order did. */
export function faultsByKey(faults: readonly StoredGatewayFault[]): StoredGatewayFault[] {
  return [...faults].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * An account's status (AIG-11): `off` when disabled in Fusebox, else from its faults, else `ok`. An API key whose
 * prepaid credit ran out (Fusebox 0.13+ `credit`) takes no requests either, so it counts as used up until Fusebox tries
 * it again.
 */
export function accountStatus(
  disabled: boolean,
  faults: readonly StoredGatewayFault[],
): { status: GatewayAccountStatus; until: string | null } {
  if (disabled) return { status: 'off', until: null };
  const quota = faults.find((f) => f.kind === 'quota') ?? faults.find((f) => f.kind === 'credit');
  if (quota) return { status: 'used_up', until: quota.until };
  const rate = faults.find((f) => f.kind === 'rate_limit');
  if (rate) return { status: 'rate_limited', until: rate.until };
  if (faults.some((f) => f.kind === 'signin')) return { status: 'signin_expired', until: null };
  return { status: 'ok', until: null };
}

/**
 * A plan identifier in words: “Ultra”, “Max”, “Pro”, “Plus”; Fusebox's own word otherwise, its underscores as spaces.
 * Claude renamed Max 20x to Ultra and Max 5x to Max on 30 October 2026 and kept the identifiers.
 */
export function planWords(plan: string | null): string | null {
  if (!plan) return null;
  const known: Record<string, string> = {
    pro: 'Pro',
    plus: 'Plus',
    max_5x: 'Max',
    max_20x: 'Ultra',
    ultra: 'Ultra',
    team: 'Team',
    enterprise: 'Enterprise',
    business: 'Business',
    free: 'Free',
  };
  const k = plan.toLowerCase();
  return known[k] ?? (k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ')).slice(0, 30);
}

/** The stable key of a Fusebox account (AIG-11): a hash of its id, never the id. */
export function gatewayAccountKey(connectionId: string, fuseboxId: string): string {
  return `gwa_${createHash('sha256').update(`${connectionId}\0${fuseboxId}`).digest('hex').slice(0, 24)}`;
}

/**
 * The pool's Claude and Codex accounts of `GET /api/accounts` (AIG-11), with their statuses from the faults: Claude
 * first, then ChatGPT, each in Fusebox's order, at most 64. Labels are what the person reads (the account's
 * email, else Fusebox's label, else “Claude account 1”).
 */
export function mapFuseboxAccounts(
  connectionId: string,
  body: unknown,
  faults: readonly StoredGatewayFault[],
  now: Date,
): GatewayAccountUsage[] {
  if (!Array.isArray(body)) return [];
  const counts: Record<GatewayProvider, number> = { claude: 0, codex: 0 };
  const out: GatewayAccountUsage[] = [];
  for (const raw of body) {
    const a = obj(raw);
    const id = str(a?.id);
    const provider = str(a?.provider)?.toLowerCase();
    if (!a || !id || !PROVIDERS.includes(provider as GatewayProvider)) continue;
    const p = provider as GatewayProvider;
    counts[p] += 1;
    const quota = obj(a.quota);
    // Fusebox 0.12+ says when the provider confirmed there is no 5-hour limit; it has already retired that window.
    const noFiveHourLimit = quota?.no_five_hour_limit === true;
    const windows = (Array.isArray(quota?.windows) ? quota.windows : [])
      .map((w) => fuseboxWindow(w, now))
      .filter((w): w is UsageWindow => w !== null && !(noFiveHourLimit && w.kind === 'five_hour'));
    const own = faults.filter((f) => f.accountId === id);
    const { status, until } = accountStatus(a.disabled === true, own);
    // Used up for want of credit, not for a limit that resets: its `until` is only Fusebox's next try.
    const outOfCredit =
      status === 'used_up' && !own.some((f) => f.kind === 'quota') && own.some((f) => f.kind === 'credit');
    // Faults follow an account's latest pause, of one model or all; only a pause of every model (`*`) stops it. An API
    // key out of credit (`credit`, Fusebox 0.13+) is paused whole too.
    const paused = ['quota', 'rate_limit', 'credit'].includes(str(obj(a.cooldown_kinds)?.['*']) ?? '');
    const plan = str(quota?.plan)?.slice(0, USAGE_PLAN_MAX) ?? null;
    // The provider's own name (Fusebox 0.12+ `plan_name`, Claude only) beats the identifier's.
    const planName = (str(quota?.plan_name) ?? planWords(plan))?.slice(0, USAGE_PLAN_MAX);
    out.push({
      key: gatewayAccountKey(connectionId, id),
      label: (str(a.email) ?? str(a.label) ?? gatewayAccountLabel(p, counts[p])).slice(0, 256),
      provider: p,
      plan,
      ...(planName ? { planName } : {}),
      ...(noFiveHourLimit ? { noFiveHourLimit } : {}),
      ...(paused ? { paused } : {}),
      ...(outOfCredit ? { outOfCredit } : {}),
      status,
      until,
      windows: sortUsageWindows(windows).slice(0, USAGE_WINDOWS_MAX),
    });
  }
  return sortGatewayAccounts(out).slice(0, GATEWAY_ACCOUNTS_MAX);
}

/* Every subscription Fusebox lists ------------------------------------------------------- */

/** Fusebox's providers as its dashboard names them; ChatGPT as Whombat does. */
const FUSEBOX_TOOLS: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  gemini: 'Gemini',
  vertex: 'Vertex AI',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  xai: 'Grok',
  meta: 'Meta',
  devin: 'Devin',
};

/** A provider's mark (`@whombat/brand`), the ones Fusebox's dashboard shows; ChatGPT's is OpenAI's. */
const FUSEBOX_MARKS: Readonly<Record<string, string>> = {
  codex: 'openai',
};

/** A Fusebox provider's name as people read it (“Meta”, “Grok”), its own id otherwise. */
export function fuseboxToolName(provider: string): string {
  return FUSEBOX_TOOLS[provider] ?? (provider.charAt(0).toUpperCase() + provider.slice(1)).slice(0, 40);
}

/**
 * A Fusebox provider's mark: its brand's (`claude`, `openai`, `meta`), or its own id, which a screen draws as its first
 * letter when there's no mark by that name (Antigravity's is drawn with blurs a mark can't hold).
 */
export function fuseboxProviderMark(provider: string): string | undefined {
  const mark = FUSEBOX_MARKS[provider] ?? provider;
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(mark) ? mark : undefined;
}

/**
 * A subscription of a tool outside the pools (Meta, Gemini, Grok, Kimi…): Fusebox lists it with its limits, Whombat
 * shows it beside the Claude and ChatGPT ones and sends nothing through it.
 */
export interface FuseboxOtherSubscription {
  key: string;
  label: string;
  /** Fusebox's provider id (`meta`). */
  provider: string;
  plan: string | null;
  noFiveHourLimit: boolean;
  status: GatewayAccountStatus;
  until: string | null;
  windows: UsageWindow[];
}

/** Of Fusebox's limits beyond windows (credits, a model's own), the ones its dashboard's list shows: two at most. */
function fuseboxLimits(quota: Record<string, unknown> | null, now: Date): UsageWindow[] {
  const all = (Array.isArray(quota?.limits) ? quota.limits : [])
    .map(obj)
    .filter(
      (l): l is Record<string, unknown> => !!l && l.enabled !== false && typeof l.used_percent === 'number',
    );
  const primary = all.filter((l) => ['account', 'credits'].includes(str(obj(l.scope)?.kind) ?? ''));
  return (primary.length ? primary : all).slice(0, 2).flatMap((l) => {
    const w = fuseboxWindow(
      { name: str(l.name) ?? str(l.id) ?? 'Limit', used: l.used_percent, resets_at: l.resets_at },
      now,
    );
    return w ? [w] : [];
  });
}

/**
 * The subscriptions of `GET /api/accounts` beyond Claude's and ChatGPT's, as Fusebox's dashboard lists them: an account
 * it signs in to that reports use (Meta's whether or not it has yet), or any account with limits. At most 64, in
 * Fusebox's order.
 */
export function mapFuseboxOtherSubscriptions(
  connectionId: string,
  body: unknown,
  faults: readonly StoredGatewayFault[],
  now: Date,
): FuseboxOtherSubscription[] {
  if (!Array.isArray(body)) return [];
  const out: FuseboxOtherSubscription[] = [];
  for (const raw of body) {
    const a = obj(raw);
    const id = str(a?.id);
    const provider = str(a?.provider)?.toLowerCase();
    if (!a || !id || !provider || PROVIDERS.includes(provider as GatewayProvider)) continue;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(provider)) continue;
    const quota = obj(a.quota);
    const noFiveHourLimit = quota?.no_five_hour_limit === true;
    const windows = (Array.isArray(quota?.windows) ? quota.windows : [])
      .map((w) => fuseboxWindow(w, now))
      .filter((w): w is UsageWindow => w !== null && !(noFiveHourLimit && w.kind === 'five_hour'));
    const limits = fuseboxLimits(quota, now);
    const signedIn = str(a.kind) === 'oauth' && provider === 'meta';
    const hasLimits =
      (Array.isArray(quota?.windows) && quota.windows.length > 0) ||
      (Array.isArray(quota?.limits) && quota.limits.length > 0);
    if (!signedIn && !hasLimits) continue;
    const { status, until } = accountStatus(
      a.disabled === true,
      faults.filter((f) => f.accountId === id),
    );
    const planName = str(quota?.plan_name)?.replace(/^Google AI\s+/i, '') ?? planWords(str(quota?.plan));
    out.push({
      key: gatewayAccountKey(connectionId, id),
      label: (str(a.email) ?? str(a.label) ?? `${fuseboxToolName(provider)} account`).slice(0, 256),
      provider,
      plan: planName ? planName.slice(0, USAGE_PLAN_MAX) : null,
      noFiveHourLimit,
      status,
      until,
      windows: [...sortUsageWindows(windows), ...limits].slice(0, USAGE_WINDOWS_MAX),
    });
    if (out.length >= GATEWAY_ACCOUNTS_MAX) break;
  }
  return out;
}

/** Fusebox's ids of the Claude and ChatGPT accounts it signs in to: subscriptions, also while one is off and unread. */
export function fuseboxSignedIn(connectionId: string, body: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(body)) return out;
  for (const raw of body) {
    const a = obj(raw);
    const id = str(a?.id);
    const provider = str(a?.provider)?.toLowerCase();
    if (a && id && str(a.kind) === 'oauth' && PROVIDERS.includes(provider as GatewayProvider))
      out.add(gatewayAccountKey(connectionId, id));
  }
  return out;
}

/* Whombat's named client (AIG-02, AIG-03) ------------------------------------------------------------------------- */

/** A new client key: `wbgw_` + 32 random bytes, base64url. */
export function newGatewayClientKey(): string {
  return `${GATEWAY_CLIENT_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** What `GET /api/config/settings` answered that provisioning needs (never kept). */
export interface FuseboxSettings {
  revision: string;
  /** `values['named-clients']`, as read; null when this Fusebox doesn't list them (an older one). */
  namedClients: unknown[] | null;
  /** `values['api-keys']`, as read. */
  apiKeys: unknown[];
}

/** The settings answer's parts, or null when it isn't one. */
export function parseFuseboxSettings(body: unknown): FuseboxSettings | null {
  const b = obj(body);
  const values = obj(b?.values);
  const revision = typeof b?.revision === 'string' ? b.revision : null;
  if (!values || revision === null) return null;
  const named = values['named-clients'];
  const keys = values['api-keys'];
  return {
    revision,
    namedClients: Array.isArray(named) ? named : null,
    apiKeys: Array.isArray(keys) ? keys : [],
  };
}

/**
 * An open Fusebox stays open (AIG-02): with neither client keys nor named clients it takes every request, and a first
 * key would lock out every other tool. Whombat adds nothing then and sends no key.
 */
export function isOpenFusebox(settings: FuseboxSettings): boolean {
  return settings.apiKeys.length === 0 && (settings.namedClients ?? []).length === 0;
}

/**
 * The named clients with Whombat's put in: the entry with its id replaced where it is, else added at the end. A
 * replaced entry keeps what the person set on it in Fusebox (its models, `model-map` since Fusebox 0.14, limits,
 * addresses, an expiry still ahead); only its label and key are new. An expiry already past goes: connecting again is
 * the person giving Whombat access again.
 */
export function withWhombatClient(
  list: readonly unknown[],
  client: { id: string; label: string; key: string },
  now: Date = new Date(),
): unknown[] {
  const today = now.toISOString().slice(0, 10);
  let replaced = false;
  const out = list.map((entry) => {
    const old = obj(entry);
    if (old?.id !== client.id) return entry;
    replaced = true;
    const { expires, ...kept } = old;
    const ahead = typeof expires === 'string' && expires >= today;
    return { ...kept, ...(ahead ? { expires } : {}), id: client.id, label: client.label, key: client.key };
  });
  return replaced ? out : [...out, { id: client.id, label: client.label, key: client.key }];
}

/** The named clients without the one with this id (others untouched). */
export function withoutClient(list: readonly unknown[], id: string): unknown[] {
  return list.filter((entry) => obj(entry)?.id !== id);
}

/** Whether a refused settings change names `named-clients` (an older Fusebox that doesn't know them, AIG-02). */
export function refusedNamedClients(status: number, body: unknown): boolean {
  if (status !== 400) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return /named[-_ ]clients/i.test(text);
}
