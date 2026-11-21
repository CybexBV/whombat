/**
 * Power for several guests at once (ported from Rackoon's `features/manage/bulk.ts` and `BulkBar`): which action each
 * selected guest gets for Start · Shut down · Restart · Stop (the power menu's rules, by platform and state), which are
 * skipped, three at a time, and the one toast at the end. Pure; the web's bar runs it.
 */
import type { HostGuest, HostGuestAction } from '@whombat/core/domain';
import { plural } from './format';
import { powerActions } from './model';

export type BulkKind = 'start' | 'shutdown' | 'reboot' | 'stop';
export const BULK_KINDS: readonly BulkKind[] = ['start', 'shutdown', 'reboot', 'stop'];

export const BULK_WORDS: Record<BulkKind, { label: string; none: string }> = {
  start: { label: 'Start', none: 'None of them is switched off.' },
  shutdown: { label: 'Shut down', none: 'None of them is running.' },
  reboot: { label: 'Restart', none: 'None of them is running.' },
  stop: { label: 'Stop…', none: 'None of them is running.' },
};

type G = Pick<HostGuest, 'platform' | 'kind' | 'state' | 'name'>;

/** The action a guest gets for a bulk command, or null when it doesn't apply (already off, paused for Shut down). */
export function bulkAction(kind: BulkKind, g: G): HostGuestAction | null {
  const can = new Set(powerActions(g).map((a) => a.action));
  const first = (...xs: HostGuestAction[]) => xs.find((x) => can.has(x)) ?? null;
  switch (kind) {
    case 'start':
      return first('start');
    case 'shutdown':
      return g.state === 'paused' ? null : first('shutdown', 'stop');
    case 'reboot':
      return first('reboot', 'restart');
    default:
      return first('force_stop', 'stop');
  }
}

export interface BulkGuest {
  server: string;
  guest: Pick<HostGuest, 'id' | 'name' | 'platform' | 'kind' | 'state'>;
  /** The viewer may power guests on this guest's server. */
  power: boolean;
}

export interface BulkPlan {
  run: { item: BulkGuest; action: HostGuestAction }[];
  skipped: BulkGuest[];
}

export function bulkPlan(kind: BulkKind, items: readonly BulkGuest[]): BulkPlan {
  const plan: BulkPlan = { run: [], skipped: [] };
  for (const item of items) {
    const action = item.power ? bulkAction(kind, item.guest) : null;
    if (action) plan.run.push({ item, action });
    else plan.skipped.push(item);
  }
  return plan;
}

/** Everything but Start is asked first, with the guests' names. */
export const bulkConfirms = (kind: BulkKind): boolean => kind !== 'start';

export function bulkQuestion(kind: BulkKind, n: number): { title: string; body: string; action: string } {
  const guests = plural(n, 'guest');
  switch (kind) {
    case 'shutdown':
      return {
        title: `Shut down ${guests}?`,
        body: `${n === 1 ? 'It closes' : 'Each one closes'} its programs first. Open consoles close.`,
        action: `Shut down ${guests}`,
      };
    case 'reboot':
      return {
        title: `Restart ${guests}?`,
        body: `${n === 1 ? 'It’s' : 'Each one is'} down for a moment while it restarts.`,
        action: `Restart ${guests}`,
      };
    default:
      return {
        title: `Stop ${guests}?`,
        body: `${n === 1 ? 'It’s' : 'Each one is'} switched off at once, like pulling the plug: anything unsaved is lost.`,
        action: `Stop ${guests}`,
      };
  }
}

const STARTED: Record<BulkKind, string> = {
  start: 'Starting',
  shutdown: 'Shutting down',
  reboot: 'Restarting',
  stop: 'Stopping',
};

/**
 * The one toast after a bulk command: “Restarting 3 guests.”, or how many went and which didn't, with why
 * (“Restarting 2 of 3 guests. Not web: The agent isn’t connected.”).
 */
export function bulkDoneText(
  kind: BulkKind,
  total: number,
  failed: readonly { name: string; message: string }[],
): string {
  if (!failed.length) return `${STARTED[kind]} ${plural(total, 'guest')}.`;
  const not = failed
    .slice(0, 3)
    .map((f) => (f.message ? `${f.name}: ${f.message.replace(/\.$/, '')}` : f.name))
    .join('; ');
  const more = failed.length > 3 ? ` and ${failed.length - 3} more` : '';
  if (failed.length === total) return `Nothing happened. Not ${not}${more}.`;
  return `${STARTED[kind]} ${total - failed.length} of ${plural(total, 'guest')}. Not ${not}${more}.`;
}

/** Run `fn` over `items`, at most `limit` at a time, in order. */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
