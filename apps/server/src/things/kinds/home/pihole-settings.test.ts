/**
 * Pi-hole v6's declared settings: rows from `/api/config/{dns,database,misc}`, `PATCH /api/config` writes with
 * read-back verification, deaf write refusal, undo guard, and approval card words.
 */
import { ThingPagePanel, type ThingSetting } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { rowOf } from '../media/testing';
import { describeSetting, settingAction, settingsPanels } from '../settings';
import { PIHOLE_configDatabase, PIHOLE_configDns, PIHOLE_configMisc } from './fixtures/pihole-settings';
import { PIHOLE_SETTINGS, parsePiholeSettings } from './pihole-settings';

interface Store {
  dns: Record<string, unknown>;
  database: Record<string, unknown>;
  misc: Record<string, unknown>;
  deaf: boolean;
  calls: { method: string; path: string; body: Record<string, unknown> | null }[];
}

const ph = vi.hoisted(() => ({ store: {} as Store }));

function merge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object')
      merge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    else target[k] = v;
  }
}

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
      ph.store.calls.push({ method: req.method, path, body });
      if (req.method === 'GET') {
        const map: Record<string, unknown> = {
          '/api/config/dns': { config: { dns: ph.store.dns } },
          '/api/config/database': { config: { database: ph.store.database } },
          '/api/config/misc': { config: { misc: ph.store.misc } },
        };
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(map[path] ?? {})) };
      }
      if (req.method === 'PATCH' && path === '/api/config' && !ph.store.deaf) {
        const cfg = (body?.config ?? {}) as Record<string, unknown>;
        if (cfg.dns) merge(ph.store.dns, cfg.dns as Record<string, unknown>);
        if (cfg.database) merge(ph.store.database, cfg.database as Record<string, unknown>);
        if (cfg.misc) merge(ph.store.misc, cfg.misc as Record<string, unknown>);
      }
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ config: {} })) };
    },
  };
});

const now = new Date('2026-11-04T20:13:00Z');
const row = rowOf('pihole', { baseUrl: 'http://192.0.2.16', fields: { url: 'http://192.0.2.16' } });
const ctx = { services: {} as Services, row, now, timeZone: 'Europe/Amsterdam' };
const act = settingAction(PIHOLE_SETTINGS);

function reset() {
  ph.store = {
    dns: structuredClone(PIHOLE_configDns.config.dns),
    database: structuredClone(PIHOLE_configDatabase.config.database),
    misc: structuredClone(PIHOLE_configMisc.config.misc),
    deaf: false,
    calls: [],
  };
}

function panels(access: 'manage' | 'read' = 'manage') {
  return settingsPanels({
    declared: PIHOLE_SETTINGS,
    settings: parsePiholeSettings({
      dns: { config: { dns: ph.store.dns } },
      database: { config: { database: ph.store.database } },
      misc: { config: { misc: ph.store.misc } },
    }),
    who: { row: rowOf('pihole', { access }) },
    url: 'http://192.0.2.16/admin/settings',
    baseUrl: 'http://192.0.2.16',
    changed: new Map(),
    assistant: 'Dusty',
    now,
    timeZone: 'Europe/Amsterdam',
  });
}

describe('Pi-hole declared settings', () => {
  it('builds valid panels from documented config endpoints with elsewhere link for upstream DNS', () => {
    reset();
    const out = panels();
    for (const p of out) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    const rows = out.flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    const by = (id: string) => rows.find((r) => r.id === id);

    expect(by('blocking_mode')).toMatchObject({
      value: 'Empty address (0.0.0.0)',
      choose: { current: 'NULL' },
    });
    expect(by('blocking_mode')?.choose?.choices.map((c) => c.value)).toEqual([
      'NULL',
      'IP_NODATA_AAAA',
      'IP',
      'NXDOMAIN',
      'NODATA',
    ]);
    expect(by('dnssec')).toMatchObject({ value: 'Off', on: false });
    expect(by('rate_limit')).toBeUndefined();
    expect(by('query_logging')).toMatchObject({ value: 'On', on: true });
    expect(by('privacy_level')).toMatchObject({ value: 'Show everything', choose: { current: 0 } });
    expect(by('max_db_days')).toMatchObject({
      value: '90 days',
      elsewhere: { label: 'In Pi-hole', url: 'http://192.0.2.16/admin/settings' },
    });
    expect(by('max_db_days')?.choose).toBeUndefined();
    expect(by('dns_and_dhcp')?.elsewhere).toEqual({
      label: 'In Pi-hole',
      url: 'http://192.0.2.16/admin/settings/dns',
    });

    const look = panels('read').flatMap((p) => (p.kind === 'settings' ? p.rows : []));
    expect(look[0]?.choose?.button.allowed).toBe(false);
    expect(look[0]?.choose?.button.reason).toMatch(/Look only/);
  });

  it('writes via PATCH /api/config and verifies read-back', async () => {
    reset();
    const done = await act(ctx, { target: 'blocking_mode', value: 'NXDOMAIN' });
    expect(done.message).toContain('NXDOMAIN');
    expect(done.message).toContain('Checked with Pi-hole');
    expect(done).toMatchObject({
      changeKind: 'setting.blocking_mode',
      detail: '0.0.0.0',
      undo: { target: 'blocking_mode', value: 'NULL', expect: 'NXDOMAIN' },
    });

    await act(ctx, { target: 'blocking_mode', value: 'IP_NODATA_AAAA' });
    expect((ph.store.dns.blocking as Record<string, unknown>).mode).toBe('IP_NODATA_AAAA');

    await act(ctx, { target: 'privacy_level', value: 2 });
    expect(ph.store.misc.privacylevel).toBe(2);
  });

  it('refuses unknown/elsewhere/invalid values, detects deaf writes, and enforces undo guard', async () => {
    reset();
    await expect(act(ctx, { target: 'dns_and_dhcp', value: true })).rejects.toThrow();
    await expect(act(ctx, { target: 'max_db_days', value: 30 })).rejects.toThrow();
    await expect(act(ctx, { target: 'rate_limit', value: 2000 })).rejects.toThrow();
    await expect(act(ctx, { target: 'blocking_mode', value: 'ZERO' })).rejects.toThrow();
    await expect(act(ctx, { target: 'privacy_level', value: 9 })).rejects.toThrow();
    await expect(act(ctx, { target: 'nope', value: 1 })).rejects.toThrow();

    const same = await act(ctx, { target: 'query_logging', value: true });
    expect(same.unchanged).toBe(true);

    ph.store.deaf = true;
    await expect(act(ctx, { target: 'dnssec', value: true })).rejects.toThrow(/didn’t take/);

    ph.store.deaf = false;
    const done = await act(ctx, { target: 'privacy_level', value: 2 });
    ph.store.misc.privacylevel = 3;
    await expect(
      act(ctx, { target: 'privacy_level', value: done.undo?.value, expect: done.undo?.expect }),
    ).rejects.toThrow(/changed again since/);
    ph.store.misc.privacylevel = 2;
    await act(ctx, { target: 'privacy_level', value: done.undo?.value, expect: done.undo?.expect });
    expect(ph.store.misc.privacylevel).toBe(0);
  });

  it('describes changes in plain words for the approval card', async () => {
    reset();
    const words = await describeSetting(PIHOLE_SETTINGS, ctx, { target: 'blocking_mode', value: 'NXDOMAIN' });
    expect(words?.title).toContain('Pi-hole');
    expect(words?.lines[0]).toContain('0.0.0.0 → NXDOMAIN');
    const ipv4 = await describeSetting(PIHOLE_SETTINGS, ctx, {
      target: 'blocking_mode',
      value: 'IP_NODATA_AAAA',
    });
    expect(ipv4?.lines[0]).toContain('0.0.0.0 → Pi-hole’s IPv4 address');
    expect(await describeSetting(PIHOLE_SETTINGS, ctx, { target: 'blocking_mode', value: 'ZERO' })).toBeNull();
    expect(await describeSetting(PIHOLE_SETTINGS, ctx, { target: 'blocking_mode', value: 'BAD' })).toBeNull();
  });
});
