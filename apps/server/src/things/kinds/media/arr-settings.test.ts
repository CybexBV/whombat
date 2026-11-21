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
      if (req.method === 'PUT' && body && !arr.store.deaf) arr.store.sections[section] = { ...body };
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
    expect(sRows.find((r) => r.id === 'min_free_space')).toMatchObject({
      value: '100 MB',
      choose: { current: 100 },
    });
    expect(sRows.find((r) => r.id === 'unmonitor_deleted')).toMatchObject({
      label: 'Stop watching deleted episodes',
      value: 'Off',
      on: false,
    });
    expect(sRows.find((r) => r.id === 'rss_sync_interval')).toMatchObject({
      value: 'Every 15 minutes',
      choose: { current: 15 },
    });
    expect(sRows.find((r) => r.id === 'general_and_updates')?.elsewhere).toEqual({
      label: 'In Sonarr',
      url: 'http://192.0.2.20:8989/settings/general',
    });

    reset('radarr');
    const rp = panels('radarr');
    for (const p of rp) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    const rRows = rp.flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(rRows.find((r) => r.id === 'unmonitor_deleted')).toMatchObject({
      label: 'Stop watching deleted movies',
      value: 'On',
      on: true,
    });
    expect(rRows.find((r) => r.id === 'min_free_space')).toMatchObject({
      value: '500 MB',
      choose: { current: 500 },
    });
    expect(rRows.find((r) => r.id === 'propers_and_repacks')).toMatchObject({
      value: 'Don’t upgrade automatically',
      choose: { current: 'doNotUpgrade' },
    });
    expect(rRows.find((r) => r.id === 'general_and_updates')?.elsewhere).toEqual({
      label: 'In Radarr',
      url: 'http://192.0.2.21:7878/settings/general',
    });

    const look = panels('sonarr', 'read').flatMap((p) => (p.kind === 'settings' ? p.rows : []));
    expect(look[0]?.toggle?.allowed).toBe(false);
    expect(look[0]?.toggle?.reason).toMatch(/Look only/);
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
    const done = await sonarrAct(sCtx, { target: 'min_free_space', value: 5120 });
    expect(done.message).toContain('5 GB');
    expect(done.message).toContain('Checked with Sonarr');
    expect(done).toMatchObject({
      changeKind: 'setting.min_free_space',
      detail: '100 MB',
      undo: { target: 'min_free_space', value: 100, expect: 5120 },
    });
    const put = arr.store.calls.find(
      (c) => c.method === 'PUT' && c.path === '/api/v3/config/mediamanagement/1',
    );
    expect(put?.body).toMatchObject({
      id: 1,
      minimumFreeSpaceWhenImporting: 5120,
      copyUsingHardlinks: true,
      extraFileExtensions: 'srt,nfo',
      chmodFolder: '755',
    });

    await sonarrAct(sCtx, { target: 'rename_files', value: false });
    expect(arr.store.sections.naming?.renameEpisodes).toBe(false);
    expect(arr.store.sections.naming?.standardEpisodeFormat).toContain('{Series Title}');

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
    await radarrAct(rCtx, { target: 'unmonitor_deleted', value: false });
    expect(arr.store.sections.mediamanagement?.autoUnmonitorPreviouslyDownloadedMovies).toBe(false);
    await radarrAct(rCtx, { target: 'rss_sync_interval', value: 60 });
    expect(arr.store.sections.indexer?.rssSyncInterval).toBe(60);
  });

  it('refuses invalid targets, detects deaf writes, enforces undo guard, and describes approval cards', async () => {
    reset('sonarr');
    const declared = arrSettings('sonarr');
    const act = settingAction(declared);
    const sCtx = {
      services: {} as Services,
      row: rowOf('sonarr', { baseUrl: 'http://192.0.2.20:8989' }),
      now,
      timeZone: 'Europe/Amsterdam',
    };
    await expect(act(sCtx, { target: 'general_and_updates', value: true })).rejects.toThrow();
    await expect(act(sCtx, { target: 'rss_sync_interval', value: 7 })).rejects.toThrow();
    expect((await act(sCtx, { target: 'hardlinks', value: true })).unchanged).toBe(true);

    arr.store.deaf = true;
    await expect(act(sCtx, { target: 'hardlinks', value: false })).rejects.toThrow(/didn’t take/);

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
});
