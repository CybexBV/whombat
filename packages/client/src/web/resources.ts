/**
 * Decrypted resources on the web (AP-12, AP-16): bytes streamed through the session become `blob:` object URLs
 * for `<img>` and for downloads. A bounded LRU (bytes), cleared — every URL revoked — when the cache scope
 * changes (account, appliance, permissions), on sign-out and on revocation.
 *
 * Safety: a `blob:` URL has the app's origin, so uploaded HTML/SVG must never be *navigated to* or put in an
 * `<iframe>`/`<object>`: only raster images are shown (`previewKind`), text is read as text, everything else
 * is only ever a download (`saveResource`: an `<a download>` click, which the browser treats as a download,
 * not a navigation). Object URLs are created with a neutral type for non-images so even an accidental
 * navigation renders nothing active.
 */
import {
  type ApplianceSession,
  type ClearReason,
  previewKind,
  type ResourceMeta,
  type ResourceRef,
  resourceKey,
  type ScopedCache,
  StreamError,
} from '../session';

export interface ObjectUrlEntry {
  url: string;
  meta: ResourceMeta;
  size: number;
}

export interface ObjectUrlCache extends ScopedCache {
  /**
   * An object URL for the resource (shared by every caller; don't revoke it yourself). A caller's `signal` stops its
   * own wait; the download stops only when every caller waiting for it has stopped.
   */
  get(ref: ResourceRef, options?: { signal?: AbortSignal; maxBytes?: number }): Promise<ObjectUrlEntry>;
  /** The object URL already held for the resource, without loading it (a photo drawn again shows at once). */
  peek(ref: ResourceRef): ObjectUrlEntry | undefined;
  /** Bytes held now. */
  size(): number;
}

const NEUTRAL = 'application/octet-stream';

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

/** A download callers share: it is cancelled once none of them waits for it any more. */
interface Pending {
  promise: Promise<ObjectUrlEntry>;
  controller: AbortController;
  waiting: number;
}

export function createObjectUrlCache(
  session: () => ApplianceSession,
  options: { maxBytes?: number; maxItemBytes?: number } = {},
): ObjectUrlCache {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxItemBytes = options.maxItemBytes ?? 32 * 1024 * 1024;
  const entries = new Map<string, ObjectUrlEntry>();
  const inflight = new Map<string, Pending>();
  let total = 0;
  let generation = 0;

  function evict() {
    for (const [key, e] of entries) {
      if (total <= maxBytes) break;
      entries.delete(key);
      total -= e.size;
      URL.revokeObjectURL(e.url);
    }
  }

  async function load(
    ref: ResourceRef,
    signal: AbortSignal | undefined,
    limit: number,
  ): Promise<ObjectUrlEntry> {
    try {
      return await loadOnce(ref, signal, limit);
    } catch (error) {
      // The connection under it dropped (a stuck one is closed and replaced, open-speed.md AP-4403): once more, on the
      // fresh one, rather than a picture that never comes.
      if (!(error instanceof StreamError && error.code === 'lost') || signal?.aborted) throw error;
      return loadOnce(ref, signal, limit);
    }
  }

  async function loadOnce(
    ref: ResourceRef,
    signal: AbortSignal | undefined,
    limit: number,
  ): Promise<ObjectUrlEntry> {
    const gen = generation;
    const stream = await session().openResource(ref, signal ? { signal } : {});
    if (stream.meta.size !== null && stream.meta.size > limit) {
      stream.cancel();
      throw new StreamError('too_large', 'This file is too large to open here.');
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream.chunks) {
      size += chunk.byteLength;
      if (size > limit) {
        stream.cancel();
        throw new StreamError('too_large', 'This file is too large to open here.');
      }
      parts.push(chunk);
    }
    const type = previewKind(stream.meta.contentType) === 'image' ? stream.meta.contentType : NEUTRAL;
    const blob = new Blob(parts as BlobPart[], { type });
    const url = URL.createObjectURL(blob);
    if (gen !== generation) {
      // The scope changed while downloading: this belongs to nobody any more.
      URL.revokeObjectURL(url);
      throw new StreamError('cancelled', 'The account or appliance changed.');
    }
    return { url, meta: stream.meta, size };
  }

  function leave(key: string, pending: Pending) {
    pending.waiting -= 1;
    if (pending.waiting > 0) return;
    if (inflight.get(key) === pending) inflight.delete(key);
    pending.controller.abort();
  }

  /** A caller's wait for a shared download: its own signal ends only its own wait. */
  function join(key: string, pending: Pending, signal: AbortSignal | undefined): Promise<ObjectUrlEntry> {
    if (signal?.aborted) return Promise.reject(abortError());
    pending.waiting += 1;
    if (!signal) return pending.promise;
    return new Promise<ObjectUrlEntry>((resolve, reject) => {
      const onAbort = () => {
        leave(key, pending);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.promise.then(
        (e) => {
          signal.removeEventListener('abort', onAbort);
          resolve(e);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  return {
    get(ref, getOptions = {}) {
      const key = resourceKey(ref);
      const hit = entries.get(key);
      if (hit) {
        // Most recently used goes last.
        entries.delete(key);
        entries.set(key, hit);
        return Promise.resolve(hit);
      }
      const pending = inflight.get(key);
      if (pending) return join(key, pending, getOptions.signal);
      if (getOptions.signal?.aborted) return Promise.reject(abortError());
      // The download has a signal of its own: the caller that started it may stop waiting while others still wait
      // (a picture drawn again, a message that moved).
      const controller = new AbortController();
      const shared: Pending = { promise: Promise.resolve() as never, controller, waiting: 0 };
      shared.promise = load(ref, controller.signal, getOptions.maxBytes ?? maxItemBytes).then(
        (e) => {
          if (inflight.get(key) === shared) inflight.delete(key);
          entries.set(key, e);
          total += e.size;
          evict();
          return e;
        },
        (error: unknown) => {
          if (inflight.get(key) === shared) inflight.delete(key);
          throw error;
        },
      );
      // Nobody may be left to hear how it ended.
      shared.promise.catch(() => {});
      inflight.set(key, shared);
      return join(key, shared, getOptions.signal);
    },
    peek: (ref) => entries.get(resourceKey(ref)),
    size: () => total,
    clear(_reason?: ClearReason) {
      generation += 1;
      for (const e of entries.values()) URL.revokeObjectURL(e.url);
      entries.clear();
      inflight.clear();
      total = 0;
    },
  };
}

/**
 * Save a resource as a file: streamed through the session into a Blob, then an `<a download>` click. The
 * browser downloads it; nothing is navigated to or rendered.
 */
export async function saveResource(
  session: ApplianceSession,
  ref: ResourceRef,
  fileName: string,
  target: Document = document,
): Promise<void> {
  const stream = await session.openResource({ ...ref, ...(ref.kind === 'attachment' && { download: true }) });
  const parts: Uint8Array[] = [];
  for await (const chunk of stream.chunks) parts.push(chunk);
  const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: NEUTRAL }));
  try {
    const a = target.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    target.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
