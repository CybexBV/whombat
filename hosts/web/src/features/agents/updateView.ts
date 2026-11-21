// Agent self-update status for the agents list (GET /agents `update`, SSE
// `agent.update`): only agents older than the hub's build show anything.

import type { AgentInfo } from '../../api/types';
import { t } from '../../lib/i18n';

export interface UpdateView {
  /** busy: a rollout runs now; failed: the last one failed; available / blocked: older than the hub's build. */
  kind: 'none' | 'busy' | 'failed' | 'available' | 'blocked';
  /** The hub's agent build. */
  version?: string;
  /** Rollout message, or why this agent cannot update itself. */
  text?: string;
  /** The Update button works. */
  canUpdate: boolean;
}

export function updateView(a: Pick<AgentInfo, 'version' | 'connected' | 'update'>): UpdateView {
  const u = a.update;
  if (!u) return { kind: 'none', canUpdate: false };
  if (u.state === 'updating') return { kind: 'busy', version: u.version, text: u.message || t('Updating…'), canUpdate: false };
  if (u.state === 'failed') return { kind: 'failed', version: u.version, text: u.message || t('The update failed'), canUpdate: u.available };
  if (u.available) return { kind: 'available', version: u.version, canUpdate: true };
  // No build on the hub, offline, or already on it: nothing to say here.
  if (!u.version || !a.connected || a.version === u.version || u.reason === 'Up to date.') return { kind: 'none', canUpdate: false };
  return { kind: 'blocked', version: u.version, text: u.reason, canUpdate: false };
}

/** Agents "Update all" would update now. */
export function updatableCount(list: readonly Pick<AgentInfo, 'version' | 'connected' | 'update'>[]): number {
  return list.filter((a) => updateView(a).canUpdate).length;
}

/** The rollout runs (one agent at a time). */
export function rolloutRunning(list: readonly Pick<AgentInfo, 'update'>[]): boolean {
  return list.some((a) => a.update?.state === 'updating');
}
