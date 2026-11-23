/** The demo world's thing pages (connection-pages-mobile.md AP-1966): every answer parses; Restart is recorded. */
import { type AnyEndpoint, api } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
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
  const client = demoClient(server.fetch);
  return { server, client };
}

async function raw(
  s: ReturnType<typeof setup>,
  ep: AnyEndpoint,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: unknown }> {
  const res = await s.server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`, init);
  const data = (await res.json()) as unknown;
  if (res.ok) {
    const parsed = ep.response.safeParse(data);
    if (!parsed.success) throw new Error(`${ep.id}: ${parsed.error.message}`);
  }
  return { status: res.status, data };
}

const THINGS = [
  'connection:con_ha',
  'connection:con_unifi',
  'connection:con_hetzner',
  'connection:con_mail',
  'device:con_heatpump',
];

describe('thing page fixtures', () => {
  it('answers every connection and device of Home with a page that parses', async () => {
    const s = setup();
    const home = await s.client.request(api.home.overview, { params: { burrow } });
    if (home.status !== 'ok') throw new Error(home.status);
    const ids = home.data.things.filter((t) => t.kind !== 'server').map((t) => t.id);
    expect(ids.sort()).toEqual([...THINGS].sort());
    for (const thing of THINGS) {
      const res = await raw(s, api.things.page, `/things/${encodeURIComponent(thing)}`);
      expect(res.status, thing).toBe(200);
    }
  });

  it('is Find My through studio: its one tab names the Mac and has no panels', async () => {
    const s = setup();
    const res = await s.client.request(api.things.page, {
      params: { burrow, thing: 'connection:con_findmy' },
    });
    if (res.status !== 'ok') throw new Error(res.status);
    expect(res.data.tabs.map((t) => [t.key, t.server, t.panels.length])).toEqual([['findmy', 'studio', 0]]);
    expect(res.data.settings).toBe(true);
  });

  it('is Home Assistant in slots: Needs a look, runs on pve-02, its slots, nine notices', async () => {
    const s = setup();
    const res = await s.client.request(api.things.page, { params: { burrow, thing: 'connection:con_ha' } });
    if (res.status !== 'ok') throw new Error(res.status);
    const page = res.data;
    expect(page.badge).toBe('Needs a look');
    expect(page.runsOn?.name).toBe('homeassistant (pve-02)');
    const overview = page.tabs[0];
    // No row of figures: Live, what it has, the cameras, the week, who's home, the machine (service-slots.md).
    expect(overview?.panels.some((p) => p.kind === 'kpis')).toBe(false);
    expect(overview?.panels.filter((p) => p.place === 'chart').map((p) => p.id)).toEqual([
      'controls',
      'inventory',
      'cameras',
      'automations-week',
      'people',
      'machine',
    ]);
    const notices = overview?.panels.find((p) => p.kind === 'notices');
    expect(notices?.kind === 'notices' ? notices.items.length : 0).toBe(9);
    // Its range (CT-397): 24 hours by default, the picker's five, and a range asked for.
    expect([page.range, page.ranges]).toEqual(['24h', ['1h', '6h', '24h', '7d', '30d']]);
    const week = await s.client.request(api.things.page, {
      params: { burrow, thing: 'connection:con_ha' },
      query: { range: '7d' },
    });
    if (week.status !== 'ok') throw new Error(week.status);
    // Its week of automation runs is its own seven days, whatever the range.
    const chart = week.data.tabs[0]?.panels.find((p) => p.kind === 'chart');
    expect([week.data.range, chart?.kind === 'chart' ? chart.labels?.length : 0]).toEqual(['7d', 7]);
  });

  it('answers 404 for a thing it doesn’t have', async () => {
    const s = setup();
    const res = await raw(s, api.things.page, `/things/${encodeURIComponent('connection:con_nope')}`);
    expect(res.status).toBe(404);
  });

  it('restarts Home Assistant: the toast’s words, and the change on its Activity', async () => {
    const s = setup();
    const res = await raw(
      s,
      api.things.action,
      `/things/${encodeURIComponent('connection:con_ha')}/actions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restart' }),
      },
    );
    expect(res.status).toBe(202);
    expect(res.data).toMatchObject({ message: 'Restarting Home Assistant. It’s back in about a minute.' });
    const changes = await raw(
      s,
      api.changes.list,
      `/changes?thing=${encodeURIComponent('connection:con_ha')}`,
    );
    const list = (changes.data as { changes: { title: string }[] }).changes;
    expect(list[0]?.title).toBe('Restarted Home Assistant');
  });

  it('pages a thing’s changes and lists its own widgets', async () => {
    const s = setup();
    const thing = encodeURIComponent('connection:con_ha');
    const first = await raw(s, api.changes.list, `/changes?thing=${thing}&limit=2`);
    const page1 = first.data as { changes: { id: string }[]; before: string | null };
    expect(page1.changes).toHaveLength(2);
    expect(page1.before).not.toBeNull();
    const second = await raw(s, api.changes.list, `/changes?thing=${thing}&limit=2&before=${page1.before}`);
    expect((second.data as { changes: unknown[]; before: string | null }).before).toBeNull();
    const widgets = await raw(s, api.widgets.list, `/widgets?thing=${thing}`);
    expect((widgets.data as { widgets: { title: string }[] }).widgets.map((w) => w.title)).toEqual([
      'Database size',
    ]);
  });

  it('gives Plex its settings tab, its cards’ Ask and its verdict (SST-01…SST-10)', async () => {
    const s = setup();
    const res = await s.client.request(api.things.page, { params: { burrow, thing: 'connection:con_plex' } });
    if (res.status !== 'ok') throw new Error(res.status);
    const page = res.data;
    expect(page.verdict).toContain('Plex is fine');
    expect(page.tabs.map((t) => t.key).slice(0, 2)).toEqual([page.tabs[0]?.key, 'service-settings']);
    const tab = page.tabs.find((t) => t.key === 'service-settings');
    expect(tab?.label).toBe('Plex settings');
    const groups = tab?.panels.filter((p) => p.kind === 'settings') ?? [];
    expect(groups.map((g) => g.title)).toEqual([
      'Watching away from home',
      'Converting video',
      'Libraries',
      'Upkeep',
    ]);
    const quality = groups[0]?.kind === 'settings' ? groups[0].rows[1] : undefined;
    expect(quality?.id).toBe('remote_quality');
    expect(quality?.changed?.short).toContain('Neo');
    expect(quality?.changed?.changeId).toBeTruthy();
    expect(groups[0]?.ask?.questions.length).toBeGreaterThan(0);
    const playing = page.tabs[0]?.panels.find((p) => 'title' in p && p.title === 'Now playing');
    expect(playing?.ask?.questions.length).toBeGreaterThan(0);
  });

  it('changes a Plex setting, says it was checked, and puts it back once', async () => {
    const s = setup();
    const thing = encodeURIComponent('connection:con_plex');
    const press = (body: unknown) =>
      raw(s, api.things.action, `/things/${thing}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const changed = await press({ action: 'setting', target: 'remote_quality', value: 20000 });
    expect(changed.status).toBe(200);
    const answer = changed.data as { message: string; changeId: string; undoable: boolean };
    expect(answer.message).toContain('20 Mbps');
    expect(answer.message).toContain('Checked with Plex');
    expect(answer.undoable).toBe(true);
    // A value it doesn't offer is refused; the same value changes nothing.
    expect((await press({ action: 'setting', target: 'remote_quality', value: 123 })).status).toBe(400);
    const same = await press({ action: 'setting', target: 'remote_quality', value: 20000 });
    expect((same.data as { changeId?: string }).changeId).toBeUndefined();
    const undo = (id: string) =>
      raw(s, api.changes.undo, `/changes/${id}/undo`, { method: 'POST', body: '{}' });
    expect((await undo(answer.changeId)).status).toBe(200);
    const after = await s.client.request(api.things.page, {
      params: { burrow, thing: 'connection:con_plex' },
    });
    if (after.status !== 'ok') throw new Error(after.status);
    const rows = after.data.tabs.find((t) => t.key === 'service-settings')?.panels[1];
    expect(rows?.kind === 'settings' ? rows.rows[1]?.choose?.current : null).toBe(8000);
    // Remote access and Secure connections stay in Plex.
    expect((await press({ action: 'setting', target: 'remote_access', value: false })).status).toBe(400);
    expect((await press({ action: 'setting', target: 'secure_connections', value: 1 })).status).toBe(400);
    // Yesterday's change by Neo can't be put back now: the setting was changed since… and back. A switch flipped
    // twice leaves its first change behind it.
    const off = await press({ action: 'setting', target: 'hardware_transcoding', value: false });
    await press({ action: 'setting', target: 'hardware_transcoding', value: true });
    const refused = await undo((off.data as { changeId: string }).changeId);
    expect(refused.status).toBe(409);
  });
});
