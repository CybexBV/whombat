import type { OverviewLayout } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  addTile,
  arrangePins,
  arrangeTiles,
  layoutNow,
  moveTileBy,
  moveTileTo,
  OVERVIEW_STARTING_TOP,
  overviewShows,
  ownFace,
  removeTile,
  setPin,
  setTopFigure,
  showId,
  showOnTile,
  sizeTile,
  viewFace,
} from './arrange';

const row = (id: string) => ({ row: { id } });
const THINGS = ['connection:con_ha', 'connection:con_plex', 'device:dev_heat', 'server:pve-01'];
const items = THINGS.map(row);
const things = THINGS.map((id) => ({ id }));
const ids = (l: OverviewLayout) => l.tiles.map((t) => `${t.thing.split(':')[1]}${t.hidden ? '-' : ''}`);

describe('the arranged order', () => {
  it('starts with every connection and device as a small tile with its figures, servers left out', () => {
    const { shown, removed } = arrangeTiles(null, items);
    expect(shown.map((s) => s.tile)).toEqual([
      { thing: 'connection:con_ha', size: 's' },
      { thing: 'connection:con_plex', size: 's' },
      { thing: 'device:dev_heat', size: 's' },
    ]);
    expect(removed).toEqual([]);
    expect(layoutNow(null, things).top).toEqual(OVERVIEW_STARTING_TOP);
  });

  it('follows the layout, keeps removed ones apart and puts a new connection last', () => {
    const layout: OverviewLayout = {
      tiles: [
        { thing: 'device:dev_heat', size: 'l', panel: 'water' },
        { thing: 'connection:con_ha', size: 's', hidden: true },
        { thing: 'connection:con_gone', size: 'w' },
      ],
      top: [],
      pins: {},
    };
    const { shown, removed } = arrangeTiles(layout, items);
    expect(shown.map((s) => s.tile.thing)).toEqual(['device:dev_heat', 'connection:con_plex']);
    expect(removed.map((s) => s.tile.thing)).toEqual(['connection:con_ha']);
    // A thing that is gone is dropped when the layout is next saved.
    expect(ids(layoutNow(layout, things))).toEqual(['dev_heat', 'con_plex', 'con_ha-']);
  });
});

describe('edits', () => {
  const start = layoutNow(null, things);

  it('changes what a tile shows, its span and its size', () => {
    const l = sizeTile(
      showOnTile(start, 'connection:con_ha', { panel: 'power', range: '7d' }),
      'connection:con_ha',
      'l',
    );
    expect(l.tiles[0]).toEqual({ thing: 'connection:con_ha', size: 'l', panel: 'power', range: '7d' });
    expect(showOnTile(l, 'connection:con_ha', {}).tiles[0]).toEqual({
      thing: 'connection:con_ha',
      size: 'l',
    });
  });

  it('removes a tile and adds it back after the last one shown', () => {
    const gone = removeTile(start, 'connection:con_ha');
    expect(ids(gone)).toEqual(['con_ha-', 'con_plex', 'dev_heat']);
    expect(ids(addTile(gone, 'connection:con_ha'))).toEqual(['con_plex', 'dev_heat', 'con_ha']);
  });

  it('moves a tile by dragging it onto another, or a place earlier or later', () => {
    expect(ids(moveTileTo(start, 'device:dev_heat', 'connection:con_ha'))).toEqual([
      'dev_heat',
      'con_ha',
      'con_plex',
    ]);
    expect(ids(moveTileTo(start, 'connection:con_ha', 'connection:con_plex'))).toEqual([
      'con_plex',
      'con_ha',
      'dev_heat',
    ]);
    expect(ids(moveTileTo(start, 'connection:con_ha', null))).toEqual(['con_plex', 'dev_heat', 'con_ha']);
    expect(ids(moveTileBy(start, 'connection:con_plex', -1))).toEqual(['con_plex', 'con_ha', 'dev_heat']);
    expect(moveTileBy(start, 'connection:con_ha', -1)).toBe(start);
  });

  it('sets a figure at the top and a pinned chart’s width', () => {
    const l = setTopFigure(start, 1, { thing: 'connection:con_ha', panel: 'power' });
    expect(l.top[1]).toEqual({ thing: 'connection:con_ha', panel: 'power' });
    expect(l.top).toHaveLength(4);
    const p = setPin(start, 'wdg_a', { size: 'full' });
    expect(arrangePins(p, [{ id: 'wdg_a' }, { id: 'wdg_b' }]).shown.map((x) => x.size)).toEqual([
      'full',
      'half',
    ]);
    const hidden = setPin(p, 'wdg_b', { hidden: true });
    expect(arrangePins(hidden, [{ id: 'wdg_a' }, { id: 'wdg_b' }]).removed).toEqual([{ id: 'wdg_b' }]);
    expect(setPin(hidden, 'wdg_b', { hidden: undefined }).pins.wdg_b).toBeUndefined();
  });
});

describe('what is read', () => {
  it('reads the same thing, panel and span once for a tile and a figure', () => {
    const l = setTopFigure(layoutNow(null, things), 0, { thing: 'connection:con_ha' });
    const shows = overviewShows(l.tiles, l.top);
    expect(shows).toHaveLength(3);
    expect(shows[0]).toEqual({ thing: 'connection:con_ha' });
    expect(showId({ thing: 'connection:con_ha', panel: 'power' })).toMatch(/^w_[a-z0-9]+$/);
  });

  it('leads with a view’s first figure, or says what is wrong', () => {
    const f = viewFace({
      kind: 'figures',
      id: 'w_a',
      title: 'Home Assistant',
      items: [
        { value: '1.4', unit: 'kW', label: 'Power now' },
        { value: '21', unit: '°C', label: 'Inside' },
      ],
      spark: [1, 2, 3],
    });
    expect(f).toMatchObject({
      value: '1.4',
      unit: 'kW',
      label: 'Power now',
      line: '21 °C inside',
      spark: [1, 2, 3],
    });
    expect(
      viewFace({
        kind: 'text',
        id: 'w_b',
        title: 'Plex',
        body: 'x',
        problem: { text: 'Plex isn’t answering' },
      }),
    ).toMatchObject({ line: 'Plex isn’t answering', tone: 'warn' });
  });

  it('counts Whombat’s own figures', () => {
    const data = { summary: { needsYou: 2, working: 0, problems: 0 }, doneToday: [] };
    const servers = ownFace('servers', data, [], [{ status: 'ok' }, { status: 'bad' }], 'Dusty');
    expect(servers).toMatchObject({ value: '1', unit: 'of 2', tone: 'bad' });
    expect(ownFace('needsYou', data, [], null, null).value).toBe('2');
    const cons = ownFace(
      'connections',
      data,
      [
        { id: 'connection:a', level: 'connected' },
        { id: 'connection:b', level: 'needsLook' },
      ],
      null,
      null,
    );
    expect(cons).toMatchObject({ value: '1', unit: 'of 2', tone: 'warn' });
  });
});
