// Fixture-mode hints (CONTRACT 1 "Hints"): conditions worth watching derived
// from fleet.json's current values and the agent catalog, with the hub's
// thresholds: a sensor from 70% of its limit (warning from 85%, unless an
// alert is open for it), disk space 80 to 89%, SSD wear 60 to 74%, failing
// collectors and unhealthy containers.

import type { Fleet, FleetServer, Hint } from '../../src/api/types.ts';
import { AGENT_SEEDS } from './catalog.ts';

function hintsFor(s: FleetServer, fleet: Fleet): Hint[] {
  const out: Hint[] = [];
  if (s.status === 'offline' || !s.current) return out;
  const c = s.current;
  const limit = c.temp_limit_c ?? 85;
  const openTemp = fleet.alerts.some((a) => a.server === s.id && a.rule.startsWith('sensor.temp'));
  if (c.temp_max_c != null && limit > 0 && c.temp_max_c / limit >= 0.7 && !openTemp) {
    const warn = c.temp_max_c * 100 >= limit * 85;
    out.push({
      server: s.id,
      kind: 'sensor.near_limit',
      severity: warn ? 'warning' : 'info',
      entity: 'cpu_package',
      title: `CPU package at ${Math.round(c.temp_max_c)} °C`,
      detail: `${Math.round((c.temp_max_c / limit) * 100)}% of the ${Math.round(limit)} °C limit`,
      link: '#temps',
    });
  }
  const openSpace = fleet.alerts.some((a) => a.server === s.id && a.rule === 'disk.space_high');
  if (c.disk_used_pct != null && c.disk_used_pct >= 80 && c.disk_used_pct < 90 && !openSpace) {
    out.push({ server: s.id, kind: 'disk.space', severity: 'info', entity: 'fs:/', title: `Disks ${Math.round(c.disk_used_pct)}% full`, detail: 'Across the mounted filesystems', link: '#storage' });
  }
  const openWear = fleet.alerts.some((a) => a.server === s.id && a.rule.startsWith('disk.wear'));
  if (c.disk_wear_max_pct != null && c.disk_wear_max_pct >= 60 && c.disk_wear_max_pct < 75 && !openWear) {
    out.push({ server: s.id, kind: 'disk.wear', severity: 'info', entity: 'ssd', title: `SSD wear at ${Math.round(c.disk_wear_max_pct)}%`, detail: 'Endurance used, from SMART', link: '#storage' });
  }
  for (const col of AGENT_SEEDS[s.id]?.collectors ?? []) {
    if (!col.ok) out.push({ server: s.id, kind: 'collector.error', severity: 'warning', entity: col.name, title: `${col.name} not reporting`, detail: col.error ?? 'The collector failed.', link: '#agent' });
  }
  const unhealthy = s.workloads.docker.unhealthy;
  if (unhealthy > 0) {
    out.push({ server: s.id, kind: 'guests.unhealthy', severity: 'warning', entity: 'docker', title: `${unhealthy} ${unhealthy === 1 ? 'container' : 'containers'} unhealthy`, detail: 'Docker health check failing', link: '#guests' });
  }
  return out;
}

/** Hints of the servers in `group`, warnings first, then by server and title. */
export function fleetHints(fleet: Fleet, servers: FleetServer[]): Hint[] {
  const all = servers.flatMap((s) => hintsFor(s, fleet));
  return all.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1) || a.server.localeCompare(b.server) || a.title.localeCompare(b.title));
}

/** Hints of one server. */
export function hostHints(fleet: Fleet, serverId: string): Hint[] {
  const s = fleet.servers.find((x) => x.id === serverId);
  return s ? fleetHints(fleet, [s]) : [];
}
