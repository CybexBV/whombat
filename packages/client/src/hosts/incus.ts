/**
 * Incus servers and the guest Whombat runs in, as the screens show them (Whombat incus-unraid.md IU-02…IU-04, IU-08;
 * app docs/decisions/incus-unraid-wi.md AP-1557…AP-1586): the Incus part of a server's page (projects, pools, custom
 * volumes, images, profiles, networks), an instance's tabs, its configuration in groups (the hub's allowlist,
 * hosts/docs/MANAGE.md §2.5), its devices, snapshot schedules, backups, the create form, names and sizes, the
 * words of every Incus change, and the self guest (“This Whombat”: what stays allowed, what the host's power question
 * adds). Pure, shared by the web and Android.
 */
import {
  HOST_ERROR_WORDS,
  HOST_SELF_GUEST_LABEL,
  HOST_SELF_SERVER_POWER_TEXT,
  type HostBackupVolume,
  type HostChoices,
  type HostGuest,
  type HostGuestAction,
  type HostGuestConfig,
  type HostHint,
  type HostIncusDetail,
  type HostIncusImage,
  type HostIncusNetwork,
  type HostIncusPool,
  type HostManageOp,
  type HostRemoteControl,
  type HostServer,
  type HostServerDetail,
  type HostServerInfo,
  type HostStorageVolume,
  type HostTask,
  INCUS_NAME_PATTERN,
  selfGuestAllows,
} from '@whombat/core/domain';
import { formatBytesBinary, plural } from './format';
import { parseProps } from './props';

/* Contract shapes (contracts 0.83.0, CT-363…CT-368) ------------------------------------------------- */

export type {
  HostIncusDetail,
  HostIncusImage,
  HostIncusNetwork,
  HostIncusPool,
  HostIncusProfile,
  HostIncusProfileSummary,
  HostIncusProject,
  HostNetworkLease,
  HostStorageVolume,
} from '@whombat/core/domain';

/** An image the `images:` server has (`choices.remoteImages`). */
export type HostIncusRemoteImage = NonNullable<HostChoices['remoteImages']>[number];

/* Reading a server and its guests --------------------------------------------------------------------- */

/** A server's page kind; a kind this app doesn't know reads as `standard`. */
export type ServerKind = 'proxmox' | 'standard' | 'incus' | 'unraid';

export function serverKind(s: Pick<HostServerInfo, 'platform'> | Pick<HostServer, 'platform'>): ServerKind {
  const p: string = s.platform;
  return p === 'proxmox' || p === 'incus' || p === 'unraid' ? p : 'standard';
}

/** The Incus part of a server's page (`detail.incus`), or null. */
export function incusDetail(d: HostServerDetail | null | undefined): HostIncusDetail | null {
  return d?.incus ?? null;
}

/** An Incus server gets the Incus page (IU-03): the hub's `incus` kind. */
export function isIncusServer(d: Pick<HostServerDetail, 'server'> | null | undefined): boolean {
  return !!d && serverKind(d.server) === 'incus';
}

/** The guest Whombat itself runs in (IU-02). */
export function isSelfGuest(g: Pick<HostGuest, 'self'> | null | undefined): boolean {
  return g?.self === true;
}

/** Whether this server runs the guest Whombat runs in. */
export function hostsThisWhombat(s: Pick<HostServerInfo, 'hostsThisWhombat'> | null | undefined): boolean {
  return s?.hostsThisWhombat === true;
}

/** Whether a task (an Incus operation) may be cancelled. */
export function taskCancellable(t: Pick<HostTask, 'cancellable'>): boolean {
  return t.cancellable === true;
}

/** When an Incus backup expires: `expiresAt`, else the `expires <iso>` in its notes. */
export function backupExpiresAt(b: HostBackupVolume): string | null {
  if (b.expiresAt) return b.expiresAt;
  const m = /^expires (\S+)$/.exec(b.notes ?? '');
  return m?.[1] ?? null;
}

/** `incus:web` → default project; `incus:ci/job` → project `ci`. */
export function incusRef(guestId: string): { project: string; name: string } {
  const rest = guestId.replace(/^incus:/, '');
  const at = rest.indexOf('/');
  return at < 0
    ? { project: 'default', name: rest }
    : { project: rest.slice(0, at), name: rest.slice(at + 1) };
}

/** The guest id of an instance in a project (`incus:web`, `incus:ci/job`). */
export function incusGuestId(project: string, name: string): string {
  return project && project !== 'default' ? `incus:${project}/${name}` : `incus:${name}`;
}

/* The self guest (IU-02) -------------------------------------------------------------------------------- */

/** The chip on the guest Whombat runs in. */
export const SELF_GUEST_CHIP = HOST_SELF_GUEST_LABEL;
/** The one line where its changing actions would be. */
export const SELF_GUEST_LINE = 'This is your Whombat itself.';
/** The hub's and the server's refusal (`self_guest`). */
export const SELF_GUEST_REFUSED = HOST_ERROR_WORDS.self_guest;

/** Whether a power or snapshot action may be done to this guest: anything, unless it's the self guest's refusal. */
export function selfAllowsAction(g: Pick<HostGuest, 'self'>, action: HostGuestAction): boolean {
  return !isSelfGuest(g) || selfGuestAllows({ action });
}

/** Whether a change may be made to this guest (`asNew`: it makes a new guest, as an Incus restore always does). */
export function selfAllowsOp(g: Pick<HostGuest, 'self'>, op: HostManageOp, asNew = false): boolean {
  return !isSelfGuest(g) || selfGuestAllows({ op, asNew });
}

/**
 * What the host's power question says (ONE-12, IU-02): the guests stop, and on a server that runs this Whombat,
 * “This Whombat goes down too.”
 */
export function hostPowerBody(action: 'host_reboot' | 'host_shutdown', thisWhombat: boolean): string {
  const down = thisWhombat ? ` ${HOST_SELF_SERVER_POWER_TEXT}` : '';
  return action === 'host_reboot'
    ? `Its guests stop while it restarts and start again if they’re set to start on boot.${down} It’s usually back within a few minutes.`
    : `Its guests stop too.${down} Whombat can’t switch it back on: someone has to press its power button.`;
}

/* Tabs ---------------------------------------------------------------------------------------------- */

export type IncusServerTab =
  | 'summary'
  | 'guests'
  | 'storage'
  | 'images'
  | 'network'
  | 'backups'
  | 'sensors'
  | 'system';

export const INCUS_SERVER_TABS: readonly IncusServerTab[] = [
  'summary',
  'guests',
  'storage',
  'images',
  'network',
  'backups',
  'sensors',
  'system',
];

export const INCUS_SERVER_TAB_WORDS: Record<IncusServerTab, string> = {
  summary: 'Summary',
  guests: 'Machines',
  storage: 'Storage',
  images: 'Images',
  network: 'Network',
  backups: 'Backups',
  sensors: 'Sensors',
  system: 'System',
};

export function parseIncusServerTab(v: unknown): IncusServerTab {
  return typeof v === 'string' && (INCUS_SERVER_TABS as readonly string[]).includes(v)
    ? (v as IncusServerTab)
    : 'summary';
}

export type IncusGuestTab = 'summary' | 'config' | 'devices' | 'snapshots' | 'backups' | 'tasks' | 'log';

export const INCUS_GUEST_TAB_WORDS: Record<IncusGuestTab, string> = {
  summary: 'Summary',
  config: 'Configuration',
  devices: 'Devices',
  snapshots: 'Snapshots',
  backups: 'Backups',
  tasks: 'Tasks',
  log: 'Log',
};

/**
 * An Incus instance's tabs (IU-04): Summary always; Configuration, Devices, Backups, Tasks and Log with Manage on;
 * Snapshots with power or Manage (the hub lists them under either, HS-29).
 */
export function incusGuestTabs(rc: HostRemoteControl | undefined, manageable: boolean): IncusGuestTab[] {
  const tabs: IncusGuestTab[] = ['summary'];
  if (manageable) tabs.push('config', 'devices');
  if (manageable || rc?.power) tabs.push('snapshots');
  if (manageable) tabs.push('backups', 'tasks', 'log');
  return tabs;
}

export function parseIncusGuestTab(v: unknown, allowed: readonly IncusGuestTab[]): IncusGuestTab {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as IncusGuestTab)
    : 'summary';
}

/* Values ------------------------------------------------------------------------------------------------- */

/** Incus's booleans (`true`, `yes`, `on`, `1`). */
export function incusOn(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === '') return fallback;
  return /^(true|yes|on|1)$/i.test(v.trim());
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  kB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  PB: 1e15,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  PiB: 1024 ** 5,
};

/** An Incus size (“16GiB”, “512MiB”, “10GB”, “1073741824”) in bytes; null for a percentage or nonsense. */
export function incusSizeBytes(v: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|PB|KiB|MiB|GiB|TiB|PiB)?$/.exec(v?.trim() ?? '');
  if (!m) return null;
  return Math.round(Number(m[1]) * (SIZE_UNITS[m[2] ?? 'B'] ?? 1));
}

/** Bytes as Incus writes sizes (“48GiB”, “512MiB”): whole units only, else the next smaller one. */
export function incusSizeString(bytes: number): string {
  for (const [unit, n] of [
    ['TiB', 1024 ** 4],
    ['GiB', 1024 ** 3],
    ['MiB', 1024 ** 2],
    ['KiB', 1024],
  ] as const)
    if (bytes >= n && bytes % n === 0) return `${bytes / n}${unit}`;
  return `${Math.round(bytes)}B`;
}

/** “4 CPUs”, “CPUs 0-3”, “1 CPU”. */
export function cpuWords(v: string | undefined): string {
  const s = (v ?? '').trim();
  if (/^\d+$/.test(s)) return plural(Number(s), 'CPU');
  return s ? `CPUs ${s}` : '';
}

/** “16 GiB”, “half of the server’s” (50%), the raw value otherwise. */
export function memoryWords(v: string | undefined): string {
  const s = (v ?? '').trim();
  const pct = /^(\d+)%$/.exec(s);
  if (pct) return `${pct[1]} % of the server’s`;
  const b = incusSizeBytes(s);
  return b != null ? formatBytesBinary(b) : s;
}

const SCHEDULE_ALIASES: Record<string, string> = {
  '@hourly': 'Every hour',
  '@daily': 'Every day',
  '@midnight': 'Every day at midnight',
  '@weekly': 'Every week',
  '@monthly': 'Every month',
  '@annually': 'Every year',
  '@yearly': 'Every year',
  '@startup': 'When it starts',
  '@never': 'Never',
};

const pad2 = (n: string) => n.padStart(2, '0');

/** A snapshot schedule in words: “Every day at 03:00”, “Every 6 hours”, “cron 0 3 * * 1” for the rest. */
export function scheduleWords(v: string | undefined): string {
  const s = (v ?? '').trim();
  if (!s) return '';
  if (SCHEDULE_ALIASES[s]) return SCHEDULE_ALIASES[s] as string;
  const f = s.split(/\s+/);
  if (f.length === 5) {
    const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
    const num = (x: string) => /^\d{1,2}$/.test(x);
    if (num(min) && num(hour) && dom === '*' && mon === '*' && dow === '*')
      return `Every day at ${pad2(hour)}:${pad2(min)}`;
    const every = /^\*\/(\d+)$/.exec(hour);
    if (num(min) && every && dom === '*' && mon === '*' && dow === '*')
      return every[1] === '1' ? 'Every hour' : `Every ${every[1]} hours`;
    if (num(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
    const days = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    if (num(min) && num(hour) && dom === '*' && mon === '*' && /^[0-7]$/.test(dow))
      return `${days[Number(dow) % 7]} at ${pad2(hour)}:${pad2(min)}`;
  }
  return `cron ${s}`;
}

/** A schedule Incus takes: a cron line (5 fields) or one of its @words; empty is fine (none). */
export function scheduleError(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (s.startsWith('@')) return SCHEDULE_ALIASES[s] ? null : 'Use @hourly, @daily, @weekly or @monthly.';
  const f = s.split(/\s+/);
  if (f.length !== 5 || !f.every((x) => /^[0-9*/,-]+$/.test(x)))
    return 'Five parts: minute hour day month weekday, like 0 3 * * *.';
  return null;
}

const EXPIRY_UNITS: Record<string, [string, string]> = {
  M: ['minute', 'minutes'],
  H: ['hour', 'hours'],
  d: ['day', 'days'],
  w: ['week', 'weeks'],
  m: ['month', 'months'],
  y: ['year', 'years'],
};

/** How long Incus keeps a snapshot (“2w” → “2 weeks”, “1d 12H” → “1 day 12 hours”); Incus's M is minutes, m months. */
export function expiryWords(v: string | undefined): string {
  const s = (v ?? '').trim();
  if (!s) return '';
  const parts = s.split(/\s+/).map((p) => /^(\d+)([MHdwmy])$/.exec(p));
  if (parts.some((p) => !p)) return s;
  return parts
    .map((p) => {
      const [, n, u] = p as RegExpExecArray;
      const w = EXPIRY_UNITS[u as string] as [string, string];
      return `${n} ${Number(n) === 1 ? w[0] : w[1]}`;
    })
    .join(' ');
}

export function expiryError(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  return s.split(/\s+/).every((p) => /^\d+[MHdwmy]$/.test(p))
    ? null
    : 'Like 2w, 14d or 1d 12H (M minutes, H hours, d days, w weeks, m months, y years).';
}

export function cpuError(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) >= 1 && Number(s) <= 512 ? null : 'Use 1 to 512 CPUs.';
  return /^\d{1,4}(-\d{1,4})?(,\d{1,4}(-\d{1,4})?)*$/.test(s) ? null : 'A number (4) or which ones (0-3,6).';
}

export function memoryError(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const pct = /^(\d{1,3})%$/.exec(s);
  if (pct) return Number(pct[1]) >= 1 && Number(pct[1]) <= 100 ? null : 'A share from 1 % to 100 %.';
  const b = incusSizeBytes(s);
  if (b == null || !/[A-Za-z]$/.test(s)) return 'A size like 4GiB or 512MiB, or a share like 50%.';
  return b >= 16 * 1024 ** 2 ? null : 'At least 16MiB.';
}

export function wholeError(v: string, max = 4_000_000_000): string | null {
  const s = v.trim();
  if (!s) return null;
  return /^\d{1,10}$/.test(s) && Number(s) <= max ? null : 'Use a whole number.';
}

/** A `user.*` key Incus takes. */
export function userKeyError(key: string): string | null {
  return /^user\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key.trim())
    ? null
    : 'Starts with user., then letters, digits, “.”, “_” and “-”.';
}

/** An instance name Incus takes (§2.2: `^[a-zA-Z][a-zA-Z0-9-]{0,62}$`). */
export function incusNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give it a name.';
  if (!/^[a-zA-Z]/.test(n)) return 'Start with a letter.';
  if (!INCUS_NAME_PATTERN.test(n)) return 'Letters, digits and “-”, at most 63.';
  if (n.endsWith('-')) return 'End with a letter or a digit.';
  return null;
}

/** A profile, volume or alias name (letters, digits, “.”, “_”, “-”; aliases may have “/”). */
export function incusObjectNameError(name: string, opts: { slash?: boolean } = {}): string | null {
  const n = name.trim();
  if (!n) return 'Give it a name.';
  const re = opts.slash
    ? /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
    : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  return re.test(n) ? null : `Letters, digits, “.”, “_” and “-”${opts.slash ? ', parts split by “/”' : ''}.`;
}

/** A size typed in GiB (“10”) as Incus's “10GiB”, or the error. */
export function gibError(v: string, min = 1): string | null {
  const s = v.trim();
  if (!/^\d+$/.test(s)) return 'Use a whole number of GiB.';
  return Number(s) >= min && Number(s) <= 1_048_576 ? null : `At least ${min} GiB.`;
}

/* Configuration in groups (MANAGE.md §2.5) -------------------------------------------------------------- */

export type IncusFieldKind =
  | 'cpu'
  | 'memory'
  | 'bool'
  | 'int'
  | 'seconds'
  | 'schedule'
  | 'expiry'
  | 'text'
  | 'notes';

export interface IncusField {
  key: string;
  label: string;
  kind: IncusFieldKind;
  /** What it means when the key isn't set. */
  unset: string;
  hint?: string;
  /** Words for on and off (booleans). */
  on?: string;
  off?: string;
  containersOnly?: boolean;
}

export type IncusGroupId = 'resources' | 'boot' | 'security' | 'snapshots' | 'notes';

export interface IncusGroup {
  id: IncusGroupId;
  title: string;
  fields: IncusField[];
}

/** The settings Whombat changes, grouped as the Configuration tab shows them (Profiles come after). */
export const INCUS_GROUPS: readonly IncusGroup[] = [
  {
    id: 'resources',
    title: 'Resources',
    fields: [
      {
        key: 'limits.cpu',
        label: 'CPUs',
        kind: 'cpu',
        unset: 'All of the server’s',
        hint: 'A number (4), or which ones (0-3).',
      },
      {
        key: 'limits.memory',
        label: 'Memory',
        kind: 'memory',
        unset: 'No limit',
        hint: 'A size like 4GiB or 512MiB, or a share like 50%.',
      },
      {
        key: 'limits.memory.swap',
        label: 'Swap',
        kind: 'bool',
        unset: 'Allowed',
        on: 'Allowed',
        off: 'Not allowed',
        containersOnly: true,
      },
      {
        key: 'limits.processes',
        label: 'Processes',
        kind: 'int',
        unset: 'No limit',
        hint: 'The most processes it may run at once.',
        containersOnly: true,
      },
    ],
  },
  {
    id: 'boot',
    title: 'Boot',
    fields: [
      {
        key: 'boot.autostart',
        label: 'Start with the server',
        kind: 'bool',
        unset: 'If it was running before',
        on: 'Yes',
        off: 'No',
      },
      {
        key: 'boot.autostart.priority',
        label: 'Start order',
        kind: 'int',
        unset: '0',
        hint: 'Higher numbers start first.',
      },
      {
        key: 'boot.autostart.delay',
        label: 'Wait after starting',
        kind: 'seconds',
        unset: 'No wait',
        hint: 'Seconds before the next one starts.',
      },
      {
        key: 'boot.host_shutdown_timeout',
        label: 'Time to shut down',
        kind: 'seconds',
        unset: '30 s',
        hint: 'Seconds it gets to shut down when the server does.',
      },
    ],
  },
  {
    id: 'security',
    title: 'Security',
    fields: [
      {
        key: 'security.protection.delete',
        label: 'Protection',
        kind: 'bool',
        unset: 'Off',
        on: 'Can’t be deleted',
        off: 'Off',
        hint: 'Incus refuses to delete it while this is on.',
      },
      {
        key: 'security.nesting',
        label: 'Containers inside',
        kind: 'bool',
        unset: 'Not allowed',
        on: 'Allowed',
        off: 'Not allowed',
        hint: 'Lets it run Docker or Incus itself.',
        containersOnly: true,
      },
    ],
  },
  {
    id: 'snapshots',
    title: 'Snapshots',
    fields: [
      { key: 'snapshots.schedule', label: 'Schedule', kind: 'schedule', unset: 'None' },
      { key: 'snapshots.expiry', label: 'Kept for', kind: 'expiry', unset: 'Until removed' },
      {
        key: 'snapshots.pattern',
        label: 'Names',
        kind: 'text',
        unset: 'snap0, snap1, …',
        hint: 'Like daily-%d; %d becomes a number.',
      },
    ],
  },
  {
    id: 'notes',
    title: 'Notes',
    fields: [{ key: 'description', label: 'Notes', kind: 'notes', unset: 'None' }],
  },
];

/** The fields of a group that apply to this kind of instance. */
export function groupFields(g: IncusGroup, kind: HostGuest['kind']): IncusField[] {
  return g.fields.filter((f) => !f.containersOnly || kind === 'container');
}

/** Every key a group shows. */
export const INCUS_GROUP_KEYS: ReadonlySet<string> = new Set(
  INCUS_GROUPS.flatMap((g) => g.fields.map((f) => f.key)),
);

/** How a field's value reads (“4 CPUs”, “Every day at 03:00”), or its unset words. */
export function fieldWords(f: IncusField, v: string | undefined): string {
  if (v === undefined || v === '') return f.unset;
  switch (f.kind) {
    case 'cpu':
      return cpuWords(v);
    case 'memory':
      return memoryWords(v);
    case 'bool':
      return incusOn(v) ? (f.on ?? 'Yes') : (f.off ?? 'No');
    case 'seconds':
      return `${v} s`;
    case 'schedule':
      return scheduleWords(v);
    case 'expiry':
      return expiryWords(v);
    default:
      return v;
  }
}

/** What is wrong with a value typed for a field. */
export function fieldError(f: IncusField, v: string): string | null {
  switch (f.kind) {
    case 'cpu':
      return cpuError(v);
    case 'memory':
      return memoryError(v);
    case 'int':
    case 'seconds':
      return wholeError(v);
    case 'schedule':
      return scheduleError(v);
    case 'expiry':
      return expiryError(v);
    case 'text':
      return v.trim().length > 200 || /\s/.test(v.trim()) ? 'One word, no spaces.' : null;
    default:
      return null;
  }
}

/** The instance's own `user.*` keys and the ones from its profiles, in order. */
export function userKeys(values: Record<string, string>): string[] {
  return Object.keys(values)
    .filter((k) => k.startsWith('user.'))
    .sort();
}

/**
 * Keys no group shows and that aren't `user.*` or devices (`raw.*`, `security.privileged`, `image.*`,
 * `environment.*`, `cloud-init.*` …): shown as they are, the restricted ones locked.
 */
export function incusOtherKeys(values: Record<string, string>): string[] {
  return Object.keys(values)
    .filter(
      (k) =>
        !INCUS_GROUP_KEYS.has(k) &&
        !k.startsWith('user.') &&
        !k.startsWith('device.') &&
        !k.startsWith('image.'),
    )
    .sort();
}

/** Keys that come from a profile (the instance doesn't set them itself). */
export function isInherited(cfg: Pick<HostGuestConfig, 'inherited'> | undefined, key: string): boolean {
  return !!cfg?.inherited?.includes(key);
}

/** The words a locked Incus key shows (“Change this with the incus command”). */
export const INCUS_LOCK_WORDS = 'Change this with the incus command';

/* Devices ------------------------------------------------------------------------------------------------ */

export interface IncusDevice {
  name: string;
  type: string;
  props: Record<string, string>;
  /** The config value (`type=disk,path=/,pool=default`). */
  raw: string;
  /** From a profile: the instance can't remove it. */
  inherited: boolean;
  /** Only the incus command changes it (a macvlan NIC, a host path, a GPU). */
  restricted: boolean;
}

/** A device string's options (an item without “=” continues the previous value: `vlan.tagged=10,20`). */
function propsOf(raw: string): Record<string, string> {
  return Object.fromEntries(parseProps(raw).map((i) => [i.key, i.value]));
}

/** The instance's devices (`device.<name>`, its profiles' included), root disk first, then NICs, then the rest. */
export function incusDevices(
  cfg: Pick<HostGuestConfig, 'values' | 'inherited' | 'restricted'> | undefined,
): IncusDevice[] {
  if (!cfg) return [];
  const rank = (d: IncusDevice) => (isRootDisk(d) ? 0 : d.type === 'nic' ? 1 : d.type === 'disk' ? 2 : 3);
  return Object.entries(cfg.values)
    .filter(([k]) => k.startsWith('device.'))
    .map(([k, raw]) => {
      const props = propsOf(raw);
      return {
        name: k.slice('device.'.length),
        type: props.type ?? '',
        props,
        raw,
        inherited: !!cfg.inherited?.includes(k),
        restricted: !!cfg.restricted?.includes(k),
      };
    })
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function isRootDisk(d: Pick<IncusDevice, 'type' | 'props'>): boolean {
  return d.type === 'disk' && d.props.path === '/' && !d.props.source;
}

/** A device in words: its title and its line under it. */
export function deviceWords(d: IncusDevice, sizeBytes?: number | null): { title: string; sub: string } {
  const p = d.props;
  if (d.type === 'nic') {
    const on = p.network
      ? `On the ${p.network} network`
      : p.nictype === 'bridged' && p.parent
        ? `On the host bridge ${p.parent}`
        : p.nictype && p.parent
          ? `${p.nictype} on ${p.parent}`
          : p.nictype
            ? p.nictype
            : 'Network card';
    const extra = [
      p.name ? `${p.name} inside` : '',
      p['ipv4.address'] ? `fixed address ${p['ipv4.address']}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return { title: 'Network card', sub: [on, extra].filter(Boolean).join(' · ') };
  }
  if (d.type === 'disk') {
    if (isRootDisk(d)) {
      const size = p.size ? memoryWords(p.size) : sizeBytes ? formatBytesBinary(sizeBytes) : null;
      return {
        title: 'Root disk',
        sub: size ? `${size} on pool ${p.pool ?? '?'}` : `On pool ${p.pool ?? '?'}, the pool’s default size`,
      };
    }
    if (p.pool && p.source)
      return { title: 'Volume', sub: `${p.source} on pool ${p.pool}${p.path ? ` · at ${p.path}` : ''}` };
    if (p.source) return { title: 'Host folder', sub: `${p.source}${p.path ? ` → ${p.path}` : ''}` };
    return { title: 'Disk', sub: p.path ?? '' };
  }
  return { title: d.type ? `${d.type.charAt(0).toUpperCase()}${d.type.slice(1)}` : 'Device', sub: d.raw };
}

/** The first free device name with a stem (`eth1`, `data0`). */
export function freeDeviceName(values: Record<string, string>, stem: string): string {
  for (let i = 0; i < 64; i++) if (!(`device.${stem}${i}` in values)) return `${stem}${i}`;
  return `${stem}${Date.now() % 1000}`;
}

/** A NIC as Incus stores it: on an Incus network, or bridged to a host bridge (the hub's allowlist). */
export function nicValue(o: { network?: string; bridge?: string; name: string }): string {
  return o.network
    ? `type=nic,name=${o.name},network=${o.network}`
    : `type=nic,name=${o.name},nictype=bridged,parent=${o.bridge ?? ''}`;
}

/** A custom volume of a pool, mounted in a container at `path` (a VM gets it as a disk without a path). */
export function volumeDiskValue(o: { pool: string; volume: string; path?: string }): string {
  return ['type=disk', ...(o.path ? [`path=${o.path}`] : []), `pool=${o.pool}`, `source=${o.volume}`].join(
    ',',
  );
}

/** A folder inside a container: absolute, no spaces or commas. */
export function incusPathError(path: string): string | null {
  const p = path.trim();
  if (!p) return 'Where it shows up inside, like /data.';
  return /^\/[^\s,]*$/.test(p) && p !== '/' ? null : 'An absolute folder like /data, without spaces.';
}

/** The root disk's size: its `size=`, else what the hub read from the pool (`disks`). */
export function rootDiskBytes(cfg: HostGuestConfig | undefined): number | null {
  const root = incusDevices(cfg).find(isRootDisk);
  const own = incusSizeBytes(root?.props.size);
  if (own != null) return own;
  return cfg?.disks?.find((d) => d.path === '/')?.sizeBytes ?? null;
}

/* Snapshots, backups ------------------------------------------------------------------------------------ */

export const SCHEDULE_PRESETS: readonly { value: string; label: string }[] = [
  { value: '', label: 'None' },
  { value: '@hourly', label: 'Every hour' },
  { value: '@daily', label: 'Every day' },
  { value: '@weekly', label: 'Every week' },
  { value: 'custom', label: 'Custom…' },
];

export const EXPIRY_PRESETS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Until removed' },
  { value: '1d', label: '1 day' },
  { value: '1w', label: '1 week' },
  { value: '2w', label: '2 weeks' },
  { value: '1m', label: '1 month' },
  { value: '3m', label: '3 months' },
  { value: 'custom', label: 'Custom…' },
];

/** Which preset a value is (`custom` for any other). */
export function presetOf(list: readonly { value: string }[], v: string | undefined): string {
  const s = (v ?? '').trim();
  return list.some((p) => p.value === s && p.value !== 'custom') ? s : 'custom';
}

const two = (n: number) => String(n).padStart(2, '0');

/** A backup's default name (§2.2): `whombat-20261017-1430`. */
export function incusBackupName(now: number): string {
  const d = new Date(now);
  return `whombat-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

export const BACKUP_KEEP_DAYS: readonly { value: string; label: string }[] = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

export const BACKUP_COMPRESSION: readonly { value: string; label: string }[] = [
  { value: 'zstd', label: 'ZSTD (fast and small)' },
  { value: 'gzip', label: 'GZIP (works everywhere)' },
  { value: 'none', label: 'None' },
];

/** `backup.create` params for an Incus instance: it expires after `days` (Incus deletes it then). */
export function incusBackupParams(o: {
  name: string;
  days: number;
  instanceOnly: boolean;
  optimized: boolean;
  compression: string;
  now: number;
}) {
  return {
    ...(o.name.trim() ? { name: o.name.trim() } : {}),
    expiresAt: new Date(o.now + Math.max(1, o.days) * 86_400_000).toISOString(),
    instanceOnly: o.instanceOnly,
    optimized: o.optimized,
    compression: o.compression,
  };
}

/** A backup name Incus takes (no “/”). */
export function backupNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n) ? null : 'Letters, digits, “.”, “_” and “-”.';
}

/** “expires in 6 days”, “expired”, “kept until deleted”. */
export function expiryText(at: string | null, now: number): string {
  if (!at) return 'Kept until deleted';
  const ms = Date.parse(at) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'Expired';
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) return `Expires in ${plural(days, 'day')}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `Expires in ${plural(hours, 'hour')}`;
}

/** Whether a snapshot schedule covers the instance (its own or a profile's: `config.get` reads the expanded one). */
export function hasSnapshotSchedule(values: Record<string, string> | undefined): boolean {
  const s = values?.['snapshots.schedule']?.trim();
  return !!s && s !== '@never';
}

/* Create (IU-04) ---------------------------------------------------------------------------------------- */

export interface IncusNewForm {
  name: string;
  project: string;
  type: 'container' | 'vm';
  /** A local alias or fingerprint, or `images:debian/13`. */
  image: string;
  profiles: string[];
  pool: string;
  /** '' = from the profiles. */
  network: string;
  cpu: string;
  memory: string;
  /** GiB; '' = the pool's default. */
  diskGb: string;
  cloudInit: string;
  start: boolean;
}

/** The `images:` server's common images (§2.2), when the host's choices don't list them. */
export const INCUS_COMMON_IMAGES: readonly string[] = [
  'debian/13',
  'debian/12',
  'ubuntu/24.04',
  'ubuntu/22.04',
  'alpine/3.22',
  'fedora/42',
  'archlinux',
  'rockylinux/9',
  'nixos/25.05',
];

/** An image a create can pick: from the server first, then the `images:` server. */
export interface IncusImageOption {
  value: string;
  label: string;
  group: 'On this server' | 'From images.linuxcontainers.org';
  cloud: boolean;
}

interface ChoiceImage {
  fingerprint?: string;
  aliases?: string[];
  description?: string;
  type?: string;
}

function remoteImagesOf(c: HostChoices | undefined): HostIncusRemoteImage[] {
  const listed = (c as { remoteImages?: HostIncusRemoteImage[] } | undefined)?.remoteImages;
  if (listed?.length) return listed;
  return INCUS_COMMON_IMAGES.flatMap((alias) => [
    { alias, description: alias, type: 'container' as const },
    { alias, description: alias, type: 'virtual-machine' as const },
    { alias: `${alias}/cloud`, description: `${alias} with cloud-init`, type: 'container' as const },
    { alias: `${alias}/cloud`, description: `${alias} with cloud-init`, type: 'virtual-machine' as const },
  ]);
}

/** Whether an image reads cloud-init user data (the `/cloud` variants, or a local image that says so). */
export function isCloudImage(ref: string, description = ''): boolean {
  return /\/cloud$/.test(ref.trim()) || /cloud/i.test(description);
}

/** The images a create offers for a type: the server's first (by alias), then the `images:` server's. */
export function incusImageOptions(
  c: HostChoices | undefined,
  type: IncusNewForm['type'],
): IncusImageOption[] {
  const want = type === 'vm' ? 'virtual-machine' : 'container';
  const local: IncusImageOption[] = ((c?.images ?? []) as ChoiceImage[])
    .filter((i) => i.type === want)
    .map((i) => {
      const ref = i.aliases?.[0] ?? i.fingerprint?.slice(0, 12) ?? '';
      return {
        value: ref,
        label: i.description ? `${i.description}${i.aliases?.[0] ? ` (${i.aliases[0]})` : ''}` : ref,
        group: 'On this server' as const,
        cloud: isCloudImage(ref, i.description ?? ''),
      };
    })
    .filter((o) => o.value);
  const remote: IncusImageOption[] = remoteImagesOf(c)
    .filter((i) => i.type === want)
    .map((i) => ({
      value: `images:${i.alias}`,
      label: `images:${i.alias}`,
      group: 'From images.linuxcontainers.org' as const,
      cloud: isCloudImage(i.alias, i.description),
    }));
  const seen = new Set<string>();
  return [...local, ...remote].filter((o) => !seen.has(o.value) && seen.add(o.value));
}

/** The projects a create can go to (`choices.projects`, else `default`). */
export function incusProjects(c: HostChoices | undefined): string[] {
  const p = (c as { projects?: string[] } | undefined)?.projects;
  return p?.length ? p : ['default'];
}

export function incusNewDefaults(c: HostChoices | undefined, project = 'default'): IncusNewForm {
  const first = incusImageOptions(c, 'container').find((o) => o.group === 'On this server');
  return {
    name: '',
    project,
    type: 'container',
    image: first?.value ?? 'images:debian/13',
    profiles: c?.profiles?.includes('default') ? ['default'] : [],
    pool: c?.storages.find((s) => s.id === 'default')?.id ?? c?.storages[0]?.id ?? '',
    network: '',
    cpu: '',
    memory: '',
    diskGb: '',
    cloudInit: '',
    start: true,
  };
}

export type IncusNewErrors = Partial<Record<keyof IncusNewForm, string>>;

export function incusNewErrors(f: IncusNewForm): IncusNewErrors {
  const e: IncusNewErrors = {};
  const name = incusNameError(f.name);
  if (name) e.name = name;
  if (!f.image.trim()) e.image = 'Pick an image, or type one.';
  else if (!/^[A-Za-z0-9:][A-Za-z0-9._:/-]*$/.test(f.image.trim()))
    e.image = 'An alias like images:debian/13, or one on the server.';
  const cpu = cpuError(f.cpu);
  if (cpu) e.cpu = cpu;
  const mem = memoryError(f.memory);
  if (mem) e.memory = mem;
  if (f.diskGb.trim()) {
    const d = gibError(f.diskGb);
    if (d) e.diskGb = d;
  }
  if (new TextEncoder().encode(f.cloudInit).length > 64 * 1024) e.cloudInit = 'At most 64 KiB.';
  else if (f.cloudInit.trim() && !/^#cloud-config|^#!/.test(f.cloudInit.trim()))
    e.cloudInit = 'Starts with #cloud-config (or #! for a script).';
  return e;
}

/** `guest.create` params for an Incus instance (§2.2): what is left empty comes from the profiles. */
export function incusNewParams(f: IncusNewForm, cloud: boolean) {
  const set: Record<string, string> = {};
  if (f.cpu.trim()) set['limits.cpu'] = f.cpu.trim();
  if (f.memory.trim()) set['limits.memory'] = f.memory.trim();
  if (f.diskGb.trim())
    set['device.root'] = `type=disk,path=/,pool=${f.pool || 'default'},size=${f.diskGb.trim()}GiB`;
  return {
    platform: 'incus' as const,
    kind: f.type,
    name: f.name.trim(),
    image: f.image.trim(),
    profiles: f.profiles,
    ...(f.project && f.project !== 'default' ? { project: f.project } : {}),
    ...(f.pool ? { pool: f.pool } : {}),
    ...(f.network ? { network: f.network } : {}),
    ...(cloud && f.cloudInit.trim() ? { cloudInit: f.cloudInit } : {}),
    start: f.start,
    set,
  };
}

/** The platform's field errors on the create form's fields. */
export const INCUS_NEW_ERROR_FIELDS: Record<string, keyof IncusNewForm> = {
  name: 'name',
  image: 'image',
  project: 'project',
  pool: 'pool',
  network: 'network',
  cloud_init: 'cloudInit',
  cloudInit: 'cloudInit',
  'limits.cpu': 'cpu',
  'limits.memory': 'memory',
  'device.root': 'diskGb',
};

/** “# cloud-config” to start from. */
export const CLOUD_INIT_EXAMPLE = `#cloud-config
packages:
  - curl
`;

/* Host level ----------------------------------------------------------------------------------------- */

/** A pool's use in percent, or null. */
export function poolPct(p: Pick<HostIncusPool, 'usedBytes' | 'totalBytes'>): number | null {
  return p.usedBytes != null && p.totalBytes ? (p.usedBytes / p.totalBytes) * 100 : null;
}

/** “84 GiB / 1.5 TiB”. */
export function poolUseText(p: Pick<HostIncusPool, 'usedBytes' | 'totalBytes'>): string {
  return p.totalBytes
    ? `${formatBytesBinary(p.usedBytes)} / ${formatBytesBinary(p.totalBytes)}`
    : formatBytesBinary(p.usedBytes);
}

/** The pool hint's threshold (IU-08). */
export const POOL_FULL_PCT = 85;

/** “Container image”, “VM image”. */
export function imageTypeWord(t: HostIncusImage['type']): string {
  return t === 'virtual-machine' ? 'VM' : 'Container';
}

/** An image's name: its first alias, else its description, else the short fingerprint. */
export function imageName(i: Pick<HostIncusImage, 'aliases' | 'description' | 'fingerprint'>): string {
  return i.aliases[0] ?? (i.description || i.fingerprint.slice(0, 12));
}

/** Images newest first within their project. */
export function sortImages(list: readonly HostIncusImage[]): HostIncusImage[] {
  return [...list].sort(
    (a, b) => a.project.localeCompare(b.project) || (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? ''),
  );
}

/** An alias the images server knows: `debian/13`, `ubuntu/24.04/cloud` (no `images:` in front). */
export function remoteAliasError(alias: string): string | null {
  const a = alias.trim().replace(/^images:/, '');
  if (!a) return 'Type an image, like debian/13.';
  return /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i.test(a)
    ? null
    : 'Like debian/13 or ubuntu/24.04/cloud.';
}

/** “incusbr0 · 10.62.52.1/24 · NAT”. */
export function networkWords(n: HostIncusNetwork): string {
  return [n.ipv4, n.ipv6, n.nat ? 'NAT' : null].filter(Boolean).join(' · ');
}

/** “Used by 4”, “Not used”. */
export function usedByText(n: number): string {
  return n ? `Used by ${n}` : 'Not used';
}

/** The volume's content type in words. */
export function volumeContentWord(t: HostStorageVolume['contentType']): string {
  return t === 'block' ? 'Block' : t === 'iso' ? 'ISO image' : 'Folder';
}

/** A server's Incus warnings (the existing platform warnings), most seen first. */
export function incusWarnings(d: HostServerDetail) {
  return [...(d.workloads?.incus?.warnings ?? [])].sort((a, b) => b.count - a.count);
}

/** Incus guests of a server's page. */
export function incusGuests(d: HostServerDetail): HostGuest[] {
  return d.workloads?.incus?.guests ?? [];
}

/* Words for changes --------------------------------------------------------------------------------- */

/** What an Incus change that runs as a task is called (“Backup of web”, “Copy of web”). */
export function incusTaskWhat(op: HostManageOp, name: string): string {
  switch (op) {
    case 'guest.clone':
      return `Copy of ${name}`;
    case 'guest.rename':
      return `Renaming ${name}`;
    case 'guest.move':
      return `Move of ${name}`;
    case 'guest.publish':
      return `Image of ${name}`;
    case 'image.download':
      return `Download of ${name}`;
    case 'image.refresh':
      return `Refresh of ${name}`;
    case 'image.delete':
      return `Deleting ${name}`;
    case 'backup.create':
      return `Backup of ${name}`;
    case 'backup.restore':
      return `Restore of ${name}`;
    case 'guest.create':
      return `Creating ${name}`;
    case 'guest.delete':
      return `Deleting ${name}`;
    default:
      return name ? `The task for ${name}` : 'The task';
  }
}

/** The toast when an Incus change was done at once. */
export function incusDoneText(op: HostManageOp, name: string): string {
  switch (op) {
    case 'profile.create':
      return `Made the profile ${name}.`;
    case 'profile.update':
      return `Saved the profile ${name}.`;
    case 'profile.delete':
      return `Deleted the profile ${name}.`;
    case 'volume.create':
      return `Made the volume ${name}.`;
    case 'volume.resize':
      return `Grew the volume ${name}.`;
    case 'volume.delete':
      return `Deleted the volume ${name}.`;
    case 'image.delete':
      return `Deleted the image ${name}.`;
    case 'image.refresh':
      return `${name} is up to date.`;
    case 'guest.rename':
      return `Renamed it to ${name}.`;
    case 'backup.delete':
      return 'Deleted the backup.';
    case 'task.stop':
      return 'Cancelled it.';
    default:
      return 'Done.';
  }
}

/** “Backup of web”: an Incus operation's words (its description, which Incus writes as “Backing up instance”). */
export function incusOperationText(t: Pick<HostTask, 'type' | 'message' | 'guestId'>): string {
  const what = INCUS_OP_WORDS[t.type] ?? t.message ?? t.type;
  const g = t.guestId ? incusRef(t.guestId).name : '';
  return g ? `${what} · ${g}` : what;
}

const INCUS_OP_WORDS: Record<string, string> = {
  create: 'Create',
  'instance.create': 'Create',
  copy: 'Copy',
  'instance.copy': 'Copy',
  backup: 'Backup',
  'backup.create': 'Backup',
  'backup.restore': 'Restore',
  snapshot: 'Snapshot',
  'snapshot.create': 'Snapshot',
  'snapshot.restore': 'Back to a snapshot',
  delete: 'Delete',
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  rename: 'Rename',
  move: 'Move',
  publish: 'Make an image',
  'image.download': 'Download an image',
  'image.refresh': 'Refresh an image',
  update: 'Settings',
};

/* Hints with their way out (IU-08) ------------------------------------------------------------------------ */

export type IncusHintFix =
  | { kind: 'guest'; guestId: string; gtab: 'snapshots'; label: string }
  | { kind: 'tab'; tab: 'storage' | 'system'; label: string };

/**
 * The Incus hints' ways out: no snapshot schedule → the instance's Snapshots tab (“Set a schedule”), a full pool →
 * Storage, an Incus warning → System. Null for a hint that isn't Incus's.
 */
export function incusHintFixes(h: HostHint, guests: readonly HostGuest[]): IncusHintFix[] | null {
  switch (h.kind) {
    case 'incus.no_snapshots': {
      // “web, db, … · no backup in 30 days either”: the names come before the middle dot.
      const named = (h.detail.split(' · ')[0] ?? '')
        .split(', ')
        .map((n) => n.replace(/\s*\(.*\)$/, '').trim())
        .filter((n) => n && n !== '…');
      const found = guests.filter(
        (g) =>
          g.platform === 'incus' &&
          (named.includes(g.name) || g.id === h.entity || `incus:${h.entity}` === g.id),
      );
      return found.slice(0, 3).map((g) => ({
        kind: 'guest',
        guestId: g.id,
        gtab: 'snapshots',
        label: found.length > 1 ? `Set a schedule for ${g.name}` : 'Set a schedule',
      }));
    }
    case 'incus.pool_full':
      return [{ kind: 'tab', tab: 'storage', label: 'Open Storage' }];
    case 'incus.warning':
      return [{ kind: 'tab', tab: 'system', label: 'Open System' }];
    default:
      return null;
  }
}
