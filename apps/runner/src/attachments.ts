/**
 * A turn's attachments (docs/decisions/bp-attachments.md BP-A09; BP-04): the runner plans what the provider
 * can use, fetches those bytes through the runner protocol (lease + the server's re-check), verifies size and
 * sha256, and keeps them in a per-turn directory it owns — `<workspaces>/.scratch/turn-files-<dispatch>-<n>`,
 * 0700, inside the workspaces root every task sandbox denies — deleted when the turn ends (and swept with
 * the scratch dirs after a crash). The agent never gets the path: images and PDFs reach the model as input,
 * text as a delimited excerpt in the prompt, the rest as an honest line. A file that is in the conversation's Files at
 * `~/files` for the turn's commands (files-space.md FS-09) has its path there in place of “you can’t open this type”
 * (FS-10).
 *
 * Checked bytes are kept by sha256 in the runner's files cache (`FilesCache`, the conversations' Files' own; turn-
 * efficiency.md TE-09): a file a turn needs again — the next attempt, the next turn of the thread — is linked from there
 * into the turn's directory instead of fetched and hashed again.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ATTACHMENT_LIMITS,
  attachmentSection,
  needsBytes,
  type PlannedAttachment,
  type ProviderCapabilities,
  planAttachments,
  type TurnAttachment,
} from '@whombat/agent-runtime';
import type { DispatchContext } from '@whombat/core';
import { leaseOf, type RunnerApi } from './api';
import type { FilesCache } from './files-cache';

export interface TurnFiles {
  /** What the provider takes as model input (images, documents) or reads by exact path (text). */
  attachments: TurnAttachment[];
  /** Appended to the prompt (empty without attachments). */
  section: string;
  planned: PlannedAttachment[];
  release(): Promise<void>;
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** How long a copy's name may be, in bytes of UTF-8 (a file name has 255 at most on the file systems we run on). */
export const SCRATCH_NAME_BYTES = 120;

/** The longest start of `text` that fits in `max` bytes of UTF-8, cut between characters. */
function cutBytes(text: string, max: number): string {
  let out = '';
  let bytes = 0;
  for (const c of text) {
    const n = Buffer.byteLength(c);
    if (bytes + n > max) break;
    out += c;
    bytes += n;
  }
  return out;
}

/**
 * A file's name in a turn's Files tree (skills-library.md SL-D23, SL-D57; files-space.md FS-09): its own name without
 * separators, control characters or a leading dot (no hidden or `..` names), at most `SCRATCH_NAME_BYTES` bytes of
 * UTF-8; its id first when another file took the name, then a number as well until the name is free. `taken` holds the
 * names given so far in lower case (a case-insensitive file system would see `Q3.csv` and `q3.csv` as one).
 */
export function treeFileName(name: string, id: string, taken: ReadonlySet<string>): string {
  const plain = [...name].map((c) =>
    c.charCodeAt(0) < 0x20 || c === '\x7f' || c === '/' || c === '\\' ? '_' : c,
  );
  const clean =
    cutBytes(
      plain
        .join('')
        .replace(/^[.\s]+/, '')
        .trim(),
      SCRATCH_NAME_BYTES,
    ).trimEnd() || safe(id);
  const free = (candidate: string) => !taken.has(candidate.toLowerCase());
  if (free(clean)) return clean;
  const prefix = safe(id).slice(0, 40);
  for (let n = 1; ; n++) {
    const head = n === 1 ? `${prefix}-` : `${prefix}-${n}-`;
    const candidate = `${head}${cutBytes(clean, SCRATCH_NAME_BYTES - Buffer.byteLength(head))}`;
    if (free(candidate)) return candidate;
  }
}

/** Where a turn's files go (inside the workspaces root, which every task sandbox denies). */
export function turnFilesDir(workspacesRoot: string, ctx: DispatchContext): string {
  return join(
    workspacesRoot,
    '.scratch',
    `turn-files-${safe(ctx.dispatch.id)}-${ctx.dispatch.attempts ?? 0}`,
  );
}

/** Streams one attachment to `path` (0600, never following links), checking size and sha256. */
async function fetchTo(
  api: Required<Pick<RunnerApi, 'fetchAttachment'>>,
  ctx: DispatchContext,
  p: PlannedAttachment,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await api.fetchAttachment(ctx.dispatch.id, p.ref.id, leaseOf(ctx), signal);
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
      if (size > p.ref.size) throw new Error(`${p.ref.id}: more bytes than the attachment has`);
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  const sha256 = hash.digest('hex');
  if (size !== p.ref.size || sha256 !== p.ref.sha256)
    throw new Error(`${p.ref.id}: the bytes do not match their size and sha256`);
}

/** The start of a text file as whole UTF-8 characters, and whether that is all of it. */
async function excerptOf(
  path: string,
  max: number,
  size: number,
): Promise<{ text: string; complete: boolean }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(Math.min(max, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let end = bytesRead;
    const complete = bytesRead >= size;
    if (!complete) {
      // Cut back to a character boundary.
      let i = end - 1;
      while (i > 0 && end - i < 4 && ((buffer[i] as number) & 0xc0) === 0x80) i--;
      const lead = buffer[i] as number;
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (i + need > end) end = i;
    }
    return { text: buffer.subarray(0, end).toString('utf8'), complete };
  } finally {
    await handle.close();
  }
}

export async function prepareTurnFiles(
  ctx: DispatchContext,
  deps: {
    api: RunnerApi;
    workspacesRoot: string;
    log?: (level: 'warn', msg: string, extra?: Record<string, unknown>) => void;
    /** Checked bytes by sha256, across attempts and turns (TE-09); without it every file is fetched. */
    filesCache?: FilesCache;
  },
  caps: ProviderCapabilities,
  signal?: AbortSignal,
  /** The conversation's Files this turn's commands have at `~/files` (FS-09): attachment id → `~/files/…`. */
  inFiles: ReadonlyMap<string, string> = new Map(),
): Promise<TurnFiles> {
  const planned = planAttachments(ctx, caps);
  const none: TurnFiles = { attachments: [], section: '', planned, release: async () => {} };
  if (!planned.length) return none;
  const wanted = planned.filter(needsBytes);
  const fetchAttachment = deps.api.fetchAttachment?.bind(deps.api);
  const attachments: TurnAttachment[] = [];
  const excerpts = new Map<string, { text: string; complete: boolean }>();
  const dir = turnFilesDir(deps.workspacesRoot, ctx);
  const release = () => rm(dir, { recursive: true, force: true });
  if (wanted.length && fetchAttachment) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let excerptBudget = ATTACHMENT_LIMITS.excerptTotalBytes;
    for (const p of wanted) {
      const path = join(dir, `${safe(p.ref.id)}.${EXT[p.ref.contentType] ?? 'txt'}`);
      try {
        const cache = deps.filesCache;
        if (cache) {
          // Linked (else copied) from the cache, which fetched and checked it once (TE-09).
          const held = await cache.get(p.ref, (tmp) => fetchTo({ fetchAttachment }, ctx, p, tmp, signal));
          try {
            await link(held.path, path).catch(() => copyFile(held.path, path, constants.COPYFILE_EXCL));
          } finally {
            held.release();
          }
        } else await fetchTo({ fetchAttachment }, ctx, p, path, signal);
      } catch (err) {
        await rm(path, { force: true });
        if (signal?.aborted) throw err;
        deps.log?.('warn', `attachment ${p.ref.id} could not be fetched: ${String(err)}`, {
          dispatchId: ctx.dispatch.id,
        });
        continue;
      }
      attachments.push({
        id: p.ref.id,
        name: p.ref.name,
        mediaType: p.ref.contentType,
        size: p.ref.size,
        kind: p.ref.kind,
        path,
      });
      if (p.delivery.mode === 'text' && excerptBudget > 0) {
        const excerpt = await excerptOf(
          path,
          Math.min(ATTACHMENT_LIMITS.excerptBytes, excerptBudget),
          p.ref.size,
        );
        excerptBudget -= Buffer.byteLength(excerpt.text);
        excerpts.set(p.ref.id, excerpt);
      }
    }
  }
  return {
    attachments,
    section: attachmentSection(planned, attachments, excerpts, inFiles),
    planned,
    release,
  };
}
