import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFrame, encodeControl, encodeData, encodeFrame, FRAME_CONTROL, FRAME_DATA, MAX_FRAME_PAYLOAD, parseControl } from './frames';
import { ConsoleTransport, type TransportCloseInfo, VirtualSocket } from './transport';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Minimal in-memory WebSocket for driving the transport. */
class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  binaryType = 'blob';
  bufferedAmount = 0;
  sent: ArrayBuffer[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.last = this;
  }
  send(d: ArrayBuffer) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  receive(buf: ArrayBuffer) {
    this.onmessage?.(new MessageEvent('message', { data: buf }));
  }
  control(obj: object) {
    this.receive(encodeFrame(FRAME_CONTROL, 0, enc.encode(JSON.stringify(obj))));
  }
  data(channel: number, text: string) {
    this.receive(encodeFrame(FRAME_DATA, channel, enc.encode(text)));
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code, reason: '', wasClean: false }));
  }
  controls(): Record<string, unknown>[] {
    return this.sent
      .map((b) => decodeFrame(b)!)
      .filter((f) => f.kind === FRAME_CONTROL)
      .map((f) => JSON.parse(dec.decode(f.payload)) as Record<string, unknown>);
  }
  dataFrames(): { channel: number; text: string }[] {
    return this.sent
      .map((b) => decodeFrame(b)!)
      .filter((f) => f.kind === FRAME_DATA)
      .map((f) => ({ channel: f.channel, text: dec.decode(f.payload) }));
  }
}

const Impl = FakeSocket as unknown as new (url: string, protocols?: string | string[]) => WebSocket;

function make(now = { t: 0 }) {
  const tr = new ConsoleTransport('ws://hub.test/api/v1/console/cs_1', 'tok123', { WebSocketImpl: Impl, now: () => now.t });
  return { tr, ws: FakeSocket.last!, now };
}

describe('frames', () => {
  it('encodes kind | uint16 BE channel | payload', () => {
    const b = new Uint8Array(encodeFrame(FRAME_DATA, 0x1234, new Uint8Array([7, 8, 9])));
    expect([...b]).toEqual([0, 0x12, 0x34, 7, 8, 9]);
    const f = decodeFrame(b.buffer)!;
    expect(f.kind).toBe(0);
    expect(f.channel).toBe(0x1234);
    expect([...f.payload]).toEqual([7, 8, 9]);
  });

  it('handles the channel range and empty payloads', () => {
    expect([...new Uint8Array(encodeFrame(FRAME_CONTROL, 0xffff))]).toEqual([1, 0xff, 0xff]);
    expect(() => encodeFrame(FRAME_DATA, 0x10000)).toThrow(RangeError);
    expect(() => encodeFrame(FRAME_DATA, -1)).toThrow(RangeError);
    expect(decodeFrame(new Uint8Array([0, 1]).buffer)).toBeNull();
    expect(decodeFrame(new Uint8Array([0, 0, 5]).buffer)!.payload.byteLength).toBe(0);
  });

  it('encodes a view without copying its neighbours', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array(encodeFrame(FRAME_DATA, 2, backing.subarray(1, 3)));
    expect([...b]).toEqual([0, 0, 2, 2, 3]);
  });

  it('splits data larger than the frame limit', () => {
    const frames = encodeData(3, new Uint8Array(MAX_FRAME_PAYLOAD * 2 + 10));
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.byteLength - 3)).toEqual([MAX_FRAME_PAYLOAD, MAX_FRAME_PAYLOAD, 10]);
    expect(frames.every((f) => decodeFrame(f)!.channel === 3)).toBe(true);
    expect(dec.decode(decodeFrame(encodeData(0, 'héllo')[0]!)!.payload)).toBe('héllo');
  });

  it('serializes controls as JSON on channel 0', () => {
    const f = decodeFrame(encodeControl({ type: 'resize', cols: 80, rows: 24 }))!;
    expect(f.kind).toBe(FRAME_CONTROL);
    expect(f.channel).toBe(0);
    expect(JSON.parse(dec.decode(f.payload))).toEqual({ type: 'resize', cols: 80, rows: 24 });
  });

  it('parses known controls and rejects junk', () => {
    const p = (o: unknown) => parseControl(enc.encode(typeof o === 'string' ? o : JSON.stringify(o)));
    expect(p({ type: 'status', state: 'connected', protocol: 'vnc', resolution: '1024x768' })).toEqual({
      type: 'status',
      state: 'connected',
      protocol: 'vnc',
      resolution: '1024x768',
    });
    expect(p({ type: 'opened', channel: 3 })).toEqual({ type: 'opened', channel: 3 });
    expect(p({ type: 'closed', reason: 'idle_timeout' })).toEqual({ type: 'closed', channel: undefined, reason: 'idle_timeout' });
    expect(p({ type: 'pong', id: 7 })).toEqual({ type: 'pong', id: 7 });
    expect(p({ type: 'error', code: 'open_failed', message: 'no serial device' })).toEqual({ type: 'error', code: 'open_failed', message: 'no serial device' });
    expect(p({ type: 'resize', cols: 1, rows: 1 })).toBeNull();
    expect(p('not json')).toBeNull();
    expect(p([1, 2])).toBeNull();
    expect(p({ type: 'opened', channel: '3' })).toEqual({ type: 'opened', channel: undefined });
  });
});

describe('ConsoleTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the socket with the console and token subprotocols', () => {
    const { ws } = make();
    expect(ws.url).toBe('ws://hub.test/api/v1/console/cs_1');
    expect(ws.protocols).toEqual(['rackoon.console.v1', 'rackoon.token.tok123']);
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('opens channel 0 on status and relays data both ways', () => {
    const { tr, ws } = make();
    const ch0 = tr.primary;
    const events: string[] = [];
    ch0.onopen = () => events.push('open');
    ch0.addEventListener('message', (e) => events.push(`msg:${dec.decode((e as MessageEvent<ArrayBuffer>).data)}`));
    let status = '';
    tr.on('status', (s) => (status = `${s.state}/${s.protocol}/${s.resolution}`));
    ws.open();
    expect(ch0.readyState).toBe(VirtualSocket.CONNECTING);
    ch0.send('early'); // queued until connected
    expect(ws.dataFrames()).toEqual([]);
    ws.control({ type: 'status', state: 'connected', protocol: 'shell', resolution: '132x36' });
    expect(status).toBe('connected/shell/132x36');
    expect(tr.state).toBe('connected');
    expect(ch0.readyState).toBe(VirtualSocket.OPEN);
    expect(ws.dataFrames()).toEqual([{ channel: 0, text: 'early' }]);
    ws.data(0, 'hello');
    ws.data(5, 'ignored: unknown channel');
    expect(events).toEqual(['open', 'msg:hello']);
    ch0.send(enc.encode('ls\r'));
    expect(ws.dataFrames().at(-1)).toEqual({ channel: 0, text: 'ls\r' });
  });

  it('treats the first data on channel 0 as connected (RFB servers speak first)', () => {
    const { tr, ws } = make();
    ws.open();
    let got = '';
    tr.primary.onmessage = (e) => (got = dec.decode(e.data as ArrayBuffer));
    ws.data(0, 'RFB 003.008\n');
    expect(tr.state).toBe('connected');
    expect(got).toBe('RFB 003.008\n');
  });

  it('holds data that arrives before a client listens and delivers it in order', async () => {
    const { tr, ws } = make();
    ws.open();
    ws.control({ type: 'status', state: 'connected' });
    ws.data(0, 'banner ');
    ws.data(0, 'login: ');
    const got: string[] = [];
    tr.primary.onmessage = (e) => got.push(dec.decode(e.data as ArrayBuffer));
    ws.data(0, 'late'); // arrives while the held data is still queued
    expect(got).toEqual([]);
    await Promise.resolve();
    expect(got).toEqual(['banner ', 'login: ', 'late']);
    ws.data(0, '!');
    expect(got.at(-1)).toBe('!');
  });

  it('delivers standalone ArrayBuffers to the clients', () => {
    const { tr, ws } = make();
    ws.open();
    ws.control({ type: 'status', state: 'connected' });
    let buf: ArrayBuffer | null = null;
    tr.primary.onmessage = (e) => (buf = e.data as ArrayBuffer);
    ws.data(0, 'abc');
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf!.byteLength).toBe(3);
  });

  it('opens extra channels with open/opened and closes them with close', async () => {
    const { tr, ws } = make();
    ws.open();
    ws.control({ type: 'status', state: 'connected', protocol: 'spice' });
    const a = tr.openChannel();
    const b = tr.openChannel();
    expect([a.channel, b.channel]).toEqual([1, 2]);
    expect(ws.controls().filter((c) => c.type === 'open')).toEqual([
      { type: 'open', channel: 1 },
      { type: 'open', channel: 2 },
    ]);
    const opened: number[] = [];
    a.addEventListener('open', () => opened.push(1));
    b.addEventListener('open', () => opened.push(2));
    a.send('link-a'); // before opened: queued
    ws.control({ type: 'opened', channel: 2 });
    ws.control({ type: 'opened', channel: 1 });
    expect(opened).toEqual([2, 1]);
    expect(ws.dataFrames()).toContainEqual({ channel: 1, text: 'link-a' });
    let gotB = '';
    b.onmessage = (e) => (gotB = dec.decode(e.data as ArrayBuffer));
    ws.data(2, 'for b');
    expect(gotB).toBe('for b');

    const closed: number[] = [];
    a.onclose = (e) => closed.push((e as CloseEvent).code);
    a.close();
    expect(ws.controls().at(-1)).toEqual({ type: 'close', channel: 1 });
    await Promise.resolve();
    expect(closed).toEqual([1000]);
    expect(a.readyState).toBe(VirtualSocket.CLOSED);
    // The agent closing a channel fires close (and error when it never opened).
    const c = tr.openChannel();
    expect(c.channel).toBe(3);
    const ev: string[] = [];
    c.onerror = () => ev.push('error');
    c.onclose = () => ev.push('close');
    ws.control({ type: 'closed', channel: 3 });
    expect(ev).toEqual(['error', 'close']);
    expect(tr.state).toBe('connected');
  });

  it('pings every 5 s and measures the round trip', () => {
    const now = { t: 1000 };
    const { tr, ws } = make(now);
    const lat: number[] = [];
    tr.on('latency', (ms) => lat.push(ms));
    ws.open();
    expect(ws.controls()).toEqual([{ type: 'ping', id: 1 }]);
    now.t = 1012;
    ws.control({ type: 'pong', id: 1 });
    expect(lat).toEqual([12]);
    expect(tr.latencyMs).toBe(12);
    now.t = 6000;
    vi.advanceTimersByTime(5000);
    expect(ws.controls().at(-1)).toEqual({ type: 'ping', id: 2 });
    now.t = 6009;
    ws.control({ type: 'pong', id: 99 }); // unknown id: ignored
    ws.control({ type: 'pong', id: 2 });
    expect(lat).toEqual([12, 9]);
  });

  it('throttles activity to one per 30 s and only once connected', () => {
    const now = { t: 0 };
    const { tr, ws } = make(now);
    ws.open();
    tr.activity();
    expect(ws.controls().filter((c) => c.type === 'activity')).toHaveLength(0);
    ws.control({ type: 'status', state: 'connected' });
    tr.activity();
    now.t = 10_000;
    tr.activity();
    now.t = 29_999;
    tr.activity();
    expect(ws.controls().filter((c) => c.type === 'activity')).toHaveLength(1);
    now.t = 30_000;
    tr.activity();
    expect(ws.controls().filter((c) => c.type === 'activity')).toHaveLength(2);
  });

  it('sends resize controls', () => {
    const { tr, ws } = make();
    ws.open();
    tr.resize(120.4, 40);
    tr.resize(0, 10);
    expect(ws.controls().filter((c) => c.type === 'resize')).toEqual([{ type: 'resize', cols: 120, rows: 40 }]);
  });

  it('reports the hub close reason and the last error', () => {
    const { tr, ws } = make();
    let info: TransportCloseInfo | null = null;
    const errors: string[] = [];
    tr.on('close', (i) => (info = i));
    tr.on('error', (e) => errors.push(`${e.code}: ${e.message}`));
    const chClosed: number[] = [];
    tr.primary.onclose = (e) => chClosed.push((e as CloseEvent).code);
    ws.open();
    ws.control({ type: 'status', state: 'connected' });
    ws.control({ type: 'error', code: 'x', message: 'y' });
    ws.control({ type: 'closed', reason: 'idle_timeout' });
    ws.drop(1000);
    expect(errors).toEqual(['x: y']);
    expect(info).toEqual({ reason: 'idle_timeout', error: { code: 'x', message: 'y' }, code: 1000, byClient: false, wasConnected: true });
    expect(chClosed).toEqual([1000]);
    expect(tr.state).toBe('closed');
  });

  it('reports a dropped connection without a reason', () => {
    const { tr, ws } = make();
    let info: TransportCloseInfo | null = null;
    tr.on('close', (i) => (info = i));
    ws.open();
    ws.control({ type: 'status', state: 'connected' });
    ws.drop(1006);
    expect(info).toMatchObject({ reason: null, code: 1006, byClient: false, wasConnected: true });
    // No pings after the close.
    const n = ws.sent.length;
    vi.advanceTimersByTime(20_000);
    expect(ws.sent.length).toBe(n);
  });

  it('marks the agent closing the primary stream as ended', () => {
    const { tr, ws } = make();
    let info: TransportCloseInfo | null = null;
    tr.on('close', (i) => (info = i));
    ws.open();
    ws.control({ type: 'status', state: 'connected' });
    ws.control({ type: 'closed' });
    ws.drop(1000);
    expect(info).toMatchObject({ reason: 'ended' });
  });

  it('close() from the UI closes the socket once and marks byClient', () => {
    const { tr, ws } = make();
    let info: TransportCloseInfo | null = null;
    let n = 0;
    tr.on('close', (i) => {
      info = i;
      n++;
    });
    ws.open();
    tr.close();
    tr.close();
    expect(ws.closedWith).toEqual({ code: 1000, reason: '' });
    expect(n).toBe(1);
    expect(info).toMatchObject({ byClient: true, wasConnected: false });
    // Closing channel 0 closes the session too (noVNC calls close() on disconnect).
    const second = make();
    second.ws.open();
    second.tr.primary.close();
    expect(second.tr.state).toBe('closed');
  });

  it('exposes the properties noVNC checks on a raw channel', () => {
    const { tr } = make();
    const ch = tr.primary;
    const props = [...Object.keys(ch), ...Object.getOwnPropertyNames(Object.getPrototypeOf(ch))];
    for (const p of ['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen', 'protocol', 'readyState']) {
      expect(props, p).toContain(p);
    }
  });
});
