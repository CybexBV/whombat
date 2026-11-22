/**
 * Immich's declared settings: read-only rows from `/api/system-config` (with 404 fallback to `/api/admin/config`),
 * keeping every setting in Immich so no whole-config PUT can overwrite concurrent sign-in or data-keeping changes
 * and “Convert videos” cannot trigger deletion of converted copies; non-admin 403 unread explanation.
 */
import { ThingPagePanel, type ThingSetting } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { rowOf } from '../media/testing';
import { describeSetting, settingAction, settingsPanels, settingsTab } from '../settings';
import type { KindCtx } from '../types';
import { IMMICH_SETTINGS, parseImmichSettings, readImmichSettings } from './immich-settings';
import { fixture } from './test-helpers';

interface Store {
  config: Record<string, unknown>;
  endpoint: '/api/system-config' | '/api/admin/config';
  forbid: boolean;
  calls: { method: string; path: string; body: Record<string, unknown> | null }[];
}

const im = vi.hoisted(() => ({ store: {} as Store }));

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
      im.store.calls.push({ method: req.method, path, body });
      if (im.store.forbid) return { status: 403, headers: {}, body: Buffer.from('{"message":"Forbidden"}') };
      if (path !== im.store.endpoint) return { status: 404, headers: {}, body: Buffer.from('{}') };
      if (req.method === 'GET')
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(im.store.config)) };
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(im.store.config)) };
    },
  };
});

const now = new Date('2026-11-04T20:13:00Z');
const row = rowOf('immich', {
  id: 'con_immich',
  baseUrl: 'http://192.0.2.30:2283',
  fields: { url: 'http://192.0.2.30:2283' },
});
const ctx = { services: {} as Services, row, now, timeZone: 'Europe/Amsterdam' };
const act = settingAction(IMMICH_SETTINGS);

function reset(endpoint: '/api/system-config' | '/api/admin/config' = '/api/system-config') {
  im.store = {
    config: structuredClone(fixture('immich-system-config.json')) as Record<string, unknown>,
    endpoint,
    forbid: false,
    calls: [],
  };
}

function panels(access: 'manage' | 'read' = 'manage') {
  return settingsPanels({
    declared: IMMICH_SETTINGS,
    settings: parseImmichSettings(im.store.config, im.store.endpoint),
    who: { row: rowOf('immich', { access }) },
    url: 'http://192.0.2.30:2283/admin/system-settings',
    baseUrl: 'http://192.0.2.30:2283',
    changed: new Map(),
    assistant: 'Dusty',
    now,
    timeZone: 'Europe/Amsterdam',
  });
}

describe('Immich declared settings', () => {
  it('builds valid read-only panels in four groups and omits trash_days when trash is disabled', () => {
    reset();
    const out = panels();
    for (const p of out) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    const rows = out.flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    const by = (id: string) => rows.find((r) => r.id === id);
    const elsewhere = { label: 'In Immich', url: 'http://192.0.2.30:2283/admin/system-settings' };

    expect(by('video_transcode')).toMatchObject({ value: 'Only when needed', elsewhere });
    expect(by('video_resolution')).toMatchObject({ value: '720p', elsewhere });
    expect(by('machine_learning')).toMatchObject({ value: 'On', elsewhere });
    expect(by('smart_search')).toMatchObject({ value: 'On', elsewhere });
    expect(by('face_recognition')).toMatchObject({ value: 'On', elsewhere });
    expect(by('duplicate_detection')).toMatchObject({ value: 'On', elsewhere });
    expect(by('trash_days')).toMatchObject({ value: '30 days', elsewhere });
    expect(by('db_backup_enabled')).toMatchObject({ value: 'On', elsewhere });
    expect(by('db_backup_keep')).toMatchObject({ value: '14 backups', elsewhere });
    expect(by('version_check')).toMatchObject({ value: 'On', elsewhere });
    expect(by('auth_and_users')).toMatchObject({ value: 'Managed in Immich', elsewhere });

    // No Immich setting is writable from Whombat (whole-config PUT carries sign-in and backups).
    for (const r of rows) {
      expect(r.toggle).toBeUndefined();
      expect(r.on).toBeUndefined();
      expect(r.choose).toBeUndefined();
      expect(r.elsewhere).toEqual(elsewhere);
    }

    (im.store.config.trash as Record<string, unknown>).enabled = false;
    const withoutTrash = panels().flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(withoutTrash.find((r) => r.id === 'trash_days')).toBeUndefined();
  });

  it('reads from /api/system-config and falls back to /api/admin/config on 404', async () => {
    reset('/api/system-config');
    const primary = await readImmichSettings({} as Services, row);
    expect(primary.path).toBe('/api/system-config');

    reset('/api/admin/config');
    const fallback = await readImmichSettings({} as Services, row);
    expect(fallback.path).toBe('/api/admin/config');
    expect(im.store.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/system-config',
      'GET /api/admin/config',
    ]);
  });

  it('explains plainly when a non-admin key gets 403 in settingsTab', async () => {
    reset();
    im.store.forbid = true;
    const tab = await settingsTab(
      {
        services: { db: null } as unknown as Services,
        row: rowOf('immich', { id: 'con_nonadmin', baseUrl: 'http://192.0.2.30:2283', fields: {} }),
        entry: {} as KindCtx['entry'],
        now,
        timeZone: 'UTC',
        machine: null,
        range: '24h',
        burrowId: 'brw_1',
        disk: { pct: [], gb: [] },
        viewer: {} as KindCtx['viewer'],
      },
      IMMICH_SETTINGS,
    );
    expect(tab.panels[0]?.kind === 'text' ? tab.panels[0].body : '').toContain('administrator');
  });

  it('refuses every Immich setting write so no whole-config PUT can overwrite concurrent sign-in changes', async () => {
    reset();
    for (const [target, value] of [
      ['video_transcode', 'disabled'],
      ['video_resolution', '1080'],
      ['machine_learning', false],
      ['smart_search', false],
      ['face_recognition', false],
      ['duplicate_detection', false],
      ['version_check', false],
      ['trash_days', 60],
      ['db_backup_enabled', false],
      ['db_backup_keep', 7],
      ['auth_and_users', true],
    ] as const) {
      await expect(act(ctx, { target, value })).rejects.toThrow();
      expect(await describeSetting(IMMICH_SETTINGS, ctx, { target, value })).toBeNull();
    }
    expect(im.store.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
