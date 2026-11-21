/**
 * The session endpoint end to end (MA-05, MA-07, MA-08): a fake relay (WebSocket, relay protocol v1: hello →
 * welcome → incoming → data connection → ready → opaque binary), the appliance's relay client, the real Noise XX
 * responder (`@whombat/secure-channel`, the content key), and a client that pins the appliance PeerId, runs the
 * initiator and speaks the session protocol. Also: a client pinning another PeerId never gets a session, the
 * relay only ever forwards ciphertext, and the control connection reconnects with a fresh ticket after 4401.
 */
import { encodeFrame, FrameDecoder } from '@whombat/protocol';
import { decodeApplianceMessage, encodeSessionMessage, SESSION_PROTOCOL } from '@whombat/protocol/session';
import { generateIdentity, openInitiator, secureByteStream } from '@whombat/secure-channel';
import { nodeWebSocketByteStream } from '@whombat/secure-channel/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeRelay, relayClientSocket } from '../test/fake-relay';
import { useTestServer } from '../test/harness';
import { ManagedRuntime } from './runtime';
import { SessionEndpoint } from './session/endpoint';
import { secureResponder } from './session/secure';
import { FakeManager } from './testing';

const t = useTestServer();
// The box's content key, made for this run.
const identity = await generateIdentity();

const relay = new FakeRelay();
const manager = new FakeManager();
let runtime: ManagedRuntime;
let endpoint: SessionEndpoint;

beforeAll(async () => {
  await relay.listen();
  manager.relayUrl = `ws://127.0.0.1:${relay.port}/v1/connect`;
  runtime = new ManagedRuntime(t.services, { manager, appliancePeerId: identity.peerId });
  await runtime.start();
  endpoint = new SessionEndpoint(runtime, secureResponder(identity), manager, {
    backoff: { baseMs: 20, maxMs: 100 },
  });
  endpoint.start();
  const deadline = Date.now() + 5000;
  while (endpoint.status().relay !== 'connected' && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
});

afterAll(async () => {
  await endpoint.stop();
  await runtime.close();
  await relay.close();
});

const clientSocket = () => relayClientSocket(relay);

describe('the session endpoint through a relay', () => {
  it('runs the real Noise handshake with the pinned appliance identity and serves the session protocol', async () => {
    expect(manager.classes[0]).toBe('interactive');
    const ws = await clientSocket();
    const me = await generateIdentity();
    const conn = await openInitiator({
      stream: nodeWebSocketByteStream(ws as never),
      identity: me,
      expectedAppliancePeerId: identity.peerId,
    });
    const bytes = secureByteStream(conn);
    const decoder = new FrameDecoder();
    const hello = encodeSessionMessage({
      t: 'hello',
      versions: [SESSION_PROTOCOL],
      capabilities: ['events', 'enroll'],
      client: { build: 'test', platform: 'web' },
    });
    bytes.write(encodeFrame({ type: 'control', streamId: 0, payload: hello }));
    let welcome: unknown = null;
    while (!welcome) {
      const chunk = await bytes.read();
      if (!chunk) break;
      for (const f of decoder.push(chunk))
        if (f.type === 'control') welcome = decodeApplianceMessage(f.payload);
    }
    expect(welcome).toMatchObject({
      ok: true,
      message: { t: 'welcome', appliance: identity.peerId, channel: 'enroll', principal: null },
    });
    // The relay only saw ciphertext: no frame header or JSON of ours in anything it forwarded.
    const seen = Buffer.concat(relay.forwarded).toString('latin1');
    expect(seen).not.toContain('"t":"hello"');
    expect(seen).not.toContain('welcome');
    await bytes.close();
  });

  it('never gives a session to a client that pinned another appliance', async () => {
    const ws = await clientSocket();
    const me = await generateIdentity();
    const other = await generateIdentity();
    await expect(
      openInitiator({
        stream: nodeWebSocketByteStream(ws as never),
        identity: me,
        expectedAppliancePeerId: other.peerId,
      }),
    ).rejects.toThrow();
  });

  it('reconnects the control connection with a fresh ticket after the relay refuses one (4401)', async () => {
    const before = manager.tickets;
    relay.rejectTickets = 1;
    relay.control?.close(4401, 'expired');
    const deadline = Date.now() + 5000;
    while (manager.tickets < before + 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    while (endpoint.status().relay !== 'connected' && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(manager.tickets).toBeGreaterThanOrEqual(before + 2);
    expect(endpoint.status().relay).toBe('connected');
  });
});
