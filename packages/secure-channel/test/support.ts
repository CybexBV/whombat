import type { AddressInfo } from 'node:net';
import type { ICryptoInterface } from '@libp2p/noise';
import { WebSocket, WebSocketServer } from 'ws';
import {
  acceptResponder,
  type ByteStream,
  type ChannelLimits,
  generateIdentity,
  type Identity,
  memoryByteStreamPair,
  openInitiator,
  type SecureConnection,
  webSocketByteStream,
} from '../src/index.js';

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array | null): string => (b === null ? '<null>' : new TextDecoder().decode(b));

export async function identities(): Promise<{ client: Identity; appliance: Identity }> {
  const [client, appliance] = await Promise.all([generateIdentity(), generateIdentity()]);
  return { client, appliance };
}

/** Capture a promise's settlement without an unhandled rejection. */
export function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

export type Direction = 'c2a' | 'a2c';
/** A transform applied to each chunk by a malicious splice; return the chunks to forward (possibly none). */
export type Tamper = (dir: Direction, chunk: Uint8Array, index: number) => Uint8Array[] | 'close';

/**
 * Splice two in-memory byte streams through a man-in-the-middle that can rewrite chunks (like a relay would).
 * Returns the endpoints for client and appliance.
 */
export function mitmPair(tamper?: Tamper): {
  client: ByteStream;
  appliance: ByteStream;
  log: Record<Direction, number[]>;
} {
  const [client, relayC] = memoryByteStreamPair();
  const [relayA, appliance] = memoryByteStreamPair();
  const log: Record<Direction, number[]> = { c2a: [], a2c: [] };
  const pump = async (from: ByteStream, to: ByteStream, dir: Direction): Promise<void> => {
    let i = 0;
    try {
      for (;;) {
        const chunk = await from.read();
        if (chunk === null) {
          await to.close();
          return;
        }
        log[dir].push(chunk.byteLength);
        const out = tamper ? tamper(dir, chunk, i) : [chunk];
        i++;
        if (out === 'close') {
          await to.close();
          await from.close();
          return;
        }
        for (const c of out) if (!to.write(c)) await to.drained();
      }
    } catch (err) {
      to.abort(err as Error);
    }
  };
  void pump(relayC, relayA, 'c2a');
  void pump(relayA, relayC, 'a2c');
  return { client, appliance, log };
}

export async function connectPair(
  opts: {
    client?: Identity;
    appliance?: Identity;
    streams?: { client: ByteStream; appliance: ByteStream };
    clientLimits?: ChannelLimits;
    applianceLimits?: ChannelLimits;
    expected?: string;
    clientCrypto?: ICryptoInterface;
    applianceCrypto?: ICryptoInterface;
  } = {},
): Promise<{ c: SecureConnection; a: SecureConnection; client: Identity; appliance: Identity }> {
  const client = opts.client ?? (await generateIdentity());
  const appliance = opts.appliance ?? (await generateIdentity());
  const streams =
    opts.streams ??
    (() => {
      const [x, y] = memoryByteStreamPair();
      return { client: x, appliance: y };
    })();
  const [c, a] = await Promise.all([
    openInitiator({
      stream: streams.client,
      identity: client,
      expectedAppliancePeerId: opts.expected ?? appliance.peerId,
      limits: opts.clientLimits,
      crypto: opts.clientCrypto,
    }),
    acceptResponder({
      stream: streams.appliance,
      identity: appliance,
      limits: opts.applianceLimits,
      crypto: opts.applianceCrypto,
    }),
  ]);
  return { c, a, client, appliance };
}

/**
 * A dumb splice relay: the first WebSocket on `/c/<sid>` is spliced to the first on `/a/<sid>`; binary
 * messages are forwarded unmodified (or through `tamper`), close is forwarded. Mirrors relay protocol v1
 * after `ready`, without tickets.
 */
export async function startSpliceRelay(
  options: { tamper?: Tamper; maxPayload?: number } = {},
): Promise<{ url: string; close: () => Promise<void>; forwarded: () => Record<Direction, number> }> {
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    maxPayload: options.maxPayload ?? 1024 * 1024,
  });
  const waiting = new Map<string, { ws: WebSocket; role: string; buffered: Buffer[] }>();
  const forwarded: Record<Direction, number> = { c2a: 0, a2c: 0 };
  // Like the real relay (MA-05): at most 1 MiB buffered per direction, then stop reading the source.
  const RELAY_BUFFER = 1024 * 1024;
  wss.on('connection', (ws, req) => {
    const [, role, sid] = (req.url ?? '').split('/');
    if (!role || !sid) {
      ws.close(4400, 'bad path');
      return;
    }
    const entry = { ws, role, buffered: [] as Buffer[] };
    const early = (data: Buffer) => entry.buffered.push(data);
    ws.on('message', early);
    const other = waiting.get(sid);
    if (!other || other.role === role) {
      waiting.set(sid, entry);
      return;
    }
    waiting.delete(sid);
    const link = (from: typeof entry, to: typeof entry, dir: Direction) => {
      let i = 0;
      from.ws.off('message', early);
      from.ws.removeAllListeners('message');
      const forward = (data: Buffer) => {
        const out = options.tamper ? options.tamper(dir, new Uint8Array(data), i) : [new Uint8Array(data)];
        i++;
        if (out === 'close') {
          to.ws.close(1000);
          from.ws.close(1000);
          return;
        }
        for (const c of out) {
          forwarded[dir] += c.byteLength;
          if (to.ws.readyState === WebSocket.OPEN) to.ws.send(c);
        }
        if (to.ws.bufferedAmount > RELAY_BUFFER && !paused) {
          paused = true;
          from.ws.pause();
          const poll = setInterval(() => {
            if (to.ws.readyState !== WebSocket.OPEN || to.ws.bufferedAmount <= RELAY_BUFFER / 2) {
              clearInterval(poll);
              paused = false;
              from.ws.resume();
            }
          }, 2);
        }
      };
      let paused = false;
      for (const b of from.buffered) forward(b);
      from.buffered.length = 0;
      from.ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          to.ws.close(4400, 'text after ready');
          from.ws.close(4400, 'text after ready');
          return;
        }
        forward(data);
      });
      from.ws.on('close', (code: number) => {
        const forwardCode = code === 1005 || code === 1006 ? 1000 : code;
        if (to.ws.readyState === WebSocket.OPEN) to.ws.close(forwardCode);
      });
    };
    const client = role === 'c' ? entry : other;
    const appl = role === 'a' ? entry : other;
    link(client, appl, 'c2a');
    link(appl, client, 'a2c');
  });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    forwarded: () => ({ ...forwarded }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

export async function openWs(url: string, maxPayload = 1024 * 1024): Promise<WebSocket> {
  const ws = new WebSocket(url, { maxPayload });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

let sessionCounter = 0;
export async function wsStreams(relayUrl: string): Promise<{ client: ByteStream; appliance: ByteStream }> {
  const sid = `s${++sessionCounter}-${Math.random().toString(36).slice(2)}`;
  const [cws, aws] = await Promise.all([openWs(`${relayUrl}/c/${sid}`), openWs(`${relayUrl}/a/${sid}`)]);
  return {
    client: webSocketByteStream(cws as never),
    appliance: webSocketByteStream(aws as never),
  };
}
