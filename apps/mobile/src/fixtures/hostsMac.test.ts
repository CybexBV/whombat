/** studio, the demo world's Mac (macos-servers.md MAC-34…MAC-36): its page, a picture of its screen, its password. */
import { macScreenView, serverDashboardSeries } from '@whombat/client/hosts';
import { api } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
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
