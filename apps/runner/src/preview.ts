/**
 * The folder a `browser_preview` asks for (docs/decisions/browser.md): read by the runner from the turn's own folder and uploaded to the server. Which folder
 * that is depends on the turn (`previewSourceOf`, resourceful-agents.md RA-DS70): a checkout, or — in any commands turn
 * without a checkout, conversations included — the agent's work folder (`~/work`, the same path for its commands and
 * this host; one-person.md OP-S109); and in an automation's step also the step's own folder (AR-43, RN-R2), named by its
 * full path, where a reviewer copies what it must run. Nothing else.
 *
 * The folder stays inside that root: `..` and paths outside it are refused, symlinks inside it are skipped, `.git` is
 * never read, and the caps hold before anything is sent. On Linux every directory and file is opened relative to the
 * one already open (`/proc/self/fd/<fd>/<name>`, never following a link), so a command that swaps a folder for a link
 * while the runner reads can't lead it outside (RA-DS71).
 */
import { constants, existsSync } from 'node:fs';
import { type FileHandle, lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { BROWSER_PREVIEW_MAX_BYTES, BROWSER_PREVIEW_MAX_FILES, type PreviewFile } from '@whombat/core';
import { STEP_FOLDERS_DIR } from './workspace';

export type PreviewFolder = { files: PreviewFile[] } | { error: string };

/** One file of a folder as read, by its path inside it (`/`-separated). */
export interface FolderFile {
  path: string;
  bytes: Buffer;
}

export type FolderFiles = { files: FolderFile[] } | { error: string };

/** How much of a folder may be read, and what to tell the agent when it is more or nothing. */
export interface FolderLimits {
  files: number;
  bytes: number;
  tooMany: (dir: string) => string;
  tooLarge: (dir: string) => string;
  empty: (dir: string) => string;
}

/** A folder previews and uploads are read from, and how the agent knows it. */
export interface PreviewRoot {
  /** The folder on this host. */
  root: string;
  /** The folder in the agent's words (“your work folder (~/work, where your shell starts)”). */
  where: string;
  /** Other names the agent's shell has for it (`~/work`). */
  aliases?: readonly string[];
  /**
   * A parent of `root` the agent can't put a link in place of (a step folder's: the work folder, whose `.automation`
   * folder the agent's commands can rename): `root` must be reached from it without a link, and is opened from it one folder at
   * a time. Absent: `root` itself is such a folder (a checkout or a work folder).
   */
  anchor?: string;
}

/** Where a turn's folders are read from: its own folder (its working directory), and a step's own folder besides. */
export interface PreviewSource extends PreviewRoot {
  /**
   * An automation step's own folder outside the turn's own (AR-43, RN-R2): read when the folder is named by its full
   * path there (or by `~/work/.automation/…`); any other folder is the turn's own folder's.
   */
  step?: PreviewRoot;
}

/** The work folder's other name in the agent's shell (OP-S109): `~/work` in its home. */
export const WORK_FOLDER_ALIASES = ['~/work'] as const;

/** A turn without a folder of its own (a turn without commands or a checkout). */
export const PREVIEW_NO_FOLDER =
  'This turn has no folder of its own to read: browser_preview takes a folder of your checkout or of your work folder (~/work, conversations included). Here you have neither: start a run (start_run) and build in its checkout.';

/** What the runner knows of a turn's working directory (`PreparedCwd`). */
export interface TurnFolder {
  cwd: string;
  git: unknown;
  workFolder?: boolean;
  /** An automation step's own folder (AR-43). */
  stepFolder?: string;
}

/**
 * An automation step's own folder as a place previews read (RN-R2): named by its full path, the same for the agent's
 * commands, or through the work folder's other name (`~/work/.automation/<dispatch>`). It is `<work folder>/.automation/<dispatch>`
 * (`automationStepFolder`), read from the work folder (`anchor`).
 */
export function stepPreviewRoot(folder: string): PreviewRoot {
  return {
    root: folder,
    where: `this step’s own folder (${folder})`,
    aliases: WORK_FOLDER_ALIASES.map((a) => posix.join(a, STEP_FOLDERS_DIR, basename(folder))),
    anchor: dirname(dirname(folder)),
  };
}

/** The turn's own folder (RA-DS70): the checkout or the agent's work folder. */
function ownPreviewRoot(prepared: TurnFolder): PreviewRoot | null {
  if (prepared.git) return { root: prepared.cwd, where: 'your checkout' };
  if (prepared.workFolder)
    return {
      root: prepared.cwd,
      where: 'your work folder (~/work, where your shell starts)',
      aliases: WORK_FOLDER_ALIASES,
    };
  return null;
}

const trimDir = (dir: string) => dir.trim().replace(/\/+$/, '');
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * The folders a turn's previews and uploads are read from (RA-DS70): the checkout (also a read-only export) or the
 * agent's work folder — the agent's shell starts there, in any kind of turn — and an
 * automation step's own folder besides (RN-R2; in a turn without a checkout it is inside the work folder, read with it).
 * Null for a turn without any.
 */
export function previewSourceOf(prepared: TurnFolder | null | undefined): PreviewSource | null {
  if (!prepared) return null;
  const own = ownPreviewRoot(prepared);
  const step = prepared.stepFolder ? stepPreviewRoot(prepared.stepFolder) : null;
  if (!own) return step;
  if (!step || inside(trimDir(step.root), trimDir(own.root))) return own;
  return { ...own, step };
}

/** `dir` with the root's base it starts with (an alias or the root itself) cut off, or null when it names none. */
function underRoot(root: PreviewRoot, dir: string): string | null {
  const d = trimDir(dir);
  for (const base of [...(root.aliases ?? []), root.root].map(trimDir)) {
    if (d === base) return '';
    if (d.startsWith(`${base}/`)) return d.slice(base.length + 1);
  }
  return null;
}

/** Where a folder is read from, for a path that names no place there. */
function onlyRead(source: PreviewSource): string {
  if (!source.step)
    return `Only ${source.where} is read: give the folder relative to it (like dist or site/dist), or build or copy it there first.`;
  return `Only ${source.where} and ${source.step.where} are read: give a folder of ${source.where} relative to it (like dist or site/dist), or one in this step’s folder by its full path.`;
}

/**
 * `dir` as a path inside the source's root (`.` for the root itself), or why not. Relative to the root; an absolute path
 * (or `~/work/…`) only when it names a place inside it. A step's own folder (`source.step`) is read by
 * `readPreviewFolder` before this; here it is only named in the refusal.
 */
export function previewPath(source: PreviewSource, dir: string): { rel: string } | { error: string } {
  const d = underRoot(source, dir) ?? trimDir(dir);
  if (isAbsolute(d) || d.startsWith('~')) return { error: onlyRead(source) };
  if (d.split(/[\\/]/).includes('..'))
    return { error: `Give the folder inside ${source.where}, without “..”.` };
  return { rel: d || '.' };
}

/** Test seam: runs before each directory or file is opened, so a test can swap it for a link. */
export interface PreviewReadHooks {
  beforeOpen?: (name: string) => Promise<void> | void;
}

const PROC_FD = '/proc/self/fd';
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_NOCTTY } = constants;
const DIR_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
const FILE_FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY;

/** A folder that isn't there: where it was looked for, and how to name one in it. */
const noFolder = (dir: string, source: PreviewSource, how: string) =>
  `There is no folder ${dir} in ${source.where}: ${how}, or build it first, then preview it.`;
/** How a folder of the turn's own folder is named. */
const RELATIVE_HOW = 'give its path from there (like site/dist)';
/** A `browser_preview`'s folder: a build. */
export const PREVIEW_LIMITS: FolderLimits = {
  files: BROWSER_PREVIEW_MAX_FILES,
  bytes: BROWSER_PREVIEW_MAX_BYTES,
  tooMany: (dir) => `${dir} has more than ${BROWSER_PREVIEW_MAX_FILES} files: preview the built folder only.`,
  tooLarge: (dir) =>
    `${dir} is larger than ${BROWSER_PREVIEW_MAX_BYTES / 1024 / 1024} MB: preview the built folder only.`,
  empty: (dir) => `${dir} is empty. Build first, then preview the built folder.`,
};

/**
 * Reads `dir` of the turn's folder — or of an automation step's own folder, when it names a place there (RN-R2) — for a
 * preview or an upload, or says why not (in words for the agent).
 */
export async function readPreviewFolder(
  from: string | PreviewSource,
  dir: string,
  hooks: PreviewReadHooks = {},
): Promise<PreviewFolder> {
  const read = await readFolderFiles(from, dir, PREVIEW_LIMITS, hooks);
  if ('error' in read) return read;
  return { files: read.files.map((f) => ({ path: f.path, data: f.bytes.toString('base64') })) };
}

/**
 * Reads `dir` of the turn's folder (or of an automation step's own folder, RN-R2) within `limits`, as bytes, or says why
 * not in words for the agent.
 */
export async function readFolderFiles(
  from: string | PreviewSource,
  dir: string,
  limits: FolderLimits,
  hooks: PreviewReadHooks = {},
): Promise<FolderFiles> {
  const source: PreviewSource =
    typeof from === 'string' ? { root: from, where: 'your working directory' } : from;
  const step = source.step;
  if (step) {
    // By any of its names, its real path included (the one the agent's shell may print).
    const real = await realpath(step.root).catch(() => null);
    const named = { ...step, aliases: [...(step.aliases ?? []), ...(real ? [real] : [])] };
    if (underRoot(named, dir) !== null)
      return readIn(
        named,
        dir,
        hooks,
        `give its full path (like ${posix.join(step.root, 'site/dist')})`,
        limits,
      );
  }
  return readIn(source, dir, hooks, RELATIVE_HOW, limits);
}

/** Reads `dir` inside one root (`source`, whose `step` only shapes the refusal of a path outside both). */
async function readIn(
  source: PreviewSource,
  dir: string,
  hooks: PreviewReadHooks,
  how: string,
  limits: FolderLimits,
): Promise<FolderFiles> {
  let root: string;
  let anchor: string;
  try {
    root = await realpath(source.root);
    anchor = source.anchor ? await realpath(source.anchor) : root;
  } catch {
    return { error: `${source.where[0]?.toUpperCase()}${source.where.slice(1)} isn’t there any more.` };
  }
  // Reached from its anchor through no link (a step folder a command swapped for one leads nowhere).
  if (source.anchor && root !== join(anchor, relative(source.anchor, source.root)))
    return { error: `${dir} leads outside ${source.where}.` };
  const path = previewPath({ ...source, aliases: [...(source.aliases ?? []), root] }, dir);
  if ('error' in path) return path;
  let folder: string;
  try {
    folder = await realpath(resolve(root, path.rel));
  } catch {
    return { error: noFolder(dir, source, how) };
  }
  if (folder !== root && !folder.startsWith(root + sep))
    return { error: `${dir} leads outside ${source.where}.` };
  if (!(await lstat(folder)).isDirectory()) return { error: `${dir} is not a folder.` };
  const read = existsSync(PROC_FD) ? readByFd : readByPath;
  return read(anchor, relative(anchor, folder), dir, source, hooks, how, limits);
}

/** The files gathered so far and the caps. */
class Gathered {
  readonly files: FolderFile[] = [];
  bytes = 0;
  constructor(
    readonly dir: string,
    readonly limits: FolderLimits,
  ) {}
  /** Room for one more file of `size` bytes, or why not. */
  room(size: number): string | null {
    if (this.files.length >= this.limits.files) return this.limits.tooMany(this.dir);
    if (this.bytes + size > this.limits.bytes) return this.limits.tooLarge(this.dir);
    return null;
  }
  /** What is left of the bytes allowed. */
  get left(): number {
    return this.limits.bytes - this.bytes;
  }
  add(path: string, data: Buffer): string | null {
    this.bytes += data.length;
    if (this.bytes > this.limits.bytes) return this.limits.tooLarge(this.dir);
    this.files.push({ path, bytes: data });
    return null;
  }
  result(): FolderFiles {
    if (this.files.length === 0) return { error: this.limits.empty(this.dir) };
    return { files: this.files };
  }
}

const sorted = <T extends { name: string }>(entries: T[]) =>
  entries.sort((a, b) => a.name.localeCompare(b.name));
const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

/** At most `max` bytes of an open file (one that grows while it is read stops there). */
async function readUpTo(fh: FileHandle, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= max) {
    const want = Math.min(256 * 1024, max + 1 - total);
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(want), 0, want, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks);
}

/**
 * The race-free read (Linux): the folder is opened one component at a time from the root (or its anchor), every entry
 * relative to its open directory, never through a link — whatever the commands change meanwhile, nothing outside the
 * folder is read.
 */
async function readByFd(
  root: string,
  rel: string,
  dir: string,
  source: PreviewSource,
  hooks: PreviewReadHooks,
  how: string,
  limits: FolderLimits,
): Promise<FolderFiles> {
  let at: FileHandle;
  try {
    at = await open(root, DIR_FLAGS);
  } catch {
    return { error: `${dir} can’t be read in ${source.where}.` };
  }
  for (const part of rel.split(sep).filter((p) => p && p !== '.')) {
    await hooks.beforeOpen?.(part);
    const parent = at;
    try {
      at = await open(`${PROC_FD}/${parent.fd}/${part}`, DIR_FLAGS);
    } catch (err) {
      // A link refuses as ENOTDIR or ELOOP, like a file: which one it is, only for the words.
      const link = await lstat(`${PROC_FD}/${parent.fd}/${part}`).then(
        (st) => st.isSymbolicLink(),
        () => false,
      );
      await parent.close();
      return {
        error:
          code(err) === 'ENOENT'
            ? noFolder(dir, source, how)
            : link
              ? `${dir} leads outside ${source.where}.`
              : `${dir} is not a folder.`,
      };
    }
    await parent.close();
  }
  const got = new Gathered(dir, limits);
  const walk = async (fh: FileHandle, prefix: string): Promise<string | null> => {
    const entries = sorted(await readdir(`${PROC_FD}/${fh.fd}`, { withFileTypes: true }));
    for (const e of entries) {
      if (e.name === '.git' || e.isSymbolicLink()) continue;
      const path = prefix ? posix.join(prefix, e.name) : e.name;
      if (e.isDirectory()) {
        await hooks.beforeOpen?.(e.name);
        // Swapped for a link (or gone) since it was listed: skipped like a link.
        const sub = await open(`${PROC_FD}/${fh.fd}/${e.name}`, DIR_FLAGS).catch(() => null);
        if (!sub) continue;
        try {
          const problem = await walk(sub, path);
          if (problem) return problem;
        } finally {
          await sub.close();
        }
        continue;
      }
      if (!e.isFile()) continue;
      const full = got.room(0);
      if (full) return full;
      await hooks.beforeOpen?.(e.name);
      let file: FileHandle;
      try {
        file = await open(`${PROC_FD}/${fh.fd}/${e.name}`, FILE_FLAGS);
      } catch (err) {
        if (code(err) === 'EACCES') return `${dir}/${path} can’t be read (permission denied).`;
        continue;
      }
      try {
        const st = await file.stat();
        if (!st.isFile()) continue;
        const problem = got.room(st.size) ?? got.add(path, await readUpTo(file, got.left));
        if (problem) return problem;
      } finally {
        await file.close();
      }
    }
    return null;
  };
  try {
    const problem = await walk(at, '');
    if (problem) return { error: problem };
  } finally {
    await at.close();
  }
  return got.result();
}

/** Where `/proc/self/fd` isn't (not Linux): by path, each file opened without following a link. */
async function readByPath(
  root: string,
  rel: string,
  dir: string,
  _source: PreviewSource,
  hooks: PreviewReadHooks,
  _how: string,
  limits: FolderLimits,
): Promise<FolderFiles> {
  const folder = join(root, rel);
  const got = new Gathered(dir, limits);
  const walk = async (at: string): Promise<string | null> => {
    for (const e of sorted(await readdir(at, { withFileTypes: true }))) {
      if (e.name === '.git' || e.isSymbolicLink()) continue;
      const path = join(at, e.name);
      if (e.isDirectory()) {
        const problem = await walk(path);
        if (problem) return problem;
        continue;
      }
      if (!e.isFile()) continue;
      const full = got.room(0);
      if (full) return full;
      await hooks.beforeOpen?.(e.name);
      const file = await open(path, FILE_FLAGS).catch(() => null);
      if (!file) continue;
      try {
        const st = await file.stat();
        if (!st.isFile()) continue;
        const shown = relative(folder, path).split(sep).join('/');
        const problem = got.room(st.size) ?? got.add(shown, await readUpTo(file, got.left));
        if (problem) return problem;
      } finally {
        await file.close();
      }
    }
    return null;
  };
  const problem = await walk(folder);
  if (problem) return { error: problem };
  return got.result();
}
