/** Find My on the fixture Mac: a read that takes a moment, the made-up people, the map and the exact picture. */
import { ThingPage, ThingSummary } from '@whombat/core';
import {
  ConnectionView,
  HOST_FIND_MY_FRESH_MS,
  HostFindMy,
  HostFindMyMap,
  HostFindMyPicture,
} from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsFixtures } from './fixtures';
import { FIND_MY_FIXTURE_BACKGROUND, FIND_MY_FIXTURE_READ_MS, FIND_MY_PEOPLE } from './fixtures-findmy';
import {
  FIND_MY_CONNECTION_ID,
  findMyConnectionPage,
  findMyConnectionThing,
  findMyConnectionView,
} from './fixtures-findmy-connection';
import { MAC_SERVER, type MacScenario } from './fixtures-mac';

const NOW = Date.parse('2026-11-22T12:00:00Z');

function studio(scenario?: MacScenario) {
  let now = NOW;
  const fx = createHostsFixtures(NOW, {
    mac: { listed: true, clock: () => now, ...(scenario ? { scenario } : {}) },
  });
  const call = (method: string, rest: string, query: Record<string, string> = {}, body = {}) =>
    fx.handle({ method, path: `/servers/${MAC_SERVER}/find-my${rest}`, query, body });
  const read = () => HostFindMy.parse(call('GET', '')?.body);
  const refresh = () => HostFindMy.parse(call('POST', '/refresh')?.body);
  const later = (ms: number) => {
    now += ms;
  };
  return { call, read, refresh, later };
}

describe('Find My on the fixture Mac', () => {
  it('has read nothing, reads for a moment, then shows its made-up people', () => {
    const { read, refresh, later } = studio();
    expect(read()).toMatchObject({ reading: false, readAt: null, people: [] });
    expect(refresh().reading).toBe(true);
    later(FIND_MY_FIXTURE_READ_MS);
    const s = read();
    expect(s.reading).toBe(false);
    expect(s.readAt).not.toBeNull();
    expect(s.people.map((p) => p.name)).toEqual(FIND_MY_PEOPLE.map((p) => p.name));
    expect(s.people.filter((p) => !p.place)).toHaveLength(1);
  });

  it('reads once while the last read is fresh', () => {
    const { read, refresh, later } = studio();
    refresh();
    later(FIND_MY_FIXTURE_READ_MS);
    const readAt = read().readAt;
    later(10_000);
    expect(refresh()).toMatchObject({ reading: false, readAt });
    later(HOST_FIND_MY_FRESH_MS);
    expect(refresh().reading).toBe(true);
  });

  it('says what stops a read: the helper, the screen, someone at the Mac, nobody sharing', () => {
    expect(studio('no-helper').refresh().problem?.code).toBe('no_helper');
    expect(studio('sharing-off').refresh().problem?.code).toBe('no_screen');
    expect(studio('setup').refresh().problem?.code).toBe('no_account');
    const used = studio('in-use');
    used.refresh();
    used.later(FIND_MY_FIXTURE_READ_MS);
    expect(used.read()).toMatchObject({ problem: { code: 'in_use' }, people: [] });
    const nobody = studio('nobody');
    nobody.refresh();
    nobody.later(FIND_MY_FIXTURE_READ_MS);
    expect(nobody.read()).toMatchObject({ problem: null, people: [] });
    expect(nobody.read().readAt).not.toBeNull();
  });

  it('draws a map that fits everyone with a place, in the asked theme, and zooms around a region', () => {
    const { call, refresh, later } = studio();
    refresh();
    later(FIND_MY_FIXTURE_READ_MS);
    const fit = HostFindMyMap.parse(call('GET', '/map', { w: '640', h: '384', dark: 'false' })?.body);
    expect(fit.points.map((p) => p.person).sort()).toEqual(
      FIND_MY_PEOPLE.filter((p) => p.location)
        .map((p) => p.id)
        .sort(),
    );
    for (const p of fit.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(640);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(384);
    }
    expect(fit.spanM).toBeGreaterThanOrEqual(600);
    const dark = HostFindMyMap.parse(call('GET', '/map', { w: '640', h: '384', dark: 'true' })?.body);
    expect(dark.imageB64).not.toBe(fit.imageB64);
    const zoomed = HostFindMyMap.parse(
      call('GET', '/map', {
        w: '640',
        h: '384',
        lat: String(fit.lat),
        lon: String(fit.lon),
        spanM: String(fit.spanM / 8),
      })?.body,
    );
    expect(zoomed.spanM).toBe(Math.round(fit.spanM / 8));
    expect(zoomed.points.length).toBeLessThan(fit.points.length);
    expect(call('GET', '/map', { w: '10', h: '384' })?.status).toBe(400);
  });

  it('takes the exact picture of a person with a place, and refuses one without', () => {
    const { call, refresh, later } = studio();
    refresh();
    later(FIND_MY_FIXTURE_READ_MS);
    const ilse = 'b6b64347cde5';
    const asked = HostFindMy.parse(call('POST', '/exact', {}, { person: ilse })?.body);
    expect(asked.exact).toMatchObject({ person: ilse, state: 'taking' });
    expect(call('GET', '/picture', { person: ilse })?.status).toBe(404);
    later(FIND_MY_FIXTURE_READ_MS);
    const ready = HostFindMy.parse(call('GET', '')?.body);
    expect(ready.exact).toMatchObject({ person: ilse, state: 'ready' });
    const picture = HostFindMyPicture.parse(call('GET', '/picture', { person: ilse })?.body);
    expect(picture).toMatchObject({ person: ilse, format: 'png', takenAt: ready.exact?.takenAt });
    const sem = HostFindMy.parse(call('POST', '/exact', {}, { person: '9c651d225f5b' })?.body);
    expect(sem.exact).toMatchObject({ state: 'failed', problem: { code: 'not_found' } });
    expect(call('POST', '/exact', {}, { person: 'Ilse' })?.status).toBe(400);
  });
});

describe('the fixture worlds’ Find My connection', () => {
  const at = new Date(NOW).toISOString();

  it('names studio as its Mac in its fields, its page’s tab and its read', () => {
    const view = ConnectionView.parse(findMyConnectionView(at));
    expect(view.fields).toEqual({ mac: MAC_SERVER, background: '15' });
    const page = ThingPage.parse(findMyConnectionPage(at));
    expect(page.connectionId).toBe(FIND_MY_CONNECTION_ID);
    expect(page.tabs[0]).toMatchObject({ key: 'findmy', server: MAC_SERVER, panels: [] });
    expect(ThingSummary.parse(findMyConnectionThing()).catalogId).toBe('findmy');
    const { read } = studio();
    expect(read().background).toEqual(FIND_MY_FIXTURE_BACKGROUND);
  });
});
