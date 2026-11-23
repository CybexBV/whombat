/**
 * What the Proxmox VE and Unraid pages share: their VMs and containers now as Live rows (“Guests now”), and as counts
 * in Inventory. A guest comes from the server Whombat watches (the hosts service's guests) or from the service's own
 * API; both are made into `GuestNow` first, so the rows read the same whichever way they came. Pure.
 */
import type { ThingGalleryItem, ThingPageItem, ThingPageLink } from '@whombat/core';
import { clip, figure1, pct, plural, span, thousands } from '../../words';
import { countLine, type LivePanel, liveRows } from '../slots';

/** A VM or container as the page shows it. */
export interface GuestNow {
  /** Stable for the row: `pve:101`, `qemu/101`, `docker:plex`. */
  id: string;
  name: string;
  kind: 'vm' | 'container';
  state: 'running' | 'unhealthy' | 'paused' | 'stopped';
  /** Processor now, percent of its own CPUs. */
  cpuPct: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  uptimeS: number | null;
  /** A few words after what it is: its node in a cluster, Docker's “Up 3 days”. */
  detail?: string | null;
  /** Its page in the app (the guest on its server's page). */
  href?: string;
}

/** How many rows Live shows: about as tall as Inventory beside it. */
export const GUEST_ROWS = 6;

const RANK: Record<GuestNow['state'], number> = { unhealthy: 0, running: 1, paused: 2, stopped: 3 };
export const isOn = (g: Pick<GuestNow, 'state'>) => g.state === 'running' || g.state === 'unhealthy';

/** An unhealthy one first, then the running ones, the busiest first, then paused ones, then those that are off. */
export function byBusiest(guests: readonly GuestNow[]): GuestNow[] {
  return [...guests].sort(
    (a, b) =>
      RANK[a.state] - RANK[b.state] || (b.cpuPct ?? -1) - (a.cpuPct ?? -1) || a.name.localeCompare(b.name),
  );
}

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/**
 * “14.1 of 16 GB”, “512 MB”: memory as computers count it (a 16 GiB VM is “16 GB”, as Proxmox and Unraid show it).
 */
function memoryWords(g: GuestNow): string | null {
  if (g.memUsedBytes === null || !isOn(g)) return null;
  const size = (n: number, div: number) => figure1(n / div);
  if (g.memLimitBytes && g.memLimitBytes >= g.memUsedBytes) {
    const [unit, div] = g.memLimitBytes >= GIB ? ['GB', GIB] : ['MB', MIB];
    return `${size(g.memUsedBytes, div as number)} of ${size(g.memLimitBytes, div as number)} ${unit}`;
  }
  return g.memUsedBytes >= GIB ? `${size(g.memUsedBytes, GIB)} GB` : `${Math.round(g.memUsedBytes / MIB)} MB`;
}

/** A guest's row: what it is and its memory under the name, its processor as the bar, how long it has been up. */
export function guestRow(g: GuestNow): ThingGalleryItem {
  const on = isOn(g);
  const sub = [g.kind === 'vm' ? 'VM' : 'Container', g.detail ?? null, memoryWords(g)]
    .filter(Boolean)
    .join(' · ');
  const cpu = on && g.cpuPct !== null ? Math.max(0, g.cpuPct) : null;
  return {
    id: clip(`guest-${g.id}`, 200),
    title: clip(g.name, 120),
    sub: clip(sub, 120),
    ...(g.state === 'unhealthy' ? { badge: { text: 'Unhealthy', tone: 'warn' as const } } : {}),
    ...(cpu !== null ? { progress: Math.min(1, cpu / 100), note: `${pct(cpu)} processor` } : {}),
    ...(g.state === 'paused' ? { note: 'Paused', paused: true } : {}),
    ...(on && g.uptimeS ? { noteEnd: `up ${span(g.uptimeS * 1000)}` } : {}),
    ...(g.state === 'stopped' ? { note: 'Off', muted: true } : {}),
    ...(g.href ? { href: g.href } : {}),
  };
}

/**
 * Live, “Guests now” (id `guests`): the running VMs and containers, the busiest first, then paused ones and those that
 * are off, greyed; at most `GUEST_ROWS`. `lead` rows go first (a parity check that runs). Null without any.
 */
export function guestsLive(
  guests: readonly GuestNow[],
  p: { lead?: ThingGalleryItem[]; link?: ThingPageLink; extra?: string } = {},
): LivePanel | null {
  const lead = p.lead ?? [];
  if (!guests.length && !lead.length) return null;
  const sorted = byBusiest(guests);
  const room = Math.max(0, GUEST_ROWS - lead.length);
  const running = guests.filter(isOn).length;
  const meta = [
    guests.length
      ? running === guests.length
        ? `${plural(running, 'guest')} running`
        : `${thousands(running)} of ${thousands(guests.length)} running`
      : null,
    p.extra ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
  return liveRows({
    id: 'guests',
    title: 'Guests now',
    shape: 'square',
    ...(meta ? { meta: clip(meta, 120) } : {}),
    ...(guests.length > room ? { total: guests.length + lead.length } : {}),
    ...(p.link ? { link: p.link } : {}),
    items: [...lead, ...sorted.slice(0, room).map(guestRow)],
    empty: 'Nothing runs on it.',
  });
}

/** Inventory's line for VMs or containers: how many, and how many run. Null when there are none of that kind. */
export function guestCountLine(
  guests: readonly GuestNow[],
  kind: GuestNow['kind'],
  url?: string,
): ThingPageItem | null {
  const all = guests.filter((g) => g.kind === kind);
  if (!all.length) return null;
  const running = all.filter(isOn).length;
  const unhealthy = all.filter((g) => g.state === 'unhealthy').length;
  return countLine({
    id: kind === 'vm' ? 'vms' : 'containers',
    title: kind === 'vm' ? 'VMs' : 'Containers',
    icon: kind === 'vm' ? 'device' : 'database',
    value: thousands(all.length),
    ...(unhealthy
      ? { note: `${unhealthy} unhealthy`, noteTone: 'warn' as const }
      : running === all.length
        ? { note: 'All running', noteTone: 'ok' as const }
        : { note: running ? `${running} running` : 'None running' }),
    ...(url ? { url } : {}),
  });
}
