/**
 * Find My on a Mac's page without Postgres (docs/implementation/macos/findmy.md §4): Find My's rows read as people,
 * and the reads and exact pictures against a made-up Mac behind a stand-in hosts service, with the clock and the waits
 * injected (nothing sleeps).
 */
import { HostFindMy, HostFindMyMap, HostFindMyPicture } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { HostsActor } from './client';
import {
  cropOf,
  FIND_MY_APP,
  FindMyStore,
  findMyPersonId,
  findMyRows,
  geocodeQuery,
  helperTooOld,
  isCropOf,
  largestImage,
  parseFindMyRow,
  rowParts,
  stepProblem,
} from './findmy';
import { toHostUiElement } from './map';
import { DOT, FakeFindMyMac } from './testing/fake-findmy';

const ACTOR: HostsActor = { id: 'pr_owner', name: 'Owner', role: 'admin' };
const MIN = 60_000;

describe('Find My’s rows', () => {
  it('split on the middle dot and its no-break spaces', () => {
    expect(rowParts(`Mara Visser${DOT}Nearby${DOT}Home${DOT}Now`)).toEqual([
      'Mara Visser',
      'Nearby',
      'Home',
      'Now',
    ]);
    expect(rowParts('Mara Visser · Home')).toEqual(['Mara Visser', 'Home']);
  });

  it('read as name, place, street, when and nearby, wherever Find My puts “Nearby”', () => {
    expect(parseFindMyRow(`Mara Visser${DOT}Nearby${DOT}Home${DOT}Now`)).toEqual({
      name: 'Mara Visser',
      place: 'Home',
      address: null,
      when: 'Now',
      nearby: true,
    });
    expect(parseFindMyRow(`Ruben Visser${DOT}Nearby${DOT}Lelystad${DOT}5 min ago`)).toMatchObject({
      place: 'Lelystad',
      when: '5 min ago',
      nearby: true,
    });
    // A chosen row adds the street: the part with a comma.
    expect(
      parseFindMyRow(`Mara Visser${DOT}Home${DOT}Nearby${DOT}Damrak 1, Amsterdam${DOT}5 minutes ago`),
    ).toEqual({
      name: 'Mara Visser',
      place: 'Home',
      address: 'Damrak 1, Amsterdam',
      when: '5 minutes ago',
      nearby: true,
    });
    expect(parseFindMyRow(`Ruben Visser${DOT}Lelystad${DOT}Now`)).toMatchObject({
      place: 'Lelystad',
      nearby: false,
    });
  });

  it('never take the distance for the street or the place, also with a decimal comma', () => {
    expect(parseFindMyRow(`Ruben Visser${DOT}5,5 km${DOT}Lelystad${DOT}Now`)).toEqual({
      name: 'Ruben Visser',
      place: 'Lelystad',
      address: null,
      when: 'Now',
      nearby: false,
    });
    expect(parseFindMyRow(`Ruben Visser${DOT}5,5 km${DOT}Stationsplein 1, Lelystad${DOT}Now`)).toMatchObject({
      place: null,
      address: 'Stationsplein 1, Lelystad',
    });
    for (const far of ['3.4 mi', '800 m', '12 km', '1,2\u00a0km', '<0.1 mi'])
      expect(parseFindMyRow(`Ruben Visser${DOT}${far}${DOT}Lelystad${DOT}Now`)).toMatchObject({
        place: 'Lelystad',
        address: null,
      });
  });

  it('have no place with fewer than three parts', () => {
    expect(parseFindMyRow(`Mara’s Keys${DOT}No location found`)).toEqual({
      name: 'Mara’s Keys',
      place: null,
      address: null,
      when: 'No location found',
      nearby: false,
    });
    expect(parseFindMyRow('Mara Visser')).toMatchObject({ name: 'Mara Visser', place: null, when: null });
    expect(parseFindMyRow(' · ')).toBeNull();
  });

  it('are the buttons with the middle dot, each name once; pins, tabs and the map are not', () => {
    const el = (role: string, desc: string) => toHostUiElement({ id: desc, role, desc });
    const rows = findMyRows([
      el('AXRadioButton', 'People'),
      el('AXButton', `Mara Visser${DOT}Nearby${DOT}Home${DOT}Now`),
      el('AXGenericElement', 'Mara Visser,Map pin'),
      el('AXButton', `Mara Visser${DOT}Home${DOT}Now`),
      el('AXButton', 'Zoom in'),
      el('AXImage', 'Map'),
      el('AXButton', `Noor Visser${DOT}No location found`),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Mara Visser', 'Noor Visser']);
  });

  it('give each person an id that stays with the name', () => {
    expect(findMyPersonId('Mara Visser')).toMatch(/^[0-9a-f]{12}$/);
    expect(findMyPersonId('Mara Visser')).toBe(findMyPersonId('Mara Visser'));
    expect(findMyPersonId('Mara Visser')).not.toBe(findMyPersonId('Ruben Visser'));
  });

  it('ask the geocoder for the street, else a place that is somewhere', () => {
    expect(geocodeQuery({ address: 'Damrak 1, Amsterdam', place: 'Home' })).toBe('Damrak 1, Amsterdam');
    expect(geocodeQuery({ address: null, place: 'Lelystad' })).toBe('Lelystad');
    expect(geocodeQuery({ address: null, place: 'Home' })).toBeNull();
    expect(geocodeQuery({ address: null, place: null })).toBeNull();
  });
});

describe('the Mac’s side', () => {
  it('needs Whombat Helper 1.1.0', () => {
    expect(helperTooOld('1.0.6')).toBe(true);
    expect(helperTooOld('0.9')).toBe(true);
    expect(helperTooOld('1.1.0')).toBe(false);
    expect(helperTooOld('1.2')).toBe(false);
    expect(helperTooOld('2.0.0 (14)')).toBe(false);
    expect(helperTooOld(null)).toBe(false);
  });

  it('calls a step the helper doesn’t know an old helper', () => {
    expect(stepProblem('map.geocode', { code: 'unsupported' })).toEqual({ code: 'helper_old' });
    expect(stepProblem('ui.quit', { code: 'unsupported', message: 'unknown op quit' }).code).toBe(
      'helper_old',
    );
    expect(stepProblem('ui.list', { code: 'unsupported' }).code).toBe('unsupported');
    expect(stepProblem('ui.open', { code: 'not_found' }, { not_found: 'no_find_my' }).code).toBe(
      'no_find_my',
    );
    expect(stepProblem('look', {})).toEqual({ code: 'failed' });
  });

  it('cuts the largest picture, kept inside the screen, and knows a picture that wasn’t cut', () => {
    const el = (desc: string, w: number, h: number) =>
      toHostUiElement({ id: desc, role: 'AXImage', desc, x: 600, y: 120, w, h });
    expect(largestImage([el('Avatar', 48, 48), el('Map', 1800, 1200)])?.description).toBe('Map');
    expect(largestImage([])).toBeNull();
    expect(cropOf({ x: -10, y: 120, w: 1810, h: 3000 }, { w: 3840, h: 2160 })).toEqual({
      x: 0,
      y: 120,
      w: 1800,
      h: 2040,
    });
    expect(isCropOf({ w: 1280, h: 853 }, { w: 1800, h: 1200 })).toBe(true);
    // The whole 3840 × 2160 screen at 1280 px is not that crop.
    expect(isCropOf({ w: 1280, h: 720 }, { w: 1800, h: 1200 })).toBe(false);
    expect(isCropOf({ w: 3840, h: 2560 }, { w: 1800, h: 1200 })).toBe(false);
  });
});

/** A store on an injected clock whose waits only move that clock. */
function setup(mac = new FakeFindMyMac()) {
  let now = Date.parse('2026-11-22T20:00:00Z');
  const warned: { server: string; code: string }[] = [];
  const store = new FindMyStore({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    warn: (facts) => warned.push(facts),
  });
  const read = async () => {
    store.refresh(mac, 'studio', ACTOR, 'Studio');
    await store.idle('studio');
    return HostFindMy.parse(store.view('studio'));
  };
  return {
    mac,
    store,
    read,
    warned,
    later: (ms: number) => {
      now += ms;
    },
    elapsed: () => now - Date.parse('2026-11-22T20:00:00Z'),
  };
}

describe('a read', () => {
  it('unlocks a locked Mac, reads People and their streets, quits Find My and locks the Mac again', async () => {
    const { mac, read, warned, elapsed } = setup();
    mac.locked = true;
    // A locked Mac is nobody's at the moment, whatever its last key press.
    mac.idle = 5;
    const seen = await read();
    expect(seen.problem).toBeNull();
    expect(seen.reading).toBe(false);
    expect(Date.parse(seen.readAt ?? '')).toBe(Date.parse('2026-11-22T20:00:00Z') + elapsed());
    expect(seen.people.map((p) => [p.name, p.place, p.address, p.when, p.nearby])).toEqual([
      ['Mara Visser', 'Home', 'Damrak 1, Amsterdam', 'Now', true],
      ['Ruben Visser', 'Lelystad', 'Stationsplein 2, Lelystad', '5 min ago', false],
      ['Noor Visser', null, null, 'No location found', false],
    ]);
    expect(seen.people[0]?.id).toBe(findMyPersonId('Mara Visser'));
    expect(seen.people[0]?.location).toEqual({ lat: 52.3765, lon: 4.8962, accuracyM: 100 });
    expect(seen.people[2]?.location).toBeNull();

    const ops = mac.ops();
    expect(ops.slice(0, 4)).toEqual(['status', 'unlock', 'ui.apps', 'ui.open']);
    expect(mac.steps[3]).toMatchObject({ target: FIND_MY_APP });
    expect(mac.steps.find((s) => s.op === 'ui.press')).toMatchObject({ name: 'People', role: 'radio' });
    // Find My is put back and the Mac locked again before the geocoder runs (it works while locked).
    const quit = ops.indexOf('ui.quit');
    const lock = ops.indexOf('keys');
    expect(quit).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(quit);
    expect(ops.indexOf('map.geocode')).toBeGreaterThan(lock);
    expect(mac.steps[lock]).toMatchObject({ keys: 'ctrl+cmd+q' });
    expect(mac.steps.find((s) => s.op === 'map.geocode')).toEqual({
      op: 'map.geocode',
      queries: ['Damrak 1, Amsterdam', 'Stationsplein 2, Lelystad'],
    });
    expect(mac.locked).toBe(true);
    expect(mac.running).toBe(false);
    // Only rows and tabs are pressed: never a row's own actions (Remove Friend).
    expect(mac.ops()).not.toContain('ui.action');
    expect(warned).toEqual([]);
  });

  it('leaves Find My open and the Mac unlocked when that is how it found them', async () => {
    const { mac, read } = setup();
    mac.running = true;
    mac.idle = 75;
    expect((await read()).people).toHaveLength(3);
    expect(mac.ops()).not.toContain('unlock');
    expect(mac.ops()).not.toContain('ui.quit');
    expect(mac.ops()).not.toContain('keys');
    expect(mac.running).toBe(true);
  });

  it('leaves alone a Mac someone used in the last minute', async () => {
    const { mac, read, warned } = setup();
    mac.idle = 12;
    const seen = await read();
    expect(seen.problem).toEqual({ code: 'in_use' });
    expect(seen.people).toEqual([]);
    expect(mac.ops()).toEqual(['status']);
    expect(warned).toEqual([{ server: 'studio', code: 'in_use' }]);
  });

  it('says the helper is old before 1.1.0, or when the agent doesn’t say how long the Mac was left', async () => {
    const old = setup();
    old.mac.version = '1.0.6';
    expect((await old.read()).problem).toEqual({ code: 'helper_old' });
    expect(old.mac.ops()).toEqual(['status']);

    const oldAgent = setup();
    oldAgent.mac.idle = undefined;
    expect((await oldAgent.read()).problem).toEqual({ code: 'helper_old' });
    expect(oldAgent.mac.ops()).toEqual(['status']);
  });

  it('keeps the people when the geocoder is too old, and says why they have no place', async () => {
    const { mac, read } = setup();
    mac.geocodeUnsupported = true;
    const seen = await read();
    expect(seen.people).toHaveLength(3);
    expect(seen.people.every((p) => p.location === null)).toBe(true);
    expect(seen.problem?.code).toBe('helper_old');
  });

  it('stops when Find My never shows its tabs, and still puts the Mac back', async () => {
    const { mac, read, elapsed } = setup();
    mac.locked = true;
    mac.slowLists = Number.POSITIVE_INFINITY;
    const seen = await read();
    expect(seen.problem).toEqual({ code: 'no_find_my' });
    expect(mac.ops().filter((o) => o === 'ui.list')).toHaveLength(16);
    expect(elapsed()).toBe(8000);
    expect(mac.ops().slice(-2)).toEqual(['ui.quit', 'keys']);
    expect(mac.locked).toBe(true);
  });

  it('locks the Mac again when the unlock may have happened though it didn’t answer', async () => {
    const { mac, read } = setup();
    mac.locked = true;
    mac.unlockTimesOut = true;
    expect((await read()).problem?.code).toBe('timeout');
    expect(mac.ops()).toEqual(['status', 'unlock', 'keys']);
    expect(mac.locked).toBe(true);
  });

  it('says no_find_my when the Mac has no Find My', async () => {
    const { mac, read } = setup();
    mac.noApp = true;
    expect((await read()).problem?.code).toBe('no_find_my');
  });

  it('reads at most once in two minutes, and again after', async () => {
    const { mac, store, read, later } = setup();
    await read();
    const steps = mac.steps.length;
    later(90_000);
    expect(store.refresh(mac, 'studio', ACTOR, 'Studio').reading).toBe(false);
    await store.idle('studio');
    expect(mac.steps).toHaveLength(steps);
    later(31_000);
    expect(store.refresh(mac, 'studio', ACTOR, 'Studio').reading).toBe(true);
    await store.idle('studio');
    expect(mac.steps.length).toBeGreaterThan(steps);
  });

  it('runs one job at a time on a Mac: a read in line isn’t doubled, an exact picture waits for it', async () => {
    const { mac, store, read, later } = setup();
    await read();
    later(3 * MIN);
    const mara = findMyPersonId('Mara Visser');
    let open = () => {};
    mac.gate = new Promise((resolve) => {
      open = resolve;
    });
    const before = mac.steps.length;
    expect(store.refresh(mac, 'studio', ACTOR, 'Studio').reading).toBe(true);
    expect(store.refresh(mac, 'studio', ACTOR, 'Studio').reading).toBe(true);
    expect(store.exact(mac, 'studio', mara, ACTOR, 'Studio').exact).toMatchObject({
      person: mara,
      state: 'taking',
    });
    expect(store.exact(mac, 'studio', mara, ACTOR, 'Studio').exact?.state).toBe('taking');
    open();
    mac.gate = null;
    await store.idle('studio');
    expect(mac.maxInFlight).toBe(1);
    const ops = mac.steps.slice(before).map((s) => String(s.op));
    // One read, then one picture.
    expect(ops.filter((o) => o === 'status')).toHaveLength(2);
    expect(ops.filter((o) => o === 'look')).toHaveLength(1);
    expect(ops.indexOf('look')).toBeGreaterThan(ops.indexOf('map.geocode'));
    expect(store.view('studio')).toMatchObject({ reading: false, exact: { state: 'ready' } });
  });

  it('forgets everything an hour after the last look, never while someone keeps looking', async () => {
    const { store, read, later } = setup();
    await read();
    later(50 * MIN);
    expect(store.view('studio').people).toHaveLength(3);
    later(50 * MIN);
    expect(store.view('studio').people).toHaveLength(3);
    later(61 * MIN);
    store.sweep();
    expect(store.view('studio')).toEqual({
      server: 'studio',
      reading: false,
      readAt: null,
      problem: null,
      people: [],
      exact: null,
    });
  });
});

describe('a Find My connection’s reads', () => {
  it('tell whoever listens after a read that worked, and never after one that didn’t', async () => {
    const { mac, store, read, later } = setup();
    const told: { server: string; places: (string | null)[] }[] = [];
    const stop = store.onRead((server, people) => told.push({ server, places: people.map((p) => p.place) }));
    await read();
    expect(told).toEqual([{ server: 'studio', places: ['Home', 'Lelystad', null] }]);
    mac.idle = 5;
    later(3 * MIN);
    expect((await read()).problem?.code).toBe('in_use');
    expect(told).toHaveLength(1);
    stop();
  });

  it('keep what was read while the Mac is read in the background, and a background read isn’t a look', async () => {
    const { mac, store, later } = setup();
    store.hold(['Studio']);
    store.refresh(mac, 'studio', ACTOR, 'Studio', { look: false });
    await store.idle('studio');
    later(3 * 60 * MIN);
    store.sweep();
    expect(store.peek('studio')?.people).toHaveLength(3);
    // Once it isn't, the hour after the last look applies: the background read wasn't one.
    store.hold([]);
    store.sweep();
    expect(store.peek('studio')).toBeNull();
  });
});

describe('the exact picture', () => {
  it('cuts Find My’s map of the person from the screen, zoomed in, and keeps it ten minutes', async () => {
    const { mac, store, read, later } = setup();
    await read();
    mac.locked = true;
    const before = mac.steps.length;
    const mara = findMyPersonId('Mara Visser');
    store.exact(mac, 'studio', mara, ACTOR, 'Studio');
    await store.idle('studio');
    const steps = mac.steps.slice(before);
    expect(steps.filter((s) => s.op === 'ui.press' && s.name === 'Zoom in')).toHaveLength(2);
    expect(steps.find((s) => s.op === 'ui.press' && s.role === 'button')).toMatchObject({
      name: 'Mara Visser',
    });
    expect(steps.find((s) => s.op === 'look')).toEqual({
      op: 'look',
      crop: { x: 600, y: 120, w: 1800, h: 1200 },
      format: 'jpeg',
      max_w: 1280,
    });
    expect(steps.slice(-2).map((s) => s.op)).toEqual(['ui.quit', 'keys']);
    expect(mac.locked).toBe(true);

    const seen = store.view('studio');
    expect(seen.exact).toEqual({ person: mara, state: 'ready', takenAt: expect.any(String), problem: null });
    const pic = HostFindMyPicture.parse(store.picture('studio', mara, 'Studio'));
    expect(pic).toMatchObject({ person: mara, imageB64: 'ZmluZG15', format: 'jpeg', w: 1280, h: 853 });

    later(11 * MIN);
    expect(() => store.picture('studio', mara, 'Studio')).toThrow(/gone/);
    expect(store.view('studio').exact).toBeNull();
  });

  it('never keeps a picture that wasn’t cut: an agent that sends the whole screen is too old', async () => {
    const { mac, store, read } = setup();
    await read();
    mac.crops = false;
    const mara = findMyPersonId('Mara Visser');
    store.exact(mac, 'studio', mara, ACTOR, 'Studio');
    await store.idle('studio');
    expect(store.view('studio').exact).toMatchObject({ state: 'failed', problem: { code: 'helper_old' } });
    expect(() => store.picture('studio', mara, 'Studio')).toThrow();
  });

  it('fails, not waits, when a read in between no longer has the person', async () => {
    const { mac, store, read, later } = setup();
    await read();
    later(3 * MIN);
    const noor = findMyPersonId('Noor Visser');
    let open = () => {};
    mac.gate = new Promise((resolve) => {
      open = resolve;
    });
    store.refresh(mac, 'studio', ACTOR, 'Studio');
    store.exact(mac, 'studio', noor, ACTOR, 'Studio');
    mac.people = mac.people.filter((p) => p.name !== 'Noor Visser');
    open();
    mac.gate = null;
    await store.idle('studio');
    expect(store.view('studio').exact).toMatchObject({
      person: noor,
      state: 'failed',
      problem: { code: 'not_found' },
    });
  });

  it('is only for someone Whombat read', async () => {
    const { mac, store, read } = setup();
    expect(() => store.exact(mac, 'studio', findMyPersonId('Mara Visser'), ACTOR, 'Studio')).toThrow(
      /Read it again/,
    );
    await read();
    expect(() => store.exact(mac, 'studio', findMyPersonId('Somebody Else'), ACTOR, 'Studio')).toThrow();
  });
});

describe('the map', () => {
  it('pins everyone with a place in the page’s theme, names their spots and leaves out who falls outside', async () => {
    const { mac, store, read } = setup();
    await read();
    const map = HostFindMyMap.parse(
      await store.map(mac, 'studio', { w: 600, h: 400, dark: true }, ACTOR, 'Studio'),
    );
    expect(mac.steps.at(-1)).toEqual({
      op: 'map.snapshot',
      format: 'jpeg',
      pins: [
        { lat: 52.3765, lon: 4.8962 },
        { lat: 52.5085, lon: 5.4752 },
      ],
      w: 600,
      h: 400,
      scale: 2,
      dark: true,
    });
    expect(map).toMatchObject({ server: 'studio', w: 1200, h: 800, lat: 52.44, lon: 5.18, spanM: 30_000 });
    expect(map.points).toEqual([{ person: findMyPersonId('Mara Visser'), x: 10, y: 20 }]);
  });

  it('answers the same picture for a minute, and draws again after it or for another view', async () => {
    const { mac, store, read, later } = setup();
    await read();
    const q = { w: 600, h: 400 };
    await store.map(mac, 'studio', q, ACTOR, 'Studio');
    await store.map(mac, 'studio', q, ACTOR, 'Studio');
    expect(mac.ops().filter((o) => o === 'map.snapshot')).toHaveLength(1);
    await store.map(mac, 'studio', { ...q, lat: 52.4, lon: 5.0, spanM: 5000 }, ACTOR, 'Studio');
    expect(mac.steps.at(-1)).toMatchObject({ lat: 52.4, lon: 5.0, span_m: 5000 });
    later(61_000);
    await store.map(mac, 'studio', q, ACTOR, 'Studio');
    expect(mac.ops().filter((o) => o === 'map.snapshot')).toHaveLength(3);
  });

  it('needs someone with a place, unless it is asked where to look', async () => {
    const { mac, store } = setup();
    await expect(store.map(mac, 'studio', { w: 600, h: 400 }, ACTOR, 'Studio')).rejects.toThrow(/place/);
    const map = await store.map(
      mac,
      'studio',
      { w: 600, h: 400, lat: 52, lon: 5, spanM: 9000 },
      ACTOR,
      'Studio',
    );
    expect(map.points).toEqual([]);
  });
});
