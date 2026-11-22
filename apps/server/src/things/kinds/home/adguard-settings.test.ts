/**
 * AdGuard Home's declared settings: read-only rows from its OpenAPI config endpoints, keeping every setting in
 * AdGuard Home so `POST /control/filtering/config` cannot overwrite a concurrent DNS filtering change.
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

    expect(by('filtering_enabled')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In AdGuard Home', url: 'http://192.0.2.15:3000/#filters' },
    });
    expect(by('filtering_enabled')?.toggle).toBeUndefined();
    expect(by('filtering_enabled')?.on).toBeUndefined();
    expect(by('filter_update_interval')).toMatchObject({
      value: 'Every day',
      elsewhere: { label: 'In AdGuard Home', url: 'http://192.0.2.15:3000/#filters' },
    });
    expect(by('filter_update_interval')?.choose).toBeUndefined();
    expect(by('safebrowsing')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In AdGuard Home', url: 'http://192.0.2.15:3000/#settings' },
    });
    expect(by('safebrowsing')?.toggle).toBeUndefined();
    expect(by('safebrowsing')?.on).toBeUndefined();
    expect(by('parental')).toMatchObject({
      value: 'Off',
      elsewhere: { label: 'In AdGuard Home', url: 'http://192.0.2.15:3000/#settings' },
    });
    expect(by('parental')?.toggle).toBeUndefined();
    expect(by('parental')?.on).toBeUndefined();
    expect(by('safesearch')).toMatchObject({
      value: 'Off',
      elsewhere: { label: 'In AdGuard Home', url: 'http://192.0.2.15:3000/#settings' },
    });
    expect(by('safesearch')?.toggle).toBeUndefined();
    expect(by('safesearch')?.on).toBeUndefined();
    ag.store.safesearch.enabled = true;
    const enabledRows = panels().flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(enabledRows.find((r) => r.id === 'safesearch')?.value).toBe('On');
    ag.store.safesearch.enabled = false;
    expect(by('querylog_enabled')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In AdGuard Home', url: 'http://192.0.2.15:3000/#settings' },
    });
    expect(by('querylog_enabled')?.toggle).toBeUndefined();
    expect(by('querylog_enabled')?.on).toBeUndefined();
    expect(by('querylog_interval')).toMatchObject({
      value: '7 days',
      elsewhere: { label: 'In AdGuard Home', url: 'http://192.0.2.15:3000/#settings' },
    });
    expect(by('querylog_interval')?.choose).toBeUndefined();
    expect(by('anonymize_ip')).toMatchObject({
      value: 'Off',
      elsewhere: { label: 'In AdGuard Home', url: 'http://192.0.2.15:3000/#settings' },
    });
    expect(by('anonymize_ip')?.toggle).toBeUndefined();
    expect(by('anonymize_ip')?.on).toBeUndefined();
    expect(by('stats_enabled')).toMatchObject({
      value: 'On',
      elsewhere: { label: 'In AdGuard Home', url: 'http://192.0.2.15:3000/#settings' },
    });
    expect(by('stats_enabled')?.toggle).toBeUndefined();
    expect(by('stats_enabled')?.on).toBeUndefined();
    expect(by('stats_interval')).toMatchObject({
      value: '24 hours',
      elsewhere: { label: 'In AdGuard Home', url: 'http://192.0.2.15:3000/#settings' },
    });
    expect(by('stats_interval')?.choose).toBeUndefined();
    expect(by('dns_and_access')?.elsewhere).toEqual({
      label: 'In AdGuard Home',
      url: 'http://192.0.2.15:3000/#dns',
    });

    for (const r of rows) {
      expect(r.toggle).toBeUndefined();
      expect(r.choose).toBeUndefined();
      expect(r.elsewhere?.label).toBe('In AdGuard Home');
    }
  });

  it('refuses every AdGuard Home setting write so POST /control/filtering/config cannot overwrite concurrent filtering.enabled changes', async () => {
    reset();
    for (const [target, value] of [
      ['dns_and_access', true],
      ['filtering_enabled', false],
      ['filter_update_interval', 12],
      ['safebrowsing', false],
      ['parental', true],
      ['safesearch', true],
      ['querylog_enabled', false],
      ['querylog_interval', 2_592_000_000],
      ['anonymize_ip', true],
      ['stats_enabled', false],
      ['stats_interval', 604_800_000],
      ['nope', true],
    ] as const) {
      await expect(act(ctx, { target, value })).rejects.toThrow();
      expect(await describeSetting(ADGUARD_SETTINGS, ctx, { target, value })).toBeNull();
    }
    expect(ag.store.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
