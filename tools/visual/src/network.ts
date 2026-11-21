/**
 * Deterministic third-party assets for visual runs. The references load React and Babel from unpkg and
 * both the references and the web app load Bricolage Grotesque / DM Mono from Google Fonts. A flaky CDN
 * response would otherwise show up as a blank reference or a fallback-font screenshot.
 *
 * `cacheExternalAssets(context)` routes those hosts through a disk cache: a hit is served from disk (no
 * network), a miss is fetched with retries and stored. The cache lives in `tmp/visual-cache/` (gitignored;
 * CI keeps it between runs with `actions/cache`), overridable with `WHOMBAT_VISUAL_CACHE`. Delete the
 * directory to refetch.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Route } from 'playwright';

/** Hosts whose responses are immutable for our purposes (versioned unpkg URLs, Google Fonts). */
export const EXTERNAL_ASSET_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'] as const;

export function assetCacheDir(repoRoot: string): string {
  return process.env.WHOMBAT_VISUAL_CACHE ?? join(repoRoot, 'tmp/visual-cache');
}

interface CachedMeta {
  url: string;
  status: number;
  headers: Record<string, string>;
}

/** Response headers that describe the transfer, not the body we store (already decoded). */
const DROP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

const ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetries(
  route: Route,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await route.fetch({ timeout: 30_000 });
      const status = response.status();
      if (status >= 500 || status === 429) throw new Error(`HTTP ${status}`);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(response.headers())) if (!DROP_HEADERS.has(k)) headers[k] = v;
      return { status, headers, body: await response.body() };
    } catch (err) {
      lastError = err;
      if (attempt < ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${route.request().url()}: ${(lastError as Error)?.message ?? lastError}`);
}

/**
 * Serve unpkg and Google Fonts requests of `context` from the disk cache, fetching (with retries) and
 * storing on a miss. Safe to call on many contexts and processes at once (writes are atomic renames).
 */
export async function cacheExternalAssets(context: BrowserContext, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const handler = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.continue();
    const url = request.url();
    const key = createHash('sha256').update(url).digest('hex').slice(0, 32);
    const bodyFile = join(dir, `${key}.body`);
    const metaFile = join(dir, `${key}.json`);
    try {
      const meta = JSON.parse(await readFile(metaFile, 'utf8')) as CachedMeta;
      const body = await readFile(bodyFile);
      return route.fulfill({ status: meta.status, headers: meta.headers, body });
    } catch {
      // Miss: fetch below.
    }
    let fetched: Awaited<ReturnType<typeof fetchWithRetries>>;
    try {
      fetched = await fetchWithRetries(route);
    } catch (err) {
      console.warn(`[visual] ${(err as Error).message}`);
      return route.abort('failed');
    }
    if (fetched.status === 200) {
      const tmp = `.${process.pid}-${Math.random().toString(36).slice(2)}`;
      const meta: CachedMeta = { url, status: fetched.status, headers: fetched.headers };
      await writeFile(bodyFile + tmp, fetched.body);
      await writeFile(metaFile + tmp, JSON.stringify(meta));
      await rename(bodyFile + tmp, bodyFile);
      await rename(metaFile + tmp, metaFile);
    }
    return route.fulfill({ status: fetched.status, headers: fetched.headers, body: fetched.body });
  };
  for (const host of EXTERNAL_ASSET_HOSTS) await context.route(`https://${host}/**`, handler);
}
