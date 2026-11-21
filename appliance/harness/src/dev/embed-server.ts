/**
 * Serves the Feedback widget's embed tree (whombat-app `build:embed`: `_headers` + `embed/v1/…`, Whombat FD-31,
 * FD-46) on loopback for the embed origin (`embed.whombat.com` through the tunnel on the dev instance, IN-54): files
 * only, with their content types and every `_headers` block that matches the path; 404 for anything that isn't a file
 * (no index, no fallback, never `_headers` itself); GET and HEAD only.
 *
 * Like the hosted UI's server (IN-48) it keeps no access log and prints nothing per request: website visitors load
 * the widget from here, and their page addresses must not rest in a log. Its only output is the listen line.
 *   node embed-server.ts <dist-embed> <port>
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { headersFor, parseHeadersFile } from './headers-file.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 0);
const headersFile = join(root, '_headers');
const blocks = existsSync(headersFile) ? parseHeadersFile(readFileSync(headersFile, 'utf8')) : [];

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  let path: string;
  try {
    // Only the path is used; a query string is never read, stored or printed.
    path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')).replace(/^(\.\.[/\\])+/, '');
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = join(root, path);
  const isFile =
    path !== '/_headers' && file.startsWith(`${root}/`) && existsSync(file) && statSync(file).isFile();
  if (!isFile) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : 'Not found\n');
    return;
  }
  res.writeHead(200, {
    'cache-control': 'no-cache',
    ...headersFor(blocks, path),
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => {
  const a = server.address();
  process.stdout.write(`serving ${root} on 127.0.0.1:${typeof a === 'object' && a ? a.port : port}\n`);
});
