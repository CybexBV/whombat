/**
 * The settings sheet's AI group (less-is-more.md AP-1814…AP-1816): one card per AI provider with what it is (signed
 * in, the plan), how much of its limits is used (the 5-hour and 7-day meters, any other window once it runs high) and
 * the one thing to do (“Sign in on the web”); how it is signed in, Claude Code's version and when the usage was read are
 * folded under Details, which opens by itself when something is wrong. One sentence on top. Built from `signins.list`,
 * `clients.list` and `usage.list` (contracts CT-70, CT-72, CT-154); the words are `@whombat/client/signins`' and
 * core's usage text. ChatGPT needs nothing installed: its card shows whatever the clients list says, and has no client
 * line (chatgpt-no-client.md AP-5618). Pure.
 */
import {
  CLIENT_NAMES,
  clientOf,
  clientReady,
  needsClient,
  SIGNIN_STATES,
  SIGNIN_TEXT,
} from '@whombat/client/signins';
import {
  type ClientStatus,
  LIVE_PROVIDERS,
  type LiveProvider,
  type ProviderSignIn,
  type SubscriptionUsage,
  sortUsageWindows,
  type UsageWindow,
  windowLevel,
} from '@whombat/core/domain';
import { formatAsOf, formatResetsIn, formatUsagePct, USAGE_PAY_AS_YOU_GO } from '@whombat/core/text';

export type AiTone = 'ok' | 'warn' | 'bad' | 'mut';

export const AI_TEXT = {
  /** The group's one sentence (AP-1815): the assistant by its name. */
  help: (assistant: string) => `${assistant} works on your own Claude and ChatGPT sign-ins. Sign in here.`,
  details: 'Details',
  apiKey: 'API key',
  subscription: 'Subscription',
  /** Under Details. */
  client: (name: string, version: string) => `${name} ${version} on this Whombat`,
  noClient: (name: string) => `${name} isn’t installed on this Whombat.`,
  /** The managed Whombat's own providers (AP-1816), under the cards. */
  whombatAi: 'AI on this Whombat',
} as const;

export interface AiMeterView {
  key: string;
  /** “5-hour”. */
  label: string;
  /** 0…100 for the bar. */
  pct: number;
  /** “62 %”, “limit reached”. */
  pctText: string;
  tone: AiTone;
  /** “High”, “Near the limit”, “Limit reached”; null while it is fine. */
  word: string | null;
  /** “resets in 2 h 10 min” once it runs high, else null. */
  resets: string | null;
}

export interface AiProviderCardView {
  provider: LiveProvider;
  /** “Claude Code”, “ChatGPT”. */
  name: string;
  tone: AiTone;
  /** “Signed in · Max plan”, “Not signed in”, “Sign-in expired”. */
  status: string;
  meters: AiMeterView[];
  /** A line instead of meters (an API key: “Pay as you go — see Spend”), or what is wrong, shown open. */
  note: string | null;
  /** Offer “Sign in on the web”: not signed in, or a sign-in that stopped working. */
  signIn: boolean;
  /** Folded under Details: how it is signed in, Claude Code's version, when the usage was read. */
  details: string[];
  /** Something is wrong: Details opens by itself (AP-1753). */
  trouble: boolean;
  /** What TalkBack reads for the card's head. */
  label: string;
}

const TROUBLE_STATES = new Set<ProviderSignIn['state']>([
  'auth_expired',
  'auth_revoked',
  'quota_exhausted',
  'outage',
]);

function signInTone(state: ProviderSignIn['state'] | undefined): AiTone {
  if (!state || state === 'not_signed_in' || state === 'gated') return 'mut';
  if (state === 'ready') return 'ok';
  return state === 'quota_exhausted' || state === 'outage' || state === 'version_drift' ? 'warn' : 'bad';
}

/** “Max plan”, “Subscription”, “API key”. */
export function planText(sub: Pick<SubscriptionUsage, 'kind' | 'plan'>): string {
  if (sub.kind === 'api_key') return AI_TEXT.apiKey;
  const words = sub.plan?.replace(/[_-]+/g, ' ').trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)} plan` : AI_TEXT.subscription;
}

const LEVEL_TONE = { ok: 'ok', warning: 'warn', critical: 'bad' } as const;

function meterOf(w: UsageWindow, now: number): AiMeterView {
  const level = windowLevel(w);
  const word =
    w.status === 'limited'
      ? 'Limit reached'
      : level === 'critical'
        ? 'Near the limit'
        : level === 'warning'
          ? 'High'
          : null;
  const pct = w.usedPct !== null ? Math.min(100, Math.max(0, w.usedPct)) : w.status === 'limited' ? 100 : 0;
  return {
    key: `${w.kind}:${w.label}`,
    label: w.label,
    pct,
    pctText: w.usedPct === null && w.status === 'limited' ? 'limit reached' : formatUsagePct(w.usedPct),
    tone: w.status === 'limited' ? 'bad' : level ? LEVEL_TONE[level] : w.usedPct === null ? 'mut' : 'ok',
    word,
    resets: word ? formatResetsIn(w.resetsAt, now) || null : null,
  };
}

/**
 * The meters shown open: the 5-hour and 7-day windows, then any other (7-day Opus…) once it runs high. The rest is
 * healthy detail and stays out (AP-1753).
 */
export function shownWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return sortUsageWindows(windows).filter((w) => {
    const level = windowLevel(w);
    return (
      w.kind === 'five_hour' ||
      w.kind === 'seven_day' ||
      w.status === 'limited' ||
      level === 'warning' ||
      level === 'critical'
    );
  });
}

export function aiProviderCards(input: {
  signIns: readonly ProviderSignIn[] | undefined;
  clients: readonly ClientStatus[] | undefined;
  usage: readonly SubscriptionUsage[] | undefined;
  now: number;
  timeZone: string;
}): AiProviderCardView[] {
  const clientsList = input.clients ? { clients: [...input.clients], checkedAt: null } : undefined;
  // Only the providers this Whombat has: Claude Code once installed, ChatGPT always (all while that isn't known).
  const available = LIVE_PROVIDERS.filter((p) => !clientsList || clientReady(p, clientsList));
  const providers = available.length ? available : LIVE_PROVIDERS;
  return providers.map((provider) => {
    const name = CLIENT_NAMES[provider];
    const own = (input.signIns ?? []).filter((s) => s.provider === provider);
    const mine = own.find((s) => s.state === 'ready') ?? own[0] ?? null;
    const usage = (input.usage ?? []).find((u) => u.provider === provider && u.connected) ?? null;
    const ready = mine?.state === 'ready';
    const plan = usage ? planText(usage) : mine?.authMode === 'api_key' ? AI_TEXT.apiKey : null;
    const status = ready
      ? [SIGNIN_TEXT.signedInOther, plan].filter(Boolean).join(' · ')
      : mine
        ? (SIGNIN_STATES[mine.state] ?? mine.state)
        : SIGNIN_TEXT.notSignedIn;
    const trouble = !!mine && TROUBLE_STATES.has(mine.state);
    const meters =
      ready && usage && usage.kind !== 'api_key'
        ? shownWindows(usage.windows).map((w) => meterOf(w, input.now))
        : [];
    const client = clientsList ? clientOf(clientsList, provider) : null;
    const details = [
      ready ? (SIGNIN_TEXT.signedIn[mine?.authMode ?? ''] ?? null) : null,
      !needsClient(provider)
        ? null
        : client?.installed
          ? AI_TEXT.client(name, client.installed.version)
          : clientsList
            ? AI_TEXT.noClient(name)
            : null,
      usage?.observedAt ? `Usage ${formatAsOf(usage.observedAt, input.now, input.timeZone)}` : null,
      usage?.error ?? null,
      !trouble ? (mine?.explanation ?? null) : null,
    ].filter((d): d is string => !!d);
    const note = trouble
      ? (mine?.explanation ?? null)
      : ready && usage?.kind === 'api_key'
        ? USAGE_PAY_AS_YOU_GO
        : null;
    const highest = meters.find((m) => m.word);
    return {
      provider,
      name,
      tone: signInTone(mine?.state),
      status,
      meters,
      note,
      signIn: !ready && mine?.state !== 'version_drift' && mine?.state !== 'gated',
      details,
      trouble: trouble || !!usage?.error,
      label: [name, status, highest ? `${highest.label} ${highest.pctText}, ${highest.word}` : null]
        .filter(Boolean)
        .join(', '),
    };
  });
}

/** What TalkBack reads for a meter: “5-hour, 62 % used”, “7-day, 96 % used, Near the limit, resets in 2 h”. */
export function meterLabel(m: AiMeterView): string {
  return [`${m.label}, ${m.pctText} used`, m.word, m.resets].filter(Boolean).join(', ');
}
