import type { ThingPage, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { createServicePages, SERVICE_THINGS } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { barRows, chartCard } from './dashboard';
import {
  countTiles,
  foldStrip,
  HINGE_GAP,
  halfWidths,
  isSlotPage,
  isStrip,
  liveRows,
  noteParts,
  personInitial,
  shelfShown,
  shelfTag,
  slotColumns,
  splitHeld,
  stripOrder,
  stripSentence,
  stripTone,
  swipePage,
} from './serviceSlots';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const TZ = 'Europe/Amsterdam';
const services = createServicePages({ now: () => NOW });
const plex = services.page(SERVICE_THINGS.plex) as ThingPage;
const panels = plex.tabs[0]?.panels ?? [];
const find = <K extends ThingPagePanel['kind']>(kind: K, id: string) =>
  panels.find((p): p is Extract<ThingPagePanel, { kind: K }> => p.kind === kind && p.id === id) as Extract<
    ThingPagePanel,
    { kind: K }
  >;

const notice = (id: string, n: Partial<ThingPageNotice> = {}): ThingPageNotice => ({
  id,
  tone: 'warn',
  icon: 'warn',
  title: id,
  ...n,
});

describe('a page in slots', () => {
  it('is Plex’s Summary, not a page without the slot looks', () => {
    expect(isSlotPage(panels)).toBe(true);
    expect(isSlotPage(panels.filter((p) => p.kind !== 'gallery' && p.kind !== 'list'))).toBe(false);
  });

  it('lays a wide page in two halves: the wide slots left, the strip and the one-column cards right', () => {
    const laid = slotColumns(panels);
    expect(laid.across).toEqual([]);
    expect(laid.left.map((p) => p.id)).toEqual(['now_playing', 'recently_added']);
    expect(laid.right.map((p) => p.id)).toEqual(['worth', 'libraries', 'week', 'people', 'machine']);
    expect(laid.bottom).toEqual([]);
  });

  it('puts main panels after the wide slots, side ones after the narrow, figures on top and the bottom across', () => {
    const laid = slotColumns([
      { kind: 'kpis', id: 'figures', place: 'top', items: [] },
      { kind: 'text', id: 'side', place: 'side', body: 'x' },
      { kind: 'text', id: 'main', place: 'main', body: 'x' },
      { kind: 'text', id: 'end', place: 'bottom', body: 'x' },
      ...panels,
    ]);
    expect(laid.across.map((p) => p.id)).toEqual(['figures']);
    expect(laid.left.map((p) => p.id)).toEqual(['now_playing', 'recently_added', 'main']);
    expect(laid.right.map((p) => p.id).slice(-1)).toEqual(['side']);
    expect(laid.bottom.map((p) => p.id)).toEqual(['end']);
  });

  it('keeps each column in its half of an open foldable, the fold in the room between', () => {
    // The page starts after the side bar and its margin; the fold is the screen's middle.
    const halves = halfWidths({ x: 94, width: 748, hinge: 430 });
    expect(halves).not.toBeNull();
    if (!halves) return;
    expect(94 + halves.left).toBeLessThan(430);
    expect(94 + halves.left + HINGE_GAP).toBeGreaterThan(430);
    expect(halves.left + halves.right + HINGE_GAP).toBe(748);
    // No fold (a tablet), or a fold far off the page: the columns share the width.
    expect(halfWidths({ x: 0, width: 800, hinge: null })).toBeNull();
    expect(halfWidths({ x: 0, width: 800, hinge: 60 })).toBeNull();
  });
});

describe('Worth a look as a strip', () => {
  it('is a notices panel on top', () => {
    expect(isStrip(find('notices', 'worth'))).toBe(true);
    expect(isStrip({ kind: 'notices', id: 'look', place: 'side', title: 'Worth a look', items: [] })).toBe(
      false,
    );
  });

  it('puts what asks first, heads-ups next and quiet lines last', () => {
    const items = [
      notice('quiet', {
        quiet: {
          state: 'ignored',
          by: { id: 'usr_john', name: 'John' },
          at: '2026-11-01T10:00:00Z',
          words: 'always',
        },
      }),
      notice('fyi', { tone: 'info', nature: 'fyi' }),
      notice('problem', { tone: 'bad', nature: 'problem' }),
    ] as ThingPageNotice[];
    expect(stripOrder(items).map((n) => n.id)).toEqual(['problem', 'fyi', 'quiet']);
  });

  it('shows three lines, then how many more', () => {
    expect(foldStrip([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(foldStrip([1, 2, 3, 4, 5], false)).toEqual({ shown: [1, 2, 3], more: 2 });
    expect(foldStrip([1, 2, 3, 4, 5], true).shown).toHaveLength(5);
  });

  it('folds the lines held with the whole thing apart, not counted in “Show N more”', () => {
    const rows = [
      { id: 'a', held: null },
      { id: 'b', held: 'window' as const },
      { id: 'c', held: null },
      { id: 'd', held: 'cause' as const },
    ];
    const { lines, held } = splitHeld(rows);
    expect(lines.map((r) => r.id)).toEqual(['a', 'c']);
    expect(held.map((r) => r.id)).toEqual(['b', 'd']);
    expect(foldStrip(lines, false).more).toBe(0);
  });

  it('takes the tint of its worst line that still asks', () => {
    expect(stripTone(find('notices', 'worth').items)).toBe('warn');
    expect(stripTone([notice('a', { tone: 'warn' }), notice('b', { tone: 'bad' })])).toBe('bad');
    expect(stripTone([notice('a', { tone: 'info' })])).toBe('info');
  });

  it('reads a line as its title closed with a full stop, then its detail', () => {
    expect(stripSentence('Plex couldn’t match 3 home videos', 'They show without a poster.').title).toBe(
      'Plex couldn’t match 3 home videos.',
    );
    expect(stripSentence('Disk full!', 'x').title).toBe('Disk full!');
    expect(stripSentence('Plex has an update', null)).toEqual({ title: 'Plex has an update', detail: null });
  });
});

describe('Live rows', () => {
  const rows = liveRows(find('gallery', 'now_playing'), NOW, TZ);

  it('carry each stream’s person, tag, progress words at both ends and whether it stands still', () => {
    expect(rows.map((r) => r.person?.initial)).toEqual(['A', 'J', 'S']);
    expect(rows[1]?.person?.note).toBe('iPad · away');
    expect(rows[0]?.badge?.text).toBe('Direct play');
    expect(rows[1]?.noteEnd).toBe('17 min left');
    expect(rows.map((r) => r.paused)).toEqual([false, false, true]);
    expect(rows[0]?.pct).toBe(42);
    expect(rows[0]?.spoken).toContain('Anna');
    expect(rows[0]?.spoken).toContain('1 h 36 min left');
  });

  it('make where it is now the strong part of its note', () => {
    expect(noteParts('38:12 of 55:00')).toEqual({ strong: '38:12', rest: ' of 55:00' });
    expect(noteParts('Paused')).toEqual({ strong: 'Paused', rest: '' });
  });

  it('page through the cards by the nearest card’s start', () => {
    expect(swipePage(0, 3)).toBe(0);
    expect(swipePage(300, 3)).toBe(1);
    expect(swipePage(5000, 3)).toBe(2);
    expect(swipePage(100, 0)).toBe(0);
  });
});

describe('the shelf', () => {
  it('tags a picture with who asked for it', () => {
    const shelf = find('gallery', 'recently_added');
    const tags = shelf.items.map(shelfTag);
    expect(tags[0]).toEqual({ initial: 'A', text: 'Anna asked' });
    expect(tags[1]).toBeNull();
    expect(shelfTag({ id: 'x', title: 'X', person: { name: 'Sam' } })).toEqual({ initial: 'S', text: 'Sam' });
  });

  it('shows whole rows of three in a half, two rows at most', () => {
    expect(shelfShown(12)).toBe(6);
    expect(shelfShown(5)).toBe(3);
    expect(shelfShown(2)).toBe(2);
  });
});

describe('counts', () => {
  it('draw each library’s count, what changed in its tone, and its Scan', () => {
    const tiles = countTiles(find('list', 'libraries'));
    expect(tiles.map((t) => [t.title, t.icon, t.value])).toEqual([
      ['Movies', 'film', '1,284'],
      ['TV Shows', 'tv', '96'],
      ['Music', 'music', '312'],
      ['Home videos', 'video', '58'],
    ]);
    expect(tiles[0]).toMatchObject({ note: '+9 this week', noteTone: 'ok' });
    expect(tiles[2]).toMatchObject({ note: 'No change', noteTone: null });
    expect(tiles[0]?.action?.action).toBe('scan');
    expect(tiles[0]?.spoken).toContain('1,284');
  });

  it('fall back to the line’s right and detail without a figure', () => {
    const [tile] = countTiles({ items: [{ id: 'a', title: 'Disks', right: '4', detail: 'All fine' }] });
    expect(tile).toMatchObject({ value: '4', note: 'All fine', action: null });
  });
});

describe('people and the week', () => {
  it('give a person’s line their initial', () => {
    const rows = barRows(find('bars', 'people'));
    expect(rows.map((r) => r.initial)).toEqual(['A', 'J', 'S', 'M']);
    expect(barRows(find('bars', 'machine')).every((r) => r.initial === null)).toBe(true);
    expect(personInitial(' anna ')).toBe('A');
  });

  it('put the day words under the bars, whatever the page’s range', () => {
    const week = find('chart', 'week');
    const day = chartCard(week, '24h', TZ);
    const month = chartCard(week, '30d', TZ);
    expect(day?.labels).toHaveLength(7);
    expect(day?.labels?.at(-1)).toBe('Today');
    expect(day?.timeTicks.map((t) => t.label)).toEqual(day?.labels);
    expect(month?.labels).toEqual(day?.labels);
    expect(day?.readout(6).title).toBe('Today');
    expect(day?.latest.title).toBe('Today');
  });
});
