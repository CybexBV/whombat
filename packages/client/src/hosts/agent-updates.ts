/**
 * Server agents keep themselves up to date, on the web and the phone (Whombat agent-updates.md AU-03…AU-09; app
 * agent-updates-app.md AP-2980…): the Agent card's Updates row — its words for each state and reason the hosts service
 * reports, and which button shows (Try again, Update the agent, Update now) or the install command to run once — and
 * the switch “Keep server agents up to date” in This Whombat → About → UPDATES. Owners act; the runtime must have
 * `hosts.agent_updates`. Pure.
 */
import type { HostAgentSettings, HostAgentUpdate } from '@whombat/core/domain';
import { clientTranslator } from '../i18n/catalog';
import { formatAgoIso } from './format';

/* The words (AU-06, AU-08) ------------------------------------------------------------------------------------- */

type Wait = NonNullable<HostAgentUpdate['waitingFor']>;

export function agentUpdateWords(locale?: string | null) {
  const tr = clientTranslator(locale);
  return {
    title: tr.t('hosts.agentUpdates.title'),
    kept: tr.t('hosts.agentUpdates.kept'),
    upToDate: tr.t('hosts.agentUpdates.upToDate'),
    updating: tr.t('hosts.agentUpdates.updating'),
    soon: tr.t('hosts.agentUpdates.soon'),
    waiting: {
      packages: (server: string) => tr.t('hosts.agentUpdates.waiting.packages', { server }),
      console: (server: string) => tr.t('hosts.agentUpdates.waiting.console', { server }),
      task: (server: string) => tr.t('hosts.agentUpdates.waiting.task', { server }),
    } as Record<Wait, (server: string) => string>,
    failed: tr.t('hosts.agentUpdates.failed'),
    halted: tr.t('hosts.agentUpdates.halted'),
    needsInstall: tr.t('hosts.agentUpdates.needsInstall'),
    turnedOff: (server: string) => tr.t('hosts.agentUpdates.turnedOff', { server }),
    autoOff: tr.t('hosts.agentUpdates.autoOff'),
    retry: tr.t('hosts.agentUpdates.retry'),
    install: tr.t('hosts.agentUpdates.install'),
    now: tr.t('hosts.agentUpdates.now'),
    showCommand: tr.t('hosts.agentUpdates.showCommand'),
    making: tr.t('hosts.agentUpdates.making'),
    commandNote: tr.t('hosts.agentUpdates.commandNote'),
    started: (state: 'updating' | 'installing', server: string) =>
      tr.t(
        state === 'installing'
          ? 'hosts.agentUpdates.startedInstalling'
          : 'hosts.agentUpdates.startedUpdating',
        { server },
      ),
    updated: (ago: string) => tr.t('hosts.agentUpdates.updated', { ago }),
    switchTitle: tr.t('hosts.agentUpdates.switchTitle'),
    switchOn: tr.t('hosts.agentUpdates.switchOn'),
    switchOff: tr.t('hosts.agentUpdates.switchOff'),
    switchHalted: tr.t('hosts.agentUpdates.switchHalted'),
    switched: (on: boolean) => tr.t(on ? 'hosts.agentUpdates.switchedOn' : 'hosts.agentUpdates.switchedOff'),
  };
}

export const AGENT_UPDATE_WORDS = agentUpdateWords();

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
  locale?: string | null;
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
 * The Updates row, or null when it doesn't show.
 */
export function agentUpdatesView(input: AgentUpdatesInput): AgentUpdatesView | null {
  const u = input.update;
  if (!u) return null;
  if (u.reasonCode === 'no_build' || u.reasonCode === 'not_connected' || !input.connected) return null;
  const { server, locale } = input;
  const W = agentUpdateWords(locale);
  const actionLabel: Record<AgentUpdateAction, string> = {
    retry: W.retry,
    install: W.install,
    now: W.now,
  };
  const at = u.updatedAt ? Date.parse(u.updatedAt) : Number.NaN;
  const updated =
    Number.isFinite(at) && input.now - at <= AGENT_UPDATED_SHOWN_MS
      ? W.updated(formatAgoIso(u.updatedAt as string, input.now, locale))
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
    action: action ? { kind: action, label: actionLabel[action] } : null,
    command,
  });
  const needsInstall = u.reasonCode === 'no_key' || u.reasonCode === 'other_key';

  if (u.state === 'updating') return out(W.updating, 'mut');
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

export function agentSettingsView(s: HostAgentSettings, locale?: string | null): AgentSettingsView {
  const W = agentUpdateWords(locale);
  const halted = s.autoUpdate && s.halted;
  return {
    title: W.switchTitle,
    meta: halted ? W.switchHalted : s.autoUpdate ? W.switchOn : W.switchOff,
    on: s.autoUpdate,
    tone: halted ? 'warn' : s.autoUpdate ? 'ok' : 'mut',
  };
}
