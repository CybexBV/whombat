/**
 * Serves a hosted build (`dist-hosted-e2e`) the way the static host would: SPA fallback and the `_headers` the
 * build wrote (CSP with frame-ancestors, nosniff, …). For the CSP journeys (hosted.spec.ts).
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, '..', process.env.HOSTED_DIR || 'dist-hosted-e2e');
const port = Number(process.env.WEB_HOSTED_PORT || 5194);
/** `_headers` blocks by path pattern (`/*`, `/sandbox/*`); a path block's values replace the `/*` ones (IN-121). */
const blocks = {};
let block = null;
for (const line of readFileSync(join(root, '_headers'), 'utf8').split('\n')) {
  if (/^\//.test(line)) {
    block = line.trim();
    blocks[block] = {};
  }
  const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
  if (m && block) blocks[block][m[1]] = m[2];
}
const headers = blocks['/*'];
// Local http: no upgrade to https.
headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace(
  '; upgrade-insecure-requests',
  '',
);
delete headers['Strict-Transport-Security'];
const headersFor = (path) => {
  const out = { ...headers };
  for (const [pattern, values] of Object.entries(blocks))
    if (pattern !== '/*' && pattern.endsWith('/*') && path.startsWith(pattern.slice(0, -1)))
      Object.assign(out, values);
  return out;
};
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};
createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  let file = join(root, path);
  const found = existsSync(file) && !statSync(file).isDirectory();
  if (!found) file = join(root, 'index.html');
  res.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    ...headersFor(found ? path : '/'),
  });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`hosted build on http://localhost:${port}`));
