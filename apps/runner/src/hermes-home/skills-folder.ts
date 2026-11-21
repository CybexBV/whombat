/**
 * A skill's folder on disk, as the skills area reads and writes it (hermes-engine.md HE-41): its regular files (never a
 * link), their hash, the front matter's name and description, and removing a folder.
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { chmod, lstat, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { HERMES_SKILL_FILES_MAX } from '@whombat/core';

/** One file of a folder. */
export interface FolderFile {
  /** Relative to the folder, `/`-separated. */
  path: string;
  bytes: number;
  exec: boolean;
  mtimeMs: number;
}

/** Folders a skill's own never counts (caches a script left behind). */
const NOT_CONTENT = new Set(['__pycache__', 'node_modules', '.git']);

/** A folder's regular files, sorted by path (links, sockets and caches left out); at most `max`. */
export async function folderFiles(dir: string, max = HERMES_SKILL_FILES_MAX * 4): Promise<FolderFile[]> {
  const out: FolderFile[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 6 || out.length >= max) return;
    let entries: Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!NOT_CONTENT.has(e.name)) await walk(p, depth + 1);
      } else if (e.isFile()) {
        const info = await stat(p).catch(() => null);
        if (info)
          out.push({
            path: relative(dir, p).split('\\').join('/'),
            bytes: info.size,
            exec: (info.mode & 0o111) !== 0,
            mtimeMs: info.mtimeMs,
          });
      }
    }
  };
  await walk(dir, 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A folder's content as one hash: sha256 over its files' sorted `path\0sha256\n` lines (hex). */
export async function folderHash(dir: string, files?: readonly FolderFile[]): Promise<string> {
  const list = files ?? (await folderFiles(dir));
  const lines: string[] = [];
  for (const f of list) {
    const sha = createHash('sha256')
      .update(await readFile(join(dir, f.path)))
      .digest('hex');
    lines.push(`${f.path}\u0000${sha}\n`);
  }
  return createHash('sha256').update(lines.join('')).digest('hex');
}

/** Whether a folder holds a `SKILL.md`. */
export async function isSkillFolder(dir: string): Promise<boolean> {
  const info = await lstat(join(dir, 'SKILL.md')).catch(() => null);
  return !!info?.isFile();
}

const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // YAML's own escapes: take the quotes off.
    }
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * `name` and `description` of a `SKILL.md`'s front matter: a plain, quoted or block (`>`, `|`) scalar; anything the
 * service can't read is left empty (Hermes reads the full YAML).
 */
export function skillHeader(text: string): { name: string; description: string } {
  const m = FRONT_MATTER.exec(text);
  const out = { name: '', description: '' };
  if (!m) return out;
  const lines = (m[1] ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i] ?? '');
    if (!kv) continue;
    const key = kv[1] as 'name' | 'description';
    let value = (kv[2] ?? '').trim();
    if (/^[>|][+-]?$/.test(value) || value === '') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '') !== '') {
        block.push((lines[++i] ?? '').trim());
      }
      value = block.join(value.startsWith('|') ? '\n' : ' ');
    } else value = unquote(value);
    out[key] = value;
  }
  return out;
}

/** A file to write into a folder. */
export interface NewFile {
  path: string;
  data: Buffer;
  exec: boolean;
}

/** A folder's files read back for writing elsewhere. */
export async function readFolder(dir: string): Promise<NewFile[]> {
  const out: NewFile[] = [];
  for (const f of await folderFiles(dir))
    out.push({ path: f.path, data: await readFile(join(dir, f.path)), exec: f.exec });
  return out;
}

/**
 * Makes a folder and everything in it writable by its owner (`deep`, else the folder alone) — HSK-S14: Hermes copies
 * its built-ins with the Nix store's modes, folders `r-x` and files `r--`, and removing or rewriting a file needs a
 * writable folder above it. Links are left alone.
 */
export async function makeWritable(path: string, deep = true): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  const want = info.isDirectory() ? 0o700 : 0o200;
  if ((info.mode & want) !== want) await chmod(path, (info.mode & 0o7777) | want);
  if (!deep || !info.isDirectory()) return;
  for (const name of await readdir(path).catch(() => [] as string[])) await makeWritable(join(path, name));
}

/** Removes a folder (writable first), then its parents while nothing but a category's description is left in them. */
export async function removeFolder(dir: string, stop: string): Promise<void> {
  await makeWritable(dirname(dir), false);
  await makeWritable(dir);
  await rm(dir, { recursive: true, force: true });
  await pruneEmptyParents(dirname(dir), stop);
}

/** Removes `dir` and its parents below `stop` while they hold nothing but a category's `DESCRIPTION.md`. */
export async function pruneEmptyParents(dir: string, stop: string): Promise<void> {
  let at = dir;
  while (at.startsWith(`${stop}/`) && at !== stop) {
    const left = await readdir(at).catch(() => null);
    if (!left || left.some((n) => n !== 'DESCRIPTION.md')) break;
    await makeWritable(dirname(at), false);
    await makeWritable(at);
    await rm(at, { recursive: true, force: true });
    at = dirname(at);
  }
}
