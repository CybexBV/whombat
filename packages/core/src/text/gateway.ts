/**
 * The AI gateway's words (0.76, CT-332; Whombat docs/decisions/ai-gateway.md AIG-01…AIG-17): the switches and their
 * confirmation, “Runs on Fusebox”, the pool on Settings → AI → Usage, what an agent says when its turn can't go
 * through, the person's alerts and the signed Keys lines. `name` is the gateway's name (its connection's label,
 * “Fusebox”); times are the burrow's clock, 24-hour (`formatGatewayUntil`).
 */
import type {
  GatewayAccountStatus,
  GatewayKind,
  GatewayProvider,
  GatewayRefusalCode,
} from '../domain/gateway.js';
import { coreTranslator } from '../i18n/catalog.js';
import { type DateInput, daysAgo, formatAgo, formatClock, formatDate, formatWeekday } from './time.js';

/**
 * What each provider's turns are called on the switches, alerts and Keys lines (AIG-05): “Claude Code”, “ChatGPT”
 * (2.1, CT-1452: a ChatGPT turn through the gateway runs on Hermes's own loop against an OpenAI-compatible endpoint;
 * nothing called Codex runs any more).
 */
export const GATEWAY_TOOL_LABELS: Readonly<Record<GatewayProvider, string>> = {
  claude: 'Claude Code',
  codex: 'ChatGPT',
};

/** The subscriptions behind each tool in a pool (AIG-13): “Claude”, “ChatGPT”. */
export const GATEWAY_ACCOUNT_PROVIDER_LABELS: Readonly<Record<GatewayProvider, string>> = {
  claude: 'Claude',
  codex: 'ChatGPT',
};

/** “Claude Code”, “Claude Code and ChatGPT” (Claude Code first). No tools reads as both. */
export function gatewayToolsText(providers: readonly GatewayProvider[], locale?: string | null): string {
  const tools = (['claude', 'codex'] as const).filter((p) => providers.length === 0 || providers.includes(p));
  const labels = tools.map((p) => GATEWAY_TOOL_LABELS[p]);
  if (labels.length === 2)
    return coreTranslator(locale).t('gateway.and', { a: labels[0] ?? '', b: labels[1] ?? '' });
  return labels.join('');
}

/**
 * When a used-up or busy account has room again (AIG-12, AIG-13), in the zone's clock: “today 18:40”, “tomorrow
 * 09:00”, the weekday within six days (“Monday 09:00”), else the date (“12 Oct 09:00”, the year when it isn't now's).
 */
export function formatGatewayUntil(
  until: DateInput,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const clock = formatClock(until, timeZone);
  const days = -daysAgo(until, now, timeZone);
  if (days === 0) return tr.t('gateway.today', { clock });
  if (days === 1) return tr.t('gateway.tomorrow', { clock });
  if (days > 1 && days <= 6)
    return tr.t('gateway.dayClock', { day: formatWeekday(until, timeZone, locale), clock });
  return tr.t('gateway.dayClock', { day: formatDate(until, timeZone, { now }, locale), clock });
}

/** What members see instead of an account's email (AIG-13): “Claude account 1”, “ChatGPT account 2”. */
export function gatewayAccountLabel(provider: GatewayProvider, n: number, locale?: string | null): string {
  return coreTranslator(locale).t('gateway.account', {
    provider: GATEWAY_ACCOUNT_PROVIDER_LABELS[provider],
    n,
  });
}

/** Whether switching a tool on asks first (AIG-06): only for Fusebox, which pools people's subscriptions. */
export function gatewaySwitchConfirms(kind: GatewayKind): boolean {
  return kind === 'fusebox';
}

/** The switches, their confirmation, “Runs on”, the pool's lines and the connect and remove messages, in a locale. */
export function aiGatewayCopy(locale?: string | null) {
  const tr = coreTranslator(locale);
  const tool = (provider: GatewayProvider) => GATEWAY_TOOL_LABELS[provider];
  return {
    /** The switch on the gateway's connection page: “Send Claude Code through Fusebox”. */
    switchLabel: (provider: GatewayProvider, name: string) =>
      tr.t('gateway.switchLabel', { tool: tool(provider), name }),
    /** Under the switch. */
    switchHint: (provider: GatewayProvider, name: string) =>
      tr.t('gateway.switchHint', { tool: tool(provider), name }),
    /** Fusebox's confirmation before a switch goes on (`gatewaySwitchConfirms`): “Send Claude Code through Fusebox?” */
    confirmTitle: (provider: GatewayProvider, name: string) =>
      tr.t('gateway.confirmTitle', { tool: tool(provider), name }),
    confirmBody: tr.t('gateway.confirmBody'),
    /** “Send through Fusebox” */
    confirm: (name: string) => tr.t('gateway.confirm', { name }),
    cancel: tr.t('gateway.cancel'),
    /** An agent of a tool whose switch is on: “Runs on Fusebox”, its note, and its own sign-in locked. */
    runsOnTitle: (name: string) => tr.t('gateway.runsOnTitle', { name }),
    runsOnNote: (provider: GatewayProvider, name: string) =>
      tr.t('gateway.runsOnNote', { tool: tool(provider), name, connections: tr.t('gateway.connections') }),
    /** Settings → AI → Usage: the section is titled with the gateway's name, above this one. */
    yourSubscriptions: tr.t('gateway.yourSubscriptions'),
    /** Each provider's group of accounts, Claude first. */
    groups: GATEWAY_ACCOUNT_PROVIDER_LABELS,
    /** Whether a tool's switch is on, in its group. */
    toolOn: (provider: GatewayProvider, name: string) =>
      tr.t('gateway.toolOn', { tool: tool(provider), name }),
    toolOff: (provider: GatewayProvider, name: string) =>
      tr.t('gateway.toolOff', { tool: tool(provider), name }),
    signInExpired: tr.t('gateway.signInExpired'),
    offIn: (name: string) => tr.t('gateway.offIn', { name }),
    answering: (name: string) => tr.t('gateway.answering', { name }),
    notAnswering: (name: string) => tr.t('gateway.notAnswering', { name }),
    notReadYet: tr.t('gateway.notReadYet'),
    /** Connecting a second gateway: the existing one's name. */
    exists: (name: string) => tr.t('gateway.exists', { name }),
    /** An API key in the pool whose prepaid credit ran out. */
    outOfCredit: tr.t('gateway.outOfCredit'),
    /** A Fusebox that refused `named-clients`. */
    tooOld: tr.t('gateway.tooOld'),
    /** Removing it while it didn't answer: “… remove the client “Whombat · Lumio BV” there yourself.” */
    removeByHand: (name: string, clientLabel: string) =>
      tr.t('gateway.removeByHand', { name, client: clientLabel }),
  };
}

export type AiGatewayCopy = ReturnType<typeof aiGatewayCopy>;

/** The switches, their confirmation, “Runs on”, the pool's lines and the connect and remove messages. */
export const AI_GATEWAY_COPY: AiGatewayCopy = aiGatewayCopy('en');

/**
 * An account's status line in the pool (AIG-13), or null when it is fine: “Used up until Monday 09:00”, “Busy until
 * 14:05” (the clock alone today), “Out of API credit” (no time: only adding credit brings it back), “Sign-in
 * expired”, “Off in Fusebox”.
 */
export function gatewayAccountStatusText(input: {
  status: GatewayAccountStatus;
  until: DateInput | null;
  outOfCredit?: boolean;
  name: string;
  now: DateInput;
  timeZone: string;
  locale?: string | null;
}): string | null {
  const { status, until, name, now, timeZone, locale } = input;
  const tr = coreTranslator(locale);
  switch (status) {
    case 'ok':
      return null;
    case 'used_up':
      if (input.outOfCredit) return tr.t('gateway.outOfCredit');
      return until === null
        ? tr.t('gateway.usedUp')
        : tr.t('gateway.usedUpUntil', { until: formatGatewayUntil(until, now, timeZone, locale) });
    case 'rate_limited': {
      if (until === null) return tr.t('gateway.busy');
      const today = daysAgo(until, now, timeZone) === 0;
      return tr.t('gateway.busyUntil', {
        until: today ? formatClock(until, timeZone) : formatGatewayUntil(until, now, timeZone, locale),
      });
    }
    case 'signin_expired':
      return tr.t('gateway.signInExpired');
    case 'off':
      return tr.t('gateway.offIn', { name });
  }
}

/** The pool's freshness (AIG-13): “Updated 1 min ago”, “Fusebox isn’t answering”, “Not read yet”. */
export function gatewayUpdatedText(input: {
  name: string;
  reachable: boolean;
  observedAt: DateInput | null;
  now: DateInput;
  timeZone: string;
  locale?: string | null;
}): string {
  const tr = coreTranslator(input.locale);
  if (!input.reachable) return tr.t('gateway.notAnswering', { name: input.name });
  if (input.observedAt === null) return tr.t('gateway.notReadYet');
  return tr.t('gateway.updated', {
    ago: formatAgo(input.observedAt, input.now, input.timeZone, input.locale),
  });
}

/**
 * What an agent says when its turn can't go through the gateway and so didn't start (AIG-12):
 *
 * - `gateway.missing`: “Fusebox isn’t set up any more, so I couldn’t start. You can connect it again under
 *   Settings → Connections.”
 * - `gateway.unreachable` (only when none of the person's own Claude or ChatGPT sign-ins can take the turn instead):
 *   “Fusebox isn’t answering and I have no Claude or ChatGPT sign-in of yours to use instead, so I couldn’t start. You
 *   can add one under Settings → AI sign-in.”
 * - `gateway.used_up`: “Fusebox has no Claude Code room left until Monday 09:00, so I couldn’t start.”
 */
export function gatewayRefusalText(input: {
  code: GatewayRefusalCode;
  name: string;
  provider: GatewayProvider;
  until?: DateInput | null;
  now: DateInput;
  timeZone: string;
  locale?: string | null;
}): string {
  const { code, name, provider, until, now, timeZone, locale } = input;
  const tr = coreTranslator(locale);
  switch (code) {
    case 'gateway.missing':
      return tr.t('gateway.refusal.missing', { name, connections: tr.t('gateway.connections') });
    case 'gateway.unreachable':
      return tr.t('gateway.refusal.unreachable', { name, signIn: tr.t('gateway.aiSignIn') });
    case 'gateway.used_up': {
      const tool = GATEWAY_TOOL_LABELS[provider];
      return until === undefined || until === null
        ? tr.t('gateway.refusal.usedUp', { name, tool })
        : tr.t('gateway.refusal.usedUpUntil', {
            name,
            tool,
            until: formatGatewayUntil(until, now, timeZone, locale),
          });
    }
  }
}

/** What the person hears about the gateway (AIG-14), once per fault and `until`. */
export const GATEWAY_ALERT_KINDS = ['used_up', 'back', 'signin_expired', 'unreachable', 'reachable'] as const;

export type GatewayAlert =
  /** Every enabled account of the provider is used up, until the earliest reset (null: unknown). */
  | { kind: 'used_up'; provider: GatewayProvider; until: DateInput | null }
  /** It has room for the provider again. */
  | { kind: 'back'; provider: GatewayProvider }
  /** An account's sign-in in the gateway expired; `account` is its label (the email). */
  | { kind: 'signin_expired'; provider: GatewayProvider; account: string }
  /**
   * Unreachable for five minutes while a switch is on; `providers`: the tools switched on; `fallback`: the person's own
   * sign-ins that take those turns meanwhile (absent or empty: none, so they don't start).
   */
  | { kind: 'unreachable'; providers: readonly GatewayProvider[]; fallback?: readonly GatewayProvider[] }
  /** It answers again. */
  | { kind: 'reachable' };

/**
 * The alert's words (AIG-14):
 *
 * - “Fusebox has no Claude Code room left until Monday 09:00. Claude Code turns won’t start until then.”
 * - “Fusebox has room for Claude Code again.”
 * - “Fusebox’s Claude sign-in for work@example.com has expired. Sign in again in Fusebox.”
 * - with a sign-in of the person's to use instead: “Fusebox isn’t answering, so I’m using your own Claude sign-in until
 *   it does.”
 * - without: “Fusebox isn’t answering, so Claude Code turns won’t start until it does. Sign in to Claude or ChatGPT
 *   under Settings → AI sign-in and I’ll use that while it’s down.”
 * - “Whombat reaches Fusebox again.”
 */
export function gatewayAlertText(
  input: GatewayAlert & { name: string; now: DateInput; timeZone: string; locale?: string | null },
): string {
  const { name, locale } = input;
  const tr = coreTranslator(locale);
  switch (input.kind) {
    case 'used_up': {
      const tool = GATEWAY_TOOL_LABELS[input.provider];
      return input.until === null
        ? tr.t('gateway.alert.usedUp', { name, tool })
        : tr.t('gateway.alert.usedUpUntil', {
            name,
            tool,
            until: formatGatewayUntil(input.until, input.now, input.timeZone, locale),
          });
    }
    case 'back':
      return tr.t('gateway.alert.back', { name, tool: GATEWAY_TOOL_LABELS[input.provider] });
    case 'signin_expired':
      return tr.t('gateway.alert.signinExpired', {
        name,
        provider: GATEWAY_ACCOUNT_PROVIDER_LABELS[input.provider],
        account: input.account,
      });
    case 'unreachable': {
      const own = (['claude', 'codex'] as const).filter((p) => input.fallback?.includes(p));
      if (own.length) {
        const labels = own.map((p) => GATEWAY_ACCOUNT_PROVIDER_LABELS[p]);
        const ownText =
          labels.length === 2
            ? tr.t('gateway.and', { a: labels[0] ?? '', b: labels[1] ?? '' })
            : labels.join('');
        return tr.tp('gateway.alert.fallback', own.length, { name, own: ownText });
      }
      return tr.t('gateway.alert.unreachable', {
        name,
        tools: gatewayToolsText(input.providers, locale),
        signIn: tr.t('gateway.aiSignIn'),
      });
    }
    case 'reachable':
      return tr.t('gateway.alert.reachable', { name });
  }
}

/**
 * The signed Keys line when a switch changes (AIG-06), the person's name first. Turning Fusebox on says it overrides
 * the provider's terms:
 *
 * - “John now sends every Claude Code turn through Fusebox (an override: Anthropic’s terms don’t allow sharing a
 *   subscription)”
 * - “John now sends every ChatGPT turn through Fusebox (an override: OpenAI’s terms don’t allow sharing a ChatGPT
 *   sign-in)”
 * - another gateway: “John now sends every Claude Code turn through LiteLLM”
 * - off: “John stopped sending Claude Code turns through Fusebox”
 */
export function gatewayKeysText(input: {
  actor: string;
  name: string;
  kind: GatewayKind;
  provider: GatewayProvider;
  on: boolean;
}): string {
  const { actor, name, kind, provider, on } = input;
  const tool = GATEWAY_TOOL_LABELS[provider];
  if (!on) return `${actor} stopped sending ${tool} turns through ${name}`;
  const line = `${actor} now sends every ${tool} turn through ${name}`;
  if (kind !== 'fusebox') return line;
  return provider === 'claude'
    ? `${line} (an override: Anthropic’s terms don’t allow sharing a subscription)`
    : `${line} (an override: OpenAI’s terms don’t allow sharing a ChatGPT sign-in)`;
}
