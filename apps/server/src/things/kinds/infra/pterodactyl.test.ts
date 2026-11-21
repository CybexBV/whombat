/**
 * Pterodactyl's page from documented answers (service-dashboards.md SD-45; Pterodactyl 1.11 client API `GET /api/client`,
 * `GET /api/client/servers/{id}/resources`, `GET /api/client/servers/{id}/activity`, trimmed). Pure.
 */
import { ThingPageKpi, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import { buttonsOf } from './fixtures/row';
import {
  type GameServer,
  gameLive,
  PTERODACTYL_CHECKS,
  type PterodactylSnapshot,
  parseServers,
  powerButtons,
  pterodactylKpis,
  pterodactylNotices,
  pterodactylRows,
  pterodactylSkipped,
  pterodactylStatus,
  pterodactylView,
  stoppedByPerson,
} from './pterodactyl';

const NOW = new Date('2026-10-21T12:00:00Z');

const server = (identifier: string, name: string, limits: Record<string, number>, extra = {}) => ({
  object: 'server',
  attributes: {
    server_owner: true,
    identifier,
    internal_id: 1,
    uuid: `${identifier}-0000-4000-8000-000000000000`,
    name,
    node: 'Node 1',
    is_node_under_maintenance: false,
    description: '',
    limits: { swap: 0, io: 500, threads: null, oom_disabled: true, ...limits },
    feature_limits: { databases: 1, allocations: 1, backups: 3 },
    status: null,
    is_suspended: false,
    is_installing: false,
    is_transferring: false,
    ...extra,
  },
});

/** `GET /api/client` */
export const PTERODACTYL_SERVERS = {
  object: 'list',
  data: [
    server('1a7ce997', 'Minecraft', { memory: 4096, disk: 10240, cpu: 200 }),
    server('5b3c8f21', 'Valheim', { memory: 8192, disk: 20480, cpu: 400 }),
    server('9d0e4a77', 'Terraria', { memory: 1024, disk: 2048, cpu: 100 }),
    server(
      'c4f2aa10',
      'Old Rust',
      { memory: 0, disk: 0, cpu: 0 },
      { status: 'suspended', is_suspended: true },
    ),
  ],
  meta: { pagination: { total: 4, count: 4, per_page: 50, current_page: 1, total_pages: 1, links: {} } },
};

const stats = (state: string, memory: number, cpu: number, disk: number) => ({
  object: 'stats',
  attributes: {
    current_state: state,
    is_suspended: false,
    resources: {
      memory_bytes: memory,
      cpu_absolute: cpu,
      disk_bytes: disk,
      network_rx_bytes: 694220,
      network_tx_bytes: 337090,
      uptime: state === 'running' ? 3_600_000 : 0,
    },
  },
});

function snapshotWith(): PterodactylSnapshot {
  const servers = parseServers(PTERODACTYL_SERVERS);
  const live: Record<string, unknown> = {
    '1a7ce997': stats('running', 2_147_483_648, 45.5, 5_000_000_000),
    '5b3c8f21': stats('offline', 0, 0, 20_000_000_000),
    '9d0e4a77': stats('running', 536_870_912, 3.2, 500_000_000),
  };
  for (const s of servers) s.live = live[s.id] ? gameLive(live[s.id]) : null;
  (servers.find((s) => s.id === '5b3c8f21') as GameServer).stoppedUnexpectedly = true;
  return { readAt: NOW, servers };
}

const manager = buttonsOf('pterodactyl');

describe('pterodactyl', () => {
  it('reads servers with limits in bytes and unlimited as null', () => {
    const [mc, , , rust] = parseServers(PTERODACTYL_SERVERS);
    expect(mc).toMatchObject({
      id: '1a7ce997',
      name: 'Minecraft',
      limits: { cpu: 200, memory: 4096 * 1024 * 1024 },
    });
    expect(rust).toMatchObject({ suspended: true, limits: { cpu: null, memory: null, disk: null } });
    expect(gameLive({ attributes: { current_state: 'nonsense' } })).toBeNull();
  });

  it('adds up what the servers use', () => {
    const kpis = pterodactylKpis(snapshotWith());
    for (const k of kpis) ThingPageKpi.parse(k);
    expect(kpis.map((k) => [k.key, k.value, k.rest ?? null])).toEqual([
      ['running', '2', 'of 4'],
      ['cpu', '49 %', null],
      ['memory', '2.7 GB', null],
      ['disk', '26 GB', null],
    ]);
    expect(kpis.find((k) => k.key === 'cpu')?.sub).toBe('of 700 % allowed');
    expect(kpis.find((k) => k.key === 'disk')?.tone).toBeUndefined();
  });

  it('says which stopped on their own, are suspended or nearly full', () => {
    const s = snapshotWith();
    const notices = pterodactylNotices(s, undefined, 'https://panel.example.com');
    expect(notices.map((n) => [n.id, n.tone])).toEqual([
      ['stopped-5b3c8f21', 'warn'],
      ['suspended-c4f2aa10', 'warn'],
      ['disk-5b3c8f21', 'warn'],
    ]);
    expect(notices.map((n) => [n.check, n.nature, n.subject?.id, n.ignore?.lifts])).toEqual([
      ['pterodactyl.stopped', 'problem', 'server:5b3c8f21', 'newer'],
      // An administrator lifts a suspension: a person's, with the panel to do it in.
      ['pterodactyl.suspended', 'you', 'server:c4f2aa10', 'fixed'],
      ['pterodactyl.disk', 'problem', 'server:5b3c8f21', 'fixed'],
    ]);
    expect(notices[1]?.link).toMatchObject({ kind: 'url', url: 'https://panel.example.com' });
    expect(notices[2]).toMatchObject({ confirm: 2, band: 90, link: { kind: 'ask' } });
    for (const n of notices) expect(PTERODACTYL_CHECKS.map((c) => c.check)).toContain(n.check);
    // The head and the dot agree now (QN-S30): the lines decide warn, the head only counts what runs.
    expect(pterodactylStatus(s)).toEqual({ status: 'ok', badge: '2 of 4 running' });
  });

  it('makes each stop on its own a new episode, and says what it couldn’t read', () => {
    const s = snapshotWith();
    const off = s.servers.find((x) => x.id === '5b3c8f21') as GameServer;
    off.lastRunningAt = new Date('2026-10-21T09:00:00Z');
    const first = pterodactylNotices(s)[0]?.episode;
    off.lastRunningAt = new Date('2026-10-21T12:00:00Z');
    expect(pterodactylNotices(s)[0]?.episode).not.toBe(first);
    expect(pterodactylSkipped(s)).toEqual([]);
    expect(pterodactylSkipped({ ...s, liveMissed: true, activityMissed: true })).toEqual([
      'pterodactyl.stopped',
      'pterodactyl.disk',
      'pterodactyl.stopped',
    ]);
  });

  it('knows a person stopped it from its activity', () => {
    const since = Date.parse('2026-10-21T10:00:00Z');
    const activity = (event: string, timestamp: string) => ({
      object: 'list',
      data: [
        {
          object: 'activity_log',
          attributes: { event: 'server:console.command', timestamp: '2026-10-21T11:30:00Z' },
        },
        { object: 'activity_log', attributes: { event, timestamp, is_api: false } },
      ],
    });
    expect(stoppedByPerson(activity('server:power.stop', '2026-10-21T11:00:00Z'), since)).toBe(true);
    expect(stoppedByPerson(activity('server:power.start', '2026-10-21T11:00:00Z'), since)).toBe(false);
    expect(stoppedByPerson(activity('server:power.stop', '2026-10-20T11:00:00Z'), since)).toBe(false);
    expect(stoppedByPerson(null, since)).toBe(false);
  });

  it('draws the table with meters and the right power buttons', () => {
    const s = snapshotWith();
    const rows = pterodactylRows(s, manager);
    expect(rows.map((r) => r.id)).toEqual(['c4f2aa10', '1a7ce997', '9d0e4a77', '5b3c8f21']);
    expect(rows.find((r) => r.id === '1a7ce997')?.cells.memory).toMatchObject({
      meter: 0.5,
      note: 'of 4.3 GB',
    });
    const view = pterodactylView({ snapshot: s, url: 'https://panel.example.com', ...manager });
    for (const p of view.panels) ThingPagePanel.parse(p);
    const mc = s.servers.find((x) => x.id === '1a7ce997') as GameServer;
    const valheim = s.servers.find((x) => x.id === '5b3c8f21') as GameServer;
    const rust = s.servers.find((x) => x.id === 'c4f2aa10') as GameServer;
    expect(powerButtons(manager, mc).map((b) => [b.action, !!b.confirm])).toEqual([
      ['restart', true],
      ['stop', true],
    ]);
    expect(powerButtons(manager, valheim).map((b) => b.action)).toEqual(['start']);
    expect(powerButtons(manager, rust)).toEqual([]);
  });

  it('is in slots: each game server now with its buttons, beside what they use together', () => {
    const s = snapshotWith();
    const view = pterodactylView({ snapshot: s, url: 'https://panel.example.com', ...manager });
    for (const p of view.panels) ThingPagePanel.parse(p);
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['servers', 'inventory']);
    const live = view.panels[0];
    if (live?.kind !== 'gallery') throw new Error('live');
    // Running first with memory as the bar and CPU at its end, then off, then suspended.
    expect(
      live.items.map((i) => [
        i.title,
        i.sub ?? null,
        i.note ?? null,
        i.noteEnd ?? null,
        i.badge?.text ?? null,
      ]),
    ).toEqual([
      ['Minecraft', 'Node 1 · up 1 h', '2.1 GB of 4.3 GB', '46 % CPU', null],
      ['Terraria', 'Node 1 · up 1 h', '537 MB of 1.1 GB', '3 % CPU', null],
      ['Valheim', 'Node 1', null, null, 'Offline'],
      ['Old Rust', 'Node 1', null, null, 'Suspended'],
    ]);
    expect(live.items[0]?.progress).toBe(0.5);
    expect(live.items[2]).toMatchObject({ paused: true, actions: [{ action: 'start' }] });
    expect(live.items[0]?.actions?.map((b) => b.action)).toEqual(['restart', 'stop']);
    expect(live.meta).toBe('2 of 4 running');
    const inv = view.panels[1];
    if (inv?.kind !== 'list') throw new Error('inventory');
    expect(inv.items.map((i) => [i.id, i.figure?.value, i.figure?.note ?? null])).toEqual([
      ['game-servers', '4', '1 suspended'],
      // Together against the limits of the servers whose figures were read.
      ['cpu', '49 %', 'of 700 % allowed'],
      ['memory', '2.7 GB', 'of 14 GB'],
      ['disk', '26 GB', 'of 34 GB'],
    ]);
    // No version in the client API: no lines of its own; every server in its tab.
    expect(view.slots?.machine).toEqual([]);
    expect(view.tabs.map((t) => [t.key, t.count])).toEqual([['servers', 4]]);
    // The card keeps Running.
    expect(pterodactylKpis(s)[0]).toMatchObject({ key: 'running', value: '2' });
  });
});
