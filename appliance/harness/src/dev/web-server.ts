/**
 * Serves the hosted web build (IN-32) on loopback for a reverse proxy: files with their content types, `index.html`
 * for every other GET (client-side routes), hashed `/assets/*` cached for a year, everything else revalidated, and
 * the build's `_headers` (the `/*` block on every response, path blocks on the files under them, IN-122).
 *
 * It keeps no access log and never prints a request (IN-48, Whombat AG-14/MR-65): Google's redirect brings an
 * authorization code and state to `/connect/google?code=…&state=…`, and only the app, in the browser, may see them.
 * Its only output is the line saying where it listens. Keep it that way (web-server.test.ts).
 *   node web-server.ts <dist-hosted> <port>
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, extname, join, normalize, resolve } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

// Files without an extension that clients read as JSON: Apple fetches the iPhone app's Universal Links and passkey
// domains from `/.well-known/apple-app-site-association` and wants it served as JSON.
const NAMED_TYPES: Record<string, string> = {
  'apple-app-site-association': 'application/json',
};

// Absolute, so the path-escape check (`file.startsWith(root)`) also holds for a relative argument like `.`.
const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 0);
const index = join(root, 'index.html');

/**
 * The static host's `_headers` file: the `/*` block (CSP, HSTS and the other security headers) applies to every
 * response; a block for a path prefix (`/sandbox/*`) applies to the files under it, and its values replace the `/*`
 * ones of the same header instead of adding to them (IN-122: the HTML preview frame has its own CSP, and two CSPs on
 * one response would both apply). Exact-path blocks (`/x.html`) work the same way.
 */
interface HeaderBlock {
  /** `/*` → '', `/sandbox/*` → '/sandbox/', `/x.html` → '/x.html' (exact). */
  prefix: string;
  exact: boolean;
  values: Record<string, string>;
}
function buildHeaderBlocks(): HeaderBlock[] {
  const f = join(root, '_headers');
  if (!existsSync(f)) return [];
  const blocks: HeaderBlock[] = [];
  let current: HeaderBlock | null = null;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      current = null;
      if (!pattern.startsWith('/')) continue;
      current = pattern.endsWith('/*')
        ? { prefix: pattern.slice(0, -1).replace(/^\/$/, ''), exact: false, values: {} }
        : { prefix: pattern, exact: true, values: {} };
      blocks.push(current);
    } else if (current) {
      const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
      if (m?.[1] && m[2]) current.values[m[1].trim().toLowerCase()] = m[2].trim();
    }
  }
  // Least specific first, so a longer prefix (or an exact path) overrides.
  return blocks.sort((a, b) => Number(a.exact) - Number(b.exact) || a.prefix.length - b.prefix.length);
}
const headerBlocks = buildHeaderBlocks();
function headersFor(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of headerBlocks)
    if (b.exact ? path === b.prefix : b.prefix === '' || path.startsWith(b.prefix))
      Object.assign(out, b.values);
  return out;
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  let path: string;
  try {
    // Only the path is used; the query (e.g. Google's code on /connect/google) is never read, stored or printed.
    path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')).replace(/^(\.\.[/\\])+/, '');
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = join(root, path);
  const isFile = path !== '/_headers' && file.startsWith(root) && existsSync(file) && statSync(file).isFile();
  // A missing asset is a 404, not the app shell (a stale tab must not parse HTML as JavaScript).
  if (!isFile && path.startsWith('/assets/')) {
    res.writeHead(404).end();
    return;
  }
  if (!isFile) file = index;
  const immutable = isFile && path.startsWith('/assets/');
  res.writeHead(200, {
    // The app shell answers every client-side route: it gets the `/*` headers, never a path block's.
    ...headersFor(isFile ? path : '/'),
    'content-type': NAMED_TYPES[basename(file)] ?? TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => {
  const a = server.address();
  process.stdout.write(`serving ${root} on 127.0.0.1:${typeof a === 'object' && a ? a.port : port}\n`);
});
