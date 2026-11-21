/**
 * Server agents keep themselves up to date, on the web and the phone (Whombat agent-updates.md AU-03…AU-09; app
 * agent-updates-app.md AP-2980…): the Agent card's Updates row — its words for each state and reason the hosts service
 * reports, and which button shows (Try again, Update the agent, Update now) or the install command to run once — and
 * the switch “Keep server agents up to date” in This Whombat → About → UPDATES. Owners act; the runtime must have
 * `hosts.agent_updates`. Pure.
 */
import type { HostAgentSettings, HostAgentUpdate } from '@whombat/core/domain';
import { formatAgoIso } from './format';

/* The words (AU-06, AU-08) ------------------------------------------------------------------------------------- */

type Wait = NonNullable<HostAgentUpdate['waitingFor']>;

export const AGENT_UPDATE_WORDS = {
  title: 'Updates',
  kept: 'Kept up to date',
  upToDate: 'Up to date',
  updating: 'Updating to the new version…',
  /** A new version the round takes by itself within minutes (AU-03). */
  soon: 'Updates to the new version soon',
  waiting: {
    packages: (server: string) => `Waits until ${server} has finished installing updates`,
    console: (server: string) => `Waits until the console on ${server} is closed`,
    task: (server: string) => `Waits until ${server} has finished its task`,
  } as Record<Wait, (server: string) => string>,
  failed: 'Couldn’t update: it went back to the version it had.',
  /** Another server's update didn't come back, so automatic updates to that version stopped everywhere (AU-05). */
  halted: 'Stopped: the new version didn’t work on another server.',
  needsInstall: 'Needs one more install, then it updates itself.',
  turnedOff: (server: string) => `Updates are turned off on ${server} itself.`,
  autoOff: 'Automatic updates are off.',
  retry: 'Try again',
  install: 'Update it',
  now: 'Update now',
  /** The install command, made on demand (making it starts an enrollment). */
  showCommand: 'Show the install command',
  making: 'Making it…',
  /** Under the install command (an agent Whombat can't install itself, AU-07). */
  commandNote: 'Run it there once; after that Whombat’s helper updates itself.',
  /** The note when a press went through. */
  started: (state: 'updating' | 'installing', server: string) =>
    state === 'installing'
      ? `Installing Whombat’s helper on ${server} once more.`
      : `Updating Whombat’s helper on ${server}.`,
  /** “updated 2 h ago” at the row's end. */
  updated: (ago: string) => `updated ${ago}`,
  /** The switch (AU-06). */
  switchTitle: 'Keep Whombat’s helper up to date',
  switchOn: 'When a new version comes, Whombat updates its helper on each server, one at a time.',
  switchOff: 'Nothing updates by itself. Update now still works on each server.',
  switchHalted:
    'Stopped for now: a new version didn’t work on one of your servers. Try again on that server, or wait for the next version.',
  switched: (on: boolean) =>
    on
      ? 'Whombat’s helper is kept up to date on every server.'
      : 'Whombat’s helper no longer updates by itself.',
} as const;

/* The Updates row (AU-08) ---------------------------------------------------------------------------------------- */

/** An update the row shows for this long after it happened (“updated 2 h ago”). */
export const AGENT_UPDATED_SHOWN_MS = 7 * 24 * 3600_000;

export interface AgentUpdatesInput {
  /** The server's name in the words (“pve-01”). */
  server: string;
  /** `HostServerSettings.agent.update`, absent while it loads or from an older hub. */
  update: HostAgentUpdate | null | undefined;
  /** “Keep server agents up to date” (`hosts.agentSettings`), null while unknown. */
  autoUpdate: boolean | null;
  /** Its agent is connected (an offline one can't be updated). */
  connected: boolean;
  now: number;
}

export type AgentUpdateTone = 'ok' | 'warn' | 'bad' | 'mut';

/** The row's one button; all three ask `hosts.updateAgent`. */
export type AgentUpdateAction = 'retry' | 'install' | 'now';

export interface AgentUpdatesView {
  text: string;
  tone: AgentUpdateTone;
  /** “updated 2 h ago”, a week at most. */
  updated: string | null;
  action: { kind: AgentUpdateAction; label: string } | null;
  /** Show the install command to run once on the server (it needs its last install and Whombat may not run it). */
  command: boolean;
}

/**
 * The Updates row, or null when it doesn't show: before the server's settings are read, with no signed agent build on this Whombat (`no_build`: nothing to
 * say a person can act on) and while the agent isn't connected (the Connection line says so).
 */
export function agentUpdatesView(input: AgentUpdatesInput): AgentUpdatesView | null {
  const u = input.update;
  if (!u) return null;
  if (u.reasonCode === 'no_build' || u.reasonCode === 'not_connected' || !input.connected) return null;
  const { server } = input;
  const W = AGENT_UPDATE_WORDS;
  const at = u.updatedAt ? Date.parse(u.updatedAt) : Number.NaN;
  const updated =
    Number.isFinite(at) && input.now - at <= AGENT_UPDATED_SHOWN_MS
      ? W.updated(formatAgoIso(u.updatedAt as string, input.now))
      : null;
  const out = (
    text: string,
    tone: AgentUpdateTone,
    action: AgentUpdateAction | null = null,
    command = false,
  ): AgentUpdatesView => ({
    text,
    tone,
    updated,
    action: action ? { kind: action, label: ACTION_LABEL[action] } : null,
    command,
  });
  const needsInstall = u.reasonCode === 'no_key' || u.reasonCode === 'other_key';

  if (u.state === 'updating') return out(W.updating, 'mut');
  // The server's own owner said no (AU-06): nothing Whombat can press changes that.
  if (u.reasonCode === 'turned_off') return out(W.turnedOff(server), 'mut');
  if (u.state === 'failed')
    return needsInstall && !u.canInstall ? out(W.failed, 'bad', null, true) : out(W.failed, 'bad', 'retry');
  if (needsInstall)
    return u.canInstall ? out(W.needsInstall, 'warn', 'install') : out(W.needsInstall, 'warn', null, true);
  if (u.state === 'halted') return out(W.halted, 'warn', 'now');
  if (u.state === 'waiting') return out(W.waiting[u.waitingFor ?? 'task'](server), 'mut');
  if (u.available) {
    if (input.autoUpdate === false) return out(W.autoOff, 'warn', 'now');
    return out(W.soon, 'mut');
  }
  return out(input.autoUpdate === false ? W.upToDate : W.kept, 'ok');
}

const ACTION_LABEL: Record<AgentUpdateAction, string> = {
  retry: AGENT_UPDATE_WORDS.retry,
  install: AGENT_UPDATE_WORDS.install,
  now: AGENT_UPDATE_WORDS.now,
};

/** Whether the row's server is being updated (read its settings again soon). */
export function agentUpdating(u: HostAgentUpdate | null | undefined): boolean {
  return u?.state === 'updating';
}

/** How often the server's settings are read again while its agent updates (its end isn't a frame of its own). */
export const AGENT_UPDATE_POLL_MS = 5000;

/* The switch (AU-06) --------------------------------------------------------------------------------------------- */

export interface AgentSettingsView {
  title: string;
  meta: string;
  on: boolean;
  /** Stopped after a version didn't come back (AU-05): the meta says so in amber. */
  tone: 'ok' | 'warn' | 'mut';
}

export function agentSettingsView(s: HostAgentSettings): AgentSettingsView {
  const W = AGENT_UPDATE_WORDS;
  const halted = s.autoUpdate && s.halted;
  return {
    title: W.switchTitle,
    meta: halted ? W.switchHalted : s.autoUpdate ? W.switchOn : W.switchOff,
    on: s.autoUpdate,
    tone: halted ? 'warn' : s.autoUpdate ? 'ok' : 'mut',
  };
}
