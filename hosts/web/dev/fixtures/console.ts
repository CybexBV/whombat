// Mock console WebSocket (CONTRACT 4) at /api/v1/console/{sid}. Text
// protocols talk to the fake shell (shell.ts); VNC / SPICE answer
// "fixture_mode" unless FIXTURE_CONSOLE_RELAY points them at a real server,
// in which case channel 0 (and SPICE's extra channels) are relayed over TCP.

import { STATUS_CODES, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { Guest } from '../../src/api/types.ts';
import { appendAudit } from './audit.ts';
import { findGuest } from './catalog.ts';
import { loadFixtures } from './data.ts';
import { pushEvent } from './events.ts';
import { decodeFrame, encodeControl, encodeData, FRAME_CONTROL, FRAME_DATA, MAX_FRAME_PAYLOAD, parseControl, type ConsoleControl } from './frames.ts';
import { defaultResolution, guestKey } from './guests.ts';
import { parseCookies } from './http.ts';
import { consoleIdleS, effectivePerms } from './remote.ts';
import { type ShellEffect, FakeShell } from './shell.ts';
import { type BrowserState, type ConsoleSessionRec, COOKIE, type FixtureStore, findServer } from './state.ts';

export const CONSOLE_PATH = '/api/v1/console/';
export const SUBPROTOCOL = 'rackoon.console.v1';
export const TOKEN_PREFIX = 'rackoon.token.';
export const MAX_AGE_MS = 8 * 3600_000;

export interface RelayTarget {
  host: string;
  port: number;
}

/** FIXTURE_CONSOLE_RELAY="vnc=127.0.0.1:5900,spice=127.0.0.1:5930" */
export function parseRelay(value: string | undefined): Map<string, RelayTarget> {
  const out = new Map<string, RelayTarget>();
  for (const part of (value ?? '').split(',')) {
    const m = /^\s*([a-z]+)\s*=\s*(\[[^\]]+\]|[^:\s]+):(\d+)\s*$/.exec(part);
    if (m) out.set(m[1]!, { host: m[2]!.replace(/^\[|\]$/g, ''), port: Number(m[3]) });
  }
  return out;
}

export interface ConsoleServerOptions {
  relay?: Map<string, RelayTarget>;
  /** Idle timeout in seconds (default: FIXTURE_CONSOLE_IDLE_S or 900). */
  idleS?: () => number;
  log?: (msg: string) => void;
}

/** Refuse an upgrade with a problem+json HTTP response. */
function reject(socket: Duplex, status: number, code: string, detail: string): void {
  const body = JSON.stringify({ type: `https://rackoon.dev/problems/${code}`, title: STATUS_CODES[status], status, detail, code });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/problem+json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
      `Cache-Control: no-store\r\nConnection: close\r\n\r\n${body}`,
  );
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** One live console session. */
class ConsoleConn {
  private ended = false;
  private finished = false;
  private bytesIn = 0;
  private bytesOut = 0;
  private openedReal = 0;
  private lastActivity = 0;
  private shell: FakeShell | null = null;
  private readonly decoder = new TextDecoder('utf-8');
  private readonly tcp = new Map<number, Socket>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly intervals = new Set<ReturnType<typeof setInterval>>();

  constructor(
    private readonly store: FixtureStore,
    private readonly st: BrowserState,
    private readonly s: ConsoleSessionRec,
    private readonly guest: Guest,
    private readonly ws: WebSocket,
    private readonly opts: ConsoleServerOptions,
  ) {}

  start(): void {
    const { s, ws } = this;
    s.close = (reason) => this.end(reason);
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', () => this.finish('client_closed'));
    ws.on('error', () => undefined);
    this.openedReal = this.lastActivity = this.store.now();

    if (this.guest.state === 'stopped') return this.failOpen('guest_not_running', 'The guest is powered off.');
    const relay = this.opts.relay?.get(s.protocol);
    if (relay) return this.startRelay(relay);
    if (s.protocol === 'shell' || s.protocol === 'tty' || s.protocol === 'serial') return this.startShell(s.protocol);
    const label = s.protocol === 'vnc' ? 'VNC' : 'SPICE';
    this.failOpen('fixture_mode', `${label} is not available in fixture mode. Run against a hub (pnpm dev) to use graphical consoles.`);
  }

  // ---- audit and lifecycle

  private auditBase() {
    const { s } = this;
    return { server: s.server, guest: s.guestId, platform: this.guest.platform, protocol: s.protocol, user: s.user, role: s.role, client_ip: s.clientIp, user_agent: s.userAgent || null };
  }

  /** The guest end is open: audit, `status`, timers. */
  private opened(resolution: string): void {
    appendAudit(this.store, this.st, { ...this.auditBase(), event: 'console.opened', details: { session_id: this.s.id, resolution } });
    this.sendControl({ type: 'status', state: 'connected', protocol: this.s.protocol, resolution });
    const idleMs = (this.opts.idleS ?? consoleIdleS)() * 1000;
    const tick = setInterval(() => {
      if (this.store.now() - this.lastActivity >= idleMs) this.end('idle_timeout');
    }, Math.min(1000, idleMs));
    this.intervals.add(tick);
    this.later(MAX_AGE_MS, () => this.end('max_age'));
  }

  /** The guest end could not be opened: `error`, close, no session. */
  private failOpen(code: string, message: string): void {
    appendAudit(this.store, this.st, { ...this.auditBase(), event: 'console.opened', outcome: 'error', code, details: { session_id: this.s.id } });
    this.sendControl({ type: 'error', code, message });
    this.finished = this.ended = true;
    this.cleanup();
    this.ws.close(1000, code);
  }

  /** Hub-initiated end: `closed {reason}`, then close the socket. */
  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.sendControl({ type: 'closed', reason });
    this.ws.close(1000, reason);
    this.finish(reason);
  }

  /** Abrupt loss: no closed control (the UI shows "Connection lost"). */
  private drop(): void {
    if (this.ended) return;
    this.ended = true;
    this.ws.terminate();
    this.finish('client_closed');
  }

  private cleanup(): void {
    for (const t of this.timers) clearTimeout(t);
    for (const t of this.intervals) clearInterval(t);
    this.timers.clear();
    this.intervals.clear();
    for (const sock of this.tcp.values()) sock.destroy();
    this.tcp.clear();
    this.s.live = false;
    this.s.close = null;
    this.st.sessions.delete(this.s.id);
  }

  private finish(reason: string): void {
    if (this.finished) return;
    this.finished = this.ended = true;
    this.cleanup();
    const secs = Math.floor((this.store.now() - this.openedReal) / 100) / 10;
    appendAudit(this.store, this.st, {
      ...this.auditBase(),
      event: 'console.closed',
      code: reason,
      duration_s: secs,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut,
      details: { session_id: this.s.id },
    });
    pushEvent(this.st, 'console.closed', { session_id: this.s.id, reason });
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  // ---- frames

  private sendControl(c: ConsoleControl): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeControl(c));
  }

  private sendData(channel: number, data: Uint8Array | string): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    for (const frame of encodeData(channel, data)) {
      this.bytesOut += frame.length - 3;
      this.ws.send(frame);
    }
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (!isBinary || this.ended) return;
    const f = decodeFrame(toBuffer(data));
    if (!f) return;
    if (f.kind === FRAME_DATA) {
      this.bytesIn += f.payload.length;
      this.lastActivity = this.store.now();
      if (this.shell && f.channel === 0) this.apply(this.shell.input(this.decoder.decode(f.payload, { stream: true })));
      else this.tcp.get(f.channel)?.write(f.payload);
      return;
    }
    if (f.kind !== FRAME_CONTROL) return;
    const c = parseControl(f.payload);
    if (!c) return;
    const clamp = (v: number | undefined, d: number) => Math.min(1000, Math.max(1, v ?? d));
    switch (c.type) {
      case 'activity':
        this.lastActivity = this.store.now();
        break;
      case 'resize':
        this.shell?.resize(clamp(c.cols, 80), clamp(c.rows, 24));
        break;
      case 'ping': {
        // A few ms of "network" so the latency readout looks real.
        const id = c.id ?? 0;
        this.later(2 + Math.floor(Math.random() * 8), () => this.sendControl({ type: 'pong', id }));
        break;
      }
      case 'open':
        if (c.channel) this.openChannel(c.channel);
        break;
      case 'close':
        if (c.channel) {
          const sock = this.tcp.get(c.channel);
          this.tcp.delete(c.channel);
          sock?.destroy();
        }
        break;
    }
  }

  // ---- fake shell

  private startShell(protocol: 'shell' | 'tty' | 'serial'): void {
    const g = this.guest;
    this.shell = new FakeShell({
      target: { name: g.name, image: g.image, platform: g.platform, kind: g.kind, uptimeS: g.uptime_s },
      protocol,
      clock: () => this.store.fxNow(),
      now: this.store.now,
    });
    this.opened(`${this.shell.cols}x${this.shell.rows}`);
    this.apply(this.shell.start());
  }

  private apply(effects: ShellEffect[]): void {
    for (const e of effects) {
      if (this.ended) return;
      if (e.type === 'output') this.sendData(0, e.data);
      else if (e.type === 'error') this.sendControl({ type: 'error', code: e.code, message: e.message });
      else if (e.type === 'close') this.end(e.reason);
      else this.drop();
    }
  }

  // ---- TCP relay (FIXTURE_CONSOLE_RELAY)

  private startRelay(t: RelayTarget): void {
    const sock = connect({ host: t.host, port: t.port });
    let connected = false;
    this.tcp.set(0, sock);
    sock.once('connect', () => {
      connected = true;
      if (this.ended) return void sock.destroy();
      this.opts.log?.(`console ${this.s.id}: relaying ${this.s.protocol} to ${t.host}:${t.port}`);
      this.opened(this.guest.console.resolution ?? defaultResolution(this.guest));
    });
    sock.on('data', (b: Buffer) => this.sendData(0, b));
    sock.on('error', (err) => {
      if (!connected && !this.ended) this.failOpen('agent_error', `Could not connect to ${t.host}:${t.port} (fixture relay): ${err.message}`);
    });
    sock.on('close', () => {
      if (connected) this.end('ended');
    });
  }

  private openChannel(ch: number): void {
    const t = this.opts.relay?.get(this.s.protocol);
    if (!t || this.tcp.has(ch)) return;
    const sock = connect({ host: t.host, port: t.port });
    this.tcp.set(ch, sock);
    sock.once('connect', () => this.sendControl({ type: 'opened', channel: ch }));
    sock.on('data', (b: Buffer) => this.sendData(ch, b));
    sock.on('error', () => undefined);
    sock.on('close', () => {
      if (this.tcp.get(ch) !== sock) return;
      this.tcp.delete(ch);
      if (!this.ended) this.sendControl({ type: 'closed', channel: ch });
    });
  }
}

/** Find a session by id and token: the cookie's browser first, then any browser. */
function findSession(store: FixtureStore, cookieHeader: string | undefined, sid: string, token: string): { st: BrowserState; s: ConsoleSessionRec } | null {
  const own = store.states.get(parseCookies(cookieHeader)[COOKIE] ?? '');
  for (const st of own ? [own, ...store.states.values()] : store.states.values()) {
    const s = st.sessions.get(sid);
    if (s && s.token === token) return { st, s };
  }
  return null;
}

/** A guest with this browser's power-state override applied (uptime for the shell). */
function liveGuest(store: FixtureStore, st: BrowserState, s: ConsoleSessionRec): Guest | null {
  const g = findGuest(loadFixtures(), s.server, s.guestId);
  if (!g) return null;
  const o = st.guestOverrides.get(guestKey(s.server, s.guestId));
  if (o) {
    g.state = o.state;
    g.uptime_s = o.state === 'stopped' ? null : Math.floor((store.now() - o.sinceReal) / 1000);
  }
  return g;
}

export interface ConsoleServer {
  /** Handle an HTTP upgrade; false when the path is not a console path (leave it to others). */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => void;
}

export function createConsoleServer(store: FixtureStore, opts: ConsoleServerOptions = {}): ConsoleServer {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_PAYLOAD + 64,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(req.url ?? '/', 'http://fixtures.local');
    if (!url.pathname.startsWith(CONSOLE_PATH)) return false;
    const sid = decodeURIComponent(url.pathname.slice(CONSOLE_PATH.length));
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host.toLowerCase();
      } catch {
        host = '';
      }
      if (host !== (req.headers.host ?? '').toLowerCase()) {
        reject(socket, 403, 'bad_origin', 'Cross-origin WebSocket refused.');
        return true;
      }
    }
    const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    const token = protos.find((p) => p.startsWith(TOKEN_PREFIX))?.slice(TOKEN_PREFIX.length) ?? '';
    if (!protos.includes(SUBPROTOCOL) || !token) {
      reject(socket, 400, 'subprotocol', `Use the subprotocols ${SUBPROTOCOL} and ${TOKEN_PREFIX}<token>.`);
      return true;
    }
    const found = findSession(store, req.headers.cookie, sid, token);
    if (!found) {
      reject(socket, 403, 'invalid_token', 'The console token is not valid for this session.');
      return true;
    }
    const { st, s } = found;
    if (s.used) {
      reject(socket, 403, 'token_used', 'The console token was already used. Open the console again.');
      return true;
    }
    if (store.now() >= s.tokenExpiresReal) {
      st.sessions.delete(s.id);
      reject(socket, 403, 'token_expired', 'The console token expired. Open the console again.');
      return true;
    }
    // Re-authorize at upgrade time (sign-out, role, remote control, server deleted).
    const rec = findServer(st, s.server);
    const perms = rec ? effectivePerms(st, rec) : null;
    const guest = liveGuest(store, st, s);
    if (!st.authenticated || !rec || !perms?.console || !guest) {
      st.sessions.delete(s.id);
      reject(socket, 403, 'console_disabled', perms?.consoleReason ?? 'Remote control is not available for this session.');
      return true;
    }
    s.used = true;
    s.live = true;
    st.lastSeenReal = store.now();
    wss.handleUpgrade(req, socket, head, (ws) => new ConsoleConn(store, st, s, guest, ws, opts).start());
    return true;
  };

  return {
    handleUpgrade,
    close: () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
    },
  };
}
