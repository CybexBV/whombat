/**
 * The desk through a runtime restart (appliance CG-49): while Whombat restarts (an update, often at night) the console
 * server answers `desk: null` for a while. Once a paired desk was shown, the page keeps it — locked, without a sheet,
 * Talk or pairing letters — for up to 10 minutes, with “Reconnecting…” after 10 s; after that, or as soon as the box
 * isn't `claimed` or Whombat says nobody is paired, today's console. Pure: the page's clock comes in.
 */

import { english, type Translate } from '../i18n/translate';
import type { ConsoleState } from './api';
import { QUIET_MS } from './connection';
import type { DeskGlance, DeskLock, DeskLockedView, DeskState } from './desk';
import { deskWordsCopy, fill, screenWordsCopy } from './deskCopy';
import { bareAsk, isUnlocked } from './deskScene';
import { lockedGrid } from './grid';

export const DESK_HOLD_MS = 10 * 60_000;

/** The last paired desk the page showed, and since when Whombat sends none (page clock). */
export interface DeskHold {
  last: DeskState | null;
  missingSince: number | null;
}

export const NO_HOLD: DeskHold = { last: null, missingSince: null };

/** The memory after a poll. */
export function holdDesk(h: DeskHold, s: ConsoleState, now: number): DeskHold {
  if (s.desk) return s.desk.paired ? { last: s.desk, missingSince: null } : NO_HOLD;
  if (!h.last) return h;
  return h.missingSince === null ? { last: h.last, missingSince: now } : h;
}

export interface ShownDesk {
  /** The desk to draw, or null for today's console. */
  desk: DeskState | null;
  /** It is the last desk, kept through a restart: nothing to unlock or ask. */
  held: boolean;
  /** Whombat has been away for 10 s: the quiet “Reconnecting…” pill. */
  reconnecting: boolean;
}

/** What the console shows for a state, given the memory (`holdDesk` of the same state). */
export function shownDesk(
  h: DeskHold,
  s: ConsoleState,
  now: number,
  locked: DeskState | null = null,
  t: Translate = english,
): ShownDesk {
  if (s.desk) return { desk: s.desk, held: false, reconnecting: false };
  const gone = { desk: null, held: false, reconnecting: false };
  if (!h.last || h.missingSince === null || s.claim?.state !== 'claimed') return gone;
  const away = now - h.missingSince;
  if (away >= DESK_HOLD_MS) return gone;
  return { desk: locked ?? heldDesk(h.last, t), held: true, reconnecting: away >= QUIET_MS };
}

/**
 * The last desk as a locked screen shows it: the lock closed, no talk and no pairing letters; a glance seen unlocked is
 * trimmed to what the person's lock view lets show (the runtime's rule, DK-03), a locked one stays as Whombat sent it.
 * Quiet hours stay as they were (the night scene stays the night scene).
 */
export function lockedDesk(d: DeskState, t: Translate = english): DeskState {
  const SCREEN_WORDS = screenWordsCopy(t);

  const view = d.paired?.lockedView ?? 'summary';
  return {
    ...d,
    pairing: null,
    talk: null,
    lock: { state: 'locked', until: null, retryAt: null, expiresAt: null },
    glance:
      d.glance && d.lock.state === 'unlocked'
        ? trimGlance(
            d.glance,
            view,
            fill(SCREEN_WORDS.locked.ask, { assistant: d.paired?.assistant.name ?? '' }),
            t,
          )
        : d.glance,
  };
}

/**
 * The last desk through a restart: `lockedDesk`, and no camera looking (CG-173). Whombat runs the camera and isn't
 * there, so the camera is off (DK-72): no camera mark, and nobody seen keeps the glance up; the screen goes idle by
 * touch alone.
 */
export function heldDesk(d: DeskState, t: Translate = english): DeskState {
  return { ...lockedDesk(d, t), presence: undefined };
}

/**
 * A desk Whombat sent unlocked that the page can't vouch for any more (CG-51): the polls are failing (Whombat may have
 * locked it since), or its `until` has passed by Whombat's clock. The page then shows it as `lockedDesk` does.
 */
export function unlockLapsed(lock: DeskLock, serverNow: number, failing: boolean): boolean {
  return lock.state === 'unlocked' && (failing || !isUnlocked(lock, serverNow));
}

/**
 * `deskStatusLine` for `summary` and `time` from what the glance holds (the worst server is listed first). A new box
 * (no servers, no tiles, nothing asked, nothing worked on: `fresh`, DK-23) is ready, with the hint as its muted part;
 * *Only the time* stays as it was.
 */
function statusLine(g: DeskGlance, view: 'summary' | 'time', t: Translate = english): DeskGlance['status'] {
  const DESK_WORDS = deskWordsCopy(t);

  const s = DESK_WORDS.status;
  const n = g.needsYou.count;
  const bad = g.servers.find((x) => x.state === 'bad');
  const worst = bad ?? g.servers.find((x) => x.state === 'warn');
  if (view === 'time') return { text: n > 0 || worst ? s.somethingNeedsYou : s.allFine, more: null };
  const fresh = g.servers.length === 0 && g.tiles.length === 0 && n === 0 && g.working === null;
  if (fresh) return { text: s.ready, more: s.connectHint };
  const server = worst ? fill(bad ? s.down : s.look, { server: worst.name }) : null;
  const asks = n === 1 ? s.needsYouOne : n > 1 ? fill(s.needsYouMany, { n }) : null;
  const parts = bad ? [server, asks] : [asks, server];
  return { text: parts.filter((p): p is string => p !== null).join(' ') || s.fine, more: null };
}

/** A glance as the locked screen may show it (DK-03): what the runtime would have sent for the lock view. */
export function trimGlance(
  g: DeskGlance,
  view: DeskLockedView,
  askTitle = '',
  t: Translate = english,
): DeskGlance {
  // The screen of widgets as the lock view shows it (lockedGrid); the monitors' too.
  const screens = (v: DeskLockedView) => ({
    grid: g.grid ? lockedGrid(g.grid, v, askTitle) : null,
    outputs: (g.outputs ?? []).flatMap((o) => {
      const grid = lockedGrid(o.grid, v, askTitle);
      return grid ? [{ ...o, grid }] : [];
    }),
  });
  if (view === 'everything')
    return { ...g, needsYou: { ...g.needsYou, items: g.needsYou.items.map(bareAsk) }, ...screens(view) };
  const summary: DeskGlance = {
    ...g,
    status: statusLine(g, view, t),
    // What needs a look shows with the cards (DK-93), not in *Only the time*.
    needsYou: {
      count: g.needsYou.count,
      items: [],
      ...(view === 'summary' && g.needsYou.looks && { looks: g.needsYou.looks }),
    },
    working: null,
    done: [],
    ...screens(view),
  };
  // This Whombat and Found on your network show in *A summary* (DK-22, DK-39, DF-11), not in *Only the time* (DF-06).
  if (view === 'summary') return summary;
  return {
    ...summary,
    servers: [],
    moreServers: 0,
    tiles: [],
    box: null,
    self: null,
    extraServers: [],
    extraTiles: [],
    found: null,
  };
}
