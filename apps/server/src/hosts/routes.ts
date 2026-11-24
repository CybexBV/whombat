/**
 * `hosts.*` (contracts 0.80.0, CT-339; one-whombat-servers.md ONE-DH05, ONE-DH09…ONE-DH13): servers through Whombat's
 * REST API. Reads ask the hosts service as the person (their id and name in `X-Whombat-Actor`) and map its JSON to the
 * contract (`map.ts`). Every change is the person's, runs on the service with the person as actor and the
 * confirmations passed through, and is then signed with `hosts.change` and recorded for Done recently (`commands.ts`). Only the oldest burrow sees servers
 * (ONE-DH02); without the service every route but `hosts.status` answers 503 `hosts_unavailable`.
 */
import {
  api,
  HOST_CONTROL_LEVEL_DEFAULT,
  HOST_DESTRUCTIVE_ACTIONS,
  type HostActionAccepted,
  type HostAlert,
  type HostFindMy,
  type HostGuestAction,
  type HostGuestDetail,
  type HostInstallBody,
  type HostManageReadResult,
  type HostManageRequest,
  type HostRemoteControl,
  type HostsStatus,
  type NoticeQuiet,
  parseHostInstallAddress,
  thingHref,
  VAULT_ENTRIES_MAX,
  VAULT_LIMIT_MESSAGES,
  VAULT_SSH_SERVERS_MAX,
} from '@whombat/core';
import { externalEffect, outsideCommandScope } from '../commit/scope';
import { hostsAlertsSince, serverFirstReportAt, serverUptime } from '../incidents/history';
import { UPTIME_WEEK_MS } from '../incidents/uptime';
import { ApiError, forbidden, notAllowed, notFound } from '../lib/errors';
import type { PrincipalRow } from '../read/principals';
import { commitAs } from '../routes/burrows';
import { type HandlerContext, type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { sshDestination } from '../vault/ssh';
import { entryCount, ownEntry, serverRows, vaultSecretAad } from '../vault/store';
import { agentUpdatesFor } from './agent-signing';
import { AGENT_UPDATE_TEXT, agentRowUpdate, startedState, toAgentSettings } from './agent-updates';
import { setServerAsks } from './asks';
import { serverAsksOf } from './asks-store';
import { HOSTS_API, type HostsActor, HostsUnavailable, networksOf, poolsOf, seg } from './client';
import { type HostsChangeInput, recordHostsChange } from './commands';
import { type HostsNames, hostsCall, refusedBeforeActing } from './errors';
import { findMyFor } from './findmy';
import { findMyBackgroundFor } from './findmy-background';
import { type InstallPlan, installsFor } from './install';
import {
  ADDRESS_FIELD_TEXT,
  INSTALL_KEY_TEXT,
  INSTALL_LIMIT_TEXT,
  VAULT_SSH_USERNAME_MAX,
} from './install-words';
import {
  arr,
  camel,
  obj,
  remoteControlFromAgent,
  str,
  toConsoleSession,
  toHostAlert,
  toHostBackupJob,
  toHostBackupVolumes,
  toHostCheck,
  toHostChoices,
  toHostDiskUsage,
  toHostEnrollment,
  toHostFirewall,
  toHostGuest,
  toHostGuestConfig,
  toHostGuestLog,
  toHostGuestPage,
  toHostIncusProfile,
  toHostInspect,
  toHostMaintenance,
  toHostManageResult,
  toHostNetworkLeases,
  toHostPendingEnrollment,
  toHostSeries,
  toHostServerDetail,
  toHostServerSettings,
  toHostSnapshots,
  toHostTask,
} from './map';
import { serverSettingsFields, settingsTitle } from './merge';
import { nameClash, renameServer } from './names';
import { serverNameOf as givenNameOf, loadServerNames } from './names-store';
import { canManageServers, ONLY_YOU_CHANGE_SERVERS_TEXT } from './person';
import { quietAlertById } from './quiet';
import { HEARTBEAT_RULE } from './quiet-lines';
import { REPOINT_TEXT, RepointBusy, type RepointView, repointsFor } from './repoint';
import {
  destructiveActionText,
  isScreenRead,
  screenChangeText,
  screenStep,
  screenStepIsEveryday,
} from './screen';
import { knownServer, SELF_GUEST_TEXT, selfActionRefused, selfOpRefused, serverLabel } from './self';
import { actorOf, HOSTS_TEXT, type HostsService, hostsFor } from './service';
import { hostsAddressChange } from './sources';
import { configUndo, powerInverse, powerText, settingsUndo } from './undo';
import { listWords, updateChangeText } from './updates';

type Ctx = HandlerContext<(typeof api.hosts)[keyof typeof api.hosts]>;

interface Guarded {
  hosts: HostsService;
  person: PrincipalRow;
  actor: HostsActor;
  manages: boolean;
}

/** The service, if this burrow sees servers; the person as the actor, with the hosts role their place gives. */
async function guard(ctx: AlertCtx, options: { manage?: boolean } = {}): Promise<Guarded> {
  const hosts = hostsFor(ctx.services);
  const person = ctx.access.principal;
  if (person.kind !== 'person')
    throw forbidden('Servers are for people here; assistants use the Servers tools.');
  if (!hosts.present)
    throw new ApiError('unavailable', HOSTS_TEXT.absent, { details: { code: 'hosts_unavailable' } });
  if (!(await hosts.serves(ctx.access.burrow.id)))
    throw new ApiError('unavailable', HOSTS_TEXT.otherBurrow, { details: { code: 'hosts_unavailable' } });
  const manages = canManageServers(person);
  if (options.manage && !manages) throw forbidden(ONLY_YOU_CHANGE_SERVERS_TEXT);
  // The person acts as admin on the service; anyone else only reads (a second line behind Whombat's own rule).
  return { hosts, person, manages, actor: actorOf(person, manages ? 'admin' : 'viewer', null) };
}

/** Reads that the service checks at operator (inspect views, manage reads): Whombat already allowed them. */
const asOperator = (g: Guarded): HostsActor => ({ ...g.actor, role: g.manages ? 'admin' : 'operator' });

/** A change on the service, run as an external effect before the record; a refusal is the service's, in our words. */
async function act<T>(label: string, names: HostsNames, fn: () => Promise<T>): Promise<T> {
  return hostsCall(
    () =>
      externalEffect(`hosts.${label}`, fn, {
        refused: (err) =>
          refusedBeforeActing(err) ||
          (err instanceof HostsUnavailable && err.reason !== 'timeout' && err.reason !== 'broken'),
      }),
    names,
  );
}

/** Signs a change once the service did it (and records it for Done recently). */
async function sign(ctx: AlertCtx, input: HostsChangeInput): Promise<string> {
  const { eventId } = await commitAs(ctx, recordHostsChange, input);
  return eventId;
}

const S = (serverId: string) => `${HOSTS_API}/servers/${seg(serverId)}`;

/** A Find My answer with how its Mac is read in the background (null: only while someone looks). */
function withBackground(services: Services, view: HostFindMy): HostFindMy {
  return { ...view, background: findMyBackgroundFor(services).about(view.server) };
}
const G = (serverId: string, guestId: string) => `${S(serverId)}/guests/${seg(guestId)}`;

/** A guest's display name for texts (its name, else its id) and whether it is the guest this Whombat runs in. */
async function guestInfo(
  g: Guarded,
  serverId: string,
  guestId: string,
): Promise<{ name: string; self: boolean }> {
  try {
    const raw = obj(await g.hosts.call<unknown>({ path: G(serverId, guestId), actor: g.actor }));
    return { name: str(raw.name) || guestId, self: raw.self === true };
  } catch {
    return { name: guestId, self: false };
  }
}

/** The name messages give a server (“The Titan”, “BlackBox”), from the fleet; its id when the fleet doesn't know it. */
async function shownNameOf(g: Guarded, serverId: string): Promise<string> {
  if (!knownServer(serverId)) await g.hosts.fleetRaw().catch(() => null);
  return serverLabel(serverId);
}

/** What a server goes by without a given name: its host name's capitals (“BlackBox”), else its id. */
function plainNameOf(fleet: unknown, serverId: string): string {
  const card = arr(obj(fleet).servers)
    .map(obj)
    .find((c) => typeof c.id === 'string' && c.id.toLowerCase() === serverId.toLowerCase());
  const hostname = card ? str(card.hostname) : null;
  return hostname && hostname.toLowerCase() === serverId.toLowerCase() ? hostname : serverId;
}

/**
 * Names a server (or puts its id back), refused before the commit when another server goes by that name: its id,
 * host name or given name, ignoring case.
 */
async function renameServerAs(ctx: Ctx, g: Guarded, serverId: string, name: string | null): Promise<void> {
  const fleet = await g.hosts.fleetRaw();
  const names = await loadServerNames(ctx.services.db, ctx.access.burrow.id);
  const clash = name ? nameClash(fleet, names, serverId, name) : null;
  if (clash) throw new ApiError('conflict', clash, { fields: { name: [clash] } });
  await commitAs(ctx, renameServer, {
    serverId,
    shownBefore: serverLabel(serverId),
    plainName: plainNameOf(fleet, serverId),
    name,
  });
}

/** The refusal of a change to the guest this Whombat runs in (IU-02), before the hub is asked. */
export function selfGuestRefusal(): ApiError {
  return new ApiError('conflict', SELF_GUEST_TEXT, { details: { code: 'self_guest' } });
}

/* Alerts --------------------------------------------------------------------------------------------------------- */

/** The route context the alert helpers need (also Watch's `watch.acknowledge`, contracts 0.80.1, CT-349). */
export type AlertCtx = Pick<Ctx, 'services' | 'access'>;

/**
 * Acknowledges (`minutes` 0 or absent: until it resolves) or snoozes an alert on the hosts service as the person, then
 * signs it with Undo (ONE-DH05).
 */
export async function ackHostsAlert(
  ctx: AlertCtx,
  alertId: string,
  body: { note?: string; minutes?: number } = {},
): Promise<HostAlert> {
  const g = await guard(ctx);
  const raw = await act('ackAlert', {}, () =>
    g.hosts.call<unknown>({
      method: 'POST',
      path: `${HOSTS_API}/alerts/${seg(alertId)}/ack`,
      body: {
        ...(body.note ? { note: body.note } : {}),
        ...(body.minutes ? { minutes: body.minutes } : {}),
      },
      // Acknowledging is an operator's on the service (ONE-DH05).
      actor: asOperator(g),
    }),
  );
  const alert = toHostAlert(raw);
  g.hosts.forget('fleet');
  const minutes = body.minutes ?? 0;
  const text = minutes
    ? `Snoozed “${alert.title}” for ${minutesText(minutes)}`
    : `Acknowledged “${alert.title}”`;
  await sign(ctx, {
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
  return alert;
}

/** Takes an alert's acknowledgement or snooze back on the hosts service. */
export async function unackHostsAlert(ctx: AlertCtx, alertId: string): Promise<HostAlert> {
  const g = await guard(ctx);
  const raw = await act('unackAlert', {}, () =>
    g.hosts.call<unknown>({
      method: 'DELETE',
      path: `${HOSTS_API}/alerts/${seg(alertId)}/ack`,
      actor: asOperator(g),
    }),
  );
  const alert = toHostAlert(raw);
  g.hosts.forget('fleet');
  await sign(ctx, {
    text: `Took back the snooze of “${alert.title}”`.slice(0, 300),
    op: 'alert_unack',
    serverId: alert.serverId ?? 'whombat',
    ids: { alertId },
  });
  return alert;
}

/**
 * Needs you's and Watch's shared Ignore, Remind me tomorrow and Undo on a server alert (quiet-notices.md QN-21, QN-23):
 * the hosts service's acknowledgement until it resolves, until 09:00 tomorrow in the burrow's zone (or `until`), or
 * taken back, signed in the server's Activity. The person only (QN-10: `not_allowed` for anyone else); `not_found` for
 * an alert that isn't open. The alert's quiet after it, null after Undo.
 */
export async function quietHostsAlert(
  ctx: AlertCtx,
  alertId: string,
  how: 'ignore' | 'snooze' | 'undo',
  until?: string,
): Promise<NoticeQuiet | null> {
  const g = await guard(ctx);
  if (!g.manages) throw notAllowed('Only you can quiet what Whombat watches on a server.');
  return quietAlertById(ctx.services, {
    burrowId: ctx.access.burrow.id,
    actorId: g.person.id,
    alertId,
    how,
    ...(until ? { until } : {}),
  });
}

/* Status --------------------------------------------------------------------------------------------------------- */

async function status(ctx: Ctx): Promise<HostsStatus> {
  const hosts = hostsFor(ctx.services);
  if (!hosts.present) return { present: false, healthy: false, reason: HOSTS_TEXT.absent };
  if (!(await hosts.serves(ctx.access.burrow.id)))
    return { present: false, healthy: false, reason: HOSTS_TEXT.otherBurrow };
  const health = await hosts.health();
  if (!health.healthy) return { present: true, healthy: false, reason: health.reason ?? HOSTS_TEXT.down };
  const [hub, fleet] = await Promise.all([
    hosts.hubInfo().catch(() => null),
    hosts.fleetRaw().catch(() => null),
  ]);
  const out: HostsStatus = { present: true, healthy: true };
  const version = str(obj(hub).version);
  if (version) out.version = version.slice(0, 60);
  const agentUrl = str(obj(hub).agents_url) || str(obj(hub).agent_url);
  if (agentUrl) out.agentUrl = agentUrl.slice(0, 300);
  if (fleet) out.servers = arr(fleet.servers).length;
  return out;
}

/* Servers -------------------------------------------------------------------------------------------------------- */

const guestPowerNames = (serverId: string, guest: string) => ({ server: serverId, guest });

function accepted(raw: unknown): HostActionAccepted {
  const r = obj(raw);
  return {
    actionId: str(r.action_id) || 'unknown',
    ...(str(r.audit_id) ? { auditId: str(r.audit_id) as string } : {}),
    ...(r.noop === true ? { noop: true } : {}),
  };
}

/** The settings patch in the service's words. */
function settingsBody(body: {
  group?: string;
  location?: string;
  parent?: string;
  remoteControl?: Partial<Record<string, boolean>>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.group !== undefined) out.group = body.group;
  if (body.location !== undefined) out.location = body.location;
  if (body.parent !== undefined) out.parent = body.parent;
  if (body.remoteControl) {
    const rc: Record<string, boolean> = {};
    const names: Record<string, string> = {
      console: 'console',
      power: 'power',
      hostShell: 'host_shell',
      hostPower: 'host_power',
      manage: 'manage',
      diagnose: 'diagnose',
    };
    for (const [k, v] of Object.entries(body.remoteControl))
      if (typeof v === 'boolean' && names[k]) rc[names[k] as string] = v;
    out.remote_control = rc;
  }
  return out;
}

/* Manage --------------------------------------------------------------------------------------------------------- */

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** A manage op's route on the service: method, path, which params become path parts, query or body. */
interface ManageRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `platform`: the request's (`libvirt` pool volumes live under `/libvirt/…`, Incus's under `/incus/…`). */
  path: (
    server: string,
    guest: string | null,
    p: Record<string, unknown>,
    platform?: string | null,
  ) => string;
  /** Body fields the route takes (snake_case), from `params` and the request's `digest`/`confirm`. */
  body?: readonly string[];
  /** Query fields (DELETE routes). */
  query?: readonly string[];
  /** Params that become parts of the path (`disk`, `pos`, `jobId`, …; as `params` names them). */
  pathParams?: readonly string[];
  /** A host route that also names a guest: the request's `guestId` goes into this field (a restore over a guest). */
  guestField?: string;
  /** Params the service takes under another name (`template` → `image` for an Incus create, 0.83). */
  alias?: Readonly<Record<string, string>>;
  guest: boolean;
}

const need = (p: Record<string, unknown>, name: string): string => {
  const v = p[name];
  if (typeof v !== 'string' && typeof v !== 'number') throw new ApiError('bad_request', `${name}: required.`);
  return seg(String(v));
};

/** A backup job's fields as the service takes them (snake_case of `HostBackupJobParams` without the job's id). */
const BACKUP_JOB_FIELDS = [
  'enabled',
  'schedule',
  'storage',
  'node',
  'selection',
  'guests',
  'exclude',
  'pool',
  'mode',
  'compress',
  'keep',
  'notes_template',
  'comment',
] as const;

export const MANAGE_ROUTES: Record<HostManageRequest['op'], ManageRoute> = {
  'config.set': {
    method: 'PUT',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/config`,
    // Incus (0.83): devices and the profiles it uses ride along.
    body: ['digest', 'set', 'delete', 'revert', 'confirm', 'devices', 'profiles'],
  },
  'disk.resize': {
    method: 'POST',
    guest: true,
    path: (s, g, p) => `${G(s, g as string)}/disks/${need(p, 'disk')}/resize`,
    pathParams: ['disk'],
    body: ['size'],
  },
  'disk.move': {
    method: 'POST',
    guest: true,
    path: (s, g, p) => `${G(s, g as string)}/disks/${need(p, 'disk')}/move`,
    pathParams: ['disk'],
    body: ['storage', 'delete_source'],
  },
  'guest.create': {
    method: 'POST',
    guest: false,
    path: (s) => `${S(s)}/guests`,
    alias: { template: 'image' },
    body: [
      'platform',
      'kind',
      'new_id',
      'name',
      'set',
      'start',
      'image',
      'profiles',
      'project',
      'pool',
      'network',
      'cloud_init',
      // libvirt (0.84, IU-13): an OS type, the ISO, the disk's pool or folder and size, a network or a bridge.
      'os_variant',
      'iso',
      'storage',
      'disk_gb',
      'bridge',
    ],
  },
  'guest.clone': {
    method: 'POST',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/clone`,
    body: ['new_id', 'name', 'full', 'storage', 'project', 'instance_only'],
  },
  'guest.template': {
    method: 'POST',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/template`,
    body: ['confirm'],
  },
  'guest.delete': {
    method: 'DELETE',
    guest: true,
    path: (s, g) => G(s, g as string),
    query: ['confirm_name', 'purge'],
  },
  'guest.migrate': {
    method: 'POST',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/migrate`,
    body: ['target', 'storage', 'digest', 'confirm'],
  },
  'backup.create': {
    method: 'POST',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/backups`,
    body: [
      'storage',
      'mode',
      'compress',
      'notes',
      'protected',
      'name',
      'expires_at',
      'instance_only',
      'optimized',
      'compression',
    ],
  },
  'backup.restore': {
    method: 'POST',
    guest: false,
    path: (s) => `${S(s)}/backups/restore`,
    guestField: 'guest',
    // Incus: `guest` is whose backup and `name` the new instance (a restore there never goes over a guest).
    body: ['platform', 'volume', 'new_id', 'guest', 'name', 'storage', 'start', 'unique', 'confirm'],
  },
  'backup.update': {
    method: 'PATCH',
    guest: false,
    path: (s) => `${S(s)}/backups`,
    body: ['platform', 'volume', 'notes', 'protected'],
  },
  'backup.delete': {
    method: 'DELETE',
    guest: false,
    path: (s) => `${S(s)}/backups`,
    guestField: 'guest',
    query: ['platform', 'guest', 'volume'],
  },
  'content.download': {
    method: 'POST',
    guest: false,
    path: (s, _g, p) => `${S(s)}/storage/${need(p, 'storage')}/download`,
    pathParams: ['storage'],
    body: ['platform', 'content', 'url', 'filename', 'checksum', 'checksum_algorithm'],
  },
  'content.delete': {
    method: 'DELETE',
    guest: false,
    path: (s) => `${S(s)}/storage/content`,
    query: ['platform', 'volume'],
  },
  'appliance.download': {
    method: 'POST',
    guest: false,
    path: (s, _g, p) => `${S(s)}/storage/${need(p, 'storage')}/appliances`,
    pathParams: ['storage'],
    body: ['platform', 'template'],
  },
  'task.stop': {
    method: 'DELETE',
    guest: false,
    path: (s, _g, p) => `${S(s)}/tasks/${need(p, 'task')}`,
    pathParams: ['task'],
    query: ['platform'],
  },
  'firewall.options': {
    method: 'PUT',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/firewall/options`,
    body: ['digest', 'set', 'delete'],
  },
  'firewall.rule_add': {
    method: 'POST',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/firewall/rules`,
    body: ['rule'],
  },
  'firewall.rule_update': {
    method: 'PUT',
    guest: true,
    path: (s, g, p) => `${G(s, g as string)}/firewall/rules/${need(p, 'pos')}`,
    pathParams: ['pos'],
    body: ['digest', 'rule', 'move_to'],
  },
  'firewall.rule_delete': {
    method: 'DELETE',
    guest: true,
    path: (s, g, p) => `${G(s, g as string)}/firewall/rules/${need(p, 'pos')}`,
    pathParams: ['pos'],
    query: ['digest'],
  },
  'ha.set': {
    method: 'PUT',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/ha`,
    body: ['state', 'max_restart', 'max_relocate', 'comment'],
  },
  'ha.remove': { method: 'DELETE', guest: true, path: (s, g) => `${G(s, g as string)}/ha` },
  'replication.add': {
    method: 'POST',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/replication`,
    body: ['target', 'schedule', 'rate', 'comment'],
  },
  'replication.delete': {
    method: 'DELETE',
    guest: true,
    path: (s, g, p) => `${G(s, g as string)}/replication/${need(p, 'job')}`,
    pathParams: ['job'],
  },
  // Backup jobs (PX-03, docs/implementation/proxmox/assignment.md §2.1).
  'backupjob.create': {
    method: 'POST',
    guest: false,
    path: (s) => `${S(s)}/backup-jobs`,
    body: BACKUP_JOB_FIELDS,
  },
  'backupjob.update': {
    method: 'PUT',
    guest: false,
    path: (s, _g, p) => `${S(s)}/backup-jobs/${need(p, 'jobId')}`,
    pathParams: ['jobId'],
    body: ['digest', ...BACKUP_JOB_FIELDS],
  },
  'backupjob.delete': {
    method: 'DELETE',
    guest: false,
    path: (s, _g, p) => `${S(s)}/backup-jobs/${need(p, 'jobId')}`,
    pathParams: ['jobId'],
    query: ['confirm'],
  },
  'backupjob.run': {
    method: 'POST',
    guest: false,
    path: (s, _g, p) => `${S(s)}/backup-jobs/${need(p, 'jobId')}/run`,
    pathParams: ['jobId'],
  },
  // Incus (0.83, CT-364; the Incus and unRAID build brief §2.2).
  'guest.rename': {
    method: 'POST',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/rename`,
    body: ['name'],
  },
  'guest.move': {
    method: 'POST',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/move`,
    body: ['pool', 'project', 'confirm'],
  },
  'guest.publish': {
    method: 'POST',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/publish`,
    body: ['alias', 'description', 'snapshot'],
  },
  'image.download': {
    method: 'POST',
    guest: false,
    path: (s) => `${S(s)}/incus/images`,
    body: ['alias', 'type', 'project', 'auto_update'],
  },
  'image.refresh': {
    method: 'POST',
    guest: false,
    path: (s, _g, p) => `${S(s)}/incus/images/${need(p, 'fingerprint')}/refresh`,
    pathParams: ['fingerprint'],
    body: ['project'],
  },
  'image.delete': {
    method: 'DELETE',
    guest: false,
    path: (s, _g, p) => `${S(s)}/incus/images/${need(p, 'fingerprint')}`,
    pathParams: ['fingerprint'],
    query: ['project', 'confirm'],
  },
  'profile.create': {
    method: 'POST',
    guest: false,
    path: (s) => `${S(s)}/incus/profiles`,
    body: ['name', 'description', 'copy_from', 'project'],
  },
  'profile.update': {
    method: 'PUT',
    guest: false,
    path: (s, _g, p) => `${S(s)}/incus/profiles/${need(p, 'profile')}`,
    pathParams: ['profile'],
    body: ['project', 'digest', 'set', 'delete', 'devices', 'description'],
  },
  'profile.delete': {
    method: 'DELETE',
    guest: false,
    path: (s, _g, p) => `${S(s)}/incus/profiles/${need(p, 'profile')}`,
    pathParams: ['profile'],
    query: ['project', 'confirm'],
  },
  // A pool's volumes: Incus's custom volumes, or (`platform: libvirt`, 0.84) a libvirt pool's.
  'volume.create': {
    method: 'POST',
    guest: false,
    path: (s, _g, p, platform) => `${poolsOf(s, platform)}/${need(p, 'pool')}/volumes`,
    pathParams: ['pool'],
    body: ['name', 'size', 'content_type', 'format', 'project', 'description'],
  },
  'volume.resize': {
    method: 'POST',
    guest: false,
    path: (s, _g, p, platform) =>
      `${poolsOf(s, platform)}/${need(p, 'pool')}/volumes/${need(p, 'volume')}/resize`,
    pathParams: ['pool', 'volume'],
    body: ['size', 'project'],
  },
  'volume.delete': {
    method: 'DELETE',
    guest: false,
    path: (s, _g, p, platform) => `${poolsOf(s, platform)}/${need(p, 'pool')}/volumes/${need(p, 'volume')}`,
    pathParams: ['pool', 'volume'],
    query: ['project', 'confirm'],
  },
  // unRAID (0.83, CT-365; §2.3): each command is an agent task on the server.
  'array.start': { method: 'POST', guest: false, path: (s) => `${S(s)}/unraid/array/start` },
  'array.stop': {
    method: 'POST',
    guest: false,
    path: (s) => `${S(s)}/unraid/array/stop`,
    body: ['confirm'],
  },
  'parity.start': {
    method: 'POST',
    guest: false,
    path: (s) => `${S(s)}/unraid/parity/start`,
    body: ['correct'],
  },
  'parity.pause': { method: 'POST', guest: false, path: (s) => `${S(s)}/unraid/parity/pause` },
  'parity.resume': { method: 'POST', guest: false, path: (s) => `${S(s)}/unraid/parity/resume` },
  'parity.cancel': {
    method: 'POST',
    guest: false,
    path: (s) => `${S(s)}/unraid/parity/cancel`,
    body: ['confirm'],
  },
  'disk.spin_up': {
    method: 'POST',
    guest: false,
    path: (s, _g, p) => `${S(s)}/unraid/disks/${need(p, 'disk')}/spin-up`,
    pathParams: ['disk'],
  },
  'disk.spin_down': {
    method: 'POST',
    guest: false,
    path: (s, _g, p) => `${S(s)}/unraid/disks/${need(p, 'disk')}/spin-down`,
    pathParams: ['disk'],
  },
  'mover.start': { method: 'POST', guest: false, path: (s) => `${S(s)}/unraid/mover` },
  'plugin.check': { method: 'POST', guest: false, path: (s) => `${S(s)}/unraid/plugins/check` },
  'plugin.update': {
    method: 'POST',
    guest: false,
    path: (s, _g, p) => `${S(s)}/unraid/plugins/${need(p, 'plugin')}/update`,
    pathParams: ['plugin'],
    body: ['confirm'],
  },
  'notification.archive': {
    method: 'POST',
    guest: false,
    path: (s) => `${S(s)}/unraid/notifications/archive`,
    body: ['id'],
  },
  'container.update': {
    method: 'POST',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/update`,
    body: ['confirm'],
  },
  'containers.check': { method: 'POST', guest: false, path: (s) => `${S(s)}/unraid/containers/check` },
  'guest.autostart': {
    method: 'PUT',
    guest: true,
    path: (s, g) => `${G(s, g as string)}/autostart`,
    body: ['on'],
  },
  // The server's operating-system updates (0.98, server-updates.md SWU-02): a task `pkg:…` on the server each.
  'packages.check': { method: 'POST', guest: false, path: (s) => `${S(s)}/packages/check`, body: [] },
  'packages.install': {
    method: 'POST',
    guest: false,
    path: (s) => `${S(s)}/packages/install`,
    body: ['packages', 'confirm'],
  },
};

/** A param the op's route doesn't pass is refused, naming it (PX-08: dropping it silently changed the outcome). */
function refuseParam(name: string): ApiError {
  return new ApiError('validation_failed', `This change doesn’t take “${name}”.`, {
    fields: { [`params.${name}`]: ['Not taken by this change.'] },
  });
}

/** A manage request as the service's call (pure; tested). */
export function manageCall(
  serverId: string,
  req: HostManageRequest,
): {
  method: ManageRoute['method'];
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
} {
  const r = MANAGE_ROUTES[req.op];
  if (r.guest && !req.guestId) throw new ApiError('bad_request', 'guestId: required for this change.');
  const takes = new Set([...(r.body ?? []), ...(r.query ?? []), ...(r.pathParams ?? [])]);
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.params ?? {})) {
    const name = r.alias?.[k] ?? snake(k);
    if (!takes.has(name) && !r.pathParams?.includes(k)) throw refuseParam(k);
    if (r.alias?.[k] && fields[name] !== undefined && fields[name] !== v)
      throw new ApiError('validation_failed', `${k} and ${name} say different things.`, {
        fields: { [`params.${k}`]: [`Not the same as ${name}.`] },
      });
    fields[name] = v;
  }
  // A restore over a guest names it as the request's guest (it restored as a new guest before, PX-08).
  if (r.guestField && req.guestId) {
    const given = fields[r.guestField];
    if (given !== undefined && given !== req.guestId)
      throw new ApiError('validation_failed', 'guestId and params.guest name different guests.', {
        fields: { [`params.${r.guestField}`]: ['Not the same guest as guestId.'] },
      });
    fields[r.guestField] = req.guestId;
  }
  if (req.digest !== undefined) fields.digest = req.digest;
  if (req.confirm !== undefined) fields.confirm = req.confirm;
  if (req.confirmName !== undefined) fields.confirm_name = req.confirmName;
  if (req.platform !== undefined && fields.platform === undefined) fields.platform = req.platform;
  const platform = req.platform ?? (typeof req.params?.platform === 'string' ? req.params.platform : null);
  const path = r.path(serverId, req.guestId ?? null, req.params ?? {}, platform);
  if (r.query) {
    const query: Record<string, string> = {};
    for (const k of r.query) {
      const v = fields[k];
      if (v === undefined || v === null) continue;
      query[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    }
    return { method: r.method, path, query };
  }
  const body: Record<string, unknown> = {};
  for (const k of r.body ?? []) if (fields[k] !== undefined) body[k] = fields[k];
  // An Install always confirms (the hub's admin route wants it): the person confirmed it on the page (SWU-S02).
  if (req.op === 'packages.install') body.confirm = true;
  return r.body ? { method: r.method, path, body } : { method: r.method, path };
}

const MANAGE_TEXT: Partial<Record<HostManageRequest['op'], string>> = {
  'config.set': 'Changed the settings of',
  'disk.resize': 'Grew a disk of',
  'disk.move': 'Moved a disk of',
  'guest.create': 'Created a guest on',
  'guest.clone': 'Cloned',
  'guest.template': 'Made a template of',
  'guest.delete': 'Deleted',
  'guest.migrate': 'Moved',
  'backup.create': 'Started a backup of',
  'backup.restore': 'Restored a backup on',
  'backup.update': 'Changed a backup on',
  'backup.delete': 'Deleted a backup on',
  'content.download': 'Downloaded to a storage of',
  'content.delete': 'Deleted from a storage of',
  'appliance.download': 'Downloaded a template to',
  'task.stop': 'Stopped a task on',
  'firewall.options': 'Changed the firewall of',
  'firewall.rule_add': 'Added a firewall rule to',
  'firewall.rule_update': 'Changed a firewall rule of',
  'firewall.rule_delete': 'Removed a firewall rule of',
  'ha.set': 'Changed high availability of',
  'ha.remove': 'Took high availability off',
  'replication.add': 'Added replication to',
  'replication.delete': 'Removed replication from',
  'backupjob.create': 'Added a backup job on',
  'backupjob.update': 'Changed a backup job on',
  'backupjob.delete': 'Deleted a backup job on',
  'backupjob.run': 'Started a backup job on',
  'guest.publish': 'Made an image of',
  'image.download': 'Downloaded an image to',
  'image.refresh': 'Refreshed an image on',
  'image.delete': 'Deleted an image on',
  'array.start': 'Started the array of',
  'array.stop': 'Stopped the array of',
  'parity.pause': 'Paused the parity check on',
  'parity.resume': 'Resumed the parity check on',
  'parity.cancel': 'Cancelled the parity check on',
  'mover.start': 'Started the mover on',
  'plugin.check': 'Checked for plugin updates on',
  'container.update': 'Updated',
  'containers.check': 'Checked for container updates on',
};

/** An Install's named packages for Done recently's detail (“Only nginx and openssl”), or null. */
export function packagesDetail(raw: unknown): string | null {
  const names = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p !== '') : [];
  return names.length ? `Only ${listWords(names, 10)}`.slice(0, 1000) : null;
}

/** A param as words for a change's title (a name, at most 60 characters), or null. */
const paramWord = (params: Readonly<Record<string, unknown>>, key: string): string | null => {
  const v = params[key];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null;
};

/** “Changed the settings of web on pve-02”, “Deleted a backup on pve-02”, “Renamed web on the-titan to web2”. */
export function manageText(
  op: HostManageRequest['op'],
  serverId: string,
  guest: string | null,
  params: Readonly<Record<string, unknown>> = {},
): string {
  // What people call the server (its given name, else its id).
  const server = serverLabel(serverId);
  const on = guest ? `${guest} on ${server}` : server;
  const p = (key: string) => paramWord(params, key);
  switch (op) {
    case 'backup.restore':
      if (params.platform === 'incus' && guest)
        return `Restored a copy of ${guest} on ${server}${p('name') ? ` as ${p('name')}` : ''}`;
      if (guest) return `Restored ${guest} on ${server} from a backup`;
      break;
    case 'guest.rename':
      return p('name') ? `Renamed ${on} to ${p('name')}` : `Renamed ${on}`;
    case 'guest.move': {
      const where = [p('pool') && `the pool ${p('pool')}`, p('project') && `the project ${p('project')}`]
        .filter(Boolean)
        .join(' and ');
      return where ? `Moved ${on} to ${where}` : `Moved ${on}`;
    }
    case 'image.download':
      return p('alias')
        ? `Downloaded the image ${p('alias')} to ${server}`
        : `Downloaded an image to ${server}`;
    case 'profile.create':
    case 'profile.update':
    case 'profile.delete': {
      const verb = op === 'profile.create' ? 'Added' : op === 'profile.update' ? 'Changed' : 'Deleted';
      return `${verb} the profile ${p('profile') ?? p('name') ?? ''} on ${server}`.replace('  ', ' ');
    }
    case 'volume.create':
      return `Added the volume ${p('name') ?? ''} to ${p('pool') ?? 'a pool'} on ${server}`.replace(
        '  ',
        ' ',
      );
    case 'volume.resize':
      return `Grew the volume ${p('volume') ?? ''} on ${server}`.replace('  ', ' ');
    case 'volume.delete':
      return `Deleted the volume ${p('volume') ?? ''} on ${server}`.replace('  ', ' ');
    case 'parity.start':
      return params.correct === true
        ? `Started a parity check with corrections on ${server}`
        : `Started a parity check on ${server}`;
    case 'disk.spin_up':
    case 'disk.spin_down': {
      const how = op === 'disk.spin_up' ? 'Spun up' : 'Spun down';
      const disk = p('disk');
      return !disk || disk === 'all' ? `${how} every disk of ${server}` : `${how} ${disk} on ${server}`;
    }
    case 'plugin.update': {
      const plugin = p('plugin');
      return !plugin || plugin === 'all'
        ? `Updated the plugins on ${server}`
        : `Updated the plugin ${plugin.replace(/\.plg$/, '')} on ${server}`;
    }
    case 'notification.archive':
      return p('id') ? `Archived a notification on ${server}` : `Archived the notifications on ${server}`;
    case 'guest.autostart':
      return params.on === false ? `${on} no longer starts by itself` : `${on} starts with its server now`;
    case 'packages.check':
    case 'packages.install':
      return updateChangeText(op, server);
    default:
      break;
  }
  const verb = MANAGE_TEXT[op] ?? 'Changed';
  return guest ? `${verb} ${guest} on ${server}` : `${verb} ${server}`;
}

async function manageRead(ctx: Ctx, g: Guarded): Promise<HostManageReadResult> {
  const q = ctx.query as {
    op: HostManageReadResult['op'];
    guestId?: string;
    platform?: 'pve' | 'incus' | 'unraid' | 'libvirt';
    storage?: string;
    content?: string;
    project?: string;
    profile?: string;
    network?: string;
    lines?: number;
  };
  const serverId = (ctx.params as { serverId: string }).serverId;
  const guest = q.guestId ?? null;
  const needGuest = () => {
    if (!guest) throw new ApiError('bad_request', 'guestId: required for this read.');
    return guest;
  };
  const read = <T>(path: string, query?: Record<string, string | undefined>) =>
    hostsCall(() => g.hosts.call<T>({ path, query, actor: asOperator(g) }), { server: serverId });
  switch (q.op) {
    case 'config.get':
      return { op: q.op, config: toHostGuestConfig(await read(`${G(serverId, needGuest())}/config`)) };
    case 'choices':
      return {
        op: q.op,
        choices: toHostChoices(
          await read(`${S(serverId)}/manage/choices`, { platform: q.platform, project: q.project }),
        ),
      };
    case 'backup.list':
      return { op: q.op, items: toHostBackupVolumes(await read(`${G(serverId, needGuest())}/backups`)) };
    case 'content.list': {
      if (!q.storage) throw new ApiError('bad_request', 'storage: required for this read.');
      const raw = await read(`${S(serverId)}/storage/${seg(q.storage)}/content`, {
        platform: q.platform,
        content: q.content,
      });
      return { op: q.op, items: arr(obj(raw).items).map((i) => camel(i) as Record<string, never>) };
    }
    case 'appliance.list': {
      const raw = await read(`${S(serverId)}/appliances`, { platform: q.platform });
      return { op: q.op, items: arr(obj(raw).items).map((i) => camel(i) as Record<string, never>) };
    }
    case 'task.list': {
      const raw = await read(guest ? `${G(serverId, guest)}/tasks` : `${S(serverId)}/tasks`, {
        platform: q.platform,
      });
      return { op: q.op, items: arr(obj(raw).items).map(toHostTask) };
    }
    case 'firewall.get':
      return { op: q.op, firewall: toHostFirewall(await read(`${G(serverId, needGuest())}/firewall`)) };
    case 'snapshot.list':
      return { op: q.op, items: toHostSnapshots(await read(`${G(serverId, needGuest())}/snapshots`)) };
    case 'backupjob.list': {
      const raw = await read(`${S(serverId)}/backup-jobs`);
      return { op: q.op, items: arr(obj(raw).items).map(toHostBackupJob) };
    }
    // Incus (0.83, CT-364).
    case 'profile.get': {
      if (!q.profile) throw new ApiError('bad_request', 'profile: required for this read.');
      const raw = await read(`${S(serverId)}/incus/profiles/${seg(q.profile)}`, { project: q.project });
      return { op: q.op, profile: toHostIncusProfile(raw) };
    }
    case 'network.leases': {
      if (!q.network) throw new ApiError('bad_request', 'network: required for this read.');
      const raw = await read(`${networksOf(serverId, q.platform)}/${seg(q.network)}/leases`, {
        project: q.project,
      });
      return { op: q.op, items: toHostNetworkLeases(raw) };
    }
    case 'log.get': {
      const raw = await read(`${G(serverId, needGuest())}/log`, {
        lines: q.lines === undefined ? undefined : String(q.lines),
      });
      return { op: q.op, ...toHostGuestLog(raw) };
    }
  }
}

/* Routes --------------------------------------------------------------------------------------------------------- */

export const hostsRoutes: RouteDef[] = [
  route(api.hosts.status, (ctx) => status(ctx)),

  route(api.hosts.fleet, async (ctx) => {
    const g = await guard(ctx);
    const fleet = await hostsCall(() => g.hosts.fleet());
    const group = ctx.query.group;
    if (!group || group === 'All') return fleet;
    return { ...fleet, servers: fleet.servers.filter((s) => s.group.toLowerCase() === group.toLowerCase()) };
  }),

  route(api.hosts.getServer, async (ctx) => {
    const g = await guard(ctx);
    const { serverId } = ctx.params;
    const now = ctx.services.clock();
    const [raw, alerts, agent, offline] = await Promise.all([
      hostsCall(
        () =>
          g.hosts.call<unknown>({
            path: S(serverId),
            query: { range: ctx.query.range },
            actor: g.actor,
          }),
        { server: serverId },
      ),
      g.hosts.openAlertsRaw().catch(() => []),
      g.hosts.agentOf(serverId),
      // Its offline stretches this week, for its week in one line (monitoring.md MON-09).
      hostsAlertsSince(ctx.services, ctx.access.burrow.id, g.actor, {
        server: serverId,
        rule: HEARTBEAT_RULE,
        since: new Date(now.getTime() - UPTIME_WEEK_MS),
        limit: 200,
      }),
    ]);
    // What is quiet (QN-14, QN-23): alerts and hints marked, hints nobody watches left out, the head from the rest.
    const detail = await g.hosts.quietDetail(toHostServerDetail(raw, alerts, agent, now));
    const week = await serverUptime(
      ctx.services,
      ctx.access.burrow.id,
      serverId,
      offline,
      serverFirstReportAt(raw),
      now,
      ctx.access.burrow.timeZone,
    ).catch(() => null);
    return {
      ...detail,
      ...(week ? { uptime: week.uptime } : {}),
      asksFirst: await serverAsksOf(ctx.services.db, ctx.access.burrow.id, serverId),
    };
  }),

  route(api.hosts.serverMetrics, async (ctx) => {
    const g = await guard(ctx);
    const { serverId } = ctx.params;
    const q = ctx.query;
    const raw = await hostsCall(
      () =>
        g.hosts.call<unknown>({
          path: `${S(serverId)}/metrics`,
          query: { range: q.from ? undefined : q.range, series: q.series, from: q.from, to: q.to },
          actor: g.actor,
        }),
      { server: serverId },
    );
    return toHostSeries(raw, serverId, null, ctx.services.clock());
  }),

  route(api.hosts.serverSettings, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    const raw = await hostsCall(
      () => g.hosts.call<unknown>({ path: `${S(serverId)}/settings`, actor: g.actor }),
      {
        server: serverId,
      },
    );
    return {
      ...toHostServerSettings(raw, await g.hosts.agentOf(serverId)),
      asksFirst: await serverAsksOf(ctx.services.db, ctx.access.burrow.id, serverId),
      name: await givenNameOf(ctx.services.db, ctx.access.burrow.id, serverId),
    };
  }),

  route(api.hosts.updateServer, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    const { asksFirst, name, ...patch } = ctx.body;
    let raw: unknown;
    // Only “Asks you first” (server-asks.md SA-05) or the name: they are Whombat's, so the hosts service changes
    // nothing; its settings are read for the answer (and say the server is there).
    if (Object.keys(settingsBody(patch)).length === 0 && (asksFirst !== undefined || name !== undefined)) {
      raw = await hostsCall(
        () => g.hosts.call<unknown>({ path: `${S(serverId)}/settings`, actor: g.actor }),
        { server: serverId },
      );
    } else {
      const before = await hostsCall(
        () => g.hosts.call<unknown>({ path: `${S(serverId)}/settings`, actor: g.actor }),
        { server: serverId },
      );
      raw = await act('updateServer', { server: serverId }, () =>
        g.hosts.call<unknown>({
          method: 'PATCH',
          path: S(serverId),
          body: settingsBody(patch),
          actor: g.actor,
        }),
      );
      g.hosts.forget('fleet', 'agents');
      const undo = settingsUndo(serverId, patch, before);
      // Each field saved on its own merges into one change (home-redesign.md HR-06).
      const fields = serverSettingsFields(patch);
      const title = settingsTitle(fields, serverLabel(serverId));
      await sign(ctx, {
        text: title,
        op: 'server_settings',
        serverId,
        change: {
          title,
          undo: undo ? { kind: 'hosts.server_settings', payload: undo } : null,
          ...(fields.length ? { merge: { fields, target: serverId } } : {}),
        },
      });
    }
    if (name !== undefined) await renameServerAs(ctx, g, serverId, name);
    if (asksFirst !== undefined)
      await commitAs(ctx, setServerAsks, {
        serverId,
        serverName: await shownNameOf(g, serverId),
        asksFirst,
      });
    return {
      ...toHostServerSettings(raw, await g.hosts.agentOf(serverId)),
      asksFirst: await serverAsksOf(ctx.services.db, ctx.access.burrow.id, serverId),
      name: await givenNameOf(ctx.services.db, ctx.access.burrow.id, serverId),
    };
  }),

  route(api.hosts.removeServer, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    // Its name, read before it is gone.
    const removed = serverLabel(serverId);
    await act('removeServer', { server: serverId }, () =>
      g.hosts.call({ method: 'DELETE', path: S(serverId), actor: g.actor }),
    );
    g.hosts.forget();
    await sign(ctx, {
      text: `Removed the server ${removed}`,
      op: 'server_remove',
      serverId,
      change: { title: `Removed the server ${removed}` },
    });
    return { ok: true as const };
  }),

  route(api.hosts.serverAction, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    const raw = await act('serverAction', { server: serverId }, () =>
      g.hosts.call<unknown>({
        method: 'POST',
        path: `${S(serverId)}/actions`,
        body: { action: ctx.body.action, confirm: true },
        actor: g.actor,
      }),
    );
    const out = accepted(raw);
    const text =
      ctx.body.action === 'host_reboot'
        ? `Restarted ${serverLabel(serverId)}`
        : `Shut down ${serverLabel(serverId)}`;
    await sign(ctx, {
      text,
      op: 'server_power',
      serverId,
      ids: { actionId: out.actionId },
      change: { title: text },
    });
    return out;
  }),

  // Server agents that keep themselves up to date (agent-updates.md AU-06…AU-08; agent-updates-server.md AU-S01…).
  route(api.hosts.agentSettings, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const raw = await hostsCall(() =>
      g.hosts.call<unknown>({ path: `${HOSTS_API}/agents/settings`, actor: g.actor }),
    );
    return toAgentSettings(raw);
  }),

  route(api.hosts.updateAgentSettings, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { autoUpdate } = ctx.body;
    const raw = await act('updateAgentSettings', {}, () =>
      g.hosts.call<unknown>({
        method: 'PATCH',
        path: `${HOSTS_API}/agents/settings`,
        body: { auto_update: autoUpdate },
        actor: g.actor,
      }),
    );
    g.hosts.forget('agents');
    // A setting of the whole Whombat, not of a server: signed, not in Done recently (as checks and maintenance).
    await sign(ctx, {
      text: autoUpdate ? AGENT_UPDATE_TEXT.settingOn : AGENT_UPDATE_TEXT.settingOff,
      op: 'agent_settings',
      serverId: 'whombat',
    });
    return toAgentSettings(raw);
  }),

  route(api.hosts.updateAgent, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    // The server's update as it is now: whether this is its last install, and the words of a refusal.
    g.hosts.forget('agents');
    const rows = await g.hosts.agentsRaw().catch(() => null);
    const row = rows?.find((a) => obj(a).server_id === serverId);
    if (rows && !row)
      throw new ApiError('not_found', `There’s no server called ${serverId}.`, {
        details: { code: 'server_not_found' },
      });
    const before = row ? (agentRowUpdate(row)?.update ?? null) : null;
    const raw = await act(
      'updateAgent',
      {
        server: serverId,
        op: 'agent.update',
        ...(before?.reasonCode ? { agentReason: before.reasonCode } : {}),
      },
      () =>
        g.hosts.call<unknown>({
          method: 'POST',
          path: `${HOSTS_API}/agents/update`,
          body: { servers: [serverId] },
          actor: g.actor,
        }),
    );
    g.hosts.forget('agents');
    const state = startedState(raw, serverId, before);
    // Done recently says it once the agent is back on the new version, signed by this person (AU-S04).
    agentUpdatesFor(ctx.services).pressed(serverId, g.person.id, ctx.access.burrow.id);
    await sign(ctx, {
      text:
        state === 'installing' ? AGENT_UPDATE_TEXT.installing(serverId) : AGENT_UPDATE_TEXT.asked(serverId),
      op: 'agent_update',
      serverId,
      ...(str(obj(raw).version) ? { ids: { version: (str(obj(raw).version) as string).slice(0, 500) } } : {}),
    });
    return { state };
  }),

  route(api.hosts.listGuests, async (ctx) => {
    const g = await guard(ctx);
    const q = ctx.query;
    const raw = await hostsCall(() =>
      g.hosts.call<unknown>({
        path: `${HOSTS_API}/guests`,
        query: {
          server: q.server,
          q: q.q,
          state: q.state,
          platform: q.platform,
          kind: q.kind,
          tag: q.tag,
          sort: q.sort,
          limit: q.limit,
          cursor: q.cursor,
        },
        actor: g.actor,
      }),
    );
    return toHostGuestPage(raw, null);
  }),

  route(api.hosts.getGuest, async (ctx) => {
    const g = await guard(ctx);
    const { serverId, guestId } = ctx.params;
    const [raw, agent] = await Promise.all([
      hostsCall(() => g.hosts.call<unknown>({ path: G(serverId, guestId), actor: g.actor }), {
        server: serverId,
        guest: guestId,
      }),
      g.hosts.agentOf(serverId),
    ]);
    const guest = toHostGuest(raw, serverId);
    const remoteControl: HostRemoteControl = agent
      ? remoteControlFromAgent(agent)
      : { console: false, power: false };
    const detail: HostGuestDetail = {
      ...guest,
      remoteControl,
      // Settings and lifecycle: Proxmox VE, Incus and (0.84) libvirt's VMs.
      manageable:
        remoteControl.manage === true &&
        (guest.platform === 'pve' || guest.platform === 'incus' || guest.platform === 'libvirt'),
    };
    return detail;
  }),

  route(api.hosts.guestMetrics, async (ctx) => {
    const g = await guard(ctx);
    const { serverId, guestId } = ctx.params;
    const q = ctx.query;
    const raw = await hostsCall(
      () =>
        g.hosts.call<unknown>({
          path: `${G(serverId, guestId)}/metrics`,
          query: { range: q.from ? undefined : q.range, from: q.from, to: q.to },
          actor: g.actor,
        }),
      { server: serverId, guest: guestId },
    );
    return toHostSeries(raw, serverId, guestId, ctx.services.clock());
  }),

  route(api.hosts.guestAction, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId, guestId } = ctx.params;
    const body = ctx.body;
    const action = body.action as HostGuestAction;
    if (HOST_DESTRUCTIVE_ACTIONS.includes(action) && body.confirm !== true)
      throw new ApiError('bad_request', 'This needs a confirmation first.', {
        details: { code: 'confirm_required' },
      });
    const before = await g.hosts
      .call<unknown>({ path: G(serverId, guestId), actor: g.actor })
      .catch(() => null);
    const name = str(obj(before).name) || guestId;
    // The guest this Whombat runs in keeps running (IU-02); the hub refuses too.
    if (obj(before).self === true && selfActionRefused(action)) throw selfGuestRefusal();
    const raw = await act('guestAction', guestPowerNames(serverId, name), () =>
      g.hosts.call<unknown>({
        method: 'POST',
        path: `${G(serverId, guestId)}/actions`,
        body: {
          action,
          ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
          ...(body.snapshot !== undefined ? { snapshot: body.snapshot } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.memory !== undefined ? { memory: body.memory } : {}),
        },
        actor: g.actor,
      }),
    );
    const out = accepted(raw);
    g.hosts.forget('fleet');
    const kind = obj(before).kind === 'vm' ? 'vm' : 'container';
    const inverse = out.noop ? null : powerInverse(action, kind);
    const text = powerText(action, name, serverId, body.snapshot);
    await sign(ctx, {
      text,
      op: action.startsWith('snapshot') ? 'guest_snapshot' : 'guest_power',
      serverId,
      guestId,
      ids: { actionId: out.actionId },
      change: {
        title: text,
        subject: { kind: 'server', id: serverId, name: serverLabel(serverId) },
        undo: inverse
          ? { kind: 'hosts.guest_power', payload: { serverId, guestId, guestName: name, action: inverse } }
          : null,
      },
    });
    return out;
  }),

  route(api.hosts.manage, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    const req = ctx.body as HostManageRequest;
    const call = manageCall(serverId, req);
    // A restore (or an Incus backup's delete) names its guest in the request or in its params (the web's).
    const guestId =
      req.guestId ??
      ((req.op === 'backup.restore' || req.op === 'backup.delete') && typeof req.params?.guest === 'string'
        ? req.params.guest
        : undefined);
    const info = guestId ? await guestInfo(g, serverId, guestId) : null;
    const guest = info?.name ?? null;
    // The guest this Whombat runs in (IU-02): a restore that makes a new guest (always on Incus and libvirt) stays allowed.
    const platform = req.platform ?? (typeof req.params?.platform === 'string' ? req.params.platform : null);
    const asNew =
      req.op === 'backup.restore' &&
      (platform === 'incus' || platform === 'libvirt' || req.params?.newId !== undefined);
    if (info?.self && selfOpRefused(req.op, asNew)) throw selfGuestRefusal();
    // A configuration change is reviewed against the values it replaces (Undo restores them).
    const raw = await act(
      `manage.${req.op}`,
      { server: serverId, op: req.op, ...(guest ? { guest } : {}) },
      () =>
        g.hosts.call<unknown>({
          method: call.method,
          path: call.path,
          ...(call.body ? { body: call.body } : {}),
          ...(call.query ? { query: call.query } : {}),
          actor: g.actor,
          timeoutMs: 60_000,
        }),
    );
    const result = toHostManageResult(raw);
    g.hosts.forget('fleet');
    // A configuration save names the keys it changed and merges with the saves before it (HR-06).
    const keys = req.op === 'config.set' ? [...new Set((result.changes ?? []).map((c) => c.key))] : [];
    const target = guest ? `${guest} on ${serverLabel(serverId)}` : serverLabel(serverId);
    const text = keys.length
      ? settingsTitle(keys, target)
      : manageText(req.op, serverId, guest, { ...(req.params ?? {}), platform });
    const undo =
      req.op === 'config.set' && req.guestId ? configUndo(serverId, req.guestId, guest, result) : null;
    await sign(ctx, {
      text,
      op: req.op === 'config.set' ? 'guest_config' : `manage_${req.op.replace('.', '_')}`,
      serverId,
      guestId: guestId ?? null,
      ids: {
        ...(result.task ? { taskId: result.task.id } : {}),
        ...(result.auditId ? { auditId: result.auditId } : {}),
      },
      change: {
        title: text,
        detail: result.changes?.length
          ? result.changes
              .slice(0, 8)
              .map(
                (c) => `${c.key}: ${c.old ?? '—'} → ${c.new ?? '—'}${c.pending ? ' (after a restart)' : ''}`,
              )
              .join('\n')
          : packagesDetail(req.params?.packages),
        undo: undo ? { kind: 'hosts.guest_config', payload: undo } : null,
        ...(keys.length ? { merge: { fields: keys, target } } : {}),
      },
    });
    return result;
  }),

  route(api.hosts.manageRead, async (ctx) => {
    const g = await guard(ctx);
    return manageRead(ctx, g);
  }),

  route(api.hosts.getTask, async (ctx) => {
    const g = await guard(ctx);
    const { serverId, taskId } = ctx.params;
    const raw = await hostsCall(
      () =>
        g.hosts.call<unknown>({
          path: `${S(serverId)}/tasks/${seg(taskId)}`,
          query: { platform: ctx.query.platform, log_start: ctx.query.logStart },
          actor: asOperator(g),
        }),
      { server: serverId },
    );
    return toHostTask(raw);
  }),

  route(api.hosts.listAlerts, async (ctx) => {
    const g = await guard(ctx);
    const q = ctx.query;
    const raw = await hostsCall(() =>
      g.hosts.call<unknown>({
        path: `${HOSTS_API}/alerts`,
        query: {
          state: q.state,
          server: q.server,
          severity: q.severity,
          limit: q.limit,
          before: q.before,
          since: q.since,
          until: q.until,
          rule: q.rule,
          q: q.q,
        },
        actor: g.actor,
      }),
    );
    return { alerts: arr(raw).map(toHostAlert) };
  }),

  route(api.hosts.ackAlert, async (ctx) =>
    ackHostsAlert(ctx, ctx.params.alertId, { note: ctx.body.note, minutes: ctx.body.minutes }),
  ),

  route(api.hosts.unackAlert, async (ctx) => unackHostsAlert(ctx, ctx.params.alertId)),

  route(api.hosts.listMaintenance, async (ctx) => {
    const g = await guard(ctx);
    const raw = await hostsCall(() =>
      g.hosts.call<unknown>({ path: `${HOSTS_API}/maintenance`, actor: g.actor }),
    );
    return { items: arr(raw).map(toHostMaintenance) };
  }),

  route(api.hosts.createMaintenance, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const b = ctx.body;
    const raw = await act('createMaintenance', {}, () =>
      g.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/maintenance`,
        body: Object.fromEntries(
          Object.entries({
            scope: b.scope,
            target: b.target,
            starts_at: b.startsAt,
            ends_at: b.endsAt,
            duration_min: b.durationMin,
            weekdays: b.weekdays,
            start_time: b.startTime,
            tz: b.tz,
            note: b.note,
          }).filter(([, v]) => v !== undefined),
        ),
        actor: g.actor,
      }),
    );
    const window = toHostMaintenance(raw);
    g.hosts.forget('fleet');
    const what = window.scope === 'all' ? 'every server' : window.target;
    await sign(ctx, {
      text: `Muted alerts of ${what} for maintenance`,
      op: 'maintenance_create',
      serverId: window.scope === 'server' ? window.target : 'whombat',
      ids: { maintenanceId: window.id },
    });
    return window;
  }),

  route(api.hosts.removeMaintenance, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { maintenanceId } = ctx.params;
    await act('removeMaintenance', {}, () =>
      g.hosts.call({
        method: 'DELETE',
        path: `${HOSTS_API}/maintenance/${seg(maintenanceId)}`,
        actor: g.actor,
      }),
    );
    g.hosts.forget('fleet');
    await sign(ctx, {
      text: 'Ended a maintenance window',
      op: 'maintenance_remove',
      serverId: 'whombat',
      ids: { maintenanceId },
    });
    return { ok: true as const };
  }),

  route(api.hosts.listChecks, async (ctx) => {
    const g = await guard(ctx);
    const raw = await hostsCall(() => g.hosts.call<unknown>({ path: `${HOSTS_API}/checks`, actor: g.actor }));
    // Heartbeat ping URLs are the check's credential: the person only.
    return {
      checks: arr(raw)
        .map(toHostCheck)
        .map((c) => (g.manages ? c : { ...c, pingUrl: null })),
    };
  }),

  route(api.hosts.getCheck, async (ctx) => {
    const g = await guard(ctx);
    const raw = await hostsCall(() =>
      g.hosts.call<unknown>({ path: `${HOSTS_API}/checks/${seg(ctx.params.checkId)}`, actor: g.actor }),
    );
    const check = toHostCheck(raw);
    return g.manages ? check : { ...check, pingUrl: null };
  }),

  route(api.hosts.createCheck, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const raw = await act('createCheck', {}, () =>
      g.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/checks`,
        body: checkBody(ctx.body),
        actor: g.actor,
      }),
    );
    const check = toHostCheck(raw);
    await sign(ctx, {
      text: `Added the check ${check.name}`.slice(0, 300),
      op: 'check_create',
      serverId: check.runner === 'hub' ? 'whombat' : check.runner,
      ids: { checkId: check.id },
    });
    return check;
  }),

  route(api.hosts.updateCheck, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { checkId } = ctx.params;
    const raw = await act('updateCheck', {}, () =>
      g.hosts.call<unknown>({
        method: 'PATCH',
        path: `${HOSTS_API}/checks/${seg(checkId)}`,
        body: checkBody(ctx.body),
        actor: g.actor,
      }),
    );
    const check = toHostCheck(raw);
    await sign(ctx, {
      text: `Changed the check ${check.name}`.slice(0, 300),
      op: 'check_update',
      serverId: check.runner === 'hub' ? 'whombat' : check.runner,
      ids: { checkId },
    });
    return check;
  }),

  route(api.hosts.removeCheck, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { checkId } = ctx.params;
    await act('removeCheck', {}, () =>
      g.hosts.call({ method: 'DELETE', path: `${HOSTS_API}/checks/${seg(checkId)}`, actor: g.actor }),
    );
    await sign(ctx, {
      text: 'Removed a check',
      op: 'check_remove',
      serverId: 'whombat',
      ids: { checkId },
    });
    return { ok: true as const };
  }),

  route(api.hosts.createEnrollment, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    // Every enrollment Whombat makes is pre-approved with its level (SI-06, SI-07): both ways in, no second trip.
    const body = ctx.body ?? {};
    const raw = await act('createEnrollment', {}, () =>
      g.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/enrollments`,
        body: {
          approve: true,
          control: body.control ?? HOST_CONTROL_LEVEL_DEFAULT,
          ...(body.name ? { name: body.name } : {}),
        },
        actor: g.actor,
      }),
    );
    const enrollment = toHostEnrollment(raw);
    // The install command holds a single-use token: it is never in the log.
    await sign(ctx, {
      text: 'Made a command to add a server',
      op: 'enrollment_create',
      serverId: 'whombat',
      ids: { enrollmentId: enrollment.id },
    });
    return enrollment;
  }),

  route(api.hosts.listEnrollments, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const raw = await hostsCall(() =>
      g.hosts.call<unknown>({
        path: `${HOSTS_API}/enrollments`,
        query: { state: ctx.query.state },
        actor: g.actor,
      }),
    );
    return { items: arr(raw).map(toHostPendingEnrollment) };
  }),

  route(api.hosts.approveEnrollment, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { enrollmentId } = ctx.params;
    const raw = await act('approveEnrollment', {}, () =>
      g.hosts.call<unknown>({
        method: 'POST',
        path: `${HOSTS_API}/enrollments/${seg(enrollmentId)}/approve`,
        body: {
          ...(ctx.body.group ? { group: ctx.body.group } : {}),
          ...(ctx.body.name ? { name: ctx.body.name } : {}),
        },
        actor: g.actor,
      }),
    );
    const serverId = str(obj(raw).server_id) || 'unknown';
    g.hosts.forget();
    await sign(ctx, {
      text: `Added the server ${serverId}`,
      op: 'enrollment_approve',
      serverId,
      ids: { enrollmentId },
      change: { title: `Added the server ${serverId}` },
    });
    return { serverId };
  }),

  route(api.hosts.rejectEnrollment, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { enrollmentId } = ctx.params;
    await act('rejectEnrollment', {}, () =>
      g.hosts.call({
        method: 'POST',
        path: `${HOSTS_API}/enrollments/${seg(enrollmentId)}/reject`,
        body: {},
        actor: g.actor,
      }),
    );
    g.hosts.forget('fleet');
    await sign(ctx, {
      text: 'Turned a server away',
      op: 'enrollment_reject',
      serverId: 'whombat',
      ids: { enrollmentId },
    });
    return { ok: true as const };
  }),

  /* Sign in once (server-signin.md SI-02…SI-11; server-signin-server.md SI-S01…) ------------------------------------ */

  route(api.hosts.startInstall, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const plan = await installPlan(ctx, g, ctx.body);
    // The job runs on after this answer, never as part of the request's command (its receipt keeps nothing, CT-44).
    return outsideCommandScope(() => installsFor(ctx.services).start(plan));
  }),

  route(api.hosts.getInstall, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const job = installsFor(ctx.services).get(ctx.params.installId, g.person.id);
    if (!job) throw notFound('Install');
    return job;
  }),

  /* Pointing servers here (backup-file.md BF-15, BF-16; BF-S35…BF-S40) --------------------------------------------- */

  route(api.hosts.addressChange, async (ctx) => {
    await guard(ctx, { manage: true });
    return hostsAddressChange(ctx.services, ctx.services.clock());
  }),

  route(api.hosts.repoint, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    try {
      // The job runs on after this answer, outside the request's command (as an install, SI-S01).
      const job = await outsideCommandScope(() =>
        repointsFor(ctx.services).start({
          burrowId: ctx.access.burrow.id,
          personId: g.person.id,
          actor: g.actor,
          servers: ctx.body.servers,
        }),
      );
      return toHostRepoint(job);
    } catch (err) {
      if (err instanceof RepointBusy)
        throw new ApiError('rate_limited', REPOINT_TEXT.busy, { details: { code: 'repoint_running' } });
      throw err;
    }
  }),

  route(api.hosts.getRepoint, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const job = repointsFor(ctx.services).get(ctx.params.repointId, g.person.id);
    if (!job) throw notFound('Repoint');
    return toHostRepoint(job);
  }),

  route(api.hosts.createConsole, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    const b = ctx.body;
    if (b.protocol === 'spice')
      throw new ApiError('bad_request', 'Whombat opens VM screens with VNC; SPICE isn’t offered here.');
    const path = b.guestId ? `${G(serverId, b.guestId)}/console-sessions` : `${S(serverId)}/console-sessions`;
    const raw = await act(
      'createConsole',
      { server: serverId, ...(b.guestId ? { guest: b.guestId } : {}) },
      () =>
        g.hosts.call<unknown>({
          method: 'POST',
          path,
          body: {
            ...(b.protocol ? { protocol: b.protocol } : {}),
            ...(b.switchFrom ? { switch_from: b.switchFrom } : {}),
          },
          actor: g.actor,
        }),
    );
    const r = obj(raw);
    const hostsSessionId = str(r.session_id);
    const hostsToken = str(r.token);
    if (!hostsSessionId || !hostsToken) throw new ApiError('conflict', 'The console didn’t open. Try again.');
    const ticket = g.hosts.issueConsole({
      burrowId: ctx.access.burrow.id,
      principalId: g.person.id,
      actor: g.actor,
      hostsSessionId,
      hostsToken,
      protocol: str(r.protocol) || 'logs',
      serverId,
      guestId: b.guestId ?? null,
    });
    const what = b.guestId
      ? `a console of ${b.guestId} on ${serverLabel(serverId)}`
      : str(r.protocol) === 'shell'
        ? `a shell on ${serverLabel(serverId)}`
        : str(r.protocol) === 'vnc'
          ? `the screen of ${serverLabel(serverId)}`
          : `a console of ${serverLabel(serverId)}`;
    await sign(ctx, {
      text: `Opened ${what}`,
      op: 'console_open',
      serverId,
      guestId: b.guestId ?? null,
      ids: { sessionId: hostsSessionId },
    });
    return toConsoleSession(raw, {
      path: `/api/v1/burrows/${ctx.access.burrow.slug}/hosts/consoles/${hostsSessionId}/ws`,
      token: ticket.token,
    });
  }),

  route(api.hosts.closeConsole, async (ctx) => {
    const g = await guard(ctx);
    const { sessionId } = ctx.params;
    await act('closeConsole', {}, () =>
      g.hosts.call({
        method: 'DELETE',
        path: `${HOSTS_API}/console-sessions/${seg(sessionId)}`,
        actor: g.actor,
      }),
    );
    return { ok: true as const };
  }),

  // A Mac's screen (macos-servers.md): its state (`status`) as the person at operator; every other step, a look and the
  // UI lists too (they show the person's whole desktop), is an owner's, and one that changes something is signed once
  // the Mac did it. The Mac's password (`account.set`) only passes through to the Mac.
  route(api.hosts.screen, async (ctx) => {
    const b = ctx.body;
    const read = isScreenRead(b.op);
    const g = await guard(ctx, { manage: !read });
    const { serverId } = ctx.params;
    // An element's own action that removes, erases or signs out is the person's to do on the Mac's screen.
    const destructive =
      b.op === 'ui.action' ? destructiveActionText(b.action ?? '', serverLabel(serverId)) : null;
    if (destructive)
      throw new ApiError('forbidden', destructive, { details: { code: 'destructive_action' } });
    const names = { server: serverLabel(serverId), op: 'screen' };
    const step = () => screenStep(g.hosts, serverId, b, read ? asOperator(g) : g.actor);
    const result = read ? await hostsCall(step, names) : await act('screen', names, step);
    const text = result.ok ? screenChangeText(b, serverLabel(serverId)) : null;
    if (text)
      await sign(ctx, {
        text,
        op: 'screen',
        serverId,
        ...(result.auditId ? { ids: { auditId: result.auditId } } : {}),
        change: { title: text, everyday: screenStepIsEveryday(b.op) },
      });
    return result;
  }),

  // A screenshot is the person's whole desktop: an owner's, at admin, as the hosts service asks.
  route(api.hosts.screenLook, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    const q = ctx.query;
    return hostsCall(
      () =>
        screenStep(
          g.hosts,
          serverId,
          { op: 'look', ...(q.maxW ? { maxW: q.maxW } : {}), ...(q.format ? { format: q.format } : {}) },
          g.actor,
        ),
      { server: serverLabel(serverId), op: 'screen' },
    );
  }),

  // Find My on a Find My connection's page (the Mac it reads): an owner's, as a look is (a read unlocks the Mac and
  // reads its screen). What was read stays in memory only (`findmy.ts`), and none of its steps is signed. Each answer
  // says how the Mac is read without anyone looking (`findmy-background.ts`).
  route(api.hosts.findMy, async (ctx) => {
    await guard(ctx, { manage: true });
    return withBackground(ctx.services, findMyFor(ctx.services).view(ctx.params.serverId));
  }),

  route(api.hosts.findMyRefresh, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    const label = await shownNameOf(g, serverId);
    // The read runs on after this answer, outside the request's command (its receipt keeps nothing).
    return withBackground(
      ctx.services,
      outsideCommandScope(() => findMyFor(ctx.services).refresh(g.hosts, serverId, g.actor, label)),
    );
  }),

  route(api.hosts.findMyExact, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    const label = await shownNameOf(g, serverId);
    return withBackground(
      ctx.services,
      outsideCommandScope(() =>
        findMyFor(ctx.services).exact(g.hosts, serverId, ctx.body.person, g.actor, label),
      ),
    );
  }),

  route(api.hosts.findMyMap, async (ctx) => {
    const g = await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    const label = await shownNameOf(g, serverId);
    return hostsCall(() => findMyFor(ctx.services).map(g.hosts, serverId, ctx.query, g.actor, label), {
      server: label,
      op: 'screen',
    });
  }),

  route(api.hosts.findMyPicture, async (ctx) => {
    await guard(ctx, { manage: true });
    const { serverId } = ctx.params;
    return findMyFor(ctx.services).picture(serverId, ctx.query.person, serverLabel(serverId));
  }),

  route(api.hosts.inspect, async (ctx) => {
    const g = await guard(ctx);
    const { serverId, kind } = ctx.params;
    const raw = await hostsCall(
      () => g.hosts.call<unknown>({ path: `${S(serverId)}/inspect/${kind}`, actor: asOperator(g) }),
      { server: serverId },
    );
    return toHostInspect(raw, kind, ctx.services.clock());
  }),

  route(api.hosts.diskUsage, async (ctx) => {
    const g = await guard(ctx);
    const { serverId } = ctx.params;
    const body = ctx.body;
    const raw = await hostsCall(
      () =>
        g.hosts.call<unknown>({
          method: 'POST',
          path: `${S(serverId)}/disk-usage`,
          body: {
            ...(body.mount ? { mount: body.mount } : {}),
            ...(body.maxDepth ? { max_depth: body.maxDepth } : {}),
            ...(body.timeoutS ? { timeout_s: body.timeoutS } : {}),
          },
          actor: asOperator(g),
          timeoutMs: 65_000,
        }),
      { server: serverId },
    );
    return toHostDiskUsage(raw, ctx.services.clock());
  }),
];

/**
 * What a Sign in once needs before its job starts (SI-02, SI-05, SI-09; SI-S03, SI-S08): the address read and allowed
 * by the Vault's SSH destination rule (its reason in full), no second job for the same server and at most two per
 * person and four per box, the person's own Vault key opened when they sign in with one, and the key SI-09 leaves
 * checked against the Vault's limits — so nothing is refused after the agent is on the server.
 */
async function installPlan(ctx: Ctx, g: Guarded, body: HostInstallBody): Promise<InstallPlan> {
  const field = (name: string, message: string) =>
    new ApiError('validation_failed', message, { fields: { [name]: [message] } });
  const where = parseHostInstallAddress(body.address);
  if (!where) throw field('address', ADDRESS_FIELD_TEXT);
  const { problem } = await sshDestination(ctx.services, where.host, where.port, 'save');
  if (problem)
    throw new ApiError('not_allowed', problem.message, {
      fields: { address: [problem.message] },
      details: { code: 'not_allowed', problem: problem.code },
    });
  const installs = installsFor(ctx.services);
  const limit = installs.limit(g.person.id, where.host, where.port);
  if (limit)
    throw new ApiError(
      'rate_limited',
      limit === 'same' ? INSTALL_LIMIT_TEXT.same(body.address.trim()) : INSTALL_LIMIT_TEXT[limit],
      { details: { code: 'install_running' } },
    );
  const burrowId = ctx.access.burrow.id;
  const own = (entryId: string) => ownEntry(ctx.services.db, burrowId, g.person.id, entryId);
  const sshKey = async (entryId: string, fieldName: string) => {
    const entry = await own(entryId);
    if (entry.kind !== 'ssh' || !entry.sealed) throw field(fieldName, INSTALL_KEY_TEXT.notSsh);
    return entry;
  };
  let privateKey: string | null = null;
  let keyEntryId: string | null = null;
  if (body.auth.kind === 'vault') {
    const entry = await sshKey(body.auth.entryId, 'auth.entryId');
    privateKey = ctx.services.custody.open(vaultSecretAad(entry.id), entry.sealed as string);
    keyEntryId = entry.id;
  }
  let keep: InstallPlan['keep'] = null;
  if (body.keepKey) {
    if (body.username.length > VAULT_SSH_USERNAME_MAX) throw field('username', INSTALL_KEY_TEXT.username);
    if ('entryId' in body.keepKey) {
      const entry = await sshKey(body.keepKey.entryId, 'keepKey.entryId');
      const servers = await serverRows(ctx.services.db, [entry.id]);
      const known = servers.some(
        (s) =>
          s.host.toLowerCase() === where.host.toLowerCase() &&
          s.port === where.port &&
          s.username === body.username,
      );
      if (!known && servers.length >= VAULT_SSH_SERVERS_MAX)
        throw new ApiError('conflict', VAULT_LIMIT_MESSAGES.servers, {
          details: { code: 'limit_reached', limit: 'servers', max: VAULT_SSH_SERVERS_MAX },
        });
      keep = { entry };
    } else {
      if ((await entryCount(ctx.services.db, burrowId, g.person.id)) >= VAULT_ENTRIES_MAX)
        throw new ApiError('conflict', VAULT_LIMIT_MESSAGES.entries, {
          details: { code: 'limit_reached', limit: 'entries', max: VAULT_ENTRIES_MAX },
        });
      keep = { create: true };
    }
  }
  return {
    burrowId,
    personId: g.person.id,
    actor: g.actor,
    body,
    host: where.host,
    port: where.port,
    privateKey,
    keyEntryId,
    keep,
  };
}

/** A repoint job in the contract's shape (`HostRepoint`): its install ids stay the server's own. */
export function toHostRepoint(job: RepointView) {
  return {
    id: job.id,
    to: job.to ?? 'this Whombat',
    state: job.state,
    servers: job.servers.map((s) => ({
      id: s.id,
      name: s.name || s.id,
      address: s.address,
      state: s.state,
      error: s.error,
    })),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/** A check's input in the service's words. */
function checkBody(b: {
  name?: string;
  kind?: string;
  target?: string;
  runner?: string;
  intervalS?: number;
  timeoutS?: number;
  graceS?: number;
  options?: Record<string, unknown>;
  enabled?: boolean;
  owner?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Record<string, string> = { intervalS: 'interval_s', timeoutS: 'timeout_s', graceS: 'grace_s' };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    if (k === 'options' && v && typeof v === 'object')
      out.options = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([ok, ov]) => [snake(ok), ov]),
      );
    else out[map[k] ?? k] = v;
  }
  return out;
}

/** “2 hours”, “30 minutes”, “1 day”. */
export function minutesText(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** The server's page in the app (for links in texts). */
export const serverHref = (serverId: string) => thingHref('server', serverId);

/** Tests and the console proxy: the services' hosts service. */
export function hostsOf(services: Services): HostsService {
  return hostsFor(services);
}
