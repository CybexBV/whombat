// Per-browser guest power state: power actions write an override that the
// detail body, the guest lists, consoles and thumbnails all read. Also the
// fleet-wide guest list (GET /guests, CONTRACT 1).

import type { FleetGuest, Guest, GuestListPage, GuestState, Platform } from '../../src/api/types.ts';
import { workloadsOf } from './catalog.ts';
import type { FixtureSet } from './data.ts';
import { applyLifecycle } from './lifecycle.ts';
import type { BrowserState, FixtureStore } from './state.ts';

export const guestKey = (server: string, guestId: string): string => `${server}|${guestId}`;

/** The guest's state after this browser's power actions. */
export function guestState(st: BrowserState, server: string, g: Guest): GuestState {
  return st.guestOverrides.get(guestKey(server, g.id))?.state ?? g.state;
}

/** Screen size of a guest that was started in this browser (the fixture has null while stopped). */
export function defaultResolution(g: Guest): string {
  const p = g.console.protocols ?? [];
  if (!p.some((x) => x === 'vnc' || x === 'spice' || x === 'serial')) return '132x36';
  if (/windows|win11|win-/i.test(`${g.image} ${g.name}`)) return '1920x1080';
  if (g.platform === 'incus') return '1280x800';
  return '1024x768';
}

const isWindows = (g: Guest): boolean => /windows/i.test(g.image) || /^win/i.test(g.name);

/** Rewrite one guest object for an override (live numbers null while stopped). */
function apply(g: Guest, state: GuestState, uptimeS: number): void {
  g.state = state;
  if (state === 'stopped') {
    g.cpu_pct = null;
    g.memory_used_mb = null;
    g.uptime_s = null;
    if ('disk_read_mbs' in g) g.disk_read_mbs = null;
    if ('disk_write_mbs' in g) g.disk_write_mbs = null;
    if ('net_rx_mbps' in g) g.net_rx_mbps = null;
    if ('net_tx_mbps' in g) g.net_tx_mbps = null;
    if (g.console.available) g.console.resolution = null;
    return;
  }
  g.uptime_s = uptimeS;
  g.cpu_pct ??= isWindows(g) ? 18.4 : 3.2;
  g.memory_used_mb ??= g.memory_limit_mb ? Math.round(g.memory_limit_mb * 0.31) : 512;
  if ('disk_read_mbs' in g) g.disk_read_mbs ??= 0.4;
  if ('disk_write_mbs' in g) g.disk_write_mbs ??= 0.2;
  if ('net_rx_mbps' in g) g.net_rx_mbps ??= 0.1;
  if ('net_tx_mbps' in g) g.net_tx_mbps ??= 0.1;
  if (g.console.available) g.console.resolution ??= defaultResolution(g);
}

/**
 * Apply this browser's overrides to the detail fixtures in place (loadFixtures
 * returns fresh copies) and keep each platform's running counts consistent.
 * Guests created, deleted or tagged through the manage endpoints first.
 */
export function applyGuestOverrides(store: FixtureStore, st: BrowserState, fx: FixtureSet): void {
  applyLifecycle(st, fx);
  if (!st.guestOverrides.size) return;
  for (const server of ['basalt', 'shale']) {
    for (const w of workloadsOf(fx, server)) {
      for (const g of w.guests) {
        const o = st.guestOverrides.get(guestKey(server, g.id));
        if (!o) continue;
        const was = g.state !== 'stopped' ? 1 : 0;
        apply(g, o.state, Math.max(0, Math.floor((store.now() - o.sinceReal) / 1000)));
        const delta = (o.state !== 'stopped' ? 1 : 0) - was;
        if (!delta) continue;
        w.running += delta;
        if (g.platform === 'incus' && g.kind === 'container' && w.containers !== undefined) w.containers += delta;
        if (g.platform === 'incus' && g.kind === 'vm' && w.vms !== undefined) w.vms += delta;
      }
    }
  }
}

export interface ListParams {
  q: string | null;
  state: string | null;
  platform: string | null;
  kind: string | null;
  server: string | null;
  /** Proxmox tag, case-insensitive exact. */
  tag?: string | null;
  sort: string | null;
  limit: string | null;
  cursor: string | null;
}

const PLATFORMS: Platform[] = ['docker', 'incus', 'libvirt', 'pve'];

/** 400 reason for an invalid filter, or null. */
export function listParamError(p: ListParams): { code: string; detail: string } | null {
  if (p.state && !['running', 'stopped', 'unhealthy'].includes(p.state)) return { code: 'invalid_state', detail: 'state must be running, stopped or unhealthy.' };
  if (p.platform && !(PLATFORMS as string[]).includes(p.platform)) return { code: 'invalid_platform', detail: 'platform must be docker, incus, libvirt or pve.' };
  if (p.kind && p.kind !== 'vm' && p.kind !== 'container') return { code: 'invalid_kind', detail: 'kind must be vm or container.' };
  return null;
}

/**
 * GET /guests (CONTRACT 1): guests of the servers this browser still has,
 * ranked like the hub when `q` is set (exact name, name prefix, name, then
 * id or image), then by the sort key (running first by CPU, stopped last).
 * `counts`, `platforms` and `tags` cover the guests matching `q` and
 * `server`, before the state / platform / kind / tag filters.
 */
export function listGuests(store: FixtureStore, st: BrowserState, fx: FixtureSet, p: ListParams): GuestListPage {
  applyGuestOverrides(store, st, fx);
  const needle = (p.q ?? '').trim().toLowerCase();
  const rows: { g: FleetGuest; rank: number }[] = [];
  for (const rec of st.servers) {
    if (p.server && rec.id !== p.server) continue;
    for (const w of workloadsOf(fx, rec.id)) {
      for (const g of w.guests) {
        let rank = 0;
        if (needle) {
          const name = g.name.toLowerCase();
          rank = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : `${g.id} ${g.image}`.toLowerCase().includes(needle) ? 3 : -1;
          if (rank < 0) continue;
        }
        rows.push({ g: { ...g, state: guestState(st, rec.id, g), server: rec.id, server_online: rec.status !== 'offline' }, rank });
      }
    }
  }
  const counts = { all: rows.length, running: 0, stopped: 0, unhealthy: 0 };
  const platforms: Partial<Record<Platform, number>> = {};
  const tags: Record<string, number> = {};
  for (const { g } of rows) {
    counts[g.state === 'paused' ? 'stopped' : g.state]++; // the hub counts paused as stopped
    platforms[g.platform] = (platforms[g.platform] ?? 0) + 1;
    for (const tag of g.tags ?? []) tags[tag] = (tags[tag] ?? 0) + 1;
  }
  const tag = (p.tag ?? '').trim().toLowerCase();
  let list = rows.filter(
    ({ g }) => (!p.state || g.state === p.state) && (!p.platform || g.platform === p.platform) && (!p.kind || g.kind === p.kind) && (!tag || (g.tags ?? []).some((x) => x.toLowerCase() === tag)),
  );

  let key = p.sort ?? 'cpu';
  let desc = key === 'cpu' || key === 'memory';
  if (key.startsWith('-') || key.startsWith('+')) {
    desc = key.startsWith('-');
    key = key.slice(1);
  }
  const live = (g: FleetGuest) => g.state !== 'stopped';
  const val = (g: FleetGuest) => (key === 'memory' ? (g.memory_used_mb ?? -1) : (g.cpu_pct ?? -1));
  const byName = (a: FleetGuest, b: FleetGuest) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.server.localeCompare(b.server);
  list.sort((x, y) => {
    if (x.rank !== y.rank) return x.rank - y.rank;
    const a = x.g;
    const b = y.g;
    switch (key) {
      case 'name':
        return desc ? -byName(a, b) : byName(a, b);
      case 'server':
        return (desc ? b.server.localeCompare(a.server) : a.server.localeCompare(b.server)) || byName(a, b);
      case 'state':
        return (desc ? b.state.localeCompare(a.state) : a.state.localeCompare(b.state)) || byName(a, b);
      default: {
        if (live(a) !== live(b)) return live(a) ? -1 : 1;
        const d = desc ? val(b) - val(a) : val(a) - val(b);
        return d || byName(a, b);
      }
    }
  });

  const total = list.length;
  let limit = Number.parseInt(p.limit ?? '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 500);
  let off = 0;
  if (p.cursor) {
    const n = Number.parseInt(Buffer.from(p.cursor, 'base64url').toString(), 10);
    off = Number.isFinite(n) && n >= 0 && n <= total ? n : total;
  }
  const end = Math.min(off + limit, total);
  list = list.slice(off, end);
  return {
    guests: list.map((r) => r.g),
    total,
    next_cursor: end < total ? Buffer.from(String(end)).toString('base64url') : null,
    counts,
    platforms,
    tags,
  };
}
