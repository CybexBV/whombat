/**
 * Page turning (DK-133), pure with the clock passed in: *When touched* goes back to the first page after two minutes
 * untouched; *Every 30 seconds* and *Every minute* turn by themselves and wait while someone touches the screen.
 */
import type { DeskTurn } from './types';

/** Seconds between pages turning by themselves (the contract's `DESK_TURN_S`). */
export const TURN_S: Readonly<Record<DeskTurn, number | null>> = { touch: null, '30s': 30, '60s': 60 };
/** A screen that turns when touched goes back to its first page after this long untouched (`DESK_FIRST_PAGE_AFTER_S`). */
export const FIRST_PAGE_AFTER_S = 120;

export interface Pager {
  page: number;
  /** When this page came up, and when the screen was last touched (ms). */
  shownAt: number;
  touchedAt: number;
}

export function pagerStart(now: number): Pager {
  return { page: 0, shownAt: now, touchedAt: now };
}

const quietSince = (p: Pager) => Math.max(p.shownAt, p.touchedAt);

/** The pager at `now`: the next page when it's time, back to the first after a while, within `count` pages. */
export function pagerTick(p: Pager, now: number, count: number, turn: DeskTurn): Pager {
  const n = Math.max(1, count);
  let page = Math.min(p.page, n - 1);
  let shownAt = page === p.page ? p.shownAt : now;
  const every = TURN_S[turn];
  const quiet = now - Math.max(shownAt, p.touchedAt);
  if (every !== null && n > 1 && quiet >= every * 1000) {
    page = (page + 1) % n;
    shownAt = now;
  } else if (every === null && page !== 0 && quiet >= FIRST_PAGE_AFTER_S * 1000) {
    page = 0;
    shownAt = now;
  }
  return page === p.page && shownAt === p.shownAt ? p : { ...p, page, shownAt };
}

/** Someone touched the screen: the turning waits. */
export function pagerTouch(p: Pager, now: number): Pager {
  return { ...p, touchedAt: now };
}

/** A page chosen (a name touched, a swipe): it counts as a touch. */
export function pagerGo(page: number, count: number, now: number): Pager {
  const n = Math.max(1, count);
  return { page: ((page % n) + n) % n, shownAt: now, touchedAt: now };
}

/** How far the page is to turning by itself, 0…1; null when it turns only when touched. */
export function pagerProgress(p: Pager, now: number, turn: DeskTurn): number | null {
  const every = TURN_S[turn];
  if (every === null) return null;
  return Math.max(0, Math.min(1, (now - quietSince(p)) / (every * 1000)));
}
