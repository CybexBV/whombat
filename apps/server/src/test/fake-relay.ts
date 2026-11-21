/**
 * A minimal relay for tests (relay protocol v1, MA-05): one appliance control connection, client connections spliced to
 * data connections, and everything it forwarded kept to prove it only saw ciphertext.
 */
import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

export class FakeRelay {
  server: Server;
  wss: WebSocketServer;
  control: WebSocket | null = null;
  hellos: Record<string, unknown>[] = [];
  /** Every binary message it forwarded, to prove it only saw ciphertext. */
  forwarded: Buffer[] = [];
  private waiting = new Map<string, WebSocket>();
  private next = 0;
  rejectTickets = 0;
  port = 0;

  constructor() {
    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server, path: '/v1/connect' });
    this.wss.on('connection', (ws) => {
      ws.once('message', (raw) => {
        const hello = JSON.parse(raw.toString()) as {
          t: string;
          ticket: string;
          session?: string;
          role?: string;
        };
        this.hellos.push(hello);
        if (this.rejectTickets > 0 && !hello.session && (hello as { client?: boolean }).client !== true) {
          this.rejectTickets -= 1;
          ws.close(4401, 'bad ticket');
          return;
        }
        if ((hello as { client?: boolean }).client) return this.client(ws);
        if (hello.session) return this.data(ws, hello.session);
        this.control = ws;
        ws.send(
          JSON.stringify({
            t: 'welcome',
            v: 1,
            conn: 'conn-appliance-1',
            heartbeatMs: 20000,
            maxMessage: 262144,
          }),
        );
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  private client(ws: WebSocket): void {
    const session = `sess-${String(++this.next).padStart(8, '0')}`;
    this.waiting.set(session, ws);
    this.control?.send(JSON.stringify({ t: 'incoming', session, class: 'interactive' }));
  }

  private data(ws: WebSocket, session: string): void {
    const client = this.waiting.get(session);
    if (!client) {
      ws.close(4404, 'unknown session');
      return;
    }
    this.waiting.delete(session);
    ws.send(
      JSON.stringify({ t: 'welcome', v: 1, conn: `conn-${session}`, heartbeatMs: 20000, maxMessage: 262144 }),
    );
    for (const end of [ws, client]) end.send(JSON.stringify({ t: 'ready' }));
    ws.on('message', (m, bin) => {
      if (bin) {
        this.forwarded.push(Buffer.from(m as Buffer));
        client.send(m, { binary: true });
      }
    });
    client.on('message', (m, bin) => {
      if (bin) {
        this.forwarded.push(Buffer.from(m as Buffer));
        ws.send(m, { binary: true });
      }
    });
    ws.on('close', () => client.close());
    client.on('close', () => ws.close());
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Opens a client through the relay; resolves once `ready` came. */
export async function relayClientSocket(relay: FakeRelay): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/connect`, 'whombat-relay.v1');
  await new Promise<void>((resolve) => ws.once('open', () => resolve()));
  ws.send(
    JSON.stringify({
      t: 'hello',
      v: 1,
      ticket: 'aaaaaaaaaaaaaaaa.bbbbbbbb.client',
      class: 'interactive',
      client: true,
    }),
  );
  await new Promise<void>((resolve) => {
    const onMessage = (m: WebSocket.RawData, bin: boolean) => {
      if (!bin && JSON.parse(m.toString()).t === 'ready') {
        ws.off('message', onMessage);
        resolve();
      }
    };
    ws.on('message', onMessage);
  });
  return ws;
}
