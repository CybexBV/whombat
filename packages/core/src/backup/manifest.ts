/**
 * The backup file's body (contracts 0.79, CT-335): a POSIX ustar archive whose entries come in this order —
 *
 * 1. `manifest.json` — `BackupFileManifest` (format id, when, which Whombat, which burrow, who made it, categories);
 * 2. `directory.jsonl` — `BackupDirectoryEntry` lines: every id the records refer to, with its portable key;
 * 3. `<category>.jsonl` for each category in the file, in `BACKUP_CATEGORY_IDS` order — that category's record lines;
 * 4. the bytes records point to, in any order: `files/<sha256>` (attachments, Files, pack files; each blob once),
 *    `canvases/<canvas id>.yjs` (a canvas's Yjs state), `repositories/<name>.bundle` (a git bundle), and since 0.117
 *    (CT-903) `servers/hub.tar.gz` (the hosts service's own backup as it gave it, once; the `servers_hub` record).
 *
 * So a reader that only previews (`backups.inspect`) stops after the last `.jsonl`; a reader refuses a body whose first
 * entry isn't the manifest, an entry name it doesn't know, or a second entry of the same name (`damaged`). Every
 * entry's mtime is the manifest's `createdAt`.
 */
import { z } from 'zod';
import { Count, Email, Sha256Hex, Timestamp } from '../domain/common.js';
import { BurrowId } from '../ids.js';
import { DOT } from '../text/format.js';
import { dayKey, formatDate } from '../text/time.js';
import { utf8Decode } from './bytes.js';
import { BACKUP_CATEGORY_IDS, BackupCategoryId } from './categories.js';
import { BackupFileError } from './errors.js';
import { BackupNote } from './notes.js';
import { BACKUP_RECORD_MAX_BYTES, BACKUP_SCHEMA_VERSION, BackupRepositoryName } from './records.js';

/** The body's format id (the manifest's `format`). */
export const BACKUP_FORMAT = 'whombat.backup-file/1';
/** The format family: `whombat.backup-file/<n>`; a higher `n` is `newer_format`. */
export const BACKUP_FORMAT_PREFIX = 'whombat.backup-file/';
export const BACKUP_FORMAT_VERSION = 1;
/** The file's extension and its download type. */
export const BACKUP_FILE_EXTENSION = '.wbk';
export const BACKUP_FILE_CONTENT_TYPE = 'application/vnd.whombat.backup';
/** Largest backup file, bytes (the session's upload ceiling, `UPLOAD_MAX_FILE_BYTES`: 10 GiB). */
export const BACKUP_FILE_MAX_BYTES = 10_737_418_240;
/** Largest `manifest.json`. */
export const BACKUP_MANIFEST_MAX_BYTES = 1_048_576;

/** One category as the manifest lists it: how many things (`BACKUP_COUNTED_TYPES`), its records' and blobs' bytes. */
export const BackupManifestCategory = z.object({
  id: BackupCategoryId,
  count: Count,
  /** Bytes of its `.jsonl` and of the blobs only it brought in. */
  bytes: Count,
});
export type BackupManifestCategory = z.infer<typeof BackupManifestCategory>;

/**
 * `manifest.json`. `format` and `schemaVersion` are checked first (`checkBackupManifestVersion`): an unknown format
 * family is `damaged`, a higher format or schema version `newer_format`.
 */
export const BackupFileManifest = z.object({
  format: z.literal(BACKUP_FORMAT),
  schemaVersion: z.number().int().min(1),
  createdAt: Timestamp,
  /** The source burrow's time zone (the file name's date and “Made 11 Oct 2026”). */
  timeZone: z.string().min(1).max(64),
  /** The Whombat that made it (`0.83.1`; the server's version). */
  whombatVersion: z.string().min(1).max(64),
  source: z.object({
    burrowId: BurrowId,
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(63),
  }),
  madeBy: z.object({ name: z.string().min(1).max(200), email: Email }),
  /** The categories in the file, in order. */
  categories: z.array(BackupManifestCategory).min(1).max(BACKUP_CATEGORY_IDS.length),
  /** Sign-ins are inside (connections, Vault or servers, BF-06, BF-13). */
  includesSecrets: z.boolean(),
  /**
   * What making the file had to leave out (0.117, CT-905; BF-19): `sign_in_left_out` (sign-ins that couldn't be read),
   * `files_left_out` (messages' files without Files). The restore preview shows them. Absent from older files.
   */
  notes: z.array(BackupNote).max(20).default([]),
});
export type BackupFileManifest = z.infer<typeof BackupFileManifest>;

/**
 * Checks a parsed `manifest.json` value's version before its schema: `newer_format` for a higher format version or
 * schema version than this code reads, `damaged` for anything that isn't a backup-file manifest; returns the parsed
 * manifest otherwise (unknown members stripped).
 */
export function parseBackupFileManifest(value: unknown): BackupFileManifest {
  if (typeof value !== 'object' || value === null) throw new BackupFileError('damaged', 'manifest');
  const v = value as { format?: unknown; schemaVersion?: unknown };
  if (typeof v.format !== 'string' || !v.format.startsWith(BACKUP_FORMAT_PREFIX))
    throw new BackupFileError('damaged', 'manifest format');
  const n = Number(v.format.slice(BACKUP_FORMAT_PREFIX.length));
  if (!Number.isInteger(n) || n < 1) throw new BackupFileError('damaged', 'manifest format');
  if (n > BACKUP_FORMAT_VERSION) throw new BackupFileError('newer_format', v.format);
  if (typeof v.schemaVersion === 'number' && v.schemaVersion > BACKUP_SCHEMA_VERSION)
    throw new BackupFileError('newer_format', `schema ${v.schemaVersion}`);
  const r = BackupFileManifest.safeParse(value);
  if (!r.success) throw new BackupFileError('damaged', r.error.issues[0]?.message ?? 'manifest');
  return r.data;
}

/** Parses the bytes of `manifest.json`. */
export function decodeBackupFileManifest(bytes: Uint8Array): BackupFileManifest {
  if (bytes.length > BACKUP_MANIFEST_MAX_BYTES) throw new BackupFileError('damaged', 'manifest too large');
  const text = utf8Decode(bytes);
  if (text === null) throw new BackupFileError('damaged', 'manifest utf-8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BackupFileError('damaged', 'manifest json');
  }
  return parseBackupFileManifest(value);
}

/** Entry names inside the body. */
export const backupEntryName = {
  manifest: 'manifest.json',
  directory: 'directory.jsonl',
  records: (category: BackupCategoryId) => `${category}.jsonl`,
  blob: (sha256: string) => `files/${sha256}`,
  canvas: (canvasId: string) => `canvases/${canvasId}.yjs`,
  repository: (name: string) => `repositories/${name}.bundle`,
  /** The hosts service's own backup (0.117, CT-903; BF-13), a `.tar.gz` as the service gave it. */
  hostsBackup: 'servers/hub.tar.gz',
} as const;

export type BackupEntryKind =
  | { kind: 'manifest' }
  | { kind: 'directory' }
  | { kind: 'records'; category: BackupCategoryId }
  | { kind: 'blob'; sha256: string }
  | { kind: 'canvas'; canvasId: string }
  | { kind: 'repository'; name: string }
  | { kind: 'hosts_backup' };

/** What an entry name is, or null for a name a backup file never holds. */
export function classifyBackupEntry(name: string): BackupEntryKind | null {
  if (name === backupEntryName.manifest) return { kind: 'manifest' };
  if (name === backupEntryName.directory) return { kind: 'directory' };
  if (name === backupEntryName.hostsBackup) return { kind: 'hosts_backup' };
  const records = /^([a-z]+)\.jsonl$/.exec(name);
  if (records) {
    const c = BackupCategoryId.safeParse(records[1]);
    return c.success ? { kind: 'records', category: c.data } : null;
  }
  const blob = /^files\/([0-9a-f]{64})$/.exec(name);
  if (blob && Sha256Hex.safeParse(blob[1]).success) return { kind: 'blob', sha256: blob[1] as string };
  const canvas = /^canvases\/(cvs_[A-Za-z0-9_-]{1,64})\.yjs$/.exec(name);
  if (canvas) return { kind: 'canvas', canvasId: canvas[1] as string };
  const repo = /^repositories\/(.+)\.bundle$/.exec(name);
  if (repo && BackupRepositoryName.safeParse(repo[1]).success)
    return { kind: 'repository', name: repo[1] as string };
  return null;
}

/**
 * Checks the order rule as entries go by: call `next(name)` per entry; throws `damaged` for a body that doesn't start
 * with the manifest and the directory, a record file out of category order or twice, an unknown name, or a blob before
 * the record files are done.
 */
export class BackupEntryOrder {
  private seen = new Set<string>();
  private stage = 0;
  private lastCategory = -1;

  next(name: string): BackupEntryKind {
    const kind = classifyBackupEntry(name);
    if (!kind) throw new BackupFileError('damaged', `unknown entry ${name}`);
    if (this.seen.has(name)) throw new BackupFileError('damaged', `entry twice ${name}`);
    this.seen.add(name);
    if (kind.kind === 'manifest') {
      if (this.stage !== 0) throw new BackupFileError('damaged', 'manifest not first');
      this.stage = 1;
    } else if (kind.kind === 'directory') {
      if (this.stage !== 1) throw new BackupFileError('damaged', 'directory not second');
      this.stage = 2;
    } else if (kind.kind === 'records') {
      const at = BACKUP_CATEGORY_IDS.indexOf(kind.category);
      if (this.stage !== 2 || at <= this.lastCategory)
        throw new BackupFileError('damaged', `records out of order ${name}`);
      this.lastCategory = at;
    } else {
      if (this.stage < 2) throw new BackupFileError('damaged', `bytes before the records ${name}`);
      this.stage = 3;
    }
    return kind;
  }

  /** Whether the record files are behind (a preview can stop reading). */
  get pastRecords(): boolean {
    return this.stage === 3;
  }
}

/**
 * Splits a `.jsonl` entry's bytes into parsed JSON values, incrementally. Throws `damaged` for invalid UTF-8 or JSON and
 * `too_large` for a line longer than `BACKUP_RECORD_MAX_BYTES`. Empty lines are skipped.
 */
export class BackupJsonlReader {
  private parts: Uint8Array[] = [];
  private partBytes = 0;

  private line(bytes: Uint8Array, out: unknown[]) {
    if (bytes.length === 0) return;
    const text = utf8Decode(bytes);
    if (text === null) throw new BackupFileError('damaged', 'record utf-8');
    if (!text.trim()) return;
    try {
      out.push(JSON.parse(text));
    } catch {
      throw new BackupFileError('damaged', 'record json');
    }
  }

  private take(tail: Uint8Array): Uint8Array {
    if (this.parts.length === 0) return tail;
    const all = new Uint8Array(this.partBytes + tail.length);
    let at = 0;
    for (const p of this.parts) {
      all.set(p, at);
      at += p.length;
    }
    all.set(tail, at);
    this.parts = [];
    this.partBytes = 0;
    return all;
  }

  push(data: Uint8Array): unknown[] {
    const out: unknown[] = [];
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0x0a) continue;
      const piece = data.subarray(start, i);
      if (this.partBytes + piece.length > BACKUP_RECORD_MAX_BYTES)
        throw new BackupFileError('too_large', 'record line');
      this.line(this.take(piece), out);
      start = i + 1;
    }
    if (start < data.length) {
      const rest = data.subarray(start);
      this.partBytes += rest.length;
      if (this.partBytes > BACKUP_RECORD_MAX_BYTES) throw new BackupFileError('too_large', 'record line');
      this.parts.push(rest.slice());
    }
    return out;
  }

  /** The last line when the entry doesn't end with `\n`. */
  finish(): unknown[] {
    const out: unknown[] = [];
    this.line(this.take(new Uint8Array(0)), out);
    return out;
  }
}

/** A file name for the slug: lowercase letters, digits and dashes (`backup` when nothing is left). */
function fileSlug(slug: string): string {
  const s = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
  return s || 'backup';
}

/** `lumio-bv-2026-10-11.wbk`: the burrow's slug and the day it was made in the burrow's time zone. */
export function backupFileName(slug: string, createdAt: string, timeZone: string): string {
  return `${fileSlug(slug)}-${dayKey(createdAt, timeZone)}${BACKUP_FILE_EXTENSION}`;
}

/** `0.83` from `0.83.1` (the restore card shows major and minor). */
export function shortWhombatVersion(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : version;
}

/** “Made 11 Oct 2026 on Lumio BV · Whombat 0.83” (the restore panel's file card). */
export function backupMadeText(
  m: Pick<BackupFileManifest, 'createdAt' | 'timeZone' | 'whombatVersion' | 'source'>,
): string {
  return `Made ${formatDate(m.createdAt, m.timeZone, { year: 'always' })} on ${m.source.name} ${DOT} Whombat ${shortWhombatVersion(m.whombatVersion)}`;
}
