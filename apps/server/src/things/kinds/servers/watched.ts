/**
 * A Proxmox VE or Unraid connection whose server Whombat watches: its page shows that server from what the hosts
 * service already knows of it (the fleet's card, the server's detail and its guests, as the server's own page reads
 * them), with no call to the service's API. Live is its guests now; Inventory what is on it (VMs, containers, storage,
 * backups, the array); the machine card is the server, linked. Worth a look stays on the server's page, which raises
 * those alerts already. Reading is here; the view is pure (`watchedView`).
 */
import type {
  HostGuest,
  HostServer,
  HostServerDetail,
  ThingGalleryItem,
  ThingLine,
  ThingPageBar,
  ThingPageItem,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { HOSTS_API, seg } from '../../../hosts/client';
import { arr, guestsOfDetail, obj, toHostGuest, toHostServer, toHostServerDetail } from '../../../hosts/map';
import { hostsFor, WHOMBAT_ACTOR } from '../../../hosts/service';
import type { Services } from '../../../services';
import type { MachineNow } from '../../machine';
import { partOfServer, within } from '../../part-of';
import { guestLabel, machineHref, serverFigures } from '../../runs-on';
import type { RawPoint } from '../../series';
import { clip, line, plural, span, thousands } from '../../words';
import { type Latest, latestRead, problemOf, withDeadline } from '../read';
import { countLine, inventory, slotPanels } from '../slots';
import { spaceWeek } from '../storage/nas';
import { ago, fullTone, usedOf } from '../storage/shared';
import type { KindCtx, KindView } from '../types';
import { type GuestNow, guestCountLine, guestsLive, isOn } from './guests';

const MIB = 1024 ** 2;
const GB = 1e9;
/** The hosts service answers on the LAN: a server that doesn't within this is shown from the API instead. */
const HOSTS_WAIT_MS = 8_000;
/** Storage lines in Inventory: the fullest ones. */
const STORAGE_LINES = 2;

/** What Whombat knows of the server a connection reaches. */
export interface WatchedServer {
  id: string;
  /** As people call it (the name they gave it, else its id). */
  name: string;
  href: string;
  row: HostServer;
  detail: HostServerDetail;
  guests: HostGuest[];
  readAt: Date;
}

/** The id of the server Whombat watches that a Proxmox or Unraid connection reaches, or null. */
export async function watchedServerId(
  services: Services,
  burrowId: string,
  row: Parameters<typeof partOfServer>[2],
  options: { wait?: boolean } = {},
): Promise<string | null> {
  const thing = await within(partOfServer(services, burrowId, row, options), 5_000, null);
  return thing?.startsWith('server:') ? thing.slice('server:'.length) : null;
}

/** The server as the hosts service answers it (as Whombat, a viewer): its card, its detail, its guests. */
async function loadWatched(services: Services, serverId: string, now: Date): Promise<WatchedServer> {
  const hosts = hostsFor(services);
  const [fleet, raw, guests] = await Promise.all([
    hosts.fleetRaw(),
    hosts.call<unknown>({
      path: `${HOSTS_API}/servers/${seg(serverId)}`,
      actor: WHOMBAT_ACTOR,
      timeoutMs: HOSTS_WAIT_MS,
    }),
    hosts.guestsRaw(serverId).catch(() => null),
  ]);
  const card = arr(fleet.servers).find((s) => obj(s).id === serverId);
  if (!card) throw new Error('server gone');
  const row = toHostServer(card, arr(fleet.alerts));
  const detail = toHostServerDetail(raw, [], null, now);
  return {
    id: serverId,
    name: row.name || serverId,
    href: machineHref(serverId, null),
    row,
    detail,
    guests: guests ? guests.map((g) => toHostGuest(g, serverId)) : guestsOfDetail(detail),
    readAt: now,
  };
}

/** The server for a page (kept 30 seconds, the last one serving while a new one is read). */
export function readWatched(
  services: Services,
  row: CatalogConnectionRow,
  serverId: string,
  now: Date,
): Promise<Latest<WatchedServer>> {
  return latestRead(services, `server-of:${row.id}:${serverId}`, row, async () => {
    try {
      return await withDeadline(
        loadWatched(services, serverId, now),
        HOSTS_WAIT_MS,
        'The server didn’t answer.',
      );
    } catch (err) {
      throw problemOf(err, serverId);
    }
  });
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

/** A guest of the server as a Live row: opens it on the server's page. Whombat's own helpers are left out. */
export function guestsNow(w: Pick<WatchedServer, 'id' | 'guests'>): GuestNow[] {
  return w.guests
    .filter((g) => !g.labels?.['whombat.service'])
    .map((g) => ({
      id: g.id,
      name: guestLabel(g),
      kind: g.kind,
      state: g.state,
      cpuPct: g.cpuPct,
      memUsedBytes: g.memoryUsedMb !== null ? g.memoryUsedMb * MIB : null,
      memLimitBytes: g.memoryLimitMb ? g.memoryLimitMb * MIB : null,
      uptimeS: g.uptimeS,
      href: machineHref(w.id, g.id),
    }));
}

/** A Proxmox storage's kind in a word or two. */
const STORAGE_WORDS: Readonly<Record<string, string>> = {
  zfspool: 'zfs',
  zfs: 'zfs',
  dir: 'folder',
  lvm: 'lvm',
  lvmthin: 'lvm thin',
  nfs: 'nfs share',
  cifs: 'smb share',
  pbs: 'backup server',
  rbd: 'ceph',
  cephfs: 'ceph',
  btrfs: 'btrfs',
};

/** A storage line: how full, used of the total and its kind under it; `problem` overrides its colour and note. */
export function storageLine(p: {
  id: string;
  title: string;
  used: number;
  total: number;
  note?: string | null;
  problem?: string;
}) {
  const percent = (p.used / p.total) * 100;
  const tone = p.problem ? 'bad' : fullTone(percent);
  return countLine({
    id: p.id,
    title: p.title,
    icon: 'disk',
    value: `${Math.round(percent)} %`,
    detail: [usedOf(p.used, p.total), p.note].filter(Boolean).join(' · '),
    ...(p.problem ? { note: p.problem } : {}),
    ...(tone ? { tone, noteTone: tone } : {}),
  });
}

/** “14 h ago”, “3 days ago”. */
const agoWords = (at: string, now: Date) => {
  const t = new Date(at);
  return Number.isNaN(t.getTime()) ? null : ago(t, now);
};

/** A Proxmox node's Inventory lines past the guests: its fullest storages, its backups, its cluster's nodes. */
function proxmoxLines(w: WatchedServer, now: Date): ThingPageItem[] {
  const px = w.detail.proxmox;
  if (!px) return [];
  const out: ThingPageItem[] = px.storages
    .filter((s) => s.capacityGb > 0)
    .sort((a, b) => b.usedGb / b.capacityGb - a.usedGb / a.capacityGb || a.id.localeCompare(b.id))
    .slice(0, STORAGE_LINES)
    .map((s) =>
      storageLine({
        id: clip(`storage-${s.id}`, 200),
        title: s.id,
        used: s.usedGb * GB,
        total: s.capacityGb * GB,
        note: STORAGE_WORDS[s.type] ?? s.type,
      }),
    );
  const job = px.backups?.lastJob;
  const outside = w.guests.filter((g) => g.backupJob === false).length;
  if (job && job.guestsTotal > 0) {
    const failed = Math.max(0, job.guestsTotal - job.guestsOk);
    const when = agoWords(job.at, now);
    out.push(
      countLine({
        id: 'backups',
        title: 'Backed up',
        icon: 'backup',
        value: `${thousands(job.guestsOk)} of ${thousands(job.guestsTotal)}`,
        ...(when
          ? { note: when, ...(failed ? { noteTone: 'bad' as const } : { noteTone: 'ok' as const }) }
          : {}),
        ...(failed ? { tone: 'bad' as const } : {}),
        detail: [
          failed ? `${plural(failed, 'guest')} failed last time` : 'Its last backup job',
          outside ? `${outside} in no backup job` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    );
  }
  const nodes = px.cluster?.nodes ?? [];
  if (nodes.length > 1) {
    const off = nodes.filter((n) => n.status !== 'online').length;
    out.push(
      countLine({
        id: 'nodes',
        title: 'Nodes',
        icon: 'network',
        value: thousands(nodes.length),
        detail: px.cluster?.name ? `Cluster ${px.cluster.name}` : 'In its cluster',
        ...(off
          ? { note: `${off} offline`, noteTone: 'bad' as const }
          : { note: 'All online', noteTone: 'ok' as const }),
      }),
    );
  }
  return out;
}

const ARRAY_WORDS: Readonly<Record<string, string>> = {
  stopped: 'Stopped',
  starting: 'Starting',
  stopping: 'Stopping',
  invalid: 'Can’t start',
};

/** An Unraid server's Inventory lines past the guests: the array, its pools, its shares. */
function unraidLines(w: WatchedServer): ThingPageItem[] {
  const u = w.detail.unraid;
  if (!u) return [];
  const a = u.array;
  const data = a.disks.filter((d) => d.slot === 'data').length;
  const bad = a.disabled + a.invalid + a.missing;
  const out: ThingPageItem[] = [];
  if (a.state !== 'started')
    out.push(
      countLine({
        id: 'array',
        title: 'Array',
        icon: 'disk',
        tone: 'bad',
        value: ARRAY_WORDS[a.state] ?? 'Stopped',
        detail: 'Shares, Docker and VMs wait for it',
      }),
    );
  else if (a.sizeBytes > 0)
    out.push(
      storageLine({
        id: 'array',
        title: 'Array',
        used: a.usedBytes,
        total: a.sizeBytes,
        note: data ? plural(data, 'disk') : null,
        ...(bad ? { problem: bad === 1 ? '1 disk problem' : `${bad} disk problems` } : {}),
      }),
    );
  const pools = u.pools
    .filter((p) => p.sizeBytes > 0)
    .sort((x, y) => y.usedBytes / y.sizeBytes - x.usedBytes / x.sizeBytes)
    .slice(0, STORAGE_LINES);
  for (const p of pools)
    out.push(
      storageLine({
        id: `pool-${p.name}`,
        title: p.name,
        used: p.usedBytes,
        total: p.sizeBytes,
        note: [p.fsType, p.profile].filter(Boolean).join(' '),
      }),
    );
  if (u.shares.length)
    out.push(
      countLine({ id: 'shares', title: 'Shares', icon: 'network', value: thousands(u.shares.length) }),
    );
  return out;
}

/** “Proxmox VE 9”, “Unraid 7.3.1”: what the server runs, as its agent says it. */
export function systemLine(w: Pick<WatchedServer, 'detail' | 'row'>): ThingPageBar | null {
  const u = w.detail.unraid;
  if (u?.version)
    return {
      id: 'system',
      label: 'Unraid',
      value: clip(u.version, 40),
      pct: null,
      ...(u.osUpdate?.version
        ? { sub: clip(`Version ${u.osUpdate.version} is out`, 120) }
        : { sub: 'Up to date', subTone: 'ok' as const }),
    };
  const os = w.detail.server.os;
  const name = os?.name.trim() || w.row.os || '';
  if (!name) return null;
  const version = os?.version.trim() ?? '';
  return {
    id: 'system',
    label: clip(name, 80),
    ...(version && !name.includes(version) ? { value: clip(version, 40) } : {}),
    pct: null,
  };
}

/** The machine card's lines: what it runs and how long it has been up. */
function machineLines(w: WatchedServer): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  const system = systemLine(w);
  if (system) out.push(system);
  const up = w.detail.server.uptimeS;
  if (typeof up === 'number' && up > 0)
    out.push({ id: 'up', label: 'Up', value: span(up * 1000), pct: null });
  return out;
}

/** A parity check, rebuild or clear that runs now, and the mover: rows before the guests. */
export function arrayWorkRows(w: Pick<WatchedServer, 'detail'>): ThingGalleryItem[] {
  const a = w.detail.unraid?.array;
  if (!a) return [];
  const out: ThingGalleryItem[] = [];
  const p = a.parity;
  if (p.state !== 'idle')
    out.push(
      parityRow({
        action: p.action,
        pct: p.pct,
        etaS: p.etaS,
        errors: p.errors,
        paused: p.state === 'paused',
      }),
    );
  if (a.moverRunning)
    out.push({
      id: 'mover',
      title: 'Mover',
      sub: 'Moving files between the pools and the array',
      note: 'Running',
    });
  return out;
}

/** The row of a parity check (or a rebuild) that runs: how far, about how long is left, errors found so far. */
export function parityRow(p: {
  action: string | null;
  pct: number | null;
  etaS: number | null;
  errors: number;
  paused: boolean;
}): ThingGalleryItem {
  const title =
    p.action === 'rebuild' ? 'Rebuilding a disk' : p.action === 'clear' ? 'Clearing a disk' : 'Parity check';
  const done = p.pct !== null ? Math.max(0, Math.min(100, p.pct)) : null;
  return {
    id: 'parity',
    title,
    sub: p.errors ? `${plural(p.errors, 'error')} found so far` : 'No errors so far',
    ...(p.errors ? { badge: { text: 'Errors', tone: 'warn' as const } } : {}),
    ...(done !== null ? { progress: done / 100, note: `${Math.round(done)} %` } : {}),
    ...(p.paused
      ? { paused: true, noteEnd: 'Paused' }
      : p.etaS && p.etaS > 0
        ? { noteEnd: `about ${span(p.etaS * 1000)} left` }
        : {}),
  };
}

/** The server's own figures for the card when the page doesn't know it as the machine the connection runs on. */
export function serverNow(w: Pick<WatchedServer, 'row'>): MachineNow {
  const f = serverFigures(w.row, null);
  return {
    cpuPct: f.cpuPct,
    cores: f.cores,
    memoryUsedGb: f.memoryUsedGb,
    memoryTotalGb: f.memoryTotalGb,
    diskUsedGb: f.diskUsedGb,
    diskTotalGb: f.diskTotalGb,
    series: null,
  };
}

export interface WatchedInput {
  server: WatchedServer;
  now: Date;
  timeZone: string;
  /** The page draws the server as the machine card, linked: no second “See” link. */
  linked: boolean;
  /** Whombat's own readings of the array's used space (Unraid), for Space used. */
  space?: readonly RawPoint[];
}

/** The page's part for a connection whose server Whombat watches; pure. */
export function watchedView(input: WatchedInput): KindView {
  const { server: w, now, linked } = input;
  const guests = guestsNow(w);
  const see = { kind: 'href' as const, label: clip(`See ${w.name}`, 30), href: w.href };
  const lines = [
    guestCountLine(guests, 'vm'),
    guestCountLine(guests, 'container'),
    ...proxmoxLines(w, now),
    ...unraidLines(w),
  ].filter((l): l is ThingPageItem => !!l);
  const u = w.detail.unraid;
  const free = u ? u.array.freeBytes : null;
  const slotted = slotPanels({
    live: guestsLive(guests, { lead: arrayWorkRows(w) }),
    inventory: lines.length
      ? inventory({
          id: 'inventory',
          title: clip(`On ${w.name}`, 60),
          items: lines,
          ...(linked ? {} : { link: see }),
        })
      : null,
    trend:
      u && input.space
        ? spaceWeek({
            points: input.space,
            now,
            timeZone: input.timeZone,
            freeBytes: free,
            what: 'The array',
          })
        : null,
    machine: machineLines(w),
  });
  const running = guests.filter(isOn).length;
  const facts: ThingLine[] = [line(`Part of **${clip(w.name, 60)}**`)];
  const system = systemLine(w);
  if (system) facts.push(line(`${system.label}${system.value ? ` **${system.value}**` : ''}`));
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices: [],
    panels: slotted.panels,
    slots: {
      machine: slotted.slots?.machine ?? [],
      ...(linked ? {} : { own: { figures: serverNow(w), name: clip(w.name, 120) } }),
    },
    tabs: [],
    facts,
    status: {
      status: 'ok',
      badge: clip(
        guests.length ? `${running} of ${plural(guests.length, 'guest')} running` : 'Running fine',
        60,
      ),
    },
    actions: [],
    readAt: w.readAt,
    suggestions: ['Busiest guests this week', 'What takes the most space', 'Last backups'],
  };
}

/** Whether the page draws this server as its machine, linked (the connection's address is the server's). */
export function drawsServer(ctx: Pick<KindCtx, 'machine'>, serverId: string): boolean {
  return ctx.machine?.at.serverId === serverId && !ctx.machine.at.guestId && !!ctx.machine.figures;
}
