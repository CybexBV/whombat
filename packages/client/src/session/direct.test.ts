import { DIRECT_CLOSE, DIRECT_SUBPROTOCOL } from '@whombat/protocol/direct';
import type { DirectRoute } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import type { ByteStreamLike, RelaySocket, SecureChannelPort, SecureConnectionLike } from './connector';
import { createDirectConnector, createRoutedConnector } from './direct';
import { ConnectError, type SessionConnector, type WireConnection } from './wire';

const BOX = '12D3KooWbox';
const lan: DirectRoute = {
  way: 'lan',
  socket: 'ws://192.168.1.20:4480/v1/direct',
  web: 'http://192.168.1.20:4480/',
};
const lan2: DirectRoute = {
  way: 'lan',
  socket: 'ws://10.0.0.20:4480/v1/direct',
  web: 'http://10.0.0.20:4480/',
};
const tailnet: DirectRoute = {
  way: 'tailscale',
  socket: 'wss://whombat-r7m4.tail1234.ts.net:4480/v1/direct',
  web: 'https://whombat-r7m4.tail1234.ts.net:4480/',
};

/** What answers at each socket URL: the box (with its PeerId), a close code, or nothing at all. */
type Answer = { peer: string } | { close: number } | 'silent';

/** A direct listener per URL, scripted. */
function network(answers: Record<string, Answer>) {
  const opened: { url: string; protocol: string; sent: string[]; closed: () => boolean }[] = [];
  class Socket implements RelaySocket {
    readyState = 0;
    binaryType = 'blob';
    listeners = new Map<string, Set<(e: unknown) => void>>();
    sent: string[] = [];
    constructor(
      readonly url: string,
      readonly protocol: string,
    ) {
      opened.push({ url, protocol, sent: this.sent, closed: () => this.readyState === 3 });
      const answer = answers[url] ?? 'silent';
      if (answer === 'silent') return;
      queueMicrotask(() => {
        if ('close' in answer) return this.emit('close', { code: answer.close });
        this.readyState = 1;
        this.emit('open', {});
      });
    }
    send(data: string | Uint8Array) {
      if (typeof data !== 'string') return;
      this.sent.push(data);
      const hello = JSON.parse(data) as { t: string };
      if (hello.t === 'hello')
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({ t: 'welcome', v: 1, heartbeatMs: 20_000, maxMessage: 262_144 }),
          }),
        );
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
  }
  // The "secure channel" checks the pin against whoever answered at the URL the socket opened.
  let current = '';
  const plain: ByteStreamLike = {
    read: () => new Promise(() => {}),
    write: () => true,
    drained: async () => {},
    close: async () => {},
    abort: () => {},
  };
  const secure: SecureChannelPort<string> = {
    byteStream: (socket) => {
      current = (socket as unknown as Socket).url;
      return plain;
    },
    async openInitiator(o) {
      const answer = answers[current];
      if (
        !answer ||
        answer === 'silent' ||
        !('peer' in answer) ||
        answer.peer !== o.expectedAppliancePeerId
      ) {
        const e = new Error('mismatch') as Error & { code: string };
        e.code = 'PEER_MISMATCH';
        throw e;
      }
      const conn: SecureConnectionLike = {
        remotePeerId: answer.peer,
        rekeyRequired: false,
        close: async () => {},
        abort: () => {},
      };
      return conn;
    },
    secureByteStream: () => plain,
  };
  return { opened, secure, socket: (url: string, protocol: string) => new Socket(url, protocol) };
}

const request = () => ({ class: 'interactive' as const, signal: new AbortController().signal });

function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > end) return reject(new Error('timed out waiting'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the direct connector (AP-5302)', () => {
  it('says hello on the direct subprotocol and opens the session with the box pinned', async () => {
    const net = network({ [lan.socket]: { peer: BOX } });
    const used: DirectRoute[] = [];
    const c = createDirectConnector({
      routes: () => [lan],
      secure: net.secure,
      identity: async () => 'me',
      appliance: { peerId: BOX },
      socket: net.socket,
      onRoute: (r) => used.push(r),
    });
    await expect(c.connect(request())).resolves.toBeDefined();
    expect(net.opened[0]).toMatchObject({ url: lan.socket, protocol: DIRECT_SUBPROTOCOL });
    expect(JSON.parse(net.opened[0]?.sent[0] ?? '{}')).toEqual({ t: 'hello', v: 1, class: 'interactive' });
    expect(used).toEqual([lan]);
  });

  it('moves on from an address that is silent, refuses, or has another box; then remembers the one that worked', async () => {
    const net = network({
      [lan.socket]: { peer: '12D3KooWanother' },
      [lan2.socket]: { close: DIRECT_CLOSE.forbidden },
      [tailnet.socket]: { peer: BOX },
    });
    const c = createDirectConnector({
      routes: () => [lan, lan2, tailnet],
      secure: net.secure,
      identity: async () => 'me',
      appliance: { peerId: BOX },
      socket: net.socket,
      dialTimeoutMs: 20,
    });
    await c.connect(request());
    expect(net.opened.map((o) => o.url)).toEqual([lan.socket, lan2.socket, tailnet.socket]);
    await c.connect(request());
    expect(net.opened.at(-1)?.url).toBe(tailnet.socket);
    expect(net.opened).toHaveLength(4);
  });

  it('dials the next address before a silent one times out, gives the silent one up, and opens nothing else once one answers', async () => {
    const net = network({ [lan.socket]: 'silent', [lan2.socket]: { peer: BOX } });
    const c = createDirectConnector({
      routes: () => [lan, lan2, tailnet],
      secure: net.secure,
      identity: async () => 'me',
      appliance: { peerId: BOX },
      socket: net.socket,
      dialTimeoutMs: 60_000,
      staggerMs: 10,
    });
    await c.connect(request());
    expect(net.opened.map((o) => o.url)).toEqual([lan.socket, lan2.socket]);
    expect(net.opened[0]?.closed()).toBe(true);
    // The address that worked goes first next time, and answers before the next one is due.
    await c.connect(request());
    await sleep(40);
    expect(net.opened.map((o) => o.url)).toEqual([lan.socket, lan2.socket, lan2.socket]);
  });

  it('is offline when no route answers, and never the identity stop', async () => {
    const net = network({ [lan.socket]: { peer: '12D3KooWanother' }, [tailnet.socket]: 'silent' });
    const c = createDirectConnector({
      routes: () => [lan, tailnet],
      secure: net.secure,
      identity: async () => 'me',
      appliance: { peerId: BOX },
      socket: net.socket,
      dialTimeoutMs: 20,
    });
    const error = await c.connect(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).reason).toBe('offline');
    const none = createDirectConnector({
      routes: () => [],
      secure: net.secure,
      identity: async () => 'me',
      appliance: { peerId: BOX },
      socket: net.socket,
    });
    await expect(none.connect(request())).rejects.toMatchObject({ reason: 'offline' });
  });
});

describe('direct first, the relay after (HE-50)', () => {
  const wire = {} as WireConnection;
  const scripted = (results: (WireConnection | ConnectError)[]) => {
    let n = 0;
    const c: SessionConnector & { calls: () => number } = {
      async connect() {
        const r = results[Math.min(n++, results.length - 1)];
        if (r instanceof ConnectError) throw r;
        return r as WireConnection;
      },
      calls: () => n,
    };
    return c;
  };

  it('uses the box directly when it answers, else the relay; and leaves the direct ways alone for a while', async () => {
    let t = 0;
    const direct = scripted([new ConnectError('offline'), new ConnectError('offline'), wire]);
    const relay = scripted([wire]);
    const ways: string[] = [];
    const c = createRoutedConnector({ direct, relay, now: () => t, onWay: (w) => ways.push(w) });
    await c.connect(request());
    expect(ways).toEqual(['relay']);
    t = 30_000;
    await c.connect(request());
    expect(direct.calls()).toBe(1);
    t = 61_000;
    await c.connect(request());
    expect(direct.calls()).toBe(2);
    t = 130_000;
    await c.connect(request());
    expect(ways).toEqual(['relay', 'relay', 'relay', 'direct']);
  });

  it('without a relay (the box’s own page) the direct failure is the answer', async () => {
    const c = createRoutedConnector({ direct: scripted([new ConnectError('busy')]), relay: null });
    await expect(c.connect(request())).rejects.toMatchObject({ reason: 'busy' });
  });
  /** A connector whose attempts the test settles; an attempt given up fails as `closed`. */
  const held = () => {
    const attempts: {
      signal: AbortSignal;
      open: (w: WireConnection) => void;
      fail: (e: ConnectError) => void;
    }[] = [];
    const c: SessionConnector = {
      connect: (r) =>
        new Promise<WireConnection>((open, fail) => {
          attempts.push({ signal: r.signal, open, fail });
          r.signal.addEventListener('abort', () => fail(new ConnectError('closed')), { once: true });
        }),
    };
    return { c, attempts };
  };

  it('starts the relay beside direct ways that haven’t opened, gives them up when it opens first, and goes straight to it for a while', async () => {
    const direct = held();
    const relay = held();
    const ways: string[] = [];
    const c = createRoutedConnector({
      direct: direct.c,
      relay: relay.c,
      relayAfterMs: 20,
      onWay: (w) => ways.push(w),
    });
    const first = c.connect(request());
    await until(() => relay.attempts.length === 1);
    expect(direct.attempts).toHaveLength(1);
    relay.attempts[0]?.open(wire);
    await expect(first).resolves.toBe(wire);
    expect(direct.attempts[0]?.signal.aborted).toBe(true);
    const next = c.connect(request());
    await until(() => relay.attempts.length === 2);
    relay.attempts[1]?.open(wire);
    await next;
    expect(direct.attempts).toHaveLength(1);
    expect(ways).toEqual(['relay', 'relay']);
  });

  it('never asks the relay when the box opens within the head start, and prefers the box when it opens after the relay started', async () => {
    const direct = held();
    const relay = held();
    const c = createRoutedConnector({ direct: direct.c, relay: relay.c, relayAfterMs: 20 });
    const first = c.connect(request());
    await until(() => direct.attempts.length === 1);
    direct.attempts[0]?.open(wire);
    await first;
    await sleep(40);
    expect(relay.attempts).toHaveLength(0);
    const second = c.connect(request());
    await until(() => relay.attempts.length === 1);
    direct.attempts[1]?.open(wire);
    await expect(second).resolves.toBe(wire);
    expect(relay.attempts[0]?.signal.aborted).toBe(true);
  });

  it('tries the relay at once when the direct ways failed, waits for the box when the relay fails first, and gives the relay’s answer when both fail', async () => {
    const direct = held();
    const relay = held();
    const late = createRoutedConnector({ direct: direct.c, relay: relay.c, relayAfterMs: 60_000 });
    const first = late.connect(request());
    await until(() => direct.attempts.length === 1);
    direct.attempts[0]?.fail(new ConnectError('offline'));
    await until(() => relay.attempts.length === 1);
    relay.attempts[0]?.open(wire);
    await expect(first).resolves.toBe(wire);

    const c = createRoutedConnector({ direct: direct.c, relay: relay.c, relayAfterMs: 10 });
    const second = c.connect(request());
    await until(() => relay.attempts.length === 2);
    relay.attempts[1]?.fail(new ConnectError('appliance_offline'));
    await sleep(20);
    direct.attempts[1]?.open(wire);
    await expect(second).resolves.toBe(wire);

    const third = createRoutedConnector({ direct: direct.c, relay: relay.c, relayAfterMs: 10 }).connect(
      request(),
    );
    await until(() => relay.attempts.length === 3);
    relay.attempts[2]?.fail(new ConnectError('appliance_offline'));
    direct.attempts[2]?.fail(new ConnectError('offline'));
    await expect(third).rejects.toMatchObject({ reason: 'appliance_offline' });
  });
});
