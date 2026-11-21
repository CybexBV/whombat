/**
 * A customer's website for scenario o (Whombat feedback-drop FD-27…FD-31): a loopback page on its own origin
 * (`http://localhost:<port>`) with a strict Content-Security-Policy (no inline script or style; scripts and frames
 * only from itself and the embed origin, the CSP advice the Feedback tab gives) that carries the integration's
 * snippet exactly as the owner copied it. The snippet can be set after the server listens (the allowed origin, and so
 * the port, is part of the integration the snippet comes from).
 *
 * Plus the helpers the scenario needs to look for plaintext in an envelope: a valid PNG with random pixels (its
 * bytes appear nowhere by chance), and the encodings a careless implementation might leave the canary in.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';

export interface TestSite {
  origin: string;
  /** The snippet the page carries from now on (the integration's `snippets.basic`). */
  setSnippet(snippet: string): void;
  close(): Promise<void>;
}

const CSS = `body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px;max-width:720px}
.card{border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:18px;margin:18px 0}`;

/**
 * The site's pages and their title's first part (the navigation trail, contracts 0.25: the widget records each page
 * view, and the report carries them). Every page carries the snippet.
 */
export const PAGES: Record<string, string> = {
  '/': 'Invoices',
  '/settings': 'Settings',
  '/invoices/2026-0917': 'Invoice 2026-0917',
};

export async function startFeedbackSite(embedOrigin: string, name = 'Acme Billing'): Promise<TestSite> {
  let snippet = '';
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/site.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }).end(CSS);
      return;
    }
    const page = path && Object.hasOwn(PAGES, path) ? PAGES[path] : undefined;
    if (!page) {
      res.writeHead(404).end();
      return;
    }
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${page} · ${name}</title>
<link rel="stylesheet" href="/site.css">
${snippet}
</head>
<body>
<h1>Your invoices</h1>
<div class="card"><strong>Invoice 2026-0917</strong><br>€ 120.00 · paid</div>
</body>
</html>
`;
    res
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // Strict: no inline script or style, nothing from Whombat but the widget's script and frame.
        'content-security-policy': `default-src 'self'; script-src 'self' ${embedOrigin}; frame-src ${embedOrigin}; style-src 'self'; img-src 'self'; connect-src 'self'`,
        'cache-control': 'no-store',
      })
      .end(html);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return {
    origin: `http://localhost:${port}`,
    setSnippet(s) {
      snippet = s;
    },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

/** A valid `size`×`size` RGB PNG of random pixels (uncompressible, so its bytes are distinctive). */
export function randomPng(size = 24): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.concat([Buffer.from([0]), randomBytes(size * 3)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Byte strings that must not appear in an envelope if `text` (or `bytes`) was sealed: UTF-8, UTF-16 LE/BE, base64 and
 * base64url of the value at every byte alignment (the stable middle of each encoding), hex, and for binary data its
 * SHA-256 (raw and hex). Each needle is labelled for the report.
 */
export function plaintextNeedles(label: string, value: string | Buffer): [string, Buffer][] {
  const raw = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const out: [string, Buffer][] = [[`${label} (bytes)`, raw]];
  if (typeof value === 'string') {
    out.push([`${label} (UTF-16LE)`, Buffer.from(value, 'utf16le')]);
    out.push([`${label} (UTF-16BE)`, Buffer.from(value, 'utf16le').swap16()]);
  }
  for (let k = 0; k < 3; k++) {
    const b64 = Buffer.concat([Buffer.alloc(k), raw]).toString('base64');
    // Skip the characters that depend on the prefix and the padding at the end.
    const middle = b64.slice(Math.ceil((k * 4) / 3) + 4, b64.length - 4);
    out.push([`${label} (base64, offset ${k})`, Buffer.from(middle)]);
    out.push([
      `${label} (base64url, offset ${k})`,
      Buffer.from(middle.replace(/\+/g, '-').replace(/\//g, '_')),
    ]);
  }
  out.push([`${label} (hex)`, Buffer.from(raw.toString('hex'))]);
  if (typeof value !== 'string') {
    const digest = createHash('sha256').update(raw).digest();
    out.push([`${label} (sha256)`, digest], [`${label} (sha256 hex)`, Buffer.from(digest.toString('hex'))]);
  }
  return out;
}
