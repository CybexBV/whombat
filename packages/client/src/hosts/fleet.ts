/**
 * Every guest of every server in one list (ported from Rackoon's `features/guests/GuestsPage.tsx`; `hosts.listGuests`):
 * the sort a column click gives, the query the filters make, and the line under the table. Pure.
 */
import type { HostGuest, HostGuestState } from '@whombat/core/domain';
import { plural } from './format';

export type GuestSortKey = 'name' | 'server' | 'state' | 'cpu' | 'memory';

export const GUEST_SORT_WORDS: Record<GuestSortKey, string> = {
  name: 'name',
  server: 'server',
  state: 'state',
  cpu: 'CPU',
  memory: 'memory',
};

/** Keys that sort high to low unless asked otherwise (the hub's defaults). */
const DESC_FIRST = new Set<string>(['cpu', 'memory']);

/** `sort` (“cpu”, “-name”, “+memory”) as its key and direction; unknown keys are CPU. */
export function parseGuestSort(sort: string | undefined): { key: GuestSortKey; desc: boolean } {
  const raw = (sort ?? '').replace(/^[-+]/, '');
  const key = (raw in GUEST_SORT_WORDS ? raw : 'cpu') as GuestSortKey;
  const desc = sort?.startsWith('-') ? true : sort?.startsWith('+') ? false : DESC_FIRST.has(key);
  return { key, desc };
}

/** The sort after clicking a column: the same column flips, another starts in its natural direction. */
export function nextGuestSort(current: string | undefined, key: GuestSortKey): string {
  const cur = parseGuestSort(current);
  if (cur.key !== key) return key;
  const desc = !cur.desc;
  return desc === DESC_FIRST.has(key) ? key : `${desc ? '-' : '+'}${key}`;
}

export const GUEST_PAGE_SIZE = 100;

export interface FleetGuestFilters {
  q?: string;
  state?: string;
  server?: string;
  tag?: string;
  sort?: string;
}

const STATES: readonly HostGuestState[] = ['running', 'stopped', 'unhealthy', 'paused'];

/** `hosts.listGuests`' query for the filters and a page's cursor; empty filters stay out. */
export function fleetGuestQuery(f: FleetGuestFilters, cursor?: string) {
  const state = STATES.find((s) => s === f.state);
  const sort = f.sort && f.sort !== 'cpu' ? f.sort : undefined;
  return {
    ...(f.q?.trim() ? { q: f.q.trim() } : {}),
    ...(state ? { state } : {}),
    ...(f.server ? { server: f.server } : {}),
    ...(f.tag ? { tag: f.tag } : {}),
    ...(sort ? { sort } : {}),
    limit: GUEST_PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  };
}

/** The tags facet as a sorted list (tag → guests with it). */
export function tagFacet(tags: Record<string, number> | undefined): { tag: string; count: number }[] {
  return Object.entries(tags ?? {})
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

/** “1–100 of 133 guests on 4 servers, by CPU”. */
export function fleetFootText(
  page: number,
  shown: readonly Pick<HostGuest, 'serverId'>[],
  total: number,
  sort: string | undefined,
): string {
  const from = page * GUEST_PAGE_SIZE + 1;
  const to = page * GUEST_PAGE_SIZE + shown.length;
  const servers = plural(new Set(shown.map((g) => g.serverId)).size, 'server');
  const by = GUEST_SORT_WORDS[parseGuestSort(sort).key];
  return `${from}–${to} of ${plural(total, 'guest')} on ${servers}, by ${by}`;
}
