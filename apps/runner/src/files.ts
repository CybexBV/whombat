/**
 * A turn's copy of its conversation's Files (docs/decisions/files-space.md FS-09; as built FS-R01…FS-R07). The runner
 * plans what fits (`planTurnFiles`: newest first, per-file and total bounds), fetches each file once into its private
 * cache by sha256 (`FilesCache`, the same fetch and checks as attachments), and lays the files out for a turn with
 * commands as a tree `<folder>/<name>` of its own, `<workspaces>/.scratch/turn-tree-<dispatch>-<attempt>` (0700,
 * hardlinks into the cache, a copy across file systems), which the turn's commands get read-only at `~/files`
 * (`turnBinds`) — the read-only bind keeps them from writing it (or the cache through a hardlink).
 *
 * The tree goes when the turn ends (`release`), and `.scratch` is swept with the
 * other turn directories after a crash (`WorkspaceManager.cleanup`).
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { planTurnFiles, type TurnFilesPlan } from '@whombat/agent-runtime';
import type { DispatchContext, FileRef } from '@whombat/core';
import { leaseOf, type RunnerApi } from './api';
import { treeFileName } from './attachments';
import type { FilesCache } from './files-cache';

/** Folder segments a tree keeps (FS-03 allows 4); deeper ones are joined into the last. */
const MAX_DEPTH = 4;

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** One folder segment as a directory name: the `treeFileName` cleaning, never `.` or `..`, never empty. */
function segmentName(segment: string): string {
  const clean = treeFileName(segment, 'folder', new Set());
  return clean === '.' || clean === '..' || !clean ? '_' : clean;
}

/**
 * Each file's path in the tree (FS-09): `<folder>/<name>`, folders as people made them (compared case-insensitively, the
 * first spelling kept, FS-03), names as `treeFileName` gives them — de-duplicated per folder, never the name of a
 * folder beside them, in the order given (newest first: the newest file keeps the plain name).
 */
export function filesTreePaths(refs: readonly FileRef[]): Map<string, string> {
  /** A directory's lower-cased path → its path as first spelled. */
  const dirs = new Map<string, string>([['', '']]);
  /** Per directory (lower-cased path): the names taken in it, lower case. */
  const taken = new Map<string, Set<string>>([['', new Set()]]);
  const dirOf = (folder: string): string => {
    const parts = folder
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .map(segmentName);
    if (parts.length > MAX_DEPTH)
      parts.splice(MAX_DEPTH - 1, parts.length, parts.slice(MAX_DEPTH - 1).join('-'));
    let key = '';
    for (const part of parts) {
      const child = key ? `${key}/${part.toLowerCase()}` : part.toLowerCase();
      if (!dirs.has(child)) {
        dirs.set(child, `${dirs.get(key) ? `${dirs.get(key)}/` : ''}${part}`);
        taken.set(child, new Set());
        // The folder's name is taken in its parent: no file may be called like it.
        taken.get(key)?.add(part.toLowerCase());
      }
      key = child;
    }
    return key;
  };
  // Folders first, so a file never takes a folder's name, whatever the order.
  const keys = refs.map((r) => dirOf(r.folder));
  const out = new Map<string, string>();
  refs.forEach((ref, i) => {
    const key = keys[i] as string;
    const names = taken.get(key) as Set<string>;
    const name = treeFileName(ref.name, ref.id, names);
    names.add(name.toLowerCase());
    const dir = dirs.get(key) ?? '';
    out.set(ref.id, dir ? `${dir}/${name}` : name);
  });
  return out;
}

/** Where a commands turn's tree goes (in the workspaces root, which guarded sandboxes deny; swept after a crash). */
export function turnTreeDir(workspacesRoot: string, ctx: DispatchContext): string {
  return join(workspacesRoot, '.scratch', `turn-tree-${safe(ctx.dispatch.id)}-${ctx.dispatch.attempts ?? 0}`);
}

/** Streams one file of the conversation to `path` (0600, never following links), checking size and sha256. */
export async function fetchFileTo(
  api: Required<Pick<RunnerApi, 'fetchAttachment'>>,
  ctx: DispatchContext,
  ref: Pick<FileRef, 'id' | 'size' | 'sha256'>,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await api.fetchAttachment(ctx.dispatch.id, ref.id, leaseOf(ctx), signal);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > ref.size) throw new Error(`${ref.id}: more bytes than the file has`);
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  if (size !== ref.size || hash.digest('hex') !== ref.sha256)
    throw new Error(`${ref.id}: the bytes do not match their size and sha256`);
}

export interface TurnConversationFiles {
  plan: TurnFilesPlan;
  /** Where the tree is: the commands turn's own directory. */
  dir: string;
  /** File id → its path in the tree (`Drawings/plan.skp`), for the files that are there. */
  paths: Map<string, string>;
  /** Planned files that couldn't be fetched or placed. */
  unavailable: FileRef[];
  /** Bytes that are there. */
  bytes: number;
  /** Removes the turn's tree. */
  release(): Promise<void>;
}

/** At most this many fetches at once (one turn's). */
const FETCH_PARALLEL = 3;

/**
 * Lays a commands turn's Files out (FS-09, at `~/files`): its own tree of hardlinks (copies across file systems). Null
 * when the conversation has no Files, the server sent none, or nothing fits. A file that can't be fetched or placed is left out
 * and named; only a stopped turn throws.
 */
export async function prepareConversationFiles(
  ctx: DispatchContext,
  deps: {
    api: RunnerApi;
    cache: FilesCache;
    workspacesRoot: string;
    log?: (level: 'warn', msg: string, extra?: Record<string, unknown>) => void;
  },
  signal?: AbortSignal,
): Promise<TurnConversationFiles | null> {
  const plan = planTurnFiles(ctx.files);
  const fetchAttachment = deps.api.fetchAttachment?.bind(deps.api);
  if (!plan?.included.length || !fetchAttachment) return null;
  const dir = turnTreeDir(deps.workspacesRoot, ctx);
  const release = () => rm(dir, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const wanted = filesTreePaths(plan.included);
  const paths = new Map<string, string>();
  const unavailable: FileRef[] = [];
  let bytes = 0;
  const place = async (ref: FileRef) => {
    const rel = wanted.get(ref.id) as string;
    const target = join(dir, rel);
    let held: Awaited<ReturnType<FilesCache['get']>> | null = null;
    try {
      held = await deps.cache.get(ref, (tmp) => fetchFileTo({ fetchAttachment }, ctx, ref, tmp, signal));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      // The same bytes, read-only for the commands: a hardlink, or a copy where the tree is on another file system.
      await link(held.path, target).catch(() =>
        copyFile(held?.path as string, target, constants.COPYFILE_EXCL),
      );
      paths.set(ref.id, rel);
      bytes += ref.size;
    } catch (err) {
      await rm(target, { force: true }).catch(() => {});
      if (signal?.aborted) throw err;
      unavailable.push(ref);
      deps.log?.('warn', `file ${ref.id} isn’t in this turn’s Files: ${String(err)}`, {
        dispatchId: ctx.dispatch.id,
      });
    } finally {
      // The tree holds its own link (or copy): the cache may evict the file again once no fetch needs it.
      held?.release();
    }
  };
  try {
    const queue = [...plan.included];
    await Promise.all(
      Array.from({ length: Math.min(FETCH_PARALLEL, queue.length) }, async () => {
        for (let ref = queue.shift(); ref; ref = queue.shift()) await place(ref);
      }),
    );
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  // The order of the plan (newest first), whatever order the fetches finished in.
  const ordered = new Map(
    plan.included.filter((r) => paths.has(r.id)).map((r) => [r.id, paths.get(r.id) as string]),
  );
  const missing = new Set(unavailable.map((r) => r.id));
  return {
    plan,
    dir,
    paths: ordered,
    unavailable: plan.included.filter((r) => missing.has(r.id)),
    bytes,
    release,
  };
}
