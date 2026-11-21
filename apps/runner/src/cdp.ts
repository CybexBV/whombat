/**
 * The runner's own CDP client (hermes-engine.md HE-S142): Whombat's `browser_preview` drives the agent's Chromium (beside
 * its commands, one-person.md OP-S113) through the turn's relay socket, as Hermes does through the sandbox's bridge. A WebSocket over the unix socket
 * (RFC 6455: the client masks, the server doesn't), commands answered by id, events to listeners, flat sessions.
 *
 * It opens over a way in of its own too (`() => Socket`, each call a fresh connection to Chromium's DevTools port): the
 * browser's own work on Chromium as it starts (the kept sites' cookies) can't go through the relay, which waits for it.
 */
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { FrameBuffer } from './frame-buffer';

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** Where the client reaches DevTools: the relay's unix socket, or a way in that makes a fresh connection per call. */
export type CdpTarget = string | (() => Socket);

const connectionOf = (target: CdpTarget): (() => Socket) =>
  typeof target === 'string' ? () => connect(target) : target;

/** `GET /json/version` over the relay (or a way in): the browser's WebSocket path. */
export function browserPath(target: CdpTarget, timeoutMs = 60_000): Promise<string> {
  const connection = connectionOf(target);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        createConnection: () => connection(),
        path: '/json/version',
        headers: { host: '127.0.0.1' },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => {
          if (res.statusCode !== 200)
            return reject(new Error(body.trim().slice(0, 300) || `${res.statusCode}`));
          try {
            const url = (JSON.parse(body) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? '';
            const path = /^wss?:\/\/[^/]+(\/devtools\/browser\/[\w.-]+)$/.exec(url)?.[1];
            if (!path) throw new Error('no browser address');
            resolve(path);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('the browser didn’t answer')));
    req.on('error', reject);
    req.end();
  });
}

/** A client frame: FIN, the opcode, masked. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (n < 126) head[1] = 0x80 | n;
  else if (n < 65536) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  const mask = randomBytes(4);
  const body = Buffer.alloc(n);
  for (let i = 0; i < n; i++) body[i] = (payload[i] as number) ^ (mask[i % 4] as number);
  return Buffer.concat([head, mask, body]);
}

export class CdpClient {
  readonly #socket: Socket;
  readonly #buf = new FrameBuffer();
  #fragments: Buffer[] = [];
  #next = 0;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #listeners = new Set<(e: CdpEvent) => void>();
  #closed: Error | null = null;

  private constructor(socket: Socket) {
    this.#socket = socket;
  }

  /**
   * Opens the browser's WebSocket over the relay socket (Chromium starts for it if it must), or over a way in straight
   * to Chromium (two connections: `/json/version`, then the WebSocket).
   */
  static async open(target: CdpTarget, timeoutMs = 60_000): Promise<CdpClient> {
    const path = await browserPath(target, timeoutMs);
    const socket = connectionOf(target)();
    const client = new CdpClient(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('the browser didn’t answer')), timeoutMs);
      let head = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', onData);
        clearTimeout(timer);
        if (!/^HTTP\/1\.1 101 /.test(head.toString('latin1'))) return fail(new Error('the browser refused'));
        socket.on('data', (c: Buffer) => client.#push(c));
        client.#push(head.subarray(end + 4));
        resolve();
      };
      function fail(err: Error) {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      }
      socket.on('data', onData);
      socket.once('error', fail);
      socket.once('close', () => fail(new Error('the browser connection closed')));
      // Written now: it waits for the connection, after anything the way in wrote first.
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on('close', () => client.#end(new Error('the browser connection closed')));
    socket.on('error', (err) => client.#end(err));
    return client;
  }

  /** One command; its result, or its error as an Error. */
  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#socket.write(
        clientFrame(
          0x1,
          Buffer.from(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })),
        ),
      );
    });
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#end(new Error('closed'));
    this.#socket.destroy();
  }

  #end(err: Error): void {
    if (this.#closed) return;
    this.#closed = err;
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }

  #push(chunk: Buffer): void {
    this.#buf.append(chunk);
    for (;;) {
      const b = this.#buf.bytes;
      if (b.length < 2) return;
      const fin = ((b[0] as number) & 0x80) !== 0;
      const opcode = (b[0] as number) & 0x0f;
      let len = (b[1] as number) & 0x7f;
      let at = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        at = 10;
      }
      if (b.length < at + len) return;
      const payload = b.subarray(at, at + len);
      this.#buf.consume(at + len);
      if (opcode === 0x9) this.#socket.write(clientFrame(0xa, Buffer.from(payload)));
      else if (opcode === 0x8) this.close();
      else if (opcode === 0x1 || opcode === 0x0) {
        this.#fragments.push(Buffer.from(payload));
        if (fin) {
          const text = Buffer.concat(this.#fragments).toString('utf8');
          this.#fragments = [];
          this.#message(text);
        }
      }
    }
  }

  #message(text: string): void {
    let m: { id?: number; result?: unknown; error?: { message?: string }; method?: string };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof m.id === 'number') {
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message ?? 'CDP error'));
      else p.resolve(m.result ?? {});
    } else if (typeof m.method === 'string') for (const l of this.#listeners) l(m as CdpEvent);
  }
}
