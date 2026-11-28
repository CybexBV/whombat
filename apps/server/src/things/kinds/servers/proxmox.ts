/**
 * Proxmox VE's page. When Whombat watches the server the connection reaches, the page is that server from what Whombat
 * already knows (`watched.ts`), with no call to Proxmox. Otherwise it reads Proxmox's own API as the connection: every
 * VM, container, node and storage in one call (`GET /api2/json/cluster/resources`, kept 30 seconds), its version
 * (`GET /api2/json/version`, 5 minutes) and the guests no backup job covers (`GET
 * /api2/json/cluster/backup-info/not-backed-up`, Sys.Audit, 10 minutes, the page only). Live is its guests now,
 * Inventory what is in it, the machine its one node's own figures. Read only: Proxmox's buttons stay in Proxmox.
 */
import type { ThingLine, ThingPageBar, ThingPageItem } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { MachineNow } from '../../machine';
import { shortHash } from '../../quiet/items';
import type { KindCheck } from '../../quiet/types';
import { clip, line, list, num, plural, rec, span, str, thousands } from '../../words';
import { cachedRead, getJson, KIND_DEADLINE_MS, latestRead, problemOf, withDeadline } from '../read';
import type { KindModule, KindSeen } from '../registry';
import { inventory, slotPanels } from '../slots';
import {
  fixed,
  fullness,
  itemLines,
  type KindNotice,
  lookInto,
  newer,
  UNTIL,
  worstOf,
} from '../storage/lines';
import { cardOf, seenOf, serviceUrl, statusOf, unreadView, usedOf, worstFirst } from '../storage/shared';
import type { KindCtx, KindView } from '../types';
import { type GuestNow, guestCountLine, guestsLive, isOn } from './guests';
import { drawsServer, readWatched, storageLine, watchedServerId, watchedView } from './watched';

const NAME = 'Proxmox VE';
const VERSION_KEEP_MS = 5 * 60_000;
const BACKUPS_KEEP_MS = 10 * 60_000;
const GIB = 1024 ** 3;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface PveGuest extends GuestNow {
  vmid: number;
  node: string | null;
}

export interface PveNode {
  name: string;
  online: boolean;
  cpuPct: number | null;
  cores: number | null;
  memUsed: number | null;
  memTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  uptimeS: number | null;
}

export interface PveStorage {
  id: string;
  node: string | null;
  type: string | null;
  used: number;
  total: number;
  shared: boolean;
}

export interface PveSnapshot {
  readAt: Date;
  version: string | null;
  nodes: PveNode[];
  guests: PveGuest[];
  storages: PveStorage[];
}

const flag = (v: unknown) => v === true || v === 1 || v === '1';

/** `GET /api2/json/cluster/resources`: `{ data: [{ id, type, node, status, … }] }` (the API viewer's schema). */
export function parseResources(body: unknown, readAt: Date, version: string | null = null): PveSnapshot {
  const items = list(rec(body).data).map(rec);
  const nodes: PveNode[] = [];
  const guests: PveGuest[] = [];
  const storages = new Map<string, PveStorage>();
  for (const r of items) {
    const type = str(r.type);
    const node = str(r.node);
    if (type === 'node' && node) {
      const cpu = num(r.cpu);
      nodes.push({
        name: node,
        online: str(r.status) === 'online',
        cpuPct: cpu !== null ? cpu * 100 : null,
        cores: num(r.maxcpu),
        memUsed: num(r.mem),
        memTotal: num(r.maxmem),
        diskUsed: num(r.disk),
        diskTotal: num(r.maxdisk),
        uptimeS: num(r.uptime),
      });
    } else if ((type === 'qemu' || type === 'lxc') && !flag(r.template)) {
      const vmid = num(r.vmid);
      if (vmid === null) continue;
      const status = str(r.status);
      const cpu = num(r.cpu);
      const kind = type === 'qemu' ? 'vm' : 'container';
      guests.push({
        id: `${type}/${vmid}`,
        vmid,
        name: str(r.name) ?? `${kind === 'vm' ? 'VM' : 'CT'} ${vmid}`,
        kind,
        state: status === 'running' ? 'running' : status === 'paused' ? 'paused' : 'stopped',
        cpuPct: cpu !== null ? cpu * 100 : null,
        memUsedBytes: num(r.mem),
        memLimitBytes: num(r.maxmem),
        uptimeS: num(r.uptime),
        node,
      });
    } else if (type === 'storage') {
      const id = str(r.storage);
      const used = num(r.disk);
      const total = num(r.maxdisk);
      if (!id || used === null || !total || str(r.status) !== 'available') continue;
      const shared = flag(r.shared);
      // A shared storage is listed once per node: the same space.
      const key = shared ? id : `${id}@${node ?? ''}`;
      if (!storages.has(key)) storages.set(key, { id, node, type: str(r.plugintype), used, total, shared });
    }
  }
  // The node a guest is on is worth saying only in a cluster.
  if (nodes.length > 1) for (const g of guests) g.detail = g.node;
  return { readAt, version, nodes, guests, storages: [...storages.values()] };
}

/** `GET /api2/json/version`'s `data.version` (“9.0.10”). */
export const versionOf = (body: unknown): string | null => str(rec(rec(body).data).version);

/** `GET /api2/json/cluster/backup-info/not-backed-up`'s guests (`vmid`, `name`, `type`). */
export function parseNotBackedUp(body: unknown): { vmid: number; name: string | null }[] {
  return list(rec(body).data)
    .map(rec)
    .flatMap((g) => {
      const vmid = num(g.vmid);
      return vmid === null ? [] : [{ vmid, name: str(g.name) }];
    });
}

function read(services: Services, row: CatalogConnectionRow, now: Date) {
  return async (): Promise<PveSnapshot> => {
    try {
      return await withDeadline(
        (async () => {
          const [body, version] = await Promise.all([
            getJson(services, row, NAME, '/api2/json/cluster/resources'),
            cachedRead(
              services,
              `proxmox-version:${row.id}`,
              row,
              async () => versionOf(await getJson(services, row, NAME, '/api2/json/version')),
              VERSION_KEEP_MS,
            ).catch(() => null),
          ]);
          return parseResources(body, now, version);
        })(),
        KIND_DEADLINE_MS,
        `${NAME} didn’t answer in time.`,
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

/** Guests no backup job covers, or null when the token may not read it (it needs Sys.Audit) or it failed. */
function notBackedUp(services: Services, row: CatalogConnectionRow) {
  return cachedRead(
    services,
    `proxmox-backups:${row.id}`,
    row,
    async () =>
      parseNotBackedUp(await getJson(services, row, NAME, '/api2/json/cluster/backup-info/not-backed-up')),
    BACKUPS_KEEP_MS,
  ).catch(() => null);
}

/* Checks and lines --------------------------------------------------------------------------------------------------- */

export const PROXMOX_CHECKS: readonly KindCheck[] = [
  {
    check: 'proxmox.node_offline',
    name: 'Nodes going offline',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'proxmox.storage_full',
    name: 'Storage filling up',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  // Leaving a test VM out of the backups is often on purpose.
  {
    check: 'proxmox.no_backup_job',
    name: 'Guests in no backup job',
    nature: 'you',
    perItem: false,
    startsOn: false,
  },
];

export interface ProxmoxInput {
  snapshot: PveSnapshot;
  url: string;
  /** Guests in no backup job; null when not read. */
  outside?: { vmid: number; name: string | null }[] | null;
}

export function proxmoxNotices(input: ProxmoxInput): KindNotice[] {
  const { snapshot: s } = input;
  const out: KindNotice[] = [];
  const many = s.nodes.length > 1;
  const offline = s.nodes.filter((n) => !n.online).sort((a, b) => a.name.localeCompare(b.name));
  out.push(
    ...itemLines(
      offline,
      (n) => ({
        id: clip(`node-${n.name}`, 120),
        tone: 'bad',
        icon: 'power',
        title: clip(`${n.name} is offline`, 120),
        detail: 'Its VMs and containers aren’t running. Check its power and network.',
        link: lookInto(`Proxmox node ${n.name} is offline. What can I check?`),
        nature: 'problem',
        check: 'proxmox.node_offline',
        subject: { id: clip(`node:${n.name}`, 160), name: clip(n.name, 80) },
        ignore: fixed(UNTIL.back),
        badge: clip(`${n.name} offline`, 40),
      }),
      (n) => n.name,
      (rest) => ({
        id: 'node-more',
        tone: 'bad',
        icon: 'power',
        title: `${plural(rest.length, 'more node')} offline`,
        nature: 'problem',
        check: 'proxmox.node_offline',
      }),
    ),
  );
  const full = s.storages
    .map((st) => ({ st, p: (st.used / st.total) * 100 }))
    .map((x) => ({ ...x, f: fullness(x.p, x.st.total - x.st.used) }))
    .filter((x): x is typeof x & { f: NonNullable<typeof x.f> } => x.f !== null)
    .sort((a, b) => b.p - a.p);
  const fullLines = full.map(({ st, p, f }): KindNotice => {
    const where = many && !st.shared && st.node ? `${st.id} on ${st.node}` : st.id;
    return {
      id: clip(`full-${st.node ?? ''}-${st.id}`, 120),
      tone: f.tone,
      icon: 'disk',
      title: clip(`${where} is ${Math.round(p)} % full`, 120),
      detail: `${usedOf(st.used, st.total)} used. VMs on a full storage stop writing.`,
      ...(f.nature === 'problem' ? { link: lookInto(`What takes the space on ${where} in Proxmox?`) } : {}),
      nature: f.nature,
      check: 'proxmox.storage_full',
      subject: { id: clip(`storage:${st.node ?? ''}/${st.id}`, 160), name: clip(where, 80) },
      band: f.band,
      ignore: fixed(UNTIL.fuller),
      badge: clip(`${where} ${Math.round(p)} % full`, 40),
    };
  });
  out.push(
    ...itemLines(
      fullLines,
      (l) => l,
      (l) => l.id,
      (rest) => ({
        id: 'full-more',
        ...worstOf(rest),
        icon: 'disk',
        title: `${plural(rest.length, 'more storage')} filling up`,
        check: 'proxmox.storage_full',
      }),
    ),
  );
  const known = new Map(s.guests.map((g) => [g.vmid, g]));
  const outside = (input.outside ?? []).filter((g) => known.has(g.vmid));
  if (outside.length) {
    const names = outside.map((g) => known.get(g.vmid)?.name ?? g.name ?? String(g.vmid));
    out.push({
      id: 'no-backup-job',
      tone: 'warn',
      icon: 'backup',
      title: clip(
        outside.length === 1
          ? `${names[0]} is in no backup job`
          : `${outside.length} guests are in no backup job`,
        120,
      ),
      detail: clip(
        `${names.slice(0, 6).join(', ')}${names.length > 6 ? ' and more' : ''}. Proxmox doesn’t back them up.`,
        200,
      ),
      nature: 'you',
      check: 'proxmox.no_backup_job',
      episode: shortHash(outside.map((g) => String(g.vmid))),
      ignore: newer(UNTIL.others),
    });
  }
  return worstFirst(out);
}

/** What it skipped this pass: the backup jobs are read only on the page. */
export const proxmoxSkipped = (input: ProxmoxInput): string[] =>
  input.outside == null ? ['proxmox.no_backup_job'] : [];

/* View --------------------------------------------------------------------------------------------------------------- */

/** One node: its own figures make “The machine” (no link: Whombat doesn't watch it). */
export function nodeNow(s: PveSnapshot): { figures: MachineNow; name: string } | null {
  const n = s.nodes.length === 1 ? s.nodes[0] : undefined;
  if (!n?.online) return null;
  return {
    name: n.name,
    figures: {
      cpuPct: n.cpuPct,
      cores: n.cores,
      memoryUsedGb: n.memUsed !== null ? n.memUsed / GIB : null,
      memoryTotalGb: n.memTotal ? n.memTotal / GIB : null,
      diskUsedGb: n.diskUsed !== null ? n.diskUsed / 1e9 : null,
      diskTotalGb: n.diskTotal ? n.diskTotal / 1e9 : null,
      series: null,
    },
  };
}

export function proxmoxMachineLines(s: PveSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version) out.push({ id: 'pve-version', label: 'Proxmox VE', value: clip(s.version, 40), pct: null });
  const n = s.nodes.length === 1 ? s.nodes[0] : undefined;
  if (n?.uptimeS) out.push({ id: 'up', label: 'Up', value: span(n.uptimeS * 1000), pct: null });
  return out;
}

/** In Proxmox (Inventory): VMs, containers, the fullest storages, its nodes in a cluster, the backup jobs. */
export function proxmoxInventory(input: ProxmoxInput) {
  const { snapshot: s, url } = input;
  const many = s.nodes.length > 1;
  const items: ThingPageItem[] = [
    guestCountLine(s.guests, 'vm', url),
    guestCountLine(s.guests, 'container', url),
  ].filter((l): l is ThingPageItem => !!l);
  for (const st of [...s.storages].sort((a, b) => b.used / b.total - a.used / a.total).slice(0, 2))
    items.push(
      storageLine({
        id: clip(`storage-${st.node ?? ''}-${st.id}`, 200),
        title: many && !st.shared && st.node ? `${st.id} · ${st.node}` : st.id,
        used: st.used,
        total: st.total,
        note: st.type,
      }),
    );
  if (many) {
    const off = s.nodes.filter((n) => !n.online).length;
    items.push({
      id: 'nodes',
      title: 'Nodes',
      icon: 'network',
      right: thousands(s.nodes.length),
      figure: {
        value: thousands(s.nodes.length),
        ...(off
          ? { note: `${off} offline`, tone: 'bad' as const }
          : { note: 'All online', tone: 'ok' as const }),
      },
      ...(off ? { tone: 'bad' as const } : {}),
    });
  }
  if (input.outside) {
    const known = new Set(s.guests.map((g) => g.vmid));
    const missing = input.outside.filter((g) => known.has(g.vmid)).length;
    items.push({
      id: 'backup-jobs',
      title: 'In a backup job',
      icon: 'backup',
      right: thousands(s.guests.length - missing),
      figure: {
        value: thousands(s.guests.length - missing),
        ...(missing
          ? { note: `${missing} left out`, tone: 'warn' as const }
          : { note: 'Every guest', tone: 'ok' as const }),
      },
    });
  }
  return items.length ? inventory({ id: 'inventory', title: 'In Proxmox', items }) : null;
}

export function proxmoxVerdict(s: PveSnapshot): string {
  const running = s.guests.filter(isOn).length;
  if (!s.guests.length) return 'Proxmox VE is fine: nothing runs on it yet.';
  return `Proxmox VE is fine: ${running} of ${plural(s.guests.length, 'guest')} running.`;
}

/** The page's part when Whombat reads Proxmox itself; pure. */
export function proxmoxView(input: ProxmoxInput): KindView {
  const { snapshot: s, url } = input;
  const slotted = slotPanels({
    live: guestsLive(s.guests),
    inventory: proxmoxInventory(input),
    machine: proxmoxMachineLines(s),
  });
  const own = nodeNow(s);
  const notices = proxmoxNotices(input);
  const running = s.guests.filter(isOn).length;
  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`Proxmox VE **${s.version}**`));
  if (s.nodes.length > 1) facts.push(line(`**${s.nodes.length}** nodes`));
  else if (s.nodes[0]) facts.push(line(`Node **${clip(s.nodes[0].name, 60)}**`));
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices,
    panels: slotted.panels,
    slots: { machine: slotted.slots?.machine ?? [], ...(own ? { own } : {}) },
    tabs: [],
    facts,
    status: statusOf(
      notices,
      s.guests.length ? `${running} of ${plural(s.guests.length, 'guest')} running` : 'Running fine',
    ),
    open: { label: 'Open Proxmox', url },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Busiest guests this week', 'Storage filling up', 'Guests without a backup'],
    verdict: proxmoxVerdict(s),
  };
}

/* Page and seen ------------------------------------------------------------------------------------------------------ */

export function proxmoxLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `proxmox:${row.id}`, row, read(services, row, now));
}

export async function proxmoxPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const serverId = await watchedServerId(services, ctx.burrowId, row);
  if (serverId) {
    const w = await readWatched(services, row, serverId, now);
    if (w.ok)
      return {
        ...watchedView({ server: w.value, now, timeZone: ctx.timeZone, linked: drawsServer(ctx, serverId) }),
        open: { label: 'Open Proxmox', url: serviceUrl(row) },
        refreshing: w.refreshing,
      };
  }
  const url = serviceUrl(row);
  const [got, outside] = await Promise.all([proxmoxLatest(services, row, now), notBackedUp(services, row)]);
  if (!got.ok) return unreadView(NAME, url, problemOf(got.error, NAME).message, got.refreshing);
  return { ...proxmoxView({ snapshot: got.value, url, outside }), refreshing: got.refreshing };
}

export async function proxmoxSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<KindSeen> {
  // Whombat watches the server: its page raises what is wrong, and Proxmox isn't asked.
  const serverId = await watchedServerId(services, row.burrowId, row, { wait: false });
  if (serverId)
    return {
      ...seenOf({ facts: [], line: clip(`Part of ${serverId}`, 80) }),
      skipped: PROXMOX_CHECKS.map((c) => c.check),
    };
  const s = await cachedRead(services, `proxmox:${row.id}`, row, read(services, row, now));
  const input = { snapshot: s, url: serviceUrl(row), outside: null };
  const notices = proxmoxNotices(input);
  const running = s.guests.filter(isOn).length;
  const seen = seenOf(
    cardOf(
      {
        kpis: [
          { key: 'guests', label: 'Guests running', value: `${running} of ${s.guests.length}` },
          ...(s.nodes.length > 1
            ? [
                {
                  key: 'nodes',
                  label: 'Nodes online',
                  value: `${s.nodes.filter((n) => n.online).length} of ${s.nodes.length}`,
                },
              ]
            : []),
        ],
        notices,
      },
      ['guests', 'nodes'],
      s.version ? `Proxmox VE ${s.version}` : NAME,
    ),
    notices,
    proxmoxSkipped(input),
  );
  return { ...seen, tracked: { version: s.version ?? null } };
}

export const PROXMOX_KIND: KindModule = {
  page: proxmoxPage,
  seen: proxmoxSeen,
  checks: PROXMOX_CHECKS,
};
