/**
 * Page turning (DK-133), pure with the clock passed in: *When touched* goes back to the screen's home after two
 * minutes untouched; *Every 30 seconds* and *Every minute* turn by themselves and wait while someone touches the screen.
 * Pages turn within the rotation (`times.ts`): a page whose window closed goes home, and a window opening takes the
 * screen to its page once (after the screen rested a moment, so it never jumps under someone's finger).
 */
import { everyPage, type Rotation } from './times';
import type { DeskTurn } from './types';

/** Seconds between pages turning by themselves (the contract's `DESK_TURN_S`). */
export const TURN_S: Readonly<Record<DeskTurn, number | null>> = { touch: null, '30s': 30, '60s': 60 };
/** A screen that turns when touched goes back to its first page after this long untouched (`DESK_FIRST_PAGE_AFTER_S`). */
export const FIRST_PAGE_AFTER_S = 120;
/** A window that opens while someone touches the screen waits this long after the last touch. */
export const WINDOW_WAITS_TOUCH_S = 30;

export interface Pager {
  /** The page shown: its place in the layout. */
  page: number;
  /** When this page came up, and when the screen was last touched (ms). */
  shownAt: number;
  touchedAt: number;
  /** The pages whose window was open and taken to already: another opening takes the screen to its page. */
  open?: readonly string[] | undefined;
}

const rotationOf = (r: Rotation | number) => (typeof r === 'number' ? everyPage(r) : r);

/** The pager at `now`, at the rotation's home (a page whose window is open, else the first). */
export function pagerStart(now: number, rotation?: Rotation): Pager {
  return {
    page: rotation?.home ?? 0,
    shownAt: now,
    touchedAt: now,
    open: rotation?.open.map((o) => o.id) ?? [],
  };
}

const quietSince = (p: Pager) => Math.max(p.shownAt, p.touchedAt);
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The pager at `now` within the rotation (or `count` pages, all in it): to a page whose window just opened, the next
 * page when it's time, home after a while, a page out of the rotation home.
 */
export function pagerTick(p: Pager, now: number, rotation: Rotation | number, turn: DeskTurn): Pager {
  const r = rotationOf(rotation);
  // A page removed: the last one there is; a page out of the turning: home.
  let page = Math.min(p.page, r.count - 1);
  if (!r.pages.includes(page)) page = r.home;
  let shownAt = page === p.page ? p.shownAt : now;
  const was = p.open ?? [];
  const resting = now - p.touchedAt >= WINDOW_WAITS_TOUCH_S * 1000;
  const opened = resting ? r.open.find((o) => !was.includes(o.id)) : undefined;
  // What is open now and was seen; a window opening under someone's finger is seen once they let go.
  const open = r.open.map((o) => o.id).filter((id) => resting || was.includes(id));
  const every = TURN_S[turn];
  const quiet = now - Math.max(shownAt, p.touchedAt);
  if (opened) {
    if (opened.page !== page) shownAt = now;
    page = opened.page;
  } else if (every !== null && r.pages.length > 1 && quiet >= every * 1000) {
    page = r.pages[(r.pages.indexOf(page) + 1) % r.pages.length] ?? r.home;
    shownAt = now;
  } else if (every === null && page !== r.home && quiet >= FIRST_PAGE_AFTER_S * 1000) {
    page = r.home;
    shownAt = now;
  }
  const keepOpen = sameIds(open, was);
  if (page === p.page && shownAt === p.shownAt && keepOpen) return p;
  return { ...p, page, shownAt, open: keepOpen ? was : open };
}

/** Someone touched the screen: the turning waits. */
export function pagerTouch(p: Pager, now: number): Pager {
  return { ...p, touchedAt: now };
}

/** A page chosen (a name touched, a swipe): it counts as a touch. `page` is its place in the layout. */
export function pagerGo(page: number, count: number, now: number, from?: Pager): Pager {
  const n = Math.max(1, count);
  return { page: ((page % n) + n) % n, shownAt: now, touchedAt: now, open: from?.open ?? [] };
}

/** How far the page is to turning by itself, 0…1; null when it turns only when touched. */
export function pagerProgress(p: Pager, now: number, turn: DeskTurn): number | null {
  const every = TURN_S[turn];
  if (every === null) return null;
  return Math.max(0, Math.min(1, (now - quietSince(p)) / (every * 1000)));
}
