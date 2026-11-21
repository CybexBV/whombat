/**
 * AdGuard Home's declared settings: rows from its OpenAPI config endpoints, verified writes preserving sibling
 * fields, deaf write refusal, undo guard, and approval card words.
 */
import { ThingPagePanel, type ThingSetting } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { rowOf } from '../media/testing';
import { describeSetting, settingAction, settingsPanels } from '../settings';
import { ADGUARD_SETTINGS, parseAdGuardSettings } from './adguard-settings';
import {
  ADGUARD_filteringConfig,
  ADGUARD_parentalStatus,
  ADGUARD_querylogConfig,
  ADGUARD_safebrowsingStatus,
  ADGUARD_safesearchStatus,
  ADGUARD_statsConfig,
} from './fixtures/adguard-settings';

interface Store {
  filtering: { enabled: boolean; interval: number };
  safebrowsing: { enabled: boolean };
  parental: { enabled: boolean };
  safesearch: Record<string, unknown>;
  querylog: Record<string, unknown>;
  stats: Record<string, unknown>;
  deaf: boolean;
  calls: { method: string; path: string; body: Record<string, unknown> | null }[];
}

const ag = vi.hoisted(() => ({
  store: {} as Store,
}));

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
      ag.store.calls.push({ method: req.method, path, body });
      if (req.method === 'GET') {
        const map: Record<string, unknown> = {
          '/control/filtering/status': ag.store.filtering,
          '/control/safebrowsing/status': ag.store.safebrowsing,
          '/control/parental/status': ag.store.parental,
          '/control/safesearch/status': ag.store.safesearch,
          '/control/querylog/config': ag.store.querylog,
          '/control/stats/config': ag.store.stats,
        };
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(map[path] ?? {})) };
      }
      if (!ag.store.deaf) {
        if (path === '/control/filtering/config' && body)
          ag.store.filtering = { enabled: Boolean(body.enabled), interval: Number(body.interval) };
        else if (path === '/control/safebrowsing/enable') ag.store.safebrowsing = { enabled: true };
        else if (path === '/control/safebrowsing/disable') ag.store.safebrowsing = { enabled: false };
        else if (path === '/control/parental/enable') ag.store.parental = { enabled: true };
        else if (path === '/control/parental/disable') ag.store.parental = { enabled: false };
        else if (path === '/control/safesearch/settings' && body) ag.store.safesearch = { ...body };
        else if (path === '/control/querylog/config/update' && body) ag.store.querylog = { ...body };
        else if (path === '/control/stats/config/update' && body) ag.store.stats = { ...body };
      }
      return { status: 200, headers: {}, body: Buffer.from('') };
    },
  };
});

const now = new Date('2026-11-04T20:13:00Z');
const row = rowOf('adguard', {
  baseUrl: 'http://192.0.2.15:3000',
  fields: { url: 'http://192.0.2.15:3000' },
});
const ctx = { services: {} as Services, row, now, timeZone: 'Europe/Amsterdam' };
const act = settingAction(ADGUARD_SETTINGS);

function reset() {
  ag.store = {
    filtering: { enabled: ADGUARD_filteringConfig.enabled, interval: ADGUARD_filteringConfig.interval },
    safebrowsing: { ...ADGUARD_safebrowsingStatus },
    parental: { ...ADGUARD_parentalStatus },
    safesearch: { ...ADGUARD_safesearchStatus },
    querylog: { ...ADGUARD_querylogConfig },
    stats: { ...ADGUARD_statsConfig },
    deaf: false,
    calls: [],
  };
}

function panels(access: 'manage' | 'read' = 'manage') {
  return settingsPanels({
    declared: ADGUARD_SETTINGS,
    settings: parseAdGuardSettings({
      filtering: ag.store.filtering,
      safebrowsing: ag.store.safebrowsing,
      parental: ag.store.parental,
      safesearch: ag.store.safesearch,
      querylog: ag.store.querylog,
      stats: ag.store.stats,
    }),
    who: { row: rowOf('adguard', { access }) },
    url: 'http://192.0.2.15:3000/#settings',
    baseUrl: 'http://192.0.2.15:3000',
    changed: new Map(),
    assistant: 'Dusty',
    now,
    timeZone: 'Europe/Amsterdam',
  });
}

describe('AdGuard Home declared settings', () => {
  it('builds valid panels from documented endpoints with elsewhere link for upstream DNS', () => {
    reset();
    const out = panels();
    for (const p of out) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    const rows = out.flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    const by = (id: string) => rows.find((r) => r.id === id);

    expect(by('filtering_enabled')).toMatchObject({ value: 'On', on: true });
    expect(by('filter_update_interval')).toMatchObject({ value: 'Every day', choose: { current: 24 } });
    expect(by('safebrowsing')).toMatchObject({ value: 'On', on: true });
    expect(by('parental')).toMatchObject({ value: 'Off', on: false });
    expect(by('querylog_interval')).toMatchObject({ value: '7 days', choose: { current: 604_800_000 } });
    expect(by('stats_interval')).toMatchObject({ value: '24 hours', choose: { current: 86_400_000 } });
    expect(by('dns_and_access')?.elsewhere).toEqual({
      label: 'In AdGuard Home',
      url: 'http://192.0.2.15:3000/#dns',
    });

    const look = panels('read').flatMap((p) => (p.kind === 'settings' ? p.rows : []));
    expect(look[0]?.toggle?.allowed).toBe(false);
    expect(look[0]?.toggle?.reason).toMatch(/Look only/);
  });

  it('writes settings, preserves sibling querylog fields, and reads back to verify', async () => {
    reset();
    const done = await act(ctx, { target: 'querylog_interval', value: 2_592_000_000 });
    expect(done.message).toContain('30 days');
    expect(done.message).toContain('Checked with AdGuard Home');
    expect(done).toMatchObject({
      changeKind: 'setting.querylog_interval',
      detail: '7 days',
      undo: { target: 'querylog_interval', value: 604_800_000, expect: 2_592_000_000 },
    });
    const put = ag.store.calls.find(
      (c) => c.method === 'PUT' && c.path === '/control/querylog/config/update',
    );
    expect(put?.body).toMatchObject({
      enabled: true,
      interval: 2_592_000_000,
      anonymize_client_ip: false,
      ignored: ['example.com'],
    });

    await act(ctx, { target: 'safesearch', value: true });
    expect(ag.store.safesearch.enabled).toBe(true);
    expect(ag.store.safesearch.google).toBe(true);

    await act(ctx, { target: 'parental', value: true });
    expect(ag.store.calls.some((c) => c.method === 'POST' && c.path === '/control/parental/enable')).toBe(
      true,
    );
  });

  it('refuses unknown/elsewhere/invalid values, detects deaf writes, and enforces undo guard', async () => {
    reset();
    await expect(act(ctx, { target: 'dns_and_access', value: true })).rejects.toThrow();
    await expect(act(ctx, { target: 'filter_update_interval', value: 999 })).rejects.toThrow();
    await expect(act(ctx, { target: 'nope', value: true })).rejects.toThrow();

    const same = await act(ctx, { target: 'safebrowsing', value: true });
    expect(same.unchanged).toBe(true);

    ag.store.deaf = true;
    await expect(act(ctx, { target: 'safebrowsing', value: false })).rejects.toThrow(/didn’t take/);

    ag.store.deaf = false;
    const done = await act(ctx, { target: 'stats_interval', value: 604_800_000 });
    ag.store.stats.interval = 2_592_000_000;
    await expect(
      act(ctx, { target: 'stats_interval', value: done.undo?.value, expect: done.undo?.expect }),
    ).rejects.toThrow(/changed again since/);
    ag.store.stats.interval = 604_800_000;
    await act(ctx, { target: 'stats_interval', value: done.undo?.value, expect: done.undo?.expect });
    expect(ag.store.stats.interval).toBe(86_400_000);
  });

  it('describes changes in plain words for the approval card', async () => {
    reset();
    const words = await describeSetting(ADGUARD_SETTINGS, ctx, {
      target: 'filter_update_interval',
      value: 12,
    });
    expect(words?.title).toContain('AdGuard Home');
    expect(words?.lines[0]).toContain('every day → every 12 hours');
    expect(
      await describeSetting(ADGUARD_SETTINGS, ctx, { target: 'filter_update_interval', value: 5 }),
    ).toBeNull();
  });
});
