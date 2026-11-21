/**
 * Quiet notices in the demo world (quiet-notices-mobile.md AP-4870): a service page's lines and a server's can be
 * ignored and taken back, What Whombat watches answers for both, and every answer parses with its endpoint's schema.
 */
import { noticeRef, quietMenu } from '@whombat/client';
import { api, type ThingPage, type ThingPageNotice } from '@whombat/core';
import { at, SERVICE_THINGS } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

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

const lines = (page: ThingPage): ThingPageNotice[] =>
  page.tabs.flatMap((t) => t.panels.flatMap((p) => (p.kind === 'notices' ? p.items : [])));

describe('quiet notices in the demo world', () => {
  it('ignores a service page’s line until it changes, greys it, and takes it back', async () => {
    const client = setup();
    const thing = SERVICE_THINGS.sabnzbd;
    const read = async () => {
      const res = await client.request(api.things.page, { params: { burrow, thing } });
      if (res.status !== 'ok') throw new Error(res.status);
      return res.data;
    };
    const line = lines(await read()).find((n) => quietMenu(n));
    const ref = line ? noticeRef(line) : null;
    if (!line || !ref) throw new Error('no line with a menu');
    const ignored = await client.request(api.things.quiet, {
      params: { burrow, thing },
      body: { notice: ref, how: 'ignore' },
    });
    if (ignored.status !== 'ok') throw new Error(ignored.status);
    expect(ignored.data.quiet?.state).toBe('ignored');
    expect(lines(await read()).find((n) => n.id === line.id)?.quiet?.state).toBe('ignored');
    const watch = await client.request(api.things.watch, { params: { burrow, thing } });
    if (watch.status !== 'ok') throw new Error(watch.status);
    expect(watch.data.checks.find((c) => c.check === ref.check)?.exceptions.length).toBeGreaterThan(0);
    const back = await client.request(api.things.quiet, {
      params: { burrow, thing },
      body: { notice: ref, how: 'undo' },
    });
    if (back.status !== 'ok') throw new Error(back.status);
    expect(lines(await read()).find((n) => n.id === line.id)?.quiet).toBeUndefined();
  });

  it('quiets a server’s hint and stops watching a check for it, as the runtime does', async () => {
    const client = setup();
    const thing = 'server:pve-02';
    const read = async () => {
      const res = await client.request(api.hosts.getServer, { params: { burrow, serverId: 'pve-02' } });
      if (res.status !== 'ok') throw new Error(res.status);
      return res.data;
    };
    const watch = await client.request(api.things.watch, { params: { burrow, thing } });
    if (watch.status !== 'ok') throw new Error(watch.status);
    expect(watch.data.mayChange).toBe(true);
    const before = await read();
    const hint = before.hints[0];
    if (!hint) throw new Error('pve-02 has no hints');
    const check = watch.data.checks.find((c) => c.check.startsWith(`host.hint.${hint.kind}`))?.check;
    if (!check) throw new Error(`no check for ${hint.kind}`);
    const off = await client.request(api.things.setWatch, {
      params: { burrow, thing },
      body: { check, watched: false },
    });
    if (off.status !== 'ok') throw new Error(off.status);
    expect(off.data.checks.find((c) => c.check === check)?.on).toBe(false);
    expect((await read()).hints.some((h) => h.kind === hint.kind)).toBe(false);
    const on = await client.request(api.things.setWatch, {
      params: { burrow, thing },
      body: { check, watched: true },
    });
    if (on.status !== 'ok') throw new Error(on.status);
    expect((await read()).hints.some((h) => h.kind === hint.kind)).toBe(true);
  });
});
