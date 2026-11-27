/**
 * Server agents that keep themselves up to date, on Whombat's side (docs/decisions/agent-updates.md AU-01…AU-10;
 * agent-updates-server.md AU-S01…): the pure parts.
 *
 * - The hub's `update` object of an `/agents` row in the contract's shape (`HostAgentUpdate`, contracts 0.99.0) and
 *   its setting (`HostAgentSettings`).
 * - Its refusals of Update now and the setting in plain words (“Another update is already running. Try again in a few
 *   minutes.”).
 * - Worth a look: an agent whose update failed (“The agent on pve-01 couldn’t be updated, so it went back to the version
 *   it had.”) and one that needs its last install (“pve-01’s agent needs one more install, then it updates itself.”),
 *   as hints of the server (its detail, the fleet's hints, and so Watch); the hub's own `agent.outdated` hint is left
 *   out where these say it, or where the agent updates itself anyway.
 * - Done recently: `AgentUpdateFollow` hears the hub's `agent.update` `updated` and has it signed once, by the person who
 *   pressed Update now (remembered for a while) or else by Whombat.
 */

import {
  HOST_AGENT_UPDATE_REASON_CODES,
  HOST_AGENT_UPDATE_STATES,
  HOST_AGENT_UPDATE_WAITS,
  type HostAgentSettings,
  type HostAgentUpdate,
  type HostAgentUpdateReasonCode,
  type HostHint,
} from '@whombat/core';
import { isEnglish, type ServerMessageKey, tServer } from '../i18n/catalog';
import type { HostsError } from './client';
import { rememberEnglish } from './localize';

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;

function timestamp(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Only the defined values (a contract's optional field is absent, not undefined). */
function defined<T extends J>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/* The hub's shapes ---------------------------------------------------------------------------------------------- */

/**
 * The `update` object of an `/agents` row as the contract's (CT-511): every 0.99 field is optional, so an older hub's
 * object maps as before; an unknown code, state or wait is left out rather than guessed.
 */
export function toAgentUpdate(raw: unknown): HostAgentUpdate {
  const u = obj(raw);
  const state = oneOf(HOST_AGENT_UPDATE_STATES, u.state);
  return defined({
    available: u.available === true,
    version: str(u.version),
    reason: str(u.reason),
    reasonCode: oneOf(HOST_AGENT_UPDATE_REASON_CODES, u.reason_code),
    auto: typeof u.auto === 'boolean' ? u.auto : undefined,
    state,
    waitingFor: state === 'waiting' ? oneOf(HOST_AGENT_UPDATE_WAITS, u.waiting_for) : undefined,
    message: str(u.message),
    failedVersion: str(u.failed_version),
    updatedAt: timestamp(u.updated_at),
    canInstall: typeof u.can_install === 'boolean' ? u.can_install : undefined,
  }) as HostAgentUpdate;
}

/** `GET /agents/settings` as `HostAgentSettings`: on unless the hub says off; halted while it names a version. */
export function toAgentSettings(raw: unknown): HostAgentSettings {
  const s = obj(raw);
  return { autoUpdate: s.auto_update !== false, halted: Boolean(str(s.halted_version)) };
}

/** One `/agents` row's server and update, or null without either. */
export function agentRowUpdate(row: unknown): { serverId: string; update: HostAgentUpdate } | null {
  const r = obj(row);
  const serverId = str(r.server_id);
  if (!serverId || !r.update) return null;
  return { serverId, update: toAgentUpdate(r.update) };
}

/**
 * What Update now started (`HostAgentUpdateAccepted.state`): the hub's own word when it gives one (`state`, or the
 * server among `installing`), else from the server's update as Whombat read it just before — an agent without the
 * build's key gets its last install (AU-07), any other a signed update.
 */
export function startedState(
  raw: unknown,
  serverId: string,
  before: HostAgentUpdate | null | undefined,
): 'updating' | 'installing' {
  const r = obj(raw);
  if (r.state === 'updating' || r.state === 'installing') return r.state;
  if (Array.isArray(r.installing) && r.installing.includes(serverId)) return 'installing';
  return before && needsInstall(before) ? 'installing' : 'updating';
}

/* Words ------------------------------------------------------------------------------------------------------- */

/**
 * What Whombat says about updates of its helper on a server (AU-08's words). A person never meets “agent” for the
 * program: that word is the assistant's. The titles don't name the server, since every line shows on or with it.
 */
export const AGENT_UPDATE_TEXT = {
  updated: (server: string) => `Updated Whombat’s helper on ${server}`,
  asked: (server: string) => `Asked Whombat’s helper on ${server} to update`,
  installing: (server: string) => `Started the last install of Whombat’s helper on ${server}`,
  settingOn: 'Turned on Keep Whombat’s helper up to date',
  settingOff: 'Turned off Keep Whombat’s helper up to date',
  failedTitle: 'Whombat’s helper didn’t update',
  failedWayOut: 'It’s still on the version it had. Try again on the System tab.',
  installTitle: 'Whombat’s helper needs one more install',
  /** Whombat may run the install there (AU-07). */
  installWayOutButton: 'After that it updates itself. Update it on the System tab.',
  /** Elsewhere a person runs the install command once (it is on the System tab). */
  installWayOutCommand:
    'After that it updates itself. Run its install command on it once; the System tab has it.',
  updateRunning: 'Another update is already running. Try again in a few minutes.',
  needsInstall: (server: string) =>
    `Whombat’s helper on ${server} needs one more install, and Whombat can’t run commands there. Run its install command on it once; the System tab has it.`,
} as const;

/** `AGENT_UPDATE_TEXT` in a locale (English: the same words). */
export function agentUpdateText(locale?: string | null): typeof AGENT_UPDATE_TEXT {
  if (isEnglish(locale)) return AGENT_UPDATE_TEXT;
  const t = (key: ServerMessageKey, server?: string) => tServer(locale, key, server ? { server } : undefined);
  return {
    updated: (server: string) => t('hosts.agent.updated', server),
    asked: (server: string) => t('hosts.agent.asked', server),
    installing: (server: string) => t('hosts.agent.installing', server),
    settingOn: t('hosts.agent.settingOn'),
    settingOff: t('hosts.agent.settingOff'),
    failedTitle: t('hosts.agent.failedTitle'),
    failedWayOut: t('hosts.agent.failedWayOut'),
    installTitle: t('hosts.agent.installTitle'),
    installWayOutButton: t('hosts.agent.installWayOutButton'),
    installWayOutCommand: t('hosts.agent.installWayOutCommand'),
    updateRunning: t('hosts.agent.updateRunning'),
    needsInstall: (server: string) => t('hosts.agent.needsInstall', server),
  } as unknown as typeof AGENT_UPDATE_TEXT;
}

/** Why the helper can't be updated now, in words, by the hub's reason code (Update now's “nothing to update”). */
export function notUpdatableText(
  server: string,
  code: HostAgentUpdateReasonCode | undefined,
  locale?: string | null,
): string {
  if (!isEnglish(locale)) {
    const key: ServerMessageKey =
      code === 'up_to_date'
        ? 'hosts.agent.upToDate'
        : code === 'not_connected'
          ? 'hosts.agent.notConnected'
          : code === 'turned_off'
            ? 'hosts.agent.turnedOff'
            : code === 'no_build'
              ? 'hosts.agent.noBuild'
              : code === 'newer_running'
                ? 'hosts.agent.newerRunning'
                : code === 'no_key' || code === 'other_key'
                  ? 'hosts.agent.needsInstall'
                  : 'hosts.agent.cantNow';
    return tServer(locale, key, { server });
  }
  switch (code) {
    case 'up_to_date':
      return `Whombat’s helper on ${server} is already up to date.`;
    case 'not_connected':
      return `${server} isn’t connected right now, so its helper can’t be updated.`;
    case 'turned_off':
      return `Updates are turned off on ${server} itself.`;
    case 'no_build':
      return 'There’s no new version of Whombat’s helper yet.';
    case 'newer_running':
      return `${server} already runs a newer helper.`;
    case 'no_key':
    case 'other_key':
      return AGENT_UPDATE_TEXT.needsInstall(server);
    default:
      return `Whombat’s helper on ${server} can’t be updated right now.`;
  }
}

/**
 * The hub's refusals of Update now in words, or null for the shared ones (`agent_offline`, `server_not_found` …).
 * `code`: the server's reason code as Whombat read it just before, for a refusal that has only “nothing to update”.
 */
export function agentUpdateRefusalText(
  err: HostsError,
  server: string,
  code?: HostAgentUpdateReasonCode,
  locale?: string | null,
): string | null {
  const T = agentUpdateText(locale);
  switch (err.code) {
    case 'update_running':
      return T.updateRunning;
    case 'needs_install':
      return T.needsInstall(server);
    case 'no_build':
      return notUpdatableText(server, 'no_build', locale);
    case 'nothing_to_update':
      return notUpdatableText(server, code, locale);
    default:
      return null;
  }
}

/* Worth a look ------------------------------------------------------------------------------------------------ */

/** The hub's hint that an agent's version differs from the hub's (hosts `rules.HintAgentOutdated`). */
export const AGENT_OUTDATED_HINT = 'agent.outdated';
/** Whombat's own hints (AU-08): a failed update, an agent that needs its last install. */
export const AGENT_FAILED_HINT = 'agent.update_failed';
export const AGENT_INSTALL_HINT = 'agent.needs_install';

/**
 * Whether the update failed on this server for the build it would get now: `failed`, or the version that failed here
 * is still the build's. `halted` alone (another server's failure stopped the round) is not this server's failure: the
 * server where it failed says it, and Try again there clears the halt (AU-S06).
 */
export function updateFailed(u: HostAgentUpdate): boolean {
  if (u.state === 'failed') return true;
  return Boolean(u.failedVersion && (!u.version || u.failedVersion === u.version));
}

/** Whether the agent needs its last install (AU-07): built without the build's key. */
export function needsInstall(u: HostAgentUpdate): boolean {
  return u.reasonCode === 'no_key' || u.reasonCode === 'other_key';
}

/** Whether the agent will be updated without anyone (the round takes it, or it is updating or waiting already). */
function updatesItself(u: HostAgentUpdate): boolean {
  return u.auto === true || u.state === 'updating' || u.state === 'waiting' || u.reasonCode === 'up_to_date';
}

/** Whombat's Worth a look about one server's agent (AU-08), as a hint of the server: none, a failure or an install. */
export function agentUpdateHint(
  serverId: string,
  u: HostAgentUpdate,
  locale?: string | null,
): HostHint | null {
  const hint = agentUpdateHintIn(serverId, u, locale);
  // What Ignore compares stays English (the hint's words may be another language's).
  if (hint && !isEnglish(locale)) {
    const en = agentUpdateHintIn(serverId, u, null);
    if (en) rememberEnglish(hint, { _en: { title: en.title, detail: en.detail } });
  }
  return hint;
}

function agentUpdateHintIn(serverId: string, u: HostAgentUpdate, locale?: string | null): HostHint | null {
  const AGENT_UPDATE_TEXT = agentUpdateText(locale);
  if (updateFailed(u))
    return {
      serverId,
      kind: AGENT_FAILED_HINT,
      severity: 'warning',
      entity: 'agent',
      title: AGENT_UPDATE_TEXT.failedTitle,
      detail: AGENT_UPDATE_TEXT.failedWayOut,
      section: 'system',
    };
  if (needsInstall(u))
    return {
      serverId,
      kind: AGENT_INSTALL_HINT,
      severity: 'warning',
      entity: 'agent',
      title: AGENT_UPDATE_TEXT.installTitle,
      detail: u.canInstall ? AGENT_UPDATE_TEXT.installWayOutButton : AGENT_UPDATE_TEXT.installWayOutCommand,
      section: 'system',
    };
  return null;
}

/**
 * A server's hints with Whombat's about its agent (AU-S05): the hub's `agent.outdated` goes where Whombat's own hint
 * says it, or where the agent updates itself; it stays where nothing will (the server's own switch, automatic updates
 * off, no build, a newer agent). Without the 0.99 fields (an older hub) the hints are as the hub gave them.
 */
export function withAgentUpdateHints(
  hints: readonly HostHint[],
  serverId: string,
  update: HostAgentUpdate | null | undefined,
  locale?: string | null,
): HostHint[] {
  if (!update) return [...hints];
  const own = agentUpdateHint(serverId, update, locale);
  const drop = own !== null || updatesItself(update);
  const kept = hints.filter(
    (h) =>
      !(h.serverId === serverId && (h.kind === AGENT_FAILED_HINT || h.kind === AGENT_INSTALL_HINT)) &&
      !(drop && h.serverId === serverId && h.kind === AGENT_OUTDATED_HINT),
  );
  return own ? [own, ...kept] : kept;
}

/**
 * Every server's hints as its page shows them (QN-S51): the hub's, with Whombat's own about each agent from `/agents`
 * (`withAgentUpdateHints`, server by server), so the dot, Watch and the page count the same lines.
 */
export function fleetHints(hints: readonly HostHint[], rows: readonly unknown[]): HostHint[] {
  const updates = new Map<string, HostAgentUpdate>();
  for (const row of rows) {
    const r = agentRowUpdate(row);
    if (r) updates.set(r.serverId, r.update);
  }
  const servers = [...new Set([...hints.map((h) => h.serverId), ...updates.keys()])];
  return servers.flatMap((id) =>
    withAgentUpdateHints(
      hints.filter((h) => h.serverId === id),
      id,
      updates.get(id),
    ),
  );
}

/* Done recently ----------------------------------------------------------------------------------------------- */

/** An update the hub finished (`agent.update` with `state: updated`), to sign. */
export interface AgentUpdated {
  serverId: string;
  from: string | null;
  to: string | null;
  /** The person who pressed Update now on it, when Whombat still knows; else Whombat signs. */
  personId: string | null;
  burrowId: string | null;
}

/** How long a press of Update now names who updated (the hub waits up to six minutes; the last install, longer). */
export const PRESSED_TTL_MS = 30 * 60 * 1000;
/** How long one update is remembered so a repeated event doesn't sign it twice. */
export const SIGNED_TTL_MS = 60 * 60 * 1000;

/**
 * Hears the hub's `agent.update` events and has each finished update signed once (AU-S04): by the person who pressed
 * Update now on that server within `PRESSED_TTL_MS`, else by Whombat, one after another in the order heard. In memory
 * only: after a restart an update someone pressed before is Whombat's.
 */
export class AgentUpdateFollow {
  #pressed = new Map<string, { personId: string; burrowId: string; at: number }>();
  #signed = new Map<string, number>();
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sign: (u: AgentUpdated) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /** A person pressed Update now (or the last install) on a server. */
  pressed(serverId: string, personId: string, burrowId: string): void {
    this.#prune();
    this.#pressed.set(serverId, { personId, burrowId, at: this.now() });
  }

  /** An `agent.update` event's data; resolves once its signing was tried. */
  async heard(data: Readonly<Record<string, unknown>>): Promise<void> {
    if (data.state !== 'updated') return;
    const serverId = str(data.server);
    if (!serverId) return;
    this.#prune();
    const to = str(data.to) ?? null;
    const key = `${serverId}\n${to ?? ''}`;
    if (this.#signed.has(key)) return;
    this.#signed.set(key, this.now());
    const pressed = this.#pressed.get(serverId);
    this.#pressed.delete(serverId);
    const u: AgentUpdated = {
      serverId,
      from: str(data.from) ?? null,
      to,
      personId: pressed?.personId ?? null,
      burrowId: pressed?.burrowId ?? null,
    };
    // One at a time, in the order heard (the first one makes the burrow's signer).
    const run = this.#queue.then(() => this.sign(u)).catch(() => {});
    this.#queue = run;
    await run;
  }

  #prune(): void {
    const now = this.now();
    for (const [k, p] of this.#pressed) if (now - p.at > PRESSED_TTL_MS) this.#pressed.delete(k);
    for (const [k, at] of this.#signed) if (now - at > SIGNED_TTL_MS) this.#signed.delete(k);
  }
}
