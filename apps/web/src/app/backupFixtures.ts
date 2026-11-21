/**
 * Backup files in fixture mode (contracts 0.79.0, CT-335; app docs/decisions/backup-file.md AP-1205): `api.backups` and
 * the raw transfers answered like a Whombat would, for Mara (whose Whombat it is), shared by fixture mode (REST) and the fake
 * managed world (its download and upload streams). The files are real: a made file is an encrypted backup file
 * (`@whombat/core/backup`, a light key derivation so the browser makes it at once) holding a manifest and some filler, so
 * downloading it and uploading it again opens with its password — a wrong one says so — and the preview counts what its
 * manifest says, split like the sketch (some already here, some different). Making a file and restoring take a few
 * seconds of progress by the clock. Seeded (`VITE_FIXTURE_BACKUPS=1`, option `backups`): a file made an hour ago,
 * ready, and a restore half an hour ago that needs Mara (Fusebox to sign in again, nine automations off,
 * blackbox to point here by hand). Since 0.117 the servers are offered and a file's servers ask the address question
 * (AP-4419).
 */

import { sha256Hex } from '@whombat/core/audit';
import {
  BACKUP_DEFAULT_CATEGORIES,
  BACKUP_FILE_CONTENT_TYPE,
  BACKUP_FILE_MAX_BYTES,
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  type BackupCategoryId,
  BackupFileEncoder,
  BackupFileError,
  type BackupFileManifest,
  BackupFileReader,
  type BackupOnDifferent,
  type BackupRestorePreview,
  type BackupRestoreSummary,
  backupAppErrorCode,
  backupFileErrorText,
  backupFileName,
  backupIncludesSecrets,
  backupPasswordOk,
  createBackupFileKeys,
  decodeBackupFileManifest,
  isBackupFileError,
  sortBackupCategories,
  TarReader,
  TarWriter,
} from '@whombat/core/backup';
import {
  BACKUP_UPLOAD_CHUNK_BYTES,
  BACKUP_UPLOAD_CHUNK_MAX_BYTES,
  type BackupDefaults,
  type BackupEstimate,
  type BackupFileView,
  type BackupRestoreView,
  type BackupUploadView,
  backupDownloadUrl,
  backupUploadUrl,
  parseBackupContentRange,
} from '@whombat/core/contracts';
import { burrow, mara } from '@whombat/fixtures';

const API = '/api/v1';
const TZ = 'Europe/Amsterdam';
/** The fixture files' password (the seeded file opens with it). */
export const FIXTURE_BACKUP_PASSWORD = 'correct horse battery';
/** Seconds a file takes to make, and a restore to run. */
const MAKE_S = 4;
const RESTORE_S = 4;
/** A made file holds at most this much filler (the estimate's bytes otherwise; a fixture never makes gigabytes). */
const FILLER_MAX = 2_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * What each category holds here: the sketch's numbers (mock-dark.png), no repositories, and since 0.117 the five servers
 * this Whombat watches (BF-13; AP-4419).
 */
const ESTIMATE: BackupEstimate['categories'] = (
  [
    { id: 'agents', count: 5, bytes: 12_000 },
    { id: 'memories', count: 142, bytes: 640_000 },
    { id: 'automations', count: 9, bytes: 48_000 },
    { id: 'connections', count: 14, bytes: 20_000 },
    { id: 'skills', count: 23, bytes: 1_100_000 },
    { id: 'settings', count: 6, bytes: 9_000 },
    { id: 'vault', count: 8, bytes: 4_000 },
    { id: 'messages', count: 18_402, bytes: 120_000_000 },
    { id: 'servers', count: 5, bytes: 2_400_000 },
    { id: 'files', count: 312, bytes: 1_400_000_000 },
    { id: 'repositories', count: 0, bytes: 0 },
  ] as const
).map((c) => ({ ...c, offered: true }));

/**
 * The servers' part of a fixture restore (BF-14, BF-15; AP-4419): the file's Whombat was at another address, so the
 * preview asks; Point them here points all but blackbox, whose address has no key in Mara's Vault.
 */
const SERVERS_ADDRESS = { from: '10.100.1.160', to: '10.100.1.158' };
const SERVER_WITHOUT_KEY = { id: 'blackbox', name: 'blackbox', address: '10.100.1.31' };

interface FileRecord {
  view: BackupFileView;
  /** The password it is made with (only until it is made). */
  password: string | null;
  bytes: Uint8Array | null;
  /** When making started (ms). */
  started: number;
}

interface UploadRecord {
  view: BackupUploadView;
  parts: Uint8Array[];
}

interface RestoreRecord {
  view: BackupRestoreView;
  started: number;
  /** What it will bring back when it is done. */
  result: BackupRestoreSummary;
}

export interface BackupWorld {
  /** `api.backups` and the raw transfers; null for any other request. */
  handle(req: Request): Promise<Response | null>;
  /** A ready file's bytes for the fake managed world's `download` stream; null when it isn't there. */
  resource(backupFileId: string): Promise<{ name: string; bytes: Uint8Array } | null>;
  /** The fake managed world's `upload` stream delivered every byte of a staged file. */
  completeUpload(
    stagedBackupId: string,
    bytes: Uint8Array,
  ): { stagedBackupId: string; size: number; sha256: string } | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ERROR_STATUS: Partial<Record<BackupFileError['code'], number>> = {
  password_too_short: 422,
  wrong_password: 422,
  damaged: 400,
  newer_format: 400,
  not_backup_file: 400,
  too_large: 413,
  no_room: 507,
  expired: 410,
  upload_expired: 410,
  upload_incomplete: 409,
  upload_mismatch: 409,
  nothing_chosen: 422,
  not_in_file: 422,
  busy: 409,
  restore_running: 409,
  too_many: 409,
  people_only: 403,
};

/** A refusal as the server answers it: the sentence, and `details.code` = `backup_file.<code>`. */
function refusal(code: BackupFileError['code'], extra: Record<string, unknown> = {}): Response {
  const status = ERROR_STATUS[code] ?? 400;
  const apiCode =
    status === 422
      ? 'validation_failed'
      : status === 409
        ? 'conflict'
        : status === 403
          ? 'forbidden'
          : status === 410
            ? 'gone'
            : status === 413
              ? 'payload_too_large'
              : 'bad_request';
  return json(
    {
      error: {
        code: apiCode,
        message: backupFileErrorText(code),
        details: { code: backupAppErrorCode(code), ...extra },
      },
    },
    status,
  );
}

let counter = 0;
const newId = (prefix: string) => `${prefix}_fx${(Date.now() + counter++).toString(36)}`;
const iso = (ms: number) => new Date(ms).toISOString();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** An encrypted backup file holding `manifest.json` and filler, with a light key derivation. */
async function makeBackupBytes(
  manifest: BackupFileManifest,
  password: string,
  filler: number,
): Promise<Uint8Array> {
  const keys = await createBackupFileKeys(password, {
    params: { memoryKiB: 256, passes: 1, parallelism: 1 },
  });
  const encoder = new BackupFileEncoder(keys);
  const tar = new TarWriter();
  const out: Uint8Array[] = [];
  out.push(...encoder.push(tar.file('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))));
  if (filler > 0) {
    const blob = new Uint8Array(filler).map((_, i) => (i * 31 + 7) % 251);
    out.push(...encoder.push(tar.file(`files/${sha256Hex(blob)}`, blob)));
  }
  out.push(...encoder.push(tar.finish()));
  out.push(...encoder.finish());
  return concat(out);
}

/** Opens an uploaded file with its password and reads its manifest (the whole file is read, as the server does). */
async function readManifest(bytes: Uint8Array, password: string): Promise<BackupFileManifest> {
  const reader = new BackupFileReader();
  const plain: Uint8Array[] = [...reader.push(bytes)];
  if (!reader.header) throw new BackupFileError('damaged', 'no header');
  plain.push(...(await reader.unlock(password)));
  plain.push(...reader.finish());
  const tar = new TarReader();
  const manifest: Uint8Array[] = [];
  let found = false;
  let current: string | null = null;
  for (const piece of plain)
    for (const e of tar.push(piece)) {
      if (e.type === 'entry') {
        current = e.entry.name;
        found ||= current === 'manifest.json';
      } else if (e.type === 'data' && current === 'manifest.json') manifest.push(e.data.slice());
      else if (e.type === 'end') current = null;
    }
  tar.finish();
  if (!found) throw new BackupFileError('damaged', 'no manifest');
  return decodeBackupFileManifest(concat(manifest));
}

/** The preview a fixture Whombat answers: the manifest's counts, split like the sketch. */
function previewOf(fileName: string, size: number, manifest: BackupFileManifest): BackupRestorePreview {
  const categories = sortBackupCategories(manifest.categories.map((c) => c.id)).map((id) => {
    const count = manifest.categories.find((c) => c.id === id)?.count ?? 0;
    const split = (here: number, different: number) => {
      const h = Math.min(here, count);
      const d = Math.min(different, count - h);
      return { new: count - h - d, here: h, different: d };
    };
    const parts =
      id === 'agents'
        ? split(Math.max(0, count - 1), 0)
        : id === 'memories'
          ? split(12, 3)
          : id === 'settings'
            ? split(Math.max(0, count - 2), 0)
            : split(0, 0);
    return { id, count, ...parts, notes: [] };
  });
  const servers = categories.find((c) => c.id === 'servers');
  return {
    fileName,
    size,
    manifest,
    sameBurrow: manifest.source.slug === burrow.slug,
    categories,
    notes: [],
    servers: servers
      ? { state: 'new', count: servers.count, blockedBy: null, address: SERVERS_ADDRESS }
      : null,
  };
}

/** What a restore of these categories brings back (the preview's counts, “Keep what’s here” or not). */
function resultOf(
  preview: BackupRestorePreview,
  categories: readonly BackupCategoryId[],
  onDifferent: BackupOnDifferent,
  finishedAt: string,
  pointHere = true,
): BackupRestoreSummary {
  const chosen = preview.categories.filter((c) => categories.includes(c.id));
  const automations = chosen.find((c) => c.id === 'automations');
  const servers = chosen.find((c) => c.id === 'servers');
  return {
    categories: chosen.map((c) => ({
      id: c.id,
      added: c.new,
      updated: onDifferent === 'replace' ? c.different : 0,
      unchanged: c.here,
      kept: onDifferent === 'keep' ? c.different : 0,
      skipped: 0,
    })),
    connectionsToSignIn: chosen.some((c) => c.id === 'connections')
      ? [{ id: 'con_fusebox', label: 'Fusebox' }]
      : [],
    automationsOff: automations
      ? automations.new + (onDifferent === 'replace' ? automations.different : 0)
      : 0,
    schedulesPaused: 0,
    notes: [],
    servers: servers
      ? {
          back: servers.count,
          pointed: pointHere ? Math.max(0, servers.count - 1) : 0,
          toPoint: pointHere ? [SERVER_WITHOUT_KEY] : [],
        }
      : null,
    finishedAt,
  };
}

export function createBackupWorld(options: { seed?: boolean; now?: () => number } = {}): BackupWorld {
  const now = options.now ?? Date.now;
  const slug = burrow.slug;
  let defaults: BackupDefaults = {
    categories: [...BACKUP_DEFAULT_CATEGORIES],
    custom: false,
    updatedAt: null,
  };
  const files: FileRecord[] = [];
  const uploads: UploadRecord[] = [];
  const restores: RestoreRecord[] = [];
  let seeded: Promise<void> | null = null;

  const manifestFor = (categories: readonly BackupCategoryId[], createdAt: string): BackupFileManifest => ({
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt,
    timeZone: TZ,
    whombatVersion: '0.83.1',
    source: { burrowId: burrow.id, name: burrow.name, slug },
    madeBy: { name: mara.name, email: 'mara@burrowhq.example' },
    categories: categories.map((id) => {
      const e = ESTIMATE.find((c) => c.id === id);
      return { id, count: e?.count ?? 0, bytes: e?.bytes ?? 0 };
    }),
    includesSecrets: backupIncludesSecrets(categories),
    notes: [],
  });

  /** Makes a file's bytes and marks it ready. */
  async function finishFile(f: FileRecord, readyAt: number) {
    const categories = f.view.categories;
    const filler = Math.min(
      FILLER_MAX,
      ESTIMATE.filter((c) => categories.includes(c.id)).reduce((n, c) => n + c.bytes, 0),
    );
    const bytes = await makeBackupBytes(
      manifestFor(categories, f.view.createdAt),
      f.password ?? FIXTURE_BACKUP_PASSWORD,
      filler,
    );
    f.bytes = bytes;
    f.password = null;
    f.view = {
      ...f.view,
      status: 'ready',
      progress: null,
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
      readyAt: iso(readyAt),
      expiresAt: iso(readyAt + DAY),
      downloadUrl: backupDownloadUrl(slug, f.view.id),
    };
  }

  function seed(): Promise<void> {
    seeded ??= (async () => {
      if (!options.seed) return;
      const t = now();
      const made: FileRecord = {
        view: {
          id: 'bkf_seededfile01',
          name: backupFileName(slug, iso(t - HOUR), TZ),
          status: 'making',
          progress: null,
          categories: [...BACKUP_DEFAULT_CATEGORIES],
          includesSecrets: true,
          size: null,
          sha256: null,
          createdAt: iso(t - HOUR - 60_000),
          readyAt: null,
          expiresAt: null,
          error: null,
          downloadUrl: null,
        },
        password: FIXTURE_BACKUP_PASSWORD,
        bytes: null,
        started: t - HOUR - 60_000,
      };
      await finishFile(made, t - HOUR);
      files.push(made);
      const preview = previewOf(
        made.view.name,
        made.bytes?.byteLength ?? 0,
        manifestFor(made.view.categories, made.view.createdAt),
      );
      const categories: BackupCategoryId[] = [
        'agents',
        'memories',
        'automations',
        'connections',
        'settings',
        'servers',
      ];
      const finishedAt = iso(t - 30 * 60_000);
      restores.push({
        started: t - 31 * 60_000,
        result: resultOf(preview, categories, 'keep', finishedAt),
        view: {
          id: 'bkr_seededrestore1',
          upload: null,
          fileName: made.view.name,
          madeAt: made.view.createdAt,
          sourceName: burrow.name,
          categories,
          onDifferent: 'keep',
          status: 'done',
          progress: null,
          startedAt: iso(t - 31 * 60_000),
          finishedAt,
          summary: resultOf(preview, categories, 'keep', finishedAt),
          error: null,
        },
      });
    })();
    return seeded;
  }

  /** Moves the jobs on by the clock. */
  async function tick() {
    await seed();
    const t = now();
    for (const f of files) {
      if (f.view.status !== 'making') continue;
      const elapsed = (t - f.started) / 1000;
      if (elapsed >= MAKE_S) await finishFile(f, t);
      else {
        const total = f.view.categories.length * 10;
        const done = Math.floor((elapsed / MAKE_S) * total);
        f.view = {
          ...f.view,
          progress: { done, total, step: f.view.categories[Math.floor(done / 10)] ?? null },
        };
      }
    }
    for (const r of restores) {
      if (r.view.status !== 'restoring') continue;
      const elapsed = (t - r.started) / 1000;
      if (elapsed >= RESTORE_S) {
        const finishedAt = iso(t);
        // The upload is deleted once its restore is done (BF-10).
        const u = uploads.findIndex((x) => x.view.id === r.view.upload);
        if (u >= 0) uploads.splice(u, 1);
        r.view = {
          ...r.view,
          status: 'done',
          progress: null,
          finishedAt,
          summary: { ...r.result, finishedAt },
          upload: null,
        };
      } else {
        const total = r.view.categories.length * 10;
        const done = Math.floor((elapsed / RESTORE_S) * total);
        r.view = {
          ...r.view,
          progress: { done, total, step: r.view.categories[Math.floor(done / 10)] ?? null },
        };
      }
    }
    // Ready files leave after their 24 hours.
    for (let i = files.length - 1; i >= 0; i--) {
      const end = Date.parse(files[i]?.view.expiresAt ?? '');
      if (Number.isFinite(end) && end <= t) files.splice(i, 1);
    }
  }

  const fileOf = (id: string) => files.find((f) => f.view.id === id);
  const uploadOf = (id: string) => uploads.find((u) => u.view.id === id);
  /** Newest first, as `backups.list` answers. */
  const newest = <T>(xs: readonly T[]) => [...xs].reverse();

  function stage(fileName: string, size: number): Response {
    if (size > BACKUP_FILE_MAX_BYTES) return refusal('too_large');
    if (uploads.length >= 3) return refusal('too_many');
    const t = now();
    const id = newId('bku');
    const view: BackupUploadView = {
      id,
      fileName,
      size,
      received: 0,
      status: 'uploading',
      sha256: null,
      createdAt: iso(t),
      expiresAt: iso(t + DAY),
      uploadUrl: backupUploadUrl(slug, id),
      chunkBytes: BACKUP_UPLOAD_CHUNK_BYTES,
      maxChunkBytes: BACKUP_UPLOAD_CHUNK_MAX_BYTES,
    };
    uploads.push({ view, parts: [] });
    return json({ upload: view }, 201);
  }

  async function inspect(u: UploadRecord, password: string): Promise<BackupRestorePreview> {
    const bytes = concat(u.parts);
    const manifest = await readManifest(bytes, password);
    return previewOf(u.view.fileName, u.view.size, manifest);
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : url.pathname;
    const prefix = `/burrows/${slug}`;
    if (!path.startsWith(prefix)) return null;
    const rest = path.slice(prefix.length);
    if (
      !rest.startsWith('/backups') &&
      !rest.startsWith('/backup-uploads') &&
      !rest.startsWith('/backup-restores')
    )
      return null;
    await tick();
    const m = req.method;
    const body = async <T>() => (await req.json().catch(() => ({}))) as T;

    if (rest === '/backups/defaults' && m === 'GET') return json(defaults);
    if (rest === '/backups/defaults' && m === 'PUT') {
      const b = await body<{ categories?: BackupCategoryId[] }>();
      if (!b.categories?.length) return refusal('nothing_chosen');
      defaults = { categories: sortBackupCategories(b.categories), custom: true, updatedAt: iso(now()) };
      return json(defaults);
    }
    if (rest === '/backups/estimate' && m === 'GET')
      return json({
        categories: ESTIMATE,
        freeBytes: 46_000_000_000,
        maxBytes: BACKUP_FILE_MAX_BYTES,
        generatedAt: iso(now()),
      } satisfies BackupEstimate);
    if (rest === '/backups' && m === 'GET')
      return json({
        files: newest(files).map((f) => f.view),
        uploads: newest(uploads).map((u) => u.view),
        restores: newest(restores).map((r) => r.view),
      });
    if (rest === '/backups' && m === 'POST') {
      const b = await body<{ categories?: BackupCategoryId[]; password?: string }>();
      if (!b.categories?.length) return refusal('nothing_chosen');
      if (!backupPasswordOk(b.password ?? '')) return refusal('password_too_short');
      if (files.some((f) => f.view.status === 'making')) return refusal('busy');
      if (files.filter((f) => f.view.status !== 'failed').length >= 5) return refusal('too_many');
      const t = now();
      const categories = sortBackupCategories(b.categories);
      const f: FileRecord = {
        view: {
          id: newId('bkf'),
          name: backupFileName(slug, iso(t), TZ),
          status: 'making',
          progress: { done: 0, total: categories.length * 10, step: categories[0] ?? null },
          categories,
          includesSecrets: backupIncludesSecrets(categories),
          size: null,
          sha256: null,
          createdAt: iso(t),
          readyAt: null,
          expiresAt: null,
          error: null,
          downloadUrl: null,
        },
        password: b.password ?? null,
        bytes: null,
        started: t,
      };
      files.push(f);
      return json({ file: f.view }, 201);
    }
    const one = /^\/backups\/([^/]+)(\/content)?$/.exec(rest);
    if (one) {
      const f = fileOf(decodeURIComponent(one[1] ?? ''));
      if (one[2]) {
        if (!f?.bytes || f.view.status !== 'ready') return refusal('expired');
        return content(f, req.headers.get('range'));
      }
      if (!f) return json({ error: { code: 'not_found', message: 'That backup file isn’t here.' } }, 404);
      if (m === 'GET') return json({ file: f.view });
      if (m === 'DELETE') {
        files.splice(files.indexOf(f), 1);
        return json({ ok: true });
      }
    }
    if (rest === '/backup-uploads' && m === 'POST') {
      const b = await body<{ fileName?: string; size?: number }>();
      return stage(b.fileName ?? 'backup.wbk', b.size ?? 0);
    }
    const up = /^\/backup-uploads\/([^/]+)(\/content|\/inspect|\/restore)?$/.exec(rest);
    if (up) {
      const u = uploadOf(decodeURIComponent(up[1] ?? ''));
      if (!u) return refusal('upload_expired');
      if (!up[2] && m === 'GET') return json({ upload: u.view });
      if (!up[2] && m === 'DELETE') {
        if (restores.some((r) => r.view.status === 'restoring' && r.view.upload === u.view.id))
          return refusal('restore_running');
        uploads.splice(uploads.indexOf(u), 1);
        return json({ ok: true });
      }
      if (up[2] === '/content' && m === 'PUT') {
        const range = parseBackupContentRange(req.headers.get('content-range') ?? '');
        const chunk = new Uint8Array(await req.arrayBuffer());
        if (!range || range.size !== u.view.size || range.end - range.start !== chunk.byteLength)
          return refusal('upload_mismatch', { received: u.view.received });
        if (range.start < u.view.received) return json({ upload: u.view });
        if (range.start !== u.view.received) return refusal('upload_mismatch', { received: u.view.received });
        u.parts.push(chunk);
        const received = u.view.received + chunk.byteLength;
        u.view = { ...u.view, received, status: received === u.view.size ? 'uploaded' : 'uploading' };
        return json({ upload: u.view });
      }
      if (up[2] === '/inspect' && m === 'POST') {
        if (u.view.status !== 'uploaded') return refusal('upload_incomplete');
        const b = await body<{ password?: string }>();
        try {
          return json(await inspect(u, b.password ?? ''));
        } catch (e) {
          return isBackupFileError(e) ? refusal(e.code) : refusal('damaged');
        }
      }
      if (up[2] === '/restore' && m === 'POST') {
        if (u.view.status !== 'uploaded') return refusal('upload_incomplete');
        if (restores.some((r) => r.view.status === 'restoring')) return refusal('restore_running');
        const b = await body<{
          password?: string;
          categories?: BackupCategoryId[];
          onDifferent?: BackupOnDifferent;
          servers?: { pointHere: boolean };
        }>();
        if (!b.categories?.length) return refusal('nothing_chosen');
        let preview: BackupRestorePreview;
        try {
          preview = await inspect(u, b.password ?? '');
        } catch (e) {
          return isBackupFileError(e) ? refusal(e.code) : refusal('damaged');
        }
        const categories = sortBackupCategories(b.categories);
        if (categories.some((id) => !preview.categories.some((c) => c.id === id)))
          return refusal('not_in_file');
        const t = now();
        const onDifferent = b.onDifferent ?? 'keep';
        const r: RestoreRecord = {
          started: t,
          result: resultOf(preview, categories, onDifferent, iso(t), b.servers?.pointHere ?? true),
          view: {
            id: newId('bkr'),
            upload: u.view.id,
            fileName: u.view.fileName,
            madeAt: preview.manifest.createdAt,
            sourceName: preview.manifest.source.name,
            categories,
            onDifferent,
            status: 'restoring',
            progress: { done: 0, total: categories.length * 10, step: categories[0] ?? null },
            startedAt: iso(t),
            finishedAt: null,
            summary: null,
            error: null,
          },
        };
        restores.push(r);
        return json({ restore: r.view }, 201);
      }
    }
    const restore = /^\/backup-restores\/([^/]+)$/.exec(rest);
    if (restore && m === 'GET') {
      const r = restores.find((x) => x.view.id === decodeURIComponent(restore[1] ?? ''));
      return r
        ? json({ restore: r.view })
        : json({ error: { code: 'not_found', message: 'That restore isn’t here.' } }, 404);
    }
    return null;
  }

  /** The raw bytes, whole or from a `Range` (206), as `BACKUP_FILE_TRANSFER.download` answers. */
  function content(f: FileRecord, range: string | null): Response {
    const bytes = f.bytes as Uint8Array;
    const headers: Record<string, string> = {
      'content-type': BACKUP_FILE_CONTENT_TYPE,
      'content-disposition': `attachment; filename="${f.view.name}"`,
      'x-whombat-sha256': f.view.sha256 ?? '',
      etag: `"${f.view.sha256 ?? ''}"`,
      'accept-ranges': 'bytes',
    };
    const m = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) + 1 : bytes.byteLength;
      if (start >= bytes.byteLength || end > bytes.byteLength || start >= end)
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${bytes.byteLength}` },
        });
      const part = bytes.slice(start, end);
      return new Response(part as BodyInit, {
        status: 206,
        headers: {
          ...headers,
          'content-length': String(part.byteLength),
          'content-range': `bytes ${start}-${end - 1}/${bytes.byteLength}`,
        },
      });
    }
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: { ...headers, 'content-length': String(bytes.byteLength) },
    });
  }

  return {
    handle,
    async resource(backupFileId) {
      await tick();
      const f = fileOf(backupFileId);
      return f?.bytes && f.view.status === 'ready' ? { name: f.view.name, bytes: f.bytes } : null;
    },
    completeUpload(stagedBackupId, bytes) {
      const u = uploadOf(stagedBackupId);
      if (!u || bytes.byteLength !== u.view.size) return null;
      u.parts = [bytes];
      const digest = sha256Hex(bytes);
      u.view = { ...u.view, received: bytes.byteLength, status: 'uploaded', sha256: digest };
      return { stagedBackupId, size: bytes.byteLength, sha256: digest };
    },
  };
}

/** Whether fixture mode starts with a ready file and a finished restore (`backups`, or `VITE_FIXTURE_BACKUPS=1`). */
export function backupsSeeded(option: boolean | undefined): boolean {
  return option ?? import.meta.env.VITE_FIXTURE_BACKUPS === '1';
}
