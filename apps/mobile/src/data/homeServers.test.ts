/** Overview's Servers on the phone (overview-one-page.md): groups that keep a child with its parent, and the facts Search shows. */

import { overviewServerRows } from '@whombat/client/hosts';
import type { HostServer } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { serverFacts, serverGroups } from './homeServers';

function server(id: string, over: Partial<HostServer> = {}): HostServer {
  return {
    id,
    name: id,
    group: 'Home lab',
    status: 'ok',
    statusNote: null,
    platform: 'proxmox',
    os: 'Proxmox VE 9.0.10',
    cpu: { model: 'AMD Ryzen 7 5800X', cores: 8, threads: 16 },
    uptimeS: 86_400,
    cpuPct: 34,
    memory: { usedPct: 80, usedGb: 51.2, totalGb: 64 },
    storage: { usedPct: 50, usedTb: 1, capacityTb: 2 },
    temperature: { maxC: 61, limitC: 85 },
    diskWearMaxPct: null,
    guests: [{ platform: 'pve', running: 23, total: 40 }],
    agent: { version: '0.9.2', connected: true },
    lastSeen: null,
    cpu24h: [3, 4, 6, 5, 8, 7, 9, 30, 10, 8, 9, 11],
    remoteControl: {
      console: true,
      power: true,
      hostShell: true,
      hostPower: true,
      manage: true,
      diagnose: true,
    },
    maintenance: null,
    parent: null,
    ...over,
  } as HostServer;
}

describe('Overview’s servers on the phone (overview-one-page.md)', () => {
  const NOW = Date.parse('2026-11-12T14:00:00Z');

  it('keeps a server and the servers that run on it in one group', () => {
    const rows = overviewServerRows(
      [
        server('pve-02', { status: 'warn', statusNote: 'running warm' }),
        server('docker-01', { parent: 'pve-02' }),
        server('blackbox', { status: 'bad', statusNote: 'disk array failed' }),
        server('alpha'),
      ],
      NOW,
      'Europe/Amsterdam',
    );
    expect(serverGroups(rows).map((g) => g.map((r) => r.id))).toEqual([
      ['blackbox'],
      ['pve-02', 'docker-01'],
      ['alpha'],
    ]);
    expect(serverGroups([])).toEqual([]);
  });

  it('gives Search and Places each server’s logo, system and how it is', () => {
    const facts = serverFacts([
      server('pve-01'),
      server('blackbox', { status: 'bad', statusNote: 'disk array failed', os: 'Unraid 7.3.1' }),
      server('the-falcon', { status: 'offline' }),
    ]);
    expect(facts.map((f) => [f.thingId, f.status])).toEqual([
      ['server:blackbox', 'Disk array failed'],
      ['server:the-falcon', 'Offline'],
      ['server:pve-01', 'Running'],
    ]);
    expect(facts[2]?.mark).toBe('proxmox');
    expect(facts[2]?.osLine).toContain('Proxmox VE 9.0');
  });
});
