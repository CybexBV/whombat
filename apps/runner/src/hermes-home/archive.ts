/**
 * A home's archive, for backups (hermes-engine.md HE-38, HE-S114, HE-S115): a gzipped ustar (`@whombat/core/backup`'s
 * writer and reader) of what a home holds that is the person's — never what the runner writes before each turn
 * (`config.yaml`, `SOUL.md`, `whombat.md`, the policy, a model's key), nor Hermes's logs, caches, locks, gateway state
 * or own logins (a person's ChatGPT login, `auth.json`: hermes-native.md HN-03). The person's profile's (one-person.md
 * OP-08): its memory files, session store (`state.db` with its write-ahead log), session files and projects
 * (`HOME_ENTRIES`); its skills folder's (`skills`): all of it — Hermes's built-ins, hub installs, what the agent learned
 * and Whombat's bookkeeping. One archive each, so the profile's carries no `skills/`.
 *
 * The archive is made into `transfers/` under the profile's lock (no Hermes writes meanwhile, so `state.db` and its log
 * agree) — the skills folder's under its own lock (`withSkills`, every change of the folder takes it) — then read out
 * in chunks; an import is written there chunk by chunk, checked whole (size, sha256, manifest,
 * paths, only those entries), unpacked beside it and moved in under the lock. A transfer nobody finished goes after
 * `HERMES_HOME_TRANSFER_TTL_MS`.
 *
 *   whombat-home.json   {format, kind, hermes, exec: [paths]}   (first)
 *   home/<path>         the files, relative to the home
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  HERMES_HOME_ENTRIES,
  HERMES_HOME_FORMAT,
  HERMES_HOME_MANIFEST,
  HERMES_HOME_PREFIX,
  HERMES_PIN,
  type HermesHomeManifest,
  hermesArchiveIncludes,
} from '@whombat/agent-runtime';
import {
  HERMES_HOME_ARCHIVE_MAX_BYTES,
  HERMES_HOME_TRANSFER_TTL_MS,
  type HermesHomeArgs,
  type HermesHomeRef,
  type HermesHomeResult,
  type HermesImportMode,
} from '@whombat/core';
import { isSafeTarPath, TarReader, TarWriter } from '@whombat/core/backup';
import { type HermesHomeContext, HermesHomeError } from './context';
import type { AreaHandlers } from './handlers';
import { withSkills } from './skills';
import { makeWritable } from './skills-folder';

export const MANIFEST = HERMES_HOME_MANIFEST;
const FORMAT = HERMES_HOME_FORMAT;
const PREFIX = HERMES_HOME_PREFIX;

type Manifest = HermesHomeManifest;

/** What a profile's archive holds, by top-level name (shared with the server, which packs a backup's copy). */
export const HOME_ENTRIES: readonly string[] = HERMES_HOME_ENTRIES;
/** Entries that are one thing: kept or replaced together (a session store and its write-ahead log). */
const GROUPS: readonly (readonly string[])[] = [['state.db', 'state.db-wal', 'state.db-shm']];
/** Directories whose children are filled one by one (`fill`). */
const FILL_INTO: ReadonlySet<string> = new Set(['memories', 'sessions', 'scripted-hermes']);

/** The directory a ref's archive is made from and put back into. */
function rootOf(ctx: HermesHomeContext, home: HermesHomeRef): string {
  return home.kind === 'skills' ? ctx.skillsDir : ctx.profileDir(home.home);
}

/** Whether a path inside the home belongs in its archive. */
const included = hermesArchiveIncludes;

interface FileEntry {
  rel: string;
  path: string;
  size: number;
  mtime: number;
  exec: boolean;
}

/** The regular files of the home that go into its archive (no links followed, nothing else). */
async function listFiles(root: string, kind: HermesHomeRef['kind']): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (dir: string, rel: string) => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (!rel && kind === 'profile' && !HOME_ENTRIES.includes(name)) continue;
      const path = join(dir, name);
      const s = await lstat(path);
      if (s.isDirectory()) await walk(path, childRel);
      else if (s.isFile() && included(kind, childRel) && isSafeTarPath(`${PREFIX}${childRel}`))
        out.push({
          rel: childRel,
          path,
          size: s.size,
          mtime: Math.floor(s.mtimeMs / 1000),
          exec: (s.mode & 0o100) !== 0,
        });
    }
  };
  await walk(root, '');
  return out;
}

/* Transfers ----------------------------------------------------------------------------------------------------------- */

interface Transfer {
  id: string;
  kind: 'export' | 'import';
  home: HermesHomeRef;
  path: string;
  bytes: number;
  sha256: string;
  /** Import: bytes received so far. */
  received: number;
  at: number;
}

const transfers = new WeakMap<HermesHomeContext, Map<string, Transfer>>();

function transfersOf(ctx: HermesHomeContext): Map<string, Transfer> {
  let m = transfers.get(ctx);
  if (!m) {
    m = new Map();
    transfers.set(ctx, m);
  }
  return m;
}

async function transfersDir(ctx: HermesHomeContext): Promise<string> {
  const dir = ctx.dir('transfers');
  await mkdir(ctx.root, { recursive: true, mode: 0o700 });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

function take(ctx: HermesHomeContext, id: string, kind: Transfer['kind']): Transfer {
  const t = transfersOf(ctx).get(id);
  if (!t || t.kind !== kind) throw new HermesHomeError('not_found', 'That transfer is gone.');
  t.at = Date.now();
  return t;
}

async function drop(ctx: HermesHomeContext, id: string): Promise<void> {
  const t = transfersOf(ctx).get(id);
  transfersOf(ctx).delete(id);
  const dir = ctx.dir('transfers');
  await rm(t?.path ?? join(dir, `${id}.tgz`), { force: true });
  await rm(join(dir, `${id}.d`), { recursive: true, force: true });
}

/** Transfers nobody finished, and what an earlier runner left in `transfers/`, removed. */
export async function sweepTransfers(ctx: HermesHomeContext, now = Date.now()): Promise<void> {
  const live = transfersOf(ctx);
  for (const [id, t] of live) if (now - t.at > HERMES_HOME_TRANSFER_TTL_MS) await drop(ctx, id);
  let names: string[];
  try {
    names = await readdir(ctx.dir('transfers'));
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.replace(/\.(tgz|d)$/, '');
    if (!live.has(id)) await rm(join(ctx.dir('transfers'), name), { recursive: true, force: true });
  }
}

const newTransferId = () => `hht_${randomBytes(12).toString('base64url')}`;

/* Export -------------------------------------------------------------------------------------------------------------- */

/** Writes the archive of `files` to `path`; its size and sha256. */
async function writeArchive(
  path: string,
  kind: HermesHomeRef['kind'],
  files: readonly FileEntry[],
): Promise<{ bytes: number; sha256: string }> {
  const manifest: Manifest = {
    format: FORMAT,
    kind,
    hermes: HERMES_PIN.version,
    exec: files.filter((f) => f.exec).map((f) => f.rel),
  };
  const tar = new TarWriter();
  async function* body(): AsyncGenerator<Uint8Array> {
    yield tar.file(
      MANIFEST,
      new TextEncoder().encode(JSON.stringify(manifest)),
      Math.floor(Date.now() / 1000),
    );
    for (const f of files) {
      yield tar.begin({ name: `${PREFIX}${f.rel}`, size: f.size, mtime: f.mtime });
      let n = 0;
      for await (const chunk of createReadStream(f.path) as AsyncIterable<Buffer>) {
        n += chunk.length;
        if (n > f.size) throw new HermesHomeError('failed', `${f.rel} changed while it was archived.`);
        yield tar.write(chunk);
      }
      if (n !== f.size) throw new HermesHomeError('failed', `${f.rel} changed while it was archived.`);
      yield tar.end();
    }
    yield tar.finish();
  }
  const hash = createHash('sha256');
  let bytes = 0;
  async function* counted(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > HERMES_HOME_ARCHIVE_MAX_BYTES)
        throw new HermesHomeError('failed', 'The home is too large to back up.');
      hash.update(chunk);
      yield chunk;
    }
  }
  await pipeline(body, createGzip(), counted, createWriteStream(path, { mode: 0o600 }));
  return { bytes, sha256: hash.digest('hex') };
}

async function exportBegin(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'home.exportBegin'>,
): Promise<HermesHomeResult<'home.exportBegin'>> {
  await sweepTransfers(ctx);
  const dir = await transfersDir(ctx);
  const id = newTransferId();
  const path = join(dir, `${id}.tgz`);
  const pack = async (root: string) => {
    const files = await listFiles(root, p.home.kind);
    return { files: files.length, ...(await writeArchive(path, p.home.kind, files)) };
  };
  try {
    const made =
      p.home.kind === 'profile'
        ? await ctx.withProfile(pack, { holder: 'hermes-home:export', home: p.home.home })
        : await withSkills(ctx, pack, { holder: 'hermes-home:export' });
    transfersOf(ctx).set(id, {
      id,
      kind: 'export',
      home: p.home,
      path,
      bytes: made.bytes,
      sha256: made.sha256,
      received: 0,
      at: Date.now(),
    });
    return { transfer: id, bytes: made.bytes, sha256: made.sha256, files: made.files };
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
}

async function exportChunk(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'home.exportChunk'>,
): Promise<HermesHomeResult<'home.exportChunk'>> {
  const t = take(ctx, p.transfer, 'export');
  if (p.offset > t.bytes) throw new HermesHomeError('invalid', 'That offset is past the archive’s end.');
  const length = Math.min(p.length, t.bytes - p.offset);
  const fh = await open(t.path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, p.offset);
    return { data: buf.subarray(0, bytesRead).toString('base64') };
  } finally {
    await fh.close();
  }
}

/* Import -------------------------------------------------------------------------------------------------------------- */

async function importBegin(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'home.importBegin'>,
): Promise<HermesHomeResult<'home.importBegin'>> {
  rootOf(ctx, p.home); // refuses a profile name that can't be one
  await sweepTransfers(ctx);
  const dir = await transfersDir(ctx);
  const id = newTransferId();
  const path = join(dir, `${id}.tgz`);
  await writeFile(path, new Uint8Array(0), { mode: 0o600 });
  transfersOf(ctx).set(id, {
    id,
    kind: 'import',
    home: p.home,
    path,
    bytes: p.bytes,
    sha256: p.sha256,
    received: 0,
    at: Date.now(),
  });
  return { transfer: id };
}

async function importChunk(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'home.importChunk'>,
): Promise<HermesHomeResult<'home.importChunk'>> {
  const t = take(ctx, p.transfer, 'import');
  const data = Buffer.from(p.data, 'base64');
  // A repeat of the last chunk (its answer was lost) is fine; anything else must come in order.
  if (p.offset + data.length === t.received && p.offset < t.received) return { received: t.received };
  if (p.offset !== t.received) throw new HermesHomeError('invalid', 'Chunks must come in order.');
  if (t.received + data.length > t.bytes)
    throw new HermesHomeError('invalid', 'The archive is longer than announced.');
  const fh = await open(t.path, 'r+');
  try {
    await fh.write(data, 0, data.length, p.offset);
  } finally {
    await fh.close();
  }
  t.received += data.length;
  return { received: t.received };
}

/** Unpacks a checked archive into `into`; the manifest and the files. */
async function unpack(
  path: string,
  into: string,
  kind: HermesHomeRef['kind'],
): Promise<{ manifest: Manifest; files: string[] }> {
  const reader = new TarReader();
  let manifest: Manifest | null = null;
  let manifestBytes: Buffer[] | null = null;
  let current: { rel: string; fh: Awaited<ReturnType<typeof open>> } | null = null;
  const files: string[] = [];
  let total = 0;
  const invalid = (why: string) =>
    new HermesHomeError('invalid', `That isn’t a Hermes home’s archive: ${why}.`);
  try {
    for await (const piece of createReadStream(path).pipe(createGunzip()) as AsyncIterable<Buffer>) {
      for (const ev of reader.push(piece)) {
        if (ev.type === 'entry') {
          if (!manifest && !manifestBytes) {
            if (ev.entry.name !== MANIFEST) throw invalid('no manifest first');
            if (ev.entry.size > 1024 * 1024) throw invalid('the manifest is too large');
            manifestBytes = [];
            continue;
          }
          if (!ev.entry.name.startsWith(PREFIX)) throw invalid(`unexpected ${ev.entry.name}`);
          const rel = ev.entry.name.slice(PREFIX.length);
          if (!included(kind, rel)) throw invalid(`${rel} isn’t part of a home`);
          total += ev.entry.size;
          if (total > HERMES_HOME_ARCHIVE_MAX_BYTES * 4) throw invalid('it unpacks too large');
          const target = join(into, rel);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          current = { rel, fh: await open(target, 'wx', 0o600) };
          files.push(rel);
        } else if (ev.type === 'data') {
          if (manifestBytes && !manifest) manifestBytes.push(Buffer.from(ev.data));
          else if (current) await current.fh.write(ev.data);
        } else if (manifestBytes && !manifest) {
          const parsed = JSON.parse(Buffer.concat(manifestBytes).toString('utf8')) as Partial<Manifest>;
          if (parsed.format !== FORMAT) throw invalid('another format');
          if (parsed.kind !== kind) throw invalid(`it holds ${parsed.kind ?? 'something else'}`);
          manifest = {
            format: FORMAT,
            kind,
            hermes: String(parsed.hermes ?? ''),
            exec: Array.isArray(parsed.exec) ? parsed.exec.filter((e) => typeof e === 'string') : [],
          };
        } else if (current) {
          await current.fh.close();
          current = null;
        }
      }
    }
    reader.finish();
  } catch (err) {
    if (err instanceof HermesHomeError) throw err;
    throw invalid((err as Error).message);
  } finally {
    await current?.fh.close().catch(() => {});
  }
  if (!manifest) throw invalid('no manifest');
  for (const rel of manifest.exec) if (files.includes(rel)) await chmod(join(into, rel), 0o700);
  return { manifest, files };
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Moves `from` to `to`, replacing whatever is at `to`. */
async function moveIn(from: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await rename(from, to);
}

/**
 * Fills the skills folder skill by skill (hermes-native.md HN-K07): a folder with a `SKILL.md` is one skill, kept whole
 * when it is here and moved in when it isn't; a folder without one is a category (or Hermes's and Whombat's
 * bookkeeping), merged entry by entry, so a category the person has here doesn't keep the backup's other skills of it
 * out. How many entries were kept.
 */
async function fillSkills(from: string, to: string): Promise<number> {
  if (!(await exists(to))) {
    await moveIn(from, to);
    return 0;
  }
  if (!(await lstat(to)).isDirectory()) return 1;
  let kept = 0;
  for (const name of await readdir(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    const category = (await lstat(src)).isDirectory() && !(await exists(join(src, 'SKILL.md')));
    if (category) kept += await fillSkills(src, dst);
    else if (await exists(dst)) kept++;
    else await moveIn(src, dst);
  }
  return kept;
}

/**
 * Puts the unpacked archive in place: `replace` removes the home's own entries (every `HOME_ENTRIES` of a profile, or
 * the whole skills folder's content) and moves the archive's in; `fill` moves in only what is missing — a group as one,
 * the children of `FILL_INTO` one by one, the skills skill by skill. How many top-level things were kept.
 */
async function place(
  unpacked: string,
  root: string,
  kind: HermesHomeRef['kind'],
  mode: HermesImportMode,
): Promise<number> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const have = new Set(await readdir(unpacked).catch(() => [] as string[]));
  if (mode === 'replace') {
    const mine = kind === 'profile' ? HOME_ENTRIES.concat('state.db-shm') : await readdir(root);
    // Hermes's built-ins may have come with the Nix store's read-only modes (HSK-S14).
    if (kind === 'skills') await makeWritable(root);
    for (const name of mine) await rm(join(root, name), { recursive: true, force: true });
    for (const name of have) await rename(join(unpacked, name), join(root, name));
    return 0;
  }
  if (kind === 'skills') return fillSkills(unpacked, root);
  let kept = 0;
  const done = new Set<string>();
  for (const name of have) {
    if (done.has(name)) continue;
    const group = GROUPS.find((g) => g.includes(name));
    if (group) {
      for (const n of group) done.add(n);
      if (await exists(join(root, group[0] as string))) {
        kept++;
        continue;
      }
      for (const n of group) if (have.has(n)) await moveIn(join(unpacked, n), join(root, n));
      continue;
    }
    done.add(name);
    const src = join(unpacked, name);
    const dst = join(root, name);
    if (FILL_INTO.has(name) && (await stat(src)).isDirectory()) {
      for (const child of await readdir(src)) {
        if (await exists(join(dst, child))) kept++;
        else await moveIn(join(src, child), join(dst, child));
      }
    } else if (await exists(dst)) kept++;
    else await moveIn(src, dst);
  }
  return kept;
}

async function importCommit(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'home.importCommit'>,
): Promise<HermesHomeResult<'home.importCommit'>> {
  const t = take(ctx, p.transfer, 'import');
  try {
    if (t.received !== t.bytes) throw new HermesHomeError('invalid', 'The archive isn’t complete.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(t.path) as AsyncIterable<Buffer>) hash.update(chunk);
    if (hash.digest('hex') !== t.sha256)
      throw new HermesHomeError('invalid', 'The archive doesn’t match its checksum.');
    const unpacked = join(ctx.dir('transfers'), `${t.id}.d`);
    await rm(unpacked, { recursive: true, force: true });
    await mkdir(unpacked, { mode: 0o700 });
    const { files } = await unpack(t.path, unpacked, t.home.kind);
    const put = (root: string) => place(unpacked, root, t.home.kind, p.mode);
    const kept =
      t.home.kind === 'profile'
        ? await ctx.withProfile(put, { holder: 'hermes-home:import', home: t.home.home })
        : await withSkills(ctx, put, { holder: 'hermes-home:import' });
    return { files: files.length, kept };
  } finally {
    await drop(ctx, t.id);
  }
}

async function discard(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'home.discard'>,
): Promise<HermesHomeResult<'home.discard'>> {
  await drop(ctx, p.transfer);
  return null;
}

export const archiveHandlers: AreaHandlers<
  | 'home.exportBegin'
  | 'home.exportChunk'
  | 'home.importBegin'
  | 'home.importChunk'
  | 'home.importCommit'
  | 'home.discard'
> = {
  'home.exportBegin': exportBegin,
  'home.exportChunk': exportChunk,
  'home.importBegin': importBegin,
  'home.importChunk': importChunk,
  'home.importCommit': importCommit,
  'home.discard': discard,
};
