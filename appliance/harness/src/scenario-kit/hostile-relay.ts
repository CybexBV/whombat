/**
 * A hostile relay for scenario (c) (MA-05/MA-07 threat: the relay operator is untrusted). It sits where the
 * client expects the relay: the client dials it with a real control ticket, it forwards the relay protocol to the
 * real relay and then, after `ready`, sees every byte in both directions — exactly what the relay sees. Modes:
 *
 * - `observe`: forward unmodified, record everything (plaintext scan);
 * - `tamper`: flip one bit in the n-th binary message of a direction;
 * - `replay`: deliver the n-th binary message of a direction twice;
 * - `substitute`: never go upstream; answer `welcome`/`ready` itself and run a Noise responder with its own
 *   identity (a different appliance), recording what the client sends.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RELAY_SUBPROTOCOL } from '@whombat/protocol/relay';
import {
  acceptResponder,
  generateIdentity,
  type Identity,
  webSocketByteStream,
} from '@whombat/secure-channel';
import WebSocket, { WebSocketServer } from 'ws';

export type Direction = 'toAppliance' | 'toClient';

export type HostileMode =
  | { kind: 'observe' }
  | { kind: 'tamper'; direction: Direction; nth: number }
  | { kind: 'replay'; direction: Direction; nth: number; once?: boolean }
  | { kind: 'substitute'; identity?: Identity };

export interface Recorded {
  direction: Direction;
  bytes: Uint8Array;
  text: boolean;
}

export interface HostileRelay {
  url: string;
  mode: HostileMode;
  setMode(m: HostileMode): void;
  /** Everything seen, both directions, including text frames. */
  recorded: Recorded[];
  /** Binary messages the client sent to a substituted responder after its handshake (must be none). */
  substitutedAppBytes: number;
  substituteIdentity: Identity | null;
  events: string[];
  connections: number;
  /**
   * The next binary message from the client is forwarded to the appliance, then both sides are closed before
   * any answer can come back (a lost acknowledgement).
   */
  armCut(): void;
  /** Close all client sockets (like a relay restart). */
  dropAll(code?: number): void;
  close(): Promise<void>;
  /** Byte offsets of `needle` (UTF-8) in the recorded stream(s). */
  find(needle: string): number;
}

export async function startHostileRelay(
  upstreamUrl: string,
  mode: HostileMode = { kind: 'observe' },
): Promise<HostileRelay> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server, handleProtocols: () => RELAY_SUBPROTOCOL, maxPayload: 262_144 });
  const clients = new Set<WebSocket>();
  let cutArmed = false;
  const relay: HostileRelay = {
    url: '',
    mode,
    setMode(m) {
      relay.mode = m;
    },
    recorded: [],
    substitutedAppBytes: 0,
    substituteIdentity: null,
    events: [],
    connections: 0,
    armCut() {
      cutArmed = true;
    },
    dropAll(code = 1012) {
      for (const c of clients) c.close(code, 'hostile relay restart');
    },
    async close() {
      for (const c of clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
    find(needle) {
      const n = Buffer.from(needle, 'utf8');
      let hits = 0;
      for (const r of relay.recorded) if (Buffer.from(r.bytes).includes(n)) hits++;
      return hits;
    },
  };

  wss.on('connection', (client) => {
    relay.connections++;
    clients.add(client);
    client.on('close', () => clients.delete(client));
    const m = relay.mode;
    if (m.kind === 'substitute') return void substitute(client, m);
    proxy(client, m);
  });

  function record(direction: Direction, data: WebSocket.RawData, text: boolean) {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    relay.recorded.push({ direction, bytes: new Uint8Array(buf), text });
    return buf;
  }

  function proxy(client: WebSocket, m: HostileMode) {
    const upstream = new WebSocket(upstreamUrl, RELAY_SUBPROTOCOL, { maxPayload: 262_144 });
    const pending: { data: WebSocket.RawData; isBinary: boolean }[] = [];
    const count: Record<Direction, number> = { toAppliance: 0, toClient: 0 };
    const forward = (to: WebSocket, direction: Direction, data: WebSocket.RawData, isBinary: boolean) => {
      const buf = record(direction, data, !isBinary);
      if (!isBinary) return to.send(buf.toString('utf8'));
      count[direction]++;
      if (m.kind === 'tamper' && m.direction === direction && count[direction] === m.nth) {
        const t = Buffer.from(buf);
        t[t.length >> 1] = (t[t.length >> 1] ?? 0) ^ 0x01;
        relay.events.push(`tampered ${direction} #${m.nth} (${t.length} bytes)`);
        return to.send(t, { binary: true });
      }
      to.send(buf, { binary: true });
      if (cutArmed && direction === 'toAppliance') {
        cutArmed = false;
        relay.events.push(`cut after forwarding ${buf.length} bytes to the appliance`);
        // Nothing the appliance answers reaches the client.
        client.terminate();
        return;
      }
      if (m.kind === 'replay' && m.direction === direction && count[direction] === m.nth) {
        relay.events.push(`replayed ${direction} #${m.nth} (${buf.length} bytes)`);
        to.send(buf, { binary: true });
        if (m.once) relay.mode = { kind: 'observe' };
      }
    };
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) forward(upstream, 'toAppliance', data, isBinary);
      else pending.push({ data, isBinary });
    });
    upstream.on('open', () => {
      for (const p of pending.splice(0)) forward(upstream, 'toAppliance', p.data, p.isBinary);
    });
    upstream.on('message', (data, isBinary) => forward(client, 'toClient', data, isBinary));
    const closeBoth = (code: number, reason: Buffer | string) => {
      const c = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011;
      if (client.readyState === WebSocket.OPEN) client.close(c, reason.toString());
      if (upstream.readyState === WebSocket.OPEN) upstream.close(c, reason.toString());
    };
    client.on('close', (c, r) => closeBoth(c, r));
    upstream.on('close', (c, r) => {
      relay.events.push(`upstream closed ${c}`);
      closeBoth(c, r);
    });
    upstream.on('error', () => client.close(1011));
    client.on('error', () => upstream.close(1011));
  }

  async function substitute(client: WebSocket, m: { kind: 'substitute'; identity?: Identity }) {
    const identity = m.identity ?? (await generateIdentity());
    relay.substituteIdentity = identity;
    let handshakeDone = false;
    client.on('message', (data, isBinary) => {
      record('toAppliance', data, !isBinary);
      if (!isBinary) {
        // hello → pretend to be the relay: welcome + ready.
        client.send(
          JSON.stringify({
            t: 'welcome',
            v: 1,
            conn: 'hostile-conn-0001',
            heartbeatMs: 20000,
            maxMessage: 262144,
          }),
        );
        client.send(JSON.stringify({ t: 'ready' }));
        start();
      } else if (handshakeDone) {
        relay.substitutedAppBytes += Buffer.byteLength(data as Buffer);
      }
    });
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      // Synchronously, so the client's first Noise message cannot arrive before the stream listens.
      const stream = webSocketByteStream(client as unknown as Parameters<typeof webSocketByteStream>[0]);
      void (async () => {
        try {
          const conn = await acceptResponder({ stream, identity });
          handshakeDone = true;
          relay.events.push(`substitute: handshake completed with ${conn.remotePeerId}`);
          const msg = await conn.receive().catch(() => null);
          if (msg) relay.substitutedAppBytes += msg.byteLength;
        } catch (err) {
          relay.events.push(`substitute: handshake ended: ${(err as Error).message}`);
        }
      })();
    };
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  relay.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/connect`;
  return relay;
}
