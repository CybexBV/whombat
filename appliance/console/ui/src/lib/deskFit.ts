/**
 * One glance that fits what there is (Whombat desk-display.md DK-37…DK-41, DK-82; appliance CG-135…, CG-232, CG-254):
 * the room under the glance's top part (the top bar, the hero, and Working on / Done today when they show) is shared by
 * the servers, the home tiles and This Whombat. Servers first, three to a row in up to three rows (DK-82), then tiles
 * in at most two rows of four; This Whombat is the panel below them when it fits, else a card first among the servers;
 * it is left out only when neither fits at all (DK-39). Among the arrangements that fit, one with a row of servers to
 * count the others under wins while there are servers (DK-38: servers left out are counted under the servers), then
 * the one that leaves out the fewest servers and tiles, then the one with This Whombat as the panel, then the one with
 * fewer rows (DK-38), then the one that leaves out fewer servers (servers first). Pure: the page measures the room and
 * draws the plan.
 *
 * Found on your network (Whombat desk-found.md DF-06, CG-232): on a glance without servers and tiles it is the panel
 * where This Whombat would be (two rows of four cards, one row when two don't fit, else the strip); beside servers or
 * tiles it is the one-line strip after the tiles, shown when it fits once This Whombat, the servers and the tiles have
 * their room (it never pushes one out), and before This Whombat's panel is preferred over its card.
 */

/**
 * Heights in layout px, as `desk.module.css` fixes them (`.server`, `.tile`, `.moreServers`, the servers' grid) and
 * This Whombat's panel's parts add up: its padding and edge (18 + 20 + 2), its head (the 34 px logo tile), the gap
 * between its parts, the figures in one row without the chart (CG-59) and the network line, which a panel too short for
 * all of them drops (CG-142). `deskFit.test.ts` reads the stylesheet so the two can't drift apart.
 */
const PANEL = { edge: 40, head: 34, gap: 16, figs: 133, foot: 18 } as const;

export const FIT = {
  /** A server card: its head and CPU, MEM and DISK on lines of their own (DK-80); This Whombat's card is one too. */
  server: 148,
  /** Between the server cards, across and down: they are one grid, so their bars line up (DK-82). */
  serverGap: 14,
  tile: 73,
  /** The “+N more” line, and how far it tucks up under the servers (its negative top margin). */
  more: 16,
  moreTuck: 10,
  /** This Whombat as the panel at its shortest: the head and the figures in one row, no chart, no network line. */
  panel: PANEL.edge + PANEL.head + PANEL.gap + PANEL.figs,
  /** Its parts, for the stylesheet's check. */
  panelParts: PANEL,
  /** From this height on the panel has its network line too (the stylesheet's container query, CG-142). */
  panelWithFoot: PANEL.edge + PANEL.head + PANEL.gap + PANEL.figs + PANEL.gap + PANEL.foot,
  /** Server cards in a row and rows of them at most (DK-82): This Whombat's card and eight servers. */
  serversPerRow: 3,
  serverRows: 3,
  /** Tiles in a row, and rows of tiles, at most (DK-40). */
  perRow: 4,
  rows: 2,
} as const;

/**
 * Found on your network (CG-232): the panel's padding and edge (18 + 18 + 2), its head (the 34 px icon tile), the gap
 * between its parts, a card at its shortest (the compact card: the mark beside the name, CG-233), the gap between
 * cards and the footer's button; the strip, one line. `deskFit.test.ts` reads the stylesheet for them.
 */
export const FOUND_FIT = {
  edge: 38,
  head: 34,
  gap: 16,
  card: 106,
  cardGap: 14,
  foot: 38,
  strip: 62,
} as const;
const FOUND = FOUND_FIT;

/** The found panel's height at its shortest with `rows` rows of cards, with the footer once the scan is done. */
export function foundPanelHeight(rows: number, looking: boolean): number {
  const grid = rows * FOUND.card + Math.max(0, rows - 1) * FOUND.cardGap;
  return FOUND.edge + FOUND.head + FOUND.gap + grid + (looking ? 0 : FOUND.gap + FOUND.foot);
}

/** The most of each the screen gets from Whombat (DK-41): four and the next four. */
export const FIT_MAX = 8;
/** The most server cards the glance draws (DK-82): three rows of three. */
const CARDS_MAX = FIT.serversPerRow * FIT.serverRows;

export interface FitInput {
  /** The room under the glance's top part, layout px. */
  height: number;
  /** The gap between rows (the glance's own). */
  gap: number;
  /** Servers the page has (`servers` and `extraServers`), worst first. */
  servers: number;
  /** Servers Whombat didn't send at all (`moreServers` less `extraServers`): always counted in “+N more”. */
  unsent: number;
  /** Tiles the page has (`tiles` and `extraTiles`). */
  tiles: number;
  /** There is a This Whombat (`box` or `self`). */
  box: boolean;
  /** Found on your network shows (`glance.found`, DF-06); `looking`: the first scan still runs (no footer, DF-07). */
  found?: { looking: boolean } | null;
}

export type BoxAs = 'panel' | 'card' | 'none';

/** Found on your network: the panel (DF-06, frames 1–2), the one-line strip (frame 3), or not shown. */
export type FoundAs = 'panel' | 'strip' | 'none';

export interface FitPlan {
  /** How many servers and tiles show: the first ones. */
  servers: number;
  tiles: number;
  /** This Whombat: the panel under the rows, a card first among the servers, or left out. */
  box: BoxAs;
  /**
   * Cards per row: the servers' rows (This Whombat's card counted, first in the first row; filled from the left, every
   * card a third of the width, DK-82), then the tiles'.
   */
  serverRows: number[];
  tileRows: number[];
  /** “+N more” under the servers: every server not shown; 0 is no line (nor without a server row to sit under). */
  more: number;
  /** Found on your network: the panel (in place of This Whombat), the strip after the tiles, or none. */
  found: FoundAs;
  /** The panel's rows of cards: 2, or 1 when two don't fit; 0 without the panel. */
  foundRows: number;
}

/** Room left unused that still counts as fitting (sub-pixel rounding of the measured room). */
const SLACK = 0.5;

/**
 * Rows for `n` tiles (DK-40): up to four share one row; five to eight make two rows as even as can be, the longer one
 * first (5 → 3 + 2, 6 → 3 + 3, 7 → 4 + 3).
 */
export function rowsOf(n: number): number[] {
  if (n <= 0) return [];
  if (n <= FIT.perRow) return [n];
  return [Math.ceil(n / 2), Math.floor(n / 2)];
}

/** Rows for `n` server cards (DK-82): three to a row, filled from the left (4 → 3 + 1, 8 → 3 + 3 + 2). */
export function serverRowsOf(n: number): number[] {
  const rows: number[] = [];
  for (let left = Math.max(0, Math.floor(n)); left > 0; left -= FIT.serversPerRow)
    rows.push(Math.min(FIT.serversPerRow, left));
  return rows;
}

/** The columns a row of `n` tiles divides the width into: its tiles, but a tile alone takes half (DK-40). */
export const columnsOf = (n: number): number => Math.max(2, n);

/** The servers' grid's height with `rows` rows of cards. */
export const serversHeight = (rows: number): number =>
  rows <= 0 ? 0 : rows * FIT.server + (rows - 1) * FIT.serverGap;

/**
 * The height a plan takes in the room: the rows, the line and the strip stacked with the gap, the panels at their
 * shortest (`looking`: the found panel without its footer).
 */
export function planHeight(plan: FitPlan, gap: number, looking = false): number {
  const parts = [
    ...(plan.serverRows.length > 0 ? [serversHeight(plan.serverRows.length)] : []),
    ...plan.tileRows.map(() => FIT.tile),
    ...(plan.found === 'strip' ? [FOUND.strip] : []),
  ];
  let h = parts.reduce((a, b) => a + b, 0) + gap * Math.max(0, parts.length - 1);
  if (plan.more > 0) h += gap + FIT.more - FIT.moreTuck;
  if (plan.box === 'panel') h += (parts.length > 0 ? gap : 0) + FIT.panel;
  if (plan.found === 'panel') h += (parts.length > 0 ? gap : 0) + foundPanelHeight(plan.foundRows, looking);
  return h;
}

const RANK: Record<BoxAs, number> = { panel: 0, card: 1, none: 2 };

const whole = (n: number, max: number) => Math.max(0, Math.min(max, Math.floor(Number.isFinite(n) ? n : 0)));

function arrange(
  servers: number,
  tiles: number,
  box: BoxAs,
  all: number,
  unsent: number,
  strip: boolean,
): FitPlan | null {
  const cards = servers + (box === 'card' ? 1 : 0);
  if (cards > CARDS_MAX) return null;
  const serverRows = serverRowsOf(cards);
  const left = all - servers + unsent;
  return {
    servers,
    tiles,
    box,
    serverRows,
    tileRows: rowsOf(tiles),
    more: serverRows.length > 0 ? left : 0,
    found: strip ? 'strip' : 'none',
    foundRows: 0,
  };
}

const NOTHING: FitPlan = {
  servers: 0,
  tiles: 0,
  box: 'none',
  serverRows: [],
  tileRows: [],
  more: 0,
  found: 'none',
  foundRows: 0,
};

/** The arrangement for the room (DK-38…DK-40). */
export function planFit(input: FitInput): FitPlan {
  const all = whole(input.servers, FIT_MAX);
  const tiles = whole(input.tiles, FIT_MAX);
  const unsent = whole(input.unsent, Number.MAX_SAFE_INTEGER);
  const room = Number.isFinite(input.height) ? input.height + SLACK : 0;
  const gap = Number.isFinite(input.gap) ? Math.max(0, input.gap) : 0;
  const found = input.found ?? null;
  // Nothing connected yet: the found panel where This Whombat would be (DF-06), two rows of cards, else one, else the
  // strip; This Whombat makes way for it.
  if (found && all === 0 && tiles === 0) {
    for (const rows of [2, 1]) {
      if (foundPanelHeight(rows, found.looking) <= room)
        return { ...NOTHING, found: 'panel', foundRows: rows };
    }
    return FOUND.strip <= room ? { ...NOTHING, found: 'strip' } : NOTHING;
  }
  const strips = found ? [true, false] : [false];
  const best = (modes: BoxAs[]): FitPlan | null => {
    let pick: { plan: FitPlan; key: number[] } | null = null;
    for (const mode of modes) {
      for (const strip of strips) {
        for (let s = all; s >= 0; s--) {
          for (let t = tiles; t >= 0; t--) {
            const plan = arrange(s, t, mode, all, unsent, strip);
            if (!plan || planHeight(plan, gap) > room) continue;
            const key = [
              all > 0 && plan.serverRows.length === 0 ? 1 : 0,
              all - s + tiles - t,
              found && !strip ? 1 : 0,
              RANK[mode],
              plan.serverRows.length + plan.tileRows.length,
              all - s,
            ];
            if (!pick || less(key, pick.key)) pick = { plan, key };
          }
        }
      }
    }
    return pick?.plan ?? null;
  };
  // This Whombat shows whenever the panel or its card fits at all (DK-39).
  const plan = (input.box ? best(['panel', 'card']) : null) ?? best(['none']);
  return plan ?? NOTHING;
}

function less(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
