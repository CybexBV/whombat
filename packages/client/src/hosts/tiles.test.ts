import { HostServer } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { amountOf, cpuLine, cpuName, litSegments, serverOsLine, serverTiles } from './tiles';

/** Spaces as typed (the figures keep a number and its unit together with a no-break space). */
const plain = (s: string | undefined) => s?.replace(/\u00a0/g, ' ');

const server = (patch: Partial<HostServer> = {}): HostServer =>
  HostServer.parse({
    id: 'pve-02',
    name: 'pve-02',
    group: '',
    status: 'ok',
    platform: 'proxmox',
    os: 'Proxmox VE 9.2.11',
    cpu: { model: 'AMD Ryzen AI MAX+ PRO 395 w/ Radeon 8060S', cores: 16, threads: 32 },
    uptimeS: 55 * 86_400 + 3600,
    cpuPct: 10.4,
    memory: { usedPct: 64.4, usedGb: 76, totalGb: 118 },
    storage: { usedPct: 44, usedTb: 1.6, capacityTb: 3.6 },
    temperature: { maxC: 75, limitC: 85 },
    guests: [{ platform: 'pve', running: 19, total: 22 }],
    agent: { version: '1.0.0', connected: true },
    lastSeen: '2026-10-19T10:00:00.000Z',
    cpu24h: [5, 7, null, 9],
    remoteControl: { console: false, power: false },
    ...patch,
  });

describe('a server’s card (CN-12, CN-13)', () => {
  it('writes the CPU in full, without the trademark marks', () => {
    expect(cpuName('Intel(R) Core(TM) i9-13900H')).toBe('Intel Core i9-13900H');
    expect(cpuName('Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz')).toBe('Intel Xeon CPU E5-2680 v4 @ 2.40GHz');
    expect(cpuLine(server().cpu)).toEqual({
      name: 'AMD Ryzen AI MAX+ PRO 395 w/ Radeon 8060S',
      detail: '16 cores · 32 threads',
    });
    expect(cpuLine({ model: 'ARM Cortex-A72', cores: 1, threads: 0 })?.detail).toBe('1 core');
    expect(cpuLine(null)).toBeNull();
    expect(cpuLine({ model: ' ', cores: 4, threads: 4 })).toBeNull();
  });

  it('says what runs it and for how long', () => {
    expect(plain(serverOsLine(server()))).toBe('Proxmox VE 9.2 · up 55 d');
    expect(serverOsLine(server({ status: 'offline' }))).toBe('Proxmox VE 9.2');
  });

  it('draws Processor, Memory, Storage and Temperature in words with their figures and where they lead', () => {
    const [cpu, mem, disk, temp] = serverTiles(server());
    expect([cpu?.label, cpu?.value, cpu?.unit, plain(cpu?.sub)]).toEqual([
      'Processor',
      'Quiet',
      '',
      '10 % in use · 24 h avg 7 %',
    ]);
    expect([mem?.value, plain(mem?.sub), mem?.tone]).toEqual([
      'Plenty free',
      '42 GB free · 76 of 118 GB in use (64 %)',
      'ok',
    ]);
    expect([disk?.value, plain(disk?.sub)]).toEqual(['Plenty free', '1.6 of 3.6 TB · 44 % in use']);
    // Temperature is its figure: a word could contradict the pill.
    expect([temp?.value, temp?.unit, plain(temp?.sub), temp?.tone]).toEqual([
      '75',
      '°C',
      'limit 85 °C',
      'warn',
    ]);
    expect(temp?.share).toBeCloseTo(75 / 85);
    expect(serverTiles(server()).map((t) => t.href.replace(/^.*pve-02/, ''))).toEqual([
      '?chart=cpu',
      '?chart=memory',
      '?tab=storage',
      '?chart=hottest',
    ]);
    expect(cpu?.spoken).toContain('Processor Quiet');
    expect(cpu?.spoken).toContain('10 % in use');
  });

  it('shows the bare figures of a server that isn’t working, never a reassuring word', () => {
    const [cpu, mem, disk] = serverTiles(server({ status: 'bad', statusNote: 'disk array failed' }));
    expect([cpu?.value, cpu?.unit, mem?.value, plain(mem?.sub), disk?.value]).toEqual([
      '10',
      '%',
      '64',
      '76 of 118 GB',
      '44',
    ]);
  });

  it('colours what is full or hot', () => {
    const t = serverTiles(
      server({
        memory: { usedPct: 93, usedGb: null, totalGb: 64 },
        storage: { usedPct: 91, usedTb: null, capacityTb: 48 },
      }),
    );
    expect(t[1]?.tone).toBe('warn');
    expect(plain(t[1]?.sub)).toContain('60 of 64 GB');
    // Amber at most: red is only for what isn't working, which the pill says.
    expect(t[2]?.tone).toBe('warn');
    expect(plain(t[2]?.sub)).toContain('44 of 48 TB');
  });

  it('says — with an unlit meter offline or without a figure', () => {
    for (const t of serverTiles(server({ status: 'offline' }))) {
      expect([t.value, t.unit, t.share, t.sub]).toEqual(['—', '', null, '']);
    }
    const t = serverTiles(
      server({ temperature: null, storage: { usedPct: null, usedTb: null, capacityTb: null } }),
    );
    expect([t[2]?.value, t[3]?.value, t[3]?.spoken]).toEqual(['—', '—', 'Temperature not known']);
  });

  it('lights at least one segment for a small figure', () => {
    expect(litSegments(0.01, 20)).toBe(1);
    expect(litSegments(0, 20)).toBe(0);
    expect(litSegments(null, 20)).toBe(0);
    expect(litSegments(1.4, 10)).toBe(10);
    expect(litSegments(0.44, 20)).toBe(9);
  });

  it('says amounts in the total’s unit', () => {
    expect(plain(amountOf(420, 1800))).toBe('0.4 of 1.8 TB');
    expect(plain(amountOf(12, 1800))).toBe('12 GB of 1.8 TB');
    expect(plain(amountOf(null, 94))).toBe('— of 94 GB');
  });
});

describe('a server page’s reading time', () => {
  it('is the page’s moment less the agent’s last report, unknown without one', async () => {
    const { serverReportAt } = await import('./tiles');
    const at = serverReportAt({ asOf: '2026-09-23T12:05:00.000Z', server: { agent: { lastSyncSAgo: 120 } } });
    expect(at).toBe('2026-09-23T12:03:00.000Z');
    expect(
      serverReportAt({ asOf: '2026-09-23T12:05:00.000Z', server: { agent: { lastSyncSAgo: null } } }),
    ).toBeNull();
  });
});
