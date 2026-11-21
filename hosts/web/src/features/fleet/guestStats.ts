// Fleet-wide guest counts derived from GET /guests (the full list): per host,
// per platform and the busiest guests. The fleet body's per-platform summary
// merges Proxmox and libvirt VMs and has no LXC counts; the list has every
// guest, so the overview computes its counts from it (up to the page limit).

import type { FleetGuest, Platform } from '../../api/types';

export interface Tally {
  running: number;
  stopped: number;
  unhealthy: number;
  total: number;
}

export const emptyTally = (): Tally => ({ running: 0, stopped: 0, unhealthy: 0, total: 0 });

function add(t: Tally, g: FleetGuest): void {
  t.total++;
  if (g.state === 'running') t.running++;
  else if (g.state === 'unhealthy') t.unhealthy++;
  else t.stopped++;
}

export interface HostTally {
  docker: Tally;
  incus: Tally;
  incusVms: Tally;
  libvirt: Tally;
  pveVms: Tally;
  pveCts: Tally;
  all: Tally;
}

export const emptyHostTally = (): HostTally => ({
  docker: emptyTally(),
  incus: emptyTally(),
  incusVms: emptyTally(),
  libvirt: emptyTally(),
  pveVms: emptyTally(),
  pveCts: emptyTally(),
  all: emptyTally(),
});

export interface GuestStats {
  byHost: Map<string, HostTally>;
  byPlatform: Record<Platform, Tally>;
  all: Tally;
  /** Hosts that run each platform. */
  hostsOf: Record<Platform, string[]>;
  /** Running guests by CPU, busiest first. */
  top: FleetGuest[];
  /** Containers in the unhealthy state. */
  unhealthy: FleetGuest[];
  /** True when the list was cut at its page limit (counts are lower bounds). */
  truncated: boolean;
}

export function guestStats(guests: FleetGuest[], total: number): GuestStats {
  const byHost = new Map<string, HostTally>();
  const byPlatform: Record<Platform, Tally> = { docker: emptyTally(), incus: emptyTally(), libvirt: emptyTally(), pve: emptyTally() };
  const hostsOf: Record<Platform, Set<string>> = { docker: new Set(), incus: new Set(), libvirt: new Set(), pve: new Set() };
  const all = emptyTally();
  for (const g of guests) {
    let h = byHost.get(g.server);
    if (!h) byHost.set(g.server, (h = emptyHostTally()));
    add(h.all, g);
    add(all, g);
    add(byPlatform[g.platform], g);
    hostsOf[g.platform].add(g.server);
    switch (g.platform) {
      case 'docker':
        add(h.docker, g);
        break;
      case 'incus':
        add(h.incus, g);
        if (g.kind === 'vm') add(h.incusVms, g);
        break;
      case 'libvirt':
        add(h.libvirt, g);
        break;
      case 'pve':
        add(g.kind === 'vm' ? h.pveVms : h.pveCts, g);
        break;
    }
  }
  const top = guests.filter((g) => g.state !== 'stopped' && g.cpu_pct != null).sort((a, b) => (b.cpu_pct ?? 0) - (a.cpu_pct ?? 0) || a.name.localeCompare(b.name));
  return {
    byHost,
    byPlatform,
    all,
    hostsOf: { docker: [...hostsOf.docker], incus: [...hostsOf.incus], libvirt: [...hostsOf.libvirt], pve: [...hostsOf.pve] },
    top,
    unhealthy: guests.filter((g) => g.state === 'unhealthy'),
    truncated: total > guests.length,
  };
}
