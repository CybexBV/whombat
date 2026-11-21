/**
 * The Guests list's rules (Whombat connections-page.md CN-08; app connections-page.md AP-2540…; mock `#guests-web`):
 * running guests first by name A–Z, stopped ones last whatever the sort; a column head sorts by it and again reverses
 * it; the line under a name (“VM 5911”, “CT 129 · Stopped”, or a change waiting for a restart); memory as “8.1 of 8 GB”
 * with its share, amber from 90 %. Pure, so it is unit-tested.
 */
import { DASH, formatPct1, formatUptimeShort, GUEST_STATE_WORDS, guestNote } from '@whombat/client/hosts';
import type { HostGuest } from '@whombat/core/domain';

const NBSP = '\u00a0';

export type GuestSortKey = 'name' | 'cpu' | 'memory' | 'up';
export type GuestSortDir = 'asc' | 'desc';
export interface GuestSort {
  key: GuestSortKey;
  dir: GuestSortDir;
}

/** By name A–Z (the mock's “Sorted by name”). */
export const GUEST_SORT_DEFAULT: GuestSort = { key: 'name', dir: 'asc' };

/** The column's word in “Sorted by <b>name</b>”. */
export const GUEST_SORT_WORDS: Record<GuestSortKey, string> = {
  name: 'name',
  cpu: 'CPU',
  memory: 'memory',
  up: 'uptime',
};

/** A head clicked: the same column reverses; another starts A–Z for the name, the biggest first for a number. */
export function nextGuestSort(current: GuestSort, key: GuestSortKey): GuestSort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'name' ? 'asc' : 'desc' };
}

/** Whether a guest's figures are live (a stopped or paused one shows dashes, as `guestRow`). */
export function guestOn(g: Pick<HostGuest, 'state'>): boolean {
  return g.state === 'running' || g.state === 'unhealthy';
}

const byName = (a: Pick<HostGuest, 'name'>, b: Pick<HostGuest, 'name'>) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name);

function figure(g: HostGuest, key: Exclude<GuestSortKey, 'name'>): number | null {
  if (!guestOn(g)) return null;
  const v = key === 'cpu' ? g.cpuPct : key === 'memory' ? g.memoryUsedMb : g.uptimeS;
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * The guests in the list's order: stopped ones last (by name), the rest by the column, ties by name; a guest without
 * the figure goes after those with one.
 */
export function sortGuests<G extends HostGuest>(guests: readonly G[], sort: GuestSort): G[] {
  const flip = sort.dir === 'asc' ? 1 : -1;
  return [...guests].sort((a, b) => {
    const sa = a.state === 'stopped' ? 1 : 0;
    const sb = b.state === 'stopped' ? 1 : 0;
    if (sa !== sb) return sa - sb;
    if (sa) return byName(a, b);
    if (sort.key === 'name') return flip * byName(a, b);
    const fa = figure(a, sort.key);
    const fb = figure(b, sort.key);
    if (fa === null || fb === null) return (fa === null ? 1 : 0) - (fb === null ? 1 : 0) || byName(a, b);
    return flip * (fa - fb) || byName(a, b);
  });
}

/** The short kind under a name: Proxmox's “VM 5911”, “CT 129”; Incus's and libvirt's “VM”, “CT”; Docker's “Docker”. */
export function guestKindShort(g: Pick<HostGuest, 'platform' | 'kind' | 'vmid'>): string {
  if (g.platform === 'docker') return 'Docker';
  const kind = g.kind === 'vm' ? 'VM' : 'CT';
  return g.platform === 'pve' && g.vmid != null ? `${kind} ${g.vmid}` : kind;
}

/** The line under a name: a change waiting (amber), else the kind, an Incus project and a stopped or paused state. */
export function guestSubline(g: HostGuest): { text: string; note: boolean } {
  const note = guestNote(g);
  if ('text' in note) return { text: note.text.charAt(0).toUpperCase() + note.text.slice(1), note: true };
  const parts = [guestKindShort(g)];
  if (g.platform === 'incus' && g.project && g.project !== 'default') parts.push(g.project);
  if (g.state === 'stopped' || g.state === 'paused') parts.push(GUEST_STATE_WORDS[g.state]);
  return { text: parts.join(' · '), note: false };
}

function trim(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** MB as the mock writes it: under 1 GB in MB (“195”), else GB with one decimal at most (“8.1”, “8”). */
function memNumber(mb: number): { n: string; unit: 'MB' | 'GB' } {
  if (mb < 1024) return { n: String(Math.round(mb)), unit: 'MB' };
  return { n: trim((mb / 1024).toFixed(1)), unit: 'GB' };
}

export interface GuestMemoryView {
  /** “8.1”, “195”. */
  value: string;
  /** “of 8 GB”, “MB of 1 GB”, “GB” (no limit). */
  rest: string;
  /** Used of the limit, 0…1; null without one. */
  share: number | null;
  /** From 90 % of the limit (CN-08). */
  warn: boolean;
}

/** The share of its limit from which a guest's memory is amber. */
export const GUEST_MEMORY_WARN = 0.9;

/** A running guest's memory (“8.1 of 8 GB”, “195 MB of 1 GB”, “41 of 512 MB”); null while it has none to show. */
export function guestMemory(
  g: Pick<HostGuest, 'state' | 'memoryUsedMb' | 'memoryLimitMb'>,
): GuestMemoryView | null {
  const used = g.memoryUsedMb;
  if (!guestOn(g) || used == null || !Number.isFinite(used)) return null;
  const u = memNumber(used);
  const limit = g.memoryLimitMb;
  if (limit == null || !Number.isFinite(limit) || limit <= 0)
    return { value: u.n, rest: u.unit, share: null, warn: false };
  const l = memNumber(limit);
  const share = Math.max(0, used / limit);
  return {
    value: u.n,
    rest: u.unit === l.unit ? `of ${l.n}${NBSP}${l.unit}` : `${u.unit} of ${l.n}${NBSP}${l.unit}`,
    share,
    warn: share >= GUEST_MEMORY_WARN,
  };
}

/** A running guest's CPU (“4.9 %”) and its share for the bar (0…1); null when stopped or unread. */
export function guestCpu(g: Pick<HostGuest, 'state' | 'cpuPct'>): { text: string; share: number } | null {
  if (!guestOn(g) || g.cpuPct == null || !Number.isFinite(g.cpuPct)) return null;
  return { text: formatPct1(g.cpuPct), share: Math.max(0, Math.min(1, g.cpuPct / 100)) };
}

/** How long it has been up, short (“55 d”, “52 min”); a dash when stopped. */
export function guestUp(g: Pick<HostGuest, 'state' | 'uptimeS'>): string {
  return guestOn(g) && g.uptimeS != null ? formatUptimeShort(g.uptimeS) : DASH;
}
