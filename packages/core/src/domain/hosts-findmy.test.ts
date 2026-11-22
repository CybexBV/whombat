/**
 * Find My on a Mac's page (docs/implementation/macos/findmy.md): the screen steps it needs, its state, the map and the
 * picture, and the words of a read that didn't work.
 */
import { describe, expect, it } from 'vitest';
import { api } from '../contracts/index.js';
import { HostScreenBody, HostScreenResult } from './hosts.js';
import {
  findMyProblemText,
  HostFindMy,
  HostFindMyExactBody,
  HostFindMyMapQuery,
  HostFindMyPerson,
} from './hosts-findmy.js';

const ok = (b: Record<string, unknown>) => HostScreenBody.safeParse(b).success;
const person = {
  id: '0123456789ab',
  name: 'Mara Visser',
  place: 'Home',
  address: 'Damrak 1, Amsterdam',
  when: 'Now',
  nearby: true,
  location: { lat: 52.37, lon: 4.89, accuracyM: 100 },
};

describe('the screen steps Find My uses', () => {
  it('runs an element’s own action by name, and quits an app', () => {
    expect(ok({ op: 'ui.action', name: 'Mara Visser', action: 'Open Details' })).toBe(true);
    expect(ok({ op: 'ui.action', name: 'Mara Visser' })).toBe(false);
    expect(ok({ op: 'ui.quit', app: 'com.apple.findmy' })).toBe(true);
    expect(ok({ op: 'ui.quit' })).toBe(false);
  });

  it('finds at most eight addresses at a time', () => {
    expect(ok({ op: 'map.geocode', queries: ['Damrak 1, Amsterdam'] })).toBe(true);
    expect(ok({ op: 'map.geocode', queries: [] })).toBe(false);
    expect(ok({ op: 'map.geocode', queries: Array(9).fill('Dam') })).toBe(false);
    expect(ok({ op: 'map.geocode', queries: ['a'.repeat(301)] })).toBe(false);
  });

  it('draws a map around pins or a centre, within its sizes', () => {
    expect(ok({ op: 'map.snapshot', w: 600, h: 400, pins: [{ lat: 52.37, lon: 4.89 }] })).toBe(true);
    expect(ok({ op: 'map.snapshot', w: 600, h: 400, lat: 52.37, lon: 4.89, spanM: 800, dark: true })).toBe(
      true,
    );
    expect(ok({ op: 'map.snapshot', w: 600, h: 400 })).toBe(false);
    expect(ok({ op: 'map.snapshot', w: 63, h: 400, pins: [{ lat: 1, lon: 1 }] })).toBe(false);
    expect(ok({ op: 'map.snapshot', w: 600, h: 400, pins: [{ lat: 91, lon: 1 }] })).toBe(false);
    expect(ok({ op: 'map.snapshot', w: 600, h: 400, scale: 3, pins: [{ lat: 1, lon: 1 }] })).toBe(false);
  });

  it('cuts a look to part of the screen', () => {
    expect(ok({ op: 'look', crop: { x: 10, y: 20, w: 300, h: 200 } })).toBe(true);
    expect(ok({ op: 'look', crop: { x: 10, y: 20, w: 0, h: 200 } })).toBe(false);
  });

  it('answers places and points, null where nothing was found', () => {
    const r = HostScreenResult.parse({
      server: 'studio',
      op: 'map.geocode',
      ok: true,
      places: [{ lat: 52.37, lon: 4.89, accuracyM: 100 }, null],
    });
    expect(r.places?.[1]).toBeNull();
  });
});

describe('hosts.findMy', () => {
  it('holds people with or without a place', () => {
    expect(HostFindMyPerson.safeParse(person).success).toBe(true);
    expect(HostFindMyPerson.safeParse({ ...person, address: null, location: null }).success).toBe(true);
    expect(HostFindMyPerson.safeParse({ ...person, id: 'Mara' }).success).toBe(false);
    const state = HostFindMy.parse({
      server: 'studio',
      reading: false,
      readAt: '2026-11-22T20:00:00.000Z',
      problem: { code: 'in_use' },
      people: [person],
      exact: { person: person.id, state: 'taking', takenAt: null, problem: null },
    });
    expect(state.problem?.code).toBe('in_use');
  });

  it('takes the map’s query as text and the exact picture’s person', () => {
    expect(HostFindMyMapQuery.parse({ w: '600', h: '400', dark: 'true' })).toEqual({
      w: 600,
      h: 400,
      dark: true,
    });
    expect(HostFindMyExactBody.safeParse({ person: person.id }).success).toBe(true);
  });

  it('has five ops on the Mac’s page', () => {
    expect(api.hosts.findMy.path).toBe('/burrows/:burrow/hosts/servers/:serverId/find-my');
    expect([api.hosts.findMyRefresh.method, api.hosts.findMyExact.method]).toEqual(['POST', 'POST']);
    expect([api.hosts.findMyMap.method, api.hosts.findMyPicture.method]).toEqual(['GET', 'GET']);
  });

  it('says what stopped a read in the person’s words', () => {
    expect(findMyProblemText('in_use', 'studio')).toContain('studio');
    expect(findMyProblemText('no_find_my', 'studio')).toContain('iCloud');
    expect(findMyProblemText('no_account', 'studio')).toContain('password');
  });
});
