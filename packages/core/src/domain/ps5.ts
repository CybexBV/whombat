import { z } from 'zod';

export const PS5_OFFICIAL_REPOSITORY = 'https://itsplk.github.io/ps5-payloads-mirror/payloads_v2.json';
export const PS5_WEBKIT_INSTALLER = 'webkit-autoloader-installer';
/** Payload Manager's own repository id: its update is a pending self-update, not a slot. */
export const PS5_MANAGER_ID = 'pldmgr';

/** A reviewed, immutable helper; it adds reboot without a PC bridge or Remote Play pairing. */
export const PS5_POWER_HELPER = {
  version: '1.0.0',
  url: 'https://raw.githubusercontent.com/StonedModder/PS5-SystemStateManager/414b905e285ec75ba91e48b7f908bbd6ea487ac9/SystemStateManager.elf',
  checksum: 'f5c25a2a33015113941c66410c8f24639b976e19847f66354c8f7a6bae1070b0',
  bytes: 119000,
  port: 9112,
  build: 'SystemStateManager shutdown_type2 rest_stmgr0 cdioceject 2026-05-25',
} as const;

export const Ps5RebootArgs = z.object({ expectedPid: z.number().int().positive() }).strict();
export const Ps5PowerReady = z.object({
  ready: z.literal(true),
  pid: z.number().int().positive(),
  build: z.literal(PS5_POWER_HELPER.build),
});
export const Ps5PowerStatus = z.discriminatedUnion('ready', [
  Ps5PowerReady,
  z.object({ ready: z.literal(false), message: z.string().max(400) }),
]);
export type Ps5PowerStatus = z.infer<typeof Ps5PowerStatus>;

/** Only the reviewed helper's complete STATUS reply identifies a power service. */
export function parsePs5PowerStatus(reply: string): z.infer<typeof Ps5PowerReady> | null {
  const match = /^OK pid=([1-9]\d{0,9}) build=([^\r\n]+)\r?\n$/.exec(reply);
  if (!match) return null;
  const result = Ps5PowerReady.safeParse({ ready: true, pid: Number(match[1]), build: match[2] });
  return result.success ? result.data : null;
}

export const Ps5Slot = z
  .string()
  .min(1)
  .max(180)
  .regex(/^(?:local|repo)\/(?!\.$)(?!.*\.\.)[a-zA-Z0-9_@.-]+$/);
export const Ps5Checksum = z.string().regex(/^[a-f0-9]{64}$/i);
const text = z.string().max(4096);
/** Long words from the service (release notes, a log) are cut rather than refused. */
const clipped = (n: number) => z.string().transform((s) => s.slice(0, n));
const count = z.number().int().nonnegative();

export const Ps5Payload = z.object({
  slot: Ps5Slot,
  filename: text,
  path: text.optional(),
  name: text.optional(),
  id: text.optional(),
  version: text.optional(),
  checksum: text.optional(),
  source_url: text.optional(),
  description: clipped(400).optional(),
});
export type Ps5Payload = z.infer<typeof Ps5Payload>;
export const Ps5Payloads = z.object({
  self: z.object({ running_version: text, pending_version: text.default('') }),
  items: z.array(Ps5Payload).max(4096),
});
export type Ps5Payloads = z.infer<typeof Ps5Payloads>;

export const Ps5Config = z.object({
  AUTOLOAD_ENABLED: z.boolean(),
  AUTOLOAD_LIST: text,
  AUTOLOAD_DELAY: z.number().int().min(0).max(300),
});
export type Ps5Config = z.infer<typeof Ps5Config>;
export const Ps5Processes = z.object({
  // Payload Manager reports memory in MiB.
  processes: z
    .array(z.object({ pid: count, name: text, memory: z.number().nonnegative(), is_daemon: z.boolean() }))
    .max(4096),
});
export type Ps5Processes = z.infer<typeof Ps5Processes>;
/** What Payload Manager launched since it started, newest first (it keeps 20). */
export const Ps5History = z.object({ history: z.array(text).max(64) });
export type Ps5History = z.infer<typeof Ps5History>;

export const Ps5ShadowVersion = z.object({
  status: z.literal(0),
  api_version: count,
  shadowmount_version: text,
  capabilities: z.array(text).max(256),
});
export const Ps5Game = z.object({
  title_id: text,
  title_name: text,
  version: text,
  platform: text,
  installed: z.boolean(),
  managed: z.boolean(),
  mounted: z.boolean(),
  source_available: z.boolean(),
  icon_url: text.optional(),
});
export type Ps5Game = z.infer<typeof Ps5Game>;
export const Ps5Games = z.object({ status: z.literal(0), count, games: z.array(Ps5Game).max(4096) });
export type Ps5Games = z.infer<typeof Ps5Games>;
export const Ps5Storage = z.object({
  status: z.literal(0),
  mounts: z
    .array(
      z.object({
        mount_point: text,
        source: text.optional(),
        mount_id: text.optional(),
        total_bytes: count,
        available_bytes: count,
        used_bytes: count,
        read_only: z.boolean(),
        ejectable: z.boolean(),
      }),
    )
    .max(256),
});
export type Ps5Storage = z.infer<typeof Ps5Storage>;
/** One game in full, as ShadowMountPlus measures it (sizes in bytes; a size whose status isn't 0 wasn't measured). */
export const Ps5GameInfo = z.object({
  status: z.literal(0),
  title_id: text,
  title_name: text,
  version: text,
  platform: text.optional(),
  path: text.optional(),
  source_type: text.optional(),
  installed: z.boolean().optional(),
  mounted: z.boolean().optional(),
  source_available: z.boolean().optional(),
  last_access_time: text.optional(),
  size_status: z.number().int().optional(),
  size_bytes: count.optional(),
  save_data_size_status: z.number().int().optional(),
  save_data_size_bytes: count.optional(),
  patch: z.object({ installed: z.boolean(), version: text, size_bytes: count }).optional(),
  dlc: z
    .array(z.object({ content_id: text.optional(), name: text.optional() }).passthrough())
    .max(256)
    .optional(),
});
export type Ps5GameInfo = z.infer<typeof Ps5GameInfo>;
/** ShadowMountPlus's one background job (a copy, a move, an eject). */
export const Ps5StorageJob = z.object({
  status: z.literal(0),
  job_id: count,
  operation: text,
  state: text,
  active: z.boolean(),
  error: text.optional(),
});
export const Ps5ShadowLog = z.object({
  status: z.literal(0),
  content: clipped(262_144),
  truncated: z.boolean().optional(),
});

export const Ps5Release = z.object({
  id: text,
  name: text,
  filename: text,
  version: text,
  checksum: text.default(''),
  description: clipped(400).default(''),
  release_notes: clipped(1500).optional(),
});
export type Ps5Release = z.infer<typeof Ps5Release>;
export const Ps5Repository = z.object({
  sources: z
    .array(
      z.object({
        url: text,
        name: text,
        error: z.boolean().default(false),
        payloads: z.array(Ps5Release).max(4096),
      }),
    )
    .max(32),
});
export type Ps5Repository = z.infer<typeof Ps5Repository>;
export const Ps5Logs = z.object({ logs: z.array(text).max(10000) });

export const Ps5NoArgs = z.object({}).strict();
export const Ps5LogArgs = z.object({ lines: z.number().int().min(1).max(200).default(50) }).strict();
export const Ps5RunArgs = z.object({ slot: Ps5Slot }).strict();
const repoId = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/);
export const Ps5InstallArgs = z
  .object({ id: repoId, version: z.string().min(1).max(80), checksum: Ps5Checksum })
  .strict();
export const Ps5WebkitArgs = Ps5InstallArgs.omit({ id: true });
/** Replace an installed payload with the approved Official Repository release; startup follows it. */
export const Ps5UpdateArgs = Ps5InstallArgs.extend({ slot: Ps5Slot }).strict();
export const Ps5AutoloadArgs = z
  .object({
    enabled: z.boolean(),
    entries: z
      .array(
        z.union([
          z.object({ slot: Ps5Slot }).strict(),
          z.object({ delayMs: z.number().int().min(1).max(60000) }).strict(),
        ]),
      )
      .max(32),
    delaySeconds: z.number().int().min(0).max(60),
    expectedConfig: Ps5Config,
  })
  .strict();
/** A PS5 or PS4 title id: four letters and five digits. */
export const Ps5TitleId = z.string().regex(/^[A-Z]{4}\d{5}$/);
export const Ps5GameArgs = z.object({ titleId: Ps5TitleId }).strict();
/** The USB drives ShadowMountPlus can eject: never internal storage or the M.2 drive. */
export const Ps5EjectArgs = z.object({ mountPoint: z.string().regex(/^\/mnt\/(?:usb[0-7]|ext0)$/) }).strict();
export const Ps5StopArgs = z
  .object({ pid: z.number().int().positive(), name: z.string().min(1).max(160) })
  .strict();
export const Ps5ShadowLogArgs = z
  .object({
    log: z.enum(['debug', 'kernel']).default('debug'),
    kilobytes: z.number().int().min(4).max(256).default(16),
  })
  .strict();

export function ps5AutoloadList(input: z.infer<typeof Ps5AutoloadArgs>): string {
  return input.entries.map((e) => ('slot' in e ? e.slot : `!${e.delayMs}`)).join(',');
}

/** The processes a payload can't be stopped from: the loader, the jailbreak's kernel part and the manager itself. */
export const PS5_KEEP_RUNNING = ['pldmgr.elf', 'elfldr.elf', 'kstuff.elf'] as const;

/* Versions -------------------------------------------------------------------------------------------------------- */

/**
 * The name and version a payload's file carries (`kstuff-lite_v1.10.elf` → kstuff-lite, v1.10), as the Official
 * Repository names its files; null when the file name carries none. A payload uploaded by hand has no other version.
 */
export function ps5FileVersion(filename: string): { name: string; version: string } | null {
  const m = /^(.+)_(v?\d[\w.+-]*)\.(?:elf|bin)$/i.exec(filename.split('/').pop() ?? '');
  return m?.[1] && m[2] ? { name: m[1], version: m[2] } : null;
}

const PRE_RELEASE = ['alpha', 'beta', 'pre', 'rc'];

/**
 * Which of two homebrew versions is newer: above 0 when `a` is, below 0 when `b` is, 0 when they're the same; null when
 * either has no number. A leading `v` is ignored, and a pre-release (`1.7beta11`, `v1.13-rc2`) comes before its release.
 */
export function ps5VersionOrder(a: string, b: string): number | null {
  const parts = (v: string) =>
    v
      .replace(/^v/i, '')
      .toLowerCase()
      .match(/\d+|[a-z]+/g) ?? [];
  const x = parts(a);
  const y = parts(b);
  if (!x.some((p) => /\d/.test(p)) || !y.some((p) => /\d/.test(p))) return null;
  const rank = (p: string) => {
    const i = PRE_RELEASE.indexOf(p);
    return i < 0 ? PRE_RELEASE.length : i;
  };
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    // A version that stops where the other goes on to a pre-release is the release; to a number, the older one.
    if (p === undefined) return q !== undefined && /^\d/.test(q) ? -1 : 1;
    if (q === undefined) return /^\d/.test(p) ? 1 : -1;
    const pn = /^\d/.test(p);
    const qn = /^\d/.test(q);
    if (pn && qn) return Number(p) - Number(q) || 0;
    if (pn !== qn) return pn ? 1 : -1;
    return rank(p) - rank(q) || (p < q ? -1 : 1);
  }
  return 0;
}

/* Firmware and the console's own discovery ------------------------------------------------------------------------ */

/** Sony's discovery port: a PS5 answers on it while awake or resting, without pairing. */
export const PS5_DISCOVERY_PORT = 9302;
/** The search a phone or Remote Play client sends. It asks only who is there. */
export const PS5_DISCOVERY_REQUEST = 'SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n';

/** What the console said about itself. */
export interface Ps5Console {
  state: 'awake' | 'resting';
  name: string | null;
  /** “10.01”, from its system version. */
  firmware: string | null;
}

/** Firmware as people write it (“10.01”) from the system version a PS5 reports (`10010000`); null for anything else. */
export function ps5Firmware(systemVersion: string): string | null {
  const m = /^(\d{2})(\d{2})\d{4}$/.exec(systemVersion.trim());
  return m?.[1] && m[2] ? `${Number(m[1])}.${m[2]}` : null;
}

/** A PS5's discovery answer, or null when it isn't one (another console, garbage). */
export function parsePs5Discovery(answer: string): Ps5Console | null {
  const [status, ...rest] = answer.split(/\r?\n/);
  const state = /^HTTP\/1\.1 200\b/.test(status ?? '')
    ? 'awake'
    : /^HTTP\/1\.1 620\b/.test(status ?? '')
      ? 'resting'
      : null;
  if (!state) return null;
  const fields = new Map<string, string>();
  for (const line of rest) {
    const i = line.indexOf(':');
    if (i > 0) fields.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  if (fields.get('host-type')?.toUpperCase() !== 'PS5') return null;
  const name = fields.get('host-name')?.slice(0, 80) || null;
  const version = fields.get('system-version');
  return { state, name, firmware: version ? ps5Firmware(version) : null };
}

/** The firmware range a release's words give (“Installs … (FW 7.00-13.60)”), or null. */
export function ps5FirmwareRange(words: string): { from: string; to: string } | null {
  const m = /\bFW\s*(\d{1,2}\.\d{2})\s*[-–—]\s*(\d{1,2}\.\d{2})\b/i.exec(words);
  return m?.[1] && m[2] ? { from: m[1], to: m[2] } : null;
}

/** Whether firmware lies in a range; null when either isn't known. */
export function ps5FirmwareFits(
  firmware: string | null,
  range: { from: string; to: string } | null,
): boolean | null {
  if (!firmware || !range) return null;
  const n = (v: string) => {
    const [a, b] = v.split('.');
    return Number(a) * 100 + Number(b);
  };
  return n(firmware) >= n(range.from) && n(firmware) <= n(range.to);
}

/* Updates --------------------------------------------------------------------------------------------------------- */

/** One installed payload against the Official Repository. */
export interface Ps5UpdateLine {
  slot: string;
  name: string;
  /** The version it reports, or the one its file name carries; null when neither says. */
  installed: string | null;
  /** Downloaded from the Official Repository, or uploaded by hand (a `local/` slot). */
  source: 'repository' | 'uploaded';
  /** The Official Repository's release of the same payload, or null when it has none. */
  available: { id: string; version: string; checksum: string } | null;
  /** The release is newer than what is installed. */
  newer: boolean;
  /** The slot is in homebrew startup. */
  startup: boolean;
  /** The firmware range the release names, and whether this console's firmware is in it (null: not known). */
  firmware: { from: string; to: string } | null;
  fits: boolean | null;
  /** The release's notes, only for a newer release (for firmware support), cut short. */
  notes?: string;
}

/** The Official Repository's release for an installed payload: the same id, or for one uploaded by hand its name. */
export function ps5ReleaseFor(item: Ps5Payload, releases: readonly Ps5Release[]): Ps5Release | null {
  const keys = new Set<string>();
  if (item.id) keys.add(item.id.toLowerCase());
  else {
    keys.add(item.slot.replace(/^local\//, '').toLowerCase());
    const file = ps5FileVersion(item.filename);
    if (file) keys.add(file.name.toLowerCase());
  }
  const found = releases.filter((r) => keys.has(r.id.toLowerCase()));
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** Each installed payload against the Official Repository's releases (installers included: their release is newer). */
export function ps5Updates(
  payloads: Ps5Payloads,
  releases: readonly Ps5Release[],
  startupList: string,
  firmware: string | null,
): Ps5UpdateLine[] {
  const startup = new Set(startupList.split(',').filter(Boolean));
  return payloads.items.map((item) => {
    const uploaded = !item.id || item.source_url !== PS5_OFFICIAL_REPOSITORY;
    const release = ps5ReleaseFor(item, releases);
    const installed = item.version || ps5FileVersion(item.filename)?.version || null;
    const newer = !!(release && installed && (ps5VersionOrder(release.version, installed) ?? 0) > 0);
    const range = release ? ps5FirmwareRange(`${release.description} ${release.release_notes ?? ''}`) : null;
    return {
      slot: item.slot,
      name: item.name || ps5FileVersion(item.filename)?.name || item.filename,
      installed,
      source: uploaded ? 'uploaded' : 'repository',
      available: release ? { id: release.id, version: release.version, checksum: release.checksum } : null,
      newer,
      startup: startup.has(item.slot),
      firmware: range,
      fits: ps5FirmwareFits(firmware, range),
      ...(newer && release?.release_notes ? { notes: release.release_notes } : {}),
    };
  });
}

/**
 * Payload Manager's own update as one more line (its `slot` is its repository id): it isn't in its payload list, and
 * a version it already downloaded and waits to restart into isn't newer.
 */
export function ps5ManagerUpdate(
  self: Ps5Payloads['self'],
  releases: readonly Ps5Release[],
  firmware: string | null,
): Ps5UpdateLine | null {
  const found = releases.filter((r) => r.id === PS5_MANAGER_ID);
  const release = found.length === 1 ? found[0] : undefined;
  if (!release || !self.running_version) return null;
  const pending = self.pending_version && ps5VersionOrder(release.version, self.pending_version) === 0;
  const newer = !pending && (ps5VersionOrder(release.version, self.running_version) ?? 0) > 0;
  const range = ps5FirmwareRange(`${release.description} ${release.release_notes ?? ''}`);
  return {
    slot: PS5_MANAGER_ID,
    name: 'Payload Manager',
    installed: self.running_version,
    source: 'repository',
    available: { id: release.id, version: release.version, checksum: release.checksum },
    newer,
    startup: false,
    firmware: range,
    fits: ps5FirmwareFits(firmware, range),
    ...(newer && release.release_notes ? { notes: release.release_notes } : {}),
  };
}

/** Every update the console can take: its payloads, then Payload Manager itself. */
export function ps5AllUpdates(
  payloads: Ps5Payloads,
  releases: readonly Ps5Release[],
  startupList: string,
  firmware: string | null,
): Ps5UpdateLine[] {
  const manager = ps5ManagerUpdate(payloads.self, releases, firmware);
  return [...ps5Updates(payloads, releases, startupList, firmware), ...(manager ? [manager] : [])];
}

/* Startup ---------------------------------------------------------------------------------------------------------- */

/** How the last homebrew startup went, from Payload Manager's log since it started. */
export interface Ps5StartupRun {
  /** `running`: still starting; `done`: every entry tried; `stopped`: aborted on the PS5; `failed`: it couldn't start. */
  state: 'running' | 'done' | 'stopped' | 'failed';
  entries: { slot: string; outcome: 'started' | 'failed' | 'skipped' }[];
}

/** A launched file's slot (`/data/pldmgr/payloads/local/kstuff-lite/kstuff-lite_v1.10.elf` → `local/kstuff-lite`). */
export function ps5SlotOfPath(path: string): string {
  const m = /\/payloads\/((?:local|repo)\/[^/]+)\//.exec(path);
  return m?.[1] ?? path.split('/').pop() ?? path;
}

/**
 * The last startup in Payload Manager's log, or null when the log doesn't show one (startup off, or older lines gone:
 * it keeps 100). A loader transfer that failed, and a payload it calls missing, failed or cancelled, both count as
 * failed.
 */
export function ps5StartupRun(logs: readonly string[]): Ps5StartupRun | null {
  let begin = -1;
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i] ?? '';
    if (/\[Autoload\] (?:Starting sequence|ABORTED via PS Button|Invalid or unreadable sequence)/.test(l)) {
      begin = i;
      break;
    }
  }
  if (begin < 0) return null;
  const head = logs[begin] ?? '';
  if (/ABORTED via PS Button/.test(head)) return { state: 'stopped', entries: [] };
  if (/Invalid or unreadable sequence/.test(head)) return { state: 'failed', entries: [] };
  const outcomes = new Map<string, 'started' | 'failed' | 'skipped'>();
  let current: string | null = null;
  let state: Ps5StartupRun['state'] = 'running';
  for (const l of logs.slice(begin + 1)) {
    const launching = /\[Autoload\] Launching: (.+)$/.exec(l);
    if (launching?.[1]) {
      current = ps5SlotOfPath(launching[1].trim());
      continue;
    }
    if (current && /Loader transfer complete/.test(l)) {
      if (outcomes.get(current) !== 'failed') outcomes.set(current, 'started');
      current = null;
    } else if (current && /Loader (?:transfer failed|connection failed)/.test(l)) {
      outcomes.set(current, 'failed');
      current = null;
    }
    const failed = /\[Autoload\] Missing, failed or cancelled payload: (.+)$/.exec(l);
    if (failed?.[1]) outcomes.set(failed[1].trim(), 'failed');
    const self = /\[Autoload\] Skipping self: (.+)$/.exec(l);
    if (self?.[1]) outcomes.set(self[1].trim(), 'skipped');
    if (/\[Autoload\] Sequence complete\./.test(l)) state = 'done';
    if (/\[Autoload\] Sequence aborted\./.test(l)) state = 'stopped';
  }
  return { state, entries: [...outcomes].map(([slot, outcome]) => ({ slot, outcome })) };
}
