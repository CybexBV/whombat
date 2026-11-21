/**
 * Files on the phone through the appliance session (AP-13, AP-12): uploads read the picked file by offset
 * through an expo-file-system file handle (one chunk in JS memory at a time — never the whole file, never
 * base64), and resources are streamed from the session into cache files that `<Image>` and the share sheet open
 * (`file://`), namespaced by cache scope so a sign-out or revocation deletes them all.
 *
 * The native file API is injected (`FileApi`) so the logic is unit-tested in Node.
 */
import type { ApplianceSession, ChunkSource, ResourceRef } from '@whombat/client/session';
import { resourceKey } from '@whombat/client/session';

export interface FileHandleLike {
  offset: number | null;
  readBytes(length: number): Uint8Array;
  writeBytes(bytes: Uint8Array): void;
  close(): void;
}

export interface FileApi {
  /** Opens `uri` for reading (`r`) or truncating write (`w`). */
  open(uri: string, mode: 'r' | 'w'): FileHandleLike;
  exists(uri: string): boolean;
  /** Creates the directory (and parents); no-op when it exists. */
  mkdir(uri: string): void;
  /** Deletes a file or directory tree; no-op when absent. */
  remove(uri: string): void;
  /** Moves a file to `to` (replacing it). */
  move(from: string, to: string): Promise<void>;
  /** The app's cache directory URI (ends with `/`). */
  cacheDir(): string;
}

/** A `ChunkSource` over a local file: the handle opens on the first read, seeks, reads `length` bytes. */
export function fileChunkSource(
  api: FileApi,
  file: { uri: string; name: string; type: string; size: number },
): ChunkSource & { close(): void } {
  let handle: FileHandleLike | null = null;
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    async read(offset, length) {
      handle ??= api.open(file.uri, 'r');
      handle.offset = offset;
      const bytes = handle.readBytes(length);
      if (bytes.byteLength !== length) throw new Error('The file changed while uploading.');
      return bytes;
    },
    close() {
      handle?.close();
      handle = null;
    },
  };
}

const ROOT = 'whombat-resources/';

function safe(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function cachePaths(api: FileApi, ref: ResourceRef, options: { scope: string; name: string }) {
  const dir = `${api.cacheDir()}${ROOT}${safe(options.scope)}/${safe(resourceKey(ref))}/`;
  return { dir, target: `${dir}${safe(options.name) || 'file'}` };
}

/** The directory a resource's cache files are in: removing it drops them (a thing page's old pictures, AP-4652). */
export function resourceCacheDir(api: FileApi, ref: ResourceRef, scope: string): string {
  return cachePaths(api, ref, { scope, name: '' }).dir;
}

/** The resource's complete cache file when it is already there (no request), else null. */
export function cachedResourceFile(
  api: FileApi,
  ref: ResourceRef,
  options: { scope: string; name: string },
): string | null {
  const { target } = cachePaths(api, ref, options);
  return api.exists(target) ? target : null;
}

/**
 * Streams a resource into `cache/whombat-resources/<scope>/<key>/<name>` and returns its `file://` URI. An
 * existing complete file is reused. Written to a `.part` first so a cut-off download is never mistaken for a
 * complete one.
 */
export async function resourceToCacheFile(
  api: FileApi,
  session: ApplianceSession,
  ref: ResourceRef,
  options: { scope: string; name: string; signal?: AbortSignal; maxBytes?: number },
): Promise<string> {
  const { dir, target } = cachePaths(api, ref, options);
  if (api.exists(target)) return target;
  api.mkdir(dir);
  const part = `${target}.part`;
  const stream = await session.openResource(ref, options.signal ? { signal: options.signal } : {});
  const out = api.open(part, 'w');
  let written = 0;
  try {
    for await (const chunk of stream.chunks) {
      written += chunk.byteLength;
      if (options.maxBytes !== undefined && written > options.maxBytes) {
        stream.cancel();
        throw new Error('This file is too large to open here.');
      }
      out.writeBytes(chunk);
    }
  } catch (error) {
    out.close();
    api.remove(part);
    throw error;
  }
  out.close();
  await api.move(part, target);
  return target;
}

/**
 * Streams `[start, end)` of a resource into the file `target` in the directory `dir` (a file of a page set, shared from
 * its viewer) and returns its URI: exactly that many bytes, through a `.part` file, or the copy is removed and the
 * download refused.
 */
export async function rangeToFile(
  api: FileApi,
  session: ApplianceSession,
  ref: ResourceRef,
  range: { start: number; end: number },
  where: { dir: string; target: string; signal?: AbortSignal },
): Promise<string> {
  const want = range.end - range.start;
  api.mkdir(where.dir);
  const part = `${where.target}.part`;
  const stream = await session.openResource(ref, {
    range,
    ...(where.signal ? { signal: where.signal } : {}),
  });
  const out = api.open(part, 'w');
  let written = 0;
  try {
    for await (const chunk of stream.chunks) {
      written += chunk.byteLength;
      if (written > want) {
        stream.cancel();
        throw new Error('The download wasn’t the file.');
      }
      out.writeBytes(chunk);
    }
    if (written !== want) throw new Error('The download was cut short.');
  } catch (error) {
    out.close();
    api.remove(part);
    throw error;
  }
  out.close();
  await api.move(part, where.target);
  return where.target;
}

/** Deletes every cached resource (sign-out, revocation, account or appliance switch: AP-17). */
export function clearResourceFiles(api: FileApi): void {
  api.remove(`${api.cacheDir()}${ROOT}`);
}
