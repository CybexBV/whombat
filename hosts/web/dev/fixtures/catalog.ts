// Static fixture catalog: agent facts for the fleet.json servers (addresses,
// collectors, policies) and guest lookup in the two detail fixtures. All
// names, addresses and versions are fake.

import type { CollectorStatus, Guest, PlatformWorkload, RemoteControlToggles, StandardDetail } from '../../src/api/types.ts';
import type { FixtureSet } from './data.ts';

export interface AgentSeed {
  address: string;
  location: string;
  version: string;
  clockSkewS: number | null;
  collectors: CollectorStatus[];
  /** Hub toggles (admin "Remote control"). */
  remoteControl: RemoteControlToggles;
  /** The agent's local config flags. */
  agentPolicy: RemoteControlToggles;
  /** Days from the fixture clock until the agent certificate expires. */
  certDays: number;
}

const ok = (name: string): CollectorStatus => ({ name, ok: true, error: null });
const on = { console: true, power: true };
/** Hosts whose guests can be managed in fixture mode (docs/MANAGE.md). */
const manage = { console: true, power: true, manage: true };
const off = { console: false, power: false };

/** Keyed by fleet.json server id, in fleet order. */
export const AGENT_SEEDS: Record<string, AgentSeed> = {
  basalt: {
    address: '10.20.0.11', location: 'Rack A · unit 4', version: '0.14.2', clockSkewS: 0.1,
    collectors: ['host', 'sensors', 'smart', 'docker', 'incus', 'libvirt'].map(ok),
    remoteControl: manage, agentPolicy: manage, certDays: 318,
  },
  granite: {
    address: '10.20.0.12', location: 'Rack A · unit 5', version: '0.14.2', clockSkewS: -0.2,
    collectors: ['host', 'sensors', 'smart', 'docker'].map(ok),
    remoteControl: off, agentPolicy: on, certDays: 301,
  },
  obsidian: {
    address: '10.20.0.13', location: 'Rack A · unit 9', version: '0.14.2', clockSkewS: 0.3,
    collectors: [ok('host'), ok('sensors'), ok('smart'), { name: 'docker', ok: false, error: 'permission denied while trying to connect to the Docker daemon socket' }, ok('incus')],
    remoteControl: off, agentPolicy: { console: true, power: false }, certDays: 287,
  },
  quartz: {
    address: '10.20.0.21', location: 'Lab bench · shelf 1', version: '0.14.2', clockSkewS: 4.8,
    collectors: ['host', 'sensors', 'smart', 'docker', 'incus', 'libvirt'].map(ok),
    remoteControl: off, agentPolicy: on, certDays: 254,
  },
  shale: {
    address: '10.20.0.15', location: 'Rack A · unit 7', version: '0.14.2', clockSkewS: 0,
    collectors: ['host', 'sensors', 'smart', 'pve'].map(ok),
    remoteControl: manage, agentPolicy: manage, certDays: 311,
  },
  flint: {
    address: '10.20.0.41', location: 'Edge · branch office', version: '0.14.2', clockSkewS: 0.2,
    collectors: ['host', 'sensors', 'smart', 'docker'].map(ok),
    remoteControl: off, agentPolicy: on, certDays: 342,
  },
  onyx: {
    address: '10.20.0.22', location: 'Lab bench · shelf 2', version: '0.14.2', clockSkewS: -0.1,
    collectors: ['host', 'sensors', 'smart', 'docker', 'incus', 'libvirt'].map(ok),
    remoteControl: off, agentPolicy: off, certDays: 266,
  },
  marble: {
    address: '10.20.0.42', location: 'Edge · garage', version: '0.13.9', clockSkewS: null,
    collectors: ['host', 'sensors', 'smart'].map(ok),
    remoteControl: off, agentPolicy: on, certDays: 97,
  },
};

/** Platform workload blocks of a detail fixture (null for servers without one). */
export function workloadsOf(fx: FixtureSet, serverId: string): PlatformWorkload[] {
  if (serverId === 'basalt') {
    const w: StandardDetail['workloads'] = fx.basalt.workloads;
    return [w?.docker, w?.incus, w?.libvirt].filter((x): x is PlatformWorkload => !!x);
  }
  if (serverId === 'shale') return [fx.shale.guests.vm, fx.shale.guests.container].filter((x): x is PlatformWorkload => !!x);
  return [];
}

/** A guest by id ("incus:dev-shell", "pve:203"), or null. */
export function findGuest(fx: FixtureSet, serverId: string, guestId: string): Guest | null {
  for (const w of workloadsOf(fx, serverId)) {
    const g = w.guests.find((x) => x.id === guestId);
    if (g) return g;
  }
  return null;
}
