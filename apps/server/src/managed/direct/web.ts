/**
 * The page the box serves to browsers on its direct ways (hermes-engine.md HE-50; direct-connection.md DC-08): the
 * hosted web build (whombat-app's session build, the release's `web/`, `webDistDir`), over plain HTTP on the local
 * network and over HTTPS on the Tailscale name. The page connects to its own origin's `DIRECT_PATH`.
 *
 * - The files as they are; content-hashed `/assets/*` cached for a year, everything else revalidated, `index.html`
 *   never cached (an update reaches every browser on its next load); a precompressed sibling (`.br`, `.gz`) when the
 *   request accepts it.
 * - Any other GET for a page gets `index.html` (the app's routes); a missing file with an extension is a 404.
 * - Never framed, no referrer, no sniffing; HSTS never (the Tailscale name may lose its certificate, DC-09). The one
 *   exception is the HTML preview frame (`/sandbox/*`, `SANDBOX_HEADERS`): the app frames it on its own pages, and the
 *   page in it, an opaque origin, loads the frame's script and the Mermaid runtime.
 */
import { createReadStream, existsSync, readFileSync, type Stats, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { PAGE_POLICY } from '@whombat/core';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_REVALIDATE = 'no-cache';
export const CACHE_NONE = 'no-store, max-age=0';

/** On every answer of the direct listener. */
export const DIRECT_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/**
 * The HTML preview frame's policy, as the hosted build's `_headers` give it (apps/web `sandboxContentSecurityPolicy`,
 * the frame page's own meta plus `frame-ancestors`): inline scripts and styles with embedded assets; no remote
 * resource loads (docs/decisions/visual-replies.md).
 */
export const SANDBOX_POLICY = `${PAGE_POLICY}; frame-ancestors 'self'`;

/**
 * The preview frame's answers: framed by the app's own pages only, under the frame's policy, and loadable by the
 * opaque-origin page inside it (which the same-origin resource policy would refuse).
 */
export const SANDBOX_HEADERS: Readonly<Record<string, string>> = {
  ...DIRECT_HEADERS,
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': SANDBOX_POLICY,
  'cross-origin-resource-policy': 'cross-origin',
};

/**
 * The scripts the preview frame loads from the build: the Mermaid runtime (`mermaid.min.js?url`:
 * `/assets/mermaid.min-<hash>.js`) and the page set viewer's (`pages-runtime.js?url`: `/assets/pages-runtime-<hash>.js`).
 */
const FRAME_ASSETS = [/^\/assets\/mermaid\.min-[\w-]+\.js$/, /^\/assets\/pages-runtime-[\w-]+\.js$/];

/** The headers for a file of the build: the frame's own for the preview frame and what it loads, else the page's. */
export function headersFor(path: string): Readonly<Record<string, string>> {
  if (path.startsWith('/sandbox/')) return SANDBOX_HEADERS;
  if (FRAME_ASSETS.some((asset) => asset.test(path)))
    return { ...DIRECT_HEADERS, 'cross-origin-resource-policy': 'cross-origin' };
  return DIRECT_HEADERS;
}

const ENCODINGS = [
  { name: 'br', ext: '.br' },
  { name: 'gzip', ext: '.gz' },
] as const;

function accepted(header: string | string[] | undefined): Set<string> {
  const out = new Set<string>();
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const part of value.split(',')) {
    const [rawName = '', ...params] = part.trim().split(';');
    const name = rawName.trim().toLowerCase();
    const q = params.map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p)?.[1]).find((v) => v !== undefined);
    if (!name || (q !== undefined && Number(q) <= 0)) continue;
    if (name === '*') for (const e of ENCODINGS) out.add(e.name);
    else out.add(name);
  }
  return out;
}

function fileStat(path: string): Stats | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function etagOf(stat: Stats, encoding: string | null): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${encoding ? `-${encoding}` : ''}"`;
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    ...DIRECT_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': CACHE_NONE,
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...DIRECT_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': CACHE_NONE,
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

/** The web build on the direct listener; `null` from `directWeb` when the build isn't there. */
export interface DirectWeb {
  readonly root: string;
  /** Answers a GET or HEAD for the page or one of its files. */
  serve(req: IncomingMessage, res: ServerResponse, path: string): void;
}

/** The web build at `root`, or null (logged by the caller) when it has no `index.html`. */
export function directWeb(root: string): DirectWeb | null {
  const base = resolve(root);
  const indexFile = join(base, 'index.html');
  if (!existsSync(indexFile)) return null;

  const sendIndex = (req: IncomingMessage, res: ServerResponse) => {
    // Read per request: an update replaces the build under a running server.
    let html: Buffer;
    try {
      html = readFileSync(indexFile);
    } catch {
      sendText(res, 503, 'The web app is being updated. Try again in a moment.');
      return;
    }
    res.writeHead(200, {
      ...DIRECT_HEADERS,
      'content-type': TYPES['.html'] as string,
      'cache-control': CACHE_NONE,
      'content-length': String(html.length),
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  };

  return {
    root: base,
    serve(req, res, path) {
      if (path.includes('\0')) return sendText(res, 400, 'Bad path.');
      const file = normalize(join(base, path));
      if (file !== base && !file.startsWith(base + sep)) return sendText(res, 404, 'Not found.');
      if (file === indexFile || path === '/') return sendIndex(req, res);
      const stat = fileStat(file);
      if (!stat) {
        if (extname(path)) return sendText(res, 404, 'Not found.');
        return sendIndex(req, res);
      }
      const variants = ENCODINGS.flatMap((e) => {
        const variant = fileStat(file + e.ext);
        return variant ? [{ ...e, stat: variant }] : [];
      });
      const ok = variants.length ? accepted(req.headers['accept-encoding']) : null;
      const chosen = variants.find((v) => ok?.has(v.name)) ?? null;
      const sent = chosen?.stat ?? stat;
      const etag = etagOf(sent, chosen?.name ?? null);
      const headers: Record<string, string> = {
        ...headersFor(path),
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': path.startsWith('/assets/') ? CACHE_IMMUTABLE : CACHE_REVALIDATE,
        'last-modified': sent.mtime.toUTCString(),
        etag,
        ...(variants.length ? { vary: 'Accept-Encoding' } : {}),
        ...(chosen ? { 'content-encoding': chosen.name } : {}),
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      headers['content-length'] = String(sent.size);
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      // A browser that goes away mid-download closes the file too, and a file that can't be read ends the answer.
      pipeline(createReadStream(chosen ? file + chosen.ext : file), res, () => {});
    },
  };
}
