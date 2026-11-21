/**
 * Two little HTTP servers for trying the widget in a real browser (run.ts):
 *
 * - a **website** (`host`) on one origin: a plain page with a strict Content-Security-Policy (no inline script or
 *   style) that embeds `widget.js` with the attributes given in its query string;
 * - a **Whombat stub** on another origin: the built `dist/v1` files, a `frame.html` with the same headers the
 *   server sends, and canned answers for the two public JSON endpoints (recorded for assertions).
 *
 * The website can also point at a real Whombat (`whombatUrl`), in which case the stub isn't needed.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';

export const WIDGET_ROOT = resolve(import.meta.dirname, '..');
export const DIST = join(WIDGET_ROOT, 'dist', 'v1');

export interface StubReport {
  site: string;
  origin: string | undefined;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** The code every sign-in of the stub (and the fake control of drop.ts) accepts. */
export const STUB_CODE = '123456';

/** A reporter's report as the stub lists it (`FeedbackReporterReport`). */
export interface StubReporterReport {
  reference: string;
  type: 'bug' | 'feature';
  status: string;
  receivedAt: string;
  updatedAt: string;
  summary: string | null;
}

/**
 * Reporter sign-in as both the runtime and control answer it (CT-162, CT-164): codes asked for, sessions by token,
 * each address's reports. Shared by the stub (direct mode) and drop.ts's fake control.
 */
export class StubReporters {
  codes: { email: string; parent: string }[] = [];
  sessions = new Map<string, string>();
  signOuts: (string | undefined)[] = [];
  reports = new Map<string, StubReporterReport[]>();
  /** Answer the next reporter routes with 404 (a server without them). */
  off = false;
  private seq = 0;

  /** Handles `…/reporter/<what>`; null when `what` isn't one of them. */
  handle(
    what: string,
    method: string,
    body: string,
    authorization: string | undefined,
  ): { status: number; body?: unknown } | null {
    if (this.off && /^(code|session|reports)$/.test(what)) return { status: 404, body: unavailable };
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    if (what === 'code' && method === 'POST') {
      const b = JSON.parse(body) as { email: string; parent: string };
      this.codes.push({ email: b.email.trim().toLowerCase(), parent: b.parent });
      return { status: 202, body: { ok: true } };
    }
    if (what === 'session' && method === 'POST') {
      const b = JSON.parse(body) as { email: string; code: string };
      if (b.code !== STUB_CODE)
        return { status: 400, body: { error: { code: 'code_refused', message: 'That code didn’t work.' } } };
      const t = `fbrs_${String(++this.seq).padStart(43, 'x')}`;
      const email = b.email.trim().toLowerCase();
      this.sessions.set(t, email);
      return {
        status: 200,
        body: { token: t, email, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() },
      };
    }
    if (what === 'session' && method === 'DELETE') {
      this.signOuts.push(token);
      if (token) this.sessions.delete(token);
      return { status: 204 };
    }
    if (what === 'reports' && method === 'GET') {
      const email = token ? this.sessions.get(token) : undefined;
      if (!email) return { status: 401, body: { error: { code: 'signed_out', message: 'Signed out.' } } };
      return { status: 200, body: { email, reports: this.reports.get(email) ?? [] } };
    }
    return null;
  }

  emailOf(authorization: string | undefined): string | undefined {
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    return token ? this.sessions.get(token) : undefined;
  }
}

const unavailable = { error: { code: 'unavailable', message: 'Not available.' } };

export interface Stub {
  origin: string;
  reports: StubReport[];
  /** Queue answers for the next submissions (default 201 with a receipt). */
  answers: { status: number; body: unknown }[];
  /** Site ids the stub knows (config 200); anything else is 404. */
  sites: Map<string, Record<string, unknown>>;
  reporters: StubReporters;
  close(): Promise<void>;
}

export const STUB_CONFIG = {
  productLabel: 'Acme Shop',
  reportTypes: ['bug', 'feature'],
  theme: 'auto',
  position: 'bottom-right',
  launcher: 'floating',
  launcherLabel: 'Feedback',
  privacyUrl: 'https://example.com/privacy',
  contactFields: { name: 'optional', email: 'optional' },
  attachments: { max: 3, maxBytes: 3 * 1024 * 1024, types: ['image/png', 'image/jpeg'] },
  text: { description: 5000, expected: 3000, steps: 3000 },
  redactPaths: ['/customers/*'],
  contextKeys: ['plan'],
  trail: true,
  reporters: true,
};

/** An older runtime's config: no trail, no sign-in (the keys are absent). */
export const OLD_CONFIG = Object.fromEntries(
  Object.entries(STUB_CONFIG).filter(([k]) => k !== 'trail' && k !== 'reporters'),
);

function listen(server: Server, port: number): Promise<void> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
}

function closer(server: Server): () => Promise<void> {
  return () => new Promise((ok) => server.close(() => ok()));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer) {
  res.writeHead(status, headers);
  res.end(body);
}

const CSP = (ancestor: string) =>
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors ${ancestor}`;

/** The Whombat side on `http://127.0.0.1:<port>`; frames are allowed for `hostOrigin` only. */
export async function startStub(port: number, hostOrigin: string): Promise<Stub> {
  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as {
    loader: string;
    frame: { js: string; css: string };
    files: Record<string, unknown>;
  };
  const origin = `http://127.0.0.1:${port}`;
  const stub: Stub = {
    origin,
    reports: [],
    answers: [],
    sites: new Map<string, Record<string, unknown>>([
      ['fbs_e2eSite00000000000000000', STUB_CONFIG],
      ['fbs_e2eOldRuntime00000000000', OLD_CONFIG],
    ]),
    reporters: new StubReporters(),
    close: async () => {},
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;
    if (path === '/embed/v1/widget.js' || path.startsWith('/embed/v1/assets/')) {
      const name = path.slice('/embed/v1/'.length);
      if (!(name in manifest.files)) return send(res, 404, {}, 'not found');
      return send(
        res,
        200,
        {
          'content-type': `${name.endsWith('.css') ? 'text/css' : 'application/javascript'}; charset=utf-8`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': name === 'widget.js' ? 'cross-origin' : 'same-origin',
        },
        readFileSync(join(DIST, name)),
      );
    }
    if (path === '/embed/v1/frame.html') {
      const site = url.searchParams.get('site') ?? '';
      const parent = url.searchParams.get('parent') ?? '';
      const theme = url.searchParams.get('theme');
      const ok = stub.sites.has(site) && parent === hostOrigin;
      const html = ok
        ? `<!doctype html>\n<html lang="en"${theme === 'light' || theme === 'dark' ? ` data-theme="${theme}"` : ''}>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Feedback</title>\n<link rel="stylesheet" href="${manifest.frame.css}">\n<script src="${manifest.frame.js}" defer></script>\n</head>\n<body>\n<div id="wb-root"></div>\n</body>\n</html>\n`
        : '<!doctype html><title>Feedback unavailable</title><p>Feedback isn’t available here.</p>';
      return send(
        res,
        ok ? 200 : 404,
        {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': CSP(ok ? parent : "'none'"),
          ...(ok ? {} : { 'x-frame-options': 'DENY' }),
        },
        html,
      );
    }
    const config = path.match(/^\/embed\/v1\/sites\/([^/]+)\/config$/);
    if (config && req.method === 'GET') {
      const cfg = stub.sites.get(config[1] ?? '');
      if (!cfg || url.searchParams.get('parent') !== hostOrigin)
        return send(
          res,
          404,
          { 'content-type': 'application/json' },
          JSON.stringify({ error: { code: 'unavailable', message: 'Not available.' } }),
        );
      return send(
        res,
        200,
        { 'content-type': 'application/json', 'cache-control': 'no-store' },
        JSON.stringify(cfg),
      );
    }
    const reporter = path.match(/^\/embed\/v1\/sites\/([^/]+)\/reporter\/([a-z]+)$/);
    if (reporter && stub.sites.get(reporter[1] ?? '')?.reporters === true) {
      const answer = stub.reporters.handle(
        reporter[2] ?? '',
        req.method ?? 'GET',
        await readBody(req),
        req.headers.authorization,
      );
      if (answer)
        return send(
          res,
          answer.status,
          { 'content-type': 'application/json', 'cache-control': 'no-store' },
          answer.body === undefined ? '' : JSON.stringify(answer.body),
        );
    }
    const reports = path.match(/^\/embed\/v1\/sites\/([^/]+)\/reports$/);
    if (reports && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      stub.reports.push({
        site: reports[1] ?? '',
        origin: req.headers.origin,
        authorization: req.headers.authorization,
        body,
      });
      const answer = stub.answers.shift() ?? {
        status: 201,
        body: { reference: 'FB-7K3Q-9M2X', receivedAt: new Date().toISOString() },
      };
      return send(res, answer.status, { 'content-type': 'application/json' }, JSON.stringify(answer.body));
    }
    send(res, 404, { 'content-type': 'text/plain' }, 'not found');
  });
  await listen(server, port);
  stub.close = closer(server);
  return stub;
}

const HOST_CSS = `
:root{color-scheme:light dark}
body{margin:0;font:16px/1.5 Georgia,serif;background:#faf7f2;color:#2a2521}
@media (prefers-color-scheme:dark){body{background:#1d1a17;color:#eee4d8}}
header{padding:20px 32px;border-bottom:1px solid rgba(0,0,0,.1);display:flex;justify-content:space-between;align-items:center}
main{max-width:760px;margin:40px auto;padding:0 24px}
h1{font-size:34px;margin:0 0 12px}
.card{border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:18px;margin:18px 0}
button.site{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}
`;

/** Page titles by path, so the navigation trail has something to show. */
function titleOf(path: string): string {
  if (path.startsWith('/orders')) return 'Orders · Acme Shop';
  if (path.startsWith('/account')) return 'Account · Acme Shop';
  if (path.startsWith('/products')) return 'Products · Acme Shop';
  return 'Acme Shop';
}

/**
 * The website on `http://localhost:<port>`: `/?site=…&theme=…&launcher=…&position=…&label=…&key=…&whombat=<url>`.
 * `whombat` defaults to `whombatOrigin`.
 */
export async function startHost(
  port: number,
  whombatOrigin: string,
): Promise<{ origin: string; close(): Promise<void> }> {
  const origin = `http://localhost:${port}`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname === '/site.css') return send(res, 200, { 'content-type': 'text/css' }, HOST_CSS);
    if (url.pathname === '/favicon.ico') return send(res, 204, {}, '');
    const q = url.searchParams;
    const whombat = q.get('whombat') ?? whombatOrigin;
    const attrs = [
      ['data-site', q.get('site') ?? 'fbs_e2eSite00000000000000000'],
      ['data-theme', q.get('theme') ?? 'auto'],
      ['data-position', q.get('position') ?? 'bottom-right'],
      ...(q.get('launcher') ? [['data-launcher', q.get('launcher') as string]] : []),
      ...(q.get('label') ? [['data-label', q.get('label') as string]] : []),
      // A managed Whombat's snippet pins the site key (drop mode, drop.ts).
      ...(q.get('key') ? [['data-key', q.get('key') as string]] : []),
      ...(q.get('trail') ? [['data-trail', q.get('trail') as string]] : []),
    ]
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
      .join(' ');
    const twice =
      q.get('twice') === '1' ? `<script src="${whombat}/embed/v1/widget.js" ${attrs} defer></script>` : '';
    const trigger =
      q.get('launcher') === 'custom' || q.get('trigger') === '1'
        ? '<button class="site" id="help" type="button" data-whombat-feedback="feature">Suggest a feature</button>'
        : '';
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleOf(url.pathname)}</title>
<link rel="stylesheet" href="/site.css">
<script src="${whombat}/embed/v1/widget.js" ${attrs} defer></script>
${twice}
</head>
<body>
<header><strong>Acme Shop</strong>${trigger}</header>
<main>
<h1>Your orders</h1>
<p>Order history for your account. Search, filter and download invoices.</p>
<div class="card"><strong>Order 1042</strong><br>2 items · shipped 12 September</div>
<div class="card"><strong>Order 1038</strong><br>1 item · delivered 3 September</div>
<p><button class="site" id="plain" type="button">A page button</button></p>
</main>
</body>
</html>
`;
    send(
      res,
      200,
      {
        'content-type': 'text/html; charset=utf-8',
        // Strict: the widget must work without unsafe-inline and without connect-src to Whombat.
        'content-security-policy': `default-src 'self'; script-src 'self' ${whombat}; frame-src ${whombat}; style-src 'self'; img-src 'self'; connect-src 'self'`,
      },
      html,
    );
  });
  await listen(server, port);
  return { origin, close: closer(server) };
}
