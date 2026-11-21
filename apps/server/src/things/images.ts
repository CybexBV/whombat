/**
 * Pictures on thing pages (service-dashboards.md SD-06, SD-S03, SD-S09): posters, camera snapshots, photo and document
 * thumbnails. A page names a picture by an opaque, signed `ref` (`imageRef`); clients load it over HTTP
 * (`GET /burrows/:burrow/things/:thing/images/:ref`) or the session's `thing-image` download (`image-route.ts`).
 *
 * - **The ref**: base64url of `{c: connectionId, s: 'c'|'t', p: path, w?: 0, l?: 1, e: expiry (epoch seconds)}`, a dot, and
 *   the first 16 bytes of its HMAC-SHA256 (base64url) under a subkey of the server's master key with the label
 *   `thing-image` (`custody.mac`, as invite links). It expires at the end of the next UTC day (24 to 48 hours on), so
 *   every page read of a day names the same picture by the same ref and clients keep it, except camera snapshots
 *   (`w: 0`): theirs is 24 hours on rounded to 5 seconds, a time bucket, so every page read gives a fresh ref and a
 *   fresh picture.
 *   `l: 1` asks for a large picture (a screen's photo view, desk-display.md DK-160): 1280 px on its long side instead of
 *   480. It is signed like the rest, so only the runtime makes one (`largeImageRef`, from a page's own ref).
 * - **What it may name**: a path on the connection itself (`c`: `/library/metadata/12/thumb/1699…`, fetched as the
 *   connection with `signedConnectionFetch`, its policy, its credential), or a poster on TMDB's public image host
 *   (`t`: `/kqjL17yu….jpg` → `https://image.tmdb.org/t/p/w342/kqjL17yu….jpg`, through the link-preview fetcher's
 *   rules: public addresses, standard ports, no credentials). Nothing else: the route is no fetcher of other URLs.
 * - **What it serves**: 8 seconds and 3 MB at most, JPEG, PNG or WebP by their bytes (`files/sniff.ts`); a JPEG or PNG
 *   larger than 480 px on its long side (a large one's 1280) is made smaller by the preview worker (`feedback/image-pool.ts`, off the event
 *   loop); a WebP is served as it came (the worker has no WebP encoder; 3 MB caps it). Anything else: no picture.
 * - **Kept** in memory per server: 64 MB at most, least recently used first out, 10 minutes (snapshots 5 seconds, large
 *   pictures 30 minutes: a photo frame comes back to the same dozen every half hour or so); a
 *   picture that couldn't be had is remembered for a minute (snapshots 5 seconds), so a page read every 5 seconds
 *   doesn't ask a broken service again each time. Two asks at once share one fetch.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  THING_IMAGE_LARGE_SIDE,
  THING_IMAGE_MAX_SIDE,
  type THING_IMAGE_TYPES,
  type ThingImage,
  ThingImageRef,
  type ThingImageShape,
} from '@whombat/core';
import { z } from 'zod';
import { externalEffect } from '../commit/scope';
import { signedConnectionFetch } from '../connections/http';
import { ps5PictureUrl } from '../connections/ps5-api';
import type { CatalogConnectionRow } from '../connections/types';
import { PREVIEW_MAX_SOURCE_PIXELS } from '../files/previews';
import { sniffBuffer } from '../files/sniff';
import type { KeyCustody } from '../keys/custody';
import { isPublicAddress, OutboundError, type OutboundPolicy, outboundRequest } from '../lib/outbound';
import { PREVIEW_USER_AGENT, previewUrlProblem } from '../previews/fetch';
import type { Services } from '../services';

/** How long a ref is good for at least (SD-06). */
export const IMAGE_REF_TTL_MS = 24 * 3600_000;
/** A ref expires at the end of the next one of these (UTC days): one ref per picture per day. */
export const IMAGE_REF_STEP_MS = 24 * 3600_000;
/** A snapshot's ref changes this often: a page read gives a fresh picture. */
export const SNAPSHOT_REF_STEP_MS = 5_000;
/** A ref's longest form (contracts CT-1000 `ThingImageRef`). */
export const IMAGE_REF_MAX = 600;
/** A path's longest form, so the ref fits. */
export const IMAGE_PATH_MAX = 360;
/** The signing key's label (SD-S03). */
export const IMAGE_KEY_LABEL = 'thing-image';

/** One fetch's deadline and size (SD-S03). */
export const IMAGE_DEADLINE_MS = 8_000;
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
/** A picture's long side at most (CT-1000); larger JPEGs and PNGs are made smaller. */
export const IMAGE_MAX_EDGE = THING_IMAGE_MAX_SIDE;
/** A large picture's long side at most (a screen's photo view); a 1280 px JPEG is well under `IMAGE_MAX_BYTES`. */
export const IMAGE_LARGE_EDGE = THING_IMAGE_LARGE_SIDE;
/** The memory cache: its size, how long a picture and a snapshot are kept, and how long a failure is remembered. */
export const IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
export const IMAGE_KEEP_MS = 10 * 60_000;
export const SNAPSHOT_KEEP_MS = 5_000;
export const LARGE_KEEP_MS = 30 * 60_000;
export const IMAGE_FAILED_KEEP_MS = 60_000;

/** TMDB's poster host and size (Seerr's posters, SD-21). */
export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';

export type ImageSource = 'c' | 't';
export type ImageType = (typeof THING_IMAGE_TYPES)[number];

/** What a ref says, once its signature, expiry and form are checked. */
export interface ImageRefPayload {
  c: string;
  s: ImageSource;
  p: string;
  w?: 0;
  l?: 1;
  e: number;
}

const Payload = z
  .object({
    c: z.string().min(1).max(64),
    s: z.enum(['c', 't']),
    p: z.string().min(1).max(IMAGE_PATH_MAX),
    w: z.literal(0).optional(),
    l: z.literal(1).optional(),
    e: z.number().int().positive(),
  })
  .strict();

const REF = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
/** A TMDB poster's path: `/<letters and digits>.jpg`. */
const TMDB_PATH = /^\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;

/**
 * Why a path can't be named by a ref, or null: a connection's path starts with one `/` and has no spaces, controls,
 * backslashes or fragment (a query is fine: Plex's transcoder); a TMDB poster's is a file name.
 */
export function imagePathProblem(source: ImageSource, path: string): string | null {
  if (path.length > IMAGE_PATH_MAX) return 'too long';
  if (source === 't') return TMDB_PATH.test(path) ? null : 'not a TMDB poster';
  if (!path.startsWith('/') || path.startsWith('//')) return 'not a path';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\s\\#\u0000-\u001f\u007f]/.test(path)) return 'not a plain path';
  if (/(?:^|\/)\.\.(?:\/|\?|$)/.test(path)) return 'goes up';
  return null;
}

function signature(custody: Pick<KeyCustody, 'mac'>, body: string): string {
  return Buffer.from(custody.mac(IMAGE_KEY_LABEL, body), 'base64url').subarray(0, 16).toString('base64url');
}

/**
 * The expiry a ref made now carries (epoch seconds): the end of the next UTC day, the same all day; a snapshot's 24
 * hours on rounded up to 5 seconds, a new one every 5 seconds.
 */
export function refExpiry(now: Date, snapshot: boolean): number {
  if (snapshot)
    return (
      Math.ceil((now.getTime() + IMAGE_REF_TTL_MS) / SNAPSHOT_REF_STEP_MS) * (SNAPSHOT_REF_STEP_MS / 1000)
    );
  return (Math.floor(now.getTime() / IMAGE_REF_STEP_MS) + 2) * (IMAGE_REF_STEP_MS / 1000);
}

function signed(custody: Pick<KeyCustody, 'mac'>, payload: ImageRefPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const ref = `${body}.${signature(custody, body)}`;
  return ref.length <= IMAGE_REF_MAX ? ref : '';
}

/**
 * A signed ref to a picture of this connection (SD-06, SD-S03): `path` on the connection (`source: 'c'`, the default)
 * or a TMDB poster's path (`'t'`); `snapshot` for a camera's picture (kept 5 seconds, a fresh address every 5 seconds);
 * `large` for a screen's photo view (1280 px instead of 480). Empty when the path can't be named (too long, not a
 * path): `thingImage` then gives no picture.
 */
export function imageRef(
  ctx: { services: Pick<Services, 'custody'>; row: Pick<CatalogConnectionRow, 'id'>; now: Date },
  {
    path,
    source = 'c',
    snapshot = false,
    large = false,
  }: { path: string; source?: ImageSource; snapshot?: boolean; large?: boolean },
): string {
  if (imagePathProblem(source, path)) return '';
  return signed(ctx.services.custody, {
    c: ctx.row.id,
    s: source,
    p: path,
    ...(snapshot ? { w: 0 as const } : {}),
    ...(large && !snapshot ? { l: 1 as const } : {}),
    e: refExpiry(ctx.now, snapshot),
  });
}

/**
 * The large form of a page's picture (a screen's photo view): the same picture at 1280 px, signed anew; '' for a ref
 * that isn't good now. A camera's snapshot stays as it is (it is no photo to hang on a wall).
 */
export function largeImageRef(custody: Pick<KeyCustody, 'mac'>, ref: string, now: Date): string {
  const payload = readImageRef(custody, ref, now);
  if (!payload) return '';
  if (payload.w === 0 || payload.l === 1) return ref;
  return signed(custody, { ...payload, l: 1 });
}

/** A page's picture (CT-1000) from a ref, its words for those who can't see it, and its box; none without a ref. */
export function thingImage(ref: string, alt: string, shape: ThingImageShape): ThingImage | undefined {
  if (!ref || !ThingImageRef.safeParse(ref).success) return undefined;
  return { ref, alt: alt.slice(0, 120), shape };
}

/**
 * Whether a ref names a camera's snapshot (a fresh picture every few seconds), read without its signature: it only
 * chooses how a picture is shown (a camera on a screen), never whether it may be.
 */
export function isSnapshotRef(ref: string): boolean {
  const m = REF.exec(ref);
  if (!m || ref.length > IMAGE_REF_MAX) return false;
  try {
    return (
      (JSON.parse(Buffer.from(m[1] as string, 'base64url').toString('utf8')) as { w?: unknown })?.w === 0
    );
  } catch {
    return false;
  }
}

/** What a well-signed, unexpired ref says; null for anything else (the route answers 404, never why). */
export function readImageRef(
  custody: Pick<KeyCustody, 'mac'>,
  ref: string,
  now: Date,
): ImageRefPayload | null {
  if (ref.length > IMAGE_REF_MAX) return null;
  const m = REF.exec(ref);
  if (!m) return null;
  const [, body, sig] = m as unknown as [string, string, string];
  const expected = Buffer.from(signature(custody, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const payload = Payload.safeParse(parsed);
  if (!payload.success) return null;
  if (payload.data.e * 1000 <= now.getTime()) return null;
  if (imagePathProblem(payload.data.s, payload.data.p)) return null;
  return payload.data as ImageRefPayload;
}

/* Fetching ------------------------------------------------------------------------------------------------------------ */

/** A picture as served: its bytes, type and tag; `snapshot` pictures are never kept by the browser. */
export interface Picture {
  bytes: Buffer;
  contentType: ImageType;
  etag: string;
  snapshot: boolean;
}

const SERVED: ReadonlySet<string> = new Set<ImageType>(['image/jpeg', 'image/png', 'image/webp']);

/** Fetches raw bytes for a ref (tests swap it); null when there are none to have. */
export type ImageFetcher = (
  services: Services,
  row: CatalogConnectionRow,
  payload: ImageRefPayload,
) => Promise<Buffer | null>;

/**
 * Where a path of the connection is fetched: on its base, except a PS5's game covers, which ShadowMountPlus serves on its
 * own port of the same console (any other PS5 path names no picture).
 */
function connectionPictureUrl(row: CatalogConnectionRow, path: string): string | null {
  if (row.catalogId === 'ps5') return ps5PictureUrl(row.baseUrl, row.fields, path);
  return `${row.baseUrl.replace(/\/+$/, '')}${path}`;
}

/** The bytes at a path of the connection, as the connection (its policy and credential). */
async function fromConnection(
  services: Services,
  row: CatalogConnectionRow,
  path: string,
): Promise<Buffer | null> {
  const url = connectionPictureUrl(row, path);
  if (!url) return null;
  const res = await externalEffect(
    'things.image',
    () =>
      signedConnectionFetch(
        services,
        row,
        {
          method: 'GET',
          url,
          headers: { Accept: 'image/webp,image/png,image/jpeg' },
        },
        { maxBytes: IMAGE_MAX_BYTES, deadlineMs: IMAGE_DEADLINE_MS },
      ),
    { idempotent: true },
  );
  return res.status >= 200 && res.status < 300 ? res.body : null;
}

/**
 * The outbound policy of a TMDB poster: the link-preview fetcher's (public addresses only, on every address the name
 * resolves to; `allowPrivate` for tests and local mocks), with a picture's deadline and size.
 */
export function tmdbPolicy(options: {
  allowPrivate?: boolean;
  resolve?: OutboundPolicy['resolve'];
}): OutboundPolicy {
  const common: OutboundPolicy = {
    timeoutMs: IMAGE_DEADLINE_MS,
    deadlineMs: IMAGE_DEADLINE_MS,
    maxBytes: IMAGE_MAX_BYTES,
    ...(options.resolve ? { resolve: options.resolve } : {}),
  };
  if (options.allowPrivate) return { ...common, allowPrivate: true };
  return {
    ...common,
    destination: {
      schemes: ['https:'],
      check(hostname, addresses) {
        if (addresses.some((a) => !isPublicAddress(a)))
          throw new OutboundError('private_address', `${hostname} is not a public address.`);
      },
    },
  };
}

/** A TMDB poster's bytes (no redirects followed: TMDB answers its images directly). */
export async function fromTmdb(
  path: string,
  options: { allowPrivate?: boolean; resolve?: OutboundPolicy['resolve'] } = {},
): Promise<Buffer | null> {
  if (imagePathProblem('t', path)) return null;
  const url = `${TMDB_IMAGE_BASE}${path}`;
  if (previewUrlProblem(url, options.allowPrivate)) return null;
  const res = await outboundRequest(
    url,
    {
      method: 'GET',
      headers: { accept: 'image/webp,image/png,image/jpeg', 'user-agent': PREVIEW_USER_AGENT },
    },
    tmdbPolicy(options),
  );
  return res.status >= 200 && res.status < 300 ? res.body : null;
}

const defaultFetcher: ImageFetcher = (services, row, payload) =>
  payload.s === 't'
    ? fromTmdb(payload.p, { allowPrivate: services.config.WHOMBAT_OUTBOUND_ALLOW_PRIVATE })
    : fromConnection(services, row, payload.p);

/**
 * The served form of fetched bytes: JPEG, PNG or WebP by their bytes, at most 480 px (`large`: 1280) for JPEG and PNG;
 * else null.
 */
export async function servedPicture(
  services: Pick<Services, 'feedback'>,
  raw: Buffer,
  snapshot: boolean,
  large = false,
): Promise<Picture | null> {
  if (raw.length === 0 || raw.length > IMAGE_MAX_BYTES) return null;
  const sniffed = sniffBuffer(raw, 'picture');
  if (!sniffed.ok || !SERVED.has(sniffed.value.contentType)) return null;
  const contentType = sniffed.value.contentType as ImageType;
  const width = sniffed.value.width ?? 0;
  const height = sniffed.value.height ?? 0;
  const edge = large ? IMAGE_LARGE_EDGE : IMAGE_MAX_EDGE;
  let bytes = raw;
  if (contentType !== 'image/webp' && Math.max(width, height) > edge) {
    if (width * height > PREVIEW_MAX_SOURCE_PIXELS) return null;
    try {
      bytes = (
        await services.feedback.images.run({
          bytes: raw,
          contentType,
          width,
          height,
          maxPixels: PREVIEW_MAX_SOURCE_PIXELS,
          thumbnailMaxEdge: edge,
        })
      ).bytes;
    } catch {
      return null;
    }
  }
  const etag = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  return { bytes, contentType, etag, snapshot };
}

/* The cache ----------------------------------------------------------------------------------------------------------- */

type Kept = { at: number; keepMs: number; picture: Picture | null };

/** A memory cache of pictures by connection, source, path and kind, least recently used first out. */
export class PictureCache {
  readonly #kept = new Map<string, Kept>();
  readonly #fetching = new Map<string, Promise<Picture | null>>();
  #bytes = 0;

  constructor(readonly maxBytes = IMAGE_CACHE_BYTES) {}

  /** Bytes kept now. */
  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#kept.size;
  }

  #drop(key: string): void {
    const kept = this.#kept.get(key);
    if (!kept) return;
    this.#kept.delete(key);
    this.#bytes -= kept.picture?.bytes.length ?? 0;
  }

  /** What is kept for `key` and still fresh at `now` (a remembered failure is `null`); `undefined` when nothing is. */
  get(key: string, now: number): Picture | null | undefined {
    const kept = this.#kept.get(key);
    if (!kept) return undefined;
    if (now - kept.at > kept.keepMs) {
      this.#drop(key);
      return undefined;
    }
    // Most recently used goes to the end.
    this.#kept.delete(key);
    this.#kept.set(key, kept);
    return kept.picture;
  }

  set(key: string, picture: Picture | null, now: number, keepMs: number): void {
    this.#drop(key);
    const size = picture?.bytes.length ?? 0;
    if (size > this.maxBytes) return;
    this.#kept.set(key, { at: now, keepMs, picture });
    this.#bytes += size;
    // Least recently used first out, the new one last.
    for (const k of this.#kept.keys()) {
      if (this.#bytes <= this.maxBytes) break;
      if (k !== key) this.#drop(k);
    }
  }

  /** The kept picture, or one fetch shared by everyone who asks meanwhile; its outcome is kept as `keep` says. */
  async through(
    key: string,
    now: () => number,
    load: () => Promise<Picture | null>,
    keep: (picture: Picture | null) => number,
  ): Promise<Picture | null> {
    const kept = this.get(key, now());
    if (kept !== undefined) return kept;
    const running = this.#fetching.get(key);
    if (running) return running;
    const work = load()
      .catch(() => null)
      .then((picture) => {
        this.set(key, picture, now(), keep(picture));
        return picture;
      })
      .finally(() => this.#fetching.delete(key));
    this.#fetching.set(key, work);
    return work;
  }
}

const caches = new WeakMap<Services, PictureCache>();
const fetchers = new WeakMap<Services, ImageFetcher>();

function cacheOf(services: Services): PictureCache {
  let cache = caches.get(services);
  if (!cache) {
    cache = new PictureCache();
    caches.set(services, cache);
  }
  return cache;
}

/** Tests: fetch raw bytes with `fetcher` instead of the network, with an empty cache. */
export function useImageFetcherForTests(services: Services, fetcher: ImageFetcher | null): void {
  caches.delete(services);
  if (fetcher) fetchers.set(services, fetcher);
  else fetchers.delete(services);
}

/** The picture a checked ref names, from the cache or fetched now; null when there is none to show. */
export function pictureFor(
  services: Services,
  row: CatalogConnectionRow,
  payload: ImageRefPayload,
): Promise<Picture | null> {
  const snapshot = payload.w === 0;
  const large = payload.l === 1;
  const key = `${payload.c}|${payload.s}|${snapshot ? 's' : large ? 'l' : ''}|${payload.p}`;
  const fetcher = fetchers.get(services) ?? defaultFetcher;
  return cacheOf(services).through(
    key,
    () => services.clock().getTime(),
    async () => {
      const raw = await fetcher(services, row, payload);
      return raw ? servedPicture(services, raw, snapshot, large) : null;
    },
    (picture) =>
      snapshot ? SNAPSHOT_KEEP_MS : !picture ? IMAGE_FAILED_KEEP_MS : large ? LARGE_KEEP_MS : IMAGE_KEEP_MS,
  );
}
