import { DEFAULT_DESK_SHOW, DeskCalm, DeskPreview, type DeskShow } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  CalmReads,
  calmActivity,
  calmComing,
  calmNow,
  calmPreview,
  DISK_DAYS_KEEP_MS,
  deskCalmInput,
  RUNS_ON_KEEP_MS,
  SPARKS_KEEP_MS,
} from './calm';
import type { DeskCalmSources } from './calm-sources';
import { EMPTY_GLANCE, type FullGlance } from './glance';
import type { DeskServer } from './shapes';

const NOW = new Date('2026-10-27T14:34:00.000Z');
const viewer = { burrowId: 'brw_1', personId: 'prn_1', timeZone: 'Europe/Amsterdam' };
const place = { viewer, assistant: 'Neo' };

const card = (id: string, over: Partial<DeskServer> = {}): DeskServer => ({
  id,
  name: id,
  mark: 'proxmox',
  state: 'ok',
  note: 'up 41 d',
  cpu: { value: 12, tone: 'ok' },
  memory: { value: 40, tone: 'ok' },
  disk: { value: 30, tone: 'ok' },
  ...over,
});

function full(over: Partial<FullGlance> = {}): FullGlance {
  return {
    ...EMPTY_GLANCE,
    asks: [
      {
        number: 7,
        kind: 'approval',
        title: 'Restart Plex on blackbox?',
        at: '2026-10-27T14:00:00.000Z',
        onDesk: true,
      },
    ],
    askCount: 3,
    servers: [
      card('pve-02', { state: 'off', note: 'off' }),
      card('nas', { state: 'warn', note: 'Filling up', disk: { value: 88, tone: 'warn' } }),
      card('pve-01', { note: 'Installing updates' }),
      card('media'),
    ],
    everyLook: [
      { key: 'server:pve-02', kind: 'server', name: 'pve-02', state: 'down', server: 'pve-02' },
      { key: 'server:nas', kind: 'server', name: 'nas', state: 'look', reason: 'Filling up', server: 'nas' },
      { key: 'connection:con_ha', kind: 'connection', name: 'Home Assistant', state: 'look' },
    ],
    work: { title: 'Update the server agents', steps: [{ label: 'pve-01', state: 'now' }] },
    doing: 'updating your server agents',
    figures: [{ key: 'widget:wdg_1', name: 'Living room', value: '21.4 °C', active: false }],
    services: 14,
    doneToday: 3,
    downSince: { 'pve-02': '2026-10-27T14:30:00.000Z' },
    ...over,
  };
}

/** Sources that answer from what a test gives, counting their reads. */
function fakeSources(over: Partial<DeskCalmSources> = {}) {
  const calls: Record<string, number> = { sparks: 0, diskDays: 0, runsOn: 0, activities: 0 };
  const sources: DeskCalmSources = {
    activities: async () => {
      calls.activities = (calls.activities ?? 0) + 1;
      return [
        { key: 'connection:con_plex', name: 'Plex', mark: 'plex', value: '2 watching', active: true },
        { key: 'nope', name: 'Bad key', value: 'x', active: true },
      ];
    },
    activityLine: (catalogId) => (catalogId === 'plex' ? 'Who’s watching' : null),
    coming: async () => [
      { name: 'Backups', at: '2026-10-27T20:00:00Z' },
      { name: 'Updates', at: '2026-10-27T16:00:00Z' },
    ],
    sparks: async (_burrow, ids) => {
      calls.sparks = (calls.sparks ?? 0) + 1;
      return new Map(ids.map((id) => [id, [10, 12, 14]]));
    },
    diskDays: async () => {
      calls.diskDays = (calls.diskDays ?? 0) + 1;
      return 12;
    },
    runsOn: async () => {
      calls.runsOn = (calls.runsOn ?? 0) + 1;
      return ['Plex', 'Home Assistant', 'Pi-hole'];
    },
    update: async () => null,
    ...over,
  };
  return { sources, calls };
}

const never = <T>() => new Promise<T>(() => {});

describe('the calm glance’s input (DK-S122)', () => {
  it('gathers the asks, looks, servers, work, figures and the sources’ facts', async () => {
    const { sources } = fakeSources({ update: async () => 'installing' });
    const input = await deskCalmInput(full(), new CalmReads(sources, 50), place, NOW);
    expect(input).toMatchObject({
      assistant: 'Neo',
      timeZone: 'Europe/Amsterdam',
      asks: [{ number: 7, title: 'Restart Plex on blackbox?' }],
      askCount: 3,
      work: { title: 'Update the server agents', doing: 'updating your server agents' },
      services: 14,
      doneCount: 3,
      update: 'installing',
    });
    // A down server says what runs on it and since when it was last seen; a filling disk its forecast.
    expect(input.looks[0]).toMatchObject({
      key: 'server:pve-02',
      since: '2026-10-27T14:30:00.000Z',
      runsOn: ['Plex', 'Home Assistant', 'Pi-hole'],
    });
    expect(input.looks[1]).toMatchObject({ key: 'server:nas', disk: { pct: 88, days: 12 } });
    expect(input.looks[2]).not.toHaveProperty('disk');
    expect(input.servers.map((s) => [s.id, s.spark?.length ?? 0, s.updating ?? false])).toEqual([
      ['pve-02', 3, false],
      ['nas', 3, false],
      ['pve-01', 3, true],
      ['media', 3, false],
    ]);
    expect(input.servers[1]).toMatchObject({ cpu: 12, memory: 40, disk: 88, note: 'Filling up' });
    // A source's activity with a key no choice has is left out; what's coming up soonest first.
    expect(input.activities.map((a) => a.key)).toEqual(['connection:con_plex']);
    expect(input.coming.map((c) => c.name)).toEqual(['Updates', 'Backups']);
    expect(input.figures).toEqual(full().figures);
  });

  it('takes the time a look began from the runtime when it saw it begin', async () => {
    const { sources } = fakeSources();
    const since = (key: string) => (key === 'connection:con_ha' ? '2026-10-27T13:00:00.000Z' : undefined);
    const input = await deskCalmInput(full(), new CalmReads(sources, 50), place, NOW, since);
    expect(input.looks.find((l) => l.key === 'connection:con_ha')?.since).toBe('2026-10-27T13:00:00.000Z');
    expect(input.looks.find((l) => l.key === 'server:nas')).not.toHaveProperty('since');
  });

  it('cleans what the sources give to what the screen draws', () => {
    expect(
      calmActivity({
        key: 'connection:con_sab',
        name: 'Downloads​',
        mark: 'SAB!',
        value: '3 left\n· 20 min',
        progress: 162.4,
        active: true,
      }),
    ).toEqual({
      key: 'connection:con_sab',
      name: 'Downloads',
      value: '3 left · 20 min',
      progress: 100,
      active: true,
    });
    expect(calmActivity({ key: 'connection:x', name: ' ', value: '1', active: false })).toBeNull();
    expect(calmComing({ name: 'Backups', at: 'soon' })).toBeNull();
    expect(calmComing({ name: 'Backups', at: '2026-10-27T20:00:00+01:00' })?.at).toBe(
      '2026-10-27T19:00:00.000Z',
    );
  });
});

describe('the sources’ slow reads (DK-S124)', () => {
  it('keeps the sparks a minute, a disk forecast ten minutes and a down server’s guests a minute', async () => {
    const { sources, calls } = fakeSources();
    const reads = new CalmReads(sources, 50);
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    await deskCalmInput(full(), reads, place, at(0));
    await deskCalmInput(full(), reads, place, at(SPARKS_KEEP_MS - 1));
    expect(calls).toMatchObject({ sparks: 1, diskDays: 1, runsOn: 1, activities: 2 });
    await deskCalmInput(full(), reads, place, at(Math.max(SPARKS_KEEP_MS, RUNS_ON_KEEP_MS)));
    expect(calls).toMatchObject({ sparks: 2, diskDays: 1, runsOn: 2 });
    await deskCalmInput(full(), reads, place, at(DISK_DAYS_KEEP_MS));
    expect(calls.diskDays).toBe(2);
    // A new server reads every server's line again.
    await deskCalmInput(
      full({ servers: [...full().servers, card('pi-hole')] }),
      reads,
      place,
      at(DISK_DAYS_KEEP_MS),
    );
    expect(calls.sparks).toBe(4);
  });

  it('gives what it had when a source fails or is late, and doesn’t wait for a late one', async () => {
    let failing = false;
    let late = false;
    const { sources } = fakeSources({
      sparks: async (_b, ids) => {
        if (late) return never();
        if (failing) throw new Error('hosts down');
        return new Map(ids.map((id) => [id, [5, 6]]));
      },
      activities: () => (late ? never() : Promise.resolve([])),
      coming: () => (late ? never() : Promise.resolve([])),
      update: () => (late ? never() : Promise.resolve(null)),
      runsOn: () => (late ? never() : Promise.resolve([])),
      diskDays: () => (late ? never() : Promise.resolve(null)),
    });
    const reads = new CalmReads(sources, 5);
    await deskCalmInput(full(), reads, place, NOW);
    failing = true;
    const later = new Date(NOW.getTime() + SPARKS_KEEP_MS);
    expect((await deskCalmInput(full(), reads, place, later)).servers[0]?.spark).toEqual([5, 6]);
    late = true;
    const fresh = new CalmReads(sources, 5);
    const input = await deskCalmInput(full(), fresh, place, NOW);
    expect(input.servers.every((s) => s.spark === undefined)).toBe(true);
    expect(input.activities).toEqual([]);
    expect(DeskCalm.safeParse(calmNow(input, DEFAULT_DESK_SHOW, 'everything', NOW)).success).toBe(true);
  });
});

describe('the calm glance now (DK-101…DK-124)', () => {
  const show: DeskShow = DEFAULT_DESK_SHOW;

  it('is the planner’s, trimmed by the lock', async () => {
    const { sources } = fakeSources();
    const input = await deskCalmInput(full(), new CalmReads(sources, 50), place, NOW);
    const unlocked = calmNow(input, show, 'everything', NOW);
    expect(unlocked && DeskCalm.parse(unlocked)).toMatchObject({
      headline: { tone: 'bad' },
      clock: 'small',
      hero: { kind: 'look', look: 'server:pve-02', since: '2026-10-27T14:30:00.000Z' },
      doneCount: 3,
    });
    expect(unlocked?.hero?.detail).toContain('Plex');
    // The ask's words only unlocked or with *Everything* (DK-122).
    const asked = await deskCalmInput(full({ everyLook: [] }), new CalmReads(sources, 50), place, NOW);
    expect(calmNow(asked, show, 'everything', NOW)?.hero?.title).toContain('Restart Plex');
    expect(JSON.stringify(calmNow(asked, show, 'summary', NOW))).not.toContain('Restart Plex');
    const time = calmNow(input, show, 'time', NOW);
    expect(time).toMatchObject({ clock: 'big', strip: [], moments: [], also: [] });
    expect(time).not.toHaveProperty('hero');
  });

  it('shows Settings’ scenario with its banner while it lasts, trimmed by the lock, without Welcome back', async () => {
    const { sources } = fakeSources();
    const calm = await deskCalmInput(
      full({ everyLook: [], asks: [], askCount: 0, work: null, doing: null }),
      new CalmReads(sources, 50),
      place,
      NOW,
    );
    const until = NOW.getTime() + 60_000;
    const digest = { id: 'wb_abcdefgh', awayS: 3_600, items: [{ icon: 'done' as const, text: 'Renewed' }] };
    const sample = { scenario: 'wrong' as const, show, until };
    const trying = calmNow(calm, show, 'everything', NOW, { digest, sample });
    expect(trying).toMatchObject({
      sample: { scenario: 'wrong', until: new Date(until).toISOString() },
      hero: { kind: 'look' },
    });
    expect(trying).not.toHaveProperty('digest');
    expect(calmNow(calm, show, 'time', NOW, { sample })).not.toHaveProperty('hero');
    // Over: what's true again, and the digest with it.
    const after = calmNow(calm, show, 'everything', new Date(until), { digest, sample });
    expect(after).not.toHaveProperty('sample');
    expect(after?.digest?.id).toBe('wb_abcdefgh');
  });

  it('previews the choices on Settings’ page unlocked, with the name', async () => {
    const { sources } = fakeSources();
    const calm = await deskCalmInput(
      full({ asks: [], askCount: 0, work: null, doing: null }),
      new CalmReads(sources, 50),
      place,
      NOW,
    );
    const now = DeskPreview.parse(calmPreview(calm, show, 'now', 'Home', NOW));
    expect(now).toMatchObject({
      name: 'Home',
      calm: { headline: { tone: 'bad' }, hero: { look: 'server:pve-02' } },
    });
    // The page's choices, saved or not: what's off is off on the screen, its problems too (DK-104).
    const items = { 'server:pve-02': 'off', 'server:nas': 'off', 'connection:con_ha': 'off' } as const;
    const off = { ...show, items };
    expect(calmPreview(calm, off, 'now', 'Home', NOW).calm.headline.tone).toBe('ok');
    expect(calmPreview(calm, off, 'busy', 'Home', NOW).calm.headline.tone).toBe('busy');
    expect(calmPreview(calm, off, 'wrong', 'Home', NOW).calm.hero?.server).toBe('pve-01');
  });

  it('speaks the person’s language: now, while a scenario is tried, and in the preview', async () => {
    const { sources } = fakeSources();
    const input = await deskCalmInput(full(), new CalmReads(sources, 50), place, NOW);
    const english = calmNow(input, show, 'everything', NOW);
    const dutch = calmNow(input, show, 'everything', NOW, { locale: 'nl-NL' });
    expect(english?.headline.text).toContain('wrong');
    expect(dutch?.headline.text).toContain('mis');
    expect(dutch?.headline.tone).toBe(english?.headline.tone);
    // The scenario's own words too (the sample work).
    const quiet = await deskCalmInput(
      full({ everyLook: [], asks: [], askCount: 0, work: null, doing: null }),
      new CalmReads(sources, 50),
      place,
      NOW,
    );
    const sample = { scenario: 'busy' as const, show, until: NOW.getTime() + 60_000 };
    const trying = calmNow(quiet, show, 'everything', NOW, { sample, locale: 'nl-NL' });
    expect(JSON.stringify(trying)).toContain('bijwerken');
    expect(JSON.stringify(calmNow(quiet, show, 'everything', NOW, { sample }))).toContain('Updating');
    const preview = calmPreview(quiet, show, 'busy', 'Home', NOW, 'nl-NL');
    expect(preview.calm.headline.text).toContain('bezig');
    expect(JSON.stringify(preview)).toContain('bijwerken');
    expect(calmPreview(quiet, show, 'busy', 'Home', NOW).calm.headline.text).toContain('busy');
  });
});
