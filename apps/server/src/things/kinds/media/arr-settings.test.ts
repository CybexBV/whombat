/**
 * Sonarr's and Radarr's declared settings: rows from v3 config fixtures, full-object PUT writes preserving sibling
 * fields, read-back verification, deaf write refusal, undo guard, and approval card words.
 */
import { ThingPagePanel, type ThingSetting } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { describeSetting, settingAction, settingsPanels } from '../settings';
import { type ArrSettingsApp, arrSettings, parseArrSettings } from './arr-settings';
import { fixture, rowOf } from './testing';

interface Store {
  sections: Record<string, Record<string, unknown>>;
  deaf: boolean;
  onPut?: (section: string) => void;
  calls: { method: string; path: string; body: Record<string, unknown> | null }[];
}

const arr = vi.hoisted(() => ({ store: {} as Store }));

vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (
      _s: unknown,
      _r: unknown,
      req: { method: string; url: string; body?: string },
    ) => {
      const path = new URL(req.url).pathname;
      const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : null;
      arr.store.calls.push({ method: req.method, path, body });
      const m = /^\/api\/v3\/config\/([a-z]+)(?:\/(\d+))?$/.exec(path);
      const section = m?.[1];
      if (!section || !arr.store.sections[section])
        return { status: 404, headers: {}, body: Buffer.from('{}') };
      if (req.method === 'GET')
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(arr.store.sections[section])) };
      if (req.method === 'PUT' && body && !arr.store.deaf) {
        arr.store.sections[section] = { ...body };
        arr.store.onPut?.(section);
      }
      return { status: 202, headers: {}, body: Buffer.from(JSON.stringify(arr.store.sections[section])) };
    },
  };
});

const now = new Date('2026-11-04T20:13:00Z');

function reset(app: ArrSettingsApp) {
  arr.store = {
    sections: {
      mediamanagement: structuredClone(fixture(`${app}-config-mediamanagement.json`)) as Record<
        string,
        unknown
      >,
      naming: structuredClone(fixture(`${app}-config-naming.json`)) as Record<string, unknown>,
      downloadclient: structuredClone(fixture(`${app}-config-downloadclient.json`)) as Record<
        string,
        unknown
      >,
      indexer: structuredClone(fixture(`${app}-config-indexer.json`)) as Record<string, unknown>,
    },
    deaf: false,
    calls: [],
  };
}

function panels(app: ArrSettingsApp, access: 'manage' | 'read' = 'manage') {
  const declared = arrSettings(app);
  const base = app === 'sonarr' ? 'http://192.0.2.20:8989' : 'http://192.0.2.21:7878';
  return settingsPanels({
    declared,
    settings: parseArrSettings({
      mediamanagement: arr.store.sections.mediamanagement,
      naming: arr.store.sections.naming,
      downloadclient: arr.store.sections.downloadclient,
      indexer: arr.store.sections.indexer,
    }),
    who: { row: rowOf(app, { access }) },
    url: `${base}/settings`,
    baseUrl: base,
    changed: new Map(),
    assistant: 'Dusty',
    now,
    timeZone: 'Europe/Amsterdam',
  });
}

describe('Sonarr and Radarr declared settings', () => {
  it('builds valid panels for Sonarr and Radarr with app-specific labels and elsewhere links', () => {
    reset('sonarr');
    const sp = panels('sonarr');
    for (const p of sp) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    const sRows = sp.flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(sRows.find((r) => r.id === 'rename_files')).toMatchObject({ value: 'On', on: true });
    expect(sRows.find((r) => r.id === 'hardlinks')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'hardlinks')?.toggle).toBeUndefined();
    expect(sRows.find((r) => r.id === 'import_extra_files')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'import_extra_files')?.toggle).toBeUndefined();
    expect(sRows.find((r) => r.id === 'min_free_space')).toMatchObject({
      value: '100 MB',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'min_free_space')?.choose).toBeUndefined();
    expect(sRows.find((r) => r.id === 'propers_and_repacks')).toMatchObject({
      value: 'Prefer and upgrade',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'propers_and_repacks')?.choose).toBeUndefined();
    expect(sRows.find((r) => r.id === 'completed_download_handling')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/downloadclients' },
    });
    expect(sRows.find((r) => r.id === 'completed_download_handling')?.toggle).toBeUndefined();
    expect(sRows.find((r) => r.id === 'auto_redownload_failed')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/downloadclients' },
    });
    expect(sRows.find((r) => r.id === 'auto_redownload_failed')?.toggle).toBeUndefined();
    expect(sRows.find((r) => r.id === 'unmonitor_deleted')).toMatchObject({
      label: 'Stop watching deleted episodes',
      value: 'Off',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'unmonitor_deleted')?.toggle).toBeUndefined();
    expect(sRows.find((r) => r.id === 'rss_sync_interval')).toMatchObject({
      value: 'Every 15 minutes',
      choose: { current: 15 },
    });
    expect(sRows.find((r) => r.id === 'general_and_updates')?.elsewhere).toEqual({
      label: 'In Sonarr',
      url: 'http://192.0.2.20:8989/settings/general',
    });

    // When RSS sync is off (0), keep turning it on in Sonarr.
    if (arr.store.sections.indexer) arr.store.sections.indexer.rssSyncInterval = 0;
    const rssOffRows = panels('sonarr').flatMap((p) =>
      p.kind === 'settings' ? p.rows : [],
    ) as ThingSetting[];
    expect(rssOffRows.find((r) => r.id === 'rss_sync_interval')).toMatchObject({
      value: 'Off',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/indexers' },
    });
    expect(rssOffRows.find((r) => r.id === 'rss_sync_interval')?.choose).toBeUndefined();

    reset('radarr');
    const rp = panels('radarr');
    for (const p of rp) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    const rRows = rp.flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(rRows.find((r) => r.id === 'unmonitor_deleted')).toMatchObject({
      label: 'Stop watching deleted movies',
      value: 'On',
      elsewhere: { label: 'In Radarr', url: 'http://192.0.2.21:7878/settings/mediamanagement' },
    });
    expect(rRows.find((r) => r.id === 'unmonitor_deleted')?.toggle).toBeUndefined();
    expect(rRows.find((r) => r.id === 'min_free_space')).toMatchObject({
      value: '500 MB',
      elsewhere: { label: 'In Radarr', url: 'http://192.0.2.21:7878/settings/mediamanagement' },
    });
    expect(rRows.find((r) => r.id === 'min_free_space')?.choose).toBeUndefined();
    expect(rRows.find((r) => r.id === 'completed_download_handling')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Radarr', url: 'http://192.0.2.21:7878/settings/downloadclients' },
    });
    expect(rRows.find((r) => r.id === 'completed_download_handling')?.toggle).toBeUndefined();
    expect(rRows.find((r) => r.id === 'propers_and_repacks')).toMatchObject({
      value: 'Don’t upgrade automatically',
      elsewhere: { label: 'In Radarr', url: 'http://192.0.2.21:7878/settings/mediamanagement' },
    });
    expect(rRows.find((r) => r.id === 'propers_and_repacks')?.choose).toBeUndefined();
    expect(rRows.find((r) => r.id === 'general_and_updates')?.elsewhere).toEqual({
      label: 'In Radarr',
      url: 'http://192.0.2.21:7878/settings/general',
    });

    reset('sonarr');
    const look = panels('sonarr', 'read').flatMap((p) =>
      p.kind === 'settings' ? p.rows : [],
    ) as ThingSetting[];
    expect(look.find((r) => r.id === 'rename_files')?.toggle?.allowed).toBe(false);
    expect(look.find((r) => r.id === 'rename_files')?.toggle?.reason).toMatch(/Look only/);
    expect(look.find((r) => r.id === 'rss_sync_interval')?.choose?.button.allowed).toBe(false);
  });

  it('writes full-object PUTs preserving untouched fields for both Sonarr and Radarr', async () => {
    reset('sonarr');
    const sonarrAct = settingAction(arrSettings('sonarr'));
    const sCtx = {
      services: {} as Services,
      row: rowOf('sonarr', { baseUrl: 'http://192.0.2.20:8989' }),
      now,
      timeZone: 'Europe/Amsterdam',
    };
    const done = await sonarrAct(sCtx, { target: 'rename_files', value: false });
    expect(done.message).toContain('no longer renames');
    expect(done.message).toContain('Checked with Sonarr');
    expect(done).toMatchObject({
      changeKind: 'setting.rename_files',
      detail: 'On',
      undo: { target: 'rename_files', value: true, expect: false },
    });
    const put = arr.store.calls.find((c) => c.method === 'PUT' && c.path === '/api/v3/config/naming/1');
    expect(put?.body).toMatchObject({
      id: 1,
      renameEpisodes: false,
    });
    expect(arr.store.sections.naming?.standardEpisodeFormat).toContain('{Series Title}');

    await sonarrAct(sCtx, { target: 'rss_sync_interval', value: 60 });
    const idxPut = arr.store.calls.find((c) => c.method === 'PUT' && c.path === '/api/v3/config/indexer/1');
    expect(idxPut?.body).toMatchObject({ id: 1, rssSyncInterval: 60 });

    reset('radarr');
    const radarrAct = settingAction(arrSettings('radarr'));
    const rCtx = {
      services: {} as Services,
      row: rowOf('radarr', { baseUrl: 'http://192.0.2.21:7878' }),
      now,
      timeZone: 'Europe/Amsterdam',
    };
    await radarrAct(rCtx, { target: 'rename_files', value: false });
    expect(arr.store.sections.naming?.renameMovies).toBe(false);
    await radarrAct(rCtx, { target: 'rss_sync_interval', value: 60 });
    expect(arr.store.sections.indexer?.rssSyncInterval).toBe(60);
  });

  it('refuses invalid and elsewhere targets, detects deaf writes, enforces undo guard, and describes approval cards', async () => {
    reset('sonarr');
    const declared = arrSettings('sonarr');
    const act = settingAction(declared);
    const sCtx = {
      services: {} as Services,
      row: rowOf('sonarr', { baseUrl: 'http://192.0.2.20:8989' }),
      now,
      timeZone: 'Europe/Amsterdam',
    };
    for (const [target, value] of [
      ['general_and_updates', true],
      ['propers_and_repacks', 'doNotUpgrade'],
      ['completed_download_handling', false],
      ['auto_redownload_failed', false],
      ['unmonitor_deleted', true],
      ['min_free_space', 5120],
      ['hardlinks', false],
      ['import_extra_files', false],
    ] as const) {
      await expect(act(sCtx, { target, value })).rejects.toThrow();
      expect(await describeSetting(declared, sCtx, { target, value })).toBeNull();
    }
    await expect(act(sCtx, { target: 'rss_sync_interval', value: 7 })).rejects.toThrow();
    await expect(act(sCtx, { target: 'rss_sync_interval', value: 0 })).rejects.toThrow();
    expect((await act(sCtx, { target: 'rename_files', value: true })).unchanged).toBe(true);

    // Refuses turning RSS sync on when it is currently off (0).
    if (arr.store.sections.indexer) arr.store.sections.indexer.rssSyncInterval = 0;
    await expect(act(sCtx, { target: 'rss_sync_interval', value: 15 })).rejects.toThrow();
    expect(await describeSetting(declared, sCtx, { target: 'rss_sync_interval', value: 15 })).toBeNull();
    if (arr.store.sections.indexer) arr.store.sections.indexer.rssSyncInterval = 15;

    arr.store.deaf = true;
    await expect(act(sCtx, { target: 'rename_files', value: false })).rejects.toThrow(/didn’t take/);

    arr.store.deaf = false;
    const done = await act(sCtx, { target: 'rss_sync_interval', value: 60 });
    if (arr.store.sections.indexer) arr.store.sections.indexer.rssSyncInterval = 120;
    await expect(
      act(sCtx, { target: 'rss_sync_interval', value: done.undo?.value, expect: done.undo?.expect }),
    ).rejects.toThrow(/changed again since/);
    if (arr.store.sections.indexer) arr.store.sections.indexer.rssSyncInterval = 60;
    await act(sCtx, { target: 'rss_sync_interval', value: done.undo?.value, expect: done.undo?.expect });
    expect(arr.store.sections.indexer?.rssSyncInterval).toBe(15);

    const words = await describeSetting(declared, sCtx, { target: 'rss_sync_interval', value: 60 });
    expect(words?.title).toContain('Sonarr');
    expect(words?.lines[0]).toContain('every 15 minutes → every hour');
  });

  it('reads only the target section right before writing and reports uncertain if any untouched field changed', async () => {
    reset('sonarr');
    const sonarrAct = settingAction(arrSettings('sonarr'));
    const sCtx = {
      services: {} as Services,
      row: rowOf('sonarr', { baseUrl: 'http://192.0.2.20:8989' }),
      now,
      timeZone: 'Europe/Amsterdam',
    };

    // Normal write reads only `/api/v3/config/naming`, writes it, and reads only `/api/v3/config/naming` back.
    await sonarrAct(sCtx, { target: 'rename_files', value: false });
    expect(arr.store.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v3/config/naming',
      'PUT /api/v3/config/naming/1',
      'GET /api/v3/config/naming',
    ]);

    // Concurrent change to a sibling naming field makes read-back differ -> uncertain, never done or undoable.
    reset('sonarr');
    arr.store.onPut = (section) => {
      if (section === 'naming' && arr.store.sections.naming)
        arr.store.sections.naming.standardEpisodeFormat = '{Series Title} - S{season:00}E{episode:00}';
    };
    const namingRace = await sonarrAct(sCtx, { target: 'rename_files', value: false });
    expect(namingRace.uncertain).toBe(true);
    expect(namingRace.undo).toBeUndefined();
    expect(namingRace.changeKind).toBeUndefined();
    expect(namingRace.title).not.toMatch(/Changed/);
    expect(namingRace.message).toMatch(/Another setting.*changed/i);
    expect(namingRace.message).not.toMatch(/Checked with/);

    // Concurrent change to a sibling indexer field in Radarr -> uncertain, never done or undoable.
    reset('radarr');
    const radarrAct = settingAction(arrSettings('radarr'));
    const rCtx = {
      services: {} as Services,
      row: rowOf('radarr', { baseUrl: 'http://192.0.2.21:7878' }),
      now,
      timeZone: 'Europe/Amsterdam',
    };
    arr.store.onPut = (section) => {
      if (section === 'indexer' && arr.store.sections.indexer) arr.store.sections.indexer.maximumSize = 2000;
    };
    const indexerRace = await radarrAct(rCtx, { target: 'rss_sync_interval', value: 60 });
    expect(indexerRace.uncertain).toBe(true);
    expect(indexerRace.undo).toBeUndefined();
    expect(indexerRace.changeKind).toBeUndefined();
    expect(indexerRace.title).not.toMatch(/Changed/);
    expect(indexerRace.message).toMatch(/Another setting.*changed/i);
    expect(indexerRace.message).not.toMatch(/Checked with/);
  });
});
