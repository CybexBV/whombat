/**
 * The direct connection end to end (hermes-engine.md HE-50, HE-51; direct-connection.md): the box's direct listener on
 * loopback, the real Noise XX responder with the content key, and a client that opens the direct WebSocket, says hello,
 * pins the box's PeerId and speaks the session protocol — next to the same client through a fake relay. Postgres: the
 * box admits a client from the endpoint rows of its database (enrolled, revoked, unknown), development enrolment claims
 * the box and enrols in one transaction, and Tailscale's state and certificate come from the (fake) manager.
 */
import { readFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { bytesToHex } from '@whombat/core';
import { encodeFrame, FrameDecoder } from '@whombat/protocol';
import { DIRECT_SUBPROTOCOL } from '@whombat/protocol/direct';
import {
  type ApplianceMessage,
  type ClientMessage,
  decodeApplianceMessage,
  encodeSessionMessage,
  SESSION_PROTOCOL,
} from '@whombat/protocol/session';
import {
  type ByteStream,
  generateIdentity,
  type Identity,
  openInitiator,
  secureByteStream,
} from '@whombat/secure-channel';
import { nodeWebSocketByteStream } from '@whombat/secure-channel/node';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { applianceEndpoints, applianceState, principals } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { FakeRelay, relayClientSocket } from '../test/fake-relay';
import { useTestServer } from '../test/harness';
import { localId } from './audit';
import { directAddresses } from './direct/routes';
import { TailscaleService } from './direct/tailscale';
import { PASSKEYS_UNAVAILABLE_HERE } from './direct/transport';
import { ManagedRuntime } from './runtime';
import { SessionEndpoint } from './session/endpoint';
import { secureResponder } from './session/secure';
import { FakeManager } from './testing';

const t = useTestServer({ seed: true, env: { WHOMBAT_MODE: 'managed' } });
// The box's content key, made for this run.
const box = await generateIdentity();
const PEM = readFileSync(
  join(import.meta.dirname, 'direct', '__fixtures__', 'tailscale-cert-pair.pem'),
  'utf8',
);
const relay = new FakeRelay();
const manager = new FakeManager();
let runtime: ManagedRuntime;
let endpoint: SessionEndpoint;
let tailscale: TailscaleService;
const direct = { hosts: ['127.0.0.1'], interfaces: ['loopback'], port: 0, development: false };

beforeAll(async () => {
  await relay.listen();
  manager.relayUrl = `ws://127.0.0.1:${relay.port}/v1/connect`;
  runtime = new ManagedRuntime(t.services, { manager, appliancePeerId: box.peerId });
  await runtime.start();
  tailscale = new TailscaleService(manager, t.services.log);
  runtime.dispatcher.tailscale = tailscale;
  manager.tailscale.pair = {
    keyPem: PEM.slice(0, PEM.indexOf('-----BEGIN CERTIFICATE-----')),
    certPem: PEM.slice(PEM.indexOf('-----BEGIN CERTIFICATE-----')),
  };
  endpoint = new SessionEndpoint(runtime, secureResponder(box), manager, {
    backoff: { baseMs: 20, maxMs: 100 },
    direct: {
      ...direct,
      hostnames: () => tailscale.hostnames(),
      tls: (name) => tailscale.certificate(name),
    },
  });
  endpoint.start();
  expect(await endpoint.startDirect()).toBe(true);
  runtime.direct = {
    tailscale,
    addresses: () =>
      directAddresses({
        port: endpoint.direct?.boundPort() ?? 0,
        interfaces: direct.interfaces,
        tailscale: tailscale.last,
      }),
  };
  const deadline = Date.now() + 5000;
  while (endpoint.status().relay !== 'connected' && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
});

afterAll(async () => {
  await endpoint.stop();
  await runtime.close();
  await relay.close();
});

/** The direct WebSocket after the box's welcome, as a byte stream. */
async function directSocket(options: { port?: number; origin?: string } = {}): Promise<ByteStream> {
  const port = options.port ?? endpoint.direct?.boundPort();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/direct`, DIRECT_SUBPROTOCOL, {
    ...(options.origin ? { origin: options.origin } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return new Promise<ByteStream>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData, bin: boolean) => {
      if (bin || JSON.parse(raw.toString()).t !== 'welcome') return reject(new Error('no welcome'));
      ws.off('message', onMessage);
      resolve(nodeWebSocketByteStream(ws as never));
    };
    ws.on('message', onMessage);
    ws.once('close', (code) => reject(new Error(`closed ${code}`)));
    ws.send(JSON.stringify({ t: 'hello', v: 1, class: 'interactive' }));
  });
}

const relayStream = async (): Promise<ByteStream> =>
  nodeWebSocketByteStream((await relayClientSocket(relay)) as never);

let requests = 0;

/** A session client over a byte stream: Noise with the box's PeerId pinned, then CONTROL messages. */
class Client {
  readonly received: ApplianceMessage[] = [];
  ended = false;
  private waiters: {
    pred: (m: ApplianceMessage) => boolean;
    resolve: (m: ApplianceMessage | null) => void;
  }[] = [];

  private constructor(private readonly bytes: ReturnType<typeof secureByteStream>) {
    void this.pump();
  }

  static async open(stream: ByteStream, me: Identity): Promise<Client> {
    const conn = await openInitiator({ stream, identity: me, expectedAppliancePeerId: box.peerId });
    return new Client(secureByteStream(conn));
  }

  private async pump(): Promise<void> {
    const decoder = new FrameDecoder();
    for (;;) {
      const chunk = await this.bytes.read().catch(() => null);
      if (!chunk) break;
      for (const f of decoder.push(chunk)) {
        if (f.type !== 'control') continue;
        const d = decodeApplianceMessage(f.payload);
        if (!d.ok) continue;
        this.received.push(d.message);
        for (const w of [...this.waiters])
          if (w.pred(d.message)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(d.message);
          }
      }
    }
    this.ended = true;
    for (const w of this.waiters.splice(0)) w.resolve(null);
  }

  send(message: ClientMessage): void {
    this.bytes.write(encodeFrame({ type: 'control', streamId: 0, payload: encodeSessionMessage(message) }));
  }

  waitFor(pred: (m: ApplianceMessage) => boolean): Promise<ApplianceMessage | null> {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }

  hello(): Promise<ApplianceMessage | null> {
    this.send({
      t: 'hello',
      versions: [SESSION_PROTOCOL],
      capabilities: ['events', 'enroll'],
      client: { build: 'test', platform: 'web' },
    });
    return this.waitFor((m) => m.t === 'welcome' || m.t === 'error');
  }

  request(op: string, input: unknown): Promise<ApplianceMessage | null> {
    // Unique across clients: a device's receipts are per key, op and id (CS-04).
    const id = `req_direct_${String(++requests).padStart(12, '0')}`;
    this.send({ t: 'request', id, op, input: input as never, deadlineMs: 10_000 });
    return this.waitFor((m) => (m.t === 'result' || m.t === 'error') && (m as { id?: string }).id === id);
  }

  async close(): Promise<void> {
    await this.bytes.close().catch(() => {});
  }
}

/** Enrols a device key for a seeded person (fixture shortcut, not a ceremony). */
async function enrol(me: Identity, principalId: string): Promise<{ endpointId: string; accountId: string }> {
  const db = t.services.db;
  const [p] = await db.select().from(principals).where(eq(principals.id, principalId));
  if (!p?.accountId) throw new Error(`no account for ${principalId}`);
  const endpointId = localId('ep');
  await db.insert(applianceEndpoints).values({
    id: endpointId,
    peerId: me.peerId,
    publicKey: bytesToHex(me.publicKey),
    accountId: p.accountId,
    label: 'Laptop',
    platform: 'web',
    enrolledVia: 'pairing',
  });
  return { endpointId, accountId: p.accountId };
}

/** What a session's welcome says that doesn't depend on the connection. */
const sameness = (w: ApplianceMessage | null) => {
  const { serverTime: _t, clearCache: _c, ...rest } = w as Extract<ApplianceMessage, { t: 'welcome' }>;
  return rest;
};

describe('the direct connection', () => {
  it('admits an enrolled device and gives it the same session as through the relay', async () => {
    const laptop = await generateIdentity();
    const { endpointId, accountId } = await enrol(laptop, IDS.mara);
    const viaDirect = await Client.open(await directSocket(), laptop);
    const viaRelay = await Client.open(await relayStream(), laptop);
    const directWelcome = await viaDirect.hello();
    const relayWelcome = await viaRelay.hello();
    expect(directWelcome).toMatchObject({
      t: 'welcome',
      appliance: box.peerId,
      channel: 'app',
      endpointId,
      principal: { accountId },
      direct: { port: endpoint.direct?.boundPort(), routes: [] },
    });
    expect(sameness(directWelcome)).toEqual(sameness(relayWelcome));
    const listed = async (c: Client) =>
      (
        (await c.request('endpoints.list', {})) as unknown as {
          output: { endpoints: { endpointId: string }[] };
        }
      ).output.endpoints
        .map((e) => e.endpointId)
        .sort();
    expect(await listed(viaDirect)).toEqual(await listed(viaRelay));
    expect(await listed(viaDirect)).toContain(endpointId);
    await viaDirect.close();
    await viaRelay.close();
  });

  it('gives a key it doesn’t know the enroll channel, in a class of its own, one per address', async () => {
    const stranger = await generateIdentity();
    const viaDirect = await Client.open(await directSocket(), stranger);
    expect(await viaDirect.hello()).toMatchObject({
      t: 'welcome',
      channel: 'enroll',
      principal: null,
      direct: null,
    });
    expect(runtime.sessions.unenrolledDirectSize).toBe(1);
    expect(runtime.sessions.unenrolledSize).toBe(0);
    // A second unenrolled key from the same address waits its turn.
    const second = await Client.open(await directSocket(), await generateIdentity());
    expect(await second.hello()).toMatchObject({ t: 'error', code: 'too_many' });
    // The relay's unenrolled class is its own.
    const viaRelay = await Client.open(await relayStream(), stranger);
    expect(await viaRelay.hello()).toMatchObject({ t: 'welcome', channel: 'enroll' });
    await viaRelay.close();
    // Leaving without enrolling counts against the address.
    const failures = endpoint.status().direct?.stats.failures ?? 0;
    await viaDirect.close();
    const deadline = Date.now() + 5000;
    while ((endpoint.status().direct?.stats.failures ?? 0) === failures && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(endpoint.status().direct?.stats.failures).toBe(failures + 1);
    expect(runtime.sessions.unenrolledDirectSize).toBe(0);
  });

  it('never counts it against a device’s address when new letters asked for at the box end its session', async () => {
    const failures = () => endpoint.status().direct?.stats.failures ?? 0;
    const before = failures();
    // The person's phone, waiting on the claim screen, each time they ask for new letters.
    for (let i = 0; i < 3; i++) {
      const phone = await Client.open(await directSocket(), await generateIdentity());
      expect(await phone.hello()).toMatchObject({ t: 'welcome', channel: 'enroll' });
      expect(await runtime.sessions.closeUnclaimedSetups()).toBe(1);
      expect(await phone.waitFor(() => false)).toBeNull();
      expect(phone.ended).toBe(true);
    }
    expect(runtime.sessions.unenrolledDirectSize).toBe(0);
    // Its place is free again, and its address is neither charged nor turned away.
    expect(failures()).toBe(before);
    expect(endpoint.direct?.guard.locked('127.0.0.1')).toBe(false);
    const again = await Client.open(await directSocket(), await generateIdentity());
    expect(await again.hello()).toMatchObject({ t: 'welcome', channel: 'enroll' });
    await again.close();
  });

  it('tells a removed device so, as the relay does', async () => {
    const old = await generateIdentity();
    const { endpointId } = await enrol(old, IDS.mara);
    await t.services.db
      .update(applianceEndpoints)
      .set({ revokedAt: new Date() })
      .where(eq(applianceEndpoints.id, endpointId));
    const viaDirect = await Client.open(await directSocket(), old);
    expect(await viaDirect.hello()).toMatchObject({ t: 'error', code: 'revoked' });
    const viaRelay = await Client.open(await relayStream(), old);
    expect(await viaRelay.hello()).toMatchObject({ t: 'error', code: 'revoked' });
  });

  it('never gives a session to a client that pinned another box', async () => {
    const me = await generateIdentity();
    const other = await generateIdentity();
    await expect(
      openInitiator({ stream: await directSocket(), identity: me, expectedAppliancePeerId: other.peerId }),
    ).rejects.toThrow();
  });

  it('says a page the box serves can’t run a passkey ceremony, where the app can', async () => {
    const laptop = await generateIdentity();
    await enrol(laptop, IDS.mara);
    const port = endpoint.direct?.boundPort();
    const page = await Client.open(await directSocket({ origin: `http://127.0.0.1:${port}` }), laptop);
    expect(await page.hello()).toMatchObject({ t: 'welcome', channel: 'app' });
    expect(await page.request('passkey.register.begin', {})).toMatchObject({
      t: 'error',
      code: 'forbidden',
      details: { code: PASSKEYS_UNAVAILABLE_HERE },
    });
    const native = await Client.open(await directSocket(), laptop);
    await native.hello();
    expect(await native.request('passkey.register.begin', {})).toMatchObject({ t: 'result' });
    await page.close();
    await native.close();
  });
});

/** A session's answer's `output` (a `result`), or the whole answer. */
const output = (m: unknown) => (m as { output?: unknown }).output ?? m;

describe('Tailscale for This Whombat', () => {
  it('goes through the manager: sign in with Tailscale’s link, on, the name served over HTTPS, off', async () => {
    const owner = await generateIdentity();
    await enrol(owner, IDS.mara);
    const mara = await Client.open(await directSocket(), owner);
    await mara.hello();
    expect(output(await mara.request('host.tailscale', {}))).toMatchObject({ tailscale: { state: 'off' } });
    expect(output(await mara.request('host.tailscale.on', {}))).toMatchObject({
      tailscale: {
        state: 'needs_sign_in',
        loginUrl: expect.stringMatching(/^https:[/][/]login[.]tailscale[.]com[/]/),
      },
    });
    manager.tailscale.completeSignIn();
    expect(output(await mara.request('host.tailscale', {}))).toMatchObject({
      tailscale: { state: 'on', name: manager.tailscale.name, https: true },
    });
    // The box answers on its Tailscale name with the certificate the manager handed over.
    const port = endpoint.direct?.boundPort() ?? 0;
    const cn = await new Promise<string>((resolve, reject) =>
      httpsGet(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/direct',
          servername: manager.tailscale.name,
          rejectUnauthorized: false,
          headers: { host: `${manager.tailscale.name}:${port}` },
        },
        (res) => {
          resolve(String((res.socket as TLSSocket).getPeerCertificate().subject?.CN ?? ''));
          res.resume();
        },
      ).on('error', reject),
    );
    expect(cn).toBe(manager.tailscale.name);
    expect(output(await mara.request('host.tailscale.off', { signOut: true }))).toMatchObject({
      tailscale: { state: 'off' },
    });
    expect(manager.tailscale.calls).toContain('off+signOut');
    expect(tailscale.hostnames()).toEqual([]);
    await mara.close();
  });
});

describe('development enrolment', () => {
  it('lets a browser on this machine in over a direct loopback session, only in development', async () => {
    const enrolDev = (c: Client, email: string) =>
      c.request('enroll.dev', {
        account: { name: 'Dev', email },
        endpoint: { label: 'Browser here', platform: 'web' },
      });
    const refused = { t: 'error', code: 'forbidden', details: { code: 'dev_only' } };
    // Not in development: refused on the very session it would work on.
    const browser = await generateIdentity();
    const early = await Client.open(await directSocket(), browser);
    expect(await early.hello()).toMatchObject({ t: 'welcome', channel: 'enroll' });
    expect(await enrolDev(early, 'mara@burrowhq.example')).toMatchObject(refused);
    await early.close();
    const config = t.services.config as { NODE_ENV: string };
    config.NODE_ENV = 'development';
    try {
      // Through the relay: refused, a development runtime answers only on its own machine.
      const viaRelay = await Client.open(await relayStream(), browser);
      await viaRelay.hello();
      expect(await enrolDev(viaRelay, 'mara@burrowhq.example')).toMatchObject(refused);
      await viaRelay.close();
      // The seeded person's email: her account, and the unclaimed box claimed for it.
      const here = await Client.open(await directSocket(), browser);
      await here.hello();
      expect(await enrolDev(here, 'mara@burrowhq.example')).toMatchObject({
        t: 'result',
        output: { endpoint: { peerId: browser.peerId } },
      });
      const [state] = await t.services.db.select().from(applianceState);
      expect(state?.claimConsumedAt).not.toBeNull();
      const [row] = await t.services.db
        .select()
        .from(applianceEndpoints)
        .where(eq(applianceEndpoints.peerId, browser.peerId));
      expect(row?.enrolledVia).toBe('dev');
      // The same key again: already enrolled. Its next session is the app's, told the box's ways in.
      expect(await enrolDev(here, 'mara@burrowhq.example')).toMatchObject({
        t: 'error',
        details: { code: 'endpoint_enrolled' },
      });
      await here.close();
      const session = await Client.open(await directSocket(), browser);
      expect(await session.hello()).toMatchObject({
        t: 'welcome',
        channel: 'app',
        principal: { accountId: expect.any(String) },
        direct: { port: endpoint.direct?.boundPort(), lan: [], tailscale: null, routes: [] },
      });
      await session.close();
      // Another email once the Whombat has its person: still the person's account (one-person.md OP-S12).
      const second = await Client.open(await directSocket(), await generateIdentity());
      await second.hello();
      const answer = await enrolDev(second, 'dev@whombat.localhost');
      expect(answer).toMatchObject({ t: 'result' });
      expect((answer as unknown as { output: { accountId: string } }).output.accountId).toBe(
        state?.claimedByAccountId,
      );
      await second.close();
    } finally {
      config.NODE_ENV = 'test';
    }
  });
});
