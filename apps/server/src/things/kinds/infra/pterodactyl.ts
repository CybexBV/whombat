/**
 * Pterodactyl's (and Pelican's) page (service-dashboards.md SD-45): which game servers run, what they use together and
 * each one's CPU, memory and disk against its limits; buttons **Start**, **Restart**✱ and **Stop**✱. Read through the
 * client API with the connection's key: the server list (`/api/client`) and each one's live figures
 * (`/servers/{id}/resources`, at most 12 a page, SD-S05). Never kills, reinstalls or deletes. Its page is in slots
 * (docs/decisions/service-slots.md): each game server now with its buttons beside what they use together.
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPageCell,
  ThingPageItem,
  ThingPageKpi,
  ThingPageRow,
} from '@whombat/core';
import { badRequest } from '../../../lib/errors';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { bytes, clip, line, list, num, pct, plural, rec, span, str, thousands } from '../../words';
import { actAs } from '../act';
import { type PageButton, pageButton } from '../buttons';
import { getJson } from '../read';
import type { KindAction, KindModule } from '../registry';
import { seenFromView } from '../registry';
import { countLine, inventory, liveRows, slotPanels } from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  type ButtonCtx,
  badgeOf,
  itemLines,
  linesSeen,
  notOffered,
  okStatus,
  optional,
  serviceUrl,
  snapshotReader,
  unreadView,
} from './shared';

const NAME = 'Pterodactyl';
/** Servers whose live figures one read asks for (SD-S05). */
export const RESOURCES_MAX = 12;
const MB = 1024 * 1024;
const DAY = 86_400_000;

export type GameState = 'running' | 'starting' | 'stopping' | 'offline';

export interface GameServer {
  id: string;
  name: string;
  node: string | null;
  /** Pterodactyl's own word when it isn't simply there: suspended, installing, install_failed, restoring_backup… */
  status: string | null;
  suspended: boolean;
  /** Limits: CPU in percent of one core, memory and disk in bytes; null when unlimited. */
  limits: { cpu: number | null; memory: number | null; disk: number | null };
  /** Off now, seen running within the last day, and nobody stopped it (its activity says so when it can be read). */
  stoppedUnexpectedly: boolean;
  /** When this Whombat last saw it running (in memory): each stop on its own is a new one. */
  lastRunningAt?: Date | null;
  /** Live figures; null when they weren't read. */
  live: {
    state: GameState;
    cpu: number | null;
    memory: number | null;
    disk: number | null;
    uptimeMs: number | null;
  } | null;
}

export interface PterodactylSnapshot {
  readAt: Date;
  servers: GameServer[];
  /** Not every server's live figures were read (past the first 12, or refused): their lines don't look fixed. */
  liveMissed?: boolean;
  /** More servers went off after running than the three whose activity is read. */
  activityMissed?: boolean;
}

const limit = (v: unknown, unit: number) => {
  const n = num(v);
  return n && n > 0 ? n * unit : null;
};

/** One server of `/api/client` (`{object: 'server', attributes}`). */
export function gameServer(raw: unknown): GameServer | null {
  const a = rec(rec(raw).attributes);
  const id = str(a.identifier) ?? str(a.uuid);
  if (!id) return null;
  const l = rec(a.limits);
  const status = str(a.status);
  return {
    id: id.slice(0, 200),
    name: clip(str(a.name) ?? id, 120),
    node: str(a.node),
    status,
    suspended: a.is_suspended === true || status === 'suspended',
    limits: { cpu: limit(l.cpu, 1), memory: limit(l.memory, MB), disk: limit(l.disk, MB) },
    stoppedUnexpectedly: false,
    live: null,
  };
}

const STATES: readonly GameState[] = ['running', 'starting', 'stopping', 'offline'];

/** `/servers/{id}/resources` (`{object: 'stats', attributes: {current_state, is_suspended, resources}}`). */
export function gameLive(raw: unknown): GameServer['live'] {
  const a = rec(rec(raw).attributes);
  const state = str(a.current_state)?.toLowerCase() as GameState | undefined;
  if (!state || !STATES.includes(state)) return null;
  const r = rec(a.resources);
  return {
    state,
    cpu: num(r.cpu_absolute),
    memory: num(r.memory_bytes),
    disk: num(r.disk_bytes),
    uptimeMs: num(r.uptime),
  };
}

export function parseServers(body: unknown): GameServer[] {
  return list(rec(body).data)
    .slice(0, 100)
    .map(gameServer)
    .filter((s): s is GameServer => s !== null);
}

export const pterodactylReader = snapshotReader<PterodactylSnapshot>(
  NAME,
  'pterodactyl',
  async (services, row, now) => {
    const servers = parseServers(await getJson(services, row, NAME, '/api/client', { per_page: '100' }));
    let liveMissed = servers.length > RESOURCES_MAX;
    await Promise.all(
      servers.slice(0, RESOURCES_MAX).map(async (s) => {
        if (s.status === 'installing' || s.status === 'install_failed') return;
        const raw = await optional(
          getJson(services, row, NAME, `/api/client/servers/${encodeURIComponent(s.id)}/resources`),
        );
        s.live = raw ? gameLive(raw) : null;
        if (!raw) liveMissed = true;
      }),
    );
    const ran = ranRecently(row.id);
    const off = servers.filter((s) => s.live?.state === 'offline' && ran.has(s.id));
    const offAfterRunning = off.slice(0, 3);
    await Promise.all(
      offAfterRunning.map(async (s) => {
        const at = ran.get(s.id);
        s.lastRunningAt = at === undefined ? null : new Date(at);
        const activity = await optional(
          getJson(services, row, NAME, `/api/client/servers/${encodeURIComponent(s.id)}/activity`, {
            per_page: '10',
          }),
        );
        s.stoppedUnexpectedly = !stoppedByPerson(activity, ran.get(s.id) ?? 0);
      }),
    );
    remember(row.id, servers, now);
    return {
      readAt: now,
      servers,
      ...(liveMissed ? { liveMissed: true } : {}),
      ...(off.length > offAfterRunning.length ? { activityMissed: true } : {}),
    };
  },
);

/* Which servers ran before (SD-45 “offline that ran before”, SD-S16) ------------------------------------------------- */

/** Per connection, when each server was last seen running; kept in memory a day. */
const lastRunning = new Map<string, Map<string, number>>();

function remember(connectionId: string, servers: readonly GameServer[], now: Date) {
  let seen = lastRunning.get(connectionId);
  if (!seen) {
    seen = new Map();
    lastRunning.set(connectionId, seen);
  }
  for (const s of servers) if (s.live?.state === 'running') seen.set(s.id, now.getTime());
  for (const [id, at] of seen) if (now.getTime() - at > DAY) seen.delete(id);
}

/** A person stopped it: it isn't “stopped unexpectedly”. */
function forget(connectionId: string, serverId: string) {
  lastRunning.get(connectionId)?.delete(serverId);
}

/** The servers seen running within the last day, and when. */
function ranRecently(connectionId: string): ReadonlyMap<string, number> {
  return new Map(lastRunning.get(connectionId) ?? []);
}

/**
 * Whether the server's activity (`/servers/{id}/activity`, newest first) has a person's stop or kill since it was last
 * seen running; false when there is no activity to read.
 */
export function stoppedByPerson(activity: unknown, sinceMs: number): boolean {
  for (const raw of list(rec(activity).data).slice(0, 50)) {
    const a = rec(rec(raw).attributes);
    const event = str(a.event) ?? '';
    const at = Date.parse(str(a.timestamp) ?? '');
    if (!event.startsWith('server:power.') || !Number.isFinite(at) || at < sinceMs - 60_000) continue;
    return event === 'server:power.stop' || event === 'server:power.kill';
  }
  return false;
}

/* What it means ------------------------------------------------------------------------------------------------------- */

const running = (s: GameServer) => s.live?.state === 'running' || s.live?.state === 'starting';
const offline = (s: GameServer) => s.live?.state === 'offline';
const diskShare = (s: GameServer) =>
  s.live?.disk != null && s.limits.disk ? s.live.disk / s.limits.disk : null;
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

/** Together, with the limits when every server has one. */
function together(servers: readonly GameServer[], key: 'cpu' | 'memory' | 'disk') {
  const used = sum(servers.map((s) => s.live?.[key]));
  const limits = servers.map((s) => s.limits[key]);
  const cap = limits.every((l) => l !== null) ? sum(limits) : null;
  return { used, cap };
}

export function pterodactylKpis(s: PterodactylSnapshot): ThingPageKpi[] {
  const read = s.servers.filter((x) => x.live);
  const up = s.servers.filter(running).length;
  const out: ThingPageKpi[] = [
    {
      key: 'running',
      label: 'Running',
      value: String(up),
      rest: `of ${s.servers.length}`,
      sub: up === s.servers.length ? 'all running' : `${s.servers.length - up} not running`,
      ...(s.servers.length ? { meter: up / s.servers.length } : {}),
      color: 'green',
    },
  ];
  if (!read.length) return out;
  const cpu = together(read, 'cpu');
  out.push({
    key: 'cpu',
    label: 'CPU',
    value: pct(cpu.used),
    ...(cpu.cap
      ? { sub: `of ${pct(cpu.cap)} allowed`, meter: Math.min(1, cpu.used / cpu.cap) }
      : { sub: '100 % is one core' }),
    color: 'blue',
  });
  const memory = together(read, 'memory');
  out.push({
    key: 'memory',
    label: 'Memory',
    value: bytes(memory.used),
    ...(memory.cap
      ? { sub: `of ${bytes(memory.cap)}`, meter: Math.min(1, memory.used / memory.cap) }
      : { sub: 'no limit' }),
    color: 'violet',
  });
  const disk = together(read, 'disk');
  const full = disk.cap ? disk.used / disk.cap : null;
  out.push({
    key: 'disk',
    label: 'Disk',
    value: bytes(disk.used),
    ...(disk.cap && full !== null
      ? {
          sub: `of ${bytes(disk.cap)}`,
          meter: Math.min(1, full),
          ...(full >= 0.9 ? { tone: 'warn' as const } : {}),
        }
      : { sub: 'no limit' }),
  });
  return out;
}

const stoppedOnItsOwn = (s: PterodactylSnapshot) =>
  s.servers.filter((x) => offline(x) && x.stoppedUnexpectedly && !x.suspended);

/** Every check Pterodactyl's page can raise (QN-15). */
export const PTERODACTYL_CHECKS: readonly KindCheck[] = [
  {
    check: 'pterodactyl.stopped',
    name: 'Game servers stopping on their own',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'pterodactyl.suspended',
    name: 'Suspended game servers',
    nature: 'you',
    perItem: true,
    startsOn: false,
  },
  { check: 'pterodactyl.install', name: 'Failed installs', nature: 'you', perItem: true, startsOn: false },
  {
    check: 'pterodactyl.disk',
    name: 'Game server disks filling up',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
];

/** What this read couldn't see (QN-11): live figures past the first 12 or refused, activity past the first three. */
export function pterodactylSkipped(s: PterodactylSnapshot): string[] {
  const out: string[] = [];
  if (s.liveMissed) out.push('pterodactyl.stopped', 'pterodactyl.disk');
  if (s.activityMissed) out.push('pterodactyl.stopped');
  return out;
}

const serverSubject = (x: GameServer) => ({ id: clip(`server:${x.id}`, 160), name: clip(x.name, 80) });

const moreLine = (id: string, what: (n: number) => string) => (rest: readonly KindNotice[]) => ({
  id,
  title: what(rest.length),
  detail: clip(rest.map((n) => n.subject?.name ?? n.title).join(' · '), 200),
});

/** Worth a look (SD-45; quiet-notices.md QN-01…QN-04): one line per game server and what's wrong with it. */
export function pterodactylNotices(s: PterodactylSnapshot, ctx?: ButtonCtx, url?: string): KindNotice[] {
  const panel = url ? { link: { kind: 'url' as const, label: 'Open the panel', url } } : {};
  const stopped = stoppedOnItsOwn(s).map(
    (x): KindNotice => ({
      id: clip(`stopped-${x.id}`, 120),
      tone: 'warn',
      icon: 'power',
      title: clip(`${x.name} has stopped`, 120),
      detail: 'It was running earlier and nobody stopped it.',
      ...(ctx && powerButtons(ctx, x)[0] ? { action: powerButtons(ctx, x)[0] as PageButton } : {}),
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: clip(`Why did the game server ${x.name} stop?`, 300),
      },
      nature: 'problem',
      check: 'pterodactyl.stopped',
      subject: serverSubject(x),
      // Each stop on its own is new: when it was last seen running.
      episode: x.lastRunningAt?.toISOString() ?? 'unknown',
      ignore: { lifts: 'newer', words: 'Until it stops on its own again.' },
      badge: badgeOf(`${x.name} stopped`),
    }),
  );
  const suspended = s.servers
    .filter((v) => v.suspended)
    .map(
      (x): KindNotice => ({
        id: clip(`suspended-${x.id}`, 120),
        tone: 'warn',
        icon: 'power',
        title: clip(`${x.name} is suspended`, 120),
        detail: 'It can’t start until an administrator lifts the suspension.',
        ...panel,
        nature: 'you',
        check: 'pterodactyl.suspended',
        subject: serverSubject(x),
        ignore: { lifts: 'fixed', words: 'Until it’s unsuspended.' },
        badge: badgeOf(`${x.name} suspended`),
      }),
    );
  const install = s.servers
    .filter((v) => v.status === 'install_failed' || v.status === 'reinstall_failed')
    .map(
      (x): KindNotice => ({
        id: clip(`install-${x.id}`, 120),
        tone: 'warn',
        icon: 'warn',
        title: clip(`${x.name} didn’t install`, 120),
        detail: 'Reinstall it from the panel; Whombat never reinstalls a server.',
        ...panel,
        nature: 'you',
        check: 'pterodactyl.install',
        subject: serverSubject(x),
        ignore: { lifts: 'fixed', words: 'Until it’s installed.' },
        badge: badgeOf(`${x.name} didn’t install`),
      }),
    );
  const disk = s.servers
    .filter((v) => (diskShare(v) ?? 0) >= 0.9)
    .map((x): KindNotice => {
      const share = diskShare(x) as number;
      return {
        id: clip(`disk-${x.id}`, 120),
        tone: 'warn',
        icon: 'disk',
        title: clip(`${x.name}’s disk is ${pct(share * 100)} full`, 120),
        detail: `${bytes(x.live?.disk ?? 0)} of ${bytes(x.limits.disk ?? 0)}.`,
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: clip(`What fills the disk of the game server ${x.name}?`, 300),
        },
        nature: 'problem',
        check: 'pterodactyl.disk',
        subject: serverSubject(x),
        band: share >= 0.95 ? 95 : 90,
        // Games write logs and saves all the time: it hovers around 90 % (QN-04).
        confirm: 2,
        ignore: { lifts: 'fixed', words: 'Until there’s room again.' },
        badge: badgeOf(`${x.name} disk ${pct(share * 100)} full`),
      };
    });
  return [
    ...itemLines(
      stopped,
      moreLine('stopped-more', (n) => `${plural(n, 'more server has', 'more servers have')} stopped`),
    ),
    ...itemLines(
      suspended,
      moreLine('suspended-more', (n) => `${plural(n, 'more server is', 'more servers are')} suspended`),
    ),
    ...itemLines(
      install,
      moreLine('install-more', (n) => `${plural(n, 'more server', 'more servers')} didn’t install`),
    ),
    ...itemLines(
      disk,
      moreLine(
        'disk-more',
        (n) => `${plural(n, 'more server’s disk is', 'more servers’ disks are')} nearly full`,
      ),
    ),
  ];
}

/** The head when nothing is worth a look (QN-S30): how many run; the lines say what's wrong. */
export function pterodactylStatus(s: PterodactylSnapshot): NonNullable<KindView['status']> {
  return okStatus(`${s.servers.filter(running).length} of ${s.servers.length} running`);
}

const STATE_WORDS: Record<GameState, { text: string; dot: NonNullable<ThingPageCell['dot']> }> = {
  running: { text: 'Running', dot: 'ok' },
  starting: { text: 'Starting', dot: 'warn' },
  stopping: { text: 'Stopping', dot: 'warn' },
  offline: { text: 'Offline', dot: 'off' },
};

function stateCell(s: GameServer): ThingPageCell {
  if (s.suspended) return { text: 'Suspended', dot: 'bad' };
  if (s.status === 'installing') return { text: 'Installing', dot: 'warn' };
  if (s.status === 'install_failed' || s.status === 'reinstall_failed')
    return { text: 'Install failed', dot: 'bad' };
  if (s.status === 'restoring_backup') return { text: 'Restoring a backup', dot: 'warn' };
  if (!s.live) return { text: '—', tone: 'muted' };
  return STATE_WORDS[s.live.state];
}

function meterCell(
  used: number | null | undefined,
  cap: number | null,
  words: (n: number) => string,
): ThingPageCell {
  if (used == null) return { text: '—', tone: 'muted' };
  const share = cap ? used / cap : null;
  return {
    text: words(used),
    mono: true,
    ...(cap ? { note: `of ${words(cap)}` } : {}),
    ...(share !== null ? { meter: Math.min(1, share) } : {}),
    ...(share !== null && share >= 0.9 ? { tone: 'warn' as const } : {}),
  };
}

/** The power buttons a server offers now (SD-45): Start when it's off; Restart✱ and Stop✱ while it runs. */
export function powerButtons(ctx: ButtonCtx, s: GameServer): PageButton[] {
  if (s.suspended || !s.live) return [];
  if (s.live.state === 'offline')
    return [
      pageButton(ctx, { action: 'start', target: s.id, label: 'Start', icon: 'play', tone: 'primary' }),
    ];
  if (s.live.state === 'stopping') return [];
  return [
    pageButton(ctx, {
      action: 'restart',
      target: s.id,
      label: 'Restart',
      icon: 'restart',
      confirm: {
        title: clip(`Restart ${s.name}?`, 80),
        body: 'Players are disconnected while it restarts; it’s usually back within a minute or two.',
        button: 'Restart',
      },
    }),
    pageButton(ctx, {
      action: 'stop',
      target: s.id,
      label: 'Stop',
      icon: 'stop',
      tone: 'danger',
      confirm: {
        title: clip(`Stop ${s.name}?`, 80),
        body: 'Players are disconnected and it stays off until someone starts it again.',
        button: 'Stop',
      },
    }),
  ];
}

export function pterodactylRows(s: PterodactylSnapshot, ctx: ButtonCtx): ThingPageRow[] {
  const rank = (x: GameServer) => (x.suspended ? 0 : running(x) ? 1 : 2);
  return [...s.servers]
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((x) => ({
      id: x.id,
      cells: {
        name: { text: x.name, ...(x.node ? { note: clip(x.node, 80) } : {}) },
        state: stateCell(x),
        cpu: meterCell(x.live?.cpu, x.limits.cpu, pct),
        memory: meterCell(x.live?.memory, x.limits.memory, bytes),
        disk: meterCell(x.live?.disk, x.limits.disk, bytes),
        ...buttonCells(powerButtons(ctx, x)),
      },
    }));
}

/** The power buttons in two cells: Start or Stop in `power`, Restart in `restart`. */
function buttonCells(buttons: readonly PageButton[]): ThingPageRow['cells'] {
  const out: ThingPageRow['cells'] = {};
  for (const b of buttons) out[b.action === 'restart' ? 'restart' : 'power'] = { text: b.label, action: b };
  return out;
}

const COLUMNS = [
  { key: 'name', label: 'Server' },
  { key: 'state', label: 'State' },
  { key: 'cpu', label: 'CPU', numeric: true },
  { key: 'memory', label: 'Memory', numeric: true },
  { key: 'disk', label: 'Disk', numeric: true },
  { key: 'restart', label: '' },
  { key: 'power', label: '' },
];

export function pterodactylFacts(s: PterodactylSnapshot): ThingLine[] {
  const nodes = new Set(s.servers.flatMap((x) => (x.node ? [x.node] : []))).size;
  return [
    line(
      `**${plural(s.servers.length, 'game server')}**${nodes > 1 ? ` on **${plural(nodes, 'node')}**` : ''}`,
    ),
  ];
}

/** A game server's state as its row's tag; null while it simply runs. */
function serverBadge(x: GameServer): ThingGalleryItem['badge'] | null {
  if (x.suspended) return { text: 'Suspended', tone: 'bad' };
  if (x.status === 'install_failed' || x.status === 'reinstall_failed')
    return { text: 'Install failed', tone: 'bad' };
  if (x.status === 'installing') return { text: 'Installing', tone: 'warn' };
  if (x.status === 'restoring_backup') return { text: 'Restoring a backup', tone: 'warn' };
  if (!x.live) return null;
  if (x.live.state === 'starting') return { text: 'Starting', tone: 'warn' };
  if (x.live.state === 'stopping') return { text: 'Stopping', tone: 'warn' };
  if (x.live.state === 'offline') return { text: 'Offline', tone: 'warn' };
  return null;
}

/** Running first, then off, then what can't run (suspended, installing). */
const liveRank = (x: GameServer) =>
  x.suspended || x.status === 'installing' || x.status?.endsWith('install_failed') ? 2 : running(x) ? 0 : 1;

/** Game servers (Live): each server with its memory as the bar, its CPU at the bar's end, and its power buttons. */
export function pterodactylLive(s: PterodactylSnapshot, ctx: ButtonCtx) {
  const up = s.servers.filter(running).length;
  const items = [...s.servers]
    .sort((a, b) => liveRank(a) - liveRank(b) || a.name.localeCompare(b.name))
    .slice(0, 48)
    .map((x): ThingGalleryItem => {
      const badge = serverBadge(x);
      const on = x.live?.state === 'running';
      const sub = [
        x.node,
        on && x.live?.uptimeMs && x.live.uptimeMs >= 60_000 ? `up ${span(x.live.uptimeMs)}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const memory = x.live?.memory;
      const cap = x.limits.memory;
      const actions = powerButtons(ctx, x);
      return {
        id: x.id,
        title: x.name,
        ...(sub ? { sub: clip(sub, 120) } : {}),
        ...(badge ? { badge } : {}),
        // Only what runs has a bar: an empty grey one on a server that is off says nothing.
        ...(memory != null && cap && running(x) ? { progress: Math.min(1, memory / cap) } : {}),
        ...(memory != null && on
          ? { note: clip(cap ? `${bytes(memory)} of ${bytes(cap)}` : bytes(memory), 80) }
          : {}),
        ...(on && x.live?.cpu != null ? { noteEnd: `${pct(x.live.cpu)} CPU` } : {}),
        // Off, suspended or installing: its bar stands still.
        ...(running(x) ? {} : { paused: true }),
        ...(actions.length ? { actions } : {}),
      };
    });
  return liveRows({
    id: 'servers',
    title: 'Game servers',
    // Game servers have no pictures here: the row's square says the name's first letter.
    shape: 'square',
    meta: `${up} of ${s.servers.length} running`,
    items,
    empty: 'No game servers this key can see.',
  });
}

/** In the panel (Inventory): how many game servers, and what they use together against their limits. */
export function pterodactylInventory(s: PterodactylSnapshot) {
  const up = s.servers.filter(running).length;
  const suspended = s.servers.filter((x) => x.suspended).length;
  const nodes = new Set(s.servers.flatMap((x) => (x.node ? [x.node] : []))).size;
  const lines: ThingPageItem[] = [
    countLine({
      id: 'game-servers',
      title: 'Game servers',
      icon: 'power',
      value: thousands(s.servers.length),
      detail: `${up} running`,
      ...(suspended
        ? { note: `${suspended} suspended`, noteTone: 'warn' as const }
        : s.servers.length && up === s.servers.length
          ? { note: 'All running', noteTone: 'ok' as const }
          : s.servers.length
            ? { note: `${s.servers.length - up} off` }
            : {}),
    }),
  ];
  if (nodes > 1)
    lines.push(countLine({ id: 'nodes', title: 'Nodes', icon: 'network', value: thousands(nodes) }));
  const read = s.servers.filter((x) => x.live);
  if (read.length) {
    const cpu = together(read, 'cpu');
    lines.push(
      countLine({
        id: 'cpu',
        title: 'CPU',
        icon: 'device',
        value: pct(cpu.used),
        note: cpu.cap ? `of ${pct(cpu.cap)} allowed` : '100 % is one core',
      }),
    );
    const memory = together(read, 'memory');
    lines.push(
      countLine({
        id: 'memory',
        title: 'Memory',
        icon: 'device',
        value: bytes(memory.used),
        ...(memory.cap ? { note: `of ${bytes(memory.cap)}` } : { note: 'No limit' }),
      }),
    );
    const disk = together(read, 'disk');
    const full = disk.cap ? disk.used / disk.cap : null;
    lines.push(
      countLine({
        id: 'disk',
        title: 'Disk',
        icon: 'disk',
        value: bytes(disk.used),
        ...(disk.cap
          ? {
              note: `of ${bytes(disk.cap)}`,
              ...(full !== null && full >= 0.9 ? { noteTone: 'warn' as const } : {}),
            }
          : { note: 'No limit' }),
      }),
    );
  }
  return inventory({ id: 'inventory', title: 'In the panel', items: lines });
}

/**
 * The Summary in slots (docs/decisions/service-slots.md): each game server now beside how many there are and what they
 * use together; no Trend (the panel keeps no history), no Shelf, no People (the panel doesn't know its players), no
 * lines of its own in the machine card (the client API doesn't say the panel's version).
 */
export function pterodactylSlots(s: PterodactylSnapshot, ctx: ButtonCtx): Pick<KindView, 'panels' | 'slots'> {
  return slotPanels({ live: pterodactylLive(s, ctx), inventory: pterodactylInventory(s), machine: [] });
}

export interface PterodactylInput {
  snapshot: PterodactylSnapshot;
  url: string;
  row: ButtonCtx['row'];
}

/** Every game server with its CPU, memory and disk against its limits: the Game servers tab. */
function serversTab(s: PterodactylSnapshot, ctx: ButtonCtx): KindView['tabs'][number] {
  return {
    key: 'servers',
    label: 'Game servers',
    count: s.servers.length,
    panels: [
      {
        kind: 'table',
        id: 'all-servers',
        title: 'Game servers',
        meta: `${s.servers.filter(running).length} running`,
        columns: COLUMNS,
        rows: pterodactylRows(s, ctx),
        empty: 'No game servers this key can see.',
      },
    ],
  };
}

/** The page's Pterodactyl part (SD-45), in slots; pure. */
export function pterodactylView({ snapshot: s, url, row }: PterodactylInput): KindView {
  const moving = s.servers.some((x) => x.live?.state === 'starting' || x.live?.state === 'stopping');
  return {
    // In slots its figures are in In the panel; the card keeps Running (`pterodactylKpis` in `seen`).
    kpis: [],
    machine: 'after',
    charts: [],
    notices: pterodactylNotices(s, { row }, url),
    ...pterodactylSlots(s, { row }),
    tabs: s.servers.length ? [serversTab(s, { row })] : [],
    facts: pterodactylFacts(s),
    status: pterodactylStatus(s),
    open: { label: 'Open the panel', url },
    actions: [],
    readAt: s.readAt,
    ...(moving ? { refreshS: 5 } : {}),
    suggestions: ['Players online', 'Memory per server', 'Backups'],
  };
}

export async function pterodactylPage(ctx: KindCtx): Promise<KindView> {
  const url = serviceUrl(ctx.row);
  const read = await pterodactylReader.latest(ctx.services, ctx.row, ctx.now);
  if (!read.ok) return unreadView(read, NAME, { label: 'Open the panel', url }, []);
  return {
    ...pterodactylView({
      snapshot: read.value,
      url,
      row: ctx.row,
    }),
    refreshing: read.refreshing,
  };
}

/* Buttons --------------------------------------------------------------------------------------------------------------- */

const POWER = {
  start: { words: 'Starting', done: 'Started', when: (x: GameServer) => x.live?.state === 'offline' },
  restart: { words: 'Restarting', done: 'Restarted', when: running },
  stop: { words: 'Stopping', done: 'Stopped', when: running },
} as const;

function power(signal: keyof typeof POWER): KindAction {
  return async ({ services, row, now }, { target }) => {
    const s = await pterodactylReader.cached(services, row, now);
    const x = s.servers.find((v) => v.id === target);
    if (!x || x.suspended) throw notOffered('That server');
    if (!POWER[signal].when(x))
      throw badRequest(signal === 'start' ? `${x.name} isn’t off.` : `${x.name} isn’t running.`);
    await actAs(services, row, NAME, {
      method: 'POST',
      path: `/api/client/servers/${encodeURIComponent(x.id)}/power`,
      body: { signal },
    });
    if (signal === 'stop') forget(row.id, x.id);
    return {
      message: `${POWER[signal].words} ${x.name}.`,
      title: clip(`${POWER[signal].done} ${x.name}`, 200),
    };
  };
}

export const PTERODACTYL_KIND: KindModule = {
  page: pterodactylPage,
  seen: async (services, row, now) => {
    const s = await pterodactylReader.cached(services, row, now);
    const view = pterodactylView({ snapshot: s, url: serviceUrl(row), row });
    return {
      // The page has no row of figures; the card keeps Running.
      glance: seenFromView(
        { kpis: pterodactylKpis(s), notices: view.notices },
        { figures: 1, line: plural(s.servers.length, 'game server') },
      ),
      points: {},
      ...linesSeen(view, pterodactylSkipped(s)),
    };
  },
  checks: PTERODACTYL_CHECKS,
  actions: { start: power('start'), restart: power('restart'), stop: power('stop') },
};
