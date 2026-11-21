// Vite dev-server plugin that mocks the hub for `pnpm dev:fixtures`:
//   - /api/v1/* from the hand-off fixtures plus per-browser mutable state
//     (auth, enrollment, settings, audit, actions, console sessions, SSE);
//   - the console WebSocket at /api/v1/console/{sid} (fake shell, optional
//     TCP relay for VNC / SPICE);
//   - page-load toggles (?setup=1, ?signedout=1, ?role=viewer|operator|admin).
//
// Times are frozen at the fixture's `as_of` (2026-10-11T14:00:00Z) by default;
// FIXTURE_TIME=live shifts the fixture timestamps so that `as_of` is 8 s
// before the real clock. Other env: FIXTURE_CONSOLE_IDLE_S (default 900),
// FIXTURE_CONSOLE_RELAY ("vnc=127.0.0.1:5900,spice=127.0.0.1:5930").

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { handleApi } from './api.ts';
import { applyPageToggles } from './auth.ts';
import { createConsoleServer, parseRelay } from './console.ts';
import { type FxRequest, problem, readJsonBody, writeResponse } from './http.ts';
import { FixtureStore } from './state.ts';

/** HTML navigations of the SPA (served by Vite, not by the API middleware). */
export function isPageLoad(req: Pick<IncomingMessage, 'method' | 'url' | 'headers'>): boolean {
  if (req.method !== 'GET' || !String(req.headers.accept ?? '').includes('text/html')) return false;
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  return !/^\/(api|@vite|@fs|@id|@react-refresh|src|node_modules)(\/|$)/.test(path);
}

function appendCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), cookie]);
}

async function toFxRequest(req: IncomingMessage): Promise<FxRequest> {
  const url = new URL(req.url ?? '/', 'http://fixtures.local');
  const { body, invalid } = await readJsonBody(req);
  return {
    method: req.method ?? 'GET',
    path: url.pathname.replace(/^\/api\/v1/, '').replace(/\/$/, '') || '/',
    query: url.searchParams,
    headers: req.headers,
    body,
    bodyInvalid: invalid,
    ip: (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''),
    host: req.headers.host ?? 'localhost',
  };
}

export function fixturesPlugin(): Plugin {
  return {
    name: 'rackoon-fixtures',
    apply: 'serve',
    configureServer(server) {
      const log = server.config.logger;
      const store = new FixtureStore();
      const relay = parseRelay(process.env.FIXTURE_CONSOLE_RELAY);
      const consoles = createConsoleServer(store, { relay, log: (m) => log.info(`[fixtures] ${m}`) });

      // Page loads get the browser cookie (so the API calls that follow share
      // its state) and apply the auth toggles from the query string.
      server.middlewares.use((req, res, next) => {
        if (isPageLoad(req)) {
          const { state, setCookie } = store.resolve(req.headers.cookie);
          if (setCookie) appendCookie(res, setCookie);
          applyPageToggles(state, new URL(req.url ?? '/', 'http://fixtures.local').searchParams);
        }
        next();
      });

      server.middlewares.use('/api/v1', (req, res) => {
        // connect strips the mount path; restore it for the router.
        req.url = '/api/v1' + (req.url ?? '/');
        toFxRequest(req)
          .then((fxReq) => writeResponse(req, res, handleApi(store, fxReq)))
          .catch((err: unknown) => {
            log.error(`[fixtures] ${String(err)}`);
            if (!res.headersSent) writeResponse(req, res, problem(500, 'internal', String(err)));
            else res.end();
          });
      });

      // Only /api/v1/console/* upgrades are ours; Vite's HMR socket is left alone.
      server.httpServer?.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
        consoles.handleUpgrade(req, socket, head);
      });
      server.httpServer?.on('close', () => {
        consoles.close();
        store.dispose();
      });

      log.info('  ➜  Serving /api/v1 from docs/handoff/sample-data (fixture mode, per-browser state)');
      if (relay.size) log.info(`  ➜  Console relay: ${[...relay].map(([p, t]) => `${p} → ${t.host}:${t.port}`).join(', ')}`);
    },
  };
}
