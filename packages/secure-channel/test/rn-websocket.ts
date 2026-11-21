import { WebSocket } from 'ws';

/**
 * A faithful stand-in for React Native 0.86's `WebSocket` on Android, driving a real `ws` socket:
 *
 * - `bufferedAmount` is declared but never assigned (reads `undefined`), and there is no `pause`/`resume`
 *   (`Libraries/WebSocket/WebSocket.js`).
 * - `send(ArrayBufferView)` base64-encodes the bytes and hands them to the native module
 *   (`NativeWebSocketModule.sendBinary(base64, id)`), which queues them in OkHttp's `RealWebSocket`. OkHttp
 *   refuses a message that would take its queue above 16 MiB (`MAX_QUEUE_SIZE`) and closes the socket with
 *   1001 instead; React Native ignores the refusal and later reports the close.
 * - Received binary messages arrive as base64 from native and are decoded to an `ArrayBuffer`
 *   (`binaryType = 'arraybuffer'`); `readyState` is set to CLOSED before the `close` event is dispatched.
 *
 * The "native queue" here drains into the real socket only while the kernel accepts data (the `ws` send
 * callback), so it grows exactly when TCP backpressure from the relay/appliance holds the sender back.
 */
export class RnLikeWebSocket extends EventTarget {
  static readonly OKHTTP_MAX_QUEUE = 16 * 1024 * 1024;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  // biome-ignore lint/suspicious/noExplicitAny: declared-but-unassigned like React Native
  bufferedAmount: any = undefined;
  readyState = 0;
  private binaryTypeValue: 'blob' | 'arraybuffer' | undefined;
  private readonly ws: WebSocket;
  private readonly native: Buffer[] = [];
  private nativeBytes = 0;
  private inFlight = 0;
  /** OkHttp refused a message (queue over 16 MiB) and started closing with 1001. */
  refused = false;
  /** Largest native queue observed (bytes of binary payload). */
  maxNativeQueue = 0;

  constructor(url: string) {
    super();
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      this.readyState = this.OPEN;
      this.dispatchEvent(new Event('open'));
    });
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        this.dispatchEvent(Object.assign(new Event('message'), { data: data.toString('utf8') }));
        return;
      }
      // Native -> JS bridge: base64 string, decoded with base64-js into a fresh ArrayBuffer.
      const decoded = new Uint8Array(Buffer.from(data.toString('base64'), 'base64'));
      this.dispatchEvent(Object.assign(new Event('message'), { data: decoded.buffer }));
    });
    this.ws.on('close', (code: number, reason: Buffer) => {
      this.readyState = this.CLOSED;
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason: reason.toString() }));
    });
    this.ws.on('error', () => {
      this.dispatchEvent(new Event('error'));
    });
  }

  get binaryType(): 'blob' | 'arraybuffer' | undefined {
    return this.binaryTypeValue;
  }

  set binaryType(value: 'blob' | 'arraybuffer') {
    if (value !== 'blob' && value !== 'arraybuffer')
      throw new Error("binaryType must be either 'blob' or 'arraybuffer'");
    this.binaryTypeValue = value;
  }

  static async open(url: string): Promise<RnLikeWebSocket> {
    const s = new RnLikeWebSocket(url);
    await new Promise<void>((resolve, reject) => {
      s.addEventListener('open', () => resolve(), { once: true });
      s.addEventListener('error', () => reject(new Error('connect failed')), { once: true });
    });
    return s;
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (this.readyState === this.CONNECTING) throw new Error('INVALID_STATE_ERR');
    if (typeof data === 'string') throw new Error('text not used by the channel');
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    // JS -> native: base64 (binaryToBase64), decoded again on the native side.
    const bytes = Buffer.from(Buffer.from(view).toString('base64'), 'base64');
    if (this.refused) return;
    if (this.nativeBytes + this.inFlight + bytes.length > RnLikeWebSocket.OKHTTP_MAX_QUEUE) {
      // OkHttp RealWebSocket.send(): queue full -> close(1001) and return false (ignored by React Native).
      this.refused = true;
      this.ws.close(1001);
      return;
    }
    this.native.push(bytes);
    this.nativeBytes += bytes.length;
    this.maxNativeQueue = Math.max(this.maxNativeQueue, this.nativeBytes + this.inFlight);
    this.pump();
  }

  /** OkHttp's writer thread: one frame at a time, next one when the socket accepted the previous. */
  private pump(): void {
    if (this.inFlight > 0 || this.ws.readyState !== WebSocket.OPEN) return;
    const next = this.native.shift();
    if (!next) return;
    this.nativeBytes -= next.length;
    this.inFlight = next.length;
    this.ws.send(next, { binary: true }, () => {
      this.inFlight = 0;
      // The kernel buffer is full while ws holds data: wait for it to flush before writing more.
      if (this.ws.bufferedAmount > 64 * 1024) setTimeout(() => this.pump(), 1);
      else this.pump();
    });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSING;
    // OkHttp sends the close frame after the queued messages.
    const finish = (): void => {
      if (this.native.length > 0 || this.inFlight > 0) setTimeout(finish, 1);
      else this.ws.close(code ?? 1000, reason);
    };
    finish();
  }
}
