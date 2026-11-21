// Console transport (CONTRACT 4): one WebSocket to the hub per console
// session, carrying frames for several logical channels. Each channel is
// exposed as a WebSocket-like object (`VirtualSocket`) so the stock clients
// can use it unchanged: noVNC attaches channel 0 as a "raw channel", the
// SPICE client gets one virtual socket per SPICE channel through a factory,
// and xterm.js reads and writes channel 0 directly.
//
// Protocol details handled here:
// - subprotocols ["rackoon.console.v1", "rackoon.token.<token>"], binary frames;
// - channel 0 is open once the session is connected (`status` control or its
//   first data); extra channels are opened with {"type":"open"} and become
//   OPEN on {"type":"opened"};
// - ping every 5 s, latency = round trip of the matching pong;
// - `activity` at most once per 30 s, only when the UI reports real input;
// - `closed` with a reason ends the session (the hub closes the socket next).

import {
  decodeFrame,
  encodeControl,
  encodeData,
  FRAME_CONTROL,
  FRAME_DATA,
  type HubCloseReason,
  type IncomingControl,
  type OutgoingControl,
  parseControl,
} from './frames';

export const CONSOLE_SUBPROTOCOL = 'rackoon.console.v1';
export const TOKEN_SUBPROTOCOL_PREFIX = 'rackoon.token.';
export const PING_INTERVAL_MS = 5_000;
export const ACTIVITY_INTERVAL_MS = 30_000;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

type SocketCtor = new (url: string, protocols?: string | string[]) => WebSocket;

export interface TransportOptions {
  WebSocketImpl?: SocketCtor;
  pingIntervalMs?: number;
  activityIntervalMs?: number;
  now?: () => number;
}

export interface ConsoleStatus {
  state: string;
  protocol: string | null;
  resolution: string | null;
}

export interface ConsoleErrorInfo {
  code: string;
  message: string;
}

/** Why the session ended. */
export interface TransportCloseInfo {
  /** Reason from the hub's `closed` control (null when the socket just dropped). */
  reason: HubCloseReason | null;
  /** Last `error` control received, if any. */
  error: ConsoleErrorInfo | null;
  /** WebSocket close code. */
  code: number;
  /** close() was called by the UI. */
  byClient: boolean;
  /** The session had reached the connected state. */
  wasConnected: boolean;
}

interface TransportEvents {
  open: () => void;
  /** Channel 0 is usable (status "connected" or its first data). */
  connected: () => void;
  status: (s: ConsoleStatus) => void;
  latency: (ms: number) => void;
  error: (e: ConsoleErrorInfo) => void;
  close: (info: TransportCloseInfo) => void;
}

type Handler<K extends keyof TransportEvents> = TransportEvents[K];

function closeEvent(code: number, reason: string, wasClean: boolean): Event {
  if (typeof CloseEvent !== 'undefined') return new CloseEvent('close', { code, reason, wasClean });
  return Object.assign(new Event('close'), { code, reason, wasClean });
}

/**
 * WebSocket-shaped view of one console channel. Implements what noVNC
 * (`Websock.attach`) and spice-html5 (`SpiceConn`) use: readyState,
 * binaryType, protocol, url, bufferedAmount, send, close, the on* handler
 * properties and add/removeEventListener.
 */
export class VirtualSocket extends EventTarget {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  readyState: number = CONNECTING;
  binaryType: BinaryType = 'arraybuffer';
  readonly protocol: string = '';
  readonly extensions: string = '';
  readonly url: string;
  readonly channel: number;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private readonly transport: ConsoleTransport;
  private pending: (ArrayBuffer | ArrayBufferView | string)[] = [];
  private messageHandler: ((ev: MessageEvent) => void) | null = null;
  // Data that arrives before a client listens (the clients load lazily) is
  // held and delivered, in order, to the first message listener.
  private inbox: ArrayBuffer[] = [];
  private hasConsumer = false;

  constructor(transport: ConsoleTransport, channel: number, url: string) {
    super();
    this.transport = transport;
    this.channel = channel;
    this.url = url;
  }

  get bufferedAmount(): number {
    return this.transport.bufferedAmount;
  }

  get onmessage(): ((ev: MessageEvent) => void) | null {
    return this.messageHandler;
  }

  set onmessage(fn: ((ev: MessageEvent) => void) | null) {
    this.messageHandler = fn;
    if (fn) this.consume();
  }

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    super.addEventListener(type, listener, options);
    if (type === 'message' && listener) this.consume();
  }

  private consume(): void {
    this.hasConsumer = true;
    if (!this.inbox.length) return;
    queueMicrotask(() => {
      const q = this.inbox;
      this.inbox = [];
      for (const d of q) this.fire(new MessageEvent('message', { data: d }));
    });
  }

  send(data: ArrayBuffer | ArrayBufferView | string | Blob): void {
    if (data instanceof Blob) throw new TypeError('VirtualSocket.send does not accept Blobs');
    if (this.readyState === CONNECTING) {
      this.pending.push(data);
      return;
    }
    if (this.readyState !== OPEN) return;
    this.transport.sendData(this.channel, data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.transport.closeChannel(this.channel, code, reason);
  }

  /** @internal */
  _open(): void {
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN;
    const queued = this.pending;
    this.pending = [];
    this.fire(new Event('open'));
    for (const d of queued) this.send(d);
  }

  /** @internal */
  _message(data: ArrayBuffer): void {
    if (this.readyState !== OPEN) return;
    if (!this.hasConsumer || this.inbox.length) {
      this.inbox.push(data);
      return;
    }
    this.fire(new MessageEvent('message', { data }));
  }

  /** @internal */
  _closed(code: number, reason: string, error: boolean): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.pending = [];
    this.inbox = [];
    if (error) this.fire(new Event('error'));
    this.fire(closeEvent(code, reason, !error));
  }

  private fire(ev: Event): void {
    const h = ev.type === 'open' ? this.onopen : ev.type === 'message' ? this.onmessage : ev.type === 'close' ? this.onclose : this.onerror;
    try {
      (h as ((e: Event) => void) | null)?.call(this, ev);
    } finally {
      this.dispatchEvent(ev);
    }
  }
}

export class ConsoleTransport {
  readonly url: string;
  state: 'connecting' | 'connected' | 'closed' = 'connecting';
  status: ConsoleStatus | null = null;
  latencyMs: number | null = null;
  lastError: ConsoleErrorInfo | null = null;
  closeInfo: TransportCloseInfo | null = null;

  private readonly ws: WebSocket;
  private readonly channels = new Map<number, VirtualSocket>();
  private readonly handlers: { [K in keyof TransportEvents]: Set<Handler<K>> } = {
    open: new Set(),
    connected: new Set(),
    status: new Set(),
    latency: new Set(),
    error: new Set(),
    close: new Set(),
  };
  private readonly pingIntervalMs: number;
  private readonly activityIntervalMs: number;
  private readonly now: () => number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSeq = 0;
  private readonly pingsInFlight = new Map<number, number>();
  private lastActivity = -Infinity;
  private nextChannel = 1;
  private hubReason: HubCloseReason | null = null;
  private byClient = false;

  constructor(url: string, token: string, opts: TransportOptions = {}) {
    this.url = url;
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.activityIntervalMs = opts.activityIntervalMs ?? ACTIVITY_INTERVAL_MS;
    this.now = opts.now ?? (() => performance.now());
    const Impl = opts.WebSocketImpl ?? WebSocket;
    this.channels.set(0, new VirtualSocket(this, 0, url));
    this.ws = new Impl(url, [CONSOLE_SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + token]);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.onSocketOpen();
    this.ws.onmessage = (e: MessageEvent) => this.onSocketMessage(e.data);
    this.ws.onclose = (e: CloseEvent) => this.onSocketClose(e.code, e.reason);
    this.ws.onerror = () => {
      /* followed by close */
    };
  }

  // ---------------------------------------------------------------- public API

  on<K extends keyof TransportEvents>(type: K, fn: Handler<K>): () => void {
    (this.handlers[type] as Set<Handler<K>>).add(fn);
    return () => (this.handlers[type] as Set<Handler<K>>).delete(fn);
  }

  /** The primary connection (PTY, RFB or the SPICE main channel). */
  get primary(): VirtualSocket {
    return this.channels.get(0)!;
  }

  channel(id: number): VirtualSocket | undefined {
    return this.channels.get(id);
  }

  /** Open an extra channel (SPICE sub-channels). It becomes OPEN when the agent answers `opened`. */
  openChannel(): VirtualSocket {
    let id = this.nextChannel;
    while (this.channels.has(id)) id++;
    if (id > 0xffff) throw new RangeError('no free console channel');
    this.nextChannel = id + 1;
    const vs = new VirtualSocket(this, id, this.url);
    this.channels.set(id, vs);
    if (this.state === 'closed') {
      queueMicrotask(() => vs._closed(1006, 'session closed', true));
    } else {
      this.sendControl({ type: 'open', channel: id });
    }
    return vs;
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  sendData(channel: number, data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.ws.readyState !== OPEN) return;
    for (const f of encodeData(channel, data)) this.ws.send(f);
  }

  sendControl(c: OutgoingControl): void {
    if (this.ws.readyState !== OPEN) return;
    this.ws.send(encodeControl(c));
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sendControl({ type: 'resize', cols: Math.round(cols), rows: Math.round(rows) });
  }

  /** Report real user input (key, mouse). Sends `activity` at most once per interval. */
  activity(): void {
    if (this.state !== 'connected') return;
    const t = this.now();
    if (t - this.lastActivity < this.activityIntervalMs) return;
    this.lastActivity = t;
    this.sendControl({ type: 'activity' });
  }

  /** @internal Called by VirtualSocket.close(). */
  closeChannel(channel: number, code?: number, reason?: string): void {
    if (channel === 0) {
      this.close(code, reason);
      return;
    }
    const vs = this.channels.get(channel);
    if (!vs) return;
    this.sendControl({ type: 'close', channel });
    this.channels.delete(channel);
    vs.readyState = CLOSING;
    queueMicrotask(() => vs._closed(code ?? 1000, reason ?? '', false));
  }

  /** End the session from the UI (switching guests, leaving the console). */
  close(code = 1000, reason = ''): void {
    if (this.state === 'closed' && this.byClient) return;
    this.byClient = true;
    this.stopPings();
    if (this.ws.readyState === CONNECTING || this.ws.readyState === OPEN) {
      try {
        this.ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason);
      } catch {
        /* ignore */
      }
    }
    this.finish(1000, reason);
  }

  // ---------------------------------------------------------------- socket events

  private emit<K extends keyof TransportEvents>(type: K, ...args: Parameters<Handler<K>>): void {
    for (const fn of [...this.handlers[type]] as ((...a: Parameters<Handler<K>>) => void)[]) fn(...args);
  }

  private onSocketOpen(): void {
    if (this.byClient) return;
    this.emit('open');
    this.ping();
    this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
  }

  private markConnected(): void {
    if (this.state !== 'connecting') return;
    this.state = 'connected';
    this.primary._open();
    this.emit('connected');
  }

  private onSocketMessage(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return; // text messages are not part of the protocol
    const f = decodeFrame(data);
    if (!f) return;
    if (f.kind === FRAME_DATA) {
      if (f.channel === 0) this.markConnected();
      // A standalone ArrayBuffer of the payload (the clients keep references).
      this.channels.get(f.channel)?._message(data.slice(3));
      return;
    }
    if (f.kind !== FRAME_CONTROL) return;
    const c = parseControl(f.payload);
    if (c) this.onControl(c);
  }

  private onControl(c: IncomingControl): void {
    switch (c.type) {
      case 'status': {
        this.status = { state: c.state ?? 'connected', protocol: c.protocol ?? null, resolution: c.resolution ?? null };
        if (this.status.state === 'connected') this.markConnected();
        this.emit('status', this.status);
        break;
      }
      case 'opened': {
        const ch = c.channel ?? 0;
        if (ch === 0) this.markConnected();
        else this.channels.get(ch)?._open();
        break;
      }
      case 'closed': {
        if (c.reason) {
          // The hub ends the session; the socket closes next.
          this.hubReason = c.reason;
          break;
        }
        const ch = c.channel ?? 0;
        if (ch === 0) {
          // The agent closed the primary stream (shell exited, guest console gone).
          this.hubReason = this.hubReason ?? 'ended';
          break;
        }
        const vs = this.channels.get(ch);
        if (vs) {
          this.channels.delete(ch);
          vs._closed(1000, 'closed by the agent', vs.readyState === CONNECTING);
        }
        break;
      }
      case 'pong': {
        const sent = c.id !== undefined ? this.pingsInFlight.get(c.id) : undefined;
        if (sent === undefined || c.id === undefined) break;
        // Drop this and older pings (their pongs are lost or late).
        for (const id of this.pingsInFlight.keys()) if (id <= c.id) this.pingsInFlight.delete(id);
        this.latencyMs = Math.max(0, Math.round(this.now() - sent));
        this.emit('latency', this.latencyMs);
        break;
      }
      case 'error': {
        this.lastError = { code: c.code ?? 'error', message: c.message ?? '' };
        this.emit('error', this.lastError);
        break;
      }
    }
  }

  private onSocketClose(code: number, reason: string): void {
    this.stopPings();
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    if (this.state === 'closed') return;
    const wasConnected = this.state === 'connected';
    this.state = 'closed';
    this.stopPings();
    this.closeInfo = { reason: this.hubReason, error: this.lastError, code, byClient: this.byClient, wasConnected };
    const abnormal = !this.byClient && (code !== 1000 || !this.hubReason);
    for (const [, vs] of this.channels) vs._closed(code, reason || this.hubReason || '', abnormal);
    this.channels.clear();
    this.emit('close', this.closeInfo);
  }

  private ping(): void {
    if (this.ws.readyState !== OPEN) return;
    const id = ++this.pingSeq;
    this.pingsInFlight.set(id, this.now());
    // Bound the map if pongs never come.
    if (this.pingsInFlight.size > 32) this.pingsInFlight.delete(this.pingsInFlight.keys().next().value!);
    this.sendControl({ type: 'ping', id });
  }

  private stopPings(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
