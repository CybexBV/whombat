/**
 * What the media kinds share (service-dashboards.md SD-20…SD-24, SD-10; SD-S12, SD-S13): the few reads that aren't a
 * plain GET of a small answer (a large library list, NZBHydra2's indexer state), the other media connection a page links to or reads (SD-S08), pictures, and the words
 * every media page uses (speeds, time left, “S02E05”). Pure apart from the calls.
 */

import type { ThingImage, ThingImageShape } from '@whombat/core';
import { externalEffect } from '../../../commit/scope';
import { resolveCredential } from '../../../connections/credentials';
import { currentRow, signedConnectionFetch } from '../../../connections/http';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { imageRef, thingImage } from '../../images';
import { siblingThing } from '../../siblings';
import { bytes, clip, figure, figure1, plural, span } from '../../words';
import { KIND_DEADLINE_MS, problemOf, ReadProblem } from '../read';
import type { KindCtx } from '../types';

/* Calls ---------------------------------------------------------------------------------------------------------------- */

const urlOf = (
  row: Pick<CatalogConnectionRow, 'baseUrl'>,
  path: string,
  query: Record<string, string> = {},
) => {
  const search = new URLSearchParams(query).toString();
  return `${row.baseUrl.replace(/\/+$/, '')}${path}${search ? `?${search}` : ''}`;
};

/** An optional part of a read: null when this version doesn't have it or it fails (SD-S05: the rest stays). */
export const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** A read of a large answer (Sonarr's series, Radarr's movies): as `getJson`, with more room. */
export const LIBRARY_MAX_BYTES = 24 * 1024 * 1024;

/** The answer's JSON of a read as the connection, with its own method, body and size (`getJson`'s rules otherwise). */
export async function readJson(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
  req: {
    method?: 'GET' | 'POST';
    path: string;
    query?: Record<string, string>;
    body?: string;
    maxBytes?: number;
  },
): Promise<unknown> {
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method: req.method ?? 'GET',
            url: urlOf(row, req.path, req.query),
            headers: {
              Accept: 'application/json',
              ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(req.body !== undefined ? { body: req.body } : {}),
          },
          { maxBytes: req.maxBytes ?? LIBRARY_MAX_BYTES, deadlineMs: KIND_DEADLINE_MS },
        ),
      { idempotent: true },
    );
  } catch (err) {
    throw problemOf(err, name);
  }
  if (res.status === 401 || res.status === 403 || res.status === 498)
    throw new ReadProblem(`${name} refused Whombat’s sign-in.`, res.status !== 403);
  if (res.status >= 400) throw new ReadProblem(`${name} answered with an error.`);
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new ReadProblem(`${name} answered with something Whombat can’t read.`);
  }
}

/**
 * The connection's `query` key (NZBHydra2's `apikey`), for an API that wants it in a request's body as well (SD-S12):
 * read as ha-socket.ts reads its token, never shown or kept.
 */
export async function queryKeyOf(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
): Promise<string> {
  const { credential } = await resolveCredential(services, row);
  const key = Object.values(credential.query)[0];
  if (!key) throw new ReadProblem(`Whombat has no key for ${name}.`);
  return key;
}

/* Other connections ----------------------------------------------------------------------------------------------------- */

/** Another media connection of these kinds the viewer sees (SD-S08): where its page is, and its row to read it. */
export async function siblingRow(
  ctx: Pick<KindCtx, 'services' | 'burrowId' | 'viewer'>,
  catalogIds: readonly string[],
): Promise<{ href: string; name: string; row: CatalogConnectionRow } | null> {
  const found = await siblingThing(ctx, catalogIds).catch(() => null);
  if (!found) return null;
  // `/things/connection%3Acon_…` (thingHref): the connection's id.
  const id = decodeURIComponent(found.href.replace(/^\/things\//, '')).replace(/^connection:/, '');
  const row = await currentRow(ctx.services, id).catch(() => null);
  return row && row.status !== 'needs_reauth' ? { ...found, row } : null;
}

/* Pictures ------------------------------------------------------------------------------------------------------------- */

/** A picture at a path of the connection, or a TMDB poster (`source: 't'`); none when the path can't be named. */
export function picture(
  ctx: Pick<KindCtx, 'services' | 'row' | 'now'>,
  path: string | null,
  alt: string,
  shape: ThingImageShape = 'poster',
  source: 'c' | 't' = 'c',
): ThingImage | undefined {
  if (!path) return undefined;
  return thingImage(imageRef(ctx, { path, source }), clip(alt, 120), shape);
}

/** Whether the catalog entry lets a picture's path through (its `request.prefixes`, CT-1000's rule). */
export function prefixAllows(ctx: Pick<KindCtx, 'entry'>, path: string): boolean {
  const prefixes = ctx.entry.request?.prefixes ?? [];
  return prefixes.some((p) => path.startsWith(p));
}

/* Words --------------------------------------------------------------------------------------------------------------- */

/** A speed in bytes a second: “42 MB/s”, “850 kB/s”, “1.2 MB/s”. */
export function speedWords(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1e9) return `${figure1(bytesPerSecond / 1e9)} GB/s`;
  if (bytesPerSecond >= 1e6) return `${figure(Math.round((bytesPerSecond / 1e6) * 10) / 10)} MB/s`;
  if (bytesPerSecond >= 1e3) return `${Math.round(bytesPerSecond / 1e3)} kB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

/**
 * A duration as the services say it (SABnzbd “1:02:03:04”/“0:12:34”, .NET “1.02:03:04”/“00:12:34”, Plex/Sonarr
 * “mm:ss”) in milliseconds; null when it isn't one.
 */
export function clockMs(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = /^\s*(?:(\d+)[.:])?(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?\s*$/.exec(text);
  if (m) {
    const [, d, h, min, s] = m;
    return (((Number(d ?? 0) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)) * 1000;
  }
  const short = /^\s*(\d+):(\d{1,2})\s*$/.exec(text);
  return short ? (Number(short[1]) * 60 + Number(short[2])) * 1000 : null;
}

/** “12 min left”, “2 h left”, “under a minute left”. */
export function leftWords(ms: number): string {
  return ms < 60_000 ? 'under a minute left' : `${span(ms)} left`;
}

/** “63 %” of a fraction. */
export function share(fraction: number): string {
  return `${Math.max(0, Math.min(100, Math.floor(fraction * 100)))} %`;
}

/** “S02E05”. */
export function episodeCode(season: number | null, episode: number | null): string | null {
  if (season === null || episode === null) return null;
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/** “18.4 GB of 40 GB”. */
export function sizeOf(left: number, total: number): string {
  return `${bytes(left)} of ${bytes(total)}`;
}

/** “2 movies”, “1 series”. */
export function titles(n: number, movie: boolean): string {
  return movie ? plural(n, 'movie') : plural(n, 'series', 'series');
}

/**
 * The head's status when nothing is worth a look (quiet-notices.md QN-S30): what the kind says is happening
 * (“Downloading · 42 MB/s”), else none (the check's). The active lines decide warn and bad (S0's apply step), so a kind
 * never puts them here.
 */
export function statusFrom(badge?: string | null): { status?: { status: 'ok'; badge: string } } {
  return badge ? { status: { status: 'ok', badge: clip(badge, 60) } } : {};
}

/** A disk's subject (QN-S3x): its total size in whole GiB, the same in SABnzbd, Sonarr and Radarr for one disk. */
export function diskSubject(totalBytes: number, name: string): { id: string; name: string } {
  return { id: `disk:${Math.round(totalBytes / 1024 ** 3)}g`, name: clip(name, 80) };
}

/** A full disk's band (QN-11: higher is worse within its tone): 90 under 10 % free, 95 under 5 %, 98 under 2 %. */
export function diskBand(free: number): number {
  return free < 0.02 ? 98 : free < 0.05 ? 95 : 90;
}

/** Notices without repeats (the first of an id wins). */
export function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

/** A row's or item's id: printable, at most 200 characters. */
export function idOf(...parts: (string | number | null | undefined)[]): string {
  const id = parts
    .filter((p) => p !== null && p !== undefined && p !== '')
    .join('-')
    .replace(/[^\w.:-]+/g, '_')
    .slice(0, 200);
  return id || 'item';
}

/* Lines (quiet-notices.md QN-01…QN-04, QN-S30…QN-S39): the infra kinds' helpers, one copy. */
export { badgeOf, itemLines, linesSeen, okStatus, worstFirst } from '../infra/shared';
