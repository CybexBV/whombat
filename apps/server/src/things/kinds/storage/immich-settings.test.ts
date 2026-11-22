/**
 * Immich's declared settings: rows from `/api/system-config` (with 404 fallback to `/api/admin/config`), full-object
 * PUT writes preserving untouched fields, non-admin 403 unread explanation, deaf write refusal, undo guard, and
 * approval card words.
 */
import { ThingPagePanel, type ThingSetting } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { rowOf } from '../media/testing';
import { describeSetting, settingAction, settingsPanels, settingsTab } from '../settings';
import type { KindCtx } from '../types';
import { IMMICH_SETTINGS, parseImmichSettings } from './immich-settings';
import { fixture } from './test-helpers';

interface Store {
  config: Record<string, unknown>;
  endpoint: '/api/system-config' | '/api/admin/config';
  forbid: boolean;
  deaf: boolean;
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
      if (req.method === 'PUT' && body && !im.store.deaf) im.store.config = structuredClone(body);
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
    deaf: false,
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
  it('builds valid panels in four groups and omits trash_days when trash is disabled', () => {
    reset();
    const out = panels();
    for (const p of out) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    const rows = out.flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    const by = (id: string) => rows.find((r) => r.id === id);

    expect(by('video_transcode')).toMatchObject({
      value: 'Only when needed',
      choose: { current: 'required' },
    });
    expect(by('video_resolution')).toMatchObject({ value: '720p', choose: { current: '720' } });
    expect(by('machine_learning')).toMatchObject({ value: 'On', on: true });
    expect(by('smart_search')).toMatchObject({ value: 'On', on: true });
    expect(by('face_recognition')).toMatchObject({ value: 'On', on: true });
    expect(by('duplicate_detection')).toMatchObject({ value: 'On', on: true });
    expect(by('trash_days')).toMatchObject({
      value: '30 days',
      elsewhere: { label: 'In Immich', url: 'http://192.0.2.30:2283/admin/system-settings' },
    });
    expect(by('trash_days')?.choose).toBeUndefined();
    expect(by('db_backup_enabled')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In Immich', url: 'http://192.0.2.30:2283/admin/system-settings' },
    });
    expect(by('db_backup_enabled')?.toggle).toBeUndefined();
    expect(by('db_backup_enabled')?.on).toBeUndefined();
    expect(by('db_backup_keep')).toMatchObject({
      value: '14 backups',
      elsewhere: { label: 'In Immich', url: 'http://192.0.2.30:2283/admin/system-settings' },
    });
    expect(by('db_backup_keep')?.choose).toBeUndefined();
    expect(by('version_check')).toMatchObject({ value: 'On', on: true });
    expect(by('auth_and_users')?.elsewhere).toEqual({
      label: 'In Immich',
      url: 'http://192.0.2.30:2283/admin/system-settings',
    });

    (im.store.config.trash as Record<string, unknown>).enabled = false;
    const withoutTrash = panels().flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(withoutTrash.find((r) => r.id === 'trash_days')).toBeUndefined();

    const look = panels('read').flatMap((p) => (p.kind === 'settings' ? p.rows : []));
    expect(look[0]?.choose?.button.allowed).toBe(false);
    expect(look[0]?.choose?.button.reason).toMatch(/Look only/);
  });

  it('writes full config PUT preserving auth and storage template fields, and falls back to /api/admin/config', async () => {
    reset('/api/system-config');
    const done = await act(ctx, { target: 'video_resolution', value: '1080' });
    expect(done.message).toContain('1080p');
    expect(done.message).toContain('Checked with Immich');
    expect(done).toMatchObject({
      changeKind: 'setting.video_resolution',
      detail: '720p',
      undo: { target: 'video_resolution', value: '720', expect: '1080' },
    });
    const put = im.store.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/api/system-config');
    expect(put?.body).toMatchObject({
      ffmpeg: { targetResolution: '1080', crf: 23, targetVideoCodec: 'h264' },
      passwordLogin: { enabled: true },
      server: { externalDomain: 'https://photos.example.com' },
      storageTemplate: { hashVerificationEnabled: true },
    });

    reset('/api/admin/config');
    await act(ctx, { target: 'face_recognition', value: false });
    expect(im.store.calls.some((c) => c.method === 'PUT' && c.path === '/api/admin/config')).toBe(true);
    expect(
      (
        (im.store.config.machineLearning as Record<string, unknown>).facialRecognition as Record<
          string,
          unknown
        >
      ).enabled,
    ).toBe(false);
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

  it('refuses invalid targets, detects deaf writes, enforces undo guard, and describes approval cards', async () => {
    reset();
    await expect(act(ctx, { target: 'auth_and_users', value: true })).rejects.toThrow();
    await expect(act(ctx, { target: 'trash_days', value: 60 })).rejects.toThrow();
    await expect(act(ctx, { target: 'db_backup_enabled', value: false })).rejects.toThrow();
    await expect(act(ctx, { target: 'db_backup_keep', value: 7 })).rejects.toThrow();
    expect(
      await describeSetting(IMMICH_SETTINGS, ctx, { target: 'db_backup_enabled', value: false }),
    ).toBeNull();
    await expect(act(ctx, { target: 'video_resolution', value: '999' })).rejects.toThrow();
    expect((await act(ctx, { target: 'machine_learning', value: true })).unchanged).toBe(true);

    im.store.deaf = true;
    await expect(act(ctx, { target: 'version_check', value: false })).rejects.toThrow(/didn’t take/);

    im.store.deaf = false;
    const done = await act(ctx, { target: 'video_resolution', value: '1080' });
    (im.store.config.ffmpeg as Record<string, unknown>).targetResolution = '1440';
    await expect(
      act(ctx, { target: 'video_resolution', value: done.undo?.value, expect: done.undo?.expect }),
    ).rejects.toThrow(/changed again since/);
    (im.store.config.ffmpeg as Record<string, unknown>).targetResolution = '1080';
    await act(ctx, { target: 'video_resolution', value: done.undo?.value, expect: done.undo?.expect });
    expect((im.store.config.ffmpeg as Record<string, unknown>).targetResolution).toBe('720');

    const words = await describeSetting(IMMICH_SETTINGS, ctx, { target: 'video_resolution', value: '1080' });
    expect(words?.title).toContain('Immich');
    expect(words?.lines[0]).toContain('720p → 1080p');
  });
});
