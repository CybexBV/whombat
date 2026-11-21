/**
 * Reading a backup's folders as the backup service opened them (docs/decisions/backup-look.md): read-only, and with the
 * symlinks the backup had kept as they were — they may point anywhere on the box, so none is ever followed. Every step
 * from the root down is checked to be a real directory, and a file is opened with `O_NOFOLLOW`.
 */
import { constants, createReadStream } from 'node:fs';
import { type FileHandle, lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** A path segment that can't climb out or name a hidden trick (`..`, `.`, empty, a slash). */
function safeSegment(s: string): boolean {
  return s.length > 0 && s.length <= 255 && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\0');
}

/**
 * The directory `segments` names under `root`, when every step is a real directory (no symlink anywhere, the root
 * included); null when something on the way is missing or isn't one.
 */
export async function dirInside(root: string, segments: readonly string[]): Promise<string | null> {
  if (!segments.every(safeSegment)) return null;
  let path = root;
  for (const step of ['', ...segments]) {
    path = step ? join(path, step) : path;
    const s = await lstat(path).catch(() => null);
    if (!s || s.isSymbolicLink() || !s.isDirectory()) return null;
  }
  return path;
}

/** Opens the regular file `segments` names under `root` without following a symlink; null when there is none. */
export async function openInside(root: string, segments: readonly string[]): Promise<FileHandle | null> {
  if (segments.length === 0 || !segments.every(safeSegment)) return null;
  const dir = await dirInside(root, segments.slice(0, -1));
  if (!dir) return null;
  let fh: FileHandle;
  try {
    fh = await open(join(dir, segments.at(-1) as string), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  const s = await fh.stat().catch(() => null);
  if (!s?.isFile()) {
    await fh.close();
    return null;
  }
  return fh;
}

/** The bytes of a regular file under `root` (as `openInside`), streamed; null when there is none. */
export async function readInside(
  root: string,
  segments: readonly string[],
): Promise<{ size: number; stream: AsyncIterable<Uint8Array> } | null> {
  const fh = await openInside(root, segments);
  if (!fh) return null;
  const size = (await fh.stat()).size;
  // The stream owns the handle (closed at its end, or when it is destroyed).
  return { size, stream: createReadStream('', { fd: fh, autoClose: true }) as AsyncIterable<Uint8Array> };
}

export interface InsideFile {
  /** Its path relative to the walk's start, with `/`. */
  rel: string;
  path: string;
  size: number;
  mtime: number;
  exec: boolean;
}

/**
 * Every regular file under the real directory `dir` (found with `dirInside`), depth first in name order; symlinks,
 * sockets and the like are skipped, never followed. `want` decides by the relative path, `enter` whether to look inside
 * a directory.
 */
export async function filesUnder(
  dir: string,
  want: (rel: string) => boolean,
  enter: (rel: string) => boolean = () => true,
): Promise<InsideFile[]> {
  const out: InsideFile[] = [];
  const walk = async (path: string, rel: string) => {
    const names = (await readdir(path).catch(() => [] as string[])).sort();
    for (const name of names) {
      if (!safeSegment(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const child = join(path, name);
      const s = await lstat(child).catch(() => null);
      if (!s || s.isSymbolicLink()) continue;
      if (s.isDirectory()) {
        if (enter(childRel)) await walk(child, childRel);
      } else if (s.isFile() && want(childRel))
        out.push({
          rel: childRel,
          path: child,
          size: s.size,
          mtime: Math.floor(s.mtimeMs / 1000),
          exec: (s.mode & 0o100) !== 0,
        });
    }
  };
  await walk(dir, '');
  return out;
}
