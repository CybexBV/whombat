/**
 * End to end through real cryptography (`@whombat/secure-channel`, Node): the client session's connector runs
 * the Noise XX initiator pinned to the appliance identity over an in-memory byte stream; the appliance side is
 * a real responder serving the fake appliance through `secureByteStream`.
 */

import { api } from '@whombat/core/contracts';
import {
  acceptResponder,
  type ByteStream,
  fingerprint,
  generateIdentity,
  type Identity,
  memoryByteStreamPair,
} from '@whombat/secure-channel';
import { afterEach, describe, expect, it } from 'vitest';
import { secureWire } from './connector';
import { createFakeAppliance } from './fake';
import { createSecureSession } from './secure';
import { secureChannelPort } from './secure-channel';
import { type ApplianceSession, OutcomeUnknownError } from './types';
import { ConnectError, type SessionConnector } from './wire';

const live: ApplianceSession[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.close();
});

async function world(pin: (appliance: Identity) => { peerId: string } | { fingerprint: string }) {
  const applianceKey = await generateIdentity();
  const clientKey = await generateIdentity();
  const fake = createFakeAppliance({
    applianceId: applianceKey.peerId,
    handle: async (op) =>
      op === 'health.get' ? { status: 200, body: { ok: true } } : { status: 200, body: {} },
    resources: async () => ({
      meta: { contentType: 'text/plain', size: 300_000, name: 'big.txt', sha256: null },
      bytes: new Uint8Array(300_000).fill(97),
    }),
  });
  const port = secureChannelPort();
  const target = pin(applianceKey);
  const connector: SessionConnector = {
    async connect() {
      const [clientBytes, applianceBytes] = memoryByteStreamPair();
      void acceptResponder({ stream: applianceBytes, identity: applianceKey })
        .then((conn) =>
          fake.serve(port.secureByteStream(conn), { endpointId: clientKey.peerId, channel: 'app' }),
        )
        .catch(() => {});
      try {
        const conn = await port.openInitiator({
          stream: clientBytes,
          identity: clientKey,
          ...('peerId' in target
            ? { expectedAppliancePeerId: target.peerId }
            : { expectedApplianceFingerprint: target.fingerprint }),
        });
        return secureWire(conn, port.secureByteStream(conn));
      } catch (error) {
        if ((error as { code?: string }).code === 'PEER_MISMATCH')
          throw new ConnectError('identity_mismatch');
        throw new ConnectError('lost', String(error));
      }
    },
  };
  const session = createSecureSession({ connector, backoff: { initialMs: 5, maxMs: 20 } });
  live.push(session);
  return { session, fake, applianceKey };
}

describe('secure session over real Noise (secure-channel 0.3)', () => {
  it('pins the appliance PeerId, then requests, downloads and uploads through the channel', async () => {
    const { session, applianceKey } = await world((a) => ({ peerId: a.peerId }));
    const r = await session.call(api.health.get, { params: {}, query: {}, body: undefined });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    const s = session.state();
    expect(s.status === 'open' && s.info.appliance.id).toBe(applianceKey.peerId);

    const stream = await session.openResource({ kind: 'attachment', burrow: 'b', attachmentId: 'att_big' });
    let size = 0;
    for await (const c of stream.chunks) size += c.byteLength;
    expect(size).toBe(300_000);
  });

  it('accepts the claim-card fingerprint as the pin', async () => {
    const { session } = await world((a) => ({ fingerprint: fingerprint(a.peerId) }));
    const r = await session.call(api.health.get, { params: {}, query: {}, body: undefined });
    expect(r.status).toBe(200);
  });

  it('after a lost answer, a fresh Noise session asks status: kept outcomes return, nothing runs twice (CT-194)', async () => {
    const { session, fake } = await world((a) => ({ peerId: a.peerId }));
    const send = { params: { burrow: 'b', conversationId: 'c' }, query: {}, body: { text: 'once' } };
    await session.call(api.health.get, { params: {}, query: {}, body: undefined });
    // Committed, answer lost with the connection: recovered from the receipt.
    fake.faults.loseResults(1);
    const r = await session.call(api.messages.send, send, { requestId: 'req_noise_send_0123' });
    expect(r).toMatchObject({ status: 200, requestId: 'req_noise_send_0123' });
    // Acted before a commit the dropped session cancelled: never sent again.
    fake.faults.loseBeforeCommit(1);
    const create = { params: { burrow: 'b' }, query: {}, body: { name: 'Whombat_Website' } };
    await expect(
      session.call(api.repos.create, create, { requestId: 'req_noise_repo_0123' }),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    const stats = fake.stats();
    expect(stats.statusAsked).toEqual(['req_noise_send_0123', 'req_noise_repo_0123']);
    expect(stats.attempts.slice(1).map((a) => a.id)).toEqual(['req_noise_send_0123', 'req_noise_repo_0123']);
    expect(stats.executed.get('messages.send')).toBe(1);
    expect(stats.executed.get('repos.create')).toBe(1);
  });

  it('refuses a different appliance before sending anything', async () => {
    const other = await generateIdentity();
    const { session, fake } = await world(() => ({ peerId: other.peerId }));
    session.connect();
    await new Promise<void>((resolve) => {
      const off = session.onState((s) => {
        if (s.status === 'closed') {
          off();
          resolve();
        }
      });
    });
    expect(session.state()).toMatchObject({ status: 'closed', reason: 'identity_mismatch' });
    expect(fake.stats().requestsSeen).toEqual([]);
    expect(fake.stats().lastHello).toBeNull();
  });
});

describe('a relay that replays the welcome record (0.5.1 integration report)', () => {
  it('the connection fails, the session reconnects, and requests are delivered — no 30 s wedge', async () => {
    const applianceKey = await generateIdentity();
    const clientKey = await generateIdentity();
    const fake = createFakeAppliance({
      applianceId: applianceKey.peerId,
      handle: async () => ({ status: 200, body: { ok: true } }),
    });
    const port = secureChannelPort();
    const replayed: number[] = [];
    let connections = 0;
    /** A splice between two in-memory byte stream pairs that delivers appliance→client message `nth` twice. */
    function relay(nth: number | null) {
      const [client, relayClient] = memoryByteStreamPair();
      const [relayAppliance, appliance] = memoryByteStreamPair();
      const pump = async (from: ByteStream, to: ByteStream, toClient: boolean) => {
        let i = 0;
        try {
          for (;;) {
            const chunk = await from.read();
            if (chunk === null) return void (await to.close());
            i += 1;
            if (!to.write(chunk)) await to.drained();
            if (toClient && i === nth) {
              replayed.push(chunk.byteLength);
              to.write(chunk);
            }
          }
        } catch (error) {
          to.abort(error as Error);
        }
      };
      void pump(relayClient, relayAppliance, false);
      void pump(relayAppliance, relayClient, true);
      return { client, appliance };
    }
    const connector: SessionConnector = {
      async connect() {
        connections += 1;
        // secure-session/2: appliance→client #1 is Noise message 2, #2 the WINDOW grant, #3 the welcome.
        const { client, appliance } = relay(connections === 1 ? 3 : null);
        void acceptResponder({ stream: appliance, identity: applianceKey })
          .then((conn) =>
            fake.serve(port.secureByteStream(conn), { endpointId: clientKey.peerId, channel: 'app' }),
          )
          .catch(() => {});
        const conn = await port.openInitiator({
          stream: client,
          identity: clientKey,
          expectedAppliancePeerId: applianceKey.peerId,
        });
        return secureWire(conn, port.secureByteStream(conn));
      },
    };
    const session = createSecureSession({ connector, backoff: { initialMs: 5, maxMs: 20 } });
    live.push(session);
    const states: string[] = [];
    session.onState((st) => states.push(st.status));
    const call = () => session.call(api.health.get, { params: {}, query: {}, body: undefined });
    const results = await Promise.race([
      Promise.all([call(), call(), call()]),
      new Promise<'wedged'>((resolve) => setTimeout(() => resolve('wedged'), 3000)),
    ]);
    expect(replayed).toHaveLength(1);
    expect(results).not.toBe('wedged');
    expect(results).toMatchObject([{ status: 200 }, { status: 200 }, { status: 200 }]);
    expect(connections).toBe(2);
    expect(states).toContain('reconnecting');
  });
});
