/**
 * studio, the demo world's Mac (macos-servers.md MAC-34…MAC-36): its page, a picture of its screen, its password, and
 * its Find My with made-up people.
 */
import { FIND_MY_WORDS, findMyView, macScreenView, serverDashboardSeries } from '@whombat/client/hosts';
import { api } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';
const serverId = 'studio';

function setup() {
  const now = createClock(new Date(at('14:05')), Date.now());
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    setTimer: () => {},
    assistant: true,
  });
  return demoClient(server.fetch);
}

describe('studio, a Mac in the demo world', () => {
  it('reads as a Mac with its own facts and history', async () => {
    const client = setup();
    const d = await client.request(api.hosts.getServer, {
      params: { burrow, serverId },
      query: { range: '24h' },
    });
    if (d.status !== 'ok') throw new Error(d.status);
    expect(d.data.server.platform).toBe('macos');
    expect(d.data.server.os?.kernel).toContain('Darwin');
    expect(d.data.macos?.chip).toBe('Apple M2 Ultra');
    const series = await client.request(api.hosts.serverMetrics, {
      params: { burrow, serverId },
      query: { range: '24h', series: serverDashboardSeries(d.data).join(',') },
    });
    expect(series.status).toBe('ok');
    const view = macScreenView(d.data, { name: serverId, owner: true, now: Date.parse(d.data.asOf) });
    expect(view?.screen.can).toBe(true);
    expect(view?.needsAccess).toBe(true);
  });

  it('gives a picture of its screen and takes its password once', async () => {
    const client = setup();
    const look = await client.request(api.hosts.screenLook, {
      params: { burrow, serverId },
      query: { maxW: 1280, format: 'jpeg' },
    });
    if (look.status !== 'ok') throw new Error(look.status);
    expect(look.data).toMatchObject({ ok: true, screenW: 3840 });
    expect(look.data.imageB64?.length).toBeGreaterThan(100);

    const set = await client.request(api.hosts.screen, {
      params: { burrow, serverId },
      body: { op: 'account.set', account: { user: 'mara', password: 'wrong' } },
    });
    expect(set.status === 'ok' && set.data).toMatchObject({ ok: false, code: 'sign_in_failed' });
    const cleared = await client.request(api.hosts.screen, {
      params: { burrow, serverId },
      body: { op: 'account.clear' },
    });
    expect(cleared.status === 'ok' && cleared.data.status?.account).toBeNull();
  });
});

describe('studio’s Find My in the demo world', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads for a moment on the demo clock, then shows made-up people, their map and an exact picture', async () => {
    // Only the clock is fake: the demo world's runs on Date.now.
    vi.useFakeTimers({ toFake: ['Date'] });
    const client = setup();
    const params = { burrow, serverId };
    const later = () => vi.setSystemTime(Date.now() + 3000);

    const started = await client.request(api.hosts.findMyRefresh, { params, body: {} });
    if (started.status !== 'ok') throw new Error(started.status);
    expect(started.data.reading).toBe(true);
    later();
    const read = await client.request(api.hosts.findMy, { params });
    if (read.status !== 'ok') throw new Error(read.status);
    expect(read.data.people.length).toBeGreaterThanOrEqual(3);
    const view = findMyView(read.data, {
      name: serverId,
      now: Date.parse(read.data.readAt ?? ''),
      screen: { can: true, why: null },
    });
    expect(view.people.some((p) => p.line === FIND_MY_WORDS.noPlace)).toBe(true);

    const map = await client.request(api.hosts.findMyMap, {
      params,
      query: { w: 384, h: 256, dark: 'true' },
    });
    if (map.status !== 'ok') throw new Error(map.status);
    expect(map.data.points.length).toBe(view.people.filter((p) => p.located).length);
    expect(map.data.imageB64.length).toBeGreaterThan(100);

    const person = view.people.find((p) => p.placed)?.id ?? '';
    const exact = await client.request(api.hosts.findMyExact, { params, body: { person } });
    expect(exact.status === 'ok' && exact.data.exact?.state).toBe('taking');
    later();
    const picture = await client.request(api.hosts.findMyPicture, { params, query: { person } });
    if (picture.status !== 'ok') throw new Error(picture.status);
    expect(picture.data).toMatchObject({ person, format: 'png' });
  });
});

describe('Find My’s timeline in the demo world', () => {
  const params = { burrow, connectionId: 'con_findmy' };
  const tz = 'Europe/Amsterdam';

  it('keeps Noor and Ruben, draws a day’s map, and its assistant switch is the tool’s tier', async () => {
    const client = setup();
    const today = new Date(at('14:05')).toISOString().slice(0, 10);
    const day = await client.request(api.connections.findMyTimeline, {
      params,
      query: { date: today, tz, days: 1 },
    });
    if (day.status !== 'ok') throw new Error(day.status);
    expect(day.data.people.filter((p) => p.kept).map((p) => p.name)).toEqual(['Noor Visser', 'Ruben Visser']);
    expect(day.data.assistantReads).toBe(true);
    const ruben = day.data.people.find((p) => p.name === 'Ruben Visser')?.id ?? '';
    const map = await client.request(api.connections.findMyTimelineMap, {
      params,
      query: { person: ruben, date: today, tz, w: 320, h: 224, dark: 'false' },
    });
    expect(map.status === 'ok' && map.data.points.length).toBeGreaterThan(0);

    const off = await client.request(api.connections.setTool, {
      params: { ...params, tool: 'findmy_timeline' },
      body: { tier: 'off' },
    });
    expect(off.status === 'ok' && off.data.tools.find((t) => t.name === 'findmy_timeline')?.tier).toBe('off');
    const after = await client.request(api.connections.findMyTimeline, {
      params,
      query: { date: today, tz, days: 7 },
    });
    expect(after.status === 'ok' && after.data.assistantReads).toBe(false);
    expect(after.status === 'ok' && after.data.days).toHaveLength(7);

    const stopped = await client.request(api.connections.findMyTimelineSet, { params, body: { people: [] } });
    expect(stopped.status === 'ok' && stopped.data.people.some((p) => p.kept)).toBe(false);
  });
});
