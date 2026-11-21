#!/usr/bin/env node
/**
 * A tiny static server for the Whombat Feedback examples (no dependencies, Node 20+):
 *
 *   node examples/feedback/serve.mjs plain-html --whombat https://whombat.example.org --site fbs_… [--port 8080]
 *
 * It serves one example directory, puts your Whombat address and site id in place of the placeholders
 * (`https://whombat.example.com`, `fbs_REPLACEwithYourSiteId000`) and answers every path without a file
 * extension with `index.html`, so the single-page examples can use real routes. Add the address it prints
 * (e.g. `http://localhost:8080`) to the integration's allowed origins in Settings → Connections → Website feedback.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const PLACEHOLDER_URL = 'https://whombat.example.com';
export const PLACEHOLDER_SITE = 'fbs_REPLACEwithYourSiteId000';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** An HTTP server for `examples/feedback/<example>` with the placeholders replaced (not listening yet). */
export function exampleServer(example, { whombat = PLACEHOLDER_URL, site = PLACEHOLDER_SITE } = {}) {
  const root = resolve(import.meta.dirname, example);
  return createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(`${root}/`) || !extname(file)) file = join(root, 'index.html');
    const type = TYPES[extname(file)];
    try {
      if (!type) throw new Error('not served');
      const text = await readFile(file, 'utf8');
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(
        text.replaceAll(PLACEHOLDER_URL, whombat.replace(/\/+$/, '')).replaceAll(PLACEHOLDER_SITE, site),
      );
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '8080' },
      whombat: { type: 'string', default: PLACEHOLDER_URL },
      site: { type: 'string', default: PLACEHOLDER_SITE },
    },
  });
  const example = positionals[0] ?? 'plain-html';
  const port = Number(values.port);
  exampleServer(example, values).listen(port, '127.0.0.1', () => {
    console.log(`${example} on http://localhost:${port} (Whombat ${values.whombat}, site ${values.site})`);
  });
}
