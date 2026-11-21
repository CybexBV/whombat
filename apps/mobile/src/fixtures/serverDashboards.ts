/**
 * The demo world's servers' Summaries (Whombat dashboards.md DS-09; dashboards-mobile.md AP-2135): each server of the
 * one-Whombat world borrows the figures, sensors, storages and history of the client's dashboard fixture of its kind
 * (`@whombat/client/hosts/fixtures` `dashboardFixtures`: pve-02 for Proxmox VE, blackbox for Unraid, the-titan for
 * Incus, the-falcon for a plain Linux host), so `serverDashboard` draws them as John's mocks do. Guests, hints,
 * alerts and the kinds' own detail stay the world's (`assistant.ts`, `hostsIu.ts`), so every other screen keeps its
 * story. Answers `hosts.serverMetrics` and a guest's `hosts.guestMetrics` (a guest of the dashboard fixture's, picked
 * by its id). Pure TypeScript.
 */
import { detailGuests } from '@whombat/client/hosts';
import {
  type DashboardFixture,
  type DashboardFixtureId,
  dashboardFixtures,
} from '@whombat/client/hosts/fixtures';
import type { HostSeries, HostSeriesRange, HostServerDetail } from '@whombat/core';

/** Which dashboard fixture each of the world's servers borrows from. */
const DONORS: Record<string, DashboardFixtureId> = {
  thetitan: 'the-titan',
  'pve-01': 'pve-02',
  'pve-02': 'pve-02',
  blackbox: 'blackbox',
  'the-falcon': 'the-falcon',
  // The demo world's Mac borrows a calm desk machine's day (macos-servers.md MAC-36).
  studio: 'the-falcon',
};

const RANGES: readonly string[] = ['1h', '6h', '24h', '7d', '30d', '90d'];

/** A small stable number for a string (which donor guest a guest borrows). */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function createServerDashboardFixtures(now: () => Date) {
  const fx = dashboardFixtures(now().getTime());
  const donor = (serverId: string): DashboardFixture | null => {
    const id = DONORS[serverId];
    return id ? fx[id] : null;
  };
  const rangeOf = (url: URL): HostSeriesRange => {
    const r = url.searchParams.get('range') ?? '';
    return (RANGES.includes(r) ? r : '24h') as HostSeriesRange;
  };

  return {
    /** What a server's page borrows: its figures now, its sensors and its storages. */
    detailExtras(serverId: string): Pick<HostServerDetail, 'live' | 'sensors'> & Partial<HostServerDetail> {
      const d = donor(serverId)?.detail;
      if (!d) return { live: null, sensors: [] };
      return { live: d.live, sensors: d.sensors, ...(d.health ? { health: d.health } : {}) };
    },

    /** `hosts.serverMetrics` and `hosts.guestMetrics` for the world's servers, or null. */
    handle(id: string, params: Record<string, string>, url: URL): HostSeries | null {
      const serverId = params.serverId ?? '';
      const f = donor(serverId);
      if (!f) return null;
      const range = rangeOf(url);
      if (id === 'hosts.serverMetrics') {
        const keys = url.searchParams.get('series')?.split(',').filter(Boolean);
        return { ...f.series(range, keys?.length ? keys : undefined), serverId };
      }
      if (id === 'hosts.guestMetrics') {
        const guestId = params.guestId ?? '';
        const theirs = detailGuests(f.detail);
        const pick = theirs[hash(guestId) % Math.max(1, theirs.length)];
        if (!pick) return null;
        return { ...f.guestSeries(pick.id, range), serverId, guestId };
      }
      return null;
    },
  };
}
