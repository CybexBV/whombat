/**
 * Plex's declared settings (service-settings.md SST-01…SST-07): the rows from `/:/prefs`, a change that is checked by
 * reading it back, what Put it back may do, and the approval card's words.
 */
import type { ThingSetting } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { describeSetting, settingAction, settingsPanels } from '../settings';
import { PLEX_SETTINGS, parsePrefs } from './plex-settings';
import { rowOf } from './testing';

const plex = vi.hoisted(() => ({
  prefs: new Map<string, string | number | boolean>(),
  /** Plex ignores writes (a pref it won't take). */
  deaf: false,
  calls: [] as { method: string; path: string; query: string }[],
}));
vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (_s: unknown, _r: unknown, req: { method: string; url: string }) => {
      const url = new URL(req.url);
      plex.calls.push({ method: req.method, path: url.pathname, query: url.search });
      if (req.method === 'PUT' && url.pathname === '/:/prefs' && !plex.deaf)
        for (const [k, v] of url.searchParams) {
          const had = plex.prefs.get(k);
          plex.prefs.set(k, typeof had === 'boolean' ? v === '1' : typeof had === 'number' ? Number(v) : v);
        }
      const body =
        url.pathname === '/:/prefs' && req.method === 'GET'
          ? JSON.stringify({
              MediaContainer: {
                Setting: [...plex.prefs].map(([id, value]) => ({ id, value, type: typeof value })),
              },
            })
          : '';
      return { status: 200, headers: {}, body: Buffer.from(body) };
    },
  };
});

const now = new Date('2026-11-04T20:13:00Z');
const row = rowOf('plex');
const ctx = { services: {} as Services, row, now, timeZone: 'Europe/Amsterdam' };
const act = settingAction(PLEX_SETTINGS);

function reset() {
  plex.deaf = false;
  plex.calls = [];
  plex.prefs = new Map<string, string | number | boolean>([
    ['PublishServerOnPlexOnlineKey', true],
    ['WanPerStreamMaxUploadRate', 8000],
    ['secureConnections', 0],
    ['TranscoderQuality', 0],
    ['TranscodeCountLimit', 4],
    ['FSEventLibraryUpdatesEnabled', true],
    ['ScheduledLibraryUpdatesEnabled', true],
    ['ScheduledLibraryUpdateInterval', 21600],
    ['autoEmptyTrash', false],
    ['ButlerStartHour', 2],
    ['ButlerEndHour', 5],
  ]);
}

const rows = () =>
  settingsPanels({
    declared: PLEX_SETTINGS,
    settings: parsePrefs({
      MediaContainer: { Setting: [...plex.prefs].map(([id, value]) => ({ id, value })) },
    }),
    who: { row },
    url: 'http://192.0.2.10:8080/web/index.html#!/settings/server',
    changed: new Map([
      [
        'remote_quality',
        { byAssistant: true, at: new Date('2026-11-03T18:00:00Z'), from: '4 Mbps', changeId: 'chg_1' },
      ],
    ]),
    assistant: 'Dusty',
    now,
    timeZone: 'Europe/Amsterdam',
  }).flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];

describe('the rows (SST-01, SST-05, SST-07)', () => {
  it('shows the settings Plex reports, in words, with a switch or Change', () => {
    reset();
    const r = rows();
    const by = (id: string) => r.find((x) => x.id === id);
    expect(by('remote_access')).toMatchObject({
      value: 'On',
      on: true,
      toggle: { action: 'setting', target: 'remote_access' },
    });
    expect(by('remote_quality')).toMatchObject({ value: 'Up to 8 Mbps', choose: { current: 8000 } });
    expect(by('remote_quality')?.changed).toMatchObject({
      short: 'Changed by Dusty yesterday',
      changeId: 'chg_1',
    });
    expect(by('remote_quality')?.changed?.text).toContain('4 Mbps');
    expect(by('scan_schedule')?.value).toBe('Every 6 hours');
    expect(by('quiet_hours')?.value).toBe('02:00 – 05:00');
    // Left out: the graphics chip, which this Plex doesn't report.
    expect(by('graphics_chip')).toBeUndefined();
    // Secure connections, emptying the trash and updates stay in Plex: no switch, no Change.
    for (const id of ['secure_connections', 'empty_trash', 'updates']) {
      expect(by(id)?.elsewhere?.label).toBe('In Plex');
      expect(by(id)?.toggle).toBeUndefined();
      expect(by(id)?.choose).toBeUndefined();
    }
    expect(by('secure_connections')?.value).toBe('Required');
  });

  it('draws them disabled with the reason on Look only', () => {
    reset();
    const look = settingsPanels({
      declared: PLEX_SETTINGS,
      settings: parsePrefs({
        MediaContainer: { Setting: [{ id: 'PublishServerOnPlexOnlineKey', value: true }] },
      }),
      who: { row: rowOf('plex', { access: 'read' }) },
      url: 'http://x.test/',
      changed: new Map(),
      assistant: 'Dusty',
      now,
      timeZone: 'UTC',
    });
    const r = look.flatMap((p) => (p.kind === 'settings' ? p.rows : []));
    expect(r[0]?.toggle?.allowed).toBe(false);
    expect(r[0]?.toggle?.reason).toMatch(/Look only/);
  });
});

describe('changing one (SST-02, SST-03)', () => {
  it('writes it, reads it back, and keeps how to put it back', async () => {
    reset();
    const done = await act(ctx, { target: 'remote_quality', value: 20000 });
    expect(plex.calls.filter((c) => c.method === 'PUT').map((c) => c.query)).toEqual([
      '?WanPerStreamMaxUploadRate=20000',
    ]);
    expect(done.message).toMatch(/20 Mbps/);
    expect(done.message).toMatch(/Checked with Plex/);
    expect(done.title).toMatch(/8 Mbps.*20 Mbps/);
    expect(done).toMatchObject({
      changeKind: 'setting.remote_quality',
      detail: '8 Mbps',
      undo: { target: 'remote_quality', value: 8000, expect: 20000 },
    });
  });

  it('says so when Plex didn’t take it', async () => {
    reset();
    plex.deaf = true;
    await expect(act(ctx, { target: 'remote_quality', value: 20000 })).rejects.toThrow(/didn’t take/);
  });

  it('takes only a choice it offers, refuses elsewhere settings, and changes nothing when it already is', async () => {
    reset();
    await expect(act(ctx, { target: 'remote_quality', value: 123 })).rejects.toThrow();
    await expect(act(ctx, { target: 'secure_connections', value: 0 })).rejects.toThrow();
    await expect(act(ctx, { target: 'secure_connections', value: 1 })).rejects.toThrow();
    await expect(act(ctx, { target: 'secure_connections', value: 2 })).rejects.toThrow();
    expect(await describeSetting(PLEX_SETTINGS, ctx, { target: 'secure_connections', value: 1 })).toBeNull();
    await expect(act(ctx, { target: 'empty_trash', value: true })).rejects.toThrow();
    await expect(act(ctx, { target: 'updates', value: true })).rejects.toThrow();
    await expect(act(ctx, { target: 'nope', value: 1 })).rejects.toThrow();
    plex.calls = [];
    const same = await act(ctx, { target: 'remote_quality', value: 8000 });
    expect(same.unchanged).toBe(true);
    expect(plex.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('writes only the targeted preference(s) for each writable Plex setting', async () => {
    reset();
    plex.prefs.set('HardwareAcceleratedCodecs', true);
    const cases: [string, string | number | boolean, string][] = [
      ['remote_access', false, '?PublishServerOnPlexOnlineKey=0'],
      ['remote_quality', 12000, '?WanPerStreamMaxUploadRate=12000'],
      ['graphics_chip', false, '?HardwareAcceleratedCodecs=0'],
      ['conversion_quality', 2, '?TranscoderQuality=2'],
      ['conversions_at_once', 2, '?TranscodeCountLimit=2'],
      ['scan_on_change', false, '?FSEventLibraryUpdatesEnabled=0'],
      ['scan_schedule', 0, '?ScheduledLibraryUpdatesEnabled=0'],
      ['scan_schedule', 3600, '?ScheduledLibraryUpdatesEnabled=1&ScheduledLibraryUpdateInterval=3600'],
      ['quiet_hours', '3-6', '?ButlerStartHour=3&ButlerEndHour=6'],
    ];
    for (const [target, value, query] of cases) {
      plex.calls = [];
      const done = await act(ctx, { target, value });
      expect(done.message).toContain('Checked with Plex');
      expect(plex.calls.filter((c) => c.method === 'PUT').map((c) => c.query)).toEqual([query]);
    }
  });

  it('puts it back only while it still has the value Whombat set', async () => {
    reset();
    const done = await act(ctx, { target: 'remote_quality', value: 20000 });
    const back = { target: 'remote_quality', value: done.undo?.value, expect: done.undo?.expect } as const;
    plex.prefs.set('WanPerStreamMaxUploadRate', 12000);
    await expect(act(ctx, back)).rejects.toThrow(/changed again since/);
    plex.prefs.set('WanPerStreamMaxUploadRate', 20000);
    await act(ctx, back);
    expect(plex.prefs.get('WanPerStreamMaxUploadRate')).toBe(8000);
  });

  it('preserves concurrent changes to other Plex preferences between read and field-only PUT', async () => {
    reset();
    let reads = 0;
    const declared = {
      ...PLEX_SETTINGS,
      read: async (services: Services, r: typeof row) => {
        const snap = await PLEX_SETTINGS.read(services, r);
        reads += 1;
        // Another actor changes unrelated Plex preferences right after Whombat reads and before it writes.
        if (reads === 1) {
          plex.prefs.set('autoEmptyTrash', true);
          plex.prefs.set('PublishServerOnPlexOnlineKey', false);
          plex.prefs.set('TranscoderQuality', 2);
        }
        return snap;
      },
    };
    const done = await settingAction(declared)(ctx, { target: 'remote_quality', value: 20000 });
    expect(done.uncertain).toBeUndefined();
    expect(done.message).toContain('Checked with Plex');
    expect(plex.prefs.get('WanPerStreamMaxUploadRate')).toBe(20000);
    expect(plex.prefs.get('autoEmptyTrash')).toBe(true);
    expect(plex.prefs.get('PublishServerOnPlexOnlineKey')).toBe(false);
    expect(plex.prefs.get('TranscoderQuality')).toBe(2);
  });
});

describe('the approval card (SST-04)', () => {
  it('says old → new in Whombat’s words', async () => {
    reset();
    const words = await describeSetting(PLEX_SETTINGS, ctx, { target: 'remote_quality', value: 20000 });
    expect(words?.title).toContain('Plex');
    expect(words?.lines[0]).toContain('8 Mbps → 20 Mbps');
    expect(await describeSetting(PLEX_SETTINGS, ctx, { target: 'remote_quality', value: 5 })).toBeNull();
  });
});
