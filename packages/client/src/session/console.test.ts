/**
 * Consoles through the session (contracts 0.80.1, CT-350): `openConsole` gives a WebSocket-shaped socket over the
 * session's `console` stream — opened once the appliance says so, one console message per `send` and per `message`
 * event (as `ArrayBuffer`s), credit as back-pressure both ways, refusals in the appliance's words, and closing from
 * either side or a dropped connection.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CONSOLE_CLOSE, type ConsoleSocket, type ConsoleSocketCloseEvent } from './console';
import { createFakeAppliance, type FakeApplianceOptions, type FakeConsoleIo } from './fake';
import { createSecureSession } from './secure';
import type { ApplianceSession } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A hosts-service console message: `kind | channel (u16 BE) | payload`. */
function frame(kind: number, payload: Uint8Array | string, channel = 0): Uint8Array {
  const body = typeof payload === 'string' ? enc.encode(payload) : payload;
  const out = new Uint8Array(3 + body.length);
  out.set([kind, channel >> 8, channel & 0xff]);
  out.set(body, 3);
  return out;
}
const control = (c: object) => frame(1, JSON.stringify(c));

function until(check: () => boolean, ms = 3000): Promise<void> {
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

const live: ApplianceSession[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.close();
});

/** A fake appliance whose console echoes data and says `status` first, like the hosts service's echo terminal. */
function world(fake: Partial<FakeApplianceOptions> = {}) {
  const got: Uint8Array[] = [];
  const consoles: { io: FakeConsoleIo; closed: boolean; target: unknown }[] = [];
  const appliance = createFakeAppliance({
    handle: async () => ({ status: 200, body: {} }),
    console: (target, io) => {
      if (target.token === 'used')
        return {
          refused: 'console_refused',
          message: 'This console link was used already or is too old. Open the console again.',
        };
      if (target.token === 'down')
        return {
          refused: 'hosts_unavailable',
          message: 'Whombat’s server monitoring isn’t answering right now.',
        };
      const entry = { io, closed: false, target };
      consoles.push(entry);
      io.send(control({ type: 'status', state: 'connected', protocol: 'shell' }));
      return {
        protocol: 'shell',
        peer: {
          receive: (m) => {
            got.push(m);
            if (m[0] === 0) io.send(m);
          },
          close: () => {
            entry.closed = true;
          },
        },
      };
    },
    ...fake,
  });
  const session = createSecureSession({
    connector: appliance.connector,
    backoff: { initialMs: 2, maxMs: 10 },
  });
  live.push(session);
  return { appliance, session, got, consoles };
}

/** What a socket said, in order. */
function record(socket: ConsoleSocket) {
  const events: string[] = [];
  const messages: Uint8Array[] = [];
  let close: ConsoleSocketCloseEvent | null = null;
  socket.onopen = () => events.push('open');
  socket.onmessage = (e) => {
    expect(e.data).toBeInstanceOf(ArrayBuffer);
    messages.push(new Uint8Array(e.data));
    events.push('message');
  };
  socket.onerror = () => events.push('error');
  socket.addEventListener('close', (e) => {
    close = e;
    events.push('close');
  });
  return { events, messages, close: () => close as ConsoleSocketCloseEvent | null };
}

async function connected(session: ApplianceSession) {
  session.connect();
  await until(() => session.state().status === 'open');
}

const target = { burrow: 'burrow-hq', sessionId: 'cs_1', token: 'tok' };

describe('consoles through the session', () => {
  it('opens once the appliance says so and carries console messages both ways', async () => {
    const { session, got } = world();
    await connected(session);
    expect(session.supports('stream.console')).toBe(true);
    const socket = session.openConsole(target) as ConsoleSocket;
    expect(socket.readyState).toBe(socket.CONNECTING);
    expect(() => socket.send(frame(0, 'x'))).toThrow(/isn’t open/);
    const r = record(socket);
    await until(() => socket.readyState === socket.OPEN);
    expect(socket.protocol).toBe('shell');
    await until(() => r.messages.length === 1);
    expect(JSON.parse(dec.decode(r.messages[0]?.subarray(3)))).toMatchObject({ type: 'status' });
    socket.send(control({ type: 'activity' }));
    socket.send(frame(0, 'ls\n'));
    await until(() => r.messages.length === 2);
    expect(dec.decode(r.messages[1]?.subarray(3))).toBe('ls\n');
    expect(got.map((m) => m[0])).toEqual([1, 0]);
    expect(socket.bufferedAmount).toBe(0);
    expect(r.events.slice(0, 2)).toEqual(['open', 'message']);
  });

  // 600 KB through the encrypted session takes about a second alone and several on a busy CI runner.
  it('carries messages larger than a frame and the window, paced by credit', async () => {
    const { session, got } = world();
    await connected(session);
    const socket = session.openConsole(target) as ConsoleSocket;
    const r = record(socket);
    await until(() => r.messages.length === 1);
    // A VNC screen update: larger than the 256 KiB window and the fake's 16 KiB frames.
    const big = frame(
      0,
      new Uint8Array(600_000).map((_, i) => i % 253),
    );
    socket.send(big);
    expect(socket.bufferedAmount).toBeGreaterThan(0);
    await until(() => r.messages.length === 2, 15_000);
    expect(got.at(-1)).toEqual(big);
    expect(r.messages[1]).toEqual(big);
    await until(() => socket.bufferedAmount === 0);
  }, 20_000);

  it('says why it was refused, in the appliance’s words', async () => {
    const { session } = world();
    await connected(session);
    const used = session.openConsole({ ...target, token: 'used' }) as ConsoleSocket;
    const r = record(used);
    await until(() => used.readyState === used.CLOSED);
    expect(r.events).toEqual(['error', 'close']);
    expect(r.close()).toMatchObject({ code: CONSOLE_CLOSE.refused, wasClean: false });
    expect(used.error).toEqual({
      code: 'console_refused',
      message: 'This console link was used already or is too old. Open the console again.',
    });
    const down = session.openConsole({ ...target, token: 'down' }) as ConsoleSocket;
    const d = record(down);
    await until(() => down.readyState === down.CLOSED);
    expect(d.close()?.code).toBe(CONSOLE_CLOSE.tryAgain);
    expect(down.error?.code).toBe('hosts_unavailable');
  });

  it('closes cleanly when the service ends it, after its reason', async () => {
    const { session, consoles } = world();
    await connected(session);
    const socket = session.openConsole(target) as ConsoleSocket;
    const r = record(socket);
    await until(() => r.messages.length === 1);
    const io = consoles.at(-1)?.io as FakeConsoleIo;
    io.send(control({ type: 'closed', reason: 'idle_timeout' }));
    io.end();
    await until(() => socket.readyState === socket.CLOSED);
    expect(r.events).toEqual(['open', 'message', 'message', 'close']);
    expect(JSON.parse(dec.decode(r.messages[1]?.subarray(3)))).toEqual({
      type: 'closed',
      reason: 'idle_timeout',
    });
    expect(r.close()).toMatchObject({ code: 1000, wasClean: true });
  });

  it('closes the service’s console when the person leaves, and fails when the connection drops', async () => {
    const { session, consoles, appliance } = world();
    await connected(session);
    const socket = session.openConsole(target) as ConsoleSocket;
    const r = record(socket);
    await until(() => socket.readyState === socket.OPEN);
    socket.close();
    expect(socket.readyState).toBe(socket.CLOSING);
    await until(() => socket.readyState === socket.CLOSED);
    expect(r.close()).toMatchObject({ code: 1000, wasClean: true });
    await until(() => consoles[0]?.closed === true);

    const other = session.openConsole(target) as ConsoleSocket;
    const o = record(other);
    await until(() => other.readyState === other.OPEN);
    appliance.faults.dropAll('lost');
    await until(() => other.readyState === other.CLOSED);
    expect(o.close()?.code).toBe(CONSOLE_CLOSE.lost);
    expect(o.events).toContain('error');
    // A console's token works once: it never re-attaches by itself.
    await until(() => session.state().status === 'open');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(consoles).toHaveLength(2);
  });

  it('has no console where the runtime has none', async () => {
    const { session } = world({ capabilities: ['events', 'stream.collab'] });
    await connected(session);
    expect(session.openConsole(target)).toBeNull();
  });
});
