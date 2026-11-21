/**
 * The hosts service's side of backup places (docs/decisions/backup-places.md BPL-01…BPL-03, BPL-12; the build brief
 * §2.1, hosts HS-203…): a server's `backup_place` as its detail reports it, and the routes that make a server keep
 * a Whombat's backups. The hub's snake_case is read here and nowhere else, so when its JSON differs this is the one file
 * to change.
 */
import { HOSTS_API, seg } from '../hosts/client';
import { arr, num, obj, str } from '../hosts/map';
import { keepHasWindows, longestKeepDays, type PlaceKeep } from './keep';
import type { LocationFacts } from './locations';

/** What a server reports about keeping backups (`backup_place`). */
export interface HubBackupPlace {
  supported: boolean;
  /** Why not: `no_docker`, `docker_down`, `array_stopped`, `self`, or a newer agent's word; null when supported. */
  reason: string | null;
  /** `unraid` or `linux`. */
  platform: string;
  root: string | null;
  freeBytes: number | null;
  totalBytes: number | null;
  /** Its IPv4 LAN addresses, the interface with the default route first. */
  addresses: string[];
  /** It can share a folder over NFS (Unraid with NFS on). */
  nfs: boolean;
  clients: HubPlaceClient[];
  /** Where on it the backups can be kept (Unraid's shares); empty from an agent that doesn't say, or on Linux. */
  locations: LocationFacts[];
}

/** One Whombat a server keeps backups for. */
export interface HubPlaceClient {
  client: string;
  port: number | null;
  running: boolean;
  usedBytes: number | null;
  /** The location its backups are in (an Unraid share), when the agent says. */
  location: string | null;
  cleanup: {
    set: boolean;
    running: boolean;
    keepDays: number | null;
    lastAt: string | null;
    ok: boolean | null;
    error: string | null;
    /**
     * What the cleanup keeps, as its helper reports it (`keep`: `<all>` or `<all>,<daily>,<weekly days>,<monthly
     * months>,<limit bytes>`, HS-251); null from a helper that doesn't report it, which knows only
     * `keep_within_days`.
     */
    keep: PlaceKeep | null;
  };
  /** Its backup app has the kit user (backup-passkey.md); null from an agent that doesn't say (an older one). */
  kit: boolean | null;
}

/** A helper's `cleanup.keep` (null when it isn't one: an older helper's, or a cleanup that isn't set). */
export function keepOfReport(text: string | null): PlaceKeep | null {
  if (!text) return null;
  const parts = text.split(',').map((x) => Number(x.trim()));
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const [all, daily = 0, weeklyDays = 0, monthly = 0, limit = 0] = parts;
  if (!all || (parts.length !== 1 && parts.length !== 5)) return null;
  return {
    allDays: all,
    dailyDays: daily,
    weeklyWeeks: Math.round(weeklyDays / 7),
    monthlyMonths: monthly,
    limitBytes: limit > 0 ? limit : null,
  };
}

const bytes = (v: unknown) => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.floor(n) : null;
};

/** An IPv4 address on the home network (BK-29 lets plain http go only to one of these). */
export function isPrivateIpv4(text: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function toClient(raw: unknown): HubPlaceClient | null {
  const c = obj(raw);
  const client = str(c.client);
  if (!client) return null;
  const cl = obj(c.cleanup);
  return {
    client,
    port: num(c.port),
    running: c.running === true,
    usedBytes: bytes(c.used_bytes),
    location: str(c.location) || null,
    cleanup: {
      set: cl.set === true,
      running: cl.running === true,
      keepDays: num(cl.keep_within_days),
      lastAt: str(cl.last_run_at) || null,
      ok: typeof cl.last_ok === 'boolean' ? cl.last_ok : null,
      error: str(cl.last_error) || null,
      keep: cl.set === true ? keepOfReport(str(cl.keep) || null) : null,
    },
    kit: typeof c.kit === 'boolean' ? c.kit : null,
  };
}

/** The share Whombat makes for backups only, not shared on the network: the recommended one. */
export const OWN_SHARE = 'whombat-backups';
/** Unraid's own shares: apps' data, virtual machines' disks, installer images, Docker's and libvirt's files. */
const UNRAID_OWN = new Set(['appdata', 'domains', 'isos', 'system']);
/** What an export setting says when the share isn't exported (`smb`/`nfs`: `public`, `secure`, `private` or empty). */
const NOT_EXPORTED = new Set(['', 'no', 'none', 'off', 'false', '-']);

const exported = (v: unknown) =>
  v === true || (typeof v === 'string' && !NOT_EXPORTED.has(v.trim().toLowerCase()));

/** One of `backup_place.locations` (an Unraid share): `{id, name, free_bytes, is_new, smb, nfs, primary, path}`. */
export function toLocation(raw: unknown): LocationFacts | null {
  const l = obj(raw);
  const id = str(l.id);
  if (!id) return null;
  const primary = str(l.primary)?.trim() ?? '';
  return {
    id,
    name: str(l.name) || id,
    freeBytes: bytes(l.free_bytes),
    isNew: l.is_new === true,
    recommended: id === OWN_SHARE,
    shared: exported(l.smb) || exported(l.nfs),
    // `array` (or Unraid's `user`) is the array itself; any other name is a pool such as the cache.
    pool: primary && !['array', 'user'].includes(primary.toLowerCase()) ? primary : null,
    holdsOther: UNRAID_OWN.has(id.toLowerCase()),
  };
}

/** A server detail's `backup_place` (at the top or beside `server`); null from an agent that doesn't report it. */
export function hubBackupPlace(detail: unknown): HubBackupPlace | null {
  const d = obj(detail);
  const raw = d.backup_place ?? obj(d.server).backup_place;
  if (!raw || typeof raw !== 'object') return null;
  const p = obj(raw);
  return {
    supported: p.supported === true,
    reason: p.supported === true ? null : str(p.reason) || 'unsupported',
    platform: str(p.platform) || 'linux',
    root: str(p.root) || null,
    freeBytes: bytes(p.free_bytes),
    totalBytes: bytes(p.total_bytes),
    addresses: arr(p.addresses).filter((a): a is string => typeof a === 'string' && isPrivateIpv4(a)),
    nfs: p.nfs === true,
    clients: arr(p.clients).flatMap((c) => toClient(c) ?? []),
    locations: arr(p.locations).flatMap((l) => toLocation(l) ?? []),
  };
}

/** Whether Manage is on for a server on both sides (the hub's switch and the agent's), from its detail. */
export function manageOn(detail: unknown): boolean {
  const rc = obj(obj(obj(detail).server).remote_control);
  return rc.manage === true && rc.agent_manage !== false;
}

/** The address the hub reaches the server at (`server.address`), when it is one. */
export function serverAddress(detail: unknown): string | null {
  const a = str(obj(obj(detail).server).address)
    ?.trim()
    .replace(/\/\d{1,2}$/, '');
  return a && isPrivateIpv4(a) ? a : null;
}

const S = (serverId: string) => `${HOSTS_API}/servers/${seg(serverId)}`;

/** The routes (§2.1). */
export const PLACE_ROUTES = {
  ensure: (serverId: string) => `${S(serverId)}/backup-place/ensure`,
  cleanup: (serverId: string, client: string) => `${S(serverId)}/backup-place/${seg(client)}/cleanup`,
  remove: (serverId: string, client: string) => `${S(serverId)}/backup-place/${seg(client)}`,
  nfs: (serverId: string) => `${S(serverId)}/backup-place/nfs`,
  storages: (serverId: string) => `${S(serverId)}/proxmox/storages`,
} as const;

/** `ensure`'s body; `location` moves the Whombat's folder there when it is elsewhere (BPL-14). */
export const ensureBody = (client: string, restPassword: string, port = 0, location?: string) => ({
  client,
  rest_password: restPassword,
  port,
  ...(location ? { location } : {}),
});

/** `ensure`'s answer: where the app answers, where the backups are now and whether the agent moved them there. */
export function ensureAnswer(raw: unknown): {
  port: number | null;
  addresses: string[];
  created: boolean;
  location: string | null;
  moved: boolean;
} {
  const a = obj(raw);
  return {
    port: num(a.port),
    addresses: arr(a.addresses).filter((x): x is string => typeof x === 'string' && isPrivateIpv4(x)),
    created: a.created === true,
    location: str(a.location) || null,
    moved: a.moved === true,
  };
}

/**
 * The cleanup's body (hosts HS-251): the windows and the limit only when there are any. `windows`: the helper
 * reports them (`cleanup.keep`); one that doesn't knows only `keep_within_days` and ignores the rest, so it gets the
 * longest window there, never the days of every backup alone (2 by default), which would clear a year of backups.
 */
export const cleanupBody = (repositoryPassword: string, keep: PlaceKeep, windows = true) => ({
  repository_password: repositoryPassword,
  keep_within_days: windows ? keep.allDays : longestKeepDays(keep),
  ...(keepHasWindows(keep)
    ? {
        keep_daily_days: keep.dailyDays,
        keep_weekly_days: keep.weeklyWeeks * 7,
        keep_monthly_months: keep.monthlyMonths,
        limit_bytes: keep.limitBytes ?? 0,
      }
    : {}),
});

export const removeBody = (deleteData: boolean) => (deleteData ? { delete_data: true, confirm: true } : {});

export const nfsBody = (name: string, clients: readonly string[]) => ({ name, clients: [...clients] });

/** `backup-place/nfs`'s answer. */
export function nfsAnswer(raw: unknown): { export: string | null; addresses: string[] } {
  const a = obj(raw);
  return {
    export: str(a.export) || null,
    addresses: arr(a.addresses).filter((x): x is string => typeof x === 'string'),
  };
}

export const storageBody = (storage: string, server: string, exportPath: string) => ({
  storage,
  type: 'nfs',
  server,
  export: exportPath,
  content: ['backup'],
});
