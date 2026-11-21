/**
 * The appliance's relay connections on a bad network path (open-speed.md OS-01, OS-02): a control connection that stops
 * answering pings is replaced, and a data connection that doesn't get `ready` gets a second dial beside it. Against a
 * minimal relay (hello → welcome, `incoming`, data connection → `ready`) with switches for what a bad path does.
 */
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { FakeManager } from '../testing';
import { RelayClient, ticketLabel } from './relay-client';

class Relay {
  server: Server = createServer();
  wss = new WebSocketServer({ server: this.server, path: '/v1/connect' });
  port = 0;
  controls: WebSocket[] = [];
  /** Data connections that said `hello`, by session. */
  dataHellos: string[] = [];
  /** The next `n` data connections get no answer at all (stuck on the way). */
  ignoreData = 0;
  /** The lease named in the control welcome (seconds), as a relay with leases does; null: an older relay. */
  lease: number | null = null;
  /** Tickets the box renewed with, and how the relay answers each (default: taken, with the same lease). */
  renews: string[] = [];
  renewAnswer: (ticket: string) => unknown = () => ({
    t: 'renewed',
    lease: { renewWithinS: this.lease ?? 0 },
  });
  /** Sessions the box refused, data connections' classes, and their sockets by session. */
  refused: string[] = [];
  dataClasses: string[] = [];
  private readonly data = new Map<string, WebSocket[]>();
  private readonly hellos = new Map<WebSocket, unknown>();
  private readonly binary = new Map<string, string>();
  private sockets = new Map<WebSocket, Socket>();

  constructor() {
    this.wss.on('connection', (ws, req) => {
      this.sockets.set(ws, req.socket);
      ws.once('message', (raw) => {
        const hello = JSON.parse(raw.toString()) as { session?: string; class?: string };
        this.hellos.set(ws, hello);
        if (hello.session) {
          const session = hello.session;
          this.dataHellos.push(session);
          this.dataClasses.push(String(hello.class));
          this.data.set(session, [...(this.data.get(session) ?? []), ws]);
          ws.on('close', () =>
            this.data.set(
              session,
              (this.data.get(session) ?? []).filter((w) => w !== ws),
            ),
          );
          ws.on('message', (m, isBinary) => {
            if (isBinary) this.binary.set(session, (this.binary.get(session) ?? '') + String(m));
          });
          if (this.ignoreData > 0) {
            this.ignoreData -= 1;
            return;
          }
          ws.send(
            JSON.stringify({ t: 'welcome', v: 1, conn: 'conn-data', heartbeatMs: 20000, maxMessage: 262144 }),
          );
          ws.send(JSON.stringify({ t: 'ready' }));
          return;
        }
        this.controls.push(ws);
        ws.on('message', (m) => {
          const msg = JSON.parse(m.toString()) as { t?: string; session?: string };
          if (msg.t === 'refuse' && msg.session) this.refused.push(msg.session);
          if (msg.t === 'renew') {
            const ticket = (msg as { ticket: string }).ticket;
            this.renews.push(ticket);
            ws.send(JSON.stringify(this.renewAnswer(ticket)));
          }
        });
        ws.send(
          JSON.stringify({
            t: 'welcome',
            v: 1,
            conn: 'conn-ctl',
            heartbeatMs: 20000,
            maxMessage: 262144,
            ...(this.lease === null ? {} : { lease: { renewWithinS: this.lease } }),
          }),
        );
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    return `ws://127.0.0.1:${this.port}/v1/connect`;
  }

  /** The newest control connection stops reading: its pings go unanswered, as on a bad path. */
  stallControl(): void {
    this.sockets.get(this.controls.at(-1) as WebSocket)?.pause();
  }

  helloOf(ws: WebSocket): unknown {
    return this.hellos.get(ws);
  }

  send(message: unknown): void {
    this.controls.at(-1)?.send(JSON.stringify(message));
  }

  dataOf(session: string): WebSocket | undefined {
    return this.data.get(session)?.at(-1);
  }

  dataSockets(session: string): number {
    return this.data.get(session)?.length ?? 0;
  }

  binaryFrom(session: string): string {
    return this.binary.get(session) ?? '';
  }

  incoming(session: string): void {
    this.controls.at(-1)?.send(JSON.stringify({ t: 'incoming', session, class: 'interactive' }));
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const log = { info() {}, warn() {}, debug() {}, error() {} } as never;

function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > end) return reject(new Error('timed out waiting'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

let relay: Relay;
let client: RelayClient | null = null;
afterEach(async () => {
  client?.stop();
  client = null;
  await relay?.close();
});

async function start(
  options: Partial<ConstructorParameters<typeof RelayClient>[0]> = {},
  setup: (relay: Relay, manager: FakeManager) => void = () => {},
) {
  relay = new Relay();
  const manager = new FakeManager();
  setup(relay, manager);
  manager.relayUrl = await relay.listen();
  const streams: unknown[] = [];
  client = new RelayClient({
    manager,
    log,
    accept: () => true,
    onStream: (s) => streams.push(s),
    backoff: { baseMs: 5, maxMs: 20 },
    ...options,
  });
  client.start();
  await until(() => client?.status === 'connected');
  return { client, streams, manager };
}

describe('the control connection (OS-01)', () => {
  it('is replaced when a ping goes unanswered, and incoming sessions reach the box again', async () => {
    const { client, streams } = await start({ livenessMs: 20, pongWaitMs: 60 });
    relay.stallControl();
    await until(() => relay.controls.length === 2);
    expect(client.stats.controlStalls).toBe(1);
    await until(() => client.status === 'connected');
    relay.incoming('sess-00000001');
    await until(() => streams.length === 1);
  });

  it('is kept while its pings are answered', async () => {
    const { client } = await start({ livenessMs: 10, pongWaitMs: 40 });
    await new Promise((r) => setTimeout(r, 200));
    expect(relay.controls).toHaveLength(1);
    expect(client.stats.controlStalls).toBe(0);
  });
});

describe('a data connection (OS-02)', () => {
  it('gets a second dial when the first gets no `ready`, and the session runs on that one', async () => {
    const { client, streams } = await start({ dataRaceAfterMs: 40 });
    relay.ignoreData = 1;
    relay.incoming('sess-00000001');
    await until(() => streams.length === 1);
    expect(relay.dataHellos).toEqual(['sess-00000001', 'sess-00000001']);
    expect(client.stats.dataRaces).toBe(1);
  });

  it('dials once when the relay answers in time', async () => {
    const { client, streams } = await start({ dataRaceAfterMs: 200 });
    relay.incoming('sess-00000001');
    await until(() => streams.length === 1);
    await new Promise((r) => setTimeout(r, 250));
    expect(relay.dataHellos).toEqual(['sess-00000001']);
    expect(client.stats.dataRaces).toBe(0);
  });
});

describe('door streams (own-address.md)', () => {
  /** A door port that takes what `classes` says, within `budget` streams, and keeps what it was handed. */
  function door(classes: ('web' | 'acme')[], budget = 8) {
    const got: { cls: string; src: string; stream: import('./relay-stream').RelayDuplex }[] = [];
    let open = 0;
    return {
      got,
      classes,
      get open() {
        return open;
      },
      port: {
        accepts: () => classes,
        admit: () => {
          if (open >= budget) return null;
          open += 1;
          let done = false;
          return () => {
            if (!done) open -= 1;
            done = true;
          };
        },
        onStream: (stream: import('./relay-stream').RelayDuplex, cls: string, src: string) =>
          got.push({ cls, src, stream }),
      },
    };
  }

  function lastHello(): { accepts?: string[] } {
    return relay.helloOf(relay.controls.at(-1) as WebSocket) as { accepts?: string[] };
  }

  it('declares no classes without an own address, and refuses a door stream without closing the control connection', async () => {
    const { client } = await start();
    expect(lastHello().accepts).toBeUndefined();
    relay.send({ t: 'incoming', session: 'sess-00000001', class: 'web', src: '203.0.113.7' });
    await until(() => relay.refused.includes('sess-00000001'));
    expect(client.stats.doorRefused).toBe(1);
    expect(relay.controls).toHaveLength(1);
  });

  it('refuses a class this version doesn’t know, and only that session', async () => {
    const d = door(['web', 'acme']);
    const { client, streams } = await start({ door: d.port });
    relay.send({ t: 'incoming', session: 'sess-00000002', class: 'carrier-pigeon' });
    await until(() => relay.refused.includes('sess-00000002'));
    relay.incoming('sess-00000003');
    await until(() => streams.length === 1);
    expect(relay.controls).toHaveLength(1);
    expect(client.status).toBe('connected');
  });

  it('hands a declared stream over as raw bytes with its source, data hello in the door class', async () => {
    const d = door(['web', 'acme']);
    await start({ door: d.port });
    expect(lastHello().accepts).toEqual(['web', 'acme']);
    relay.send({ t: 'incoming', session: 'sess-00000004', class: 'web', src: '2001:db8::1' });
    await until(() => d.got.length === 1);
    expect(d.got[0]).toMatchObject({ cls: 'web', src: '2001:db8::1' });
    expect(relay.dataClasses.at(-1)).toBe('web');
    const echoed = new Promise<string>((resolve) => d.got[0]?.stream.once('data', (b) => resolve(String(b))));
    relay.dataOf('sess-00000004')?.send(Buffer.from('client hello'), { binary: true });
    expect(await echoed).toBe('client hello');
    d.got[0]?.stream.write(Buffer.from('server hello'));
    await until(() => relay.binaryFrom('sess-00000004') === 'server hello');
    d.got[0]?.stream.destroy();
    await until(() => d.open === 0);
  });

  it('refuses a class it didn’t declare, a stream without a source address, and one past its budget', async () => {
    const d = door(['acme'], 1);
    const { client } = await start({ door: d.port });
    relay.send({ t: 'incoming', session: 'sess-00000005', class: 'web', src: '203.0.113.7' });
    relay.send({ t: 'incoming', session: 'sess-00000006', class: 'acme' });
    relay.send({ t: 'incoming', session: 'sess-00000007', class: 'acme', src: '203.0.113.8' });
    relay.send({ t: 'incoming', session: 'sess-00000008', class: 'acme', src: '203.0.113.9' });
    await until(() => relay.refused.length === 3);
    expect(relay.refused).toEqual(['sess-00000005', 'sess-00000006', 'sess-00000008']);
    await until(() => d.got.length === 1);
    expect(client.stats.doorRefused).toBe(3);
  });

  it('opens the control connection again, once, when what it declares changes', async () => {
    const d = door([]);
    const { client } = await start({ door: d.port });
    await client.refresh();
    expect(relay.controls).toHaveLength(1);
    d.classes.push('acme');
    await client.refresh();
    await until(() => relay.controls.length === 2 && client.status === 'connected');
    expect(lastHello().accepts).toEqual(['acme']);
    await client.refresh();
    expect(relay.controls).toHaveLength(2);
    expect(client.stats.redeclares).toBe(1);
  });

  it('opens it again when a fresh ticket starts carrying the label, and app sessions run on', async () => {
    const d = door(['acme']);
    const { client, streams } = await start({ door: d.port });
    relay.incoming('sess-00000009');
    await until(() => streams.length === 1);
    (client as unknown as { options: { manager: FakeManager } }).options.manager.ticketLabel =
      'maple-otter-river';
    await client.refresh(true);
    await until(() => relay.controls.length === 2 && client.status === 'connected');
    expect(relay.dataSockets('sess-00000009')).toBe(1);
    await client.refresh(true);
    expect(relay.controls).toHaveLength(2);
  });
});

describe('the lease (whombat-link.md)', () => {
  /** A relay with a 1 s lease, renewed 0.9 s ahead: the first renewal goes out about 100 ms after the welcome. */
  const fast = { renewAheadMs: 900, renewRetryMs: 50 };
  const withLease = (r: Relay) => {
    r.lease = 1;
  };

  it('is renewed in band with a fresh ticket, again and again, on the same connection', async () => {
    const { client, manager } = await start(fast, withLease);
    // The relay hears a renewal before the client has its answer: wait for both.
    await until(() => relay.renews.length >= 2 && client.stats.renewed >= 2);
    expect(relay.controls).toHaveLength(1);
    expect(new Set(relay.renews).size).toBe(relay.renews.length);
    expect(manager.tickets).toBeGreaterThanOrEqual(3);
    // The next data connection says hello with a ticket the relay renewed with.
    relay.incoming('sess-00000010');
    await until(() => relay.dataHellos.includes('sess-00000010'));
  });

  it('is never renewed on a relay that names no lease', async () => {
    const { client } = await start(fast);
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.renews).toEqual([]);
    expect(client.stats.renewsSent).toBe(0);
  });

  it('isn’t renewed with a ticket that expires no later than the one in use', async () => {
    const { client, manager } = await start(fast, (r, m) => {
      withLease(r);
      const ticket = m.ticket.bind(m);
      let first: Awaited<ReturnType<typeof ticket>> | null = null;
      m.ticket = async (cls) => {
        first ??= await ticket(cls);
        return first;
      };
    });
    await until(() => manager.tickets >= 1 && client.status === 'connected');
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.renews).toEqual([]);
  });

  it('tries again shortly after `stale`, `replayed` and `rate`, never with a refused ticket', async () => {
    let refusals = 3;
    const reasons = ['stale', 'replayed', 'rate'];
    const { client } = await start(fast, (r) => {
      r.lease = 2;
      r.renewAnswer = () =>
        refusals-- > 0
          ? { t: 'renew_refused', reason: reasons[2 - refusals], lease: { renewWithinS: 2 } }
          : { t: 'renewed', lease: { renewWithinS: 60 } };
    });
    await until(() => client.stats.renewed === 1);
    expect(client.stats.renewRefused).toBe(3);
    expect(relay.renews).toHaveLength(4);
    // `stale` and `replayed` tickets aren't sent again; `rate`'s may be.
    expect(relay.renews[1]).not.toBe(relay.renews[0]);
    expect(relay.renews[2]).not.toBe(relay.renews[1]);
    expect(relay.controls).toHaveLength(1);
  });

  it('connects again, at once, when the renewal’s ticket names another worker', async () => {
    const { client } = await start(fast, (r) => {
      withLease(r);
      r.renewAnswer = () => ({ t: 'renew_refused', reason: 'wrong_worker', lease: { renewWithinS: 1 } });
    });
    await until(() => relay.controls.length === 2 && client.status === 'connected');
    expect(client.stats.redeclares).toBe(1);
  });

  it('tries once more with a new ticket after any other refusal, then leaves it to the relay', async () => {
    const { client } = await start({ ...fast, renewRetryMs: 5_000 }, (r) => {
      r.lease = 2;
      r.renewAnswer = () => ({ t: 'renew_refused', reason: 'bad_signature', lease: { renewWithinS: 2 } });
    });
    await until(() => relay.renews.length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.renews).toHaveLength(2);
    expect(relay.renews[1]).not.toBe(relay.renews[0]);
    expect(client.stats.renewRefused).toBe(2);
    expect(relay.controls).toHaveLength(1);
  });

  it('takes a new label in a renewal instead of opening the connection again; a new door class still reconnects', async () => {
    const classes: ('web' | 'acme')[] = ['acme'];
    const door = { accepts: () => classes, admit: () => () => {}, onStream: () => {} };
    const { client, manager } = await start({ door, renewAheadMs: 0 }, (r) => {
      r.lease = 60;
    });
    manager.ticketLabel = 'maple-otter-river';
    await client.refresh(true);
    await until(() => client.stats.renewed === 1);
    expect(relay.controls).toHaveLength(1);
    expect(relay.renews).toHaveLength(1);
    expect(ticketLabel(relay.renews[0] as string)).toBe('maple-otter-river');
    await client.refresh(true);
    expect(relay.renews).toHaveLength(1);
    classes.push('web');
    await client.refresh();
    await until(() => relay.controls.length === 2 && client.status === 'connected');
    expect(client.stats.redeclares).toBe(1);
  });

  it('opens the connection again when a renewal for a new label is refused', async () => {
    const door = { accepts: () => ['acme' as const], admit: () => () => {}, onStream: () => {} };
    const { client, manager } = await start({ door, renewAheadMs: 0 }, (r) => {
      r.lease = 60;
      r.renewAnswer = () => ({ t: 'renew_refused', reason: 'stale', lease: { renewWithinS: 60 } });
    });
    manager.ticketLabel = 'maple-otter-river';
    await client.refresh(true);
    await until(() => relay.controls.length === 2 && client.status === 'connected');
    expect(ticketLabel((relay.helloOf(relay.controls[1] as WebSocket) as { ticket: string }).ticket)).toBe(
      'maple-otter-river',
    );
  });

  it('reconnects with a fresh ticket when the relay ends the lease', async () => {
    const { client, manager } = await start({ renewAheadMs: 0 }, (r) => {
      r.lease = 60;
    });
    const before = manager.tickets;
    relay.controls[0]?.close(4401, 'lease');
    await until(() => relay.controls.length === 2 && client.status === 'connected');
    expect(manager.tickets).toBeGreaterThan(before);
  });
});

describe('ticketLabel', () => {
  it('reads `lbl` from the payload and nothing else', () => {
    const payload = Buffer.from(JSON.stringify({ lbl: 'maple-otter-river', apl: 'x' })).toString('base64url');
    expect(ticketLabel(`aaaa.${payload}.cccc`)).toBe('maple-otter-river');
    expect(ticketLabel(`aaaa.${Buffer.from('{}').toString('base64url')}.cccc`)).toBeNull();
    expect(ticketLabel('aaaa.!!!.cccc')).toBeNull();
    expect(ticketLabel('nothing')).toBeNull();
  });
});
