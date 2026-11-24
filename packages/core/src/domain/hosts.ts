/**
 * Servers from the hosts service (Rackoon folded in; Whombat one-whombat.md ONE-11…ONE-15, contracts 0.80.0, CT-339).
 * The hosts service (`whombat-hosts`, headless) speaks snake_case JSON over its Unix socket
 * (`hosts/web/src/api/types.ts`, `docs/CONTRACT.md`, `docs/REST-API.md`, `docs/MANAGE.md`); the Whombat server
 * maps it to these camelCase `Host*` shapes for its REST API, Home and the Servers tools. Rarely used nested parts are
 * typed but optional, so a hub that leaves them out still parses. Ids are the hub's: a server id (`pve-02`), a guest id
 * `<platform>:<id>` (`pve:101`, `docker:pihole`, `incus:web`), an alert id (`al_…`), a Proxmox UPID for tasks.
 */
import { z } from 'zod';
import { utf8ByteLength } from '../text/utf8.js';
import { parseVaultSshHost } from '../vault/ssh.js';
import { JsonObject, Timestamp } from './common.js';
import { KeptQuiet, NoticeQuiet } from './quiet.js';

const N = z.number().nullable();
const OptN = N.optional();
const OptS = z.string().nullable().optional();
const Id = z.string().min(1).max(200);

/* Enums ------------------------------------------------------------------------------------------- */

export const HostSeriesRange = z.enum(['1h', '6h', '24h', '7d', '30d', '90d']);
export type HostSeriesRange = z.infer<typeof HostSeriesRange>;
export const HOST_SERIES_RANGES = HostSeriesRange.options;

/**
 * A server's status as Whombat shows it (CT-339): `ok`, `warn` (the hub's `warning`, or open warning alerts), `bad`
 * (open critical alerts), `offline`, `pending` (enrolled, its agent never reported).
 */
export const HostServerStatus = z.enum(['ok', 'warn', 'bad', 'offline', 'pending']);
export type HostServerStatus = z.infer<typeof HostServerStatus>;

export const HostSeverity = z.enum(['critical', 'warning']);
export type HostSeverity = z.infer<typeof HostSeverity>;
export const HostGuestState = z.enum(['running', 'stopped', 'unhealthy', 'paused']);
export type HostGuestState = z.infer<typeof HostGuestState>;
export const HostPlatform = z.enum(['docker', 'incus', 'libvirt', 'pve']);
export type HostPlatform = z.infer<typeof HostPlatform>;
export const HostStack = z.enum(['incus', 'libvirt', 'proxmox']);
export const HostGuestKind = z.enum(['vm', 'container']);
export type HostGuestKind = z.infer<typeof HostGuestKind>;
/** `logs`: read-only (Docker logs, the host's journal). SPICE is never served by Whombat (ONE-13). */
export const HostConsoleProtocol = z.enum(['vnc', 'spice', 'serial', 'shell', 'tty', 'logs']);
export type HostConsoleProtocol = z.infer<typeof HostConsoleProtocol>;
/**
 * Which page a server gets: `proxmox` (cluster, storages, backups, VMs and containers) or `standard`; since 0.83
 * (CT-363, Whombat incus-unraid.md IU-03) `incus` (Incus without Proxmox VE or unRAID: projects, pools, images,
 * profiles, networks) and `unraid` (array, parity, pools, shares, plugins); since 0.84 (CT-369, IU-13) `libvirt`
 * (“QEMU/KVM”: libvirt without Proxmox VE, unRAID or Incus; pools, networks, ISO images); `macos` a Mac (Whombat
 * macos-servers.md: its own facts, the screen and the helper, `HostServerDetail.macos`). The hub picks Proxmox
 * VE > unRAID > Incus > libvirt > standard on Linux, and `macos` for every Mac. A client maps a value it doesn't know to
 * `standard`.
 */
export const HostServerPlatform = z.enum(['proxmox', 'standard', 'incus', 'unraid', 'libvirt', 'macos']);
export type HostServerPlatform = z.infer<typeof HostServerPlatform>;

/**
 * The family of a server's operating system (Whombat macos-servers.md): what its agent runs on. Absent is
 * `linux` (every agent before Macs).
 */
export const HostOsFamily = z.enum(['linux', 'macos']);
export type HostOsFamily = z.infer<typeof HostOsFamily>;

/* Remote control ---------------------------------------------------------------------------------- */

/** What may be done on a server: the hub's switches and the agent's, combined, with reasons when off. */
export const HostRemoteControl = z.object({
  console: z.boolean(),
  power: z.boolean(),
  agentConsole: z.boolean().optional(),
  agentPower: z.boolean().optional(),
  consoleReason: OptS,
  powerReason: OptS,
  hostShell: z.boolean().optional(),
  hostPower: z.boolean().optional(),
  agentHostShell: z.boolean().optional(),
  agentHostPower: z.boolean().optional(),
  hostShellReason: OptS,
  hostPowerReason: OptS,
  manage: z.boolean().optional(),
  agentManage: z.boolean().optional(),
  manageReason: OptS,
  diagnose: z.boolean().optional(),
  agentDiagnose: z.boolean().optional(),
  diagnoseReason: OptS,
});
export type HostRemoteControl = z.infer<typeof HostRemoteControl>;

/** The hub's switches for a server (Settings), or the agent's policy. */
export const HostRemoteToggles = z.object({
  console: z.boolean(),
  power: z.boolean(),
  hostShell: z.boolean().optional(),
  hostPower: z.boolean().optional(),
  manage: z.boolean().optional(),
  diagnose: z.boolean().optional(),
});
export type HostRemoteToggles = z.infer<typeof HostRemoteToggles>;

/**
 * Whether Whombat asks a person before its risky calls on a server (0.86, CT-380; Whombat server-asks.md SA-01…SA-03):
 * `never` (the default: Whombat acts on its own there, but for `server_power` and installing updates with
 * `server_update` on the server this Whombat runs on) or `risky` (the Servers catalog's sensitive tools and
 * `SERVERS_SENSITIVE` rules ask). Kept by Whombat, not by the hosts service; the person changes it
 * (`hosts.updateServer`).
 */
export const HOST_ASKS_FIRST = ['risky', 'never'] as const;
export const HostAsksFirst = z.enum(HOST_ASKS_FIRST);
export type HostAsksFirst = z.infer<typeof HostAsksFirst>;
export const HOST_ASKS_FIRST_DEFAULT: HostAsksFirst = 'never';

/**
 * The words of the servers' “Ask me first · Go ahead” (SA-08; since 0.98 they name updates, SWU-09, CT-504), the same
 * three words as everything else the assistant may do (settings-groups.md): the label asks the question
 * and the choices answer it, so no choice contradicts the label. `server` is the server's name; `self` it runs this
 * Whombat.
 */
export const HOST_ASKS_FIRST_WORDS = {
  label: 'When Whombat wants to change something here',
  /** The same question with the server's name, for screen readers and lists of servers. */
  labelOn: (server: string) => `When Whombat wants to change something on ${server}`,
  choices: { risky: 'Ask me first', never: 'Go ahead' } as Record<HostAsksFirst, string>,
  hint: {
    risky: 'Commands, restarts, updates, deleting and restoring wait for your yes.',
    never: 'Whombat goes ahead on its own here. Everything it does shows under “Changes here”.',
  } as Record<HostAsksFirst, string>,
  selfNote: (server: string) =>
    `It always asks before restarting, shutting down or updating ${server}, which runs this Whombat.`,
  confirmTitle: (server: string) => `Let Whombat go ahead on ${server}?`,
  confirmBody: (server: string) =>
    `Whombat will run commands, install updates, restart guests and delete things on ${server} without asking you first. You can switch it back any time.`,
  confirm: 'Go ahead',
  /** The toast after a change: “The Titan: Whombat goes ahead without asking.” */
  changed: (server: string, asks: HostAsksFirst) =>
    asks === 'never' ? `${server}: Whombat goes ahead without asking.` : `${server}: Whombat asks you first.`,
} as const;

/**
 * Whether the Servers catalog's sensitive rules apply to a call on a server (SA-03, SA-06): always on `risky`; on
 * `never` only for `server_power` and `server_update` on the server this Whombat runs on (SWU-08, CT-504: an upgrade
 * there can restart Whombat's own database). `server_update`'s rule asks only for `install`, so Check never asks.
 */
export function serverAsksApply(
  tool: string,
  server: { asksFirst?: HostAsksFirst | null; hostsThisWhombat?: boolean },
): boolean {
  if ((server.asksFirst ?? HOST_ASKS_FIRST_DEFAULT) !== 'never') return true;
  return (tool === 'server_power' || tool === 'server_update') && server.hostsThisWhombat === true;
}

export const HostMaintenanceInfo = z.object({ id: Id, until: Timestamp, note: z.string() });

/* Fleet ------------------------------------------------------------------------------------------- */

export const HostCpu = z.object({ model: z.string(), cores: z.number().int(), threads: z.number().int() });
export type HostCpu = z.infer<typeof HostCpu>;

/** Guests running and in total on one platform of a server (`pve` VMs and containers count together). */
export const HostGuestCount = z.object({
  platform: HostPlatform,
  running: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  unhealthy: z.number().int().nonnegative().optional(),
});
export type HostGuestCount = z.infer<typeof HostGuestCount>;

/** The points of `HostServer.cpu24h`: 24 hours in 30-minute buckets, oldest first. */
export const HOST_CPU24H_POINTS = 48;

/**
 * The name a person gave a server (“The Titan” for `the-titan`), kept by Whombat: what every screen and message calls
 * it, while links, tools and the hosts service keep the id. One line of 1 to 60 characters, spaces allowed.
 */
export const HOST_SERVER_NAME_MAX = 60;
export const HostServerGivenName = z
  .string()
  .trim()
  .min(1, 'Give it a name.')
  .max(HOST_SERVER_NAME_MAX, `At most ${HOST_SERVER_NAME_MAX} characters.`)
  .regex(/^[^\p{Cc}]+$/u, 'One line, without tabs.');

/** A row of the servers table (Home's Servers card, the fleet). */
export const HostServer = z.object({
  id: Id,
  /** The name shown: the name a person gave it, else its host name's capitals (“BlackBox”), else the id. */
  name: z.string().min(1).max(120),
  group: z.string().max(120),
  status: HostServerStatus,
  statusNote: OptS,
  platform: HostServerPlatform,
  /** “Proxmox VE 9.0.10”, “Debian GNU/Linux 13”, “macOS 27.2.1”; null before the agent reported. */
  os: z.string().nullable(),
  /** What its agent runs on; absent: Linux. */
  osFamily: HostOsFamily.optional(),
  cpu: HostCpu.nullable(),
  uptimeS: OptN,
  cpuPct: N,
  memory: z.object({ usedPct: N, usedGb: OptN, totalGb: N }),
  storage: z.object({ usedPct: N, usedTb: OptN, capacityTb: N }),
  /** The hottest sensor against its limit (85 °C when the hub has none). */
  temperature: z.object({ maxC: N, limitC: N }).nullable(),
  diskWearMaxPct: OptN,
  guests: z.array(HostGuestCount).max(8),
  agent: z.object({ version: z.string().nullable(), connected: z.boolean() }),
  lastSeen: Timestamp.nullable(),
  cpu24h: z.array(N).max(HOST_CPU24H_POINTS),
  remoteControl: HostRemoteControl,
  alerts: z
    .object({ critical: z.number().int().nonnegative(), warning: z.number().int().nonnegative() })
    .optional(),
  maintenance: HostMaintenanceInfo.nullable().optional(),
  /** The enrolled server this one runs on. */
  parent: OptS,
  /** One of its guests is this Whombat itself (0.83, CT-363; IU-02); only when true. */
  hostsThisWhombat: z.boolean().optional(),
  /** Whether Whombat asks before its risky calls here (0.86, CT-380; SA-01); absent is `risky`. */
  asksFirst: HostAsksFirst.optional(),
});
export type HostServer = z.infer<typeof HostServer>;

export const HostFleetKpis = z.object({
  serversOnline: z.number().int(),
  serversTotal: z.number().int(),
  cpuAvgPct: N,
  memoryPct: N,
  memoryUsedGb: z.number(),
  memoryTotalGb: z.number(),
  storageUsedTb: z.number(),
  storageTotalTb: z.number(),
  storagePct: N,
  disksOver75Wear: z.number().int(),
  openAlerts: z.number().int(),
  openAlertsCritical: z.number().int(),
  openAlertsWarning: z.number().int(),
  openAlertsAttention: z.number().int().optional(),
});
export type HostFleetKpis = z.infer<typeof HostFleetKpis>;

/* Alerts and hints -------------------------------------------------------------------------------- */

export const HostAlertAck = z.object({
  at: Timestamp,
  by: z.string(),
  note: z.string(),
  /** A snooze: the acknowledgement lapses then. */
  until: Timestamp.nullable(),
});
export type HostAlertAck = z.infer<typeof HostAlertAck>;

export const HostAlert = z.object({
  id: Id,
  /** Null for hub-level alerts (checks). */
  serverId: z.string().nullable(),
  severity: HostSeverity,
  title: z.string(),
  detail: z.string(),
  openedAt: Timestamp,
  rule: z.string(),
  state: z.enum(['open', 'resolved']),
  resolvedAt: Timestamp.nullable().optional(),
  /** The server page's section (`storage`, `sensors`, `guests`), without `#`. */
  section: OptS,
  acknowledged: HostAlertAck.nullable().optional(),
  /** The server is in maintenance. */
  muted: z.boolean().optional(),
  /** The server it runs on is offline (the cause). */
  suppressedBy: OptS,
  /** Open and none of the above: counts in the Watch badge. */
  attention: z.boolean(),
  /**
   * What it is about within the server (0.122, CT-1066; Whombat quiet-notices.md QN-03, QN-23): the disk, mount, pool,
   * sensor, guest or check (`fs:/mnt/data`, `pool:tank`, `pve/101`, `check:<id>`; `host` for the server itself), as the
   * hosts service names it. Absent: the hosts service didn't say.
   */
  entity: z.string().max(200).optional(),
  /**
   * The hosts service's key of the condition, `<rule>:<entity>` (0.122, CT-1066): the same while it recurs, unlike `id`,
   * which is new each time it opens. Absent: the hosts service didn't say.
   */
  key: z.string().max(300).optional(),
  /**
   * Quiet (0.122, CT-1068; QN-14, QN-23): the runtime's reading of the hosts service's acknowledgement — ignored until it
   * resolves (“until it’s back online”) or snoozed (“until tomorrow 09:00”), by the person who did it. Drawn greyed at
   * the bottom of Worth a look; absent while it asks for attention.
   */
  quiet: NoticeQuiet.optional(),
});
export type HostAlert = z.infer<typeof HostAlert>;

/** A condition worth watching that is not (yet) an alert (`sensor.near_limit`, `disk.wear`, `agent.outdated`, …). */
export const HostHint = z.object({
  serverId: Id,
  kind: z.string(),
  severity: z.enum(['warning', 'info']),
  entity: z.string(),
  title: z.string(),
  detail: z.string(),
  section: z.string(),
  /**
   * The hint's stable id on its server, `<kind>:<entity>` (0.122, CT-1066; QN-23): what Whombat quiets it by. Absent:
   * Whombat joins `kind` and `entity` the same way.
   */
  id: z.string().max(200).optional(),
  /**
   * Quiet in Whombat (0.122, CT-1068; QN-23): ignored or snoozed, from the runtime's own store. A hint whose check is
   * switched off for the server or its item is left out altogether. Absent: not quiet.
   */
  quiet: NoticeQuiet.optional(),
});
export type HostHint = z.infer<typeof HostHint>;

/** `hosts.fleet`. */
export const HostFleet = z.object({
  asOf: Timestamp,
  groups: z.array(z.object({ name: z.string(), count: z.number().int() })),
  kpis: HostFleetKpis,
  servers: z.array(HostServer),
  alerts: z.array(HostAlert),
  hints: z.array(HostHint),
  agentsConnected: z.number().int(),
  pendingEnrollments: z.number().int(),
});
export type HostFleet = z.infer<typeof HostFleet>;

/* Server detail ----------------------------------------------------------------------------------- */

export const HostCollector = z.object({ name: z.string(), ok: z.boolean(), error: OptS });

export const HostServerInfo = z.object({
  id: Id,
  /** The name a person gave it (kept by Whombat, `HostServerGivenName`); absent: it goes by its id. */
  name: z.string().min(1).max(120).optional(),
  group: z.string(),
  status: HostServerStatus,
  statusNote: OptS,
  roles: z.array(z.string()),
  os: z.object({ name: z.string(), version: z.string(), kernel: z.string() }).nullable(),
  /** What its agent runs on; absent: Linux. */
  osFamily: HostOsFamily.optional(),
  cpu: HostCpu.nullable(),
  memory: z.object({ totalGb: z.number(), type: z.string().nullable() }).nullable(),
  uptimeS: N,
  lastBoot: Timestamp.nullable(),
  address: z.string().nullable(),
  location: z.string().nullable(),
  agent: z.object({
    version: z.string().nullable(),
    lastSyncSAgo: N,
    connected: z.boolean().optional(),
    clockSkewS: OptN,
  }),
  platform: HostServerPlatform,
  remoteControl: HostRemoteControl,
  collectors: z.array(HostCollector).optional(),
  maintenance: HostMaintenanceInfo.nullable().optional(),
  parent: OptS,
  /** One of its guests is this Whombat itself (0.83, CT-363; IU-02); only when true. */
  hostsThisWhombat: z.boolean().optional(),
  /** Whether Whombat asks before its risky calls here (0.86, CT-380; SA-01); absent is `risky`. */
  asksFirst: HostAsksFirst.optional(),
});
export type HostServerInfo = z.infer<typeof HostServerInfo>;

export const HostLive = z.object({
  refreshIntervalS: z.number(),
  cpuPct: N,
  cpuUserPct: OptN,
  cpuSystemPct: OptN,
  cpuIowaitPct: OptN,
  loadAvg: z.array(z.number()).nullable().optional(),
  memPct: N,
  memUsedGb: N,
  memCacheGb: OptN,
  zfsArcGb: OptN,
  memFreeGb: OptN,
  swapUsedGb: OptN,
  swapTotalGb: OptN,
});
export type HostLive = z.infer<typeof HostLive>;

export const HostBanner = z.object({
  severity: HostSeverity,
  title: z.string(),
  detail: z.string(),
  section: z.string().nullable(),
  /**
   * The alert the banner shows (0.122, CT-1068): its rule and id, as the hosts service sends them (`rule`, `alert_id`),
   * so a client matches the banner to its alert by id, not by title. Absent: the hosts service didn't say.
   */
  rule: z.string().max(80).optional(),
  alertId: z.string().max(200).optional(),
});

export const HostSensor = z.object({
  id: Id,
  label: z.string(),
  group: z.string().optional(),
  source: z.string(),
  nowC: N,
  /** Max over the requested range. */
  maxC: N,
  limitC: N,
});
export type HostSensor = z.infer<typeof HostSensor>;

export const HostSmart = z.object({
  passed: z.boolean().nullable().optional(),
  reallocated: OptN,
  pending: OptN,
  uncorrectable: OptN,
  selfTest: z
    .object({ type: z.string(), result: z.string(), poh: z.number().optional() })
    .nullable()
    .optional(),
  errorLog: OptN,
  crcErrors: OptN,
  criticalWarning: OptN,
  sparePct: OptN,
  spareThreshold: OptN,
  mediaErrors: OptN,
  unsafeShutdowns: OptN,
  standby: z.boolean().optional(),
});

export const HostDiskIo = z.object({
  readMbs: z.number(),
  writeMbs: z.number(),
  utilPct: z.number(),
  awaitMs: z.number(),
});

/** A disk of a standard host or of a Proxmox node (pool instead of role). */
export const HostDisk = z.object({
  device: z.string(),
  type: z.enum(['nvme', 'hdd', 'ssd']).optional(),
  model: z.string(),
  role: z.string().optional(),
  pool: z.string().optional(),
  capacityGb: OptN,
  usedGb: OptN,
  wearPct: N,
  writtenTb: OptN,
  ratedTbw: OptN,
  tempC: N,
  powerOnHours: OptN,
  health: z.enum(['healthy', 'wear_high', 'failing']).optional(),
  healthReason: OptS,
  smart: HostSmart.optional(),
  io: HostDiskIo.nullable().optional(),
});
export type HostDisk = z.infer<typeof HostDisk>;

export const HostVirtualization = z.object({
  stacks: z.array(HostStack),
  capabilities: z
    .object({
      kvm: z.object({ enabled: z.boolean(), module: z.string().nullable(), device: z.string().nullable() }),
      cpuVirtualization: z.object({
        type: z.string().nullable(),
        flag: z.string().nullable(),
        nestedPaging: z.boolean(),
      }),
      iommu: z.object({ enabled: z.boolean(), groups: N, vfioPciDevices: N }),
      nested: z.object({ enabled: z.boolean(), moduleParam: z.string().nullable() }),
      hugepages: z
        .object({ reservedGb: z.number(), pageSize: z.string(), count: z.number() })
        .nullable()
        .optional(),
      ksm: z.object({ savedGb: z.number() }).nullable().optional(),
      ballooning: z
        .object({ state: z.string(), vmsActive: z.number().optional(), vmsTotal: z.number().optional() })
        .nullable()
        .optional(),
    })
    .optional(),
  allocation: z.object({
    vcpuAllocated: z.number(),
    hostThreads: z.number(),
    vcpuOvercommitRatio: z.number(),
    guestMemoryAssignedGb: z.number(),
    hostMemoryGb: z.number(),
    guestMemoryInUseGb: N,
    diskIoMbs: z.object({ total: z.number(), read: z.number(), write: z.number() }).nullable(),
    networkMbps: z.object({ total: z.number(), rx: z.number(), tx: z.number() }).nullable(),
  }),
});
export type HostVirtualization = z.infer<typeof HostVirtualization>;

/**
 * Installing a server's operating-system updates (0.98, CT-500; Whombat server-updates.md SWU-01…SWU-06): `check`
 * refreshes the package lists and reads the waiting updates again; `install` installs everything waiting, or only the
 * named packages. Each runs on the server as a task `pkg:<16 hex>` outside the agent, one at a time; neither ever
 * restarts the server, changes a repository or upgrades to a new release.
 */
export const HOST_PACKAGE_OPS = ['check', 'install'] as const;
export const HostPackageOp = z.enum(HOST_PACKAGE_OPS);
export type HostPackageOp = z.infer<typeof HostPackageOp>;

/** A package's name as `packages.install` takes it (CT-500): apt, dnf, yum, zypper and apk names, `pkg:arch` too. */
export const HOST_PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+._:@~-]{0,127}$/;
/** At most this many named packages in one Install. */
export const HOST_PACKAGES_MAX = 200;
export const HostPackageNames = z
  .array(z.string().regex(HOST_PACKAGE_NAME_PATTERN))
  .min(1)
  .max(HOST_PACKAGES_MAX);

/**
 * Why a package task ended early (CT-502; `HostTask.code`, `HostPackageLast.code`): `busy`, another program still held
 * the package lock after two minutes; `timeout`, it passed its limit (Check 10 minutes, Install 2 hours). Open on the
 * wire: a client shows the task's `message` for a code it doesn't know.
 */
export const HOST_PACKAGE_TASK_CODES = ['busy', 'timeout'] as const;

/** The package task running on a server (CT-501): Check or Install, since when; `hosts.getTask` with `platform: host`. */
export const HostPackageTask = z.object({
  id: z.string().min(1).max(500),
  op: HostPackageOp,
  startedAt: Timestamp,
});
export type HostPackageTask = z.infer<typeof HostPackageTask>;

/** How the last package task on a server ended (CT-501), kept across agent restarts. */
export const HostPackageLast = z.object({
  op: HostPackageOp,
  status: z.enum(['ok', 'failed']),
  finishedAt: Timestamp,
  /** How many packages Install installed; null for Check (and for an Install that stopped before it counted). */
  installed: z.number().int().nonnegative().nullable(),
  /** Why it failed, or on `ok` a warning in one sentence (SWU-06's Proxmox enterprise repository); null: none. */
  message: z.string().nullable(),
  /** Why it ended early (`HOST_PACKAGE_TASK_CODES`: `busy`, `timeout`); null otherwise (CT-502). */
  code: z.string().max(64).nullable(),
});
export type HostPackageLast = z.infer<typeof HostPackageLast>;

/** Updates, reboots, failed services, time, pressure. */
export const HostSystem = z.object({
  packageManager: z.string().nullable(),
  updates: N,
  securityUpdates: N,
  updatesCheckedAt: Timestamp.nullable(),
  updatesError: z.string().nullable(),
  rebootRequired: z.boolean(),
  rebootReason: z.string().nullable(),
  /** The package task running now, or null (0.98, CT-501); absent: the hosts service didn't say. */
  packageTask: HostPackageTask.nullable().optional(),
  /** How the last package task ended, or null when none ran (0.98, CT-501); absent: the hosts service didn't say. */
  packageLast: HostPackageLast.nullable().optional(),
  initSystem: z.string().nullable(),
  failedCount: z.number().int(),
  failedUnits: z.array(z.string()),
  timeSynced: z.boolean().nullable(),
  timeOffsetMs: N,
  timeSource: z.string().nullable(),
  oomKills: z.number().int(),
  processes: z.number().int(),
  stealPct: N,
  pressure: z
    .object({
      cpu: z.number(),
      memory: z.number(),
      memoryFull: z.number(),
      io: z.number(),
      ioFull: z.number(),
    })
    .nullable(),
});
export type HostSystem = z.infer<typeof HostSystem>;

export const HostNetIface = z.object({
  name: z.string(),
  kind: z.string(),
  up: z.boolean(),
  carrier: z.boolean(),
  speedMbps: N,
  mtu: N,
  addresses: z.array(z.string()),
  master: z.string().nullable(),
  members: z.array(z.string()),
  rxMbps: z.number(),
  txMbps: z.number(),
  errors: z.number(),
  drops: z.number(),
});

export const HostVolume = z.object({
  entity: z.string(),
  kind: z.enum(['fs', 'pool', 'storage']),
  label: z.string(),
  usedGb: z.number(),
  totalGb: z.number(),
  usedPct: z.number(),
  fullInDays: N,
  fsType: OptS,
  device: OptS,
  inodesPct: OptN,
  readOnly: z.boolean().optional(),
  remote: z.boolean().optional(),
  error: OptS,
  health: OptS,
  layout: OptS,
  scrub: z
    .object({ state: z.string(), end: z.string().nullable(), errors: z.number() })
    .nullable()
    .optional(),
  errors: z.object({ read: z.number(), write: z.number(), checksum: z.number() }).nullable().optional(),
  fragPct: OptN,
  faulted: z.array(z.string()).optional(),
  status: OptS,
});
export type HostVolume = z.infer<typeof HostVolume>;

/**
 * A Proxmox task, an Incus operation (`incus:<uuid>`; running ones and the last 48 hours since 0.83), an unRAID
 * command the agent runs (`unraid:<16 hex>`, 0.83, CT-365) or a libvirt job the agent runs (`libvirt:<16 hex>`: clone,
 * backup, restore, download, disk copy; 0.84, CT-370) — the server's Tasks — or a manage task's status with its log.
 * Since 0.98 (CT-501) also a package task on the server itself (`pkg:<16 hex>`, `platform: host`; Check is
 * `cancellable`, Install never), with `packages` once it ended.
 */
export const HostTask = z.object({
  id: z.string().min(1).max(500),
  type: z.string(),
  platform: z.string().optional(),
  guestId: OptS,
  node: z.string().optional(),
  user: OptS,
  started: Timestamp,
  ended: Timestamp.nullable().optional(),
  status: z.enum(['running', 'ok', 'warning', 'error']),
  message: z.string().optional(),
  log: z.array(z.string()).optional(),
  logNext: z.number().int().optional(),
  /** It can be stopped with `task.stop` (an Incus operation that says `may_cancel`; 0.83, CT-364). */
  cancellable: z.boolean().optional(),
  /**
   * A package task's outcome once it ended (0.98, CT-501): how many packages it installed (0 for Check), the ones the
   * package manager kept back, and a warning in one sentence (SWU-06), or null.
   */
  packages: z
    .object({
      installed: z.number().int().nonnegative(),
      keptBack: z.array(z.string()),
      warning: z.string().nullable(),
    })
    .optional(),
  /** Set only when a package task ended early (`HOST_PACKAGE_TASK_CODES`: `busy`, `timeout`; CT-502). */
  code: z.string().max(64).optional(),
});
export type HostTask = z.infer<typeof HostTask>;

/** The host health parts of a detail (Storage, Sensors, System tabs); each absent when the hosts service sends none. */
export const HostHealth = z.object({
  system: HostSystem.nullable().optional(),
  network: z.array(HostNetIface).optional(),
  volumes: z.array(HostVolume).optional(),
  arrays: z
    .array(
      z.object({
        name: z.string(),
        level: z.string(),
        state: z.string(),
        devices: z.number(),
        active: z.number(),
        members: z.array(z.string()),
        failed: z.array(z.string()),
        syncPct: N,
        sizeGb: N,
        lastCheck: z.string().nullable(),
        checkErrors: N,
      }),
    )
    .optional(),
  ups: z
    .array(
      z.object({
        name: z.string(),
        model: z.string().nullable(),
        status: z.string(),
        chargePct: N,
        runtimeS: N,
        loadPct: N,
      }),
    )
    .optional(),
  gpus: z
    .array(
      z.object({
        index: z.number(),
        name: z.string(),
        vendor: z.string(),
        utilPct: N,
        memUsedGb: N,
        memTotalGb: N,
        tempC: N,
        powerW: N,
      }),
    )
    .optional(),
  fans: z.array(z.object({ label: z.string(), source: z.string(), rpm: z.number(), minRpm: N })).optional(),
  tasks: z.array(HostTask).optional(),
  pveReplication: z
    .array(
      z.object({
        id: z.string(),
        guest: z.string(),
        target: z.string(),
        lastSync: z.string().nullable(),
        error: z.string().nullable(),
        fails: z.number(),
      }),
    )
    .optional(),
  ceph: z
    .object({ status: z.string(), summary: z.array(z.string()) })
    .nullable()
    .optional(),
});
export type HostHealth = z.infer<typeof HostHealth>;

/* Guests ------------------------------------------------------------------------------------------ */

export const HostGuestConsole = z.object({
  available: z.boolean(),
  protocols: z.array(HostConsoleProtocol).optional(),
  defaultProtocol: HostConsoleProtocol.optional(),
  resolution: OptS,
  /** Protocols the platform has but Whombat can't serve, with why. */
  unavailable: z.record(z.string(), z.string()).optional(),
});

/** A VM or container (`pve:101`, `incus:web`, `docker:pihole`, `libvirt:win11`). */
export const HostGuest = z.object({
  id: Id,
  serverId: Id,
  /** False when the server is offline (the guest comes from its last report). */
  serverOnline: z.boolean().optional(),
  name: z.string(),
  platform: HostPlatform,
  kind: HostGuestKind,
  image: z.string(),
  state: HostGuestState,
  vcpu: OptN,
  cpuPct: N,
  memoryUsedMb: N,
  memoryLimitMb: N,
  diskReadMbs: OptN,
  diskWriteMbs: OptN,
  netRxMbps: OptN,
  netTxMbps: OptN,
  snapshots: OptN,
  uptimeS: N,
  lastExit: OptS,
  console: HostGuestConsole,
  vmid: z.number().int().optional(),
  node: z.string().optional(),
  lastBackup: z.object({ result: z.string(), at: Timestamp }).nullable().optional(),
  addresses: z.array(z.string()).optional(),
  lock: z.string().optional(),
  restarts: z.number().optional(),
  exitCode: z.number().optional(),
  oomKilled: z.boolean().optional(),
  project: z.string().optional(),
  updateAvailable: z.boolean().optional(),
  diskUsedGb: z.number().optional(),
  processes: z.number().optional(),
  tags: z.array(z.string()).optional(),
  pendingChanges: z.number().optional(),
  guestAgent: z.enum(['running', 'not_running']).nullable().optional(),
  oldestSnapshot: OptS,
  backupJob: z.boolean().nullable().optional(),
  haState: OptS,
  /**
   * This Whombat itself (0.83, CT-363; IU-02): one of the guest's network MAC addresses is the hub machine's own. Only
   * when true. Changing it is refused (`self_guest`, `HOST_ERROR_WORDS`) but for `HOST_SELF_GUEST_ALLOWED`.
   */
  self: z.boolean().optional(),
  /** Starts with its host (0.83, CT-365): Docker on unRAID (dockerMan's autostart list), libvirt everywhere. */
  autostart: z.boolean().optional(),
  /**
   * The container's web page (0.83, CT-365): the dockerMan template's `<WebUI>` with `[IP]` and `[PORT:n]` filled in
   * (Docker on unRAID); null when the template has none.
   */
  webUi: z.string().max(2000).nullable().optional(),
  /** A dockerMan template exists for the container, so `container.update` works (Docker on unRAID; 0.83, CT-365). */
  template: z.boolean().optional(),
  /**
   * The container's labels Whombat reads (`whombat.service`: one of Whombat's own services), only those; the apps hide
   * Whombat's own containers from the person's lists by it. Absent on a hosts service that doesn't send them.
   */
  labels: z.record(z.string().max(100), z.string().max(200)).optional(),
});
export type HostGuest = z.infer<typeof HostGuest>;

/** `hosts.getGuest`: the guest with what may be done to it. */
export const HostGuestDetail = HostGuest.extend({
  remoteControl: HostRemoteControl,
  /** Configuration and lifecycle (Proxmox VE, Incus) are possible: the Manage switch is on both sides. */
  manageable: z.boolean(),
});
export type HostGuestDetail = z.infer<typeof HostGuestDetail>;

/** One platform's guests on a standard host. */
export const HostPlatformWorkload = z.object({
  running: z.number().int(),
  total: z.number().int(),
  cpuPct: N,
  memoryGb: N,
  containers: z.number().int().optional(),
  vms: z.number().int().optional(),
  paused: z.number().int().optional(),
  guests: z.array(HostGuest),
  warnings: z
    .array(
      z.object({
        type: z.string(),
        message: z.string(),
        count: z.number(),
        lastSeen: z.string().nullable(),
        project: z.string().nullable(),
      }),
    )
    .optional(),
});
export type HostPlatformWorkload = z.infer<typeof HostPlatformWorkload>;

export const HostCluster = z.object({
  name: z.string(),
  quorate: z.boolean(),
  votes: z.object({ have: z.number(), expected: z.number() }),
  ha: z.object({ resourcesStarted: z.number() }),
  nodes: z.array(
    z.object({
      name: z.string(),
      thisNode: z.boolean(),
      status: z.string(),
      cpuPct: N,
      memPct: N,
      vms: z.number(),
      containers: z.number(),
      agent: z.enum(['connected', 'offline', 'not_enrolled']),
      serverId: OptS,
    }),
  ),
  note: z.string().nullable(),
});
export type HostCluster = z.infer<typeof HostCluster>;

export const HostStorage = z.object({
  id: z.string(),
  type: z.string(),
  content: z.string(),
  usedGb: z.number(),
  capacityGb: z.number(),
});
export type HostStorage = z.infer<typeof HostStorage>;

export const HostBackups = z.object({
  lastJob: z
    .object({
      at: Timestamp,
      schedule: z.string(),
      mode: z.string(),
      result: z.string(),
      guestsOk: z.number(),
      guestsTotal: z.number(),
      warnings: z.number(),
      writtenGb: z.number(),
      dedupRatio: N,
      durationMin: z.number(),
      avgDurationMinWeek: N,
    })
    .nullable(),
  nextRun: Timestamp.nullable(),
  target: z.string().nullable(),
});
export type HostBackups = z.infer<typeof HostBackups>;

/* Incus (0.83, CT-364; Whombat incus-unraid.md IU-04) ---------------------------------------------- */

/** Incus image and instance types. */
export const HostIncusType = z.enum(['container', 'virtual-machine']);
export type HostIncusType = z.infer<typeof HostIncusType>;

/** An image in an Incus host's image store (`image.download`, `image.refresh`, `image.delete`). */
export const HostIncusImage = z.object({
  fingerprint: z.string().min(1).max(128),
  aliases: z.array(z.string()),
  description: z.string(),
  type: HostIncusType,
  architecture: z.string(),
  sizeBytes: z.number().nonnegative(),
  uploadedAt: Timestamp.nullable(),
  lastUsedAt: Timestamp.nullable(),
  /** Incus refreshes it from where it came from. */
  autoUpdate: z.boolean(),
  /** Downloaded to make an instance (Incus drops unused cached images by itself). */
  cached: z.boolean(),
  project: z.string(),
});
export type HostIncusImage = z.infer<typeof HostIncusImage>;

/** A custom storage volume of an Incus pool (`volume.create`, `volume.resize`, `volume.delete`). */
export const HostStorageVolume = z.object({
  pool: z.string(),
  name: z.string(),
  project: z.string(),
  type: z.literal('custom'),
  contentType: z.enum(['filesystem', 'block', 'iso']),
  sizeBytes: N,
  usedBytes: N,
  /** The guests it is attached to (hub guest ids, `incus:web`). */
  usedBy: z.array(z.string()),
  description: z.string(),
});
export type HostStorageVolume = z.infer<typeof HostStorageVolume>;

export const HostIncusProject = z.object({
  name: z.string(),
  description: z.string(),
  instances: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
});
export type HostIncusProject = z.infer<typeof HostIncusProject>;

export const HostIncusPool = z.object({
  name: z.string(),
  driver: z.string(),
  status: z.string(),
  description: z.string(),
  usedBytes: N,
  totalBytes: N,
  volumes: z.number().int().nonnegative(),
});
export type HostIncusPool = z.infer<typeof HostIncusPool>;

export const HostIncusNetwork = z.object({
  name: z.string(),
  /** `bridge`, `macvlan`, `physical`, `ovn`, … */
  type: z.string(),
  /** Incus manages it (it has address leases); else a host interface. */
  managed: z.boolean(),
  description: z.string(),
  ipv4: z.string().nullable(),
  ipv6: z.string().nullable(),
  nat: z.boolean().nullable(),
  usedBy: z.number().int().nonnegative(),
});
export type HostIncusNetwork = z.infer<typeof HostIncusNetwork>;

/** A profile as the detail lists it; `profile.get` reads one whole (`HostIncusProfile`). */
export const HostIncusProfileSummary = z.object({
  name: z.string(),
  project: z.string(),
  description: z.string(),
  usedBy: z.number().int().nonnegative(),
});
export type HostIncusProfileSummary = z.infer<typeof HostIncusProfileSummary>;

/**
 * `HostServerDetail.incus` (0.83, CT-364): an Incus host's own objects from its agent's report (refreshed every five
 * minutes and after every change). `volumes` are custom volumes only.
 */
export const HostIncusDetail = z.object({
  /** `6.0.4`. */
  version: z.string(),
  clustered: z.boolean(),
  projects: z.array(HostIncusProject),
  pools: z.array(HostIncusPool),
  networks: z.array(HostIncusNetwork),
  profiles: z.array(HostIncusProfileSummary),
  images: z.array(HostIncusImage),
  volumes: z.array(HostStorageVolume),
});
export type HostIncusDetail = z.infer<typeof HostIncusDetail>;

/* unRAID (0.83, CT-365; Whombat incus-unraid.md IU-05) --------------------------------------------- */

/** A disk of an unRAID server: parity, data, pool or the flash drive (`disks.ini`). */
export const HostUnraidDisk = z.object({
  /** `parity`, `parity2`, `disk1`, `cache`, `flash`: the name `disk.spin_up` and `disk.spin_down` take. */
  name: z.string(),
  slot: z.enum(['parity', 'data', 'pool', 'flash']),
  device: z.string().nullable(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  status: z.enum(['ok', 'disabled', 'emulated', 'missing', 'new', 'invalid', 'wrong', 'empty']),
  /** unRAID's own word: `DISK_OK`, `DISK_NP_DSBL`, … */
  statusRaw: z.string(),
  sizeBytes: z.number().nonnegative(),
  usedBytes: N,
  freeBytes: N,
  fsType: z.string().nullable(),
  tempC: N,
  spunDown: z.boolean(),
  /** Read errors since the array started (`numErrors`). */
  errors: z.number().int().nonnegative(),
  rotational: z.boolean().nullable(),
});
export type HostUnraidDisk = z.infer<typeof HostUnraidDisk>;

/** One parity check, sync or rebuild (`/boot/config/parity-checks.log`, or the superblock's last). */
export const HostUnraidParityRun = z.object({
  at: Timestamp,
  durationS: N,
  speedMbs: N,
  errors: z.number().int().nonnegative(),
  result: z.enum(['ok', 'errors', 'cancelled', 'failed']),
  /** `check`, `correct`, `rebuild`, `clear`, … as unRAID logged it. */
  action: z.string().nullable(),
});
export type HostUnraidParityRun = z.infer<typeof HostUnraidParityRun>;

export const HostUnraidParity = z.object({
  state: z.enum(['idle', 'running', 'paused']),
  /** While running or paused (`mdResyncAction`). */
  action: z.enum(['check', 'correct', 'rebuild', 'clear']).nullable(),
  pct: N,
  speedMbs: N,
  etaS: N,
  /** Errors found so far while running (`mdResyncCorr`). */
  errors: z.number().int().nonnegative(),
  last: HostUnraidParityRun.nullable(),
  /** Newest first, at most 10. */
  history: z.array(HostUnraidParityRun).max(10),
  /** In plain words: “Monthly, day 1 at 00:30, no corrections”; null: no schedule. */
  schedule: z.string().nullable(),
});
export type HostUnraidParity = z.infer<typeof HostUnraidParity>;

export const HostUnraidArrayState = z.enum(['started', 'stopped', 'starting', 'stopping', 'invalid']);
export type HostUnraidArrayState = z.infer<typeof HostUnraidArrayState>;

export const HostUnraidArray = z.object({
  state: HostUnraidArrayState,
  /** unRAID's own word: `STARTED`. */
  stateRaw: z.string(),
  /** The array starts when the server boots (`startArray`). */
  startOnBoot: z.boolean(),
  /** Data disks only. */
  sizeBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  disabled: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  moverRunning: z.boolean(),
  parity: HostUnraidParity,
  /** Parity, parity2, disk1, … in slot order. */
  disks: z.array(HostUnraidDisk),
});
export type HostUnraidArray = z.infer<typeof HostUnraidArray>;

export const HostUnraidPool = z.object({
  name: z.string(),
  fsType: z.string(),
  /** `raidz1`, `mirror`, `single`; null when unRAID doesn't say. */
  profile: z.string().nullable(),
  sizeBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  disks: z.array(HostUnraidDisk),
});
export type HostUnraidPool = z.infer<typeof HostUnraidPool>;

export const HostUnraidShare = z.object({
  name: z.string(),
  comment: z.string(),
  usedBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  /** `array` or a pool's name. */
  primary: z.string(),
  secondary: z.string().nullable(),
  moverAction: z.enum(['to_array', 'to_pool']).nullable(),
  /** `public`, `secure` or `private`; null: not shared over SMB. */
  smb: z.string().nullable(),
  nfs: z.boolean(),
  encrypted: z.boolean(),
});
export type HostUnraidShare = z.infer<typeof HostUnraidShare>;

export const HostUnraidPlugin = z.object({
  name: z.string(),
  /** The `.plg` file's name: what `plugin.update` takes. */
  file: z.string(),
  version: z.string(),
  /** The newer version, when there is one. */
  update: z.string().nullable(),
  author: z.string().nullable(),
  supportUrl: z.string().nullable(),
});
export type HostUnraidPlugin = z.infer<typeof HostUnraidPlugin>;

/** An unread unRAID notification (`notification.archive` takes its `id`). */
export const HostUnraidNotification = z.object({
  id: z.string().min(1).max(200),
  at: Timestamp,
  importance: z.enum(['alert', 'warning', 'normal']),
  event: z.string(),
  subject: z.string(),
  description: z.string(),
});
export type HostUnraidNotification = z.infer<typeof HostUnraidNotification>;

/**
 * `HostServerDetail.unraid` (0.83, CT-365): an unRAID server's own objects from its agent's report (every 30 seconds;
 * plugins and update checks every six hours). `osUpdate`: a newer unRAID exists (updating it stays in unRAID, IU-10).
 */
export const HostUnraidDetail = z.object({
  /** `7.3.1`. */
  version: z.string(),
  /** The server's name in unRAID: `BlackBox`. */
  name: z.string(),
  /** The licence: `Pro`. */
  license: z.string().nullable(),
  osUpdate: z.object({ version: z.string() }).nullable(),
  array: HostUnraidArray,
  pools: z.array(HostUnraidPool),
  flash: HostUnraidDisk.nullable(),
  shares: z.array(HostUnraidShare),
  plugins: z.array(HostUnraidPlugin),
  /** Unread, newest first, at most 50. */
  notifications: z.array(HostUnraidNotification).max(50),
  docker: z.object({ enabled: z.boolean(), imageUsedPct: N }),
  vms: z.object({ enabled: z.boolean() }),
});
export type HostUnraidDetail = z.infer<typeof HostUnraidDetail>;

/* libvirt: QEMU/KVM (0.84, CT-370; Whombat incus-unraid.md IU-13) ---------------------------------------------- */

/** A libvirt storage pool (`volume.create`, `volume.resize`, `volume.delete` take its volumes). */
export const HostLibvirtPool = z.object({
  name: z.string(),
  /** `dir`, `logical`, `zfs`, `netfs`, … */
  type: z.string(),
  active: z.boolean(),
  autostart: z.boolean(),
  path: z.string().nullable(),
  usedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  availBytes: z.number().nonnegative(),
  volumes: z.number().int().nonnegative(),
});
export type HostLibvirtPool = z.infer<typeof HostLibvirtPool>;

/** A libvirt network (`network.leases` reads its DHCP leases). */
export const HostLibvirtNetwork = z.object({
  name: z.string(),
  active: z.boolean(),
  autostart: z.boolean(),
  bridge: z.string().nullable(),
  /** `nat`, `route`, `bridge`, `open`, `none`; null when libvirt doesn't say. */
  forward: z.string().nullable(),
  ipv4: z.string().nullable(),
  dhcp: z.boolean(),
  usedBy: z.number().int().nonnegative(),
});
export type HostLibvirtNetwork = z.infer<typeof HostLibvirtNetwork>;

/** What the host's QEMU can give a new VM: UEFI (OVMF), Secure Boot, a TPM (swtpm). */
export const HostLibvirtFirmware = z.object({ uefi: z.boolean(), secureBoot: z.boolean(), tpm: z.boolean() });
export type HostLibvirtFirmware = z.infer<typeof HostLibvirtFirmware>;

/**
 * `HostServerDetail.libvirt` (0.84, CT-370): a host's libvirt from its agent's report (refreshed every five minutes and
 * after every change), on every host that runs it — a `libvirt` server, and unRAID's VM Manager too. `folders`: unRAID's
 * VM folders (`DOMAINDIR`, `MEDIADIR` of `/boot/config/domain.cfg`) where there are no pools, else null. `backupsDir`:
 * where Whombat's VM backups go.
 */
export const HostLibvirtDetail = z.object({
  /** libvirt's version: `12.2.0`. */
  version: z.string(),
  /** QEMU's version: `10.1.0`. */
  qemu: z.string().nullable(),
  pools: z.array(HostLibvirtPool),
  networks: z.array(HostLibvirtNetwork),
  folders: z.object({ domains: z.string().nullable(), isos: z.string().nullable() }).nullable(),
  firmware: HostLibvirtFirmware,
  backupsDir: z.string().nullable(),
});
export type HostLibvirtDetail = z.infer<typeof HostLibvirtDetail>;

/** The storage id of unRAID's VM folders where a pool's name goes (`storage` of create, clone, restore, downloads). */
export const LIBVIRT_DOMAINS_FOLDER = 'folder:domains';
export const LIBVIRT_ISOS_FOLDER = 'folder:isos';
/** A libvirt VM's name: what `guest.create`, `guest.clone`, `guest.rename` and a restore as new take. */
export const LIBVIRT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/* macOS (Whombat macos-servers.md) ------------------------------------------------------------------- */

/**
 * A Mac's screen as its agent sees it: whether Screen Sharing answers on the Mac itself, the account
 * the agent signs in to it with (the password stays on the Mac), how the last sign-in went, whether the screen is
 * locked (from the helper; null when unknown) and the screen's size in pixels from the last sign-in (what clicks count
 * in).
 */
export const HostMacScreen = z.object({
  sharing: z.boolean(),
  /** The user the agent signs in as; null: no account set. */
  account: z.string().nullable(),
  /** `ok`, `failed` (the account was refused), null: not tried yet. */
  signIn: z.enum(['ok', 'failed']).nullable(),
  signInAt: Timestamp.nullable(),
  locked: z.boolean().nullable(),
  w: z.number().int().nonnegative().nullable(),
  h: z.number().int().nonnegative().nullable(),
});
export type HostMacScreen = z.infer<typeof HostMacScreen>;

/**
 * Whombat Helper on a Mac: installed, its version, whether it answered in the last minute in the
 * session of the person at the screen (`user`), and whether it has Accessibility (`ax`; null when it isn't running).
 */
export const HostMacHelper = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  running: z.boolean(),
  ax: z.boolean().nullable(),
  user: z.string().nullable(),
  /** Seconds since someone last used the Mac's keyboard or mouse (helper 1.1.0 and later; null: unknown). */
  idleS: z.number().int().nonnegative().nullable().optional(),
});
export type HostMacHelper = z.infer<typeof HostMacHelper>;

/**
 * `HostServerDetail.macos`: a Mac's own facts from its agent's report. `autoLogin` is the user the Mac signs
 * in by itself after a restart (null: none); `consoleUser` who is at the screen now (null: the login window).
 */
export const HostMacosDetail = z.object({
  /** `27.2.1`. */
  version: z.string(),
  /** `26B131`. */
  build: z.string().nullable(),
  /** `Mac14,14`. */
  model: z.string().nullable(),
  /** `Mac Studio`. */
  modelName: z.string().nullable(),
  /** `Apple M2 Ultra`. */
  chip: z.string().nullable(),
  sip: z.boolean().nullable(),
  filevault: z.boolean().nullable(),
  autoLogin: z.string().nullable(),
  consoleUser: z.string().nullable(),
  screen: HostMacScreen,
  helper: HostMacHelper,
});
export type HostMacosDetail = z.infer<typeof HostMacosDetail>;

/** The oldest macOS Whombat's helper runs on. */
export const HOST_MACOS_MIN_MAJOR = 13;

/* On-request disk usage breakdown ------------------------------------------------------------------- */

/** One recognised bucket in an on-request disk usage breakdown (container images, journal, caches, VM disks…). */
export const HostDiskUsageCategory = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  bytes: z.number().nonnegative(),
  reclaimableBytes: z.number().nonnegative().optional(),
  detail: z.string().max(200).optional(),
});
export type HostDiskUsageCategory = z.infer<typeof HostDiskUsageCategory>;

/** One large directory in an on-request disk usage breakdown. */
export const HostDiskUsageFolder = z.object({
  path: z.string().min(1).max(512),
  bytes: z.number().nonnegative(),
  partial: z.boolean().optional(),
});
export type HostDiskUsageFolder = z.infer<typeof HostDiskUsageFolder>;

/** One on-request breakdown of what fills a mounted filesystem on a server. */
export const HostDiskUsage = z.object({
  mount: z.string().min(1).max(512),
  fsType: z.string().max(64).optional(),
  device: z.string().max(256).optional(),
  measuredAt: Timestamp,
  durationMs: z.number().nonnegative().optional(),
  totalBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  partial: z.boolean().optional(),
  skippedSpunDown: z.array(z.string()).optional(),
  categories: z.array(HostDiskUsageCategory),
  folders: z.array(HostDiskUsageFolder),
  /** False when skipped without measuring (`spun_down` when a disk is asleep, `standby_unknown` when sleep state can’t be checked). */
  ok: z.boolean().optional(),
  code: z.string().max(64).optional(),
  message: z.string().max(500).optional(),
});
export type HostDiskUsage = z.infer<typeof HostDiskUsage>;

/** `hosts.diskUsage` body: which mount to inspect and optional safety bounds. */
export const HostDiskUsageBody = z.object({
  mount: z.string().min(1).max(512).optional(),
  maxDepth: z.number().int().min(1).max(12).optional(),
  timeoutS: z.number().int().min(1).max(45).optional(),
});
export type HostDiskUsageBody = z.infer<typeof HostDiskUsageBody>;

/**
 * `hosts.getServer`: everything on a server's page (mock 2): Summary, Guests, Storage, Sensors, Backups, System.
 * `workloads` on standard hosts; `proxmox` on Proxmox nodes; `incus` on Incus hosts and `unraid` on unRAID servers
 * (0.83, CT-364, CT-365); `libvirt` wherever libvirt runs (0.84, CT-370); `macos` on a Mac.
 */
export const HostServerDetail = z.object({
  asOf: Timestamp,
  server: HostServerInfo,
  live: HostLive.nullable(),
  banner: HostBanner.nullable(),
  sensors: z.array(HostSensor),
  disks: z.array(HostDisk),
  virtualization: HostVirtualization.nullable(),
  hints: z.array(HostHint),
  alerts: z.array(HostAlert).optional(),
  health: HostHealth.optional(),
  /** Recent on-request disk usage breakdowns (measured within 24 hours), newest first. */
  diskUsage: z.array(HostDiskUsage).optional(),
  /**
   * The platforms the host runs (a Docker host has only `docker`). A partial record (0.80.2, CT-351): Zod 4's `z.record`
   * over an enum requires every key, which refused every normal host's page.
   */
  workloads: z.partialRecord(z.enum(['docker', 'incus', 'libvirt']), HostPlatformWorkload).optional(),
  proxmox: z
    .object({
      cluster: HostCluster.nullable(),
      storages: z.array(HostStorage),
      backups: HostBackups.nullable(),
      guests: z.object({ vm: HostPlatformWorkload.optional(), container: HostPlatformWorkload.optional() }),
    })
    .optional(),
  /** Incus's own objects (0.83, CT-364): on an Incus host (and on any host whose agent reports Incus). */
  incus: HostIncusDetail.optional(),
  /** unRAID's own objects (0.83, CT-365): on an unRAID server. */
  unraid: HostUnraidDetail.optional(),
  /** libvirt's objects (0.84, CT-370): on every host that runs libvirt, whatever its kind (an unRAID server too). */
  libvirt: HostLibvirtDetail.optional(),
  /** A Mac's own facts, its screen and its helper: on a Mac. */
  macos: HostMacosDetail.optional(),
  /**
   * Kept quiet until a time (Whombat monitoring.md MON-04, MON-05): the page draws its words with End now when
   * `canEnd`; its alerts are muted by a maintenance window meanwhile.
   */
  keptQuiet: KeptQuiet.optional(),
});
export type HostServerDetail = z.infer<typeof HostServerDetail>;

/** `hosts.listGuests`: guests of the fleet or of one server, with the filter counts. */
export const HostGuestPage = z.object({
  guests: z.array(HostGuest),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
  counts: z
    .object({ all: z.number(), running: z.number(), stopped: z.number(), unhealthy: z.number() })
    .optional(),
  platforms: z.record(z.string(), z.number()).optional(),
  tags: z.record(z.string(), z.number()).optional(),
});
export type HostGuestPage = z.infer<typeof HostGuestPage>;

/* Metrics ----------------------------------------------------------------------------------------- */

/**
 * A server's or guest's history: `timestamps` and each series (`cpu_pct`, `mem_pct`, `temp_max_c`, `net_rx_mbps`,
 * `net_tx_mbps`, `disk.<entity>.used_pct`, …) point for point; null for a gap.
 */
export const HostSeries = z.object({
  serverId: Id,
  guestId: Id.optional(),
  range: z.union([HostSeriesRange, z.literal('custom')]),
  stepSeconds: z.number().int().positive(),
  asOf: Timestamp,
  timestamps: z.array(Timestamp),
  series: z.record(z.string(), z.array(N)),
  summary: z
    .record(z.string(), z.object({ avg: N, max: N, maxAt: Timestamp.nullable() }).nullable())
    .optional(),
});
export type HostSeries = z.infer<typeof HostSeries>;

/* Settings ---------------------------------------------------------------------------------------- */

/**
 * Why a server's agent can or can't take a signed update (0.99, CT-510; Whombat agent-updates.md AU-07, AU-08), as the
 * hosts service says it: `no_build` (no signed agent build on this Whombat), `not_connected`, `up_to_date`, `no_key`
 * (the agent was built without the update key: it needs one more install), `other_key` (built with another key: the
 * same), `turned_off` (the server's own `[update] allow = false`), `newer_running` (it runs a newer version than the
 * build, never downgraded). The hosts service's English `reason` comes beside it.
 */
export const HOST_AGENT_UPDATE_REASON_CODES = [
  'no_build',
  'not_connected',
  'up_to_date',
  'no_key',
  'other_key',
  'turned_off',
  'newer_running',
] as const;
export const HostAgentUpdateReasonCode = z.enum(HOST_AGENT_UPDATE_REASON_CODES);
export type HostAgentUpdateReasonCode = z.infer<typeof HostAgentUpdateReasonCode>;

/**
 * An agent update's state (CT-511): `updating` (rolling out now), `failed` (the last try failed; not tried again for
 * that version until Try again or a newer version), `waiting` (busy, see `waitingFor`; tried again at the next round,
 * AU-04), `halted` (a new version didn't come back on some server, so automatic updates to it stopped everywhere,
 * AU-05).
 */
export const HOST_AGENT_UPDATE_STATES = ['updating', 'failed', 'waiting', 'halted'] as const;
export const HostAgentUpdateState = z.enum(HOST_AGENT_UPDATE_STATES);
export type HostAgentUpdateState = z.infer<typeof HostAgentUpdateState>;

/** What a `waiting` update waits for (CT-511, AU-04): a package task, an open console or shell, a task in the agent. */
export const HOST_AGENT_UPDATE_WAITS = ['packages', 'console', 'task'] as const;
export const HostAgentUpdateWait = z.enum(HOST_AGENT_UPDATE_WAITS);
export type HostAgentUpdateWait = z.infer<typeof HostAgentUpdateWait>;

/**
 * `HostServerSettings.agent.update`: whether the server's agent can be updated and how its update goes (CT-511). Optional,
 * as far as the hosts service says them: `reasonCode`; `auto` (the automatic round would take this server);
 * `waitingFor` (with `state: waiting`); `failedVersion` (the version that failed here); `updatedAt` (its last
 * successful update); `canInstall` (AU-07: it needs one more install and Whombat may run it as root there, so
 * `hosts.updateAgent` does that install).
 */
export const HostAgentUpdate = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  reason: z.string().optional(),
  reasonCode: HostAgentUpdateReasonCode.optional(),
  auto: z.boolean().optional(),
  state: HostAgentUpdateState.optional(),
  waitingFor: HostAgentUpdateWait.optional(),
  message: z.string().optional(),
  failedVersion: z.string().optional(),
  updatedAt: Timestamp.optional(),
  canInstall: z.boolean().optional(),
});
export type HostAgentUpdate = z.infer<typeof HostAgentUpdate>;

export const HostServerSettings = z.object({
  id: Id,
  /** The name a person gave it (kept by Whombat); null when it goes by its id. */
  name: z.string().max(HOST_SERVER_NAME_MAX).nullable().optional(),
  group: z.string(),
  location: z.string().nullable(),
  remoteControl: HostRemoteToggles,
  agentPolicy: HostRemoteToggles,
  /** Whether Whombat asks before its risky calls here (0.86, CT-380; SA-01, kept by Whombat); absent is `risky`. */
  asksFirst: HostAsksFirst.optional(),
  /** `''` = detected automatically, `'-'` = none, else a server id. */
  parent: z.string().optional(),
  detectedParent: OptS,
  agent: z
    .object({
      version: z.string().nullable(),
      arch: z.string().optional(),
      install: OptS,
      certExpiresAt: Timestamp.nullable().optional(),
      update: HostAgentUpdate.optional(),
    })
    .optional(),
});
export type HostServerSettings = z.infer<typeof HostServerSettings>;

/**
 * `hosts.agentSettings` (0.99, CT-512; AU-06): “Keep server agents up to date”, kept by the hosts service, on by
 * default. `halted`: automatic updates stopped because a new version didn't come back on a server (AU-05); Update now on
 * any server clears it.
 */
export const HostAgentSettings = z.object({
  autoUpdate: z.boolean(),
  halted: z.boolean(),
});
export type HostAgentSettings = z.infer<typeof HostAgentSettings>;

/** `hosts.updateAgentSettings`'s body (owners). Off, nothing updates by itself; Update now still works. */
export const HostAgentSettingsPatch = z.object({ autoUpdate: z.boolean() });
export type HostAgentSettingsPatch = z.infer<typeof HostAgentSettingsPatch>;

/**
 * `hosts.updateAgent`'s answer (CT-513): `updating` (a signed update is rolling out; it clears the server's failed mark
 * and the halt) or `installing` (AU-07, the one last install, run as root on a server with `canInstall`). How it ends
 * comes with the server's settings (`agent.update`).
 */
export const HOST_AGENT_UPDATE_STARTS = ['updating', 'installing'] as const;
export const HostAgentUpdateAccepted = z.object({ state: z.enum(HOST_AGENT_UPDATE_STARTS) });
export type HostAgentUpdateAccepted = z.infer<typeof HostAgentUpdateAccepted>;

export const HostServerSettingsPatch = z.object({
  group: z.string().trim().min(1).max(63).optional(),
  location: z.string().max(120).optional(),
  parent: z.string().max(63).optional(),
  remoteControl: HostRemoteToggles.partial().optional(),
  /** Owners only (0.86, CT-380; SA-05); a body with only this doesn't reach the hosts service. */
  asksFirst: HostAsksFirst.optional(),
  /** The name it goes by (kept by Whombat, as `asksFirst`); null puts its id back. */
  name: HostServerGivenName.nullable().optional(),
});
export type HostServerSettingsPatch = z.infer<typeof HostServerSettingsPatch>;

/* Maintenance and checks -------------------------------------------------------------------------- */

export const HostMaintenance = z.object({
  id: Id,
  scope: z.enum(['server', 'group', 'all']),
  target: z.string(),
  startsAt: Timestamp,
  endsAt: Timestamp.nullable(),
  /** Weekly windows: 0 = Sunday. Empty for one-off windows. */
  weekdays: z.array(z.number().int().min(0).max(6)),
  startTime: z.string(),
  durationMin: z.number().int(),
  tz: z.string(),
  note: z.string(),
  createdBy: z.string(),
  createdAt: Timestamp,
  active: z.boolean(),
  activeUntil: Timestamp.nullable(),
  nextStart: Timestamp.nullable(),
});
export type HostMaintenance = z.infer<typeof HostMaintenance>;

export const HostMaintenanceCreate = z.object({
  scope: z.enum(['server', 'group', 'all']),
  target: z.string().max(120).optional(),
  startsAt: Timestamp.optional(),
  endsAt: Timestamp.optional(),
  durationMin: z.number().int().min(1).max(525_600).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  tz: z.string().max(64).optional(),
  note: z.string().max(256).optional(),
});
export type HostMaintenanceCreate = z.infer<typeof HostMaintenanceCreate>;

export const HostCheckKind = z.enum(['http', 'tcp', 'ping', 'dns', 'heartbeat']);
export type HostCheckKind = z.infer<typeof HostCheckKind>;

export const HostCheckOptions = z.object({
  expectStatus: z.string().optional(),
  keyword: z.string().optional(),
  tls: z.boolean().optional(),
  insecure: z.boolean().optional(),
  dnsType: z.string().optional(),
  dnsServer: z.string().optional(),
  expect: z.string().optional(),
  certWarnDays: z.number().int().optional(),
});

/** An uptime or heartbeat check the hub (or a server's agent) runs. */
export const HostCheck = z.object({
  id: Id,
  name: z.string(),
  kind: HostCheckKind,
  target: z.string(),
  /** `hub` or a server id. */
  runner: z.string(),
  intervalS: z.number().int(),
  timeoutS: z.number().int(),
  graceS: z.number().int(),
  options: HostCheckOptions,
  enabled: z.boolean(),
  status: z.enum(['up', 'down', 'pending', 'disabled']),
  since: Timestamp.nullable(),
  last: z
    .object({
      at: Timestamp,
      ok: z.boolean(),
      latencyMs: N,
      error: z.string().optional(),
      statusCode: z.number().optional(),
      certNotAfter: z.string().optional(),
      answer: z.array(z.string()).optional(),
    })
    .nullable(),
  lastPing: Timestamp.nullable(),
  uptime24h: N,
  latency24h: z.array(N),
  /** Heartbeat checks, owners only. */
  pingUrl: z.string().nullable(),
  createdBy: z.string(),
});
export type HostCheck = z.infer<typeof HostCheck>;

export const HostCheckInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  kind: HostCheckKind.optional(),
  target: z.string().max(500).optional(),
  runner: z.string().max(63).optional(),
  intervalS: z.number().int().min(10).max(86_400).optional(),
  timeoutS: z.number().int().min(1).max(120).optional(),
  graceS: z.number().int().min(0).max(86_400).optional(),
  options: HostCheckOptions.optional(),
  enabled: z.boolean().optional(),
});
export type HostCheckInput = z.infer<typeof HostCheckInput>;

/* Enrollment (Add a server, ONE-15) --------------------------------------------------------------- */

/**
 * What Whombat may do on a server it adds (0.85, CT-373; Whombat server-signin.md SI-06), chosen up front and set on
 * both sides at once: the hub's switches (`HOST_CONTROL_LEVEL_SWITCHES`) and the agent's own lock (`install.sh
 * --control <level>`). Exact: after an install the server has exactly that level, lower ones too. `full` is the
 * default in every UI (`HOST_CONTROL_LEVEL_DEFAULT`).
 */
export const HostControlLevel = z.enum(['watch', 'operate', 'full']);
export type HostControlLevel = z.infer<typeof HostControlLevel>;
export const HOST_CONTROL_LEVELS = HostControlLevel.options;
export const HOST_CONTROL_LEVEL_DEFAULT: HostControlLevel = 'full';

/** The hub's switches of each level (SI-06): `watch` read-only checks, `operate` also consoles and power, `full` all. */
export const HOST_CONTROL_LEVEL_SWITCHES: Readonly<Record<HostControlLevel, Required<HostRemoteToggles>>> = {
  watch: { console: false, power: false, hostShell: false, hostPower: false, manage: false, diagnose: true },
  operate: { console: true, power: true, hostShell: false, hostPower: false, manage: false, diagnose: true },
  full: { console: true, power: true, hostShell: true, hostPower: true, manage: true, diagnose: true },
};

/** Each level's title and the line under the control (SI-06), on the web and the phone. */
export const HOST_CONTROL_LEVEL_WORDS: Readonly<Record<HostControlLevel, { title: string; line: string }>> = {
  watch: { title: 'Watch only', line: 'Whombat sees how it’s doing and runs read-only checks.' },
  operate: {
    title: 'Restart and consoles',
    line: 'Also opens consoles and starts, stops or restarts its VMs and containers.',
  },
  full: {
    title: 'Full control',
    line: 'Also changes and creates VMs and containers, opens a shell on the server and restarts it.',
  },
};

/**
 * `hosts.createEnrollment`'s body (0.85, CT-374), optional: an empty POST stays valid and means `full`. Whombat
 * pre-approves every enrollment it makes (SI-07): the server is added the moment its agent asks, named `name` (else
 * its host name; a taken name gets `-2`, `-3`, …) with the level's switches.
 */
export const HostCreateEnrollmentBody = z
  .object({
    control: HostControlLevel.optional(),
    name: z.string().min(1).max(63).optional(),
  })
  .strict();
export type HostCreateEnrollmentBody = z.infer<typeof HostCreateEnrollmentBody>;

/**
 * A new enrollment: the one-line install command that dials the box's LAN address with its CA pinned (CT-374):
 * `control`, the level the command sets (it ends with `--control <level>`), and `preApproved` (SI-07), as far as the
 * hosts service says them.
 */
export const HostEnrollment = z.object({
  id: Id,
  expiresAt: Timestamp,
  installCommand: z.string().min(1).max(4000),
  control: HostControlLevel.optional(),
  preApproved: z.boolean().optional(),
});
export type HostEnrollment = z.infer<typeof HostEnrollment>;

/**
 * CT-374: `control`, the level an approval applies (by hand too), and `name`, the name it was made for; null when not
 * given.
 */
export const HostPendingEnrollment = z.object({
  id: Id,
  state: z.enum(['pending', 'issued', 'approved', 'rejected', 'expired']),
  hostname: z.string().nullable(),
  os: z.string().nullable(),
  address: z.string().nullable(),
  agentVersion: z.string().nullable(),
  requestedAt: Timestamp.nullable(),
  createdAt: Timestamp.nullable().optional(),
  expiresAt: Timestamp.nullable().optional(),
  serverId: OptS,
  control: HostControlLevel.nullable().optional(),
  name: z.string().nullable().optional(),
});
export type HostPendingEnrollment = z.infer<typeof HostPendingEnrollment>;

/* Sign in once (Add a server, SI-02) -------------------------------------------------------------- */

/**
 * An install job's state (0.85, CT-375; SI-02): `connecting` (Signing in), `installing` (Installing Whombat’s helper),
 * `waiting` (Waiting for its first report), then `ready` or `failed`.
 */
export const HostInstallState = z.enum(['connecting', 'installing', 'waiting', 'ready', 'failed']);
export type HostInstallState = z.infer<typeof HostInstallState>;

/** Why an install failed (SI-11); `hostInstallErrorText` has the words. */
export const HostInstallErrorCode = z.enum([
  /** SI-05 refused the address (the destination rule's own words). */
  'not_allowed',
  /** Nothing answers on that address and port. */
  'unreachable',
  /** SI-04: the server's key differs from the one the owner's Vault trusts; nothing was sent. */
  'host_key_changed',
  /** Wrong user name, password or key. */
  'sign_in_failed',
  /** Signed in with a key, and `sudo` wants a password. */
  'sudo_password_needed',
  /** The user may not use `sudo`. */
  'sudo_refused',
  /** Neither curl nor wget on the server. */
  'no_downloader',
  /** The server can't reach the agents' address of this Whombat. */
  'cant_reach_whombat',
  /** Not Linux or macOS 13 or later, an unknown architecture or init system. */
  'unsupported',
  /** Its agent reports to another Whombat (SI-08). */
  'other_whombat',
  'timed_out',
  /** Anything else (`detail` says what). */
  'failed',
]);
export type HostInstallErrorCode = z.infer<typeof HostInstallErrorCode>;

/** `HostInstall.detail`'s limit: the installer's last lines (4 KiB). */
export const HOST_INSTALL_DETAIL_MAX = 4096;

/**
 * An install job (0.85, CT-375; SI-02): Whombat signs in to a server over SSH once, installs its agent as root and
 * waits for its first report. Kept in the server's memory only, 30 minutes after it ends; `hosts.install` events say
 * when it changes. Never carries the password or the enrollment token (SI-03).
 */
export const HostInstall = z.object({
  id: Id,
  /** As typed: `host[:port]`. */
  address: z.string(),
  username: z.string(),
  control: HostControlLevel,
  state: HostInstallState,
  /** The key the server showed (`SHA256:…`); null before it did. */
  hostKey: z.object({ algorithm: z.string(), fingerprint: z.string() }).nullable(),
  /** True: first contact, the key was trusted as shown (SI-04); false: it matched the key the owner's Vault trusts. */
  hostKeyNew: z.boolean(),
  serverId: z.string().nullable(),
  /** What it is called in Whombat (may be `pve-03-2`, SI-07). */
  serverName: z.string().nullable(),
  /** “Proxmox VE 9.0 · Debian GNU/Linux 13 (trixie) · amd64”. */
  system: z.string().nullable(),
  /** SI-08: it had been added before; its agent was updated in place. */
  already: z.boolean(),
  /** SI-09: a Vault key was left on it. */
  keptKey: z.boolean(),
  error: z.object({ code: HostInstallErrorCode, message: z.string() }).nullable(),
  /**
   * With `host_key_changed` (Whombat connect-in-chat.md): the person's Vault SSH servers that trust the old key, which
   * “Trust the new one” trusts again with the key in `hostKey` (`vault.trustSshHostKey`). Absent otherwise.
   */
  pins: z
    .array(z.object({ entryId: Id, serverId: Id }))
    .max(10)
    .optional(),
  /** On failure only: the installer's last lines, password and token removed. */
  detail: z.string().max(HOST_INSTALL_DETAIL_MAX).nullable(),
  startedAt: Timestamp,
  updatedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type HostInstall = z.infer<typeof HostInstall>;

/**
 * `hosts.startInstall`'s body (0.85, CT-375; SI-02, SI-09). The password is used for this install only (and for
 * `sudo`), then forgotten (SI-03): the op is a `secret` one. `auth.kind: vault` signs in with one of the person's own
 * Vault SSH keys, its `password` only for `sudo`. `keepKey` (SI-09, off by default) leaves that entry's key, or a new
 * one, on the server.
 */
export const HostInstallBody = z
  .object({
    address: z.string().min(1).max(255),
    username: z.string().min(1).max(64),
    auth: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('password'), password: z.string().min(1).max(1024) }),
      z.strictObject({
        kind: z.literal('vault'),
        entryId: Id,
        password: z.string().min(1).max(1024).optional(),
      }),
    ]),
    control: HostControlLevel,
    name: z.string().min(1).max(63).optional(),
    keepKey: z
      .union([z.strictObject({ entryId: Id }), z.strictObject({ create: z.literal(true) })])
      .optional(),
  })
  .strict();
export type HostInstallBody = z.infer<typeof HostInstallBody>;

/** The SSH port an address without one gets. */
export const HOST_INSTALL_SSH_PORT = 22;

/**
 * Reads an address as typed in Sign in once (SI-02): a host name or IP address with an optional `:port` (22 by
 * default); IPv6 in brackets when it has a port (`[2001:db8::7]:2222`), bare without. Null when it isn't one.
 */
export function parseHostInstallAddress(
  text: string,
): { host: string; hostKind: 'name' | 'ipv4' | 'ipv6'; port: number } | null {
  const raw = text.trim();
  let hostText = raw;
  let portText: string | null = null;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return null;
    hostText = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return null;
      portText = rest.slice(1);
    }
  } else if (raw.split(':').length === 2) {
    const at = raw.indexOf(':');
    hostText = raw.slice(0, at);
    portText = raw.slice(at + 1);
  }
  let port = HOST_INSTALL_SSH_PORT;
  if (portText !== null) {
    if (!/^[0-9]{1,5}$/.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65_535) return null;
  }
  const host = parseVaultSshHost(hostText);
  return host ? { ...host, port } : null;
}

/**
 * The words of a failed install (SI-11), as `HostInstall.error.message` carries them: `address` as typed, `name` the
 * server's name when known (`host_key_changed`, `cant_reach_whombat`), `whombat` the agents' address of this Whombat
 * (`10.100.1.160:8443`), `withKey` when the sign-in used a Vault key, `installed` when only the first report is
 * missing (`timed_out` while `waiting`), `mac` when the server is a Mac (Whombat macos-servers.md: its
 * `version` when macOS is too old). `not_allowed` takes the destination rule's own words when there are some; `failed`
 * is the fallback when nothing better is known.
 */
export function hostInstallErrorText(
  code: HostInstallErrorCode,
  ctx: {
    address: string;
    name?: string | null;
    whombat?: string | null;
    withKey?: boolean;
    installed?: boolean;
    mac?: { version: string | null };
  },
): string {
  const server = ctx.name || ctx.address;
  switch (code) {
    case 'not_allowed':
      return `Whombat doesn’t sign in to ${ctx.address}.`;
    case 'unreachable':
      return `Nothing answers at ${ctx.address}. Is the address right, and is the server on?`;
    case 'host_key_changed':
      return `${server} showed a different key than the one your Vault trusts, so Whombat sent nothing. If the server was reinstalled, trust its new key in the Vault first.`;
    case 'sign_in_failed':
      return `Couldn’t sign in to ${ctx.address}: the user name or ${ctx.withKey ? 'key' : 'password'} isn’t right.`;
    case 'sudo_password_needed':
      return `Signed in, but sudo on ${ctx.address} asks for a password. Add it under “Password for sudo”.`;
    case 'sudo_refused':
      return ctx.mac
        ? `Signed in, but this user may not use sudo on ${ctx.address}. Sign in as an administrator of the Mac.`
        : `Signed in, but this user may not use sudo on ${ctx.address}. Use root or a user that may.`;
    case 'no_downloader':
      return `${ctx.address} has neither curl nor wget. Install one of them and try again.`;
    case 'cant_reach_whombat':
      return ctx.whombat
        ? `${server} can’t reach this Whombat at ${ctx.whombat}. Is it on another network?`
        : `${server} can’t reach this Whombat. Is it on another network?`;
    case 'unsupported':
      if (ctx.mac)
        return ctx.mac.version
          ? `Whombat’s helper needs macOS ${HOST_MACOS_MIN_MAJOR} or later, and ${ctx.address} has macOS ${ctx.mac.version}. Update the Mac first.`
          : `Whombat’s helper needs macOS ${HOST_MACOS_MIN_MAJOR} or later, and Whombat couldn’t tell which macOS ${ctx.address} has.`;
      return `Whombat’s helper can’t run on ${ctx.address}: it needs Linux or macOS ${HOST_MACOS_MIN_MAJOR} or later on a 64-bit Intel, AMD or ARM processor. “More detail” says what was missing.`;
    case 'other_whombat':
      return 'This server reports to another Whombat. Remove Whombat’s helper there first.';
    case 'timed_out':
      return ctx.installed
        ? 'It’s installed, but its first report hasn’t come in yet. It shows up once it does.'
        : `${ctx.address} took too long to answer, so Whombat stopped.`;
    case 'failed':
      return `Putting Whombat’s helper on ${ctx.address} didn’t work. “More detail” shows what the installer said.`;
  }
}

/* The Whombat's address and pointing servers here (0.117, CT-910…CT-914; Whombat backup-file.md BF-15, BF-16) ---- */

/** The port agents dial when an agent URL names none, and the one an address as people read it leaves out. */
export const HOSTS_AGENT_PORT_DEFAULT = 8443;

/**
 * An agent URL as people read it (BF-15): `wss://10.100.1.160:8443` → `10.100.1.160`, `wss://whombat.lan:9443/x` →
 * `whombat.lan:9443`, `wss://[fd00::5]:8443` → `fd00::5` (`[fd00::5]:9443` with another port). Null when it isn't a URL.
 */
export function hostsAgentAddress(agentUrl: string): string | null {
  const m =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[0-9A-Fa-f:.]+\]|[^:/?#[\]]+)(?::([0-9]{1,5}))?(?:[/?#]|$)/i.exec(
      agentUrl.trim(),
    );
  if (!m) return null;
  const host = (m[1] as string).toLowerCase();
  const port = m[2] === undefined ? null : Number(m[2]);
  if (port === null || port === HOSTS_AGENT_PORT_DEFAULT) return host.replace(/^\[(.*)\]$/, '$1');
  return `${host}:${port}`;
}

/** A server that hasn't found this Whombat since its address changed: its id, name and its own address (null: unknown). */
export const HostWaitingServer = z.object({
  id: Id,
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(300).nullable(),
});
export type HostWaitingServer = z.infer<typeof HostWaitingServer>;

/**
 * `hosts.addressChange` (owners; BF-16): this Whombat's address changed (`from`, `to`: addresses as people read them,
 * `hostsAgentAddress`) at `changedAt`, and these servers haven't found it five minutes later. The read answers null
 * while there is nothing to say (no change, or every server is back).
 */
export const HostAddressChange = z.object({
  from: z.string().min(1).max(300),
  to: z.string().min(1).max(300),
  changedAt: Timestamp,
  waiting: z.array(HostWaitingServer).max(500),
});
export type HostAddressChange = z.infer<typeof HostAddressChange>;

/**
 * BF-16's sentence (the Needs you item, the Servers page): “Your Whombat’s address changed from 10.100.1.160 to
 * 10.100.1.158, and 5 servers haven’t found it yet.” One server is named.
 */
export function hostsAddressChangeText(c: {
  from: string;
  to: string;
  waiting: readonly { name: string }[];
}): string {
  const n = c.waiting.length;
  const who =
    n === 1
      ? `${c.waiting[0]?.name} hasn’t found it yet`
      : `${n.toLocaleString('en-US')} servers haven’t found it yet`;
  return `Your Whombat’s address changed from ${c.from} to ${c.to}, and ${who}.`;
}

/** The most servers one `hosts.repoint` takes. */
export const HOST_REPOINT_MAX = 100;

/** `hosts.repoint`'s body (owners; BF-15, BF-16): the servers (the hosts service's ids) to point at this Whombat. */
export const HostRepointBody = z.strictObject({
  servers: z
    .array(Id)
    .min(1)
    .max(HOST_REPOINT_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'List each server once.'),
});
export type HostRepointBody = z.infer<typeof HostRepointBody>;

/**
 * One server of a repoint job: `waiting`, `pointing` (signing in with the restorer's Vault SSH key for its address and
 * updating its agent in place), then `pointed`, `no_key` (no Vault SSH key for its address: Add a server, filled in)
 * or `failed` (`error`: the sign-in's reason, `hostInstallErrorText`'s words).
 */
export const HOST_REPOINT_SERVER_STATES = ['waiting', 'pointing', 'pointed', 'no_key', 'failed'] as const;
export const HostRepointServerState = z.enum(HOST_REPOINT_SERVER_STATES);
export type HostRepointServerState = z.infer<typeof HostRepointServerState>;

export const HostRepointState = z.enum(['running', 'done']);
export type HostRepointState = z.infer<typeof HostRepointState>;

export const HostRepointServer = z.object({
  id: Id,
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(300).nullable(),
  state: HostRepointServerState,
  error: z.object({ code: HostInstallErrorCode, message: z.string() }).nullable(),
});
export type HostRepointServer = z.infer<typeof HostRepointServer>;

/**
 * A repoint job (0.117, CT-911; BF-15): Whombat signs in to each server with the owner's Vault SSH key for its address
 * (Sign in once, SI-02) and updates its agent in place to dial this Whombat at `to` (as people read it). Kept in the
 * server's memory like an install job; `hosts.repoint` events say when it changes.
 */
export const HostRepoint = z.object({
  id: Id,
  to: z.string().min(1).max(300),
  state: HostRepointState,
  servers: z.array(HostRepointServer).max(HOST_REPOINT_MAX),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type HostRepoint = z.infer<typeof HostRepoint>;

/** The words of pointing servers here (BF-15, BF-16): the buttons and a server's state. */
export const HOST_REPOINT_WORDS = {
  pointThemHere: 'Point them here',
  pointItHere: 'Point it here',
  leaveThem: 'Leave them',
  states: {
    waiting: 'Waiting',
    pointing: 'Pointing it here…',
    pointed: 'Pointed here',
    no_key: 'Needs a password',
    failed: 'Didn’t work',
  } satisfies Record<HostRepointServerState, string>,
  /** Under a `no_key` server: what Add a server, filled in, does. */
  noKey: 'Your Vault has no key for it. Sign in once with its password to point it here.',
} as const;

/* Actions, consoles, inspect ---------------------------------------------------------------------- */

export const HOST_POWER_ACTIONS = [
  'start',
  'shutdown',
  'reboot',
  'force_stop',
  'restart',
  'stop',
  'pause',
  'resume',
  'ctrl_alt_del',
] as const;
export const HOST_SNAPSHOT_ACTIONS = ['snapshot_create', 'snapshot_restore', 'snapshot_delete'] as const;
export const HostGuestAction = z.enum([...HOST_POWER_ACTIONS, ...HOST_SNAPSHOT_ACTIONS]);
export type HostGuestAction = z.infer<typeof HostGuestAction>;
/** Actions that need `confirm: true` (the hub refuses them otherwise). */
export const HOST_DESTRUCTIVE_ACTIONS: readonly HostGuestAction[] = [
  'force_stop',
  'stop',
  'reboot',
  'shutdown',
  'restart',
  'snapshot_restore',
  'snapshot_delete',
];

export const HostGuestActionBody = z.object({
  action: HostGuestAction,
  confirm: z.boolean().optional(),
  snapshot: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
    .optional(),
  description: z.string().max(200).optional(),
  memory: z.boolean().optional(),
});
export type HostGuestActionBody = z.infer<typeof HostGuestActionBody>;

export const HostServerActionBody = z.object({
  action: z.enum(['host_reboot', 'host_shutdown']),
  confirm: z.literal(true),
});
export type HostServerActionBody = z.infer<typeof HostServerActionBody>;

/** An accepted action; the result arrives as `hosts.task` with the same `actionId`. */
export const HostActionAccepted = z.object({
  actionId: Id,
  auditId: z.string().optional(),
  /** Already in the requested state. */
  noop: z.boolean().optional(),
});
export type HostActionAccepted = z.infer<typeof HostActionAccepted>;

export const HostConsoleCreateBody = z.object({
  /**
   * A guest's console; absent: the host itself (`logs`, or `shell` with the host-shell switch on; on a Mac also `vnc`,
   * its screen through Screen Sharing, which the hub opens by default there when Screen Sharing and the screen
   * account are set).
   */
  guestId: Id.optional(),
  protocol: HostConsoleProtocol.optional(),
  /** One of the caller's sessions to close in its favour. */
  switchFrom: z.string().max(100).optional(),
});
export type HostConsoleCreateBody = z.infer<typeof HostConsoleCreateBody>;

/**
 * A console session (CT-339): open a WebSocket to `path` (absolute on Whombat's origin, under `/api/v1`) offering the
 * subprotocols `HOSTS_CONSOLE_SUBPROTOCOL` and `HOSTS_CONSOLE_TOKEN_PREFIX + token`; the frames are the hosts
 * service's (`kind (1 byte) | channel (uint16 BE) | payload`, docs/REST-API.md “Console and actions”). The token works
 * once, for 30 seconds, for the same person.
 */
export const HostConsoleSession = z.object({
  sessionId: Id,
  path: z.string().regex(/^\/[^\s]{1,500}$/),
  token: z.string().min(1).max(500),
  protocol: HostConsoleProtocol,
  expiresAt: Timestamp,
  idleTimeoutS: z.number().int().positive(),
  requiresConfirmation: z.boolean().optional(),
});
export type HostConsoleSession = z.infer<typeof HostConsoleSession>;

/** The browser ↔ Whombat console subprotocols (Whombat proxies to the hosts service's own). */
export const HOSTS_CONSOLE_SUBPROTOCOL = 'whombat.console.v1';
export const HOSTS_CONSOLE_TOKEN_PREFIX = 'whombat.token.';

export const HostInspectKind = z.enum(['processes', 'ports', 'services', 'updates']);
export type HostInspectKind = z.infer<typeof HostInspectKind>;

export const HostProcess = z.object({
  pid: z.number().int(),
  ppid: z.number().int().optional(),
  user: z.string(),
  name: z.string(),
  command: z.string(),
  cpuPct: z.number(),
  rssBytes: z.number(),
  state: z.string(),
  threads: z.number().optional(),
  container: z.string().optional(),
  started: z.string().optional(),
});
export const HostPort = z.object({
  proto: z.string(),
  address: z.string(),
  port: z.number().int(),
  pid: z.number().int().optional(),
  process: z.string().optional(),
});
export const HostService = z.object({
  name: z.string(),
  description: z.string().optional(),
  load: z.string().optional(),
  active: z.string(),
  sub: z.string().optional(),
  enabled: z.string().optional(),
  since: z.string().optional(),
});
export const HostPackageUpdate = z.object({
  name: z.string(),
  current: z.string().optional(),
  new: z.string(),
  security: z.boolean().optional(),
  source: z.string().optional(),
});

const inspect = <K extends string, T extends z.ZodType>(kind: K, item: T) =>
  z.object({ kind: z.literal(kind), asOf: Timestamp, truncated: z.boolean(), items: z.array(item) });

/** `hosts.inspect`: a view of the host asked from the agent now (not stored). */
export const HostInspectResult = z.discriminatedUnion('kind', [
  inspect('processes', HostProcess),
  inspect('ports', HostPort),
  inspect('services', HostService),
  inspect('updates', HostPackageUpdate),
]);
export type HostInspectResult = z.infer<typeof HostInspectResult>;

/* A Mac's screen (`hosts.screen`, Whombat macos-servers.md) -------------------------------------------- */

/**
 * What `hosts.screen` does on a Mac: `status`; `look` (a screenshot); by position `click`, `drag`, `scroll`, `type`,
 * `keys`; `unlock` (types the Mac's own password the agent keeps); `password` (types it into a macOS password prompt
 * that is in front, never into anything else); the screen account (`account.set`,
 * `account.check`, `account.clear`); and by name through Whombat Helper (`ui.apps`, `ui.list`, `ui.press`, `ui.set`,
 * `ui.menu`, `ui.focus`, `ui.open`, `ui.action` (an element's own named action, “Play”), `ui.quit`), and the Mac's maps
 * (`map.geocode`: places for addresses, `map.snapshot`: a map picture; docs/implementation/macos/findmy.md).
 */
export const HOST_SCREEN_OPS = [
  'status',
  'look',
  'click',
  'drag',
  'scroll',
  'type',
  'keys',
  'unlock',
  'password',
  'account.set',
  'account.check',
  'account.clear',
  'ui.apps',
  'ui.list',
  'ui.press',
  'ui.set',
  'ui.menu',
  'ui.focus',
  'ui.open',
  'ui.action',
  'ui.quit',
  'map.geocode',
  'map.snapshot',
] as const;
export const HostScreenOp = z.enum(HOST_SCREEN_OPS);
export type HostScreenOp = z.infer<typeof HostScreenOp>;

/**
 * The ops that only read the Mac's state: `status`, which the hosts service checks at operator and doesn't audit. Every
 * other op is an owner's at admin: a look and the two UI lists too, since a screenshot and other apps' fields show the
 * person's whole desktop (the hosts service audits those three with the op and the app only).
 */
export const HOST_SCREEN_READ_OPS: readonly HostScreenOp[] = ['status'];

/**
 * How long a screen step may take end to end, in ms: `password` and `unlock` type the Mac's password one checked key at
 * a time (the hosts service gives them 60 s and answers within 65 s), every other step 30 s (35 s with the socket).
 */
export function hostScreenTimeoutMs(op: HostScreenOp): number {
  return op === 'password' || op === 'unlock' ? 70_000 : 35_000;
}

/** Why a screen step didn't work, as the Mac's agent says (`HostScreenResult.code`); `hostScreenProblemText` words it. */
export const HOST_SCREEN_CODES = [
  'invalid_request',
  'unsupported',
  'no_screen',
  'no_account',
  'sign_in_failed',
  'no_helper',
  'no_access',
  /** The screen account isn't an administrator: the Mac can't type its password into an admin prompt by itself. */
  'not_admin',
  'not_found',
  'locked',
  'no_prompt',
  'busy',
  'timeout',
  'failed',
] as const;
export const HostScreenCode = z.enum(HOST_SCREEN_CODES);
export type HostScreenCode = z.infer<typeof HostScreenCode>;

/**
 * What the hosts service takes in a screen step (its own table): text in characters, the account in bytes (Apple's
 * sign-in takes at most 63 of each), positions in the screen's pixels.
 */
export const HOST_SCREEN_LIMITS = {
  /** `ui.set`'s value. */
  text: 10_000,
  /** `type`: typed key by key through Screen Sharing, so shorter. */
  typeText: 2000,
  keys: 500,
  /** `app`, `window` and `name`. */
  name: 200,
  /** One role or a comma list of them. */
  role: 64,
  target: 2048,
  /** `ui.menu`: at most this many items, each at most `name` long. */
  path: 8,
  /** `x`, `y`, `toX`, `toY`: 0 up to this. */
  position: 16_384,
  /** `dx`, `dy`: this many steps either way. */
  scroll: 50,
  /** `look`'s `maxW` (0: full size). */
  width: 8192,
  /** `ui.list`'s most elements (300 when not asked). */
  list: 1000,
  /** The account's user and password, each in UTF-8 bytes. */
  accountBytes: 63,
  /** `map.geocode`: at most this many addresses, each at most `query` characters. */
  queries: 8,
  query: 300,
  /** `map.snapshot`: at most this many pins, a picture of `mapSide` points a side at most (64 at least). */
  pins: 20,
  mapSide: 1600,
} as const;

/** The longest text `ui.set` takes (`type` takes `HOST_SCREEN_LIMITS.typeText`). */
export const HOST_SCREEN_TEXT_MAX = HOST_SCREEN_LIMITS.text;
/** The most elements `ui.list` answers (300 when not asked). */
export const HOST_SCREEN_LIST_MAX = HOST_SCREEN_LIMITS.list;

const L = HOST_SCREEN_LIMITS;
const Px = z.number().int().min(0).max(L.position);
const ScreenName = z.string().min(1).max(L.name);
const Lat = z.number().min(-90).max(90);
const Lon = z.number().min(-180).max(180);
/** A map's span: its shorter side in metres, from a street to half the earth. */
const SpanM = z.number().min(50).max(20_000_000);
const MapSide = z.number().int().min(64).max(L.mapSide);
const AccountPart = z
  .string()
  .min(1)
  .refine((v) => utf8ByteLength(v) <= L.accountBytes, {
    message: `At most ${L.accountBytes} bytes.`,
  });

/**
 * `hosts.screen`'s body: only the fields its op takes, within the hosts service's limits (`HOST_SCREEN_LIMITS`).
 * Positions are the screen's own pixels (`screenW` × `screenH` of a look), `account` only with `account.set` (the
 * Mac's password goes to the Mac and is never kept by Whombat: a secret op).
 */
export const HostScreenBody = z
  .strictObject({
    op: HostScreenOp,
    x: Px.optional(),
    y: Px.optional(),
    toX: Px.optional(),
    toY: Px.optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    clicks: z.number().int().min(1).max(3).optional(),
    dx: z.number().int().min(-L.scroll).max(L.scroll).optional(),
    dy: z.number().int().min(-L.scroll).max(L.scroll).optional(),
    text: z.string().max(L.text).optional(),
    /** `cmd+q`, `return`, `cmd+shift+4`, `tab tab space`. */
    keys: z.string().min(1).max(L.keys).optional(),
    /** `look`: scaled down to at most this width (0: full size). */
    maxW: z.number().int().min(0).max(L.width).optional(),
    format: z.enum(['png', 'jpeg']).optional(),
    /** `ui.*`: an app's name or bundle id; absent: the app in front. */
    app: ScreenName.optional(),
    window: ScreenName.optional(),
    name: ScreenName.optional(),
    /** button, checkbox, switch, text_field, menu_item, link, tab, row, popup, radio or any (a comma list too). */
    role: z.string().min(1).max(L.role).optional(),
    index: z.number().int().min(0).max(1000).optional(),
    /** `ui.menu`: the menu bar path, `["File", "Save…"]`. */
    path: z.array(ScreenName).min(1).max(L.path).optional(),
    limit: z.number().int().min(1).max(L.list).optional(),
    /** `ui.open`: `accessibility`, an app's name or an https address. */
    target: z.string().min(1).max(L.target).optional(),
    account: z.strictObject({ user: AccountPart, password: AccountPart }).optional(),
    /** `ui.action`: the element's own action, by its name (“Play”, “Directions”). */
    action: ScreenName.optional(),
    /** `map.geocode`: the addresses to find, in order. */
    queries: z.array(z.string().min(1).max(L.query)).min(1).max(L.queries).optional(),
    /** `map.snapshot`: the places to pin (their points come back in order). */
    pins: z
      .array(z.strictObject({ lat: Lat, lon: Lon }))
      .max(L.pins)
      .optional(),
    /** `map.snapshot`: the map's centre and span; absent, the map fits the pins. */
    lat: Lat.optional(),
    lon: Lon.optional(),
    spanM: SpanM.optional(),
    /** `map.snapshot`: the picture's size in points, and 1 or 2 pixels a point. */
    w: MapSide.optional(),
    h: MapSide.optional(),
    scale: z.union([z.literal(1), z.literal(2)]).optional(),
    dark: z.boolean().optional(),
    /** `look`: only this part of the screen, in its pixels (cut before `maxW` scales it). */
    crop: z.strictObject({ x: Px, y: Px, w: Px.min(1), h: Px.min(1) }).optional(),
  })
  .superRefine((b, ctx) => {
    const need = (...fields: (keyof typeof b)[]) => {
      for (const f of fields)
        if (b[f] === undefined) ctx.addIssue({ code: 'custom', path: [f], message: `${b.op} needs ${f}.` });
    };
    if (b.op === 'click') need('x', 'y');
    if (b.op === 'drag') need('x', 'y', 'toX', 'toY');
    if (b.op === 'scroll' && b.dx === undefined && b.dy === undefined) need('dy');
    if (b.op === 'type') need('text');
    if (b.op === 'type' && b.text !== undefined && [...b.text].length > L.typeText)
      ctx.addIssue({
        code: 'too_big',
        origin: 'string',
        maximum: L.typeText,
        inclusive: true,
        path: ['text'],
        message: `type takes at most ${L.typeText} characters.`,
      });
    if (b.op === 'keys') need('keys');
    if (b.op === 'ui.press') need('name');
    if (b.op === 'ui.set') need('text');
    if (b.op === 'ui.menu') need('path');
    if (b.op === 'ui.focus') need('app');
    if (b.op === 'ui.open') need('target');
    if (b.op === 'ui.action') need('name', 'action');
    if (b.op === 'ui.quit') need('app');
    if (b.op === 'map.geocode') need('queries');
    if (b.op === 'map.snapshot') {
      need('w', 'h');
      const centred = b.lat !== undefined && b.lon !== undefined && b.spanM !== undefined;
      if (!centred && !b.pins?.length)
        ctx.addIssue({
          code: 'custom',
          path: ['pins'],
          message: 'map.snapshot needs pins, or lat, lon and spanM.',
        });
    }
    // The Mac types its own password: nothing typed comes along with the step.
    if (b.op === 'password' && b.text !== undefined)
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'password types the Mac’s own password.' });
    if (b.op === 'account.set') need('account');
    else if (b.account !== undefined)
      ctx.addIssue({ code: 'custom', path: ['account'], message: 'Only account.set takes an account.' });
  });
export type HostScreenBody = z.infer<typeof HostScreenBody>;

/**
 * An element on a Mac's screen as Whombat Helper reads it: `id` is good for one list only; the position and
 * size are the screen's pixels (an element on another display lies beyond them).
 */
export const HostUiElement = z.object({
  id: z.string().max(200),
  role: z.string().max(100),
  subrole: z.string().max(100).nullable(),
  title: z.string().max(400).nullable(),
  description: z.string().max(400).nullable(),
  value: z.string().max(400).nullable(),
  identifier: z.string().max(400).nullable(),
  enabled: z.boolean(),
  focused: z.boolean(),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
  actions: z.array(z.string().max(100)).max(30),
  app: z.string().max(200).nullable(),
  window: z.string().max(300).nullable(),
});
export type HostUiElement = z.infer<typeof HostUiElement>;

/** An app running on a Mac, with its windows' titles. */
export const HostUiApp = z.object({
  name: z.string().max(200),
  bundleId: z.string().max(200).nullable(),
  pid: z.number().int(),
  active: z.boolean(),
  windows: z.array(z.string().max(300)).max(100),
});
export type HostUiApp = z.infer<typeof HostUiApp>;

/** A place the Mac's geocoder found for an address: about `accuracyM` metres. */
export const HostMapPlace = z.object({
  lat: z.number(),
  lon: z.number(),
  accuracyM: z.number().nonnegative(),
});
export type HostMapPlace = z.infer<typeof HostMapPlace>;

/** Where a pin falls in a map picture, in the points the picture was asked in. */
export const HostMapPoint = z.object({ x: z.number(), y: z.number() });
export type HostMapPoint = z.infer<typeof HostMapPoint>;

/** The largest screenshot `hosts.screen` answers (base64 characters). */
export const HOST_SCREEN_IMAGE_MAX = 12_000_000;

/**
 * `hosts.screen`'s answer: `ok` with what the op gives back (a `look`'s picture as base64 with its size and the screen's,
 * `ui.list`'s elements, `ui.apps`' apps, the element pressed or set, the screen's state after `status`, `unlock` and
 * the account steps), or `ok: false` with the Mac's own reason (`code`, `message`: `not_found` lists up to ten names that
 * came close). `message` comes with a step that worked too, when the Mac has something to add (“The Mac locks again
 * when this screen session ends.”); `screenMessageText` makes it fit to show. `auditId`: the hosts service's audit
 * line of a step.
 */
export const HostScreenResult = z.object({
  server: Id,
  op: HostScreenOp,
  ok: z.boolean(),
  code: HostScreenCode.optional(),
  message: z.string().max(2000).optional(),
  imageB64: z.string().max(HOST_SCREEN_IMAGE_MAX).optional(),
  format: z.enum(['png', 'jpeg']).optional(),
  /** The picture's size. */
  w: z.number().int().nonnegative().optional(),
  h: z.number().int().nonnegative().optional(),
  /** The screen's size in pixels: what positions count in. */
  screenW: z.number().int().nonnegative().optional(),
  screenH: z.number().int().nonnegative().optional(),
  elements: z.array(HostUiElement).max(HOST_SCREEN_LIST_MAX).optional(),
  apps: z.array(HostUiApp).max(200).optional(),
  element: HostUiElement.optional(),
  status: HostMacScreen.optional(),
  helper: HostMacHelper.optional(),
  truncated: z.boolean().optional(),
  /** `map.geocode`: a place for each address, in order; null where the Mac found none. */
  places: z.array(HostMapPlace.nullable()).max(L.queries).optional(),
  /** `map.snapshot`: where each pin is in the picture, in the asked points; null where it falls outside. */
  points: z.array(HostMapPoint.nullable()).max(L.pins).optional(),
  /** `map.snapshot`: the region drawn (its centre and its shorter side in metres). */
  lat: z.number().optional(),
  lon: z.number().optional(),
  spanM: z.number().optional(),
  auditId: z.string().max(200).optional(),
});
export type HostScreenResult = z.infer<typeof HostScreenResult>;

/** `hosts.screenLook`'s query: a screenshot at most `maxW` wide (full size when absent), PNG unless JPEG is asked. */
export const HostScreenLookQuery = z.object({
  maxW: z.coerce.number().int().min(64).max(HOST_SCREEN_LIMITS.width).optional(),
  format: z.enum(['png', 'jpeg']).optional(),
});
export type HostScreenLookQuery = z.infer<typeof HostScreenLookQuery>;

/** The longest note of the Mac's own that Whombat shows (a person's sentence or two). */
export const HOST_SCREEN_MESSAGE_SHOWN_MAX = 300;

/**
 * The Mac's own words about a step (`HostScreenResult.message`), fit to show: one line, without control characters,
 * with curly apostrophes and at most `HOST_SCREEN_MESSAGE_SHOWN_MAX` characters; null when it says nothing.
 */
export function screenMessageText(message: string | null | undefined): string | null {
  if (!message) return null;
  const line = message
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\w)'(\w)/g, '$1’$2');
  if (!line) return null;
  if (line.length <= HOST_SCREEN_MESSAGE_SHOWN_MAX) return line;
  const cut = line.slice(0, HOST_SCREEN_MESSAGE_SHOWN_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > HOST_SCREEN_MESSAGE_SHOWN_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * Why a screen step didn't work, in a sentence a person reads: `server` is the Mac's name. When the Mac said why a step
 * failed (“The password prompt is still there after typing the password: the Mac may have refused it.”), its own
 * words come through; `not_found` adds the Mac's own list of close names when there is one.
 */
export function hostScreenProblemText(code: HostScreenCode, server: string, message?: string | null): string {
  const said = screenMessageText(message);
  switch (code) {
    // The Mac's own words first where it gave some (“something else answered on Screen Sharing's port”, “nobody is
    // signed in”), then what the person can do.
    case 'no_screen':
      // The Mac's own words may already say how to switch it on: then they're enough.
      if (said && /System Settings/.test(said)) return said;
      return `${said ?? `Screen Sharing is off on ${server}.`} Switch it on in System Settings → General → Sharing.`;
    case 'no_account':
      return `Whombat doesn’t have ${server}’s password for the screen yet. Set it on the Mac’s page.`;
    case 'sign_in_failed':
      return `${server} didn’t take the password Whombat has for its screen. Set it again on the Mac’s page.`;
    case 'no_helper':
      return said ?? `Whombat Helper isn’t running on ${server}.`;
    case 'no_access':
      return (
        said ??
        `Whombat Helper on ${server} needs Accessibility. Switch it on in Privacy & Security → Accessibility.`
      );
    case 'not_admin':
      return `Whombat signs in to ${server}’s screen as a user who isn’t an administrator, so it can’t answer this password prompt. Open the screen and switch on Whombat Helper in Privacy & Security → Accessibility yourself.`;
    case 'not_found':
      return said
        ? `Nothing on ${server}’s screen has that name. ${said}`
        : `Nothing on ${server}’s screen has that name.`;
    case 'locked':
      return said ?? `${server}’s screen is locked.`;
    case 'no_prompt':
      return said ?? `Nothing on ${server}’s screen is asking for its password right now.`;
    case 'busy':
      return said ?? `${server} is busy with another screen step. Try again in a moment.`;
    case 'timeout':
      return said ?? `${server}’s screen didn’t answer in time.`;
    case 'unsupported':
      return said ?? `${server} can’t do that: it isn’t a Mac, or its Whombat helper needs an update.`;
    case 'invalid_request':
      return said ?? `${server} couldn’t do that on its screen.`;
    case 'failed':
      return said ?? `That didn’t work on ${server}’s screen.`;
  }
}

export const HostSnapshot = z.object({
  name: z.string(),
  created: z.string().optional(),
  description: z.string().optional(),
  parent: z.string().optional(),
  memory: z.boolean().optional(),
  current: z.boolean().optional(),
  sizeBytes: z.number().optional(),
});
export type HostSnapshot = z.infer<typeof HostSnapshot>;

/* Manage (Proxmox VE, Incus and unRAID, docs/MANAGE.md) ------------------------------------------- */

/**
 * Whose manage routes: `pve`, `incus`, since 0.83 (CT-365) `unraid` (the host's array, parity, plugins, …), since
 * 0.84 (CT-370) `libvirt` (QEMU/KVM VMs, pools, ISO images, networks — on every host that runs libvirt) and since 0.98
 * (CT-500) `host`: the server's own operating system, only for `packages.check`, `packages.install` and their tasks
 * (`hosts.getTask`, `task.stop`).
 */
export const HostManagePlatform = z.enum(['pve', 'incus', 'unraid', 'libvirt', 'host']);

/**
 * A guest's configuration as the platform stores it (raw values; secrets read `**********`).
 *
 * libvirt (0.84, CT-370; `platform: libvirt`, `digest` the SHA-256 of the inactive domain XML) uses Proxmox-like keys so
 * the same editors work: `name`, `title`, `description`, `vcpus`, `vcpus_max`, `memory_mb`, `memory_max_mb`,
 * `autostart` (`1`/`0`), `boot` (`hd,cdrom,network`, in order), `cpu_mode` (`host-passthrough`, `host-model`,
 * `maximum` or `custom:<model>`), `on_poweroff` / `on_reboot` / `on_crash` (`destroy`, `restart`, `preserve`,
 * `rename-restart`); devices `disk<N>` (`source=<path or pool/volume>,bus=virtio|sata|scsi|ide,format=qcow2|raw,
 * target=vda,size=<bytes>`), `cdrom<N>` (`source=<iso path or pool/volume>|empty,bus=sata|ide`), `net<N>`
 * (`model=virtio|e1000e|rtl8139,network=<name>|bridge=<name>,mac=<mac>,link=up|down`). A new disk is `disk<N>` set to
 * `new=<size>,storage=<pool or folder:domains>,format=qcow2`. In `restricted` (shown locked): `machine`, `firmware`
 * (`bios`/`uefi`), `secure_boot`, `tpm`, `hostdev<N>`, `graphics<N>`, `video`. A running VM takes CD/DVD media, link
 * state, memory and vCPUs up to their maximum, autostart, title and notes at once; the rest is `pending` until it starts.
 */
export const HostGuestConfig = z.object({
  platform: HostManagePlatform,
  kind: HostGuestKind,
  /** Send back with changes: a change made meanwhile fails with `digest_mismatch` (“Changed meanwhile — review again.”). */
  digest: z.string(),
  lock: z.string().optional(),
  running: z.boolean(),
  values: z.record(z.string(), z.string()),
  pending: z.record(z.string(), z.string()).optional(),
  pendingDelete: z.array(z.string()).optional(),
  restricted: z.array(z.string()).optional(),
  inherited: z.array(z.string()).optional(),
  profiles: z.array(z.string()).optional(),
  disks: z
    .array(
      z.object({
        key: z.string(),
        storage: z.string().optional(),
        volume: z.string().optional(),
        sizeBytes: z.number().optional(),
        media: z.enum(['disk', 'cdrom']).optional(),
        path: z.string().optional(),
        unused: z.boolean().optional(),
        boot: z.boolean().optional(),
      }),
    )
    .optional(),
  ha: z
    .object({
      state: z.enum(['started', 'stopped', 'ignored', 'disabled']),
      maxRestart: z.number().optional(),
      maxRelocate: z.number().optional(),
      comment: z.string().optional(),
      status: z.string().optional(),
    })
    .nullable()
    .optional(),
  replication: z
    .array(
      z.object({
        id: z.string(),
        target: z.string(),
        schedule: z.string().optional(),
        rate: z.string().optional(),
        comment: z.string().optional(),
        disabled: z.boolean().optional(),
        lastSync: z.string().nullable().optional(),
        error: z.string().optional(),
      }),
    )
    .optional(),
});
export type HostGuestConfig = z.infer<typeof HostGuestConfig>;

/** An OS type a new libvirt VM starts from (0.84, CT-370): `win11` needs UEFI and a TPM. */
export const HostOsVariant = z.object({
  id: z.string().min(1).max(64),
  label: z.string(),
  firmware: z.enum(['bios', 'uefi']),
  tpm: z.boolean(),
});
export type HostOsVariant = z.infer<typeof HostOsVariant>;

/** What the create, clone, backup and download forms offer on a host. */
export const HostChoices = z.object({
  platform: HostManagePlatform,
  node: z.string().optional(),
  cluster: z.boolean().optional(),
  nextId: z.number().int().optional(),
  storages: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      content: z.array(z.string()),
      availBytes: z.number().optional(),
      totalBytes: z.number().optional(),
      shared: z.boolean().optional(),
      thin: z.boolean().optional(),
    }),
  ),
  bridges: z.array(z.string()),
  isos: z.array(JsonObject).optional(),
  ctTemplates: z.array(JsonObject).optional(),
  templates: z
    .array(z.object({ id: z.string(), name: z.string(), kind: HostGuestKind, node: z.string().optional() }))
    .optional(),
  cpuTypes: z.array(z.string()).optional(),
  /** Other cluster nodes (replication and migration targets). */
  nodes: z.array(z.string()).optional(),
  download: z.boolean().optional(),
  profiles: z.array(z.string()).optional(),
  images: z.array(JsonObject).optional(),
  /** Incus: the projects (0.83, CT-364); `choices` with `project` answers that project's pools, networks, profiles. */
  projects: z.array(z.string()).optional(),
  /**
   * Incus: the common images of the `images:` server to create from (0.83, CT-364: debian/13, ubuntu/24.04,
   * alpine/3.22, …, container and VM, and their `/cloud` variants that take cloud-init). Another alias is accepted too.
   */
  remoteImages: z
    .array(z.object({ alias: z.string(), description: z.string(), type: HostIncusType }))
    .optional(),
  /**
   * libvirt (0.84, CT-370): its networks (`bridges` are the host's bridges; `storages` its active pools, or
   * `folder:domains` on unRAID; `isos` `{volid, name, sizeBytes}` of every pool and the ISO folder).
   */
  networks: z.array(z.string()).optional(),
  /** libvirt: the OS types a new VM starts from (`os_variant`), with the firmware and TPM each needs (Windows 11). */
  osVariants: z.array(HostOsVariant).optional(),
  /** libvirt: what the host's QEMU can give a new VM. */
  firmware: HostLibvirtFirmware.optional(),
});
export type HostChoices = z.infer<typeof HostChoices>;

export const HostFirewall = z.object({
  options: z.record(z.string(), z.string()),
  optionsDigest: z.string().optional(),
  rules: z.array(
    z.object({
      pos: z.number().int(),
      type: z.enum(['in', 'out', 'group']),
      action: z.string(),
      enable: z.boolean(),
      macro: z.string().optional(),
      proto: z.string().optional(),
      source: z.string().optional(),
      dest: z.string().optional(),
      sport: z.string().optional(),
      dport: z.string().optional(),
      iface: z.string().optional(),
      log: z.string().optional(),
      comment: z.string().optional(),
    }),
  ),
  rulesDigest: z.string().optional(),
  groups: z.array(z.string()).optional(),
  clusterEnabled: z.boolean(),
});
export type HostFirewall = z.infer<typeof HostFirewall>;

/**
 * A backup: a Proxmox backup volume, or (0.83, CT-364) an Incus instance's backup — `volume` its name, `storage`
 * `incus`, `guest` the instance, `format` `optimized` or `tar`, `notes` `expires <iso>` or empty, and `expiresAt` — or
 * (0.84, CT-370) a libvirt VM's backup in the backups folder: `volume` its folder's name (`<yyyymmdd-hhmmss>`), `storage`
 * `libvirt`, `guest` the VM, `sizeBytes`, `created`.
 */
export const HostBackupVolume = z.object({
  volume: z.string(),
  storage: z.string(),
  guest: z.string().optional(),
  kind: HostGuestKind.optional(),
  sizeBytes: z.number().optional(),
  created: z.string().optional(),
  format: z.string().optional(),
  notes: z.string().optional(),
  protected: z.boolean().optional(),
  encrypted: z.boolean().optional(),
  verified: z.enum(['ok', 'failed', '']).optional(),
  /** When Incus deletes it by itself (0.83, CT-364); null: never. */
  expiresAt: Timestamp.nullable().optional(),
});
export type HostBackupVolume = z.infer<typeof HostBackupVolume>;

/* Backup jobs (0.81, CT-353; Whombat proxmox.md PX-03) ------------------------------------------- */

export const HostBackupJobSelection = z.enum(['all', 'guests', 'pool']);
export type HostBackupJobSelection = z.infer<typeof HostBackupJobSelection>;
export const HostBackupMode = z.enum(['snapshot', 'suspend', 'stop']);
export type HostBackupMode = z.infer<typeof HostBackupMode>;
/** How a job compresses its backups (`0`: not at all). */
export const HostBackupCompress = z.enum(['zstd', 'lzo', 'gzip', '0']);
export type HostBackupCompress = z.infer<typeof HostBackupCompress>;

const Keep = z.number().int().nonnegative();
/** How many backups a job keeps (Proxmox's prune-backups): the newest `last`, then one per hour, day, … */
export const HostBackupKeep = z.object({
  last: Keep.optional(),
  hourly: Keep.optional(),
  daily: Keep.optional(),
  weekly: Keep.optional(),
  monthly: Keep.optional(),
  yearly: Keep.optional(),
});
export type HostBackupKeep = z.infer<typeof HostBackupKeep>;

/**
 * A scheduled backup job of a Proxmox server or cluster (`backupjob.list`; the hub's `BackupJob`, docs/MANAGE.md).
 * `selection` says which guests: `all` (but `exclude`), the `guests` listed (hub guest ids, `pve:101`) or a `pool`.
 * `node` null: every node. `keep` null: the storage's own retention. `digest`: send it back with `backupjob.update`
 * (a change made meanwhile fails with `digest_mismatch`). `compress` is read as text, so a value Proxmox adds later
 * still parses.
 */
export const HostBackupJob = z.object({
  id: Id,
  enabled: z.boolean(),
  /** Proxmox's calendar event: `04:00`, `sat 02:00`, `daily`. */
  schedule: z.string(),
  storage: z.string(),
  node: OptS,
  selection: HostBackupJobSelection,
  guests: z.array(Id).optional(),
  exclude: z.array(Id).optional(),
  pool: OptS,
  mode: HostBackupMode,
  compress: OptS,
  keep: HostBackupKeep.nullable().optional(),
  notesTemplate: OptS,
  comment: OptS,
  nextRun: Timestamp.nullable().optional(),
  digest: z.string().optional(),
});
export type HostBackupJob = z.infer<typeof HostBackupJob>;

/**
 * `params` of `backupjob.create` and `backupjob.update` (0.81, CT-353): the job's fields, `jobId` naming the job for
 * every op but `backupjob.create` (`backupjob.delete` and `backupjob.run` take only `jobId`). An update sends what
 * changes; `null` clears `node`, `pool`, `compress`, `keep`, `notesTemplate` or `comment`. Strict: a field it doesn't
 * know is refused, naming it (PX-08).
 */
export const HostBackupJobParams = z
  .object({
    jobId: Id.optional(),
    enabled: z.boolean().optional(),
    schedule: z.string().min(1).max(200).optional(),
    storage: z.string().min(1).max(100).optional(),
    node: z.string().min(1).max(100).nullable().optional(),
    selection: HostBackupJobSelection.optional(),
    guests: z.array(Id).max(1000).optional(),
    exclude: z.array(Id).max(1000).optional(),
    pool: z.string().min(1).max(100).nullable().optional(),
    mode: HostBackupMode.optional(),
    compress: HostBackupCompress.nullable().optional(),
    keep: HostBackupKeep.nullable().optional(),
    notesTemplate: z.string().max(1000).nullable().optional(),
    comment: z.string().max(500).nullable().optional(),
  })
  .strict();
export type HostBackupJobParams = z.infer<typeof HostBackupJobParams>;

/* Incus reads (0.83, CT-364) ----------------------------------------------------------------------- */

/**
 * An Incus profile whole (`profile.get`): its configuration and devices as Incus stores them, the instances using it
 * (hub guest ids), the keys Whombat doesn't change (`restricted`: “Change this with the incus command”), and its
 * `digest` to send back with `profile.update`.
 */
export const HostIncusProfile = z.object({
  name: z.string(),
  project: z.string(),
  description: z.string(),
  config: z.record(z.string(), z.string()),
  devices: z.record(z.string(), z.record(z.string(), z.string())),
  usedBy: z.array(z.string()),
  restricted: z.array(z.string()),
  digest: z.string(),
});
export type HostIncusProfile = z.infer<typeof HostIncusProfile>;

/** An address an Incus network handed out (`network.leases`); `guestId` when it is one of the host's guests. */
export const HostNetworkLease = z.object({
  hostname: z.string(),
  address: z.string(),
  hwaddr: z.string(),
  /** `dynamic`, `static`, `gateway`, `uplink`, … */
  type: z.string(),
  guestId: z.string().nullable(),
});
export type HostNetworkLease = z.infer<typeof HostNetworkLease>;

/** An instance's own log (`log.get`): its last lines, 500 by default, at most `HOST_LOG_LINES_MAX`. */
export const HOST_LOG_LINES_DEFAULT = 500;
export const HOST_LOG_LINES_MAX = 2000;

/** An Incus instance's name: what `guest.create`, `guest.clone`, `guest.rename` and a restore as new take. */
export const INCUS_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;

/** What `hosts.manageRead` reads (GET routes of docs/MANAGE.md). */
export const HOST_MANAGE_READ_OPS = [
  'config.get',
  'choices',
  'backup.list',
  'content.list',
  'appliance.list',
  'task.list',
  'firewall.get',
  'snapshot.list',
  /** A server's backup jobs (0.81, CT-353). */
  'backupjob.list',
  /** Incus (0.83, CT-364): one profile whole, a network's address leases, an instance's own log. */
  'profile.get',
  'network.leases',
  'log.get',
] as const;
export const HostManageReadOp = z.enum(HOST_MANAGE_READ_OPS);
export type HostManageReadOp = z.infer<typeof HostManageReadOp>;

/** `hosts.manageRead`'s answer, by op. */
export const HostManageReadResult = z.discriminatedUnion('op', [
  z.object({ op: z.literal('config.get'), config: HostGuestConfig }),
  z.object({ op: z.literal('choices'), choices: HostChoices }),
  z.object({ op: z.literal('backup.list'), items: z.array(HostBackupVolume) }),
  z.object({ op: z.literal('content.list'), items: z.array(JsonObject) }),
  z.object({ op: z.literal('appliance.list'), items: z.array(JsonObject) }),
  z.object({ op: z.literal('task.list'), items: z.array(HostTask) }),
  z.object({ op: z.literal('firewall.get'), firewall: HostFirewall }),
  z.object({ op: z.literal('snapshot.list'), items: z.array(HostSnapshot) }),
  z.object({ op: z.literal('backupjob.list'), items: z.array(HostBackupJob) }),
  z.object({ op: z.literal('profile.get'), profile: HostIncusProfile }),
  z.object({ op: z.literal('network.leases'), items: z.array(HostNetworkLease) }),
  /** `file`: `lxc.log` or `qemu.log`. */
  z.object({
    op: z.literal('log.get'),
    file: z.string(),
    lines: z.array(z.string()).max(HOST_LOG_LINES_MAX),
  }),
]);
export type HostManageReadResult = z.infer<typeof HostManageReadResult>;

/** The changes `hosts.manage` makes (docs/MANAGE.md, plus `guest.migrate` within a Proxmox cluster). */
export const HOST_MANAGE_OPS = [
  'config.set',
  'disk.resize',
  'disk.move',
  'guest.create',
  'guest.clone',
  'guest.template',
  'guest.delete',
  'guest.migrate',
  'backup.create',
  'backup.restore',
  'backup.update',
  'backup.delete',
  /** Backup jobs (0.81, CT-353): `run` starts one now, as a task. */
  'backupjob.create',
  'backupjob.update',
  'backupjob.delete',
  'backupjob.run',
  'content.download',
  'content.delete',
  'appliance.download',
  'task.stop',
  'firewall.options',
  'firewall.rule_add',
  'firewall.rule_update',
  'firewall.rule_delete',
  'ha.set',
  'ha.remove',
  'replication.add',
  'replication.delete',
  /** Incus (0.83, CT-364): rename, move to another pool or project, make an image of an instance. */
  'guest.rename',
  'guest.move',
  'guest.publish',
  /** Incus images, profiles and custom volumes (0.83, CT-364). */
  'image.download',
  'image.refresh',
  'image.delete',
  'profile.create',
  'profile.update',
  'profile.delete',
  'volume.create',
  'volume.resize',
  'volume.delete',
  /** unRAID (0.83, CT-365): the array, parity, disks' spin, the mover, plugins, its notifications. */
  'array.start',
  'array.stop',
  'parity.start',
  'parity.pause',
  'parity.resume',
  'parity.cancel',
  'disk.spin_up',
  'disk.spin_down',
  'mover.start',
  'plugin.check',
  'plugin.update',
  'notification.archive',
  /** Docker on unRAID: update a container from its template, check every container for updates (0.83, CT-365). */
  'container.update',
  'containers.check',
  /** Start with the host or not: Docker on unRAID, libvirt (0.83, CT-365). */
  'guest.autostart',
  /** The server's operating-system updates (0.98, CT-500): check for them, install them; `platform: host`. */
  'packages.check',
  'packages.install',
] as const;
export const HostManageOp = z.enum(HOST_MANAGE_OPS);
export type HostManageOp = z.infer<typeof HostManageOp>;

/** The manage ops that run on the server itself (`platform: host`, never a guest; 0.98, CT-500). */
export const HOST_PACKAGE_MANAGE_OPS = [
  'packages.check',
  'packages.install',
] as const satisfies readonly HostManageOp[];

/** Whether a manage op is one of the server's package ops (`HOST_PACKAGE_MANAGE_OPS`). */
export function isHostPackageManageOp(op: HostManageOp): op is (typeof HOST_PACKAGE_MANAGE_OPS)[number] {
  return (HOST_PACKAGE_MANAGE_OPS as readonly HostManageOp[]).includes(op);
}

/** Changes that destroy or move something: Whombat's tools always ask before them. */
export const HOST_MANAGE_DESTRUCTIVE_OPS: readonly HostManageOp[] = [
  'guest.delete',
  'guest.migrate',
  'guest.template',
  'backup.restore',
  'backup.delete',
  'backupjob.delete',
  'content.delete',
  'disk.move',
  /** 0.83 (CT-364, CT-365). */
  'guest.move',
  'profile.delete',
  'volume.delete',
  'image.delete',
  'array.stop',
  'plugin.update',
  'container.update',
  'parity.cancel',
  /** 0.98 (CT-500): installing a server's updates asks like updating a plugin or a container. */
  'packages.install',
];

/**
 * What may still be done to the guest this Whombat runs in (0.83, CT-363; IU-02): reads, consoles, these actions and
 * these manage ops. Everything else that changes it is refused with `self_guest` (“That’s this Whombat itself.”):
 * stopping, restarting, pausing, restoring a snapshot, settings, disks, renaming, moving, deleting, publishing,
 * autostart, firewall and HA. `asNewOnly`: allowed only when it makes a new guest (an Incus restore always does; a
 * Proxmox one with `newId`). Restarting or shutting down the host it runs on still works, but asks with
 * `HOST_SELF_SERVER_POWER_TEXT`.
 */
export const HOST_SELF_GUEST_ALLOWED = {
  actions: ['start', 'resume', 'snapshot_create', 'snapshot_delete'] as readonly HostGuestAction[],
  ops: [
    'backup.create',
    'backup.update',
    'backup.delete',
    'guest.clone',
    'replication.add',
    'replication.delete',
    'task.stop',
  ] as readonly HostManageOp[],
  asNewOnly: ['backup.restore'] as readonly HostManageOp[],
} as const;

/** Whether a change to the guest this Whombat runs in stays allowed (`HOST_SELF_GUEST_ALLOWED`). */
export function selfGuestAllows(
  change: { action: HostGuestAction } | { op: HostManageOp; asNew?: boolean },
): boolean {
  if ('action' in change) return HOST_SELF_GUEST_ALLOWED.actions.includes(change.action);
  if (HOST_SELF_GUEST_ALLOWED.ops.includes(change.op)) return true;
  return change.asNew === true && HOST_SELF_GUEST_ALLOWED.asNewOnly.includes(change.op);
}

/** The words for the hosts service's codes that came with Incus and unRAID (0.83, CT-367); platform-neutral. */
export const HOST_ERROR_WORDS = {
  /** 409: a change to the guest this Whombat runs in (IU-02). */
  self_guest: 'That’s this Whombat itself.',
  /** 409: a profile, volume or image something still uses. */
  in_use: 'It’s still in use, so it can’t be removed.',
  /** 403: something Whombat doesn’t change (a restricted key, unRAID’s own OS plugin). */
  not_allowed: 'Whombat doesn’t change that; use the platform’s own screens for it.',
} as const;

/** The badge of the guest this Whombat runs in (IU-02). */
export const HOST_SELF_GUEST_LABEL = 'This Whombat';
/** Said in the question before restarting or shutting down the server this Whombat runs on (IU-02). */
export const HOST_SELF_SERVER_POWER_TEXT = 'This Whombat goes down too.';

/**
 * `hosts.manage`: one change. `params` are the route's body fields in camelCase (`set`, `delete`, `revert`, `size`,
 * `storage`, `newId`, `name`, `target`, …; docs/MANAGE.md; `guest.migrate` takes `target` and `storage`, the service
 * decides whether it moves online); a backup job's (0.81, CT-353) are `HostBackupJobParams`: `jobId` (every op but
 * `backupjob.create`), `enabled`, `schedule`, `storage`, `node`, `selection`, `guests`, `exclude`, `pool`, `mode`,
 * `compress`, `keep`, `notesTemplate`, `comment`. `digest` from the read it was reviewed on (for `backupjob.update` the
 * job's own); `confirm` for changes that destroy data (`backupjob.delete` too); `confirmName` the guest's name for a
 * delete. `backupjob.create` answers the new job's id as `newId`, `backupjob.run` a `task`.
 *
 * Incus (0.83, CT-364; `platform: incus` on host routes): `guest.create` adds `project`, `pool`, `network`, `profiles`,
 * `cloudInit` (user data, ≤ 64 KiB) and takes the image alias as `template`; `guest.clone` takes `name`, `storage`
 * (the pool), `project`, `instanceOnly`; `guest.rename` `name` (`INCUS_NAME_PATTERN`, stopped only); `guest.move`
 * `pool?`, `project?` and `confirm`; `guest.publish` `alias?`, `description?`, `snapshot?` (else stopped only), its
 * `newId` the image's fingerprint; `backup.create` `name?` (default `whombat-<yyyymmdd-hhmm>`), `expiresAt?` (default
 * 7 days), `instanceOnly?`, `optimized?`, `compression?` (`zstd`, `gzip`, `none`); `backup.restore` `guest` (whose
 * backup), `volume` (its name), `name` (the new instance, default `<name>-restored`), `storage?`, `start?` — always a
 * new instance; `backup.delete` `guest`, `volume`; `task.stop` an operation that is `cancellable`;
 * `image.download` `alias`, `type`, `project?`, `autoUpdate?` (default true); `image.refresh` and `image.delete`
 * `fingerprint`, `project?`; `profile.create` `name`, `description?`, `copyFrom?`, `project?`; `profile.update`
 * `profile`, `project?`, `set`, `delete`, `devices` (`{name: {…} | null}`), `description?` with the profile's `digest`;
 * `profile.delete` `profile`, `project?`, `confirm` (`in_use` while used, `default` never); `volume.create` `pool`,
 * `name`, `size` (`10GiB`), `contentType?` (`filesystem`, `block`), `project?`, `description?`; `volume.resize`
 * `pool`, `volume`, `size` (grow only), `project?`; `volume.delete` `pool`, `volume`, `project?`, `confirm` (`in_use`
 * while attached). Attaching a volume, adding a network card and the snapshot schedule stay `config.set` (`devices`,
 * `snapshots.schedule`). Long ones answer a `task` (`incus:<uuid>`).
 *
 * unRAID (0.83, CT-365; `platform: unraid`): `array.start`; `array.stop` `confirm`; `parity.start` `correct` (default
 * false); `parity.pause`, `parity.resume`, `parity.cancel` (`confirm`); `disk.spin_up` and `disk.spin_down` `disk` (a
 * disk's name from the detail, or `all`); `mover.start`; `plugin.check`; `plugin.update` `plugin` (a plugin's `file`,
 * or `all`; never unRAID's own: `not_allowed`) and `confirm`; `notification.archive` `id?` (left out: all);
 * `containers.check`. Guest ops on a Docker guest of unRAID with a template: `container.update` `confirm`; on Docker of
 * unRAID or libvirt: `guest.autostart` `on`. Each command answers a `task` (`unraid:<16 hex>`) but
 * `notification.archive` and `guest.autostart`, which are done at once.
 *
 * libvirt (0.84, CT-370; `platform: libvirt`, on every host that runs it): `config.get` / `config.set` with the keys of
 * `HostGuestConfig` (CD/DVD media through `cdrom<N>`, a new disk through `disk<N>` `new=`); `disk.resize` `disk`,
 * `size` (grows, live while running); `guest.create` `kind: vm`, `name` (`LIBVIRT_NAME_PATTERN`), `osVariant`, `set`,
 * `iso`, `storage` (a pool or `folder:domains`), `diskGb`, `network` or `bridge`, `start`; `guest.clone` (stopped)
 * `name`, `storage?`; `guest.rename` (stopped) `name`; `guest.delete` (stopped) `purge` (its disks and NVRAM too);
 * `backup.create` `compress?`; `backup.restore` (always a new VM, new UUID and MACs) `guest`, `volume`, `name`,
 * `storage?`, `start?`; `backup.delete` `guest`, `volume`; `volume.create` / `volume.resize` / `volume.delete` on a
 * pool (`in_use` while a VM uses it); `content.download` `url`, `filename`, `storage` (a pool or `folder:isos`);
 * `content.delete` an ISO no VM uses; `task.stop` aborts a backup or a copy; `guest.autostart` as above. Long ones
 * answer a `task` (`libvirt:<16 hex>`).
 *
 * The server's own updates (0.98, CT-500; Whombat server-updates.md SWU-01…SWU-06; `platform: host` or left out, never
 * a `guestId`): `packages.check`; `packages.install` `packages?` (only these names, `HostPackageNames`; left out:
 * everything waiting). Both answer a `task` (`pkg:<16 hex>`) at once; `task.stop` with `platform: host` stops a Check,
 * never an Install. The hosts service refuses with `unsupported` (no package manager it installs with, NixOS, unRAID,
 * an agent too old), `not_allowed` (TrueNAS, named packages on pacman), `busy` (a package task already running) and
 * `manage_disabled`.
 */
export const HostManageRequest = z
  .object({
    op: HostManageOp,
    guestId: Id.optional(),
    /** Host routes: `pve`, `incus`, `unraid`, `libvirt`, or `host` for the package ops (default: the host's). */
    platform: HostManagePlatform.optional(),
    params: JsonObject.default({}),
    digest: z.string().max(128).optional(),
    confirm: z.boolean().optional(),
    confirmName: z.string().max(100).optional(),
  })
  .superRefine((req, ctx) => {
    const packageOp = isHostPackageManageOp(req.op);
    if (!packageOp) {
      // `task.stop` stops a Check (`pkg:…`) with `platform: host`.
      if (req.platform === 'host' && req.op !== 'task.stop')
        ctx.addIssue({
          code: 'custom',
          path: ['platform'],
          message: 'Only the package ops run on the host itself.',
        });
      return;
    }
    if (req.platform !== undefined && req.platform !== 'host')
      ctx.addIssue({
        code: 'custom',
        path: ['platform'],
        message: 'The package ops run on the host itself.',
      });
    if (req.guestId !== undefined)
      ctx.addIssue({ code: 'custom', path: ['guestId'], message: 'The package ops take no guest.' });
    const packages = req.params.packages;
    if (packages === undefined) return;
    if (req.op !== 'packages.install')
      ctx.addIssue({ code: 'custom', path: ['params', 'packages'], message: 'Only Install takes packages.' });
    else if (!HostPackageNames.safeParse(packages).success)
      ctx.addIssue({
        code: 'custom',
        path: ['params', 'packages'],
        message: `Packages are 1 to ${HOST_PACKAGES_MAX} names.`,
      });
  });
export type HostManageRequest = z.infer<typeof HostManageRequest>;

export const HostConfigChange = z.object({
  key: z.string(),
  old: z.string().optional(),
  new: z.string().optional(),
  /** Applies at the next restart. */
  pending: z.boolean().optional(),
});
export type HostConfigChange = z.infer<typeof HostConfigChange>;

/** A change's answer: done (`changes`) or still running on the host (`task`; `hosts.task` follows it). */
export const HostManageResult = z.object({
  ok: z.boolean(),
  task: z.object({ id: z.string() }).optional(),
  newId: z.string().optional(),
  changes: z.array(HostConfigChange).optional(),
  auditId: z.string().optional(),
});
export type HostManageResult = z.infer<typeof HostManageResult>;

/* The service ------------------------------------------------------------------------------------- */

/**
 * `hosts.status`: whether this Whombat runs the hosts service and it answers. `present` false: no service here
 * (a development stack without it, a production image) and every other `hosts.*` route answers `unavailable`.
 */
export const HostsStatus = z.object({
  present: z.boolean(),
  healthy: z.boolean(),
  version: z.string().optional(),
  /** Why not healthy, in plain words. */
  reason: z.string().max(200).optional(),
  /** Where agents dial in (`wss://10.100.1.5:8443`), for Add a server. */
  agentUrl: z.string().max(300).optional(),
  servers: z.number().int().nonnegative().optional(),
});
export type HostsStatus = z.infer<typeof HostsStatus>;

/** A server's page words (mock 2). */
export const HOST_STATUS_LABELS: Record<HostServerStatus, string> = {
  ok: 'Running fine',
  warn: 'Needs a look',
  bad: 'Problem',
  offline: 'Offline',
  pending: 'Waiting for its first report',
};
