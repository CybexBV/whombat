import { HostServer } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  overviewServerOrder,
  overviewServerRow,
  overviewServerRows,
  overviewServersLine,
  RUNNING_DOTS_MAX,
  runningDots,
  STALE_READING_MS,
  sparklinePaths,
} from './overview';

const plain = (s: string | null | undefined) => s?.replace(/ /g, ' ');
const NOW = Date.parse('2026-10-19T10:00:00.000Z');
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
    temperature: { maxC: 75, limitC: 85 },
    guests: [{ platform: 'pve', running: 19, total: 22 }],
    agent: { version: '1.0.0', connected: true },
    lastSeen: new Date(NOW - 60_000).toISOString(),
    cpu24h: [5, 7, null, 9],
    remoteControl: { console: false, power: false },
    ...patch,
  });

describe('Overview’s server order (OVP-06)', () => {
  it('sorts top-level servers worst first, a child right under its parent, an orphan on top level', () => {
    const order = overviewServerOrder([
      server({ id: 'a', name: 'alpha' }),
      server({ id: 'pve', name: 'pve', status: 'warn' }),
      server({ id: 'c2', name: 'zeta', parent: 'pve' }),
      server({ id: 'c1', name: 'docker', parent: 'pve', status: 'offline' }),
      server({ id: 'orphan', name: 'beta', parent: 'gone' }),
      server({ id: 'bad', name: 'omega', status: 'bad' }),
    ]);
    expect(order.map((o) => o.server.id)).toEqual(['bad', 'pve', 'c1', 'c2', 'a', 'orphan']);
    expect(order.map((o) => o.parent?.id ?? null)).toEqual([null, null, 'pve', 'pve', null, null]);
  });

  it('keeps servers that name each other as parents', () => {
    const order = overviewServerOrder([server({ id: 'x', parent: 'y' }), server({ id: 'y', parent: 'x' })]);
    expect(order.map((o) => o.server.id).sort()).toEqual(['x', 'y']);
  });

  it('marks a child row and names its parent where its uptime was', () => {
    const rows = overviewServerRows(
      [
        server(),
        server({
          id: 'docker-01',
          name: 'docker-01',
          os: 'Ubuntu 24.04.1 LTS',
          parent: 'pve-02',
          platform: 'standard',
        }),
      ],
      NOW,
      TZ,
    );
    expect(rows.map((r) => [r.id, r.child, r.parentId])).toEqual([
      ['pve-02', false, null],
      ['docker-01', true, 'pve-02'],
    ]);
    expect(rows[1]?.osLine).toContain('on pve-02');
    expect(rows[1]?.osLine).not.toContain('up ');
    expect(plain(rows[0]?.osLine)).toContain('up 23 d');
  });
});

describe('a server row (OVP-02…OVP-08)', () => {
  it('has no pill when it runs fine, its word otherwise', () => {
    const fine = overviewServerRow(server(), NOW, TZ);
    expect(fine.pill).toBeNull();
    expect(fine.statusWord).toBe('Running fine');
    expect(fine.label).toContain('running fine');
    const warm = overviewServerRow(server({ status: 'warn', statusNote: 'running warm' }), NOW, TZ);
    expect(warm.pill).toEqual({ word: 'Running warm', tone: 'warn' });
    expect(overviewServerRow(server({ status: 'offline' }), NOW, TZ).pill?.tone).toBe('mut');
  });

  it('puts the figure first with its word, the average and the amounts', () => {
    const r = overviewServerRow(server({ hostsThisWhombat: true }), NOW, TZ);
    expect(r.thisWhombat).toBe(true);
    expect([plain(r.cpu.value), r.cpu.word, plain(r.cpu.avg)]).toEqual(['10 %', 'Quiet', 'avg 7 %']);
    expect(r.cpu.points).toEqual([5, 7, 9]);
    expect([plain(r.memory.value), r.memory.word, plain(r.memory.sub)]).toEqual([
      '64 %',
      'Plenty free',
      '76 of 118 GB',
    ]);
    expect(plain(r.storage.sub)).toBe('0.9 of 2 TB');
    expect(r.memory.share).toBeCloseTo(0.644);
    expect([plain(r.temp.value), plain(r.temp.sub), r.temp.noSensor]).toEqual([
      '75 °C',
      'limit 85 °C',
      false,
    ]);
    expect(r.temp.share).toBeCloseTo(75 / 85);
    expect(r.cpu.href).toContain('chart=cpu');
    expect(r.storage.href).toContain('tab=storage');
    expect(r.running.href).toContain('tab=guests');
  });

  it('shows bare figures on a server that isn’t working, with the tinted row', () => {
    const r = overviewServerRow(server({ status: 'bad', statusNote: 'Disk array failed' }), NOW, TZ);
    expect(r.notWorking).toBe(true);
    expect([r.cpu.word, r.memory.word, r.storage.word]).toEqual([null, null, null]);
    expect(plain(r.cpu.value)).toBe('10 %');
    expect(r.cpu.avg).not.toBeNull();
  });

  it('says No sensor without a temperature', () => {
    const r = overviewServerRow(server({ temperature: null }), NOW, TZ);
    expect([r.temp.value, r.temp.sub, r.temp.share, r.temp.noSensor]).toEqual(['–', 'No sensor', null, true]);
  });

  it('draws no line with fewer than two readings', () => {
    expect(overviewServerRow(server({ cpu24h: [null, 4] }), NOW, TZ).cpu.points).toEqual([]);
    expect(overviewServerRow(server({ cpu24h: [] }), NOW, TZ).cpu.avg).toBeNull();
  });

  it('says the reading’s time only when it is older than five minutes, or unknown', () => {
    const fresh = overviewServerRow(
      server({ lastSeen: new Date(NOW - STALE_READING_MS + 1000).toISOString() }),
      NOW,
      TZ,
    );
    expect(fresh.stale).toBeNull();
    expect(fresh.readTitle).toMatch(/^Read at /);
    const old = overviewServerRow(server({ lastSeen: new Date(NOW - 12 * 60_000).toISOString() }), NOW, TZ);
    expect(old.stale).toContain('12 min');
    expect(overviewServerRow(server({ lastSeen: null }), NOW, TZ).stale).toBe('Reading time unknown');
    expect(overviewServerRow(server({ lastSeen: null, status: 'pending' }), NOW, TZ).stale).toBeNull();
  });

  it('keeps an offline server’s dashes and last seen, not a reading time', () => {
    const r = overviewServerRow(
      server({ status: 'offline', lastSeen: new Date(NOW - 2 * 86_400_000).toISOString() }),
      NOW,
      TZ,
    );
    expect(r.offline).toBe(true);
    expect([r.cpu.value, r.memory.value, r.temp.value, r.memory.sub]).toEqual(['—', '—', '—', '']);
    expect(plain(r.seen)).toBe('Last seen 2 d ago');
    expect(r.stale).toBeNull();
    expect(r.running.count).toBe('19 of 22');
  });

  it('counts what runs: machines or apps, unwell first, nothing', () => {
    const r = overviewServerRow(server(), NOW, TZ);
    expect([r.running.count, r.running.word, r.running.nothing]).toEqual(['19 of 22', 'machines', false]);
    expect(r.running.dots).toEqual({ unwell: 0, running: 19, stopped: 3, more: 0 });
    const docker = overviewServerRow(
      server({ guests: [{ platform: 'docker', running: 24, total: 26, unhealthy: 2 }] }),
      NOW,
      TZ,
    );
    expect([docker.running.word, docker.running.tone]).toEqual(['2 unwell', 'warn']);
    expect(docker.running.dots).toEqual({ unwell: 2, running: 22, stopped: 2, more: 0 });
    const none = overviewServerRow(server({ guests: [] }), NOW, TZ);
    expect([none.running.count, none.running.word, none.running.nothing]).toEqual([
      '',
      'Nothing running',
      true,
    ]);
  });

  it('draws at most 60 dots and counts the rest', () => {
    const d = runningDots(70, 100, 3);
    expect(d.unwell + d.running + d.stopped).toBe(RUNNING_DOTS_MAX);
    expect(d).toEqual({ unwell: 3, running: 57, stopped: 0, more: 40 });
    expect(runningDots(5, 3, 9)).toEqual({ unwell: 3, running: 0, stopped: 0, more: 0 });
  });
});

describe('the Servers heading’s line', () => {
  it('says how many run, what isn’t working, and the machines and apps', () => {
    const line = overviewServersLine([
      server({ status: 'warn' }),
      server({ status: 'bad' }),
      server({ guests: [{ platform: 'docker', running: 14, total: 14 }] }),
    ]);
    expect(line).toBe('2 running · 1 not working · 52 of 58 machines and apps running');
    expect(overviewServersLine([server(), server({ status: 'offline' })])).toBe(
      '1 running · 1 offline · 38 of 44 machines running',
    );
    expect(overviewServersLine([server()])).toMatch(/^All running · 19 of 22 machines running$/);
    expect(overviewServersLine([server({ guests: [] })])).toBe('All running');
    expect(overviewServersLine([])).toBe('');
  });
});

describe('the processor’s 24 hour line', () => {
  it('scales to at least 20 % with room above, and closes the wash', () => {
    const p = sparklinePaths([0, 10], 100, 30);
    expect(p?.line).toBe('M0 29L100 16.3');
    expect(p?.area).toBe('M0 29L100 16.3L100 30L0 30Z');
    expect(sparklinePaths([0, 110], 100, 30)?.line).toBe('M0 29L100 3.5');
    expect(sparklinePaths([5], 100, 30)).toBeNull();
  });
});
