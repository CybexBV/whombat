/**
 * Attachment previews (docs/decisions/managed-runtime.md MR-14; CT-21): a real, bounded-size thumbnail of a PNG or
 * JPEG attachment, decoded and re-encoded by the image worker (`feedback/image-worker.ts`, one job at a time, off
 * the event loop and heap), never the original under another name. Other types, and images too large for the
 * worker's budget, have no preview (`variant_unavailable`).
 *
 * Since contracts 0.55 (docs/decisions/review-features.md RF-04, CT-298) the preview is the attachment's thumbnail:
 * `THUMBNAIL_MAX_EDGE` (720) on its longest side, made at upload for images larger than that (`thumbnails.ts`), served
 * over REST at `…/attachments/:id/thumbnail` and over a session as the download's `preview` variant.
 *
 * Cache: content-addressed by the source bytes. `$files/previews/<ab>/<source sha256>-<edge>.<png|jpg>`, written
 * once (temp file + rename) and reused by every attachment with those bytes; it goes with its source blob
 * (`removePreviews` when the blob is deleted, and the attachment sweep's `sweepPreviews`, which also drops previews of
 * another edge).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FEEDBACK_IMAGE_MAX_PIXELS, THUMBNAIL_MAX_EDGE } from '@whombat/core';
import type { ImageRunner } from '../feedback/image-pool';
import { sniffBuffer } from './sniff';
import { blobKey, type FileStore } from './store';

/** A preview fits this many pixels a side: the thumbnail's edge (CT-298). */
export const PREVIEW_MAX_EDGE = THUMBNAIL_MAX_EDGE;
/** Sources above this are refused (the worker's decode budget, as for feedback screenshots). */
export const PREVIEW_MAX_SOURCE_PIXELS = FEEDBACK_IMAGE_MAX_PIXELS;
/** Sources above this many bytes aren't read into memory for a preview. */
export const PREVIEW_MAX_SOURCE_BYTES = 32 * 1024 * 1024;

const SHA = /^[0-9a-f]{64}$/;
const NAME = /^([0-9a-f]{64})-(\d+)\.(png|jpg)$/;

export interface PreviewSource {
  sha256: string;
  blobKey: string;
  contentType: string;
  width: number | null;
  height: number | null;
  size: number;
  /**
   * The picture's bytes when they aren't the whole blob (a page set's cover, docs/decisions/page-sets.md): its preview
   * is still kept under the blob's own sha256.
   */
  read?: () => Promise<Buffer | null>;
}

export interface Preview {
  bytes: Buffer;
  contentType: 'image/png' | 'image/jpeg';
  /** Its pixel size (null only if its own header can't be read, which the worker never writes). */
  width: number | null;
  height: number | null;
}

/** A preview of these bytes, with the size its header says. */
function preview(bytes: Buffer, contentType: 'image/png' | 'image/jpeg'): Preview {
  const sniffed = sniffBuffer(bytes, contentType === 'image/png' ? 'preview.png' : 'preview.jpg');
  const dims = sniffed.ok ? sniffed.value : null;
  return { bytes, contentType, width: dims?.width ?? null, height: dims?.height ?? null };
}

export type PreviewResult =
  | { ok: true; preview: Preview }
  | { ok: false; reason: 'unsupported' | 'too_large' | 'failed' };

export function previewPath(root: string, sha256: string, contentType: 'image/png' | 'image/jpeg'): string {
  if (!SHA.test(sha256)) throw new Error('not a sha256');
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  return join(root, 'previews', sha256.slice(0, 2), `${sha256}-${PREVIEW_MAX_EDGE}.${ext}`);
}

/** A whole blob, or null when it is missing. */
export async function readAll(store: FileStore, key: string): Promise<Buffer | null> {
  const stream = await store.open(key);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The preview of an attachment, from the cache or made now. */
export async function attachmentPreview(options: {
  filesRoot: string;
  store: FileStore;
  images: ImageRunner;
  source: PreviewSource;
}): Promise<PreviewResult> {
  const { source } = options;
  const type =
    source.contentType === 'image/png' || source.contentType === 'image/jpeg' ? source.contentType : null;
  if (!type || !source.width || !source.height) return { ok: false, reason: 'unsupported' };
  if (source.width * source.height > PREVIEW_MAX_SOURCE_PIXELS || source.size > PREVIEW_MAX_SOURCE_BYTES)
    return { ok: false, reason: 'too_large' };
  const path = previewPath(options.filesRoot, source.sha256, type);
  const cached = await readFile(path).catch(() => null);
  if (cached) return { ok: true, preview: preview(cached, type) };
  const original = source.read ? await source.read() : await readAll(options.store, source.blobKey);
  if (!original) return { ok: false, reason: 'failed' };
  let bytes: Buffer;
  try {
    const out = await options.images.run({
      bytes: original,
      contentType: type,
      width: source.width,
      height: source.height,
      maxPixels: PREVIEW_MAX_SOURCE_PIXELS,
      thumbnailMaxEdge: PREVIEW_MAX_EDGE,
    });
    bytes = out.bytes;
  } catch {
    return { ok: false, reason: 'failed' };
  }
  await mkdir(join(options.filesRoot, 'previews', source.sha256.slice(0, 2)), {
    recursive: true,
    mode: 0o700,
  });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, path).catch(async () => {
    await rm(tmp, { force: true });
  });
  return { ok: true, preview: preview(bytes, type) };
}

/** Removes the previews of a blob's bytes (its blob was just deleted). */
export async function removePreviews(root: string, sha256: string): Promise<void> {
  if (!SHA.test(sha256)) return;
  const dir = join(root, 'previews', sha256.slice(0, 2));
  for (const name of await readdir(dir).catch(() => [] as string[]))
    if (name.startsWith(`${sha256}-`)) await rm(join(dir, name), { force: true });
}

/** Removes previews whose source blob is no longer in the store. Returns how many. */
export async function sweepPreviews(filesRoot: string, store: FileStore): Promise<number> {
  const top = join(filesRoot, 'previews');
  let removed = 0;
  for (const dir of await readdir(top).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(dir)) continue;
    for (const name of await readdir(join(top, dir)).catch(() => [] as string[])) {
      const path = join(top, dir, name);
      const m = NAME.exec(name);
      if (!m) {
        // A temp file a crash left behind.
        const info = await stat(path).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 3_600_000) await rm(path, { force: true });
        continue;
      }
      // Gone with its blob, or made at another edge (before the thumbnail's 720, RF-04).
      if (m[2] !== String(PREVIEW_MAX_EDGE) || (await store.size(blobKey(m[1] as string))) === null) {
        await rm(path, { force: true });
        removed++;
      }
    }
  }
  return removed;
}
