import type { ThingSummary } from '@whombat/core';
import { HostServer } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  connectionPlaceRows,
  placeOfThing,
  placeOpening,
  placeRowsTone,
  placeSpoken,
  placeSummary,
  placeSummaryParts,
  placeTone,
  serverPlaceRows,
} from './placeLists';
import { thingRows } from './things';

const NOW = Date.parse('2026-11-27T10:00:00.000Z');
const TZ = 'Europe/Amsterdam';

const server = (patch: Partial<HostServer> = {}): HostServer =>
  HostServer.parse({
    id: 'pve-02',
    name: 'pve-02',
    group: '',
    status: 'ok',
    platform: 'proxmox',
    os: 'Proxmox VE 9.2.11',
    cpu: { model: 'AMD Ryzen AI MAX+ PRO 395', cores: 16, threads: 32 },
    uptimeS: 23 * 86_400,
    cpuPct: 10.4,
    memory: { usedPct: 64.4, usedGb: 76, totalGb: 118 },
    storage: { usedPct: 44, usedTb: 0.9, capacityTb: 2 },
    temperature: { maxC: 60, limitC: 85 },
    guests: [{ platform: 'pve', running: 19, total: 22 }],
    agent: { version: '1.0.0', connected: true },
    lastSeen: new Date(NOW - 60_000).toISOString(),
    cpu24h: [5, 7, 9],
    remoteControl: { console: false, power: false },
    ...patch,
  });

const thing = (patch: Partial<ThingSummary> & Pick<ThingSummary, 'id' | 'name'>): ThingSummary =>
  ({
    kind: 'connection',
    status: 'ok',
    href: `/things/${encodeURIComponent(patch.id)}`,
    icon: 'server',
    facts: [],
    ...patch,
  }) as ThingSummary;

describe('the Servers list', () => {
  const fleet = [
    server({ id: 'pve-01', name: 'pve-01' }),
    server({ id: 'the-falcon', name: 'the-falcon', parent: 'pve-01', guests: [] }),
    server({ id: 'blackbox', name: 'blackbox', status: 'bad', platform: 'unraid' }),
    server({ id: 'pve-02', name: 'pve-02', status: 'warn' }),
  ];
  const things = thingRows([
    thing({
      id: 'server:blackbox',
      name: 'blackbox',
      kind: 'server',
      status: 'bad',
      reason: 'disk array failed.',
    }),
    thing({ id: 'server:pve-02', name: 'pve-02', kind: 'server', status: 'warn' }),
    thing({ id: 'server:pve-01', name: 'pve-01', kind: 'server' }),
    thing({ id: 'server:the-falcon', name: 'the-falcon', kind: 'server' }),
  ]);

  it('is Overview’s order: broken first, a child under its parent, each row its page', () => {
    const rows = serverPlaceRows(fleet, things, NOW, TZ);
    expect(rows.map((r) => r.id)).toEqual([
      'server:blackbox',
      'server:pve-02',
      'server:pve-01',
      'server:the-falcon',
    ]);
    expect(rows.map((r) => r.child)).toEqual([false, false, false, true]);
    expect(rows[0]?.href).toBe('/things/server%3Ablackbox');
  });

  it('says why one isn’t fine, how a fine one is, and its processor at the end', () => {
    const [blackbox, pve02, pve01, falcon] = serverPlaceRows(fleet, things, NOW, TZ);
    expect(blackbox).toMatchObject({ line: 'Disk array failed', tone: 'bad', level: 'notWorking' });
    expect(pve02?.tone).toBe('warn');
    expect(pve01?.line).toContain('19 of 22 running');
    expect(pve01?.figure).toMatch(/^10/);
    expect(falcon?.line).toContain('on pve-01');
  });

  it('takes the fleet’s live level, and Home’s only for a server kept quiet', () => {
    const offline = [server({ id: 'nas', name: 'nas', status: 'offline' })];
    const home = thingRows([thing({ id: 'server:nas', name: 'nas', kind: 'server', status: 'ok' })]);
    // Home not caught up yet: the outage still shows.
    const [live] = serverPlaceRows(offline, home, NOW, TZ);
    expect(live).toMatchObject({ level: 'notWorking', tone: 'bad' });
    // Kept quiet: it doesn't turn the list red.
    const quiet = new Set(['server:nas']);
    const [kept] = serverPlaceRows(offline, home, NOW, TZ, quiet);
    expect(kept).toMatchObject({ level: 'connected', tone: 'mut' });
    expect(placeRowsTone(serverPlaceRows(offline, home, NOW, TZ, quiet))).toBeNull();
  });

  it('keeps a server Home knows that the fleet doesn’t, after the fleet’s', () => {
    const more = thingRows([thing({ id: 'server:old', name: 'old', kind: 'server' })]);
    const rows = serverPlaceRows(fleet, [...things, ...more], NOW, TZ);
    expect(rows.at(-1)?.id).toBe('server:old');
    expect(rows).toHaveLength(fleet.length + 1);
  });

  it('falls back to Home’s servers without the fleet', () => {
    const rows = serverPlaceRows(null, things, NOW, TZ);
    expect(rows.map((r) => r.id)).toEqual(things.map((t) => t.id));
    expect(rows[0]).toMatchObject({ line: 'Disk array failed', tone: 'bad', figure: null });
    expect(rows[2]?.line).toBe('Connected');
  });
});

describe('the Connections list', () => {
  const rows = thingRows([
    thing({ id: 'connection:plex', name: 'Plex' }),
    thing({ id: 'connection:unifi', name: 'UniFi', status: 'warn', reason: '1 access point offline' }),
  ]);

  it('without Overview’s tiles: worst first, with the reason', () => {
    const list = connectionPlaceRows(rows, null);
    expect(list.map((r) => r.id)).toEqual(['connection:unifi', 'connection:plex']);
    expect(list[0]).toMatchObject({
      line: '1 access point offline',
      tone: 'warn',
      figure: null,
    });
  });
});

describe('a place’s words and marks', () => {
  it('counts what it holds and what isn’t fine', () => {
    const rows = serverPlaceRows(
      [server({ id: 'a', name: 'a', status: 'bad' }), server({ id: 'b', name: 'b' })],
      [],
      NOW,
      TZ,
    );
    expect(placeSummary('servers', rows)).toBe('2 servers · 1 not working');
    expect(placeSummary('servers', [])).toBe('');
    expect(
      placeSummaryParts('connections', [
        { level: 'needsLook' },
        { level: 'connected' },
        { level: 'notWorking' },
      ]),
    ).toEqual([
      { text: '3 connected', tone: null },
      { text: '1 not working', tone: 'bad' },
      { text: '1 needs a look', tone: 'warn' },
    ]);
  });

  it('marks the menu item with the worst of what it holds', () => {
    expect(placeTone([{ status: 'ok' }, { status: 'offline' }])).toBe('bad');
    expect(placeTone([{ status: 'warn' }, { status: 'ok' }])).toBe('warn');
    expect(placeTone([{ status: 'learning' }])).toBeNull();
    expect(placeRowsTone([{ level: 'connected' }, { level: 'needsLook' }])).toBe('warn');
    expect(placeRowsTone([{ level: 'needsLook' }, { level: 'notWorking' }])).toBe('bad');
    expect(placeRowsTone([{ level: 'learning' }])).toBeNull();
    expect(placeSpoken('connections', 'warn')).toBe('Connections, something needs a look');
    expect(placeSpoken('servers', null)).toBe('Servers');
  });

  it('knows which place a page is in, and opens on the last one looked at', () => {
    const lists = { servers: [{ id: 'server:a' }], connections: [{ id: 'connection:b' }] };
    expect(placeOfThing('server:a', lists)).toBe('servers');
    expect(placeOfThing('connection:b', lists)).toBe('connections');
    expect(placeOfThing('servers', lists)).toBeNull();
    const rows = [
      { id: 'x', href: '/things/x' },
      { id: 'y', href: '/things/y' },
    ];
    expect(placeOpening(rows, 'y')).toBe('/things/y');
    expect(placeOpening(rows, 'gone')).toBe('/things/x');
    expect(placeOpening([], null)).toBeNull();
    // A row that leads elsewhere (an older account's Settings) isn't opened by itself.
    expect(placeOpening([{ id: 'old', href: '/settings?tab=connections' }, ...rows], null)).toBe('/things/x');
    expect(placeOpening([{ id: 'old', href: '/settings?tab=connections' }], null)).toBeNull();
  });
});
