import {
  DEFAULT_DESK_SHOW,
  DESK_SCREEN_ID_RE,
  DESK_SCREEN_WORDS,
  type DeskLayout,
  type DeskWidget,
  deskAttentionFor,
  deskDefaultLayout,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { glanceFacts, screenGrid, screenSummary } from './screen-grid';
import {
  layoutOf,
  layoutRefusal,
  NOT_ARRANGED,
  newDeviceScreenId,
  outputScreenId,
  recordOf,
  type ScreenRow,
  screenKind,
  screenOnline,
} from './screens';
import type { ScreenRecord } from './widgets/types';

const NOW = new Date('2026-10-27T14:34:00.000Z');

const page = (widgets: DeskWidget[], shape = '8x5'): DeskLayout => ({
  pages: [{ id: 'p_one', name: 'Overview', layouts: { [shape]: widgets }, last: shape }],
  turn: 'touch',
  size: 'normal',
});
const w = (id: string, over: Partial<DeskWidget>): DeskWidget => ({
  id,
  type: 'clock',
  opts: {},
  x: 0,
  y: 0,
  w: 3,
  h: 2,
  ...over,
});

const row = (over: Partial<ScreenRow> = {}): ScreenRow => ({
  id: 'out_hdmi-a-1',
  burrowId: 'brw_1',
  kind: 'output',
  name: 'DELL U2720Q',
  popups: 'problems',
  doorbell: 'big',
  layout: NOT_ARRANGED,
  show: {},
  endpointId: null,
  personId: null,
  device: 'DELL U2720Q',
  width: 1920,
  height: 1080,
  lastSeenAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

describe('the screens’ store (DK-128, DK-132)', () => {
  it('reads a layout nobody arranged, or one it can’t read, as the default', () => {
    expect(layoutOf(NOT_ARRANGED)).toEqual(deskDefaultLayout());
    expect(layoutOf(null)).toEqual(deskDefaultLayout());
    expect(layoutOf({ pages: 'nope' })).toEqual(deskDefaultLayout());
    // Two widgets on one spot: not a layout the screen can draw.
    const overlapping = page([w('w_a', {}), w('w_b', { x: 1 })]);
    expect(layoutOf(overlapping)).toEqual(deskDefaultLayout());
    const good = page([w('w_a', {}), w('w_b', { x: 3, type: 'work', w: 4, h: 1 })]);
    expect(layoutOf(good)).toEqual(good);
  });

  it('keeps every widget within its own sizes, a panel’s by what it draws', () => {
    expect(layoutRefusal(page([w('w_a', { w: 1, h: 1 })]))).toContain('w_a');
    expect(layoutRefusal(page([w('w_a', { w: 8, h: 4 })]))).toContain('larger');
    // A panel before its view is known takes the panel's own sizes; a camera's are larger than a list's.
    const camera = page([
      w('w_cam', { type: 'panel', ref: 'device:ha', opts: { panel: 'cams' }, x: 0, y: 0, w: 8, h: 5 }),
    ]);
    expect(layoutRefusal(camera)).toBeNull();
    expect(layoutRefusal(camera, () => 'list')).toContain('w_cam');
    expect(layoutRefusal(camera, () => 'camera')).toBeNull();
    // A grid smaller than a widget's smallest size takes it as small as the grid.
    expect(layoutRefusal(page([w('w_now', { type: 'now', w: 1, h: 2 })], '1x5'))).toBeNull();
    expect(layoutRefusal(page([w('w_a', {}), w('w_a', { x: 4 })]))).toContain('twice');
  });

  it('names screens as the contract does', () => {
    expect(screenKind('box')).toBe('box');
    expect(screenKind('out_dp-2')).toBe('output');
    expect(screenKind('scr_abcdefgh')).toBe('device');
    expect(outputScreenId('HDMI-A-1')).toBe('out_hdmi-a-1');
    expect(outputScreenId('x'.repeat(41))).toBeNull();
    const id = newDeviceScreenId(() => new Uint8Array(12).fill(7));
    expect(id).toMatch(DESK_SCREEN_ID_RE);
    expect(id.startsWith('scr_')).toBe(true);
  });

  it('reads a row: the box keeps its name, pop-ups fall back by kind, the box’s choices are the paired screen’s', () => {
    const box = recordOf(row({ id: 'box', kind: 'box', name: 'Something else', popups: 'bogus' as never }), {
      ...DEFAULT_DESK_SHOW,
      clock: 'small',
    });
    expect(box.name).toBe(DESK_SCREEN_WORDS.box);
    expect(box.popups).toBe('all');
    expect(box.show.clock).toBe('small');
    const monitor = recordOf(
      row({ name: '', popups: 'bogus' as never, show: { clock: 'small', items: 'bad' } }),
    );
    expect(monitor.name).toBe(DESK_SCREEN_WORDS.output);
    expect(monitor.popups).toBe('problems');
    // The part it can't read is its default; the rest stays.
    expect(monitor.show.clock).toBe('small');
    expect(monitor.show.items).toEqual({});
    expect(monitor.size).toEqual({ width: 1920, height: 1080 });
    expect(monitor.layout).toEqual(deskDefaultLayout());
  });

  it('says a screen shows now when it was seen lately, the box’s own while it’s on', () => {
    const monitor = recordOf(row());
    expect(screenOnline(monitor, NOW.getTime() + 60_000, false)).toBe(true);
    expect(screenOnline(monitor, NOW.getTime() + 3 * 60_000, true)).toBe(false);
    const box = recordOf(row({ id: 'box', kind: 'box' }));
    expect(screenOnline(box, NOW.getTime(), true)).toBe(true);
    expect(screenOnline(box, NOW.getTime(), false)).toBe(false);
  });
});

describe('a screen as Settings lists it and the screen draws it (DK-128, DK-135…DK-137)', () => {
  const record: ScreenRecord = recordOf(row());

  it('summarises a screen', () => {
    const s = screenSummary(record, true);
    expect(s).toMatchObject({
      id: 'out_hdmi-a-1',
      kind: 'output',
      pages: 1,
      online: true,
      popups: 'problems',
    });
    // What it is only when it says more than its name.
    expect(s.device).toBeUndefined();
    expect(screenSummary({ ...record, device: 'iPad · Safari' }, false).device).toBe('iPad · Safari');
    expect(screenSummary(record, false, null).size).toBeNull();
  });

  it('makes a grid with what needs the person for its pop-ups, or none when it isn’t one the screen takes', () => {
    const calm = {
      assistant: 'Dusty',
      now: NOW,
      timeZone: 'Europe/Amsterdam',
      asks: [{ number: 4, title: 'Restart Plex?' }],
      askCount: 1,
      looks: [{ key: 'server:pve-02', kind: 'server' as const, name: 'pve-02', state: 'down' as const }],
      work: null,
      servers: [],
      activities: [],
      figures: [],
      coming: [],
      services: 0,
      doneCount: 0,
    };
    const grid = screenGrid({
      record,
      layout: record.layout,
      trying: null,
      views: [],
      calm,
      view: 'everything',
    });
    expect(grid?.screen).toBe('out_hdmi-a-1');
    // Problems only: the outage pops, the question is only in the pill's list.
    const pops = Object.fromEntries((grid?.attention.items ?? []).map((i) => [i.key, i.pops]));
    expect(pops).toEqual({ 'server:pve-02': true, 'ask:4': false });
    const trying = screenGrid({
      record,
      layout: record.layout,
      trying: NOW.getTime(),
      views: [],
      calm,
      view: 'summary',
    });
    expect(trying?.trying?.until).toBe(NOW.toISOString());
    const warned: string[] = [];
    const bad = screenGrid({
      record: { ...record, id: 'nope' },
      layout: record.layout,
      trying: null,
      views: [],
      calm: null,
      view: 'everything',
      warn: (m) => warned.push(m),
    });
    expect(bad).toBeNull();
    expect(warned).toHaveLength(1);
    // What needs the person, in their language: the same items, said in Dutch.
    const dutch = screenGrid({
      record,
      layout: record.layout,
      trying: null,
      views: [],
      calm,
      view: 'everything',
      locale: 'nl-NL',
    });
    expect(dutch?.attention.items.map((i) => i.key)).toEqual(grid?.attention.items.map((i) => i.key));
    expect(dutch?.attention).toEqual(
      deskAttentionFor(calm, record.show, 'everything', record.popups, 'nl-NL'),
    );
    expect(JSON.stringify(dutch?.attention)).not.toEqual(JSON.stringify(grid?.attention));
  });

  it('gives the widgets what the glance read', () => {
    expect(glanceFacts(null, null, 0)).toBeNull();
  });
});
