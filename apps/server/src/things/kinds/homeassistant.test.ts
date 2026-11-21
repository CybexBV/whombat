/**
 * Home Assistant's page and tile from its WebSocket API (connection-pages.md CP-07, CP-16; connection-pages-server.md
 * CP-S08…CP-S13; dashboards.md DS-11), against a fake Home Assistant on a real socket: the sign-in, the read, the
 * Summary in slots with the house's parts, and the words.
 */
import { ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { type Stub, startStub } from '../../connections/provision/testing-home';
import { pictureRef } from '../../desk/widgets/thing-testing';
import { diskPoints, haSeenPoints } from '../../home/health';
import type { MachineFigures } from '../runs-on';
import type { RawPoint } from '../series';
import { type FakeHaState, fakeHaState, fakeHomeAssistant } from '../testing/fake-ha';
import { bufferMessages, HaAuthInvalid, haSession } from './ha-socket';
import {
  HA_houseAreas,
  HA_houseDevices,
  HA_houseEvent,
  HA_houseRegistry,
  HA_logbook,
} from './home/fixtures/ha-house';
import {
  HA_areas,
  HA_devices,
  HA_home,
  HA_registry,
  HA_security,
  HA_states,
  HA_unit,
} from './home/fixtures/homeassistant';
import { controlsPanel, favouritesOf, parseLayout, pickEntities, statesOf } from './home/ha-controls';
import { type HaHouseRead, parseHouse, runsOf } from './home/ha-house';
import {
  addedThisWeek,
  databaseName,
  emptySnapshot,
  errorsToday,
  type HaCtx,
  type HaParts,
  type HaPoints,
  type HaSnapshot,
  HOME_ASSISTANT_CHECKS,
  haActions,
  haMachineLines,
  haNotices,
  haSeenNotices,
  haSkipped,
  haSlots,
  haView,
  healthDone,
  homeAssistantGlance,
  logErrors,
  loggerDomain,
  NO_PARTS,
  NO_POINTS,
  readHomeAssistant,
  shortVersion,
} from './homeassistant';
import { slotProblems } from './slots';

let stub: Stub | null = null;

// The fake's log entries are a minute or two old and “errors today” starts at local midnight, so a run just after
// midnight counted only some of them. Every test reads at midday; only the date is fake, the sockets' timers are real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-28T12:00:00+01:00'), shouldAdvanceTime: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await stub?.close();
  stub = null;
});

async function read(state: FakeHaState, token = state.token) {
  stub = await startStub(() => ({ status: 404 }), { websocket: fakeHomeAssistant(state) });
  const ws = new WebSocket(`${stub.url.replace(/^http/, 'ws')}/api/websocket`);
  const buffer = bufferMessages(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const ha = await haSession(buffer, token);
  try {
    return await readHomeAssistant(ha, new Date());
  } finally {
    ha.close();
  }
}

const TZ = 'Europe/Amsterdam';

const ctxOf = (over: Partial<HaCtx> = {}): HaCtx => ({
  now: new Date(),
  timeZone: TZ,
  openUrl: 'http://10.100.0.5:8123',
  range: '24h',
  points: NO_POINTS,
  ...over,
});

/** What the health pass kept: every 5 minutes for a day, every hour before that (`f(hoursAgo)`). */
function kept(days: number, f: (hoursAgo: number) => number | null, now = new Date()): RawPoint[] {
  const out: RawPoint[] = [];
  for (let h = days * 24; h > 24; h--) out.push({ at: new Date(now.getTime() - h * 3600_000), value: f(h) });
  for (let m = 24 * 60; m >= 0; m -= 5)
    out.push({ at: new Date(now.getTime() - m * 60_000), value: f(m / 60) });
  return out;
}

const ct131: MachineFigures = {
  kind: 'guest',
  name: 'pve-02 · CT 131',
  label: 'CT 131',
  cpuPct: 5,
  cores: 4,
  memoryUsedGb: 3,
  memoryTotalGb: 8,
  diskUsedGb: 30.4,
  diskTotalGb: 40,
  uptimeS: 6 * 7 * 86_400,
  lastBackup: { at: new Date(Date.now() - 3600_000).toISOString(), result: 'ok' },
  backupJob: true,
  series: {
    timestamps: [new Date(Date.now() - 600_000).toISOString(), new Date().toISOString()],
    cpu: [4, 5],
    memoryGb: [2.9, 3],
  },
};

describe('reading Home Assistant', () => {
  it('signs in and reads how it runs, every command at once', async () => {
    const state = fakeHaState();
    const s = await read(state);
    expect(s).toMatchObject({
      version: '2026.10.2',
      installation: 'Container',
      recoveryMode: false,
      notAdmin: false,
      counts: { updates: 2, unavailable: 12, entities: 6012 },
      database: { engine: 'MariaDB', version: '10.11' },
      supervisor: null,
    });
    // Disabled and ignored integrations are left out.
    expect(s.entries).toHaveLength(171);
    expect(s.database?.sizeBytes).toBeCloseTo(2670.41 * 1024 ** 2, -3);
    expect(s.repairs).toEqual([
      {
        id: 'yaml_deprecated',
        domain: 'knx',
        severity: 'warning',
        title: 'The KNX YAML configuration is being removed',
      },
    ]);
    expect(s.backups?.[0]).toMatchObject({
      name: 'Settings copy before the kiosk update',
      sizeBytes: 1_800_000_000,
    });
    expect(s.startedAt?.getTime()).toBeGreaterThan(Date.now() - 24 * 3600_000);
    expect(state.seen).toEqual(
      expect.arrayContaining(['get_config', 'system_health/info', 'config_entries/get', 'render_template']),
    );
    // Nothing on the house: no states, no services.
    expect(state.seen.some((t) => t === 'get_states' || t === 'call_service')).toBe(false);
  });

  it('doesn’t wait for system health checks it doesn’t use (CP-S23)', async () => {
    const started = Date.now();
    const s = await read(fakeHaState({ healthFinish: false }));
    // Waiting for a `finish` that never comes took the whole 5 s.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s.installation).toBe('Container');
    expect(s.database?.sizeBytes).toBeCloseTo(2670.41 * 1024 ** 2, -3);
  });

  it('knows when system health has said what the read uses', () => {
    const initial = (recorder: Record<string, unknown>) => ({
      type: 'initial',
      data: {
        homeassistant: { info: { installation_type: 'Home Assistant Container', version: '2026.10.2' } },
        recorder: { info: recorder },
        cloud: { info: { can_reach_cloud: { type: 'pending' } } },
      },
    });
    const ready = healthDone();
    expect(ready(initial({ database_engine: 'mysql', estimated_db_size: '6 GiB' }))).toBe(true);
    const later = healthDone();
    expect(later(initial({ estimated_db_size: { type: 'pending' } }))).toBe(false);
    expect(later({ type: 'update', domain: 'cloud', key: 'can_reach_cloud', data: 'ok' })).toBe(false);
    expect(later({ type: 'update', domain: 'recorder', key: 'estimated_db_size', data: '6 GiB' })).toBe(true);
    expect(healthDone()({ type: 'finish' })).toBe(true);
  });

  it('refuses a wrong token as auth_invalid', async () => {
    await expect(read(fakeHaState(), 'wrong')).rejects.toBeInstanceOf(HaAuthInvalid);
  });

  it('reads what it can when the account isn’t an administrator, and says so', async () => {
    const s = await read(fakeHaState({ admin: false, backups: null }));
    expect(s.notAdmin).toBe(true);
    expect(s.entries).toBeNull();
    expect(s.log).toBeNull();
    expect(s.backups).toBeNull();
    expect(s.version).toBe('2026.10.2');
    const view = haView(s, null, ctxOf());
    expect(view.problem).toBe(
      'Whombat’s Home Assistant account isn’t an administrator, so it can’t read the integrations and the log.',
    );
    // No integrations to count: its version and database still go in the machine's card.
    expect(view.panels.map((p) => p.id)).toEqual([]);
    expect(view.slots?.machine.map((l) => l.label)).toEqual(['Home Assistant', 'Database']);
  });

  it('reads the Supervisor on Home Assistant OS', async () => {
    const s = await read(
      fakeHaState({
        installation: 'Home Assistant OS',
        supervisor: {
          '/core/stats': { cpu_percent: 3.2, memory_usage: 1_200_000_000, memory_limit: 4_000_000_000 },
          '/host/info': { disk_total: 62.3, disk_used: 58.1 },
          '/os/info': { version: '16.2' },
          '/addons': {
            addons: [
              {
                name: 'Mosquitto broker',
                slug: 'core_mosquitto',
                state: 'started',
                version: '6.5',
                update_available: true,
              },
            ],
          },
          '/addons/core_mosquitto/stats': { cpu_percent: 0.4, memory_usage: 40_000_000 },
        },
      }),
    );
    expect(s.supervisor).toMatchObject({ cpuPct: 3.2, diskUsedGb: 58.1, osVersion: '16.2' });
    expect(s.supervisor?.addons[0]).toMatchObject({
      name: 'Mosquitto broker',
      cpuPct: 0.4,
      updateAvailable: true,
    });
    const view = haView(s, null, ctxOf({ openUrl: null }));
    // On a machine Whombat doesn't know, the Supervisor's figures make the machine's card.
    expect(view.slots?.own).toMatchObject({
      name: 'Home Assistant OS',
      figures: { cpuPct: 3.2, diskUsedGb: 58.1, diskTotalGb: 62.3 },
    });
    expect(haView(s, ct131, ctxOf()).slots?.own).toBeUndefined();
    expect(view.kpis).toEqual([]);
    expect(view.tabs.map((t) => t.key)).toEqual(['integrations', 'logs', 'backups', 'addons']);
  });
});

describe('Home Assistant’s words', () => {
  it('the page as John’s mock: in slots on CT 131, the notices, the panels, the tabs', async () => {
    const s = await read(fakeHaState());
    const now = new Date();
    const view = haView(s, ct131, ctxOf({ now }));
    expect(slotProblems(view)).toEqual([]);
    expect(view).toMatchObject({ kpis: [], charts: [], machine: 'after' });
    // Without the house's parts: what Home Assistant has, then its own panels.
    const inv = view.panels[0];
    if (inv?.kind !== 'list') throw new Error('no inventory');
    expect(inv.items.map((i) => [i.id, i.figure])).toEqual([
      ['integrations', { value: '171', note: '2 not loading', tone: 'warn' }],
    ]);
    expect(inv.items[0]?.url).toBe('http://10.100.0.5:8123/config/integrations/dashboard');
    expect(view.slots?.machine.map((l) => [l.id, l.value, l.note ?? null, l.sub ?? null])).toEqual([
      ['ha-version', '2026.10.2', null, 'Container'],
      ['ha-database', '2.8 GB', 'MariaDB 10.11', null],
    ]);
    const notices = view.notices.map((n) => [n.id, n.tone, n.nature, n.title, n.detail, n.link?.label]);
    expect(notices).toEqual([
      ['integration-daikin1', 'bad', 'problem', 'Heat pump isn’t loading', 'Daikin · Failed', 'Look into it'],
      [
        'integration-shelly1',
        'info',
        'fyi',
        'Living room plug is retrying',
        'Shelly · Retrying · Device unreachable',
        undefined,
      ],
      [
        'repair-knx-yaml_deprecated',
        'warn',
        'problem',
        'The KNX YAML configuration is being removed',
        'A repair for KNX',
        'Look into it',
      ],
      ['disk', 'info', 'fyi', 'Disk 76 % full', '30 GB of 40 GB used on CT 131', undefined],
      [
        'updates',
        'info',
        'fyi',
        '2 updates waiting',
        'Home Assistant lists them under Settings → Updates.',
        'Open',
      ],
      [
        'unavailable',
        'info',
        'fyi',
        '12 devices and sensors not answering',
        'Home Assistant shows them as unavailable.',
        undefined,
      ],
    ]);
    expect(view.notices[0]?.link).toEqual({
      kind: 'ask',
      label: 'Look into it',
      question: 'Why is Heat pump not loading in Home Assistant?',
    });
    expect(view.notices.map((n) => [n.check, n.subject?.id ?? null])).toEqual([
      ['homeassistant.integration', 'entry:daikin1'],
      ['homeassistant.integration', 'entry:shelly1'],
      ['homeassistant.repair', 'repair:knx/yaml_deprecated'],
      ['machine.disk', null],
      ['homeassistant.updates', null],
      ['homeassistant.unavailable', null],
    ]);
    // The head follows the lines (QN-S25): no words of its own.
    expect(view.status).toBeUndefined();
    expect(view.facts[0]).toEqual([
      { text: 'Home Assistant ' },
      { text: '2026.10.2', strong: true },
      { text: ' · Container' },
    ]);
    expect(view.facts[1]).toEqual([{ text: 'Restarted ' }, { text: '23 h', strong: true }, { text: ' ago' }]);
    expect(view.panels.map((p) => [p.kind, p.id, p.place])).toEqual([
      ['list', 'inventory', 'chart'],
      ['list', 'not-loading', 'main'],
      ['list', 'backups', 'main'],
    ]);
    const broken = view.panels[1] as {
      meta?: string;
      items: { title: string; detail?: string; tone?: string }[];
    };
    expect(broken.meta).toBe('2 of 171');
    expect(broken.items.map((i) => [i.title, i.detail, i.tone])).toEqual([
      ['Shelly · Living room plug', 'Retrying · Device unreachable', 'warn'],
      ['Daikin · Heat pump', 'Failed', 'bad'],
    ]);
    const backups = view.panels[2] as { items: { title: string; detail?: string }[] };
    expect(backups.items.map((i) => i.title)).toEqual([
      'Whole machine, by Proxmox',
      'Settings copy before the kiosk update',
    ]);
    expect(view.tabs.map((t) => [t.key, t.label, t.count])).toEqual([
      ['integrations', 'Integrations', 171],
      ['logs', 'Logs', undefined],
      ['backups', 'Backups', undefined],
    ]);
  });

  it('with what the health pass kept: the database’s growth, when the disk is full, old backups', async () => {
    const s = await read(fakeHaState());
    const now = new Date();
    // The disk grows 0.4 % a day from 64 % (24 GB of 40): full in about two months. The database 110 MB a day.
    const diskPct = kept(30, (h) => 76 - (h / 24) * 0.4, now);
    const points: HaPoints = {
      diskPct,
      diskGb: diskPct.map((p) => ({ ...p, value: ((p.value as number) * 40) / 100 })),
      dbMb: kept(30, (h) => 2800 - (h / 24) * 110, now),
      logErr: [],
      logErrTop: [],
      logTop: null,
    };
    const ctx = ctxOf({ now, points });
    expect(haMachineLines(s, ctx).find((l) => l.id === 'ha-database')?.sub).toBe('Grows 110 MB a day');
    // As the contract has them.
    const all = haView(s, ct131, { ...ctx, range: '30d' });
    for (const c of all.panels) ThingPagePanel.parse(c);
    for (const n of all.notices) ThingPageNotice.parse(n);

    // Three backups on its own disk: the older ones are worth a look and one line in Backups.
    const day = 86_400_000;
    const backups = [3, 40, 200].map((d, i) => ({
      id: `b${i}`,
      name: `Backup ${i}`,
      at: new Date(now.getTime() - d * day),
      sizeBytes: 3e9,
      automatic: true,
      local: true,
    }));
    const full = { ...s, backups };
    const view = haView(full, ct131, ctx);
    expect(view.notices.find((n) => n.id === 'disk')).toMatchObject({
      title: 'Disk full in about 2 months',
      detail: '6.0 GB of it is old backups',
    });
    const listed = view.panels.find((p) => p.id === 'backups') as {
      items: { title: string; detail?: string }[];
    };
    expect(listed.items.at(-1)).toMatchObject({
      title: '9.0 GB of Home Assistant backups on its own disk',
      detail: expect.stringMatching(/^3 backups, the oldest from \w+$/),
    });
  });

  it('what the health pass keeps: errors since the restart, the noisiest source, the database', async () => {
    const s = await read(fakeHaState());
    expect(logErrors(s)).toEqual({ count: 38, top: 'knx', topCount: 30 });
    expect(haSeenPoints(s)).toEqual({
      points: { log_err: 38, log_err_top: 30, db_mb: 2800.13 },
      logTop: 'knx',
    });
    // The machine's disk, for every connection Whombat knows the machine of.
    expect(diskPoints(ct131)).toEqual({ disk_pct: 76, disk_gb: 30.4 });
    expect(diskPoints(null)).toEqual({});
  });

  it('the tile is technical (CP-16): version, integrations, log errors, updates; yellow while some don’t load', async () => {
    const s = await read(fakeHaState());
    expect(homeAssistantGlance(s, TZ)).toEqual({
      status: 'bad',
      line: 'Home Assistant 2026.10.2',
      facts: [
        { label: 'Integrations', value: '169 of 171', note: '2 not loading' },
        { label: 'Log errors', value: '38', note: 'since restart' },
        { label: 'Updates', value: '2', note: 'waiting' },
      ],
      reason: 'Heat pump isn’t loading',
    });
    const fine = await read(
      fakeHaState({ entries: [{ entry_id: 'a', domain: 'knx', title: 'KNX', state: 'loaded' }], issues: [] }),
    );
    expect(homeAssistantGlance(fine, TZ).status).toBe('ok');
    // Fine: no reason for the sidebar's dot (SB-03).
    expect(homeAssistantGlance(fine, TZ).reason).toBeUndefined();
    expect(homeAssistantGlance({ ...s, recoveryMode: true }, TZ).reason).toBe('Started in recovery mode');
    // A plug that is off (retrying) is a heads-up: fine on its own.
    const retry = await read(
      fakeHaState({
        entries: [{ entry_id: 'a', domain: 'shelly', title: 'Plug', state: 'setup_retry' }],
        issues: [],
      }),
    );
    expect(homeAssistantGlance(retry, TZ).status).toBe('ok');
  });

  it('a machine still shows when Home Assistant can’t be read: the slots it has, nothing out of place', () => {
    const slots = haSlots(emptySnapshot(new Date()), ct131, ctxOf(), NO_PARTS);
    expect(slotProblems({ ...slots, kpis: [] })).toEqual([]);
    // The machine's own backup is all there is.
    expect(slots.panels.map((p) => p.id)).toEqual(['backups']);
    expect(slots.slots).toEqual({ machine: [] });
  });

  it('recovery mode and an old backup are worth a look', () => {
    const s = { ...emptySnapshot(new Date()), recoveryMode: true, backups: [] };
    const notices = haNotices(s, null, ctxOf({ openUrl: null }));
    expect(notices.map((n) => [n.tone, n.title])).toEqual([
      ['bad', 'Home Assistant started in recovery mode'],
      ['warn', 'No backup yet'],
    ]);
  });

  it('small helpers', () => {
    expect(loggerDomain('homeassistant.components.knx.climate')).toBe('knx');
    expect(loggerDomain('custom_components.solar.sensor')).toBe('solar');
    expect(databaseName('mysql', '10.11.6')).toBe('MariaDB');
    expect(databaseName('mysql', '8.0.36')).toBe('MySQL');
    expect(databaseName('sqlite', '3.45')).toBe('SQLite');
    expect(shortVersion('10.11.6-MariaDB')).toBe('10.11');
    const s = { ...emptySnapshot(new Date()), log: [] };
    expect(errorsToday(s, new Date(), TZ)).toEqual({ count: 0, top: null, since: null });
  });

  it('Restart is the person’s, refused on Look only', () => {
    expect(haActions({ access: 'manage', label: 'Home Assistant' })[0]).toMatchObject({
      id: 'restart',
      allowed: true,
      confirm: { title: 'Restart Home Assistant?', button: 'Restart' },
    });
    expect(haActions({ access: 'read', label: 'Home Assistant' })[0]).toMatchObject({
      allowed: false,
      reason:
        'Home Assistant is set to Look only, so Whombat changes nothing there. Set it to Manage in Settings first.',
    });
  });
});

describe('Home Assistant: what Whombat watches (quiet-notices.md QN-01…QN-04, QN-S25)', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const base = (): HaSnapshot => ({ ...emptySnapshot(now), startedAt: new Date('2026-10-21T08:00:00Z') });

  it('one line per repair, its domain and id the subject; past three the rest share the third line', () => {
    const repairs = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      domain: i % 2 ? 'knx' : 'zha',
      severity: (i === 9 ? 'critical' : 'warning') as 'critical' | 'warning',
      title: `Repair ${i}`,
    }));
    const lines = haNotices({ ...base(), repairs }, null, ctxOf({ now }));
    expect(lines).toHaveLength(3);
    // The critical one first.
    expect(lines[0]).toMatchObject({
      check: 'homeassistant.repair',
      tone: 'bad',
      nature: 'problem',
      subject: { id: 'repair:knx/r9', name: 'Repair 9' },
      ignore: { lifts: 'fixed', words: 'Until it’s repaired.' },
    });
    expect(lines[2]).toMatchObject({ subject: { id: '+more', name: '8 more' }, ignore: { lifts: 'newer' } });
  });

  it('the log: a flood is a problem per integration until it restarts; other errors make no line', () => {
    const at = new Date(now.getTime() - 60_000);
    const entry = (name: string, count: number) => ({
      name,
      message: 'x',
      level: 'ERROR',
      at,
      first: at,
      count,
    });
    const flood = haNotices(
      { ...base(), log: [entry('homeassistant.components.knx', 150), entry('custom_components.solar', 10)] },
      null,
      ctxOf({ now }),
    );
    expect(flood[0]).toMatchObject({
      check: 'homeassistant.log_flood',
      nature: 'problem',
      subject: { id: 'integration:knx', name: 'KNX' },
      ignore: { lifts: 'newer', words: 'Until Home Assistant restarts.' },
      episode: '2026-10-21T08:00:00.000Z',
    });
    const some = haNotices(
      { ...base(), log: [entry('homeassistant.components.knx', 12)] },
      null,
      ctxOf({ now }),
    );
    expect(some.filter((n) => n.check.startsWith('homeassistant.log'))).toEqual([]);
  });

  it('updates and devices not answering are heads-ups without an agent', () => {
    const lines = haNotices(
      { ...base(), counts: { updates: 3, unavailable: 40, entities: 6000 } },
      null,
      ctxOf({ now }),
    );
    expect(lines.map((n) => [n.check, n.nature, n.link?.kind ?? null, n.episode ?? null])).toEqual([
      ['homeassistant.updates', 'fyi', 'url', '3'],
      ['homeassistant.unavailable', 'fyi', null, null],
    ]);
  });

  it('the health pass leaves the disk to the machine and backups it can’t be sure of', () => {
    const old = { ...base(), backups: [] };
    expect(haNotices(old, null, ctxOf({ now })).map((n) => n.check)).toEqual(['homeassistant.backup']);
    expect(haSeenNotices(old, TZ)).toEqual([]);
    expect(haSkipped(old)).toContain('homeassistant.backup');
    const recent = {
      ...base(),
      backups: [
        {
          id: 'b',
          name: 'b',
          at: new Date(now.getTime() - 86_400_000),
          sizeBytes: 1,
          automatic: true,
          local: true,
        },
      ],
      entries: [],
      repairs: [],
      log: [],
      counts: { updates: 0, unavailable: 0, entities: 1 },
    };
    expect(haSkipped(recent)).toEqual([]);
    expect(haSkipped(base())).toEqual([
      'homeassistant.integration',
      'homeassistant.repair',
      'homeassistant.log_flood',
      'homeassistant.updates',
      'homeassistant.unavailable',
      'homeassistant.backup',
    ]);
  });

  it('recovery mode is a problem until it starts normally; every check it raises is in its list', () => {
    const lines = haNotices(
      {
        ...base(),
        recoveryMode: true,
        entries: [{ id: 'e', domain: 'hue', title: 'Hue', state: 'setup_error', reason: null }],
        backups: [],
        counts: { updates: 1, unavailable: 1, entities: 2 },
      },
      null,
      ctxOf({ now }),
    );
    expect(lines[0]).toMatchObject({
      check: 'homeassistant.recovery',
      ignore: { lifts: 'fixed', words: 'Until it starts normally.' },
      badge: 'Started in recovery mode',
    });
    const checks = new Set(HOME_ASSISTANT_CHECKS.map((c) => c.check));
    for (const n of lines) expect(checks.has(n.check)).toBe(true);
    for (const n of lines) ThingPageNotice.parse(n);
  });
});

/** The house's parts as the page reads them on 2026-10-21 (the house fixtures' evening): controls, the house, cameras. */
const HOUSE_NOW = new Date('2026-10-21T19:50:00Z');
function houseParts(): HaParts {
  const house: HaHouseRead = {
    readAt: HOUSE_NOW,
    house: parseHouse([HA_houseEvent]),
    layout: parseLayout(HA_houseRegistry, HA_houseDevices, HA_houseAreas, '°C'),
    weather: null,
    days: null,
    energy: null,
    runs: runsOf(HA_logbook),
  };
  const layout = parseLayout(HA_registry, HA_devices, HA_areas, HA_unit);
  const picked = pickEntities(
    favouritesOf({ value: HA_home.value }),
    favouritesOf({ value: HA_security.value }, ['favorite_entities', 'alert_entities']),
    layout,
  );
  const states = statesOf([HA_states]);
  const camera = (id: string, alt: string) => ({
    ref: pictureRef(`api/camera_proxy/${id}`, true),
    alt,
    shape: 'wide' as const,
  });
  const controls = controlsPanel(
    { readAt: HOUSE_NOW, pinned: picked.pinned, ids: picked.ids.filter((id) => states[id]), states, layout },
    { buttons: { row: { access: 'manage', label: 'Home Assistant' } as never }, cameraImage: camera },
  );
  return { controls, house, camera };
}

describe('Home Assistant’s Summary in slots', () => {
  it('Controls live beside what it has, the cameras, the week’s runs, who’s home, then the house', async () => {
    const s = await read(fakeHaState());
    const ctx = ctxOf({ now: HOUSE_NOW });
    const view = haView(s, ct131, ctx, houseParts());
    expect(slotProblems(view)).toEqual([]);
    for (const p of view.panels) ThingPagePanel.parse(p);
    expect(view.panels.map((p) => [p.id, p.kind, p.span ?? null])).toEqual([
      ['controls', 'controls', 2],
      ['inventory', 'list', 1],
      ['cameras', 'gallery', 3],
      ['automations-week', 'chart', 1],
      ['people', 'bars', 1],
      ['not-loading', 'list', null],
      ['home-now', 'list', null],
      ['rooms', 'list', null],
      ['backups', 'list', null],
    ]);
    const inv = view.panels[1];
    if (inv?.kind !== 'list') throw new Error('no inventory');
    // Four areas, two devices (one disabled left out) with the plug added two days ago, two automations, 171 integrations.
    expect(inv.items.map((i) => [i.id, i.figure?.value, i.figure?.note])).toEqual([
      ['areas', '4', 'Nothing new'],
      ['devices', '2', '+1 this week'],
      ['automations', '2', 'Ran 2 times today'],
      ['integrations', '171', '2 not loading'],
    ]);
    const cams = view.panels[2];
    if (cams?.kind !== 'gallery') throw new Error('no cameras');
    expect(cams).toMatchObject({ look: 'shelf', shape: 'wide', meta: '2 cameras' });
    expect(cams.items.map((i) => [i.title, i.sub ?? null, !!i.image])).toEqual([
      ['Front door', null, true],
      ['Garden', 'Recording', true],
    ]);
    const week = view.panels[3];
    if (week?.kind !== 'chart') throw new Error('no trend');
    expect(week.labels).toHaveLength(7);
    expect(week.labels?.at(-1)).toBe('Today');
    expect(week.series[0]?.values.slice(-2)).toEqual([1, 2]);
    expect(week.figure).toMatchObject({ value: '3', rest: 'automation runs' });
    const who = view.panels[4];
    if (who?.kind !== 'bars') throw new Error('no people');
    expect(who.title).toBe('Who’s home');
    expect(who.meta).toBe('1 of 3 home');
    expect(who.items.map((i) => [i.label, i.value, i.person, i.pct])).toEqual([
      ['Anna', 'Home', true, null],
      ['John', 'Work', true, null],
      ['Sam', 'Away', true, null],
    ]);
    expect(who.items[0]?.note).toBe('since 17:12');
    // Home now keeps the doors, locks and lights; the people are in Who’s home.
    const now = view.panels.find((p) => p.id === 'home-now');
    expect(now?.kind === 'list' && now.items.some((i) => i.id.startsWith('person.'))).toBe(false);
  });

  it('a house without cameras, automations or people leaves those slots out', async () => {
    const s = await read(fakeHaState());
    const parts = houseParts();
    const h = parts.house?.house;
    if (!h || !parts.house) throw new Error('no house');
    const bare = {
      ...parts,
      house: {
        ...parts.house,
        house: { ...h, cameras: [], people: [], automationCount: 0, automations: [] },
      },
    };
    const view = haView(s, ct131, ctxOf({ now: HOUSE_NOW }), bare);
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id).slice(0, 2)).toEqual(['controls', 'inventory']);
    expect(view.panels.map((p) => p.id)).not.toContain('cameras');
    expect(view.panels.map((p) => p.id)).not.toContain('automations-week');
    expect(view.panels.map((p) => p.id)).not.toContain('people');
  });

  it('counts what came in this week, nothing when Home Assistant doesn’t say when', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    expect(addedThisWeek([new Date('2026-10-20T00:00:00Z'), new Date('2026-09-01T00:00:00Z')], now)).toBe(1);
    expect(addedThisWeek([null, null], now)).toBeNull();
    expect(addedThisWeek([], now)).toBeNull();
  });
});
