/**
 * Monitoring in the demo world: UniFi and the-falcon kept quiet,
 * Seerr down while its machine is stopped, What happened for every thing, and a server check's limit with Undo — each
 * answer through the session, parsed with its endpoint's schema.
 */
import { heldLine, historyView, thingStateWords, withoutHoldLine } from '@whombat/client';
import { api, type ThingPage, type ThingPageNotice, type ThingPagePanel } from '@whombat/core';
import { at, SERVICE_THINGS } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { splitHeld } from '../data/serviceSlots';
import { noticeRows } from '../data/thingPage';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { createFixtureServer } from './fixture-server';
import { MONITORING_THINGS } from './monitoring';

const burrow = 'burrow-hq';
const ZONE = 'Europe/Amsterdam';

function setup() {
  const now = createClock(new Date(at('14:05')), Date.now());
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    setTimer: () => {},
    assistant: true,
    services: true,
  });
  return { client: demoClient(server.fetch, { validateResponses: true }), now };
}

/** The strip as the page draws it: without the hold's heads-up line, which the line under the head says. */
const withoutHold = (
  panel: Extract<ThingPagePanel, { kind: 'notices' }>,
  page: ThingPage,
): Extract<ThingPagePanel, { kind: 'notices' }> => ({
  ...panel,
  items: [...withoutHoldLine(panel.items, page)],
});

const lines = (page: ThingPage): ThingPageNotice[] =>
  page.tabs.flatMap((t) => t.panels.flatMap((p) => (p.kind === 'notices' ? p.items : [])));

async function ok<T>(p: Promise<{ status: string; data?: T }>): Promise<T> {
  const res = await p;
  if (res.status !== 'ok') throw new Error(`answered ${res.status}`);
  return res.data as T;
}

describe('monitoring in the demo world', () => {
  it('keeps UniFi quiet until tonight: its words, End now, held lines and the heads-up for older apps', async () => {
    const { client } = setup();
    const thing = MONITORING_THINGS.unifi;
    const page = await ok(client.request(api.things.page, { params: { burrow, thing } }));
    expect(page.keptQuiet?.words).toMatch(/^Quiet until 23:00 · /);
    expect(page.keptQuiet?.canEnd).toBe(true);
    const items = lines(page);
    expect(items[0]?.id).toBe('quiet-window');
    expect(items.filter((n) => n.check).every((n) => heldLine(n) === 'window')).toBe(true);
    // Its strip folds them under “Show N on hold”, as a server's page does: none is among the lines shown.
    const strip = page.tabs[0]?.panels.find(
      (p): p is Extract<ThingPagePanel, { kind: 'notices' }> => p.kind === 'notices' && p.place === 'top',
    );
    expect(strip).toBeTruthy();
    const rows = noticeRows(withoutHold(strip as NonNullable<typeof strip>, page), [], { quiet: true });
    const { lines: shown, held } = splitHeld(rows);
    expect(held.length).toBeGreaterThan(0);
    expect(shown.some((r) => r.endNow)).toBe(false);
    // The week's line, and the same words among the facts for an app that doesn't draw it.
    expect(page.uptime?.text).toBeTruthy();
    expect(page.facts.some((f) => f.map((p) => p.text).join('') === page.uptime?.text)).toBe(true);
  });

  it('ends the window now and keeps quiet again for an hour', async () => {
    const { client } = setup();
    const thing = MONITORING_THINGS.unifi;
    const ended = await ok(client.request(api.things.endQuiet, { params: { burrow, thing } }));
    expect(ended.keptQuiet).toBeNull();
    const after = await ok(client.request(api.things.page, { params: { burrow, thing } }));
    expect(after.keptQuiet).toBeUndefined();
    expect(lines(after).some((n) => heldLine(n))).toBe(false);
    const kept = await ok(
      client.request(api.things.keepQuiet, {
        params: { burrow, thing },
        body: { minutes: 60, note: 'Firmware' },
      }),
    );
    expect(kept.keptQuiet?.words).toBe('Quiet until 15:05 · Firmware');
    const home = await ok(client.request(api.home.overview, { params: { burrow } }));
    const row = home.things.find((t) => t.id === thing);
    expect(row && thingStateWords(row, Date.parse(at('14:05')), ZONE)).toBe('Quiet until 15:05');
  });

  it('refuses a time that has passed', async () => {
    const { client } = setup();
    await expect(
      client.request(api.things.keepQuiet, {
        params: { burrow, thing: MONITORING_THINGS.unifi },
        body: { until: at('13:00') },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('keeps the-falcon quiet with its alerts held and no banner', async () => {
    const { client } = setup();
    const d = await ok(client.request(api.hosts.getServer, { params: { burrow, serverId: 'the-falcon' } }));
    expect(d.keptQuiet?.words).toMatch(/^Quiet until 23:00/);
    expect(d.banner ?? null).toBeNull();
    expect((d.alerts ?? []).filter((a) => a.state === 'open').every((a) => a.quiet?.held === 'window')).toBe(
      true,
    );
    expect(d.uptime?.text).toBeTruthy();
  });

  it('says Seerr isn’t answering while its machine is stopped, grey, with the cause’s page', async () => {
    const { client } = setup();
    const thing = SERVICE_THINGS.seerr;
    const page = await ok(client.request(api.things.page, { params: { burrow, thing } }));
    expect(page.causedBy?.words).toBe('Not answering while media is stopped');
    expect(page.causedBy?.href).toContain('server%3Apve-02');
    expect(page.status).toBe('unknown');
    expect(page.badge).toBe(page.causedBy?.words);
    expect(lines(page)[0]?.id).toBe('quiet-cause');
    const home = await ok(client.request(api.home.overview, { params: { burrow } }));
    const row = home.things.find((t) => t.id === thing);
    expect(row?.status).toBe('unknown');
    expect(row?.causedBy?.name).toBe('media');
  });

  it('lists what happened over 30 days: a server’s incidents and alerts, nothing for a quiet thing', async () => {
    const { client } = setup();
    const pve = await ok(
      client.request(api.things.history, {
        params: { burrow, thing: MONITORING_THINGS.pve02 },
        query: { days: 30 },
      }),
    );
    expect(pve.incidents.length).toBeGreaterThan(0);
    expect(pve.alerts?.length).toBeGreaterThan(0);
    expect(pve.uptime?.text).toMatch(/^Up /);
    // The server's own “isn’t checking in” is the outage its incidents already list: the card says it once.
    const view = historyView(pve, Date.parse(at('14:05')), ZONE);
    expect(view.rows.some((r) => r.words === 'Not answering')).toBe(true);
    expect(view.alerts.map((a) => a.words)).not.toContain('pve-02 isn’t checking in');
    expect(view.alerts.length).toBeGreaterThan(0);
    const quiet = await ok(
      client.request(api.things.history, { params: { burrow, thing: 'server:pve-01' }, query: { days: 30 } }),
    );
    expect(quiet.incidents).toEqual([]);
    expect(quiet.alerts).toEqual([]);
  });

  it('changes a server check’s limit and puts it back with Undo', async () => {
    const { client } = setup();
    const thing = MONITORING_THINGS.pve02;
    const watch = await ok(client.request(api.things.watch, { params: { burrow, thing } }));
    const space = watch.checks.find((c) => c.check === 'host.disk.space_high');
    expect(space?.limit?.defaultValue).toBe(90);
    expect(space?.limit?.items.map((i) => i.subject.name)).toEqual(['/mnt/backup']);
    const set = await ok(
      client.request(api.things.setWatchLimit, {
        params: { burrow, thing },
        body: { check: 'host.disk.space_high', limit: 85 },
      }),
    );
    expect(set.watch.checks.find((c) => c.check === 'host.disk.space_high')?.limit?.value).toBe(85);
    if (!set.changeId) throw new Error('no change to undo');
    await ok(client.request(api.changes.undo, { params: { burrow, changeId: set.changeId } }));
    const back = await ok(client.request(api.things.watch, { params: { burrow, thing } }));
    expect(back.checks.find((c) => c.check === 'host.disk.space_high')?.limit?.value).toBeNull();
    await expect(
      client.request(api.things.setWatchLimit, {
        params: { burrow, thing },
        body: { check: 'host.disk.space_high', limit: 140 },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a warning at or above the critical limit, as the hub does, in words the sheet can show', async () => {
    const { client } = setup();
    const thing = MONITORING_THINGS.pve02;
    const set = (check: string, limit: number) =>
      client.request(api.things.setWatchLimit, { params: { burrow, thing }, body: { check, limit } });
    await expect(set('host.sensor.temp_high', 100)).rejects.toMatchObject({
      message: expect.stringContaining('below the critical limit of 95 °C'),
    });
    await expect(set('host.disk.wear_high', 90)).rejects.toMatchObject({
      message: expect.stringContaining('below the critical limit of 90 %'),
    });
    await ok(set('host.disk.wear_high', 80));
    await expect(set('host.disk.wear_critical', 80)).rejects.toMatchObject({
      message: expect.stringContaining('above the warning limit of 80 %'),
    });
    await ok(set('host.sensor.temp_high', 85));
  });
});
