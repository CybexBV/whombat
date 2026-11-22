/**
 * Sonarr's and Radarr's declared settings: read-only rows from v3 config fixtures, keeping every setting in
 * Sonarr/Radarr because v3 config endpoints only take whole-section PUTs without conditional writes.
 */
import { ThingPagePanel, type ThingSetting } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { describeSetting, settingAction, settingsPanels } from '../settings';
import { type ArrSettingsApp, arrSettings, parseArrSettings } from './arr-settings';
import { fixture, rowOf } from './testing';

interface Store {
  sections: Record<string, Record<string, unknown>>;
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
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(arr.store.sections[section])) };
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
  it('builds valid read-only panels for Sonarr and Radarr with app-specific labels and elsewhere links', () => {
    reset('sonarr');
    const sp = panels('sonarr');
    for (const p of sp) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    const sIntro = sp.find((p) => p.id === 'settings-intro');
    expect(sIntro?.kind === 'text' ? sIntro.body : '').toContain('stay in Sonarr');
    const sRows = sp.flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(sRows.find((r) => r.id === 'rename_files')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'hardlinks')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'import_extra_files')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'min_free_space')).toMatchObject({
      value: '100 MB',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'propers_and_repacks')).toMatchObject({
      value: 'Prefer and upgrade',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'completed_download_handling')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/downloadclients' },
    });
    expect(sRows.find((r) => r.id === 'auto_redownload_failed')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/downloadclients' },
    });
    expect(sRows.find((r) => r.id === 'unmonitor_deleted')).toMatchObject({
      label: 'Stop watching deleted episodes',
      value: 'Off',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/mediamanagement' },
    });
    expect(sRows.find((r) => r.id === 'rss_sync_interval')).toMatchObject({
      value: 'Every 15 minutes',
      elsewhere: { label: 'In Sonarr', url: 'http://192.0.2.20:8989/settings/indexers' },
    });
    expect(sRows.find((r) => r.id === 'general_and_updates')?.elsewhere).toEqual({
      label: 'In Sonarr',
      url: 'http://192.0.2.20:8989/settings/general',
    });
    for (const r of sRows) {
      expect(r.toggle).toBeUndefined();
      expect(r.on).toBeUndefined();
      expect(r.choose).toBeUndefined();
      expect(r.elsewhere?.label).toBe('In Sonarr');
    }

    reset('radarr');
    const rp = panels('radarr');
    for (const p of rp) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    const rIntro = rp.find((p) => p.id === 'settings-intro');
    expect(rIntro?.kind === 'text' ? rIntro.body : '').toContain('stay in Radarr');
    const rRows = rp.flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(rRows.find((r) => r.id === 'rename_files')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Radarr', url: 'http://192.0.2.21:7878/settings/mediamanagement' },
    });
    expect(rRows.find((r) => r.id === 'unmonitor_deleted')).toMatchObject({
      label: 'Stop watching deleted movies',
      value: 'On',
      elsewhere: { label: 'In Radarr', url: 'http://192.0.2.21:7878/settings/mediamanagement' },
    });
    expect(rRows.find((r) => r.id === 'min_free_space')).toMatchObject({
      value: '500 MB',
      elsewhere: { label: 'In Radarr', url: 'http://192.0.2.21:7878/settings/mediamanagement' },
    });
    expect(rRows.find((r) => r.id === 'completed_download_handling')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Radarr', url: 'http://192.0.2.21:7878/settings/downloadclients' },
    });
    expect(rRows.find((r) => r.id === 'propers_and_repacks')).toMatchObject({
      value: 'Don’t upgrade automatically',
      elsewhere: { label: 'In Radarr', url: 'http://192.0.2.21:7878/settings/mediamanagement' },
    });
    expect(rRows.find((r) => r.id === 'rss_sync_interval')).toMatchObject({
      value: 'Every 30 minutes',
      elsewhere: { label: 'In Radarr', url: 'http://192.0.2.21:7878/settings/indexers' },
    });
    expect(rRows.find((r) => r.id === 'general_and_updates')?.elsewhere).toEqual({
      label: 'In Radarr',
      url: 'http://192.0.2.21:7878/settings/general',
    });
    for (const r of rRows) {
      expect(r.toggle).toBeUndefined();
      expect(r.on).toBeUndefined();
      expect(r.choose).toBeUndefined();
      expect(r.elsewhere?.label).toBe('In Radarr');
    }
  });

  it('refuses every Sonarr and Radarr setting write so no whole-section PUT can overwrite concurrent changes', async () => {
    for (const [app, baseUrl] of [
      ['sonarr', 'http://192.0.2.20:8989'],
      ['radarr', 'http://192.0.2.21:7878'],
    ] as const) {
      reset(app);
      const declared = arrSettings(app);
      const act = settingAction(declared);
      const ctx = {
        services: {} as Services,
        row: rowOf(app, { baseUrl }),
        now,
        timeZone: 'Europe/Amsterdam',
      };
      for (const [target, value] of [
        ['rename_files', false],
        ['rss_sync_interval', 60],
        ['general_and_updates', true],
        ['propers_and_repacks', 'doNotUpgrade'],
        ['completed_download_handling', false],
        ['auto_redownload_failed', false],
        ['unmonitor_deleted', true],
        ['min_free_space', 5120],
        ['hardlinks', false],
        ['import_extra_files', false],
        ['nope', true],
      ] as const) {
        await expect(act(ctx, { target, value })).rejects.toThrow();
        expect(await describeSetting(declared, ctx, { target, value })).toBeNull();
      }
      expect(arr.store.calls.some((c) => c.method === 'PUT')).toBe(false);
    }
  });
});
