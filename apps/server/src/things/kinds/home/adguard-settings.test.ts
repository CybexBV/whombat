/**
 * AdGuard Home's declared settings: Safe browsing and Parental control write through their dedicated single-field
 * `/enable` and `/disable` endpoints with read-back and Undo; every whole-section, destructive or cut-off setting
 * stays in AdGuard Home.
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
      on: true,
      toggle: { action: 'setting', target: 'safebrowsing', allowed: true },
    });
    expect(by('safebrowsing')?.elsewhere).toBeUndefined();
    expect(by('parental')).toMatchObject({
      value: 'Off',
      on: false,
      toggle: { action: 'setting', target: 'parental', allowed: true },
    });
    expect(by('parental')?.elsewhere).toBeUndefined();
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

    const look = panels('read').flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(look.find((r) => r.id === 'safebrowsing')?.toggle?.allowed).toBe(false);
    expect(look.find((r) => r.id === 'safebrowsing')?.toggle?.reason).toMatch(/Look only/);
    expect(look.find((r) => r.id === 'parental')?.toggle?.allowed).toBe(false);
  });

  it('writes Safe browsing and Parental control through dedicated single-field endpoints with read-back and Undo', async () => {
    reset();
    const sbOff = await act(ctx, { target: 'safebrowsing', value: false });
    expect(sbOff.message).toContain('Checked with AdGuard Home');
    expect(sbOff).toMatchObject({
      changeKind: 'setting.safebrowsing',
      detail: 'On',
      undo: { target: 'safebrowsing', value: true, expect: false },
    });
    expect(ag.store.calls).toEqual([
      { method: 'GET', path: '/control/safebrowsing/status', body: null },
      { method: 'POST', path: '/control/safebrowsing/disable', body: null },
      { method: 'GET', path: '/control/safebrowsing/status', body: null },
    ]);

    // Undo restores Safe browsing only while unchanged.
    ag.store.safebrowsing.enabled = true;
    await expect(
      act(ctx, { target: 'safebrowsing', value: sbOff.undo?.value, expect: sbOff.undo?.expect }),
    ).rejects.toThrow(/changed again since/);
    ag.store.safebrowsing.enabled = false;
    ag.store.calls = [];
    await act(ctx, { target: 'safebrowsing', value: sbOff.undo?.value, expect: sbOff.undo?.expect });
    expect(ag.store.safebrowsing.enabled).toBe(true);
    expect(ag.store.calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/control/safebrowsing/enable', body: null },
    ]);

    ag.store.calls = [];
    const parOn = await act(ctx, { target: 'parental', value: true });
    expect(parOn.message).toContain('Checked with AdGuard Home');
    expect(parOn).toMatchObject({
      changeKind: 'setting.parental',
      detail: 'Off',
      undo: { target: 'parental', value: false, expect: true },
    });
    expect(ag.store.calls).toEqual([
      { method: 'GET', path: '/control/parental/status', body: null },
      { method: 'POST', path: '/control/parental/enable', body: null },
      { method: 'GET', path: '/control/parental/status', body: null },
    ]);

    const same = await act(ctx, { target: 'parental', value: true });
    expect(same.unchanged).toBe(true);

    ag.store.deaf = true;
    await expect(act(ctx, { target: 'parental', value: false })).rejects.toThrow(/didn’t take/);

    ag.store.deaf = false;
    const words = await describeSetting(ADGUARD_SETTINGS, ctx, { target: 'parental', value: false });
    expect(words?.title).toContain('AdGuard Home');
    expect(words?.lines[0]).toContain('On → Off');

    // Concurrent changes to sibling AdGuard Home settings are untouched by single-field enable/disable calls.
    reset();
    ag.store.filtering.enabled = false;
    ag.store.parental.enabled = true;
    await act(ctx, { target: 'safebrowsing', value: false });
    expect(ag.store.safebrowsing.enabled).toBe(false);
    expect(ag.store.filtering.enabled).toBe(false);
    expect(ag.store.parental.enabled).toBe(true);
  });

  it('refuses every whole-section, destructive or cut-off AdGuard Home setting write', async () => {
    reset();
    for (const [target, value] of [
      ['dns_and_access', true],
      ['filtering_enabled', false],
      ['filter_update_interval', 12],
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
    expect(ag.store.calls.some((c) => c.method === 'POST' || c.method === 'PUT')).toBe(false);
  });
});
