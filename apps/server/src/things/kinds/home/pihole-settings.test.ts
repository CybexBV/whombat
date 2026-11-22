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
    expect(by('dnssec')).toMatchObject({
      value: 'Off',
      elsewhere: { label: 'In Pi-hole', url: 'http://192.0.2.16/admin/settings/dns' },
    });
    expect(by('dnssec')?.toggle).toBeUndefined();
    expect(by('dnssec')?.on).toBeUndefined();
    ph.store.dns.dnssec = true;
    const dnssecOn = panels().flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(dnssecOn.find((r) => r.id === 'dnssec')?.value).toBe('On');
    ph.store.dns.dnssec = false;
    expect(by('rate_limit')).toBeUndefined();
    expect(by('query_logging')).toMatchObject({
      value: 'On',
      on: true,
      toggle: { action: 'setting', target: 'query_logging', allowed: true },
    });
    expect(by('query_logging')?.elsewhere).toBeUndefined();
    expect(by('privacy_level')).toMatchObject({
      value: 'Show everything',
      choose: { current: 0 },
    });
    expect(by('privacy_level')?.choose?.choices.map((c) => c.value)).toEqual([0, 1, 2, 3]);
    expect(by('privacy_level')?.elsewhere).toBeUndefined();
    expect(by('max_db_days')).toMatchObject({
      value: '90 days',
      elsewhere: { label: 'In Pi-hole', url: 'http://192.0.2.16/admin/settings' },
    });
    expect(by('max_db_days')?.choose).toBeUndefined();
    expect(by('dns_and_dhcp')?.elsewhere).toEqual({
      label: 'In Pi-hole',
      url: 'http://192.0.2.16/admin/settings/dns',
    });

    const look = panels('read').flatMap((p) => (p.kind === 'settings' ? p.rows : [])) as ThingSetting[];
    expect(look.find((r) => r.id === 'blocking_mode')?.choose?.button.allowed).toBe(false);
    expect(look.find((r) => r.id === 'blocking_mode')?.choose?.button.reason).toMatch(/Look only/);
    expect(look.find((r) => r.id === 'query_logging')?.toggle?.allowed).toBe(false);
    expect(look.find((r) => r.id === 'privacy_level')?.choose?.button.allowed).toBe(false);
  });

  it('writes blocking_mode, query_logging and privacy_level as single-field PATCH /api/config and verifies read-back', async () => {
    reset();
    const done = await act(ctx, { target: 'blocking_mode', value: 'NXDOMAIN' });
    expect(done.message).toContain('NXDOMAIN');
    expect(done.message).toContain('Checked with Pi-hole');
    expect(done).toMatchObject({
      changeKind: 'setting.blocking_mode',
      detail: '0.0.0.0',
      undo: { target: 'blocking_mode', value: 'NULL', expect: 'NXDOMAIN' },
    });
    expect(ph.store.calls).toEqual([
      { method: 'GET', path: '/api/config/dns', body: null },
      { method: 'PATCH', path: '/api/config', body: { config: { dns: { blocking: { mode: 'NXDOMAIN' } } } } },
      { method: 'GET', path: '/api/config/dns', body: null },
    ]);

    ph.store.calls = [];
    const ql = await act(ctx, { target: 'query_logging', value: false });
    expect(ql.message).toContain('Checked with Pi-hole');
    expect(ql).toMatchObject({
      changeKind: 'setting.query_logging',
      detail: 'On',
      undo: { target: 'query_logging', value: true, expect: false },
    });
    expect(ph.store.calls).toEqual([
      { method: 'GET', path: '/api/config/dns', body: null },
      { method: 'PATCH', path: '/api/config', body: { config: { dns: { queryLogging: false } } } },
      { method: 'GET', path: '/api/config/dns', body: null },
    ]);

    ph.store.calls = [];
    const priv = await act(ctx, { target: 'privacy_level', value: 2 });
    expect(priv.message).toContain('Checked with Pi-hole');
    expect(priv).toMatchObject({
      changeKind: 'setting.privacy_level',
      detail: 'Show everything',
      undo: { target: 'privacy_level', value: 0, expect: 2 },
    });
    expect(ph.store.calls).toEqual([
      { method: 'GET', path: '/api/config/misc', body: null },
      { method: 'PATCH', path: '/api/config', body: { config: { misc: { privacylevel: 2 } } } },
      { method: 'GET', path: '/api/config/misc', body: null },
    ]);
    // Unrelated sibling fields in both sections stay untouched.
    expect(ph.store.misc.delay_startup).toBe(0);
    expect(ph.store.dns.upstreams).toEqual(['9.9.9.9']);

    await act(ctx, { target: 'blocking_mode', value: 'IP_NODATA_AAAA' });
    expect((ph.store.dns.blocking as Record<string, unknown>).mode).toBe('IP_NODATA_AAAA');
  });

  it('preserves concurrent changes to other Pi-hole settings between read and field-only PATCH', async () => {
    reset();
    let reads = 0;
    const origDns = ph.store.dns;
    // Inject a concurrent change between Whombat's pre-write GET and its PATCH by wrapping the first GET read.
    const declared = {
      ...PIHOLE_SETTINGS,
      specs: PIHOLE_SETTINGS.specs.map((s) =>
        s.id === 'blocking_mode' && s.readFresh
          ? {
              ...s,
              readFresh: async (services: Services, r: typeof row) => {
                const snap = await (s.readFresh as NonNullable<typeof s.readFresh>)(services, r);
                reads += 1;
                if (reads === 1) {
                  ph.store.dns.dnssec = true;
                  ph.store.dns.upstreams = ['1.1.1.1'];
                  ph.store.dns.queryLogging = false;
                }
                return snap;
              },
            }
          : s,
      ),
    };
    const done = await settingAction(declared)(ctx, { target: 'blocking_mode', value: 'NXDOMAIN' });
    expect(done.uncertain).toBeUndefined();
    expect(done.message).toContain('Checked with Pi-hole');
    expect(origDns).toBe(ph.store.dns);
    expect((ph.store.dns.blocking as Record<string, unknown>).mode).toBe('NXDOMAIN');
    expect(ph.store.dns.dnssec).toBe(true);
    expect(ph.store.dns.upstreams).toEqual(['1.1.1.1']);
    expect(ph.store.dns.queryLogging).toBe(false);
    const patch = ph.store.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ config: { dns: { blocking: { mode: 'NXDOMAIN' } } } });
  });

  it('refuses unknown/elsewhere/invalid values, detects deaf writes, and enforces undo guard', async () => {
    reset();
    await expect(act(ctx, { target: 'dns_and_dhcp', value: true })).rejects.toThrow();
    await expect(act(ctx, { target: 'dnssec', value: true })).rejects.toThrow();
    await expect(act(ctx, { target: 'max_db_days', value: 30 })).rejects.toThrow();
    await expect(act(ctx, { target: 'rate_limit', value: 2000 })).rejects.toThrow();
    await expect(act(ctx, { target: 'blocking_mode', value: 'ZERO' })).rejects.toThrow();
    await expect(act(ctx, { target: 'privacy_level', value: 9 })).rejects.toThrow();
    await expect(act(ctx, { target: 'nope', value: 1 })).rejects.toThrow();

    const same = await act(ctx, { target: 'blocking_mode', value: 'NULL' });
    expect(same.unchanged).toBe(true);

    ph.store.deaf = true;
    await expect(act(ctx, { target: 'blocking_mode', value: 'NXDOMAIN' })).rejects.toThrow(/didn’t take/);
    await expect(act(ctx, { target: 'query_logging', value: false })).rejects.toThrow(/didn’t take/);
    await expect(act(ctx, { target: 'privacy_level', value: 2 })).rejects.toThrow(/didn’t take/);

    ph.store.deaf = false;
    const done = await act(ctx, { target: 'blocking_mode', value: 'NXDOMAIN' });
    (ph.store.dns.blocking as Record<string, unknown>).mode = 'NODATA';
    await expect(
      act(ctx, { target: 'blocking_mode', value: done.undo?.value, expect: done.undo?.expect }),
    ).rejects.toThrow(/changed again since/);
    (ph.store.dns.blocking as Record<string, unknown>).mode = 'NXDOMAIN';
    await act(ctx, { target: 'blocking_mode', value: done.undo?.value, expect: done.undo?.expect });
    expect((ph.store.dns.blocking as Record<string, unknown>).mode).toBe('NULL');
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
    const ql = await describeSetting(PIHOLE_SETTINGS, ctx, { target: 'query_logging', value: false });
    expect(ql?.lines[0]).toContain('On → Off');
    const priv = await describeSetting(PIHOLE_SETTINGS, ctx, { target: 'privacy_level', value: 2 });
    expect(priv?.lines[0]).toContain('Show everything → Hide domains and devices');
    expect(
      await describeSetting(PIHOLE_SETTINGS, ctx, { target: 'blocking_mode', value: 'ZERO' }),
    ).toBeNull();
    expect(await describeSetting(PIHOLE_SETTINGS, ctx, { target: 'dnssec', value: true })).toBeNull();
    expect(await describeSetting(PIHOLE_SETTINGS, ctx, { target: 'max_db_days', value: 30 })).toBeNull();
    expect(await describeSetting(PIHOLE_SETTINGS, ctx, { target: 'privacy_level', value: 9 })).toBeNull();
    expect(await describeSetting(PIHOLE_SETTINGS, ctx, { target: 'blocking_mode', value: 'BAD' })).toBeNull();
  });
});
