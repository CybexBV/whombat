/**
 * Servers on Home and Watch (one-whombat.md ONE-05, ONE-07; one-whombat-servers.md ONE-DH18), registered with the Home
 * registry:
 *
 * - **Needs you** `hosts`: critical alerts that ask for attention and aren't heads-ups (“Look into it” · “Remind me
 *   tomorrow”), and for the person the servers waiting to be let in.
 * - **Your things** `hosts`: one thing per server — its status, a short line and four facts (CPU, memory, hottest,
 *   guests), linking to its page. Its dot follows what asks for attention (quiet-notices.md QN-22, QN-23; QN-S51).
 * - **Watch** `hosts`: every open alert (acknowledged, snoozed, muted or held back ones say so) and every hint (ignored and
 *   snoozed ones say so, those Whombat doesn't watch are left out), heads-ups marked `fyi`: the Needs you list folds
 *   them, `watch.list` leaves them out (needs-you-list.md NYL-03). A hint
 *   links to where it is fixed (proxmox.md PX-07): the guest it names — its Backups or Snapshots tab — or the server's
 *   tab (Storage, Guests, Sensors), with the way out in a few words (“Add it to a backup job.”); “Look into it” is
 *   Watch's own. An agent whose update failed or that needs its last install is one too (agent-updates.md AU-08).
 *
 * Read from the cached fleet (5 s) and agents (30 s), so Home costs the hosts service two calls at most; a service that
 * doesn't answer leaves the sources empty (the registry logs it). Only the burrow that sees servers gets any (ONE-DH02).
 */
import {
  HOST_STATUS_LABELS,
  type HostAlert,
  type HostFleet,
  type HostHint,
  type HostServer,
  hostHintCheck,
  hostOsMark,
  type NeedsYouItem,
  type NeedsYouWatch,
  type ThingSummary,
  thingHref,
  thingId,
  UPTIME_ID,
  type WatchItem,
} from '@whombat/core';
import { and, eq, isNotNull } from 'drizzle-orm';
import { catalogConnections, principals } from '../db/schema/index';
import {
  readOnce,
  registerNeedsYouSource,
  registerSubjectResolver,
  registerThingsSource,
  registerWatchSource,
  type SourceCtx,
  type SourceReads,
} from '../home/registry';
import type { Services } from '../services';
import { addTaken } from '../things/causes';
import { type AddressChange, addressChangeOf, addressNeedsYou, agentAddresses } from './address';
import { HOSTS_API } from './client';
import { toHubInfo } from './hub';
import { arr, obj, str, toHostPendingEnrollment, ts } from './map';
import {
  alertLine,
  HEARTBEAT_RULE,
  HUB_LEVEL,
  hintGuestNames,
  hintLine,
  hintRefId,
  type ServerLine,
  serverThingId,
  verdictOf,
} from './quiet-lines';
import { fleetWasRead, knownServer, serverLabel } from './self';
import { type HostsService, hostsFor } from './service';

export { hintGuestNames };

const STATUS: Record<HostServer['status'], ThingSummary['status']> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  offline: 'offline',
  pending: 'unknown',
};

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}`);

/** A note as a reason: “disk wear” → “Disk wear”; a title that starts with a name (“nvme1n1 wear …”) stays. */
function reasonWords(note: string): string {
  const t = note.trim();
  return /^[a-z]+(\s|$)/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * A server as a thing on Home and in the sidebar, its icon what it runs (marks.md MK-01: `proxmox`, `debian`). Its dot
 * is what the fleet's row came to (QN-23): an offline server whose “offline” alert is quiet or switched off shows no
 * dot, its line still saying it is offline.
 */
export function serverThing(s: HostServer): ThingSummary {
  const verdict = verdictOf(s);
  const status = verdict && !verdict.dot && s.status === 'offline' ? 'ok' : STATUS[s.status];
  const running = s.guests.reduce((n, g) => n + g.running, 0);
  const total = s.guests.reduce((n, g) => n + g.total, 0);
  const facts: ThingSummary['facts'] = [
    { label: 'CPU', value: pct(s.cpuPct), unit: '%' },
    { label: 'Memory', value: pct(s.memory.usedPct), unit: '%' },
  ];
  if (s.temperature?.maxC !== null && s.temperature?.maxC !== undefined)
    facts.push({ label: 'Hottest', value: `${Math.round(s.temperature.maxC)}`, unit: '°C' });
  if (total > 0) facts.push({ label: 'Guests', value: `${running}`, note: `of ${total} running` });
  return {
    id: thingId('server', s.id),
    kind: 'server',
    name: s.name,
    icon: hostOsMark(s) ?? 'server',
    status,
    line: (s.statusNote?.trim() ? reasonWords(s.statusNote) : HOST_STATUS_LABELS[s.status]).slice(0, 160),
    // Why it isn't fine (sidebar.md SB-03): the service's own note (“Filling up”), else the line behind it.
    ...(status !== 'ok' && s.statusNote?.trim() ? { reason: reasonWords(s.statusNote).slice(0, 160) } : {}),
    facts,
    href: thingHref('server', s.id),
    // Kept quiet until a time, as Home's connections and devices say it.
    ...(verdict?.quietUntil ? { quietUntil: verdict.quietUntil } : {}),
  };
}

/**
 * The check behind a server's line, for Needs you's *Stop watching this* (on-purpose.md): its item when the check is
 * per item, else the check on the whole server. None for the hub's own checks, which aren't a server's to switch off.
 */
export function serverLineWatch(
  serverId: string | null | undefined,
  line: Pick<ServerLine, 'check' | 'subject' | 'title'>,
  rule?: string,
): NeedsYouWatch | undefined {
  if (!serverId || (rule && HUB_LEVEL(rule))) return undefined;
  return {
    thing: serverThingId(serverId),
    check: line.check,
    ...(line.subject ? { subject: line.subject } : {}),
    name: (line.subject?.name ?? `“${line.title}”`).slice(0, 220),
  };
}

/** “Look into it” and “Remind me tomorrow” for an alert that needs someone. */
export function alertNeedsYou(a: HostAlert): NeedsYouItem {
  const server = a.serverId;
  const line = alertLine(a);
  const nature = line.nature;
  const watch = serverLineWatch(server, line, a.rule);
  return {
    id: `hosts.alert:${a.id}`,
    ref: { kind: 'alert', id: a.id },
    kind: 'alert',
    severity: a.severity === 'critical' ? 'bad' : 'warn',
    ...(nature !== 'fyi' ? { nature } : {}),
    title: (server ? `${a.title} on ${serverLabel(server)}` : a.title).slice(0, 200),
    body: a.detail.slice(0, 600),
    at: a.openedAt,
    actions: [
      { id: 'investigate', label: 'Look into it', style: 'primary', kind: 'investigate' },
      { id: 'snooze', label: 'Remind me tomorrow', style: 'secondary', kind: 'snooze' },
    ],
    ...(server ? { subject: { kind: 'server' as const, id: server, name: serverLabel(server) } } : {}),
    ...(watch ? { watch } : {}),
  };
}

/**
 * An alert on Watch, with its acknowledgement or snooze (QN-22): an open one only while it asks for attention; muted
 * by maintenance or held back while its parent is offline, it was put aside too (`acknowledged`). Its server kept quiet
 * snoozes it until the window ends.
 */
export function alertWatch(a: HostAlert, now: Date): WatchItem {
  const held = a.quiet?.held === 'window' ? (a.quiet.until ?? null) : null;
  const until = held ?? a.acknowledged?.until ?? null;
  const snoozed = until !== null && Date.parse(until) > now.getTime();
  const line = alertLine(a);
  const nature = line.nature;
  const watch = serverLineWatch(a.serverId, line, a.rule);
  return {
    id: `hosts.alert:${a.id}`,
    ref: { kind: 'alert', id: a.id },
    source: 'server',
    severity: a.severity === 'critical' ? 'bad' : 'warn',
    title: a.title.slice(0, 200),
    body: a.detail.slice(0, 600),
    at: a.openedAt,
    ...(a.serverId ? { serverId: a.serverId, href: thingHref('server', a.serverId) } : {}),
    state:
      held && snoozed
        ? 'snoozed'
        : a.acknowledged
          ? snoozed
            ? 'snoozed'
            : 'acknowledged'
          : a.attention || a.state !== 'open'
            ? 'open'
            : 'acknowledged',
    ...(snoozed && until ? { snoozedUntil: until } : {}),
    nature,
    ...(watch ? { watch } : {}),
  };
}

/** The server tab a hint's section opens (the web's `?tab=`, whombat-app things/search.ts). */
const SECTION_TAB: Readonly<Record<string, string>> = {
  storage: 'storage',
  temps: 'sensors',
  sensors: 'sensors',
  guests: 'guests',
  backups: 'backups',
  system: 'system',
  updates: 'system',
  // Incus and Unraid pages (incus-unraid.md IU-03).
  array: 'array',
  plugins: 'plugins',
  shares: 'shares',
  images: 'images',
  network: 'network',
  summary: 'summary',
};

/** Proxmox's guest hints (hosts/docs/MANAGE.md §3): the guest tab that fixes it and the way out in words. */
const GUEST_HINTS: Readonly<Record<string, { gtab?: string; one: string; many: string }>> = {
  'guest.no_backup_job': {
    gtab: 'backups',
    one: 'Add it to a backup plan.',
    many: 'Add them to a backup plan.',
  },
  'guest.backup_old': { gtab: 'backups', one: 'Back it up now.', many: 'Back them up now.' },
  'guest.pending_changes': { one: 'Restart it to apply them.', many: 'Restart them to apply the changes.' },
  'guest.snapshot_old': {
    gtab: 'snapshots',
    one: 'See its snapshots.',
    many: 'See their snapshots.',
  },
  'guest.agent_down': {
    one: 'Check that Proxmox’s helper runs inside it.',
    many: 'Check that Proxmox’s helper runs inside them.',
  },
  // QEMU/KVM (IU-13): a running VM without a backup or a snapshot in 30 days.
  'libvirt.no_backup': { gtab: 'backups', one: 'Back it up now.', many: 'Back them up now.' },
  // Incus (IU-08): no snapshot schedule and no backup in 30 days.
  'incus.no_snapshots': {
    gtab: 'snapshots',
    one: 'Set up automatic restore points for it.',
    many: 'Set up automatic restore points for them.',
  },
};

/** Docker on Unraid with a template (IU-08): the way out of an update is Update. */
const UNRAID_DOCKER_UPDATE: { gtab?: string; one: string; many: string } = {
  one: 'Update it.',
  many: 'Update them.',
};

/**
 * Host hints (Incus's and Unraid's, IU-08; waiting updates, SWU-13): the tab that fixes it and the way out in words,
 * which may follow the count in the title (“1 update waiting” is “it”).
 */
const HOST_HINTS: Readonly<Record<string, { tab: string; wayOut: string | ((title: string) => string) }>> = {
  'system.updates': {
    tab: 'system',
    wayOut: (title) =>
      /^1\b/.test(title) ? 'Install it on the System tab.' : 'Install them on the System tab.',
  },
  'incus.pool_full': { tab: 'storage', wayOut: 'Free up space or add more.' },
  'libvirt.pool_full': { tab: 'storage', wayOut: 'Free up space or add more.' },
  'incus.warning': { tab: 'system', wayOut: 'See it on the System tab.' },
  'unraid.array_stopped': { tab: 'array', wayOut: 'Start the array.' },
  'unraid.parity_errors': { tab: 'array', wayOut: 'Run the parity check again.' },
  'unraid.parity_old': { tab: 'array', wayOut: 'Run a parity check.' },
  'unraid.disk_errors': { tab: 'array', wayOut: 'See the disk on the Array tab.' },
  'unraid.pool_full': { tab: 'array', wayOut: 'Free up space on it.' },
  'unraid.plugin_updates': { tab: 'plugins', wayOut: 'Update them under Plugins.' },
  'unraid.notification': { tab: 'summary', wayOut: 'Clear it in Unraid once it’s handled.' },
  'unraid.os_update': { tab: 'plugins', wayOut: 'Update it in Unraid.' },
};

/** Whether a hint names guests Watch links to (on this kind of server). */
const namesGuests = (kind: string, serverKind?: string) =>
  Boolean(GUEST_HINTS[kind]) || (kind === 'docker.update_available' && serverKind === 'unraid');

/** Where a hint is fixed and how (pure): the guest it names, else the server's tab; and the way out. */
export function hintLink(
  h: Pick<HostHint, 'serverId' | 'kind' | 'detail' | 'section'> & { title?: string },
  guests: readonly { id: string; name: string }[],
  serverKind?: string,
): { href: string; wayOut: string | null } {
  const server = thingHref('server', h.serverId);
  const guestHint =
    GUEST_HINTS[h.kind] ??
    (h.kind === 'docker.update_available' && serverKind === 'unraid' ? UNRAID_DOCKER_UPDATE : undefined);
  if (guestHint) {
    const names = hintGuestNames(h.detail);
    if (names?.length === 1) {
      const want = (names[0] as string).toLowerCase();
      const hits = guests.filter(
        (g) => g.name.toLowerCase() === want || g.id.toLowerCase().split(':').pop() === want,
      );
      if (hits.length === 1) {
        const id = encodeURIComponent((hits[0] as { id: string }).id);
        return {
          href: `${server}?guest=${id}${guestHint.gtab ? `&gtab=${guestHint.gtab}` : ''}`,
          wayOut: guestHint.one,
        };
      }
    }
    return { href: `${server}?tab=guests`, wayOut: names?.length === 1 ? guestHint.one : guestHint.many };
  }
  if (h.kind === 'storage.overcommit')
    return { href: `${server}?tab=storage`, wayOut: 'Check it before it fills up.' };
  const hostHint = HOST_HINTS[h.kind];
  if (hostHint)
    return {
      href: `${server}?tab=${hostHint.tab}`,
      wayOut: typeof hostHint.wayOut === 'string' ? hostHint.wayOut : hostHint.wayOut(h.title ?? ''),
    };
  // A degraded array on Unraid is fixed on its Array tab (§2.4).
  if (serverKind === 'unraid' && h.section === 'storage')
    return { href: `${server}?tab=array`, wayOut: null };
  const tab = SECTION_TAB[h.section];
  return { href: tab ? `${server}?tab=${tab}` : server, wayOut: null };
}

/** A hint on Watch, linking to where it is fixed; ignored or snoozed in Whombat, it says so (QN-22). */
export function hintWatch(
  h: HostHint,
  at: string,
  guests: readonly { id: string; name: string }[],
  serverKind?: string,
): WatchItem {
  const { href, wayOut } = hintLink(h, guests, serverKind);
  const line = hintLine(h);
  const nature = line.nature;
  const watch = serverLineWatch(h.serverId, line);
  // What only the person decides but the assistant can do once asked (a backup job, a restart).
  const fixable = nature === 'you' && hostHintCheck(h.kind).fixable;
  const quiet = h.quiet;
  const detail = h.detail.trim();
  const body = wayOut ? (detail ? `${detail.replace(/[.\s]+$/, '')}. ${wayOut}` : wayOut) : detail;
  return {
    id: `hosts.hint:${hintRefId(h)}`.slice(0, 200),
    ref: { kind: 'hint', id: hintRefId(h) },
    source: 'server',
    severity: h.severity === 'warning' ? 'warn' : 'info',
    title: h.title.slice(0, 200) || 'Worth a look',
    body: body.slice(0, 600),
    at,
    serverId: h.serverId,
    state: quiet ? (quiet.state === 'snoozed' ? 'snoozed' : 'acknowledged') : 'open',
    ...(quiet?.state === 'snoozed' && quiet.until ? { snoozedUntil: quiet.until } : {}),
    href,
    nature,
    ...(fixable ? { fixable: true as const } : {}),
    ...(watch ? { watch } : {}),
  };
}

/**
 * The fleet with what is quiet (`HostsService.fleet`): once per Home read when the read shares its reads, with its
 * quiet rows; otherwise read now. For a burrow the hosts service serves.
 */
export function fleetFor(hosts: HostsService, burrowId: string, reads?: SourceReads): Promise<HostFleet> {
  if (!reads) return hosts.fleet();
  return reads.once('hosts.fleet', () => hosts.fleet({ burrowId, quiet: reads.quiet }));
}

async function homeServices(ctx: SourceCtx): Promise<Services | null> {
  const services = ctx.services;
  if (!services) return null;
  const hosts = hostsFor(services);
  return (await hosts.serves(ctx.burrowId)) ? services : null;
}

async function managesServers(ctx: SourceCtx): Promise<boolean> {
  if (ctx.reads) return ctx.reads.person.kind === 'person';
  const [p] = await ctx.db
    .select({ kind: principals.kind })
    .from(principals)
    .where(eq(principals.id, ctx.personId));
  return p?.kind === 'person';
}

/**
 * The agents' address changed and servers haven't found it five minutes later (backup-file.md BF-16), or null: from
 * `/hub` (cached a minute), the fleet (5 s) and `/agents` for the servers' own addresses (30 s, when it answers).
 */
export async function hostsAddressChange(services: Services, now: Date): Promise<AddressChange | null> {
  const hosts = hostsFor(services);
  const hub = toHubInfo(await hosts.hubInfo());
  if (!hub.agentUrlPrevious || !hub.agentUrlChangedAt) return null;
  const fleet = await hosts.fleetRaw();
  const agents = await hosts.agentsRaw().catch(() => [] as unknown[]);
  return addressChangeOf(hub, arr(fleet.servers), now, { addresses: agentAddresses(agents) });
}

/** The connection's own lines cover these hub checks in both Inbox and Watch. */
async function connectionCheckAlerts(ctx: SourceCtx, alerts: readonly HostAlert[]) {
  const isCheck = (a: HostAlert) => a.rule.startsWith('check.') && a.entity?.startsWith('check:') === true;
  if (!alerts.some(isCheck)) return alerts;
  const ids = await readOnce(
    ctx,
    'connection-owned hub checks',
    async () =>
      new Set(
        (
          await ctx.db
            .select({ id: catalogConnections.hubCheckId })
            .from(catalogConnections)
            .where(and(eq(catalogConnections.catalogId, UPTIME_ID), isNotNull(catalogConnections.hubCheckId)))
        ).map((row) => row.id),
      ),
  );
  return alerts.filter((a) => !isCheck(a) || !ids.has(a.entity?.slice('check:'.length) ?? null));
}

export async function hostsNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  const services = await homeServices(ctx);
  if (!services) return [];
  const hosts = hostsFor(services);
  const fleet = await hosts.fleetRaw();
  // What asks for attention and isn't a heads-up (QN-21, QN-22): an ignored or snoozed alert isn't here.
  const shaped = await fleetFor(hosts, ctx.burrowId, ctx.reads);
  // A server the hosts service holds while it reconnects after the box's address changed isn't down (network-move.md
  // NM-06): its fleet row came to no dot, so its “isn't checking in” alert waits too.
  const held = new Set(
    shaped.servers.filter((s) => s.status === 'offline' && verdictOf(s)?.dot === false).map((s) => s.id),
  );
  const items = (await connectionCheckAlerts(ctx, shaped.alerts))
    .filter((a) => a.state === 'open' && a.attention && a.severity === 'critical')
    .filter((a) => alertLine(a).nature !== 'fyi')
    .filter((a) => !(a.rule === HEARTBEAT_RULE && a.serverId && held.has(a.serverId)))
    .map(alertNeedsYou);
  // A server that is down names what it takes with it.
  await addTaken(ctx.db, ctx.burrowId, items, shaped.alerts).catch(() => undefined);
  const manages = await managesServers(ctx);
  // Servers that haven't found a new address (BF-16): the person points them here.
  if (manages) {
    const change = await hostsAddressChange(services, ctx.now).catch(() => null);
    if (change) items.push(addressNeedsYou(change));
  }
  if (Number(fleet.pending_enrollments ?? 0) > 0 && manages) {
    const pending = await hosts
      .call<unknown>({
        path: `${HOSTS_API}/enrollments`,
        query: { state: 'pending' },
        actor: { id: 'whombat', name: 'Whombat', role: 'admin' },
      })
      .catch(() => []);
    for (const e of arr(pending).map(toHostPendingEnrollment).slice(0, 10)) {
      const name = e.hostname ?? 'A server';
      items.push({
        id: `hosts.enrollment:${e.id}`,
        ref: { kind: 'enrollment', id: e.id },
        kind: 'enrollment',
        severity: 'info',
        title: `${name} wants to be added`.slice(0, 200),
        body: `${e.address ? `It asked from ${e.address}. ` : ''}Let it in to start watching it, or turn it away.`,
        at: e.requestedAt ?? ts(fleet.as_of) ?? ctx.now.toISOString(),
        actions: [
          { id: 'open', label: 'Review', style: 'primary', kind: 'open', href: '/things/servers?add=1' },
        ],
      });
    }
  }
  return items;
}

export async function hostsThings(ctx: SourceCtx): Promise<ThingSummary[]> {
  const services = await homeServices(ctx);
  if (!services) return [];
  const fleet = await fleetFor(hostsFor(services), ctx.burrowId, ctx.reads);
  return fleet.servers.map(serverThing);
}

export async function hostsWatch(ctx: SourceCtx): Promise<WatchItem[]> {
  const services = await homeServices(ctx);
  if (!services) return [];
  const hosts = hostsFor(services);
  // The fleet with what is quiet (QN-22): alerts marked, hints with Whombat's own about the agents (AU-08), hints of a
  // check nobody watches left out. Heads-ups come marked: only the Needs you list shows them, folded (NYL-03).
  const [raw, fleet] = await Promise.all([hosts.fleetRaw(), fleetFor(hosts, ctx.burrowId, ctx.reads)]);
  const at = ts(raw.as_of) ?? ctx.now.toISOString();
  const alerts = (await connectionCheckAlerts(ctx, fleet.alerts))
    .filter((a) => a.state === 'open')
    .map((a) => alertWatch(a, ctx.now));
  const hints = fleet.hints;
  const kinds = new Map(
    arr(raw.servers).map((c) => [String(obj(c).id), String(obj(c).detail_view ?? 'standard')] as const),
  );
  // A hint that names one guest links to it: that server's guests (cached), only where one is named.
  const lookup = [
    ...new Set(
      hints
        .filter((h) => namesGuests(h.kind, kinds.get(h.serverId)) && hintGuestNames(h.detail)?.length === 1)
        .map((h) => h.serverId),
    ),
  ];
  const guests = new Map(
    await Promise.all(
      lookup.map(
        async (id) =>
          [
            id,
            (await hosts.guestsRaw(id).catch(() => [])).map((g) => ({
              id: str(obj(g).id) ?? '',
              name: str(obj(g).name) ?? '',
            })),
          ] as const,
      ),
    ),
  );
  return [
    ...alerts,
    ...hints.map((h) => hintWatch(h, at, guests.get(h.serverId) ?? [], kinds.get(h.serverId))),
  ];
}

/** How long starting a chat waits for the hosts service when no fleet was read yet: it holds the write lock. */
export const SUBJECT_FLEET_WAIT_MS = 2_000;

/**
 * What a chat about a server is called (its name as screens give it), from the servers the hosts service listed rather
 * than the name a client sent; null when this burrow sees no servers or the service knows none by that id. It runs
 * inside the write that starts the chat, so it reads the last fleet read (every screen that shows servers made one)
 * and asks the service only when there is none yet, for at most `SUBJECT_FLEET_WAIT_MS`; a hung service then can't
 * stall every other write.
 */
export async function serverSubject(ctx: SourceCtx, id: string): Promise<{ name: string } | null> {
  const services = await homeServices(ctx);
  if (!services) return null;
  if (!fleetWasRead()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      hostsFor(services)
        .fleetRaw()
        .catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(resolve, SUBJECT_FLEET_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  return knownServer(id)?.id === id ? { name: serverLabel(id) } : null;
}

/** Registers the servers' sources with Home (idempotent). */
export function registerHostsSources(): void {
  registerSubjectResolver('server', serverSubject);
  // The registry's types are the contract's shapes (SW keeps local copies until it switches to @whombat/core).
  registerNeedsYouSource('hosts', hostsNeedsYou as never);
  registerThingsSource('hosts', hostsThings as never);
  registerWatchSource('hosts', hostsWatch as never);
}
