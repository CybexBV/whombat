/**
 * A stand-in Chromium for tests of the browser's own work (kept sites, the watchdog): a DevTools server on loopback that
 * answers `/json/version` and, over its browser WebSocket, `Storage.getCookies`, `Storage.setCookies` (an expired cookie
 * removes the one it names, as Chromium's does), `Target.getTargets` (the pages a test opens), attaching to a page and
 * evaluating in it, closing a page, a throwaway context with a new page, and anything else with `{}`. A test can make it
 * break as Chromium does: the browser stops answering (`stuck`), a page stops answering (`stuckPages`), new pages don't
 * answer (`noNewPages`), pages can't be closed (`unclosable`). Its host (`StandInChromiumHost`) "starts" it as the relay's
 * `BrowserHost.start` does — a process that prints Chromium's DevTools line — and each start is a fresh profile that
 * works: no cookies, no pages. Never for a real runner.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import type { KeptCookie, KeptSite } from '@whombat/core';
import { RunnerApiError } from './api';
import { type BrowserHost, ClientFrames, textFrame } from './browser';
import type { BrowserCookie, TurnKeptSites } from './kept-sites';

export class StandInChromium {
  /** What it heard, in order: `GET <path>` for HTTP, the CDP method for each command. */
  readonly heard: string[] = [];
  /** The cookie jar of its default context. */
  cookies: BrowserCookie[] = [];
  /** The pages open now (their addresses; a page's target id is `t:<address>`). */
  pages: string[] = [];
  /** The browser answers no command. */
  stuck = false;
  /** The pages (addresses) whose `Runtime.evaluate` never answers. */
  stuckPages = new Set<string>();
  /** A page it starts now never answers. */
  noNewPages = false;
  /** `Target.closeTarget` answers, and the page stays. */
  unclosable = false;
  /** The DevTools WebSockets open now, and the most that were at once. */
  sockets = 0;
  maxSockets = 0;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  /** The throwaway pages (target id → whether it answers). */
  readonly #newPages = new Map<string, boolean>();
  #next = 0;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async open(): Promise<StandInChromium> {
    let self: StandInChromium | null = null;
    const server = createServer((req, res) => {
      self?.heard.push(`GET ${req.url}`);
      if (req.url === '/json/version')
        return res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ webSocketDebuggerUrl: `ws://${req.headers.host}/devtools/browser/b-1` }));
      if (req.url === '/json/list')
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([]));
      res.writeHead(404).end();
    });
    self = new StandInChromium(server);
    const chromium = self;
    server.on('connection', (s: Socket) => {
      chromium.#sockets.add(s);
      s.once('close', () => chromium.#sockets.delete(s));
    });
    server.on('upgrade', (req, socket: Socket) =>
      chromium.#upgrade(req.headers['sec-websocket-key'], socket),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return chromium;
  }

  get port(): number {
    return (this.#server.address() as { port: number }).port;
  }

  /** A fresh profile (Chromium started again), which works. */
  fresh(): void {
    this.cookies = [];
    this.pages = [];
    this.stuck = false;
    this.stuckPages.clear();
    this.noNewPages = false;
    this.unclosable = false;
    this.#newPages.clear();
  }

  /** How many times it heard `method`. */
  count(method: string): number {
    return this.heard.filter((h) => h === method).length;
  }

  /** The names of the cookies in the jar, sorted. */
  names(): string[] {
    return this.cookies.map((c) => c.name).sort();
  }

  #upgrade(key: unknown, socket: Socket): void {
    const accept = createHash('sha1')
      .update(`${String(key)}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.sockets++;
    this.maxSockets = Math.max(this.maxSockets, this.sockets);
    socket.once('close', () => this.sockets--);
    const frames = new ClientFrames(
      (text) => {
        if (text === null) return null;
        const { id, method, params, sessionId } = JSON.parse(text) as {
          id: number;
          method: string;
          params?: unknown;
          sessionId?: string;
        };
        this.heard.push(method);
        const answer = this.#answer(method, params, sessionId);
        if (answer === NO_ANSWER) return null;
        if (answer instanceof Error)
          socket.write(textFrame(JSON.stringify({ id, error: { code: -32000, message: answer.message } })));
        else socket.write(textFrame(JSON.stringify({ id, result: answer })));
        return null;
      },
      () => {},
      () => {},
      () => socket.destroy(),
    );
    socket.on('data', (d: Buffer) => frames.push(d));
    socket.on('error', () => {});
  }

  #answer(method: string, params: unknown, sessionId: string | undefined): unknown {
    if (this.stuck) return NO_ANSWER;
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'Storage.getCookies') return { cookies: this.cookies.map((c) => ({ ...c, size: 1 })) };
    if (method === 'Target.getTargets')
      return {
        targetInfos: [
          ...this.pages.map((url) => ({ targetId: `t:${url}`, type: 'page', url })),
          { targetId: 'sw-1', type: 'service_worker', url: 'https://example.com/sw.js' },
        ],
      };
    if (method === 'Target.attachToTarget') {
      const id = String(p.targetId);
      return this.#page(id) === undefined
        ? new Error('No target with given id found')
        : { sessionId: `s:${id}` };
    }
    if (method === 'Runtime.evaluate') {
      const answers = this.#page(String(sessionId).replace(/^s:/, ''));
      if (answers === undefined) return new Error('Session with given id not found');
      return answers ? { result: { type: 'number', value: 1, description: '1' } } : NO_ANSWER;
    }
    if (method === 'Target.closeTarget') {
      const id = String(p.targetId);
      if (!this.unclosable) this.pages = this.pages.filter((url) => `t:${url}` !== id);
      return { success: true };
    }
    if (method === 'Target.createBrowserContext') return { browserContextId: `c${++this.#next}` };
    if (method === 'Target.createTarget') {
      const id = `n${++this.#next}`;
      this.#newPages.set(id, !this.noNewPages);
      return { targetId: id };
    }
    if (method === 'Storage.setCookies') {
      for (const c of (params as { cookies: BrowserCookie[] }).cookies) {
        this.cookies = this.cookies.filter(
          (o) => !(o.name === c.name && o.domain === c.domain && o.path === c.path),
        );
        const expired = typeof c.expires === 'number' && c.expires > 0 && c.expires < Date.now() / 1000;
        if (!expired) this.cookies.push({ ...c });
      }
      return {};
    }
    return {};
  }

  /** Whether a page answers (undefined: no such page). */
  #page(targetId: string): boolean | undefined {
    if (this.#newPages.has(targetId)) return this.#newPages.get(targetId);
    const url = this.pages.find((u) => `t:${u}` === targetId);
    return url === undefined ? undefined : !this.stuckPages.has(url);
  }

  close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    return new Promise((r) => this.#server.close(() => r()));
  }
}

/** A command the stand-in never answers. */
const NO_ANSWER = Symbol('no answer');

/**
 * A browser host whose Chromium is `chromium` (each start a fresh profile); `kill()` ends the one running, as a
 * Chromium that crashed.
 */
export class StandInChromiumHost implements BrowserHost {
  readonly shell = '/bin/bash';
  starts = 0;
  /** Its processes that ended. */
  ended = 0;
  #running: Duplex | null = null;

  constructor(private readonly chromium: StandInChromium) {}

  async start(_argv: readonly string[]): Promise<Socket> {
    this.starts++;
    this.chromium.fresh();
    const line = `echo 'DevTools listening on ws://127.0.0.1:${this.chromium.port}/devtools/browser/b-1' >&2; sleep 60`;
    const child = spawn('bash', ['-c', line], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stream = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        child.stdin.write(chunk, cb);
      },
      destroy(_err, cb) {
        child.kill('SIGKILL');
        cb(null);
      },
    });
    child.stdout.on('data', (d: Buffer) => stream.push(d));
    child.stderr.on('data', (d: Buffer) => stream.push(d));
    child.on('close', () => {
      this.ended++;
      stream.push(null);
      stream.destroy();
    });
    child.stdin.on('error', () => {});
    this.#running = stream;
    return stream as unknown as Socket;
  }

  connect(port: number): Socket {
    return connect(port, '127.0.0.1');
  }

  /** Ends the running Chromium; resolves once it is gone. */
  kill(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running || running.destroyed) return Promise.resolve();
    return new Promise((r) => {
      running.once('close', () => r());
      running.destroy();
    });
  }
}

/** A kept site as the server answers it. */
export const keptSite = (id: string, origins: string[], over: Partial<KeptSite> = {}): KeptSite => ({
  id,
  site: new URL(origins[0] as string).hostname,
  origins,
  agentId: 'prn_agent00000001',
  hours: 4,
  keptAt: '2026-11-13T10:00:00.000Z',
  lastUsedAt: '2026-11-13T10:00:00.000Z',
  expiresAt: '2026-11-13T14:00:00.000Z',
  ...over,
});

/** The server's kept sites standing in: what it keeps (with cookies), and every call. */
export class StandInKeptServer {
  readonly calls: { method: string; siteId?: string; cookies?: KeptCookie[] }[] = [];
  kept = new Map<string, { site: KeptSite; cookies: KeptCookie[] }>();
  next = 1;

  readonly api = {
    keptSiteRestore: async () => {
      this.calls.push({ method: 'restore' });
      return { sites: [...this.kept.values()].map((k) => ({ site: k.site, cookies: k.cookies })) };
    },
    keptSiteRenew: async (siteId: string, body: { cookies: KeptCookie[] }) => {
      this.calls.push({ method: 'renew', siteId, cookies: body.cookies });
      const k = this.kept.get(siteId);
      if (!k) throw new RunnerApiError(404, null, 'not kept');
      k.cookies = body.cookies;
      return { site: k.site };
    },
  };

  turn(): TurnKeptSites {
    return {
      keep: async (body) => {
        this.calls.push({ method: 'keep', cookies: body.cookies });
        const s = keptSite(`kst_site0000000${this.next++}`, body.origins, { hours: body.hours ?? 4 });
        for (const [id, k] of this.kept)
          if (k.site.origins.some((o) => body.origins.includes(o))) this.kept.delete(id);
        this.kept.set(s.id, { site: s, cookies: body.cookies });
        return s;
      },
      forget: async (origins) => {
        this.calls.push({ method: 'forget' });
        const gone = [...this.kept.values()].filter((k) => k.site.origins.some((o) => origins.includes(o)));
        for (const k of gone) this.kept.delete(k.site.id);
        return gone.map((k) => k.site);
      },
      list: async () => [...this.kept.values()].map((k) => k.site),
    };
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}
