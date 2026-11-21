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

const CONNECTIONS = 'Settings → Connections';
const AI_SIGN_IN = 'Settings → AI sign-in';

/** “Claude Code”, “Claude Code and ChatGPT” (Claude Code first). No tools reads as both. */
export function gatewayToolsText(providers: readonly GatewayProvider[]): string {
  const tools = (['claude', 'codex'] as const).filter((p) => providers.length === 0 || providers.includes(p));
  return tools.map((p) => GATEWAY_TOOL_LABELS[p]).join(' and ');
}

/**
 * When a used-up or busy account has room again (AIG-12, AIG-13), in the zone's clock: “today 18:40”, “tomorrow
 * 09:00”, the weekday within six days (“Monday 09:00”), else the date (“12 Oct 09:00”, the year when it isn't now's).
 */
export function formatGatewayUntil(until: DateInput, now: DateInput, timeZone: string): string {
  const clock = formatClock(until, timeZone);
  const days = -daysAgo(until, now, timeZone);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  if (days > 1 && days <= 6) return `${formatWeekday(until, timeZone)} ${clock}`;
  return `${formatDate(until, timeZone, { now })} ${clock}`;
}

/** What members see instead of an account's email (AIG-13): “Claude account 1”, “ChatGPT account 2”. */
export function gatewayAccountLabel(provider: GatewayProvider, n: number): string {
  return `${GATEWAY_ACCOUNT_PROVIDER_LABELS[provider]} account ${n}`;
}

/** Whether switching a tool on asks first (AIG-06): only for Fusebox, which pools people's subscriptions. */
export function gatewaySwitchConfirms(kind: GatewayKind): boolean {
  return kind === 'fusebox';
}

/** The switches, their confirmation, “Runs on”, the pool's lines and the connect and remove messages. */
export const AI_GATEWAY_COPY = {
  /** The switch on the gateway's connection page (AIG-05): “Send Claude Code through Fusebox”. */
  switchLabel: (provider: GatewayProvider, name: string) =>
    `Send ${GATEWAY_TOOL_LABELS[provider]} through ${name}`,
  /** Under the switch (AIG-05). */
  switchHint: (provider: GatewayProvider, name: string) =>
    `Every ${GATEWAY_TOOL_LABELS[provider]} turn on this Whombat goes through ${name}, whoever asks. Off: turns use their usual sign-in again.`,
  /** Fusebox's confirmation before a switch goes on (AIG-06, `gatewaySwitchConfirms`): “Send Claude Code through Fusebox?” */
  confirmTitle: (provider: GatewayProvider, name: string) =>
    `Send ${GATEWAY_TOOL_LABELS[provider]} through ${name}?`,
  confirmBody:
    'Fusebox can share Claude and ChatGPT subscriptions between people. Anthropic’s terms say “Each end user must authenticate with their own … credentials”, and OpenAI asks people not to share a ChatGPT sign-in. Either can limit or suspend those accounts.',
  /** “Send through Fusebox” */
  confirm: (name: string) => `Send through ${name}`,
  cancel: 'Cancel',
  /** An agent of a tool whose switch is on (AIG-17): “Runs on Fusebox”, its note, and its own sign-in locked. */
  runsOnTitle: (name: string) => `Runs on ${name}`,
  runsOnNote: (provider: GatewayProvider, name: string) =>
    `Every ${GATEWAY_TOOL_LABELS[provider]} turn on this Whombat goes through ${name}. When it isn’t answering, your own Claude or ChatGPT sign-in is used. You can change this under ${CONNECTIONS} → ${name}.`,
  /** Settings → AI → Usage (AIG-13): the section is titled with the gateway's name, above this one. */
  yourSubscriptions: 'Your subscriptions',
  /** Each provider's group of accounts, Claude first. */
  groups: GATEWAY_ACCOUNT_PROVIDER_LABELS,
  /** Whether a tool's switch is on, in its group. */
  toolOn: (provider: GatewayProvider, name: string) =>
    `${GATEWAY_TOOL_LABELS[provider]} turns go through ${name}`,
  toolOff: (provider: GatewayProvider, name: string) =>
    `${GATEWAY_TOOL_LABELS[provider]} turns don’t go through ${name}`,
  signInExpired: 'Sign-in expired',
  offIn: (name: string) => `Off in ${name}`,
  answering: (name: string) => `${name} is answering`,
  notAnswering: (name: string) => `${name} isn’t answering`,
  notReadYet: 'Not read yet',
  /** Connecting a second gateway (AIG-01): the existing one's name. */
  exists: (name: string) =>
    `This Whombat already sends its AI through ${name}. Remove that connection first.`,
  /** An API key in the pool whose prepaid credit ran out (Fusebox 0.13). */
  outOfCredit: 'Out of API credit',
  /** A Fusebox that refused `named-clients` (AIG-02). */
  tooOld: 'This Fusebox is too old to add a client key for Whombat. Update Fusebox and connect again.',
  /** Removing it while it didn't answer (AIG-03): “… remove the client “Whombat · Lumio BV” there yourself.” */
  removeByHand: (name: string, clientLabel: string) =>
    `${name} didn’t answer, so remove the client “${clientLabel}” there yourself.`,
} as const;

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
}): string | null {
  const { status, until, name, now, timeZone } = input;
  switch (status) {
    case 'ok':
      return null;
    case 'used_up':
      if (input.outOfCredit) return AI_GATEWAY_COPY.outOfCredit;
      return until === null ? 'Used up' : `Used up until ${formatGatewayUntil(until, now, timeZone)}`;
    case 'rate_limited': {
      if (until === null) return 'Busy';
      const today = daysAgo(until, now, timeZone) === 0;
      return `Busy until ${today ? formatClock(until, timeZone) : formatGatewayUntil(until, now, timeZone)}`;
    }
    case 'signin_expired':
      return AI_GATEWAY_COPY.signInExpired;
    case 'off':
      return AI_GATEWAY_COPY.offIn(name);
  }
}

/** The pool's freshness (AIG-13): “Updated 1 min ago”, “Fusebox isn’t answering”, “Not read yet”. */
export function gatewayUpdatedText(input: {
  name: string;
  reachable: boolean;
  observedAt: DateInput | null;
  now: DateInput;
  timeZone: string;
}): string {
  if (!input.reachable) return AI_GATEWAY_COPY.notAnswering(input.name);
  if (input.observedAt === null) return AI_GATEWAY_COPY.notReadYet;
  return `Updated ${formatAgo(input.observedAt, input.now, input.timeZone)}`;
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
}): string {
  const { code, name, provider, until, now, timeZone } = input;
  switch (code) {
    case 'gateway.missing':
      return `${name} isn’t set up any more, so I couldn’t start. You can connect it again under ${CONNECTIONS}.`;
    case 'gateway.unreachable':
      return `${name} isn’t answering and I have no Claude or ChatGPT sign-in of yours to use instead, so I couldn’t start. You can add one under ${AI_SIGN_IN}.`;
    case 'gateway.used_up': {
      const when =
        until === undefined || until === null ? '' : ` until ${formatGatewayUntil(until, now, timeZone)}`;
      return `${name} has no ${GATEWAY_TOOL_LABELS[provider]} room left${when}, so I couldn’t start.`;
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
  input: GatewayAlert & { name: string; now: DateInput; timeZone: string },
): string {
  const { name } = input;
  switch (input.kind) {
    case 'used_up': {
      const tool = GATEWAY_TOOL_LABELS[input.provider];
      return input.until === null
        ? `${name} has no ${tool} room left. ${tool} turns won’t start until it has room again.`
        : `${name} has no ${tool} room left until ${formatGatewayUntil(input.until, input.now, input.timeZone)}. ${tool} turns won’t start until then.`;
    }
    case 'back':
      return `${name} has room for ${GATEWAY_TOOL_LABELS[input.provider]} again.`;
    case 'signin_expired':
      return `${name}’s ${GATEWAY_ACCOUNT_PROVIDER_LABELS[input.provider]} sign-in for ${input.account} has expired. Sign in again in ${name}.`;
    case 'unreachable': {
      const own = (['claude', 'codex'] as const).filter((p) => input.fallback?.includes(p));
      if (own.length)
        return `${name} isn’t answering, so I’m using your own ${own.map((p) => GATEWAY_ACCOUNT_PROVIDER_LABELS[p]).join(' and ')} sign-in${own.length > 1 ? 's' : ''} until it does.`;
      return `${name} isn’t answering, so ${gatewayToolsText(input.providers)} turns won’t start until it does. Sign in to Claude or ChatGPT under ${AI_SIGN_IN} and I’ll use that while it’s down.`;
    }
    case 'reachable':
      return `Whombat reaches ${name} again.`;
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
