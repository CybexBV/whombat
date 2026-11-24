/**
 * Servers through Whombat (Whombat one-whombat.md ONE-11…ONE-15, contracts 0.80.0, CT-339): the hosts service's data
 * and changes as Whombat's REST API, under `/burrows/:burrow/hosts`. Reads map the service's JSON to `Host*`
 * (`../domain/hosts.ts`); writes are commands in the commit pipeline with the service's confirmations passed through
 * (owners change servers, members view). Without the service every route but `hosts.status` answers `unavailable`.
 * Session ops too (`hosts.*`); the realtime topic `hosts:<burrowId>` carries `hosts.*` events.
 */
import { z } from 'zod';
import {
  HOST_LOG_LINES_MAX,
  HostActionAccepted,
  HostAddressChange,
  HostAgentSettings,
  HostAgentSettingsPatch,
  HostAgentUpdateAccepted,
  HostAlert,
  HostCheck,
  HostCheckInput,
  HostConsoleCreateBody,
  HostConsoleSession,
  HostCreateEnrollmentBody,
  HostDiskUsage,
  HostDiskUsageBody,
  HostEnrollment,
  HostFleet,
  HostGuestActionBody,
  HostGuestDetail,
  HostGuestKind,
  HostGuestPage,
  HostGuestState,
  HostInspectKind,
  HostInspectResult,
  HostInstall,
  HostInstallBody,
  HostMaintenance,
  HostMaintenanceCreate,
  HostManagePlatform,
  HostManageReadOp,
  HostManageReadResult,
  HostManageRequest,
  HostManageResult,
  HostPendingEnrollment,
  HostPlatform,
  HostRepoint,
  HostRepointBody,
  HostScreenBody,
  HostScreenLookQuery,
  HostScreenResult,
  HostSeries,
  HostSeriesRange,
  HostServerActionBody,
  HostServerDetail,
  HostServerSettings,
  HostServerSettingsPatch,
  HostsStatus,
  HostTask,
} from '../domain/hosts.js';
import {
  HostFindMy,
  HostFindMyExactBody,
  HostFindMyMap,
  HostFindMyMapQuery,
  HostFindMyPicture,
  HostFindMyPictureQuery,
  HostFindMyRefreshBody,
} from '../domain/hosts-findmy.js';
import { BurrowParam, endpoint } from './endpoint.js';
import { OkResponse as Ok } from './errors.js';

const B = z.object({ burrow: BurrowParam });
const Seg = z.string().min(1).max(200);
const S = B.extend({ serverId: Seg });
const G = S.extend({ guestId: Seg });

const MetricsQuery = z.object({
  range: HostSeriesRange.optional(),
  /** Series names, comma-separated (`cpu_pct,mem_pct`); absent: the defaults. */
  series: z.string().max(500).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export const HostAlertsResponse = z.object({ alerts: z.array(HostAlert) });
export const HostAckAlertBody = z.object({
  note: z.string().max(256).optional(),
  /** 0 (default): until it resolves; 1–43 200: snoozed for that long. */
  minutes: z.number().int().min(0).max(43_200).optional(),
});
export const HostMaintenanceListResponse = z.object({ items: z.array(HostMaintenance) });
export const HostChecksResponse = z.object({ checks: z.array(HostCheck) });
export const HostEnrollmentsResponse = z.object({ items: z.array(HostPendingEnrollment) });
export const HostApproveEnrollmentBody = z.object({
  group: z.string().trim().min(1).max(63).optional(),
  name: z.string().trim().min(1).max(63).optional(),
});
export const HostApproveEnrollmentResponse = z.object({ serverId: Seg });

export const hostsEndpoints = {
  status: endpoint({
    id: 'hosts.status',
    method: 'GET',
    path: '/burrows/:burrow/hosts/status',
    summary: 'Whether this Whombat runs the hosts service and it answers; where agents dial in.',
    params: B,
    response: HostsStatus,
  }),
  fleet: endpoint({
    id: 'hosts.fleet',
    method: 'GET',
    path: '/burrows/:burrow/hosts/fleet',
    summary: 'Every server with its status and load, the fleet’s totals, open alerts and hints.',
    params: B,
    query: z.object({ group: z.string().max(120).optional() }),
    response: HostFleet,
  }),
  getServer: endpoint({
    id: 'hosts.getServer',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId',
    summary:
      'A server’s page: facts, live load, sensors, disks, storage, health, guests, Proxmox cluster and backups.',
    params: S,
    query: z.object({ range: HostSeriesRange.optional() }),
    response: HostServerDetail,
  }),
  serverMetrics: endpoint({
    id: 'hosts.serverMetrics',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/metrics',
    summary: 'A server’s history for a range or a from/to window.',
    params: S,
    query: MetricsQuery,
    response: HostSeries,
  }),
  serverSettings: endpoint({
    id: 'hosts.serverSettings',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/settings',
    summary: 'A server’s group, location, parent and remote-control switches, and its agent.',
    params: S,
    response: HostServerSettings,
  }),
  updateServer: endpoint({
    id: 'hosts.updateServer',
    method: 'PATCH',
    path: '/burrows/:burrow/hosts/servers/:serverId',
    summary: 'Change a server’s name, group, location, parent or switches.',
    params: S,
    body: HostServerSettingsPatch,
    response: HostServerSettings,
  }),
  removeServer: endpoint({
    id: 'hosts.removeServer',
    method: 'DELETE',
    path: '/burrows/:burrow/hosts/servers/:serverId',
    summary: 'Forget a server and its history; its agent is no longer accepted.',
    params: S,
    response: Ok,
  }),
  serverAction: endpoint({
    id: 'hosts.serverAction',
    method: 'POST',
    path: '/burrows/:burrow/hosts/servers/:serverId/actions',
    summary: 'Reboot or shut down the server itself (with its host-power switch on).',
    params: S,
    body: HostServerActionBody,
    response: HostActionAccepted,
    status: 202,
  }),
  agentSettings: endpoint({
    id: 'hosts.agentSettings',
    method: 'GET',
    path: '/burrows/:burrow/hosts/agents/settings',
    summary:
      'Whether the hosts service keeps every server’s agent up to date by itself, and whether it stopped because a new version didn’t come back.',
    params: B,
    response: HostAgentSettings,
  }),
  updateAgentSettings: endpoint({
    id: 'hosts.updateAgentSettings',
    method: 'PATCH',
    path: '/burrows/:burrow/hosts/agents/settings',
    summary: 'Switch “Keep server agents up to date” on or off.',
    params: B,
    body: HostAgentSettingsPatch,
    response: HostAgentSettings,
  }),
  updateAgent: endpoint({
    id: 'hosts.updateAgent',
    method: 'POST',
    path: '/burrows/:burrow/hosts/servers/:serverId/agent/update',
    summary:
      'Update a server’s agent now: a signed update, or the one last install where Whombat may run commands as root there; how it goes comes with the server’s settings.',
    params: S,
    response: HostAgentUpdateAccepted,
    status: 202,
  }),
  listGuests: endpoint({
    id: 'hosts.listGuests',
    method: 'GET',
    path: '/burrows/:burrow/hosts/guests',
    summary: 'Guests of every server, or of one (`server`), filtered and sorted, with counts.',
    params: B,
    query: z.object({
      server: Seg.optional(),
      q: z.string().max(200).optional(),
      state: HostGuestState.optional(),
      platform: HostPlatform.optional(),
      kind: HostGuestKind.optional(),
      tag: z.string().max(80).optional(),
      sort: z.string().max(20).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      cursor: z.string().max(500).optional(),
    }),
    response: HostGuestPage,
  }),
  getGuest: endpoint({
    id: 'hosts.getGuest',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/guests/:guestId',
    summary: 'A VM or container with what may be done to it.',
    params: G,
    response: HostGuestDetail,
  }),
  guestMetrics: endpoint({
    id: 'hosts.guestMetrics',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/guests/:guestId/metrics',
    summary: 'A guest’s history for a range.',
    params: G,
    query: MetricsQuery,
    response: HostSeries,
  }),
  guestAction: endpoint({
    id: 'hosts.guestAction',
    method: 'POST',
    path: '/burrows/:burrow/hosts/servers/:serverId/guests/:guestId/actions',
    summary:
      'Start, stop, shut down, reboot, pause or resume a guest, or create, restore or delete a snapshot; the result comes as `hosts.task`.',
    params: G,
    body: HostGuestActionBody,
    response: HostActionAccepted,
    status: 202,
  }),
  manage: endpoint({
    id: 'hosts.manage',
    method: 'POST',
    path: '/burrows/:burrow/hosts/servers/:serverId/manage',
    summary:
      'One change to a Proxmox, Incus, unRAID or QEMU/KVM (libvirt) guest or host: configuration, disks, create, clone, rename, move, delete, migrate, backups, backup jobs, firewall, HA, replication, images, profiles, volumes, the array, parity, plugins, container updates, and the server’s own operating-system updates.',
    params: S,
    body: HostManageRequest,
    response: HostManageResult,
  }),
  manageRead: endpoint({
    id: 'hosts.manageRead',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/manage',
    summary:
      'Read what a change is made against: a guest’s configuration with its digest, the form choices, backups, backup jobs, storage content, tasks, firewall, snapshots, an Incus profile, a network’s leases, an instance’s log.',
    params: S,
    query: z.object({
      op: HostManageReadOp,
      guestId: Seg.optional(),
      platform: HostManagePlatform.optional(),
      storage: z.string().max(100).optional(),
      content: z.enum(['iso', 'vztmpl', 'import']).optional(),
      /** Incus (0.83, CT-364): whose pools, networks, profiles (`choices`, `profile.get`, `network.leases`). */
      project: z.string().max(100).optional(),
      /** `profile.get`: the profile. */
      profile: z.string().max(100).optional(),
      /** `network.leases`: the network. */
      network: z.string().max(100).optional(),
      /** `log.get`: how many of the last lines (default 500). */
      lines: z.coerce.number().int().min(1).max(HOST_LOG_LINES_MAX).optional(),
    }),
    response: HostManageReadResult,
  }),
  getTask: endpoint({
    id: 'hosts.getTask',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/tasks/:taskId',
    summary: 'A task’s state and log (from `logStart`, at most 500 lines).',
    params: S.extend({ taskId: z.string().min(1).max(500) }),
    query: z.object({
      platform: HostManagePlatform.optional(),
      logStart: z.coerce.number().int().min(-1).optional(),
    }),
    response: HostTask,
  }),
  listAlerts: endpoint({
    id: 'hosts.listAlerts',
    method: 'GET',
    path: '/burrows/:burrow/hosts/alerts',
    summary:
      'Alerts, open ones most severe first; resolved ones newest first. With `resolved` or `all`, `since`, `until` and `before` bound the period (the hosts service keeps 90 days); `rule` is a rule or a prefix ending in a dot, `q` words in the title or detail.',
    params: B,
    query: z.object({
      state: z.enum(['open', 'resolved', 'all']).optional(),
      server: Seg.optional(),
      severity: z.enum(['critical', 'warning']).optional(),
      limit: z.coerce.number().int().min(1).max(1000).optional(),
      before: z.iso.datetime({ offset: true }).optional(),
      since: z.iso.datetime({ offset: true }).optional(),
      until: z.iso.datetime({ offset: true }).optional(),
      rule: z
        .string()
        .max(120)
        .regex(/^[a-z0-9_.-]+$/)
        .optional(),
      q: z.string().max(200).optional(),
    }),
    response: HostAlertsResponse,
  }),
  ackAlert: endpoint({
    id: 'hosts.ackAlert',
    method: 'POST',
    path: '/burrows/:burrow/hosts/alerts/:alertId/ack',
    summary: 'Acknowledge an alert until it resolves, or snooze it for some minutes.',
    params: B.extend({ alertId: Seg }),
    body: HostAckAlertBody,
    response: HostAlert,
  }),
  unackAlert: endpoint({
    id: 'hosts.unackAlert',
    method: 'DELETE',
    path: '/burrows/:burrow/hosts/alerts/:alertId/ack',
    summary: 'Take an acknowledgement or snooze back.',
    params: B.extend({ alertId: Seg }),
    response: HostAlert,
  }),
  listMaintenance: endpoint({
    id: 'hosts.listMaintenance',
    method: 'GET',
    path: '/burrows/:burrow/hosts/maintenance',
    summary: 'Maintenance windows: one-off and weekly, with whether each is active now.',
    params: B,
    response: HostMaintenanceListResponse,
  }),
  createMaintenance: endpoint({
    id: 'hosts.createMaintenance',
    method: 'POST',
    path: '/burrows/:burrow/hosts/maintenance',
    summary: 'Mute a server’s, a group’s or every alert for a window.',
    params: B,
    body: HostMaintenanceCreate,
    response: HostMaintenance,
    status: 201,
  }),
  removeMaintenance: endpoint({
    id: 'hosts.removeMaintenance',
    method: 'DELETE',
    path: '/burrows/:burrow/hosts/maintenance/:maintenanceId',
    summary: 'End a maintenance window (unmute).',
    params: B.extend({ maintenanceId: Seg }),
    response: Ok,
  }),
  listChecks: endpoint({
    id: 'hosts.listChecks',
    method: 'GET',
    path: '/burrows/:burrow/hosts/checks',
    summary: 'Uptime and heartbeat checks with their status, 24-hour uptime and latency.',
    params: B,
    response: HostChecksResponse,
  }),
  createCheck: endpoint({
    id: 'hosts.createCheck',
    method: 'POST',
    path: '/burrows/:burrow/hosts/checks',
    summary: 'Add an HTTP, TCP, ping, DNS or heartbeat check.',
    params: B,
    body: HostCheckInput,
    response: HostCheck,
    status: 201,
  }),
  updateCheck: endpoint({
    id: 'hosts.updateCheck',
    method: 'PATCH',
    path: '/burrows/:burrow/hosts/checks/:checkId',
    summary: 'Change a check, or switch it off.',
    params: B.extend({ checkId: Seg }),
    body: HostCheckInput,
    response: HostCheck,
  }),
  removeCheck: endpoint({
    id: 'hosts.removeCheck',
    method: 'DELETE',
    path: '/burrows/:burrow/hosts/checks/:checkId',
    summary: 'Remove a check.',
    params: B.extend({ checkId: Seg }),
    response: Ok,
  }),
  createEnrollment: endpoint({
    id: 'hosts.createEnrollment',
    method: 'POST',
    path: '/burrows/:burrow/hosts/enrollments',
    summary:
      'Add a server: a one-line install command, single use for an hour, that dials this Whombat. Since 0.85 the body (optional; an empty POST means `full`) says what Whombat may do on it and its name; the server is added as soon as its agent asks (SI-07).',
    params: B,
    body: HostCreateEnrollmentBody.optional(),
    response: HostEnrollment,
    status: 201,
  }),
  listEnrollments: endpoint({
    id: 'hosts.listEnrollments',
    method: 'GET',
    path: '/burrows/:burrow/hosts/enrollments',
    summary: 'Servers waiting for approval (or every enrollment by state).',
    params: B,
    query: z.object({
      state: z.enum(['pending', 'issued', 'approved', 'rejected', 'expired', 'all']).optional(),
    }),
    response: HostEnrollmentsResponse,
  }),
  approveEnrollment: endpoint({
    id: 'hosts.approveEnrollment',
    method: 'POST',
    path: '/burrows/:burrow/hosts/enrollments/:enrollmentId/approve',
    summary: 'Let a waiting server in, with its name and group.',
    params: B.extend({ enrollmentId: Seg }),
    body: HostApproveEnrollmentBody,
    response: HostApproveEnrollmentResponse,
  }),
  rejectEnrollment: endpoint({
    id: 'hosts.rejectEnrollment',
    method: 'POST',
    path: '/burrows/:burrow/hosts/enrollments/:enrollmentId/reject',
    summary: 'Turn a waiting server away.',
    params: B.extend({ enrollmentId: Seg }),
    response: Ok,
  }),
  startInstall: endpoint({
    id: 'hosts.startInstall',
    method: 'POST',
    path: '/burrows/:burrow/hosts/installs',
    summary:
      'Sign in once (SI-02): Whombat signs in to a server over SSH, installs its agent as root with the chosen control and waits for its first report. The password is used for this install only, never kept (a secret op). Answers the job at once; `hosts.install` events and `hosts.getInstall` follow it.',
    params: B,
    body: HostInstallBody,
    response: HostInstall,
    status: 202,
  }),
  getInstall: endpoint({
    id: 'hosts.getInstall',
    method: 'GET',
    path: '/burrows/:burrow/hosts/installs/:installId',
    summary: 'An install job of Sign in once, with its steps, the key the server showed and how it ended.',
    params: B.extend({ installId: Seg }),
    response: HostInstall,
  }),
  createConsole: endpoint({
    id: 'hosts.createConsole',
    method: 'POST',
    path: '/burrows/:burrow/hosts/servers/:serverId/consoles',
    summary:
      'Open a console: a guest’s screen or terminal, or the host’s journal or shell; then the WebSocket at `path`.',
    params: S,
    body: HostConsoleCreateBody,
    response: HostConsoleSession,
    status: 201,
  }),
  closeConsole: endpoint({
    id: 'hosts.closeConsole',
    method: 'DELETE',
    path: '/burrows/:burrow/hosts/consoles/:sessionId',
    summary: 'End one of the caller’s console sessions.',
    params: B.extend({ sessionId: Seg }),
    response: Ok,
  }),
  screen: endpoint({
    id: 'hosts.screen',
    method: 'POST',
    path: '/burrows/:burrow/hosts/servers/:serverId/screen',
    summary:
      'A Mac’s screen (Whombat macos-servers.md): its state, a click, keys or text by position, unlock, the screen account, and apps’ buttons and fields by name through Whombat Helper. Needs the host-shell switch on both sides. `account.set` carries the Mac’s password to the Mac, never kept by Whombat (a secret op). A screenshot is `hosts.screenLook`’s.',
    params: S,
    body: HostScreenBody,
    response: HostScreenResult,
  }),
  screenLook: endpoint({
    id: 'hosts.screenLook',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/screen',
    summary:
      'A screenshot of a Mac’s screen now, with the screen’s size in pixels. Larger than one session message: clients read it through an export stream.',
    params: S,
    query: HostScreenLookQuery,
    response: HostScreenResult,
  }),
  // Find My on a Mac's page (docs/implementation/macos/findmy.md): what Whombat read last, kept in the box's memory only.
  findMy: endpoint({
    id: 'hosts.findMy',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/find-my',
    summary:
      'What Whombat read last from a Mac’s Find My: its People with their places, whether a read is under way, why the last one didn’t work and the exact picture asked last. Kept in memory only, for an hour after the last look.',
    params: S,
    response: HostFindMy,
  }),
  findMyRefresh: endpoint({
    id: 'hosts.findMyRefresh',
    method: 'POST',
    path: '/burrows/:burrow/hosts/servers/:serverId/find-my/refresh',
    summary:
      'Read a Mac’s Find My now, unless a read is under way or the last is under two minutes old: Whombat unlocks the screen when it is locked (and locks it again), opens Find My, reads its People and finds their places with the Mac’s geocoder. Someone using the Mac is left alone (`in_use`).',
    params: S,
    body: HostFindMyRefreshBody,
    response: HostFindMy,
  }),
  findMyExact: endpoint({
    id: 'hosts.findMyExact',
    method: 'POST',
    path: '/burrows/:burrow/hosts/servers/:serverId/find-my/exact',
    summary:
      'Take Find My’s own map of one person from the Mac’s screen (`hosts.findMyPicture` once `exact.state` is `ready`).',
    params: S,
    body: HostFindMyExactBody,
    response: HostFindMy,
  }),
  findMyMap: endpoint({
    id: 'hosts.findMyMap',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/find-my/map',
    summary:
      'A map picture drawn by the Mac with everyone Whombat found a place for, and where each of them is on it. Larger than one session message: clients read it through an export stream.',
    params: S,
    query: HostFindMyMapQuery,
    response: HostFindMyMap,
  }),
  findMyPicture: endpoint({
    id: 'hosts.findMyPicture',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/find-my/picture',
    summary:
      'Find My’s own map of one person, cut from the Mac’s screen when it was asked (kept ten minutes). Larger than one session message: clients read it through an export stream.',
    params: S,
    query: HostFindMyPictureQuery,
    response: HostFindMyPicture,
  }),
  inspect: endpoint({
    id: 'hosts.inspect',
    method: 'GET',
    path: '/burrows/:burrow/hosts/servers/:serverId/inspect/:kind',
    summary: 'Ask the server now for its processes, listening ports, services or pending updates.',
    params: S.extend({ kind: HostInspectKind }),
    response: HostInspectResult,
  }),
  diskUsage: endpoint({
    id: 'hosts.diskUsage',
    method: 'POST',
    path: '/burrows/:burrow/hosts/servers/:serverId/disk-usage',
    summary:
      'Measure what fills one mounted filesystem on a server now, skipping sleeping disks or disks whose sleep state can’t be checked.',
    params: S,
    body: HostDiskUsageBody,
    response: HostDiskUsage,
  }),
  addressChange: endpoint({
    id: 'hosts.addressChange',
    method: 'GET',
    path: '/burrows/:burrow/hosts/address-change',
    summary:
      'Whether this Whombat’s address changed and which servers haven’t found it since (0.117, BF-16): null when there is nothing to say.',
    params: B,
    response: HostAddressChange.nullable(),
  }),
  repoint: endpoint({
    id: 'hosts.repoint',
    method: 'POST',
    path: '/burrows/:burrow/hosts/repoints',
    summary:
      'Point servers at this Whombat (0.117, BF-15, BF-16): for each, sign in once with the caller’s Vault SSH key for its address and update its agent in place. Answers the job at once; `hosts.repoint` events and `hosts.getRepoint` follow it.',
    params: B,
    body: HostRepointBody,
    response: HostRepoint,
    status: 202,
  }),
  getRepoint: endpoint({
    id: 'hosts.getRepoint',
    method: 'GET',
    path: '/burrows/:burrow/hosts/repoints/:repointId',
    summary: 'A repoint job, with how each server went: pointed here, no key for it, or why it didn’t work.',
    params: B.extend({ repointId: Seg }),
    response: HostRepoint,
  }),
};
