/**
 * The status sentence in the fixture world (status-line.md): how Mara's Whombat is and what Neo finished today.
 *
 * - `VITE_FIXTURE_STATUS=good` or `whombat:fixture-status` = `good`: nothing open, every thing fine, so the sentence is
 *   “All good. I fixed 1 thing overnight. I’m adding your Daikin heat pump.” Otherwise the world as it is: blackbox's
 *   disk array failed, two more things need Mara.
 * - `VITE_FIXTURE_DONE=0` or `whombat:fixture-done` = `0`: nothing done today, so nothing was fixed. Otherwise
 *   four things, one of them a fix in the night and one with Undo.
 */
import { localAt } from '@whombat/client';
import { chatThreadHref, type DoneTodayItem, type HomeOverview } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { DISK_THREAD, PVE_THREAD } from './chatChannelFixtures';

const TZ = 'Europe/Amsterdam';
const HOME = `/api/v1/burrows/${burrow.slug}/home`;

export const STATUS_FIXTURE_KEY = 'whombat:fixture-status';
export const DONE_FIXTURE_KEY = 'whombat:fixture-done';

export interface StatusFixture {
  /** Nothing open and every thing fine. */
  good: boolean;
  /** Neo finished things today. */
  done: boolean;
}

function stored(key: string): string | null {
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
}

export function statusFixture(): StatusFixture {
  return {
    good: (import.meta.env.VITE_FIXTURE_STATUS ?? stored(STATUS_FIXTURE_KEY)) === 'good',
    done: (import.meta.env.VITE_FIXTURE_DONE ?? stored(DONE_FIXTURE_KEY)) !== '0',
  };
}

/** What Neo finished today, newest first; `at(day, 'hh:mm')` is the world's local time. */
export function doneTodayFixture(at: (day: number, hhmm: string) => string): DoneTodayItem[] {
  return [
    {
      id: 'dnt_nextcloud-memory',
      text: 'Gave nextcloud more memory',
      at: at(0, '10:12'),
      href: chatThreadHref('chat', PVE_THREAD),
      // The world's change of the same name, which Undo puts back.
      undo: { changeId: 'chg_nextcloud-memory' },
    },
    {
      id: 'dnt_disk-guests',
      text: 'Found which guests use the most disk',
      at: at(0, '09:40'),
      href: chatThreadHref('chat', DISK_THREAD),
    },
    { id: 'dnt_zigbee', text: 'Restarted Zigbee in Home Assistant', at: at(0, '03:12'), fixed: true },
    { id: 'dnt_pve-01-updates', text: 'Installed security updates on pve-01', at: at(0, '03:00') },
  ];
}

/** The overview as the fixture says: all good (nothing open, things fine) and with or without Done today. */
export function withStatusFixture(
  overview: HomeOverview,
  fixture: StatusFixture,
  at: (day: number, hhmm: string) => string,
): HomeOverview {
  const done = fixture.done ? { doneToday: doneTodayFixture(at) } : {};
  if (!fixture.good) return { ...overview, ...done };
  return {
    ...overview,
    ...done,
    summary: { needsYou: 0, working: overview.summary.working, problems: 0 },
    needsYou: [],
    things: overview.things.map(({ reason: _reason, ...t }) =>
      t.status === 'ok' || t.status === 'learning' ? t : { ...t, status: 'ok' },
    ),
  };
}

/** A layer over the world's `home.overview` answers (`createWebFixtureFetch`). */
export function statusFixtureLayer(fixture: StatusFixture = statusFixture()) {
  const made = Date.now();
  const at = (day: number, hhmm: string) => localAt(made, TZ, hhmm, day);
  return async (req: Request, res: Response): Promise<Response> => {
    if (req.method !== 'GET' || new URL(req.url).pathname !== HOME || !res.ok) return res;
    const overview = (await res.json()) as HomeOverview;
    return Response.json(withStatusFixture(overview, fixture, at), { status: res.status });
  };
}
