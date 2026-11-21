/**
 * A console through the session (contracts 0.80.1, CT-350; Whombat docs/decisions/one-whombat-consoles.md): the hosts
 * service's console for a server's shell or a guest's screen, carried by the appliance session's `console` stream for a
 * client that reaches its Whombat only through the relay. `ApplianceSession.openConsole` gives a **WebSocket-shaped**
 * object (`readyState`, `binaryType`, `bufferedAmount`, `send`, `close`, `onopen`/`onmessage`/`onclose`/`onerror` and
 * `addEventListener`), so a console written for the box's console WebSocket (the web's `ConsoleTransport`, noVNC through
 * it) runs on either transport unchanged. One `send` is one console message (`kind | channel | payload`), one `message`
 * event one message from the service, its `data` an `ArrayBuffer`.
 *
 * Plain objects for events (no `MessageEvent` or `CloseEvent`), so it runs in browsers, Node and Hermes alike. Close
 * codes follow the WebSocket's: 1000 when either side ended it (the hub's reason arrives first as its `closed` control),
 * 1006 when the connection dropped, 1011 when the console broke, 4003 when the appliance refused it (`error` says why in
 * its words), 1013 when the server monitoring isn't answering.
 */

export const CONSOLE_SOCKET_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;

/** What `openConsole` opens: `hosts.createConsole`'s session id and single-use token, in that burrow. */
export interface ConsoleTarget {
  burrow: string;
  sessionId: string;
  token: string;
}

export interface ConsoleSocketOpenEvent {
  type: 'open';
}
export interface ConsoleSocketMessageEvent {
  type: 'message';
  data: ArrayBuffer;
}
export interface ConsoleSocketCloseEvent {
  type: 'close';
  code: number;
  reason: string;
  wasClean: boolean;
}
export interface ConsoleSocketErrorEvent {
  type: 'error';
}
type EventOf = {
  open: ConsoleSocketOpenEvent;
  message: ConsoleSocketMessageEvent;
  close: ConsoleSocketCloseEvent;
  error: ConsoleSocketErrorEvent;
};
type EventName = keyof EventOf;

/** Why the appliance refused or ended a console, in its words (`error.details.code` / the reset's name). */
export interface ConsoleSocketError {
  code: string;
  message: string;
}

/** What the session gives the socket to send with (the stream underneath). */
export interface ConsolePort {
  /** One console message; false when it can't go (too large, not open). */
  send(message: Uint8Array): boolean;
  /** Bytes waiting for the appliance's credit. */
  buffered(): number;
  /** The person left: the stream is reset and the service's console closes. */
  close(): void;
}

/** Close codes (`CloseEvent.code`) a console socket ends with. */
export const CONSOLE_CLOSE = {
  normal: 1000,
  protocol: 1002,
  lost: 1006,
  policy: 1008,
  tooBig: 1009,
  broken: 1011,
  tryAgain: 1013,
  refused: 4003,
  notFound: 4004,
} as const;

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : (bytes.slice().buffer as ArrayBuffer);
}

/** A console's WebSocket look-alike over the session (see the module comment). */
export class ConsoleSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState: number = CONSOLE_SOCKET_STATE.CONNECTING;
  /** Always `arraybuffer` (messages are delivered as `ArrayBuffer`s whatever is set). */
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  /** The console's protocol once open (`shell`, `vnc`, …). */
  protocol = '';
  readonly extensions = '';
  /** Why the appliance refused or ended it, when it did. */
  error: ConsoleSocketError | null = null;

  onopen: ((event: ConsoleSocketOpenEvent) => void) | null = null;
  onmessage: ((event: ConsoleSocketMessageEvent) => void) | null = null;
  onclose: ((event: ConsoleSocketCloseEvent) => void) | null = null;
  onerror: ((event: ConsoleSocketErrorEvent) => void) | null = null;

  readonly #listeners: { [K in EventName]: Set<(event: EventOf[K]) => void> } = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };
  #port: ConsolePort | null = null;

  constructor(readonly url: string) {}

  get bufferedAmount(): number {
    return this.#port?.buffered() ?? 0;
  }

  addEventListener<K extends EventName>(type: K, listener: (event: EventOf[K]) => void): void {
    this.#listeners[type]?.add(listener);
  }

  removeEventListener<K extends EventName>(type: K, listener: (event: EventOf[K]) => void): void {
    this.#listeners[type]?.delete(listener);
  }

  /** One console message. Before the console opened it throws, as a WebSocket does; after it closed it is dropped. */
  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.readyState === CONSOLE_SOCKET_STATE.CONNECTING)
      throw Object.assign(new Error('The console isn’t open yet.'), { name: 'InvalidStateError' });
    if (this.readyState !== CONSOLE_SOCKET_STATE.OPEN) return;
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!this.#port?.send(bytes)) this._fail(CONSOLE_CLOSE.tooBig, 'message too large');
  }

  /** Leaves the console (the service's console closes too). */
  close(code: number = CONSOLE_CLOSE.normal, reason = ''): void {
    if (this.readyState === CONSOLE_SOCKET_STATE.CLOSING || this.readyState === CONSOLE_SOCKET_STATE.CLOSED)
      return;
    this.readyState = CONSOLE_SOCKET_STATE.CLOSING;
    this.#port?.close();
    queueMicrotask(() => this.#finish({ type: 'close', code, reason, wasClean: true }));
  }

  /* Driven by the session ---------------------------------------------------------------------------- */

  /** @internal The stream to send on. */
  _bind(port: ConsolePort): void {
    this.#port = port;
  }

  /** @internal The appliance said `opened`: the service's console is connected. */
  _open(protocol: string): void {
    if (this.readyState !== CONSOLE_SOCKET_STATE.CONNECTING) return;
    this.protocol = protocol;
    this.readyState = CONSOLE_SOCKET_STATE.OPEN;
    this.#emit('open', { type: 'open' });
  }

  /** @internal One message from the service. */
  _message(message: Uint8Array): void {
    if (this.readyState !== CONSOLE_SOCKET_STATE.OPEN) return;
    this.#emit('message', { type: 'message', data: bufferOf(message) });
  }

  /** @internal The appliance ended its half (END): the console is over. */
  _end(): void {
    this.#finish({ type: 'close', code: CONSOLE_CLOSE.normal, reason: '', wasClean: true });
  }

  /** @internal Refused, reset or lost: `error` then `close`. */
  _fail(code: number, reason: string, error?: ConsoleSocketError): void {
    if (this.readyState === CONSOLE_SOCKET_STATE.CLOSED) return;
    if (error) this.error = error;
    if (this.readyState !== CONSOLE_SOCKET_STATE.CLOSING) {
      this.#port?.close();
      this.#emit('error', { type: 'error' });
    }
    this.#finish({ type: 'close', code, reason: reason.slice(0, 123), wasClean: false });
  }

  #finish(event: ConsoleSocketCloseEvent): void {
    if (this.readyState === CONSOLE_SOCKET_STATE.CLOSED) return;
    this.readyState = CONSOLE_SOCKET_STATE.CLOSED;
    this.#emit('close', event);
  }

  #emit<K extends EventName>(type: K, event: EventOf[K]): void {
    const handler = this[`on${type}`] as ((e: EventOf[K]) => void) | null;
    try {
      handler?.call(this, event);
    } finally {
      for (const l of [...this.#listeners[type]]) l(event);
    }
  }
}

/** A stream reset's name → the close code a console socket ends with. */
export function consoleCloseCodeOf(reset: string): number {
  switch (reset) {
    case 'forbidden':
    case 'refused':
      return CONSOLE_CLOSE.refused;
    case 'notFound':
      return CONSOLE_CLOSE.notFound;
    case 'protocolError':
      return CONSOLE_CLOSE.protocol;
    case 'tooLarge':
      return CONSOLE_CLOSE.tooBig;
    case 'flowControl':
      return CONSOLE_CLOSE.policy;
    case 'cancelled':
      return CONSOLE_CLOSE.normal;
    default:
      return CONSOLE_CLOSE.broken;
  }
}

/** A refused `console` stream's code (`details.code`, else the error's) → its close code. */
export function consoleRefusalCodeOf(code: string): number {
  return code === 'hosts_unavailable' || code === 'unavailable'
    ? CONSOLE_CLOSE.tryAgain
    : CONSOLE_CLOSE.refused;
}
