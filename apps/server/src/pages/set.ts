/**
 * A page set's file on the server (docs/decisions/page-sets.md): checking what the runner sent before it is kept, and
 * reading Whombat's own entries (the manifest, the cover) out of a kept one by their byte ranges. The format is core's
 * (`@whombat/core` `text/pages.ts`).
 */
import {
  PAGES_COVER,
  PAGES_MANIFEST,
  PAGES_MAX_FILES,
  PageSetManifest,
  ZIP_DIRECTORY_MAX,
  ZIP_TAIL_BYTES,
  type ZipEntry,
  zipEnd,
  zipEntries,
  zipEntryData,
  zipEntryRange,
} from '@whombat/core';
import type { FileStore } from '../files/store';

/** The last bytes of an upload the check reads: the directory (at its largest), the manifest and some room. */
export const UPLOAD_TAIL_BYTES = ZIP_DIRECTORY_MAX + 64 * 1024;

/** Keeps the last `max` bytes of a stream that passes by, in the chunks it came in (at most one chunk more). */
export class Tail {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  constructor(readonly max: number) {}

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    while (this.#chunks.length > 1 && this.#bytes - (this.#chunks[0]?.length ?? 0) >= this.max) {
      this.#bytes -= this.#chunks.shift()?.length ?? 0;
    }
  }

  bytes(): Buffer {
    const all = Buffer.concat(this.#chunks);
    return all.length > this.max ? all.subarray(all.length - this.max) : all;
  }
}

export interface CheckedSet {
  manifest: PageSetManifest;
  entries: ZipEntry[];
}

/**
 * Whether the last bytes (`tail`) of a file of `size` bytes are a page set as the runner writes it: a directory within
 * the limits, `.whombat/pages.json` last and readable, the page it opens on in it, the cover there when it says so.
 */
export function checkPageSet(tail: Uint8Array, size: number): CheckedSet | { error: string } {
  const end = zipEnd(tail, size);
  if (!end) return { error: 'The runner sent something that isn’t a page set.' };
  const tailStart = size - tail.length;
  if (end.directoryOffset < tailStart) return { error: 'The page set’s directory is too large.' };
  if (end.count > PAGES_MAX_FILES + 2) return { error: `A page set has at most ${PAGES_MAX_FILES} files.` };
  const at = end.directoryOffset - tailStart;
  const entries = zipEntries(tail.subarray(at, at + end.directorySize), end);
  if (!Array.isArray(entries)) return { error: `The page set is damaged: ${entries.error}` };
  const last = entries.at(-1);
  if (last?.path !== PAGES_MANIFEST) return { error: 'The page set says nothing about itself.' };
  const range = zipEntryRange(last);
  if (range.start < tailStart) return { error: 'The page set’s manifest is too large.' };
  const data = zipEntryData(last, tail.subarray(range.start - tailStart, range.end - tailStart));
  if (!(data instanceof Uint8Array)) return { error: 'The page set’s manifest is damaged.' };
  let manifest: PageSetManifest;
  try {
    const parsed = PageSetManifest.safeParse(JSON.parse(Buffer.from(data).toString('utf8')));
    if (!parsed.success) return { error: 'The page set’s manifest is damaged.' };
    manifest = parsed.data;
  } catch {
    return { error: 'The page set’s manifest is damaged.' };
  }
  const paths = new Set(entries.map((e) => e.path));
  if (!paths.has(manifest.open)) return { error: `The page set has no ${manifest.open}.` };
  if (manifest.cover !== paths.has(PAGES_COVER)) return { error: 'The page set’s cover is missing.' };
  return { manifest, entries };
}

/** At most this many bytes of a kept set's end are read to find its cover. */
const STORED_TAIL_BYTES = ZIP_TAIL_BYTES;
/** A cover is a screenshot (`PREVIEW_SHOT_MAX_BYTES`). */
const COVER_MAX_BYTES = 4 * 1024 * 1024;

async function readRange(store: FileStore, key: string, start: number, end: number): Promise<Buffer | null> {
  if (end <= start) return Buffer.alloc(0);
  // The store's range is inclusive.
  const stream = await store.open(key, { start, end: end - 1 });
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A kept set's cover picture (PNG bytes), or null when it has none or it can't be read. */
export async function pageSetCover(
  store: FileStore,
  row: { blobKey: string | null; size: number },
): Promise<Buffer | null> {
  if (!row.blobKey) return null;
  const size = (await store.size(row.blobKey)) ?? row.size;
  const tailStart = Math.max(0, size - STORED_TAIL_BYTES);
  const tail = await readRange(store, row.blobKey, tailStart, size);
  if (!tail) return null;
  const end = zipEnd(tail, size);
  if (!end) return null;
  const directory =
    end.directoryOffset >= tailStart
      ? tail.subarray(end.directoryOffset - tailStart, end.directoryOffset - tailStart + end.directorySize)
      : await readRange(store, row.blobKey, end.directoryOffset, end.directoryOffset + end.directorySize);
  if (!directory) return null;
  const entries = zipEntries(directory, end);
  if (!Array.isArray(entries)) return null;
  const cover = entries.find((e) => e.path === PAGES_COVER);
  if (!cover || cover.size > COVER_MAX_BYTES) return null;
  const range = zipEntryRange(cover);
  const read = await readRange(store, row.blobKey, range.start, range.end);
  if (!read) return null;
  const data = zipEntryData(cover, read);
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data === null) return null;
  return readRange(store, row.blobKey, data.dataAt, data.dataAt + cover.size);
}
