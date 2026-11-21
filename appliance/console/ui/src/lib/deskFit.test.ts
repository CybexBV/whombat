import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  columnsOf,
  FIT,
  type FitInput,
  FOUND_FIT,
  foundPanelHeight,
  planFit,
  planHeight,
  rowsOf,
  serverRowsOf,
  serversHeight,
} from './deskFit';

/** The room at 1280×800 under the mockup's hero with Working on and Done today (measured: 266.6 px). */
const WITH_ROW = 266.6;
/** Under the hero alone (A summary, Needs you with asks). */
const HERO_ONLY = 449;
/** On battery with every row (the tight gap): the old four and four exactly. */
const TIGHT = 208;

const plan = (p: Partial<FitInput>) =>
  planFit({ height: HERO_ONLY, gap: 18, servers: 0, unsent: 0, tiles: 0, box: false, ...p });

describe('rows (DK-40, DK-82)', () => {
  it('puts servers three to a row, filled from the left (DK-82)', () => {
    expect(serverRowsOf(0)).toEqual([]);
    expect(serverRowsOf(1)).toEqual([1]);
    expect(serverRowsOf(3)).toEqual([3]);
    expect(serverRowsOf(4)).toEqual([3, 1]);
    expect(serverRowsOf(8)).toEqual([3, 3, 2]);
    expect(serverRowsOf(9)).toEqual([3, 3, 3]);
    expect(serversHeight(2)).toBe(2 * FIT.server + FIT.serverGap);
  });

  it('puts up to four tiles in a row and balances five to eight over two, the longer first', () => {
    expect(rowsOf(0)).toEqual([]);
    expect(rowsOf(2)).toEqual([2]);
    expect(rowsOf(4)).toEqual([4]);
    expect(rowsOf(5)).toEqual([3, 2]);
    expect(rowsOf(6)).toEqual([3, 3]);
    expect(rowsOf(7)).toEqual([4, 3]);
    expect(rowsOf(8)).toEqual([4, 4]);
  });

  it('divides the width among a row’s tiles; a tile alone takes half', () => {
    expect([1, 2, 3, 4].map(columnsOf)).toEqual([2, 2, 3, 4]);
  });
});

describe('what gets the room (DK-38, DK-39)', () => {
  it('two servers and nothing else: both in one row, This Whombat the panel below', () => {
    const p = plan({ servers: 2, box: true });
    expect(p).toMatchObject({ servers: 2, box: 'panel', serverRows: [2], tileRows: [], more: 0 });
  });

  it('four servers, four tiles and Working on: This Whombat a card first and two servers in a row, two counted', () => {
    const p = plan({ height: WITH_ROW, servers: 4, tiles: 4, box: true });
    expect(p).toMatchObject({ servers: 2, tiles: 4, box: 'card', serverRows: [3], tileRows: [4], more: 2 });
  });

  it('seven servers and four tiles in “A summary”: the card and five in two rows, “+2 more” (mockup frame 1)', () => {
    const p = plan({ servers: 7, tiles: 4, box: true });
    expect(p).toMatchObject({
      servers: 5,
      tiles: 4,
      box: 'card',
      serverRows: [3, 3],
      tileRows: [4],
      more: 2,
    });
  });

  it('eight servers: the card and five in two rows, three counted; three rows with room, the panel with more', () => {
    expect(plan({ servers: 8, box: true })).toMatchObject({
      servers: 5,
      box: 'card',
      serverRows: [3, 3],
      more: 3,
    });
    // This Whombat's card and the eight fit exactly in three rows (DK-82).
    expect(plan({ height: serversHeight(3), servers: 8, box: true })).toMatchObject({
      servers: 8,
      box: 'card',
      serverRows: [3, 3, 3],
      more: 0,
    });
    expect(plan({ height: serversHeight(3) + 18 + FIT.panel, servers: 8, box: true })).toMatchObject({
      servers: 8,
      box: 'panel',
      serverRows: [3, 3, 2],
      more: 0,
    });
  });

  it('tiles only: two rows of tiles and the panel', () => {
    expect(plan({ tiles: 5, box: true })).toMatchObject({ tiles: 5, box: 'panel', tileRows: [3, 2] });
    expect(plan({ tiles: 8, box: true })).toMatchObject({ tiles: 8, box: 'panel', tileRows: [4, 4] });
  });

  it('a new box: the panel, a card when the panel can’t fit, nothing when no card can', () => {
    expect(plan({ box: true }).box).toBe('panel');
    expect(plan({ height: FIT.panel, box: true }).box).toBe('panel');
    expect(plan({ height: FIT.panel - 1, box: true })).toMatchObject({ box: 'card', serverRows: [1] });
    expect(plan({ height: FIT.server - 1, box: true }).box).toBe('none');
  });

  it('a runtime from before (no This Whombat): servers and tiles as sent, “+N more” for the ones not sent', () => {
    expect(plan({ height: WITH_ROW, servers: 4, tiles: 4 })).toMatchObject({
      servers: 3,
      tiles: 4,
      box: 'none',
      serverRows: [3],
      tileRows: [4],
      more: 1,
    });
    expect(plan({ height: TIGHT, gap: 14, servers: 4, tiles: 4 })).toMatchObject({
      servers: 3,
      tiles: 0,
      more: 1,
    });
    expect(plan({ servers: 4, unsent: 3, tiles: 2 })).toMatchObject({ servers: 4, tiles: 2, more: 3 });
  });

  it('This Whombat shows whenever its card fits, even if that leaves out a server', () => {
    const p = plan({ height: TIGHT, gap: 14, servers: 4, tiles: 4, box: true });
    expect(p.box).toBe('card');
    expect(p.servers).toBe(2);
    expect(p.more).toBe(2);
  });

  it('leaves out the fewest; then prefers the panel; then the servers', () => {
    // Room for two rows: four servers counted under the card and two and the four tiles leave out fewer than the tiles
    // and one more server.
    const two = FIT.server + 18 + FIT.more - FIT.moreTuck + 18 + FIT.tile;
    expect(plan({ height: two, servers: 6, tiles: 4, box: true })).toMatchObject({
      servers: 2,
      tiles: 4,
      box: 'card',
      more: 4,
    });
    // Everything fits either way: the panel.
    expect(plan({ height: 2000, servers: 8, tiles: 8, box: true }).box).toBe('panel');
    // As many left out with as many rows: the servers win (servers first).
    expect(plan({ height: serversHeight(2), servers: 6, tiles: 3 })).toMatchObject({ servers: 6, tiles: 0 });
  });

  it('keeps a row of servers to count the rest under while there are servers', () => {
    // Two rows of tiles would leave out fewer, but the server would vanish uncounted.
    const p = plan({ height: FIT.server + 18 + FIT.tile + 18 + FIT.tile - 1, servers: 1, tiles: 8 });
    expect(p.serverRows.length).toBe(1);
    expect(p.servers).toBe(1);
  });

  it('counts every server not shown, the ones not sent too, under a row of servers only', () => {
    const p = plan({ height: FIT.server + 18 + FIT.more - FIT.moreTuck, servers: 8, unsent: 2 });
    expect(p).toMatchObject({ servers: 3, serverRows: [3], more: 7 });
    expect(plan({ height: FIT.tile, tiles: 2, unsent: 0 }).more).toBe(0);
  });

  it('never plans more than the room', () => {
    for (let height = 0; height <= 700; height += 7) {
      for (const servers of [0, 1, 3, 4, 5, 8]) {
        for (const tiles of [0, 2, 4, 7, 8]) {
          for (const box of [false, true]) {
            const p = plan({ height, servers, tiles, box, unsent: servers === 8 ? 2 : 0 });
            expect(planHeight(p, 18)).toBeLessThanOrEqual(height + 0.5);
            expect(p.servers).toBeLessThanOrEqual(servers);
            expect(p.tiles).toBeLessThanOrEqual(tiles);
            expect(p.serverRows.reduce((a, b) => a + b, 0)).toBe(p.servers + (p.box === 'card' ? 1 : 0));
            // This Whombat is left out only when not even its card fits.
            if (box && height >= FIT.server + FIT.more - FIT.moreTuck + 18) expect(p.box).not.toBe('none');
          }
        }
      }
    }
  });
});

describe('found on your network (DF-06, CG-232)', () => {
  const done = { looking: false };
  const looking = { looking: true };

  it('nothing connected: the panel in This Whombat’s place, two rows, one when two don’t fit, else the strip', () => {
    expect(plan({ box: true, found: done })).toMatchObject({ box: 'none', found: 'panel', foundRows: 2 });
    expect(plan({ height: WITH_ROW, box: true, found: done })).toMatchObject({
      found: 'panel',
      foundRows: 1,
    });
    const one = foundPanelHeight(1, false);
    expect(plan({ height: one, box: true, found: done })).toMatchObject({ found: 'panel', foundRows: 1 });
    expect(plan({ height: one - 1, box: true, found: done })).toMatchObject({ found: 'strip', box: 'none' });
    expect(plan({ height: FOUND_FIT.strip - 1, box: true, found: done }).found).toBe('none');
  });

  it('while the first scan looks the panel has no footer, so it fits sooner', () => {
    const h = foundPanelHeight(2, true);
    expect(h).toBeLessThan(foundPanelHeight(2, false));
    expect(plan({ height: h, box: true, found: looking })).toMatchObject({ found: 'panel', foundRows: 2 });
    expect(plan({ height: h, box: true, found: done }).foundRows).toBe(1);
  });

  it('beside servers or tiles: the strip after them when it fits (frame 3), This Whombat as before', () => {
    const frame3 = plan({ servers: 2, tiles: 4, found: done });
    expect(frame3).toMatchObject({ servers: 2, tiles: 4, found: 'strip', serverRows: [2], tileRows: [4] });
    // With This Whombat its card joins the servers (the panel doesn't fit under the strip), the strip still shows.
    expect(plan({ servers: 2, tiles: 4, box: true, found: done })).toMatchObject({
      box: 'card',
      serverRows: [3],
      found: 'strip',
    });
    // Room for everything: the panel and the strip.
    expect(plan({ height: 2000, servers: 2, tiles: 4, box: true, found: done })).toMatchObject({
      box: 'panel',
      found: 'strip',
    });
  });

  it('the strip never pushes out a server, a tile or This Whombat; it goes before the panel does', () => {
    // The mockup's full glance: no room for the strip after the card, three servers and four tiles.
    const full = plan({ height: WITH_ROW, servers: 4, tiles: 4, box: true, found: done });
    expect(full).toMatchObject({ servers: 2, tiles: 4, box: 'card', found: 'none' });
    expect(plan({ height: TIGHT, gap: 14, servers: 4, tiles: 4, found: done })).toMatchObject({
      servers: 3,
      tiles: 0,
      found: 'none',
    });
    // Two servers and the panel, or two servers, the card and the strip: the strip.
    const h = FIT.server + 18 + FIT.panel;
    expect(plan({ height: h, servers: 2, box: true })).toMatchObject({ box: 'panel' });
    expect(plan({ height: h, servers: 2, box: true, found: done })).toMatchObject({
      box: 'card',
      found: 'strip',
    });
  });

  it('never plans more than the room', () => {
    for (let height = 0; height <= 700; height += 7) {
      for (const servers of [0, 2, 4, 8]) {
        for (const tiles of [0, 3, 8]) {
          for (const found of [done, looking]) {
            const p = plan({ height, servers, tiles, box: true, found });
            expect(planHeight(p, 18, found.looking)).toBeLessThanOrEqual(height + 0.5);
            if (servers + tiles > 0) expect(p.found).not.toBe('panel');
            if (p.found === 'panel') expect(p.box).toBe('none');
          }
        }
      }
    }
  });
});

describe('the heights match the stylesheet (CG-136)', () => {
  const css = readFileSync(new URL('../desk/desk.module.css', import.meta.url), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('the panel’s parts are what the planner counts, and it drops its network line under its full height (CG-142)', () => {
    const p = FIT.panelParts;
    expect(css).toMatch(/\n\.card \{[^}]*border: 1px solid/);
    expect(rule('.box')).toContain('padding: 18px 22px 20px;');
    expect(18 + 20 + 2).toBe(p.edge);
    expect(rule('.box')).toContain(`gap: ${p.gap}px;`);
    expect(rule('.box')).toContain('container: panel / size;');
    expect(rule('.boxLogo')).toContain(`height: ${p.head}px;`);
    // The network line keeps the font's own line (18 px at 15 px, measured): fixing it would move a new box's figures
    // at other zooms by a fraction of a pixel. It counts only for when the line goes, not for the planner's minimum.
    expect(rule('.boxFoot')).toContain('font: 400 15px var(--font-sans);');
    expect(FIT.panel + p.gap + p.foot).toBe(FIT.panelWithFoot);
    // CG-59: storage over the temperature needs two figures and the gap; under that the figures stand in one row.
    expect(css).toContain(`@container figs (height < ${2 * p.figs + 14}px)`);
    // A container query measures the content box: the panel less its padding and edge.
    expect(css).toContain(`@container panel (height < ${FIT.panelWithFoot - p.edge}px)`);
    expect(FIT.panel).toBe(223);
    expect(FIT.panelWithFoot).toBe(257);
  });

  it('the found panel’s parts, its compact card and the strip are what the planner counts (CG-232, CG-233)', () => {
    const f = FOUND_FIT;
    expect(rule('.found')).toContain('padding: 18px 22px;');
    expect(18 + 18 + 2).toBe(f.edge);
    expect(rule('.found')).toContain(`gap: ${f.gap}px;`);
    expect(rule('.foundIcon')).toContain(`height: ${f.head}px;`);
    expect(rule('.foundGrid')).toContain(`gap: ${f.cardGap}px;`);
    expect(rule('.foundButton')).toContain(`height: ${f.foot}px;`);
    expect(rule('.strip')).toContain(`height: ${f.strip}px;`);
    // The compact card: its padding (13 + 12), the mark's 30 px row, two gaps of 6, the short line (14.5 px at 1.35)
    // and the address's 17 px line, inside the 1 px edge.
    expect(css).toContain('padding: 13px 16px 12px;');
    expect(rule('.foundWhat')).toContain('font: 400 14.5px / 1.35 var(--font-sans);');
    expect(rule('.foundAddress')).toContain('font: 400 13px / 17px var(--font-mono);');
    expect(Math.ceil(13 + 30 + 6 + 14.5 * 1.35 + 6 + 17 + 12 + 2)).toBe(f.card);
    // The full card needs 16 + 44 + 6 + 6 + 22.8 + 6 + 19.6 + 6 + 17 + 14 inside its edge: under that, compact.
    expect(rule('.foundBody')).toContain('padding: 16px 18px 14px;');
    expect(css).toContain(
      `@container foundcard (height < ${Math.ceil(16 + 44 + 6 + 6 + 19 * 1.2 + 6 + 14.5 * 1.35 + 6 + 17 + 14)}px)`,
    );
  });

  it('a server card, a tile and the “+N more” line are as tall as the planner counts', () => {
    expect(rule('.serverGrid > .server')).toContain(`height: ${FIT.server}px;`);
    expect(rule('.serverGrid')).toContain(`gap: ${FIT.serverGap}px;`);
    // The card (DK-80): its padding (14 + 16) and edge, the 30 px head, a gap of 14 and three 18 px lines 9 apart.
    expect(rule('.server')).toContain('padding: 14px 18px 16px;');
    expect(rule('.server')).toContain('gap: 14px;');
    expect(rule('.markTile')).toContain('height: 30px;');
    expect(rule('.cardLines')).toContain('gap: 9px;');
    expect(rule('.cardValue')).toContain('font: 600 15px / 18px var(--font-sans);');
    expect(14 + 16 + 2 + 30 + 14 + 3 * 18 + 2 * 9).toBe(FIT.server);
    expect(rule('.cards > .tile')).toContain(`height: ${FIT.tile}px;`);
    expect(rule('.moreServers')).toContain(`/ ${FIT.more}px`);
    expect(rule('.moreServers')).toContain(`margin: -${FIT.moreTuck}px 0 0;`);
  });
});
