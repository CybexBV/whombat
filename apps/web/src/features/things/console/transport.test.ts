import { decodeFrame, encodeControl, FRAME_CONTROL } from '@whombat/client/hosts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleTransport } from './transport';

/** A WebSocket that records what the transport sends. */
class FakeSocket {
  static last: FakeSocket | null = null;
  binaryType = 'arraybuffer';
  readyState = 0;
  bufferedAmount = 0;
  error = null;
  sent: ArrayBuffer[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(data: ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: encodeControl({ type: 'status', state: 'connected' } as never) });
  }
  controls(type: string): number {
    return this.sent
      .map((b) => decodeFrame(b))
      .filter((f) => f?.kind === FRAME_CONTROL)
      .map((f) => JSON.parse(new TextDecoder().decode(f?.payload)) as { type: string })
      .filter((c) => c.type === type).length;
  }
}

describe('the console transport’s idle bookkeeping (AP-1481)', () => {
  let t = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    t = 1_000;
  });
  afterEach(() => vi.useRealTimers());

  function connect() {
    const tr = new ConsoleTransport('ws://box/console', [], {
      WebSocketImpl: FakeSocket as never,
      now: () => t,
      pingIntervalMs: 1e9,
      activityIntervalMs: 30_000,
    });
    const ws = FakeSocket.last as FakeSocket;
    ws.open();
    expect(tr.state).toBe('connected');
    return { tr, ws };
  }

  it('counts the idle time from the socket’s open', () => {
    const { tr } = connect();
    t += 840_000;
    expect(tr.idleLeftMs(900)).toBe(60_000);
  });

  it('sends activity at most every 30 s, and the last input of a burst when they are up', () => {
    const { tr, ws } = connect();
    tr.activity();
    expect(ws.controls('activity')).toBe(1);
    t += 10_000;
    tr.activity();
    t += 5_000;
    tr.activity();
    expect(ws.controls('activity')).toBe(1);
    // The trailing one goes when the 30 s since the first are up (20 s after the second input).
    vi.advanceTimersByTime(19_000);
    expect(ws.controls('activity')).toBe(1);
    t = 31_000;
    vi.advanceTimersByTime(1_000);
    expect(ws.controls('activity')).toBe(2);
    expect(tr.idleLeftMs(900)).toBe(900_000);
  });

  it('“Stay connected” tells the service at once and resets the clock', () => {
    const { tr, ws } = connect();
    tr.activity();
    t += 5_000;
    tr.stayConnected();
    expect(ws.controls('activity')).toBe(2);
    t += 100_000;
    expect(tr.idleLeftMs(900)).toBe(800_000);
    // No trailing activity was left waiting.
    vi.advanceTimersByTime(60_000);
    expect(ws.controls('activity')).toBe(2);
  });

  it('knows nothing once closed', () => {
    const { tr } = connect();
    tr.close();
    expect(tr.idleLeftMs(900)).toBeNull();
  });
});
