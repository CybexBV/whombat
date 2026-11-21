/**
 * Websites for the end-to-end suite (run.ts), each on its own origin, every page under a strict
 * Content-Security-Policy (no inline script or style, no `connect-src` to Whombat):
 *
 * - `/plain`   exactly the generated basic snippet (from `api.feedback.getIntegration`), a text field and a link;
 * - `/custom`  the custom-launcher script tag from the generated snippet, a site button with
 *              `data-whombat-feedback="feature"`, and `/custom.js` (external) calling `setContext` and `open()`;
 * - `/hostile` aggressive global CSS (`/hostile.css`); `?widget=0` is the same page without the widget;
 * - `/forge`   the widget plus two child frames (same origin and another origin) that tests post forged messages from;
 * - `/direct`  an `<iframe>` of `frame.html` itself with whatever `site` / `parent` the query gives;
 * - `/child`   an empty page for child frames.
 *
 * `snippet` / `customScript` are filled in after the integration exists.
 */
import { createServer, type Server } from 'node:http';

export interface SiteOptions {
  port: number;
  whombat: string;
  /** Another origin allowed as a child frame on /forge. */
  foreign?: string;
  snippet: () => string;
  customScript: () => string;
  siteId: () => string;
}

export interface Site {
  origin: string;
  server: Server;
  close(): Promise<void>;
}

const SITE_CSS = `
:root{color-scheme:light dark}
body{margin:0;font:16px/1.5 Georgia,serif;background:#faf7f2;color:#2a2521}
@media (prefers-color-scheme:dark){body{background:#1d1a17;color:#eee4d8}}
header{padding:20px 32px;border-bottom:1px solid rgba(0,0,0,.1);display:flex;justify-content:space-between;align-items:center}
main{max-width:760px;margin:40px auto;padding:0 24px}
h1{font-size:34px;margin:0 0 12px}
.card{border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:18px;margin:18px 0}
button.site{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}
input.site{font:inherit;padding:6px 10px;border:1px solid #999;border-radius:6px}
`;

/** Everything a site with a careless global stylesheet might do to a widget. */
const HOSTILE_CSS = `
* { all: unset !important; }
html, body { display: block !important; }
div, p, main, header, h1, ul, li { display: block !important; }
button { display: none !important; }
iframe { width: 0 !important; height: 0 !important; display: none !important; }
[role="dialog"], [aria-haspopup] { visibility: hidden !important; }
whombat-feedback { display: none !important; }
body > * { position: relative !important; z-index: 2147483647 !important; }
.overlay-top { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; height: 120px !important; z-index: 2147483647 !important; background: rgb(200 0 0 / 30%) !important; }
.overlay-corner { position: fixed !important; right: 0 !important; bottom: 0 !important; width: 400px !important; height: 300px !important; z-index: 999999 !important; background: rgb(0 0 200 / 30%) !important; }
h1 { font-size: 40px !important; color: rgb(10, 120, 30) !important; margin: 7px !important; }
p { color: rgb(1, 2, 3) !important; }
a { color: rgb(200, 10, 10) !important; text-decoration: underline !important; }
`;

const CUSTOM_JS = `
// The site's own script: context for reports and a second way to open the widget.
function withFeedback(fn) {
  if (window.WhombatFeedback) fn(window.WhombatFeedback);
  else document.addEventListener('whombat-feedback:ready', function () { fn(window.WhombatFeedback); }, { once: true });
}
withFeedback(function (feedback) {
  feedback.setContext({ app: { version: '2.3.1', environment: 'staging' }, references: ['req_123'] });
  document.getElementById('menu-feedback').addEventListener('click', function () { feedback.open(); });
});
`;

function page(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${head}
</head>
<body>
${body}
</body>
</html>
`;
}

export async function startSite(opts: SiteOptions): Promise<Site> {
  const origin = `http://127.0.0.1:${opts.port}`;
  const base = `default-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    // `?whombat=<origin>` points the page at another Whombat (a dead port, a relay, the server with the module off);
    // `?theme=` stands for an integration whose theme is forced. Otherwise the generated snippet as it is.
    const w = url.searchParams.get('whombat') ?? opts.whombat;
    const theme = url.searchParams.get('theme');
    const snippet = () => {
      let s = opts.snippet().replaceAll(opts.whombat, w);
      if (theme === 'light' || theme === 'dark') s = s.replace('data-theme="auto"', `data-theme="${theme}"`);
      return s;
    };
    const send = (status: number, type: string, body: string, csp?: string) => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        ...(csp ? { 'content-security-policy': csp } : {}),
      });
      res.end(body);
    };
    const html = (body: string, csp: string) => send(200, 'text/html; charset=utf-8', body, csp);
    switch (url.pathname) {
      case '/site.css':
        return send(200, 'text/css', SITE_CSS);
      case '/hostile.css':
        return send(200, 'text/css', HOSTILE_CSS);
      case '/custom.js':
        return send(200, 'text/javascript', CUSTOM_JS);
      case '/favicon.ico':
        return send(204, 'text/plain', '');
      case '/child':
        return html(page('Child', '', '<p>child</p>'), base);
      case '/plain':
        // The strictest policy that still loads the widget: no script of the site's own at all.
        return html(
          page(
            'Orders · Acme Shop',
            `<link rel="stylesheet" href="/site.css">\n${snippet()}`,
            `<header><strong>Acme Shop</strong><a id="host-link" href="#orders">Orders</a></header>
<main><h1 id="orders">Your orders</h1><p>Order history for your account.</p>
<label>Search <input class="site" id="host-input" type="text"></label>
<div class="card"><strong>Order 1042</strong><br>2 items · shipped 12 September</div></main>`,
          ),
          `default-src 'self'; script-src ${w}; frame-src ${w}; style-src 'self'; img-src 'self'`,
        );
      case '/custom':
        return html(
          page(
            'Settings · Acme Shop',
            `<link rel="stylesheet" href="/site.css">\n${opts.customScript()}\n<script src="/custom.js" defer></script>`,
            `<header><strong>Acme Shop</strong><span><button class="site" id="suggest" type="button" data-whombat-feedback="feature">Suggest a feature</button>
<button class="site" id="menu-feedback" type="button">Help · Feedback</button></span></header>
<main><h1>Settings</h1><p>Your account settings.</p></main>`,
          ),
          `${base}; script-src 'self' ${w}; frame-src ${w}`,
        );
      case '/hostile': {
        const widget = url.searchParams.get('widget') !== '0';
        return html(
          page(
            'Hostile · Acme Shop',
            `<link rel="stylesheet" href="/hostile.css">${widget ? `\n${snippet()}` : ''}`,
            `<div class="overlay-top"></div><div class="overlay-corner"></div>
<main><h1 id="h">Hostile styles</h1><p id="p">A site whose CSS resets everything.</p><a id="a" href="#x">A link</a>
<button id="b" type="button">Hidden by the site</button></main>`,
          ),
          `${base}; script-src ${w}; frame-src ${w}`,
        );
      }
      case '/forge': {
        const foreign = opts.foreign ?? origin;
        return html(
          page(
            'Forge · Acme Shop',
            `<link rel="stylesheet" href="/site.css">\n${snippet()}`,
            `<main><h1>Messages</h1>
<iframe id="same" title="same-origin child" src="/child"></iframe>
<iframe id="other" title="other-origin child" src="${foreign}/child"></iframe></main>`,
          ),
          `${base}; script-src ${w}; frame-src ${w} 'self' ${foreign}`,
        );
      }
      case '/direct': {
        const site = url.searchParams.get('site') ?? opts.siteId();
        const parent = url.searchParams.get('parent') ?? origin;
        const src = `${w}/embed/v1/frame.html?site=${encodeURIComponent(site)}&parent=${encodeURIComponent(parent)}&theme=light#instance=AAAAAAAAAAAAAAAAAAAAAA`;
        return html(
          page(
            'Direct frame',
            '',
            `<main><h1>Direct</h1><iframe id="direct" title="direct" src="${src}" width="400" height="500"></iframe></main>`,
          ),
          `${base}; frame-src ${w}`,
        );
      }
      default:
        return send(404, 'text/plain', 'not found');
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port, '127.0.0.1', () => ok());
  });
  return {
    origin,
    server,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

/** A pass-through to Whombat on another port, closable mid-test: “Whombat went away after the page loaded”. */
export async function startRelay(port: number, target: string): Promise<Site> {
  const origin = `http://localhost:${port}`;
  const server = createServer(async (req, res) => {
    try {
      const upstream = await fetch(new URL(req.url ?? '/', target), { method: req.method });
      const headers: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') headers[k] = v;
      });
      res.writeHead(upstream.status, headers);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502).end();
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
  return {
    origin,
    server,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
