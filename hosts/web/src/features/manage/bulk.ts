// Bulk power actions (docs/MANAGE.md, Bulk actions): which power action each
// selected guest gets for Start · Shut down · Reboot · Stop, by kind and
// state (the row menu's rules), and which guests are skipped. Pure, unit
// tested; BulkBar.tsx runs them.

import type { Guest, PowerAction } from '../../api/types';
import { guestPowerActions } from '../guests/guestActions';

export type BulkKind = 'start' | 'shutdown' | 'reboot' | 'stop';
export const BULK_KINDS: BulkKind[] = ['start', 'shutdown', 'reboot', 'stop'];

type G = Pick<Guest, 'platform' | 'kind' | 'state'>;

/** The power action a guest gets for a bulk command, or null when it does not apply (already stopped, ...). */
export function bulkAction(kind: BulkKind, g: G): PowerAction | null {
  const vm = g.kind === 'vm';
  const want: PowerAction = kind === 'start' ? 'start' : kind === 'shutdown' ? (vm ? 'shutdown' : 'stop') : kind === 'reboot' ? (vm ? 'reboot' : 'restart') : vm ? 'force_stop' : 'stop';
  // A container's graceful stop is its only stop: "Shut down" covers running ones, "Stop" paused ones too.
  if (kind === 'shutdown' && g.state === 'paused') return null;
  return guestPowerActions(g).includes(want) ? want : null;
}

export interface BulkGuest {
  server: string;
  guest: Pick<Guest, 'id' | 'name' | 'platform' | 'kind' | 'state'>;
  /** The user may power guests on this guest's host. */
  power: boolean;
}

export interface BulkPlan {
  run: { item: BulkGuest; action: PowerAction }[];
  skipped: BulkGuest[];
}

export function bulkPlan(kind: BulkKind, items: BulkGuest[]): BulkPlan {
  const plan: BulkPlan = { run: [], skipped: [] };
  for (const item of items) {
    const action = item.power ? bulkAction(kind, item.guest) : null;
    if (action) plan.run.push({ item, action });
    else plan.skipped.push(item);
  }
  return plan;
}

/** Disruptive commands are confirmed with the guests' names first. */
export const bulkConfirms = (kind: BulkKind): boolean => kind !== 'start';

/** Run fn over items, at most `limit` at a time, in order. */
export async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
