import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ByteStreamLike,
  createManagedConnector,
  type RelaySocket,
  type SecureChannelPort,
  type SecureConnectionLike,
  TicketDeniedError,
  type TicketSource,
} from './connector';
import { ConnectError, encodeFrame, frameReader } from './wire';

/** A scripted relay WebSocket. */
class FakeRelaySocket implements RelaySocket {
  static last: FakeRelaySocket | null = null;
  readyState = 0;
  binaryType = 'blob';
  sent: (string | Uint8Array)[] = [];
  listeners = new Map<string, Set<(e: unknown) => void>>();
  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {
    FakeRelaySocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  addEventListener(type: string, l: (e: unknown) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(l);
  }
  removeEventListener(type: string, l: (e: unknown) => void) {
    this.listeners.get(type)?.delete(l);
  }
  emit(type: string, event: unknown) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(event);
  }
  text(message: unknown) {
    this.emit('message', { data: JSON.stringify(message) });
  }
  closeWith(code: number, reason = '') {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

/** A pass-through "secure channel" that only checks the pin (the real one is @whombat/secure-channel). */
function passthrough(
  remotePeerId: string,
  sentToAppliance: Uint8Array[],
): SecureChannelPort<string> & { deliver(m: Uint8Array): void } {
  let push: ((m: Uint8Array | null) => void) | null = null;
  const inbox: Uint8Array[] = [];
  const plain: ByteStreamLike = {
    read: () =>
      inbox.length
        ? Promise.resolve(inbox.shift() as Uint8Array)
        : new Promise((r) => {
            push = r;
          }),
    write: (chunk) => {
      sentToAppliance.push(chunk);
      return true;
    },
    drained: async () => {},
    close: async () => {},
    abort: () => {},
  };
  return {
    byteStream: () => plain,
    async openInitiator(o) {
      if (o.expectedAppliancePeerId && o.expectedAppliancePeerId !== remotePeerId) {
        const e = new Error('mismatch') as Error & { code: string };
        e.code = 'PEER_MISMATCH';
        throw e;
      }
      const conn: SecureConnectionLike = {
        remotePeerId,
        rekeyRequired: false,
        close: async () => {},
        abort: () => {},
      };
      return conn;
    },
    secureByteStream: () => plain,
    deliver(m) {
      if (push) {
        const p = push;
        push = null;
        p(m);
      } else inbox.push(m);
    },
  };
}

function connector(
  options: {
    tickets?: TicketSource;
    ticketTimeoutMs?: number;
    peer?: string;
    /** The appliance never finishes the Noise handshake. */
    hangHandshake?: boolean;
  } = {},
) {
  const toAppliance: Uint8Array[] = [];
  const secure = passthrough('12D3KooWappliance', toAppliance);
  if (options.hangHandshake) secure.openInitiator = () => new Promise(() => {});
  const c = createManagedConnector({
    tickets:
      options.tickets ??
      (async () => ({ ticket: 'eyJ.ticket.sig', relayUrl: 'wss://relay.test/v1/connect' })),
    secure,
    identity: async () => 'endpoint-key',
    appliance: { peerId: options.peer ?? '12D3KooWappliance' },
    channel: 'app',
    socket: (url, protocol) => new FakeRelaySocket(url, protocol),
    dialTimeoutMs: 500,
    handshakeTimeoutMs: 50,
    ticketTimeoutMs: options.ticketTimeoutMs,
  });
  return { c, toAppliance, secure };
}

async function relayHandshake() {
  await new Promise((r) => setTimeout(r, 0));
  const ws = FakeRelaySocket.last as FakeRelaySocket;
  ws.text({ t: 'welcome', v: 1, conn: 'conn_000001', heartbeatMs: 20000, maxMessage: 262144 });
  ws.text({ t: 'ready' });
  return ws;
}

describe('managed connector (relay protocol v1 + pinned secure channel)', () => {
  it('puts the ticket in the first message, never the URL, then speaks session frames', async () => {
    const { c, toAppliance, secure } = connector();
    const pending = c.connect({ class: 'interactive', signal: new AbortController().signal });
    const ws = await relayHandshake();
    const wire = await pending;
    expect(ws.url).toBe('wss://relay.test/v1/connect');
    expect(ws.url).not.toContain('ticket');
    expect(ws.protocol).toBe('whombat-relay.v1');
    expect(JSON.parse(ws.sent[0] as string)).toEqual({
      t: 'hello',
      v: 1,
      ticket: 'eyJ.ticket.sig',
      class: 'interactive',
    });

    const ping = {
      type: 'control' as const,
      streamId: 0 as const,
      payload: new TextEncoder().encode('{"t":"ping","n":1}'),
    };
    wire.send(ping);
    await new Promise((r) => setTimeout(r, 0));
    expect(frameReader()(toAppliance[0] as Uint8Array)).toEqual([ping]);
    const got: unknown[] = [];
    wire.onFrame((f) => got.push(f));
    const pong = encodeFrame({
      type: 'control',
      streamId: 0,
      payload: new TextEncoder().encode('{"t":"pong","n":1}'),
    });
    // Arbitrary chunking of the plaintext stream is re-framed.
    secure.deliver(pong.subarray(0, 4));
    secure.deliver(pong.subarray(4));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(1);
  });

  it('aborts before sending anything when the appliance identity isn’t the pinned one', async () => {
    const { c, toAppliance } = connector({ peer: '12D3KooWsomeoneElse' });
    const pending = c.connect({ class: 'interactive', signal: new AbortController().signal });
    const ws = await relayHandshake();
    await expect(pending).rejects.toMatchObject({ reason: 'identity_mismatch' });
    expect(toAppliance).toEqual([]);
    expect(ws.sent.length).toBe(1);
  });

  it('maps relay close codes to reasons and keeps the retry hint', async () => {
    const cases: [number, string, string][] = [
      [4404, '', 'appliance_offline'],
      [4504, '', 'appliance_offline'],
      [4401, '', 'lost'],
      [4403, '', 'ticket_denied'],
      [4503, '{"retryAfterMs":1500}', 'busy'],
    ];
    for (const [code, reason, expected] of cases) {
      const { c } = connector();
      const pending = c.connect({ class: 'bulk', signal: new AbortController().signal });
      await new Promise((r) => setTimeout(r, 0));
      const ws = FakeRelaySocket.last as FakeRelaySocket;
      ws.text({ t: 'welcome', v: 1, conn: 'conn_000002', heartbeatMs: 20000, maxMessage: 262144 });
      ws.closeWith(code, reason);
      const error = (await pending.catch((e: unknown) => e)) as ConnectError;
      expect(error).toBeInstanceOf(ConnectError);
      expect(error.reason).toBe(expected);
      if (code === 4503) expect(error.retryAfterMs).toBe(1500);
    }
  });

  it('a refused ticket is terminal; control unreachable is “offline”', async () => {
    const denied = connector({
      tickets: async () => {
        throw new TicketDeniedError('Not a member.');
      },
    });
    await expect(
      denied.c.connect({ class: 'interactive', signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      reason: 'ticket_denied',
    });
    const down = connector({
      tickets: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(
      down.c.connect({ class: 'interactive', signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      reason: 'offline',
    });
  });

  it('binary data before ready is a protocol error', async () => {
    const { c } = connector();
    const pending = c.connect({ class: 'interactive', signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 0));
    (FakeRelaySocket.last as FakeRelaySocket).emit('message', { data: new ArrayBuffer(4) });
    await expect(pending).rejects.toMatchObject({ reason: 'lost' });
  });
});

describe('managed connector: attempts that get stuck or are given up (open-speed.md AP-4402)', () => {
  afterEach(() => vi.useRealTimers());

  it('cancels a silent admission request at its deadline, before opening any socket', async () => {
    vi.useFakeTimers();
    const tickets = vi.fn<TicketSource>(() => new Promise(() => {}));
    const { c } = connector({ tickets, ticketTimeoutMs: 100 });
    FakeRelaySocket.last = null;
    const pending = c.connect({ class: 'interactive', signal: new AbortController().signal });
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'offline' });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(tickets.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(FakeRelaySocket.last).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up immediately during admission even when the source ignores cancellation', async () => {
    vi.useFakeTimers();
    const tickets = vi.fn<TicketSource>(() => new Promise(() => {}));
    const { c } = connector({ tickets });
    const giveUp = new AbortController();
    const pending = c.connect({ class: 'interactive', signal: giveUp.signal });
    giveUp.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'closed' });
    expect(tickets.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks for no ticket when the attempt was already given up', async () => {
    const tickets = vi.fn<TicketSource>();
    const { c } = connector({ tickets });
    await expect(c.connect({ class: 'bulk', signal: AbortSignal.abort() })).rejects.toMatchObject({
      reason: 'closed',
    });
    expect(tickets).not.toHaveBeenCalled();
  });

  it('can open with a fresh ticket after a silent admission request timed out', async () => {
    const tickets = vi
      .fn<TicketSource>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ ticket: 'fresh.ticket', relayUrl: 'wss://relay.test/v1/connect' });
    const { c } = connector({ tickets, ticketTimeoutMs: 50 });
    await expect(
      c.connect({ class: 'interactive', signal: new AbortController().signal }),
    ).rejects.toMatchObject({ reason: 'offline' });
    const next = c.connect({ class: 'interactive', signal: new AbortController().signal });
    await relayHandshake();
    const wire = await next;
    expect(tickets).toHaveBeenCalledTimes(2);
    wire.close();
  });

  it('ends a Noise handshake that never finishes as lost, and closes the socket', async () => {
    const { c } = connector({ hangHandshake: true });
    const pending = c.connect({ class: 'interactive', signal: new AbortController().signal });
    const ws = await relayHandshake();
    await expect(pending).rejects.toMatchObject({ reason: 'lost' });
    expect(ws.readyState).toBe(3);
  });

  it('ends at once when the attempt is given up during the handshake', async () => {
    const { c } = connector({ hangHandshake: true });
    const giveUp = new AbortController();
    const pending = c.connect({ class: 'interactive', signal: giveUp.signal });
    const ws = await relayHandshake();
    giveUp.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'closed' });
    expect(ws.readyState).toBe(3);
  });

  it('opens no relay socket when the attempt was given up while the ticket came', async () => {
    let issue: (t: { ticket: string; relayUrl: string }) => void = () => {};
    const { c } = connector({ tickets: () => new Promise((r) => (issue = r)) });
    const giveUp = new AbortController();
    FakeRelaySocket.last = null;
    const pending = c.connect({ class: 'interactive', signal: giveUp.signal });
    giveUp.abort();
    issue({ ticket: 'eyJ.ticket.sig', relayUrl: 'wss://relay.test/v1/connect' });
    await expect(pending).rejects.toMatchObject({ reason: 'closed' });
    expect(FakeRelaySocket.last).toBeNull();
  });
});
