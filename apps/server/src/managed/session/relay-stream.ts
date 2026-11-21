/**
 * A relay data connection after `ready` as a Node `Duplex` of raw bytes (docs/decisions/own-address.md): a door stream
 * carries a browser's or a certificate authority's TLS connection, byte for byte, in binary messages of at most
 * `RELAY_MAX_MESSAGE_BYTES` each way. The own-address server takes it as a socket (`server.emit('connection', …)`) and the
 * ACME socket pipe as a stream. WebSocket has no half-close: the end of writing closes the data connection (the relay
 * then closes the TCP connection), and the relay's close ends reading.
 */
import { Duplex } from 'node:stream';
import WebSocket from 'ws';

/** The relay's largest binary message (relay protocol v1). */
export const RELAY_MAX_MESSAGE_BYTES = 262_144;
/** Writing waits for the socket only while more than this is queued in it. */
const HIGH_WATER_BYTES = 1 << 20;

export class RelayDuplex extends Duplex {
  /** The visitor's address as the door saw it (`incoming.src`): fair sharing only, never trust. */
  readonly remoteAddress: string;
  readonly remotePort = 0;
  readonly localAddress: string;
  readonly localPort = 443;
  /** Read by the TLS layer and the HTTP servers: a door stream is never Nagle-delayed (there is no TCP here). */
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  setTimeout(ms: number, callback?: () => void): this {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (callback) this.once('timeout', callback);
    if (ms > 0) {
      const arm = () => {
        if (this.idle) clearTimeout(this.idle);
        this.idle = setTimeout(() => this.emit('timeout'), ms);
        this.idle.unref?.();
      };
      this.timeoutMs = ms;
      arm();
    } else this.timeoutMs = 0;
    return this;
  }
  private idle: NodeJS.Timeout | null = null;
  private timeoutMs = 0;

  constructor(
    private readonly ws: WebSocket,
    where: { remote: string; local: string },
  ) {
    super({ allowHalfOpen: false });
    this.remoteAddress = where.remote;
    this.localAddress = where.local;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        ws.close(4400, 'text after ready');
        return;
      }
      this.touch();
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (!this.push(chunk)) ws.pause();
    });
    // What was read still drains; with `allowHalfOpen` off, the end of reading ends writing too.
    ws.on('close', () => this.push(null));
    ws.on('error', (err) => this.destroy(err));
  }

  private touch(): void {
    if (this.timeoutMs > 0 && this.idle) this.idle.refresh();
  }

  override _read(): void {
    this.ws.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      callback(new Error('the relay data connection is closed'));
      return;
    }
    this.touch();
    for (let i = 0; i < chunk.length; i += RELAY_MAX_MESSAGE_BYTES) {
      const part = chunk.subarray(i, i + RELAY_MAX_MESSAGE_BYTES);
      const last = i + RELAY_MAX_MESSAGE_BYTES >= chunk.length;
      if (last && this.ws.bufferedAmount + part.length > HIGH_WATER_BYTES) {
        this.ws.send(part, { binary: true }, (err) => callback(err ?? null));
        return;
      }
      this.ws.send(part, { binary: true });
    }
    callback();
  }

  override _final(callback: (err?: Error | null) => void): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
    callback();
  }

  override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      this.ws.terminate();
    callback(err);
  }
}
