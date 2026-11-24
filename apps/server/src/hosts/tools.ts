/**
 * The built-in Servers connection's tools (contracts CT-342, `SERVERS_TOOLS`; one-whombat.md ONE-12;
 * one-whombat-servers.md ONE-DH14…ONE-DH17): Whombat reads and changes servers through `connection_call`, so the keys
 * engine, the tools' tiers, approvals (sensitive calls always ask: stopping and restarting guests, restoring and
 * deleting snapshots, migrating, running a command) and signed events apply as for any connection. This adapter runs
 * an allowed call against the hosts service as “<Whombat> for <person>” with the role the call needs, answers compact
 * JSON, and records what it changed for Done recently with the inverse where there is one (power, configuration,
 * snooze). A call that starts a task on the server is followed (`follow.ts`, proxmox.md PX-05): Whombat says in the
 * chat how it ended. An argument a tool doesn't take is refused, naming it (PX-08), rather than dropped.
 */

import {
  type GuideCard,
  HOST_ASKS_FIRST_DEFAULT,
  HOST_CONTROL_LEVELS,
  type HostAlert,
  type HostAsksFirst,
  type HostControlLevel,
  type HostHint,
  HostSeriesRange,
  type NoticeQuiet,
  parseHostInstallAddress,
  quietLine,
} from '@whombat/core';
import type { Adapter, AdapterContext } from '../connections/adapters/types';
import { type CallOutput, ConnectionArgumentError } from '../connections/request';
import { makeCard } from '../guides/flows';
import { loadPrincipalRow } from '../read/principals';
import { keepQuietForWork, RESTART_MS } from '../things/quiet/window-work';
import { serverAsksOf } from './asks-store';
import { HOSTS_API, seg } from './client';
import { askAddServer, committed } from './commands';
import {
  arr,
  guestsOfDetail,
  num,
  obj,
  remoteControlFromAgent,
  str,
  toHostAlert,
  toHostDiskUsage,
  toHostGuest,
  toHostGuestConfig,
  toHostManageResult,
  toHostSeries,
  toHostServerDetail,
} from './map';
import { settingsTitle } from './merge';
import { MANAGE_TOOL_ARGS, MANAGE_TOOLS } from './tools-manage';
import {
  type Args,
  camelOut,
  FOLLOWED_NOTE,
  follow,
  incusDevices,
  isOutput,
  opt,
  optStrList,
  output,
  record,
  refuseSelf,
  req,
  resolveGuest,
  resolveServer,
  run,
  scope,
  serverDetailRaw,
} from './tools-shared';
import { configUndo, powerInverse, powerText } from './undo';
import { noteWaitingUpdates } from './updates';

/** The default series of `server_metrics` (the service's names, REST-API “Fleet and servers”). */
export const DEFAULT_SERIES = ['cpu_pct', 'mem_pct', 'temp_max_c', 'net_rx_mbps', 'net_tx_mbps'];
/** Names an agent may have read in an older description, as the service's (`net_mbps` was the fleet's sum). */
const SERIES_ALIASES: Readonly<Record<string, readonly string[]>> = {
  net_mbps: ['net_rx_mbps', 'net_tx_mbps'],
};

/** The series `server_metrics` asks for: the defaults, or the agent's with old names mapped. */
export function seriesWanted(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [...DEFAULT_SERIES];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string' || !/^[a-z][a-z0-9_.:/-]{0,99}$/.test(x)))
    throw new ConnectionArgumentError('series: names like cpu_pct, mem_pct, temp_max_c, net_rx_mbps.');
  const out = (raw as string[]).flatMap((x) => SERIES_ALIASES[x] ?? [x]);
  const unique = [...new Set(out)];
  if (unique.length === 0) return [...DEFAULT_SERIES];
  if (unique.length > 12) throw new ConnectionArgumentError('series: at most 12.');
  return unique;
}

/** `server_diagnose`'s arguments as the service takes them: strings (numbers and booleans converted), at most 16. */
export function diagnoseArgs(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new ConnectionArgumentError(
      'args: an object of strings, like {"unit": "pveproxy", "lines": "200"}.',
    );
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 16) throw new ConnectionArgumentError('args: at most 16.');
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k)) throw new ConnectionArgumentError(`args.${k}: not a name.`);
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else throw new ConnectionArgumentError(`args.${k}: a string.`);
  }
  return entries.length ? out : undefined;
}

/**
 * What the assistant reads about lines people put aside (quiet-notices.md QN-24; QN-S57): a line that is ignored or
 * snoozed says so in its `quiet` (“Ignored by John until it’s back online”), and the answer says once that such lines
 * stay out of what it brings up unless someone asks. Lines Whombat doesn't watch aren't in it at all.
 */
export const QUIET_NOTE =
  'Lines with “quiet” were put aside on purpose by someone here: leave them out of what you bring up unless asked.';

/** A line's quiet as the assistant reads it (“Ignored by John until it’s back online”). */
const quietWords = (q: NoticeQuiet | undefined) => (q ? { quiet: quietLine(q) } : {});

/** An alert or hint for the assistant, its quiet in words. */
function withQuietWords<T extends { quiet?: NoticeQuiet }>(line: T): Omit<T, 'quiet'> & { quiet?: string } {
  const { quiet, ...rest } = line;
  return { ...rest, ...quietWords(quiet) };
}

/** The note about quiet lines, when the answer has any. */
const quietNote = (lines: readonly { quiet?: unknown }[]) =>
  lines.some((l) => l.quiet) ? { quietNote: QUIET_NOTE } : {};

/** The arguments each tool takes; anything else is refused by name (PX-08). */
export const SERVERS_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  servers_overview: [],
  server_detail: ['server'],
  server_metrics: ['server', 'range', 'series'],
  guests_list: ['server', 'q', 'state'],
  guest_detail: ['server', 'guest'],
  guest_config: ['server', 'guest'],
  guest_power: ['server', 'guest', 'action'],
  guest_config_set: [
    'server',
    'guest',
    'digest',
    'set',
    'delete',
    'revert',
    'confirm',
    'devices',
    'profiles',
  ],
  guest_snapshot: ['server', 'guest', 'action', 'name', 'description'],
  guest_migrate: ['server', 'guest', 'target', 'storage'],
  alerts_list: ['server'],
  alert_snooze: ['alert', 'minutes', 'note'],
  server_diagnose: ['server', 'check', 'args'],
  server_disk_usage: ['server', 'mount'],
  server_command: ['server', 'command', 'reason'],
  server_add: ['address', 'username', 'control', 'name'],
  ...MANAGE_TOOL_ARGS,
};

/** Refuses an argument the tool doesn't take, naming it. */
export function checkArgs(tool: string, args: Readonly<Record<string, unknown>>): void {
  const takes = SERVERS_TOOL_ARGS[tool];
  if (!takes) return;
  for (const [k, v] of Object.entries(args))
    if (v !== undefined && !takes.includes(k))
      throw new ConnectionArgumentError(
        takes.length
          ? `${k}: ${tool} doesn’t take it (it takes ${takes.join(', ')}).`
          : `${k}: ${tool} takes no arguments.`,
      );
}
/** Points per series an agent gets at most (the history is averaged into them). */
export const MAX_POINTS = 60;

/** A server row as an agent reads it: what matters, no sparkline. */
function serverLine(row: ReturnType<typeof compactServer>) {
  return row;
}

function compactServer(s: {
  id: string;
  name?: string;
  status: string;
  statusNote?: string | null;
  platform: string;
  os: string | null;
  cpuPct: number | null;
  memory: { usedPct: number | null; totalGb: number | null };
  storage: { usedPct: number | null; capacityTb: number | null };
  temperature: { maxC: number | null; limitC: number | null } | null;
  guests: { platform: string; running: number; total: number }[];
  alerts?: { critical: number; warning: number };
  lastSeen: string | null;
  remoteControl: {
    console: boolean;
    power: boolean;
    manage?: boolean;
    hostShell?: boolean;
    diagnose?: boolean;
  };
  asksFirst?: HostAsksFirst;
}) {
  return {
    id: s.id,
    // What the person calls it (“The Titan”), when that isn't its id: say that name to them.
    ...(s.name && s.name.toLowerCase() !== s.id.toLowerCase() ? { name: s.name } : {}),
    status: s.status,
    ...(s.statusNote ? { note: s.statusNote } : {}),
    platform: s.platform,
    os: s.os,
    cpuPct: s.cpuPct,
    memoryPct: s.memory.usedPct,
    memoryGb: s.memory.totalGb,
    storagePct: s.storage.usedPct,
    temperatureC: s.temperature?.maxC ?? null,
    guests: s.guests.map((g) => `${g.platform} ${g.running}/${g.total} running`),
    alerts: s.alerts ?? { critical: 0, warning: 0 },
    lastSeen: s.lastSeen,
    allowed: {
      power: s.remoteControl.power,
      manage: s.remoteControl.manage === true,
      commands: s.remoteControl.hostShell === true,
      checks: s.remoteControl.diagnose !== false,
    },
    // Whether Whombat asks before its risky calls there (server-asks.md SA-09).
    asksFirst: s.asksFirst ?? HOST_ASKS_FIRST_DEFAULT,
  };
}

/** A series averaged into at most `max` points. */
export function downsample(values: readonly (number | null)[], max = MAX_POINTS): (number | null)[] {
  if (values.length <= max) return [...values];
  const out: (number | null)[] = [];
  const step = values.length / max;
  for (let i = 0; i < max; i++) {
    const part = values
      .slice(Math.floor(i * step), Math.floor((i + 1) * step))
      .filter((v): v is number => v !== null);
    out.push(part.length ? Math.round((part.reduce((a, b) => a + b, 0) / part.length) * 10) / 10 : null);
  }
  return out;
}

/** The tool's power words → the hub's action for this kind of guest. */
export function hubPowerAction(tool: string, kind: 'vm' | 'container'): string {
  if (tool === 'stop') return kind === 'vm' ? 'force_stop' : 'stop';
  if (tool === 'shutdown') return kind === 'vm' ? 'shutdown' : 'stop';
  if (tool === 'reboot') return kind === 'vm' ? 'reboot' : 'restart';
  if (tool === 'pause' || tool === 'resume') return tool;
  return 'start';
}

const TOOLS: Adapter = {
  async servers_overview(ctx) {
    const s = await scope(ctx);
    const out = await run({}, async () => {
      const fleet = await s.hosts.fleet();
      const open = fleet.alerts.filter((a) => a.state === 'open');
      const quiet = open.filter((a) => !a.attention).length;
      return output({
        servers: fleet.servers.map((row) => serverLine(compactServer(row))),
        // What asks for attention; the rest someone put aside (QN-24).
        openAlerts: open.length - quiet,
        ...(quiet ? { quietAlerts: quiet, quietNote: QUIET_NOTE } : {}),
        pendingEnrollments: fleet.pendingEnrollments,
      });
    });
    return out as CallOutput;
  },

  async server_detail(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const out = await run({ server }, async () => {
      const { id } = await resolveServer(s, server);
      const [raw, alerts, agent, asksFirst] = await Promise.all([
        serverDetailRaw(s, id),
        s.hosts.openAlertsRaw().catch(() => []),
        s.hosts.agentOf(id),
        serverAsksOf(s.call.services.db, s.call.burrowId, id),
      ]);
      // What is quiet, as the page shows it (QN-24): marked, and hints nobody watches left out.
      const d = await s.hosts.quietDetail(toHostServerDetail(raw, alerts, agent, s.call.services.clock()));
      // The waiting updates name an Install's question (server-updates.md SWU-08).
      noteWaitingUpdates(id, d.health?.system?.updates);
      // The guests are guests_list's; the detail keeps their count. Incus's and Unraid's own things in short
      // (incus_overview and unraid_overview have them whole).
      const { workloads, proxmox, incus, unraid, libvirt, alerts: open, hints, ...rest } = d;
      const lines = [...(open ?? []).map(withQuietWords), ...hints.map(withQuietWords)];
      const guests = proxmox
        ? { vm: proxmox.guests.vm?.total ?? 0, container: proxmox.guests.container?.total ?? 0 }
        : Object.fromEntries(Object.entries(workloads ?? {}).map(([k, w]) => [k, w?.total ?? 0]));
      const self = guestsOfDetail(d).find((g) => g.self);
      return output({
        ...rest,
        alerts: (open ?? []).map(withQuietWords),
        hints: hints.map(withQuietWords),
        ...quietNote(lines),
        asksFirst,
        guests,
        ...(self ? { thisWhombat: { guest: self.id, name: self.name } } : {}),
        ...(proxmox
          ? { proxmox: { cluster: proxmox.cluster, storages: proxmox.storages, backups: proxmox.backups } }
          : {}),
        ...(incus
          ? {
              incus: {
                version: incus.version,
                projects: incus.projects.map((p) => p.name),
                pools: incus.pools.map((p) => ({
                  name: p.name,
                  usedPct:
                    p.usedBytes !== null && p.totalBytes
                      ? Math.round((p.usedBytes / p.totalBytes) * 100)
                      : null,
                })),
                images: incus.images.length,
                profiles: incus.profiles.length,
                volumes: incus.volumes.length,
              },
            }
          : {}),
        ...(libvirt
          ? {
              libvirt: {
                version: libvirt.version,
                qemu: libvirt.qemu,
                pools: libvirt.pools.map((p) => ({
                  name: p.name,
                  usedPct: p.totalBytes ? Math.round((p.usedBytes / p.totalBytes) * 100) : null,
                })),
                networks: libvirt.networks.map((n) => n.name),
              },
            }
          : {}),
        ...(unraid
          ? {
              unraid: {
                version: unraid.version,
                ...(unraid.osUpdate ? { newerVersion: unraid.osUpdate.version } : {}),
                array: unraid.array.state,
                parity: unraid.array.parity.state,
                lastParityCheck: unraid.array.parity.last
                  ? { at: unraid.array.parity.last.at, errors: unraid.array.parity.last.errors }
                  : null,
                pluginUpdates: unraid.plugins.filter((p) => p.update).length,
                unreadNotifications: unraid.notifications.length,
              },
            }
          : {}),
      });
    });
    return out as CallOutput;
  },

  async server_metrics(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const rangeRaw = opt(args, 'range') ?? '24h';
    const range = HostSeriesRange.safeParse(rangeRaw);
    if (!range.success) throw new ConnectionArgumentError('range: 1h, 6h, 24h, 7d, 30d or 90d.');
    const wanted = seriesWanted(args.series);
    const out = await run({ server }, async () => {
      const { id } = await resolveServer(s, server);
      const raw = await s.hosts.call<unknown>({
        path: `${HOSTS_API}/servers/${seg(id)}/metrics`,
        query: { range: range.data, series: wanted.join(',') },
        actor: s.actor('viewer'),
      });
      const series = toHostSeries(raw, id, null, s.call.services.clock());
      return output({
        server: id,
        range: series.range,
        from: series.timestamps[0] ?? null,
        to: series.timestamps.at(-1) ?? null,
        summary: series.summary ?? {},
        points: Object.fromEntries(Object.entries(series.series).map(([k, v]) => [k, downsample(v)])),
      });
    });
    return out as CallOutput;
  },

  async guests_list(ctx, args) {
    const s = await scope(ctx);
    const server = opt(args, 'server');
    const state = opt(args, 'state');
    if (state && !['running', 'stopped', 'unhealthy'].includes(state))
      throw new ConnectionArgumentError('state: running, stopped or unhealthy.');
    const out = await run(server ? { server } : {}, async () => {
      const id = server ? (await resolveServer(s, server)).id : undefined;
      const raw = await s.hosts.call<unknown>({
        path: `${HOSTS_API}/guests`,
        query: { server: id, q: opt(args, 'q'), state, limit: 200 },
        actor: s.actor('viewer'),
      });
      const p = obj(raw);
      return output({
        total: num(p.total) ?? arr(p.guests).length,
        guests: arr(p.guests).map((g) => {
          const x = toHostGuest(g, str(obj(g).server) ?? id ?? '');
          return {
            id: x.id,
            server: x.serverId,
            name: x.name,
            kind: x.kind,
            state: x.state,
            cpuPct: x.cpuPct,
            memoryMb: x.memoryUsedMb,
            memoryLimitMb: x.memoryLimitMb,
            ...(x.addresses?.length ? { addresses: x.addresses.slice(0, 4) } : {}),
            ...(x.self ? { thisWhombat: true } : {}),
            ...(x.updateAvailable ? { updateAvailable: true } : {}),
          };
        }),
      });
    });
    return out as CallOutput;
  },

  async guest_detail(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const out = await run({ server, guest: guestArg }, async () => {
      const { id } = await resolveServer(s, server);
      const guest = await resolveGuest(s, id, guestArg);
      const agent = await s.hosts.agentOf(id);
      const rc = agent ? remoteControlFromAgent(agent) : { console: false, power: false };
      return output({
        ...guest,
        allowed: {
          power: rc.power,
          manage:
            rc.manage === true &&
            (guest.platform === 'pve' || guest.platform === 'incus' || guest.platform === 'libvirt'),
        },
        ...(guest.self
          ? {
              note: 'This is the guest this Whombat runs in: read it, snapshot it or back it up, but don’t change it.',
            }
          : {}),
      });
    });
    return out as CallOutput;
  },

  async guest_config(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const out = await run({ server, guest: guestArg }, async () => {
      const { id } = await resolveServer(s, server);
      const guest = await resolveGuest(s, id, guestArg);
      const raw = await s.hosts.call<unknown>({
        path: `${HOSTS_API}/servers/${seg(id)}/guests/${seg(guest.id)}/config`,
        actor: s.actor('operator'),
      });
      const c = toHostGuestConfig(raw);
      return output({
        server: id,
        guest: guest.id,
        name: guest.name,
        digest: c.digest,
        running: c.running,
        values: c.values,
        ...(c.pending && Object.keys(c.pending).length ? { waitingForRestart: c.pending } : {}),
        ...(c.restricted?.length ? { notChangeableHere: c.restricted } : {}),
        ...(c.profiles?.length ? { profiles: c.profiles } : {}),
        ...(c.inherited?.length ? { fromProfiles: c.inherited } : {}),
        ...(guest.self ? { thisWhombat: true } : {}),
      });
    });
    return out as CallOutput;
  },

  async guest_power(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const action = req(args, 'action');
    if (!['start', 'stop', 'shutdown', 'reboot', 'pause', 'resume'].includes(action))
      throw new ConnectionArgumentError('action: start, stop, shutdown, reboot, pause or resume.');
    const out = await run({ server, guest: guestArg }, async () => {
      const { id } = await resolveServer(s, server);
      const guest = await resolveGuest(s, id, guestArg);
      const hubAction = hubPowerAction(action, guest.kind);
      refuseSelf(guest, { action: hubAction });
      const raw = await s.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/servers/${seg(id)}/guests/${seg(guest.id)}/actions`,
        // Whombat's own approval already happened where the call asks (sensitive calls always do).
        body: {
          action: hubAction,
          ...(hubAction === 'start' || hubAction === 'resume' ? {} : { confirm: true }),
        },
        actor: s.actor('operator'),
      });
      const r = obj(raw);
      s.hosts.forget('fleet');
      // Whombat's own restart is planned work: the machine is kept quiet for it (monitoring.md MON-05).
      if (r.noop !== true && (hubAction === 'reboot' || hubAction === 'restart'))
        await keepQuietForWork(s.call.services, {
          burrowId: s.call.burrowId,
          serverId: id,
          guestId: guest.id,
          work: `power:${id}/${guest.id}:${str(r.action_id) ?? Date.now()}`,
          expectedMs: RESTART_MS,
        });
      const text = powerText(hubAction, guest.name, id);
      const inverse = r.noop === true ? null : powerInverse(hubAction, guest.kind);
      await record(s, {
        text,
        op: 'guest_power',
        serverId: id,
        guestId: guest.id,
        ids: str(r.action_id) ? { actionId: str(r.action_id) as string } : {},
        change: {
          title: text,
          undo: inverse
            ? {
                kind: 'hosts.guest_power',
                payload: { serverId: id, guestId: guest.id, guestName: guest.name, action: inverse },
              }
            : null,
        },
      });
      return output({
        accepted: true,
        ...(r.noop === true ? { note: `${guest.name} was already in that state.` } : {}),
        actionId: str(r.action_id),
        next: 'The result follows in a few seconds; guest_detail shows the new state.',
      });
    });
    return out as CallOutput;
  },

  async guest_config_set(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const digest = req(args, 'digest');
    const set =
      args.set && typeof args.set === 'object' && !Array.isArray(args.set)
        ? (args.set as Record<string, unknown>)
        : {};
    const list = (name: string) => {
      const v = args[name];
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.some((k) => typeof k !== 'string'))
        throw new ConnectionArgumentError(`${name}: a list of keys.`);
      return v as string[];
    };
    const del = list('delete');
    const revert = list('revert');
    const devices = incusDevices(args.devices);
    const profiles = optStrList(args, 'profiles', 50);
    const confirm = args.confirm === undefined || args.confirm === null ? false : args.confirm;
    if (typeof confirm !== 'boolean') throw new ConnectionArgumentError('confirm: true or false.');
    for (const [k, v] of Object.entries(set))
      if (typeof v !== 'string') throw new ConnectionArgumentError(`set.${k}: a string value.`);
    if (
      Object.keys(set).length === 0 &&
      del.length === 0 &&
      revert.length === 0 &&
      !devices &&
      profiles === null
    )
      throw new ConnectionArgumentError('Nothing to change: give set, delete, revert, devices or profiles.');
    if (del.some((k) => /^unused\d+$/.test(k)) && !confirm)
      throw new ConnectionArgumentError(
        'confirm: deleting an unused disk destroys it for good; send confirm true once that is what was asked.',
      );
    const out = await run({ server, guest: guestArg }, async () => {
      const { id } = await resolveServer(s, server);
      const guest = await resolveGuest(s, id, guestArg);
      refuseSelf(guest, { op: 'config.set' });
      if ((devices || profiles !== null) && guest.platform !== 'incus')
        throw new ConnectionArgumentError('devices, profiles: Incus guests only; on Proxmox set the keys.');
      const raw = await s.hosts.call<unknown>({
        method: 'PUT',
        path: `${HOSTS_API}/servers/${seg(id)}/guests/${seg(guest.id)}/config`,
        body: {
          digest,
          ...(Object.keys(set).length ? { set } : {}),
          ...(del.length ? { delete: del } : {}),
          ...(revert.length ? { revert } : {}),
          ...(confirm ? { confirm: true } : {}),
          ...(devices ? { devices } : {}),
          ...(profiles !== null ? { profiles } : {}),
        },
        actor: s.actor('operator'),
        timeoutMs: 60_000,
      });
      const result = toHostManageResult(raw);
      const dropped = revert.length > 0 && !del.length && !Object.keys(set).length;
      // A save names the keys it changed and merges with the saves before it (home-redesign.md HR-06).
      const keys = dropped ? [] : [...new Set((result.changes ?? []).map((c) => c.key))];
      const target = `${guest.name} on ${id}`;
      const text = dropped
        ? `Dropped the waiting changes of ${target}`
        : keys.length
          ? settingsTitle(keys, target)
          : `Changed the settings of ${target}`;
      // A deleted disk can't come back; the rest goes back to what it was.
      const undo = del.some((k) => /^unused\d+$/.test(k))
        ? null
        : configUndo(id, guest.id, guest.name, result);
      const followed = await follow(
        s,
        'guest_config_set',
        args,
        result.task?.id,
        {
          server: id,
          guest: guest.name,
        },
        {
          text,
          op: 'guest_config',
          serverId: id,
          guestId: guest.id,
          ...(result.auditId ? { ids: { auditId: result.auditId } } : {}),
          change: {
            title: text,
            detail: (result.changes ?? [])
              .slice(0, 8)
              .map(
                (c) => `${c.key}: ${c.old ?? '—'} → ${c.new ?? '—'}${c.pending ? ' (after a restart)' : ''}`,
              )
              .join('\n'),
            undo: undo ? { kind: 'hosts.guest_config', payload: undo } : null,
            ...(keys.length ? { merge: { fields: keys, target } } : {}),
          },
        },
      );
      return output({
        done: !result.task,
        changes: result.changes ?? [],
        ...(result.task ? { task: result.task.id } : {}),
        ...(followed ? { next: FOLLOWED_NOTE } : {}),
        ...((result.changes ?? []).some((c) => c.pending)
          ? { note: 'Some values apply at the next restart.' }
          : {}),
      });
    });
    return out as CallOutput;
  },

  async guest_snapshot(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const action = req(args, 'action');
    if (!['create', 'restore', 'delete'].includes(action))
      throw new ConnectionArgumentError('action: create, restore or delete.');
    const name = opt(args, 'name');
    if (action !== 'create' && !name)
      throw new ConnectionArgumentError('name: required to restore or delete.');
    if (name && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name))
      throw new ConnectionArgumentError(
        'name: 1 to 40 letters, digits, “.”, “_” or “-”, not starting with one of those.',
      );
    const out = await run({ server, guest: guestArg }, async () => {
      const { id } = await resolveServer(s, server);
      const guest = await resolveGuest(s, id, guestArg);
      const hubAction = `snapshot_${action}`;
      refuseSelf(guest, { action: hubAction });
      const description = opt(args, 'description');
      const raw = await s.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/servers/${seg(id)}/guests/${seg(guest.id)}/actions`,
        body: {
          action: hubAction,
          ...(name ? { snapshot: name } : {}),
          ...(description && action === 'create' ? { description: description.slice(0, 200) } : {}),
          ...(action === 'create' ? {} : { confirm: true }),
        },
        actor: s.actor('operator'),
      });
      const r = obj(raw);
      const text = powerText(hubAction, guest.name, id, name ?? undefined);
      await record(s, {
        text,
        op: 'guest_snapshot',
        serverId: id,
        guestId: guest.id,
        ids: str(r.action_id) ? { actionId: str(r.action_id) as string } : {},
        change: { title: text },
      });
      return output({ accepted: true, actionId: str(r.action_id) });
    });
    return out as CallOutput;
  },

  async guest_migrate(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const target = req(args, 'target');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(target))
      throw new ConnectionArgumentError('target: a node’s name.');
    const storage = opt(args, 'storage');
    if (storage && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(storage))
      throw new ConnectionArgumentError('storage: a storage’s name on the target node.');
    const out = await run({ server, guest: guestArg }, async () => {
      const { id } = await resolveServer(s, server);
      const guest = await resolveGuest(s, id, guestArg);
      refuseSelf(guest, { op: 'guest.migrate' });
      // The service moves a running VM live and a running container with a restart.
      const running = guest.state === 'running' || guest.state === 'unhealthy';
      const raw = await s.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/servers/${seg(id)}/guests/${seg(guest.id)}/migrate`,
        body: { target, ...(storage ? { storage } : {}), confirm: true },
        actor: s.actor('admin'),
        timeoutMs: 60_000,
      });
      const result = toHostManageResult(raw);
      const text = `Moved ${guest.name} from ${id} to ${target}`;
      const followed = await follow(
        s,
        'guest_migrate',
        args,
        result.task?.id,
        { server: id, guest: guest.name },
        {
          text,
          op: 'guest_migrate',
          serverId: id,
          guestId: guest.id,
          ...(result.task ? { ids: { taskId: result.task.id } } : {}),
          change: { title: text },
        },
      );
      return output({
        accepted: true,
        ...(result.task ? { task: result.task.id } : {}),
        ...(running && guest.kind === 'container'
          ? { note: `${guest.name} restarts on the way: containers can’t move while they run.` }
          : {}),
        ...(followed ? { next: FOLLOWED_NOTE } : {}),
      });
    });
    return out as CallOutput;
  },

  async alerts_list(ctx, args) {
    const s = await scope(ctx);
    const server = opt(args, 'server');
    const out = await run(server ? { server } : {}, async () => {
      const id = server ? (await resolveServer(s, server)).id : null;
      // The fleet with what is quiet (QN-24): marked, and hints nobody watches left out.
      const fleet = await s.hosts.fleet();
      const alerts = fleet.alerts.filter((a: HostAlert) => !id || a.serverId === id);
      const hints = fleet.hints.filter((h: HostHint) => !id || h.serverId === id);
      const lines = [...alerts, ...hints];
      return output({
        alerts: alerts.map((a) => ({
          id: a.id,
          server: a.serverId,
          severity: a.severity,
          title: a.title,
          detail: a.detail,
          since: a.openedAt,
          ...(a.acknowledged ? { acknowledgedBy: a.acknowledged.by, until: a.acknowledged.until } : {}),
          ...(a.muted ? { muted: true } : {}),
          ...quietWords(a.quiet),
        })),
        hints: hints.map((h) => ({
          server: h.serverId,
          severity: h.severity,
          title: h.title,
          detail: h.detail,
          ...quietWords(h.quiet),
        })),
        ...quietNote(lines),
      });
    });
    return out as CallOutput;
  },

  async alert_snooze(ctx, args) {
    const s = await scope(ctx);
    const alertId = req(args, 'alert');
    const minutes = args.minutes === undefined || args.minutes === null ? 0 : args.minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > 43_200)
      throw new ConnectionArgumentError('minutes: 0 (until it resolves) or 1 to 43200.');
    const note = opt(args, 'note');
    const out = await run({}, async () => {
      const raw = await s.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/alerts/${seg(alertId)}/ack`,
        body: { ...(minutes ? { minutes } : {}), ...(note ? { note: note.slice(0, 256) } : {}) },
        actor: s.actor('operator'),
      });
      const alert = toHostAlert(raw);
      s.hosts.forget('fleet');
      const text = minutes ? `Snoozed “${alert.title}”` : `Acknowledged “${alert.title}”`;
      await record(s, {
        text: text.slice(0, 300),
        op: 'alert_ack',
        serverId: alert.serverId ?? 'whombat',
        ids: { alertId },
        change: {
          title: text.slice(0, 200),
          subject: alert.serverId ? { kind: 'server', id: alert.serverId, name: alert.serverId } : null,
          undo: { kind: 'hosts.alert_ack', payload: { alertId, title: alert.title } },
        },
      });
      return output({ done: true, until: alert.acknowledged?.until ?? null });
    });
    return out as CallOutput;
  },

  async server_diagnose(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const check = opt(args, 'check');
    const extra = diagnoseArgs(args.args);
    if (extra && !check) throw new ConnectionArgumentError('args: give the check they are for.');
    const out = await run({ server }, async () => {
      const { id } = await resolveServer(s, server);
      const path = `${HOSTS_API}/servers/${seg(id)}/diagnose`;
      // Without a check: the catalog this server can run (WHOMBAT.md §3).
      const raw = check
        ? await s.hosts.call<unknown>({
            method: 'POST',
            path,
            body: { check, ...(extra ? { args: extra } : {}) },
            actor: s.actor('operator'),
            timeoutMs: 75_000,
          })
        : await s.hosts.call<unknown>({ path, actor: s.actor('operator') });
      return output({ ...(camelOut(raw) as Record<string, unknown>), server: id });
    });
    return out as CallOutput;
  },

  async server_disk_usage(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const mount = opt(args, 'mount');
    if (mount !== null) {
      if (
        mount.length > 512 ||
        !mount.startsWith('/') ||
        [...mount].some((c) => c.charCodeAt(0) < 0x20) ||
        mount.split('/').includes('..')
      )
        throw new ConnectionArgumentError('mount: an absolute mount point path like / or /var/lib/docker.');
    }
    const toGb = (bytes: number) => Math.round((bytes / 1e9) * 100) / 100;
    const out = await run({ server }, async () => {
      const { id } = await resolveServer(s, server);
      const raw = await s.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/servers/${seg(id)}/disk-usage`,
        body: mount ? { mount } : {},
        actor: s.actor('operator'),
        timeoutMs: 65_000,
      });
      const du = toHostDiskUsage(raw, s.call.services.clock());
      const ok = du.ok !== false && !du.code;
      const skipMessage =
        du.message ??
        (du.code === 'spun_down'
          ? 'Skipped because a backing disk is asleep; sleeping disks aren’t woken.'
          : du.code === 'standby_unknown'
            ? 'Skipped because Whombat can’t tell whether the disk is asleep; sleeping disks aren’t woken.'
            : !ok
              ? 'Could not check what fills this disk.'
              : undefined);
      return output({
        server: id,
        ok,
        ...(du.code ? { code: du.code } : {}),
        ...(skipMessage ? { message: skipMessage } : {}),
        mount: du.mount,
        ...(du.fsType ? { fsType: du.fsType } : {}),
        measuredAt: du.measuredAt,
        totalGb: toGb(du.totalBytes),
        usedGb: toGb(du.usedBytes),
        ...(du.partial ? { partial: true } : {}),
        ...(du.skippedSpunDown?.length ? { skippedSpunDown: du.skippedSpunDown } : {}),
        categories: du.categories.map((c) => ({
          key: c.key,
          label: c.label,
          gb: toGb(c.bytes),
          ...(c.reclaimableBytes ? { reclaimableGb: toGb(c.reclaimableBytes) } : {}),
          ...(c.detail ? { detail: c.detail } : {}),
        })),
        folders: du.folders.map((f) => ({
          path: f.path,
          gb: toGb(f.bytes),
          ...(f.partial ? { partial: true } : {}),
        })),
      });
    });
    return out as CallOutput;
  },

  async server_command(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const command = req(args, 'command');
    const reason = req(args, 'reason');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing line breaks and NUL is the point.
    if (command.length > 4000 || /[\r\n\u0000]/.test(command))
      throw new ConnectionArgumentError('command: one line, at most 4000 characters.');
    const out = await run({ server }, async () => {
      const { id } = await resolveServer(s, server);
      const raw = await s.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/servers/${seg(id)}/exec`,
        // The reason is the person's to read on the approval card (and in the change); the service takes the command.
        body: { command, timeout_s: 120 },
        actor: s.actor('admin'),
        timeoutMs: 150_000,
      });
      const r = obj(raw);
      const text = `Ran a command on ${id}`;
      await record(s, {
        text,
        op: 'server_command',
        serverId: id,
        ...(str(r.audit_id) ? { ids: { auditId: str(r.audit_id) as string } } : {}),
        change: { title: text, detail: `${reason.slice(0, 200)}\n${command.slice(0, 300)}` },
      });
      return output({ server: id, ...(camelOut(r) as Record<string, unknown>) });
    });
    return out as CallOutput;
  },

  /**
   * SI-10: a card in the conversation that opens Add a server filled in; the person signs in there (Whombat never signs
   * in itself and never sees the password). Only the person adds servers: an outsiders' turn is told so.
   */
  async server_add(ctx, args) {
    const s = await scope(ctx);
    const ask = addServerArgs(args);
    const out = await run({}, async () => {
      const db = s.call.services.db;
      const person = s.personId ? await loadPrincipalRow(db, s.personId) : null;
      if (person?.kind !== 'person')
        return output({ error: ONLY_PERSON_ADDS_SERVERS, code: 'owners_only' }, true);
      if (!s.call.conversationId)
        return output(
          { error: 'Ask for it in a conversation: the card goes there.', code: 'no_conversation' },
          true,
        );
      await s.call.services.pipeline
        .commit(
          askAddServer,
          { conversationId: s.call.conversationId, card: addServerCard(ask) },
          { burrowId: s.call.burrowId, actorId: s.call.agentId },
        )
        .then(committed);
      // The card says it all; nothing else goes in the chat.
      return output({ asked: true });
    });
    return out as CallOutput;
  },
};

/** What `server_add` was given, checked (SI-10). */
export interface AddServerAsk {
  address: string;
  username: string | null;
  control: HostControlLevel | null;
  name: string | null;
}

export function addServerArgs(args: Args): AddServerAsk {
  const address = req(args, 'address');
  if (address.length > 255 || !parseHostInstallAddress(address))
    throw new ConnectionArgumentError(
      'address: a host name or IP address, with :port when SSH isn’t on 22 (10.100.0.40, pve-03.lan:2222).',
    );
  const username = opt(args, 'username');
  if (username !== null && (username.length > 64 || /\s/.test(username)))
    throw new ConnectionArgumentError('username: a user name on the server, like root.');
  const control = opt(args, 'control');
  if (control !== null && !(HOST_CONTROL_LEVELS as readonly string[]).includes(control))
    throw new ConnectionArgumentError('control: watch, operate or full.');
  const name = opt(args, 'name');
  if (name !== null && name.length > 63) throw new ConnectionArgumentError('name: at most 63 characters.');
  return { address, username, control: control as HostControlLevel | null, name };
}

/** Where the card's button goes: Add a server, filled in with what was given (only that). */
export function addServerHref(ask: AddServerAsk): string {
  const q = new URLSearchParams({ add: '1', address: ask.address });
  if (ask.username) q.set('user', ask.username);
  if (ask.control) q.set('control', ask.control);
  if (ask.name) q.set('name', ask.name);
  return `/things/servers?${q.toString()}`;
}

/** The card (topic `add_server`): “Add 10.100.0.40 as a server”, one line, one button. */
export function addServerCard(ask: AddServerAsk): GuideCard {
  return makeCard({
    guide: 'add_server',
    node: 'ask',
    title: `Add ${ask.address.slice(0, 90)} as a server`,
    body: 'Sign in to it once and Whombat puts its helper on it.',
    blocks: [
      {
        type: 'actions',
        actions: [{ id: 'sign_in', label: 'Sign in…', style: 'primary', href: addServerHref(ask) }],
      },
    ],
  });
}

/** What an outsiders' turn is told when it asks to add a server: a Whombat has one person, and only they add one. */
export const ONLY_PERSON_ADDS_SERVERS = 'Only the person this Whombat belongs to adds servers.';

export { isOutput };

/** The adapter the Servers connection runs: each tool after its arguments were checked. */
export const SERVERS_ADAPTER: Adapter = Object.fromEntries(
  Object.entries({ ...TOOLS, ...MANAGE_TOOLS }).map(([name, run]) => [
    name,
    (ctx: AdapterContext, args: Args) => {
      checkArgs(name, args);
      return run(ctx, args);
    },
  ]),
);
