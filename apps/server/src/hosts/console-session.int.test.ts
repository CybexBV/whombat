/**
 * Consoles through the managed session (contracts 0.80.1, CT-350; one-whombat-consoles.md ONE-DC01…ONE-DC07): the web
 * app on dev.whombat.com reaches the box only through the relay, so its console is a `console` stream on the session,
 * relayed to the hosts service's console WebSocket (here the fake hosts service on a unix socket). The same rule as the
 * WebSocket proxy (the person, a single-use 30-second ticket), the service's own subprotocols and the person as actor, the
 * console's frames unchanged both ways with credit as back-pressure, and closing from either side.
 */
import { CONSOLE_MAX_MESSAGE_BYTES } from '@whombat/protocol';
import { ConsoleMessageDecoder, encodeConsoleMessages } from '@whombat/protocol/console';
import { beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { STREAM_RESET } from '../managed/ports';
import type { TestSessionClient } from '../managed/testing';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { endFakeConsole, FakeHostsService } from './testing/fake';

const fake = new FakeHostsService();
const m = useManagedRuntime({
  seed: true,
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});
let mara: Awaited<ReturnType<typeof m.enroll>>;

beforeAll(async () => {
  await fake.start();
  mara = await m.enroll(IDS.mara);
  return () => fake.stop();
});

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

/** The console messages the appliance sent on a stream so far. */
function messagesOf(c: TestSessionClient, stream: number): Uint8Array[] {
  const d = new ConsoleMessageDecoder();
  return (c.streamData.get(stream) ?? []).flatMap((p) => d.push(p));
}

async function until<T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function createConsole(c: TestSessionClient) {
  const r = await c.request('hosts.createConsole', {
    params: { burrow: 'burrow-hq', serverId: 'basalt' },
    body: { guestId: 'incus:dev-shell', protocol: 'shell' },
  });
  expect(r, JSON.stringify(r)).toMatchObject({ t: 'result' });
  return (r as unknown as { output: { sessionId: string; token: string } }).output;
}

const consoleSpec = (s: { sessionId: string; token: string }) => ({
  kind: 'console' as const,
  burrow: 'burrow-hq',
  sessionId: s.sessionId,
  token: s.token,
});

describe('a console through the session', () => {
  it('says the runtime serves consoles', async () => {
    const c = await m.client(mara);
    const welcome = c.received.find((x) => x.t === 'welcome');
    expect(welcome?.t === 'welcome' && welcome.capabilities).toContain('stream.console');
  });

  it('opens a shell for the person, relays frames both ways as them, and works once', async () => {
    const c = await m.client(mara);
    const session = await createConsole(c);
    const { stream, answer } = await c.open(consoleSpec(session));
    expect(answer).toEqual({ t: 'opened', stream, meta: { kind: 'console', protocol: 'shell' } });
    const upstream = fake.consoles.at(-1);
    expect(upstream?.session).toBe(session.sessionId);
    expect(upstream?.headers['x-whombat-actor']).toBe('prn_mara|Mara Okafor');
    expect(upstream?.headers.authorization).toBe(`Bearer ${fake.token}`);
    expect(upstream?.protocols).toEqual(['rackoon.console.v1', expect.stringMatching(/^rackoon\.token\./)]);
    // The hub's `status` comes first, as over the WebSocket.
    const first = await until(() => messagesOf(c, stream)[0]);
    expect(first[0]).toBe(1);
    expect(JSON.parse(dec.decode(first.subarray(3)))).toMatchObject({ type: 'status', state: 'connected' });
    // Keys go up and the echo comes back unchanged; an `activity` control passes through too.
    c.write(stream, encodeConsoleMessages([frame(1, '{"type":"activity"}'), frame(0, 'ls\n')]));
    const echo = await until(() => messagesOf(c, stream)[1]);
    expect(dec.decode(echo.subarray(3))).toBe('ls\n');
    // The same token again is refused, in the words a client shows, with the code to open it again.
    const again = await c.open(consoleSpec(session));
    expect(again.answer).toMatchObject({
      t: 'error',
      code: 'stream_refused',
      details: { code: 'console_refused' },
    });
    c.frame({ type: 'reset', streamId: stream, code: STREAM_RESET.cancelled });
    // Leaving closes the service's console.
    await until(() => upstream?.ws?.readyState === WebSocket.CLOSED);
  });

  it('carries a message larger than the window, paced by credit both ways', async () => {
    const c = await m.client(mara);
    const { stream, answer } = await c.open(consoleSpec(await createConsole(c)));
    expect(answer).toMatchObject({ t: 'opened' });
    await until(() => messagesOf(c, stream).length >= 1);
    // A screen's worth: more than the 256 KiB initial window, so it spans DATA frames and waits for credit.
    const big = frame(
      0,
      new Uint8Array(700_000).map((_, i) => i % 251),
    );
    await c.writeWithCredit(stream, encodeConsoleMessages([big]));
    const back = await until(() => messagesOf(c, stream)[1], 10_000);
    expect(back).toEqual(big);
    c.frame({ type: 'reset', streamId: stream, code: STREAM_RESET.cancelled });
  });

  it('ends the stream when the hub ends the console, after its reason', async () => {
    const c = await m.client(mara);
    const { stream } = await c.open(consoleSpec(await createConsole(c)));
    const ws = await until(() => fake.consoles.at(-1)?.ws);
    await until(() => messagesOf(c, stream).length >= 1);
    endFakeConsole(ws, 'idle_timeout');
    const { reset } = await c.readStream(stream);
    expect(reset).toBeNull();
    const last = messagesOf(c, stream).at(-1) as Uint8Array;
    expect(JSON.parse(dec.decode(last.subarray(3)))).toEqual({ type: 'closed', reason: 'idle_timeout' });
  });

  it('refuses a console of another session and a message above the bound', async () => {
    const device = await m.client(mara);
    const session = await createConsole(device);
    const other = await device.open({ ...consoleSpec(session), sessionId: 'cs_somebody_else' });
    expect(other.answer).toMatchObject({ t: 'error', details: { code: 'console_refused' } });
    // The wrong session used the ticket up: a new console opens fine.
    const fresh = await device.open(consoleSpec(await createConsole(device)));
    expect(fresh.answer).toMatchObject({ t: 'opened' });
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, CONSOLE_MAX_MESSAGE_BYTES + 1);
    device.write(fresh.stream, header);
    expect((await device.readStream(fresh.stream)).reset).toBe(STREAM_RESET.protocolError);
  });
});
