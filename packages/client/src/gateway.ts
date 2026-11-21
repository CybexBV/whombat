/**
 * Claude Code and ChatGPT through an AI gateway (Whombat ai-gateway.md AIG-01…AIG-21; contracts 0.76.0, CT-332; app
 * docs/decisions/ai-gateway.md AP-1117…): what the web and the phone share — the burrow's gateway where the runtime has
 * `ai.gateway`, “Runs on Fusebox” (AIG-17), a switch's words and the confirmation before Fusebox's goes on (AIG-05,
 * AIG-06), what the gateway connection's page and row say instead of the agents' lines (AIG-01), and the pool's lines in
 * Settings → AI → Usage (AIG-11, AIG-13). The sentences the server says too are the contracts' (`AI_GATEWAY_COPY`,
 * `gatewayUpdatedText`, `gatewayAccountStatusText`); `GATEWAY_TEXT` has the app's own. Pure.
 */
import {
  type AiGatewaySwitches,
  aiGatewayFor,
  aiGatewayProviders,
  type BurrowAiGateway,
  GATEWAY_PROVIDERS,
  type GatewayAccountUsage,
  type GatewayKind,
  type GatewayPool,
  type GatewayProvider,
  sortGatewayAccounts,
} from '@whombat/core/domain';
import {
  AI_GATEWAY_COPY,
  GATEWAY_TOOL_LABELS,
  gatewayAccountStatusText,
  gatewaySwitchConfirms,
  gatewayToolsText,
  gatewayUpdatedText,
} from '@whombat/core/text';

/** The app's own words around the contracts' (AP-1117…AP-1124). */
export const GATEWAY_TEXT = {
  /** The switches' section on the connection page (web and Android). */
  section: 'CLAUDE CODE AND CODEX',
  /** The connection page's block instead of the agents' lines (AIG-01): which tools go through it. */
  usedBy: (tools: string) => `Used by ${tools}`,
  usedByText: (on: string, off: string | null) =>
    `${on} turns go through it.${off ? ` ${off} turns run on your own sign-in.` : ''}`,
  unused: 'Not switched on yet',
  unusedText: 'Claude Code and ChatGPT run on your own sign-in until a switch below is on.',
  /** The overview row's line. */
  rowOn: (tools: string) => `${tools} turns go through it`,
  rowOff: 'Not switched on',
  /** The toasts after a switch was saved. */
  savedOn: (tool: string, name: string) => `${tool} turns now go through ${name}.`,
  savedOff: (tool: string) => `${tool} runs on its own sign-in again.`,
  /** A Fusebox provider group without accounts. */
  noAccounts: (provider: string, name: string) => `${name} has no ${provider} accounts.`,
  /** An account without meters. */
  noLimits: (name: string) => `${name} didn’t report its limits.`,
  /** Runs on (AIG-17): the agent's own choice, which applies again when the switch is off. */
  ownChoice: (choice: string) => `When it’s off: ${choice}`,
} as const;

/** The burrow’s gateway; null without one. */
export function aiGatewayOf(
  burrow: { aiGateway?: BurrowAiGateway | null } | null | undefined,
): BurrowAiGateway | null {
  return burrow?.aiGateway ?? null;
}

/**
 * A gateway connection's line on the overview (AP-1117): “Claude Code and ChatGPT turns go through it”, “Not switched
 * on”.
 */
export function gatewayRowLine(switches: AiGatewaySwitches | null): string {
  const on = aiGatewayProviders(switches);
  return on.length ? GATEWAY_TEXT.rowOn(gatewayToolsText(on)) : GATEWAY_TEXT.rowOff;
}

/**
 * Whether the burrow's gateway carries one of these providers' turns now (AIG-07, AIG-16): its switch is on and the
 * runner has the CLI — signed in or not, since a gateway turn needs no sign-in. The shell's “agents can't reply” and
 * “sign in first” lines stay away then (AP-1126).
 */
export function gatewayCarries(
  burrow: { aiGateway?: BurrowAiGateway | null } | null | undefined,
  providers: readonly { provider: string; state: string }[],
): boolean {
  return providers.some(
    (p) => (p.state === 'ready' || p.state === 'logged_out') && aiGatewayFor(burrow, p.provider) !== null,
  );
}

/* Runs on (AIG-17) ------------------------------------------------------------------------------------------------- */

/** An agent's RUNS ON while its tool goes through the gateway: “Runs on Fusebox” and why its own choice doesn't apply. */
export interface GatewayRunsOn {
  title: string;
  note: string;
}

/** “Runs on Fusebox” for an agent on `provider` while the burrow's switch for it is on; null otherwise. */
export function gatewayRunsOn(
  burrow: { aiGateway?: BurrowAiGateway | null } | null | undefined,
  provider: string,
): GatewayRunsOn | null {
  const gateway = aiGatewayFor(burrow, provider);
  if (!gateway) return null;
  return {
    title: AI_GATEWAY_COPY.runsOnTitle(gateway.name),
    note: AI_GATEWAY_COPY.runsOnNote(provider as GatewayProvider, gateway.name),
  };
}

/* The switches (AIG-05, AIG-06) ------------------------------------------------------------------------------------ */

export interface GatewaySwitchText {
  provider: GatewayProvider;
  /** “Send Claude Code through Fusebox”. */
  label: string;
  /** “Every Claude Code turn on this Whombat goes through Fusebox. Off: …”. */
  hint: string;
}

/** The two switches of a gateway connection, Claude Code first, in its name. */
export function gatewaySwitches(name: string): GatewaySwitchText[] {
  return GATEWAY_PROVIDERS.map((provider) => ({
    provider,
    label: AI_GATEWAY_COPY.switchLabel(provider, name),
    hint: AI_GATEWAY_COPY.switchHint(provider, name),
  }));
}

/** The question before a Fusebox switch goes on (AIG-06): the terms, said plainly where it is chosen. */
export interface GatewayConfirmText {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
}

/**
 * The confirmation switching one on asks first — Fusebox only (`gatewaySwitchConfirms`: a generic gateway pools nobody's
 * subscriptions, AIG-06); null when none is needed (switching off, or the generic kind).
 */
export function gatewayConfirm(
  kind: GatewayKind,
  provider: GatewayProvider,
  name: string,
  on: boolean,
): GatewayConfirmText | null {
  if (!on || !gatewaySwitchConfirms(kind)) return null;
  return {
    title: AI_GATEWAY_COPY.confirmTitle(provider, name),
    body: AI_GATEWAY_COPY.confirmBody,
    confirm: AI_GATEWAY_COPY.confirm(name),
    cancel: AI_GATEWAY_COPY.cancel,
  };
}

/** The toast after a switch was saved: “Claude Code turns now go through Fusebox.” / “ChatGPT runs on … again.”. */
export function gatewaySavedText(provider: GatewayProvider, name: string, on: boolean): string {
  const tool = GATEWAY_TOOL_LABELS[provider];
  return on ? GATEWAY_TEXT.savedOn(tool, name) : GATEWAY_TEXT.savedOff(tool);
}

/** What the gateway connection's page says instead of the agents' lines (AIG-01): which tools go through it now. */
export function gatewayUsedBy(switches: AiGatewaySwitches | null): { title: string; text: string } {
  const on = aiGatewayProviders(switches);
  if (!on.length) return { title: GATEWAY_TEXT.unused, text: GATEWAY_TEXT.unusedText };
  const off = GATEWAY_PROVIDERS.filter((p) => !on.includes(p));
  const tools = gatewayToolsText(on);
  return {
    title: GATEWAY_TEXT.usedBy(tools),
    text: GATEWAY_TEXT.usedByText(tools, off.length ? gatewayToolsText(off) : null),
  };
}

/* The pool (AIG-11, AIG-13) ---------------------------------------------------------------------------------------- */

export type GatewayTone = 'ok' | 'warn' | 'mut';

/** The pool's line: “Updated 1 min ago”, “Fusebox isn’t answering” (warning), “Not read yet”. */
export function gatewayPoolLine(
  pool: Pick<GatewayPool, 'name' | 'reachable' | 'observedAt'>,
  now: Date | number,
  timeZone: string,
): { tone: GatewayTone; text: string } {
  const text = gatewayUpdatedText({
    name: pool.name,
    reachable: pool.reachable,
    observedAt: pool.observedAt,
    now,
    timeZone,
  });
  return { tone: !pool.reachable ? 'warn' : pool.observedAt ? 'ok' : 'mut', text };
}

/** A provider group's line in Usage: whether that tool's switch is on (“Claude Code turns go through Fusebox”). */
export function gatewayProviderLine(
  provider: GatewayProvider,
  pool: Pick<GatewayPool, 'name' | 'claude' | 'codex'>,
): string {
  return pool[provider]
    ? AI_GATEWAY_COPY.toolOn(provider, pool.name)
    : AI_GATEWAY_COPY.toolOff(provider, pool.name);
}

/**
 * An account's state beside its plan: null when fine (and for a status this app doesn't know), else “Used up until
 * Monday 09:00”, “Busy until 14:05”, “Out of API credit”, “Sign-in expired” (warning) or “Off in Fusebox” (muted).
 */
export function gatewayAccountStatus(
  account: Pick<GatewayAccountUsage, 'status' | 'until' | 'outOfCredit'>,
  pool: Pick<GatewayPool, 'name'>,
  now: Date | number,
  timeZone: string,
): { tone: GatewayTone; text: string } | null {
  const text = gatewayAccountStatusText({
    status: account.status,
    until: account.until,
    ...(account.outOfCredit ? { outOfCredit: true } : {}),
    name: pool.name,
    now,
    timeZone,
  });
  return text ? { tone: account.status === 'off' ? 'mut' : 'warn', text } : null;
}

/** The pool's accounts by provider, Claude then ChatGPT, each in Fusebox's order; a provider without any is left out. */
export function gatewayAccountGroups(
  pool: Pick<GatewayPool, 'accounts'>,
): { provider: GatewayProvider; accounts: GatewayAccountUsage[] }[] {
  const sorted = sortGatewayAccounts(pool.accounts);
  return GATEWAY_PROVIDERS.map((provider) => ({
    provider,
    accounts: sorted.filter((a) => a.provider === provider),
  })).filter((g) => g.accounts.length > 0);
}
