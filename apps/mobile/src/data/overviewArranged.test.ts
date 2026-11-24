import type { DeskCatalog, HomeOverview } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  figureWhat,
  pinMovePosition,
  sparkPaths,
  tileRows,
  tileShowChoices,
  todayCounts,
  todayMoments,
  todayShown,
  topChoiceGroups,
} from './overviewArranged';

describe('tiles in rows', () => {
  const size = (t: { s: 's' | 'w' | 'l' }) => t.s;
  const names = (rows: ReturnType<typeof tileRows<{ id: string; s: 's' | 'w' | 'l' }>>) =>
    rows.map((r) => (r.kind === 'pair' ? r.items.map((i) => i.id).join('+') : `[${r.item.id}]`));

  it('puts small tiles two across and a wide or large one alone, in their order', () => {
    const tiles = [
      { id: 'a', s: 's' },
      { id: 'b', s: 's' },
      { id: 'c', s: 's' },
      { id: 'd', s: 'w' },
      { id: 'e', s: 's' },
      { id: 'f', s: 'l' },
    ] as const;
    expect(names(tileRows(tiles, size))).toEqual(['a+b', 'c', '[d]', 'e', '[f]']);
    expect(tileRows([], size)).toEqual([]);
  });
});

describe('what a figure is, beside its value', () => {
  it('lowers a word but keeps a short name', () => {
    expect(figureWhat('Power now')).toBe('power now');
    expect(figureWhat('CPU')).toBe('CPU');
    expect(figureWhat('devices')).toBe('devices');
    expect(figureWhat('')).toBe('');
  });
});

describe('Today', () => {
  const tz = 'Europe/Amsterdam';
  const now = new Date('2026-11-24T13:00:00Z');
  const data: Pick<HomeOverview, 'doneToday' | 'automationsToday'> = {
    doneToday: [
      { id: 'd1', text: 'Backups finished', at: '2026-11-24T01:05:00Z' },
      { id: 'd0', text: 'Yesterday’s', at: '2026-11-23T10:00:00Z' },
    ],
    automationsToday: [
      { id: 'aut_1' as never, name: 'Nightly backups', state: 'scheduled', at: '2026-11-24T20:00:00Z' },
      { id: 'aut_2' as never, name: 'Pay invoices', state: 'failed', at: '2026-11-24T10:00:00Z' },
      { id: 'aut_3' as never, name: 'Morning lights', state: 'ran', at: '2026-11-24T06:00:00Z' },
    ],
  };

  it('lists the day’s moments oldest first, with their times, tones and where they came from', () => {
    const moments = todayMoments(data, now, tz, 'Dusty');
    expect(moments.map((m) => [m.time, m.text, m.tone, m.from])).toEqual([
      ['02:05', 'Backups finished', 'ok', 'Dusty'],
      ['07:00', 'Morning lights', 'ok', 'Automation'],
      ['11:00', 'Pay invoices', 'bad', 'Automation'],
      ['21:00', 'Nightly backups', 'plan', 'Automation'],
    ]);
    expect(todayCounts(moments)).toEqual({ done: 3, planned: 1 });
  });

  it('shows the last three that happened folded, topped up with what is planned', () => {
    const moments = todayMoments(data, now, tz, 'Dusty');
    expect(todayShown(moments, false).map((m) => m.text)).toEqual([
      'Backups finished',
      'Morning lights',
      'Pay invoices',
    ]);
    expect(todayShown(moments, true)).toHaveLength(4);
    const plan = moments.find((m) => m.tone === 'plan');
    const fewer = [
      moments.find((m) => m.text === 'Pay invoices'),
      plan,
      { ...plan, id: 'later', text: 'Later', at: (plan?.at ?? 0) + 1 },
      { ...plan, id: 'latest', text: 'Latest', at: (plan?.at ?? 0) + 2 },
    ] as Parameters<typeof todayShown>[0];
    expect(todayShown(fewer, false).map((m) => m.text)).toEqual(['Pay invoices', 'Nightly backups', 'Later']);
  });
});

describe('a small chart', () => {
  it('runs across the width from nought, its newest reading at the right', () => {
    const p = sparkPaths([0, 5, 10], 100, 40);
    expect(p?.line.startsWith('M0 36')).toBe(true);
    expect(p?.end.x).toBe(100);
    expect(p?.end.y).toBeGreaterThan(4);
    expect(p?.area.endsWith('L100 40L0 40Z')).toBe(true);
    expect(sparkPaths([3], 100, 40)).toBeNull();
    expect(sparkPaths([0, 0], 100, 40)?.end.y).toBe(20);
  });
});

describe('a gear’s choices', () => {
  const catalog: DeskCatalog = {
    groups: [
      {
        key: 'connection:con_ha',
        label: 'Home Assistant',
        thing: 'connection:con_ha',
        items: [
          {
            type: 'panel',
            ref: 'connection:con_ha',
            opts: { panel: 'energy' },
            name: 'Energy',
            line: '1.4 kW',
            view: 'chart',
          },
          {
            type: 'figures',
            ref: 'connection:con_ha',
            opts: {},
            name: 'Home Assistant',
            line: '1.4 kW · 21 °C',
          },
        ],
      },
      {
        key: 'connection:con_plex',
        label: 'Plex',
        thing: 'connection:con_plex',
        items: [{ type: 'figures', ref: 'connection:con_plex', opts: {}, name: 'Plex', line: '2 watching' }],
      },
    ],
  };

  it('offers a tile its main figures first, then its panels', () => {
    expect(tileShowChoices(catalog, 'connection:con_ha').map((c) => [c.key, c.show, c.chart])).toEqual([
      ['', {}, false],
      ['energy', { panel: 'energy' }, true],
    ]);
    expect(tileShowChoices(undefined, 'connection:con_ha')).toEqual([]);
  });

  it('offers a figure Whombat’s own and every thing’s, greying those at the top elsewhere', () => {
    const top = [
      { own: 'servers' },
      { thing: 'connection:con_plex' },
      { own: 'needsYou' },
      { own: 'doneToday' },
    ] as const;
    const groups = topChoiceGroups(catalog, top, 0);
    expect(groups.map((g) => g.label)).toEqual(['Whombat', 'Home Assistant', 'Plex']);
    const own = groups[0]?.items ?? [];
    expect(own.map((c) => [c.name, c.chosen, c.taken])).toEqual([
      ['Servers running', true, false],
      ['Connections working', false, false],
      ['Needs you', false, true],
      ['Done today', false, true],
    ]);
    expect(groups[2]?.items[0]?.taken).toBe(true);
    expect(groups[1]?.items.map((c) => c.top)).toEqual([
      { thing: 'connection:con_ha', panel: 'energy' },
      { thing: 'connection:con_ha' },
    ]);
  });
});

describe('a pinned chart’s place', () => {
  it('moves past the next pin shown, over the removed ones', () => {
    const all = ['a', 'b', 'gone', 'c'];
    const shown = ['a', 'b', 'c'];
    expect(pinMovePosition(all, shown, 'b', 1)).toBe(3);
    expect(pinMovePosition(all, shown, 'c', -1)).toBe(1);
    expect(pinMovePosition(all, shown, 'a', -1)).toBeNull();
    expect(pinMovePosition(all, shown, 'c', 1)).toBeNull();
  });
});
