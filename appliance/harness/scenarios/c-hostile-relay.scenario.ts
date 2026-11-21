/**
 * (c) Hostile relay (assignment §14.3/§14.4, MA-05/MA-07): a relay that tampers, replays or substitutes the
 * appliance. The client must refuse, and no plaintext may reach the relay: every byte the (hostile) relay sees is
 * scanned for known plaintext of the session. Real control tickets, real relay upstream, real runtime, real client.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApplianceSession,
  type ConnectionState,
  openSession,
  sessionOps,
  whenOpen,
  whenState,
} from '../src/scenario-kit/app-client.ts';
import { type HostileRelay, startHostileRelay } from '../src/scenario-kit/hostile-relay.ts';
import { gap, note } from '../src/scenario-kit/report.ts';
import { ensureSlice, identityOf, type SliceState } from '../src/scenario-kit/slice.ts';
import { collect } from '../src/scenario-kit/work.ts';
import { claimCard, env, persona, ticketSource } from '../src/scenario-kit/world.ts';

let slice: SliceState;
let hostile: HostileRelay;

beforeAll(async () => {
  slice = await ensureSlice();
  hostile = await startHostileRelay(env().relay?.url ?? '');
});
afterAll(async () => hostile?.close());

async function sessionVia(h: HostileRelay): Promise<{ s: ApplianceSession; states: ConnectionState[] }> {
  const owner = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
  const s = openSession({
    tickets: ticketSource(owner, slice.deviceId, h.url),
    identity: identityOf(slice),
    appliance: { peerId: slice.peerId },
    channel: 'app',
    backoff: { baseMs: 100, maxMs: 500 },
  });
  const states: ConnectionState[] = [];
  s.onState((x) => states.push(x));
  return { s, states };
}

const me = (s: ApplianceSession) =>
  s.call({ id: 'me.get', method: 'GET' }, { params: {}, query: {}, body: undefined });

describe('c hostile relay', () => {
  it('no plaintext reaches the relay (every relayed byte scanned for the session’s known plaintext)', async (ctx) => {
    hostile.recorded.length = 0;
    hostile.setMode({ kind: 'observe' });
    const { s } = await sessionVia(hostile);
    await whenOpen(s);
    const marker = `MARKER-${randomBytes(6).toString('hex')}`;
    const r = await me(s);
    expect(r.status).toBe(200);
    await sessionOps.endpointsRename(s, { endpointId: slice.endpointId, label: marker });
    const list = await sessionOps.endpointsList(s);
    expect(JSON.stringify(list)).toContain(marker);
    const status = await sessionOps.applianceStatus(s);
    s.close('closed');
    const card = claimCard();
    const known = [
      marker,
      slice.owner.email,
      slice.owner.name,
      slice.owner.accountId,
      slice.endpointId,
      card.claimSecret,
      String(
        (status as { appliance?: { runtimeVersion?: string } }).appliance?.runtimeVersion ??
          'runtime-version',
      ),
      'me.get',
      'endpoints.rename',
      'appliance.status',
    ];
    const bytes = hostile.recorded.reduce((n, x) => n + x.bytes.length, 0);
    const hits = Object.fromEntries(known.map((k) => [k, hostile.find(k)]));
    note(ctx, 'relay-observed bytes scanned', { messages: hostile.recorded.length, bytes, hits });
    expect(bytes).toBeGreaterThan(1000);
    for (const [k, n] of Object.entries(hits)) expect(n, `plaintext “${k}” seen by the relay`).toBe(0);
    // The only text frames are the relay protocol's own (hello with the ticket, welcome, ready).
    const texts = hostile.recorded
      .filter((x) => x.text)
      .map((x) => JSON.parse(Buffer.from(x.bytes).toString()).t);
    expect(new Set(texts)).toEqual(new Set(['hello', 'welcome', 'ready']));
  });

  it('substituted appliance: identity mismatch, nothing but Noise message 1 sent', async (ctx) => {
    const sub = await startHostileRelay(env().relay?.url ?? '', { kind: 'substitute' });
    try {
      const { s } = await sessionVia(sub);
      s.connect();
      const st = await whenState(s, (x) => x.status === 'closed');
      expect(st.status === 'closed' && st.reason).toBe('identity_mismatch');
      const fromClient = sub.recorded.filter((x) => x.direction === 'toAppliance' && !x.text);
      note(ctx, 'substitute', {
        events: sub.events,
        clientBinaryMessages: fromClient.length,
        appBytes: sub.substitutedAppBytes,
      });
      expect(fromClient.length).toBe(1);
      expect(sub.substitutedAppBytes).toBe(0);
    } finally {
      await sub.close();
    }
  });

  for (const direction of ['toClient', 'toAppliance'] as const) {
    it(`tampered ${direction === 'toClient' ? 'appliance → client' : 'client → appliance'} record: the connection fails, no corrupted data is accepted, a fresh handshake recovers`, async (ctx) => {
      hostile.recorded.length = 0;
      hostile.events.length = 0;
      // Record #1/#2 are Noise handshake messages in each direction; #3 (to appliance) and #2 (to client) are the
      // first encrypted session records (hello / welcome).
      hostile.setMode({ kind: 'tamper', direction, nth: direction === 'toClient' ? 2 : 3 });
      const { s, states } = await sessionVia(hostile);
      s.connect();
      await whenState(s, (x) => x.status === 'reconnecting' || x.status === 'closed', 15_000);
      hostile.setMode({ kind: 'observe' });
      const info = await whenOpen(s, 20_000);
      const r = await me(s);
      note(ctx, 'tamper', {
        events: hostile.events,
        states: states.map((x) => ('reason' in x ? `${x.status}:${x.reason}` : x.status)),
      });
      expect(hostile.events.some((e) => e.startsWith('tampered'))).toBe(true);
      expect(states.some((x) => x.status === 'reconnecting' && x.reason === 'lost')).toBe(true);
      expect(info.account?.id).toBe(slice.owner.accountId);
      expect(r.status).toBe(200);
      expect((r.body as { account: { id: string } }).account.id).toBe(slice.owner.accountId);
      s.close('closed');
    });
  }

  it('replayed appliance → client record: the connection fails (nonce), the next one works, nothing is duplicated', async (ctx) => {
    hostile.events.length = 0;
    const { s, states } = await sessionVia(hostile);
    const events = collect(s, [`me:${slice.owner.accountId}`]);
    await whenOpen(s);
    const before = states.length;
    // The next connection gets appliance→client record #3 twice (once), then the relay behaves.
    hostile.setMode({ kind: 'replay', direction: 'toClient', nth: 3, once: true });
    hostile.dropAll(1012);
    await whenState(s, (x) => x.status === 'reconnecting', 10_000);
    const rs = await Promise.allSettled([me(s), me(s)]);
    const after = await me(s).catch((err) => {
      note(ctx, 'replay: the request after recovery was not delivered', {
        events: hostile.events,
        states: states.map((x) => ('reason' in x ? `${x.status}:${x.reason}` : x.status)),
        connections: hostile.connections,
      });
      throw err;
    });
    const since = states.slice(before).map((x) => ('reason' in x ? `${x.status}:${x.reason}` : x.status));
    note(ctx, 'replay', {
      events: hostile.events,
      statesAfterDrop: since,
      results: rs.map((x) => (x.status === 'fulfilled' ? x.value.status : String(x.reason))),
    });
    expect(hostile.events.some((e) => e.startsWith('replayed'))).toBe(true);
    // The drop, then the connection that got the replayed record must have failed too (never installed open).
    const reconnects = since.filter((x) => x.startsWith('reconnecting')).length;
    if (reconnects < 2)
      gap(
        ctx,
        'whombat-contracts/secure-channel (+ whombat-app client)',
        'a relay-replayed appliance→client record did not fail its connection',
      );
    expect(reconnects).toBeGreaterThanOrEqual(2);
    for (const x of rs) expect(x.status === 'fulfilled' && x.value.status === 200).toBe(true);
    expect(after.status).toBe(200);
    expect(events.duplicateCursors()).toEqual([]);
    events.close();
    s.close('closed');
  });
});
