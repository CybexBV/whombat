/**
 * (b) Enrollment negatives (assignment §14.2, MA-04): wrong appliance, reused claim, competing claim, unenrolled
 * endpoint, cloud-reset bypass, last-device protection. Real control, relay, runtime and client.
 */

import { generateIdentity } from '@whombat/secure-channel';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  newEndpointIdentity,
  OperationError,
  openSession,
  sessionOps,
  whenOpen,
  whenState,
} from '../src/scenario-kit/app-client.ts';
import { ControlError, clientTicket, startClaim } from '../src/scenario-kit/cloud.ts';
import { startHostileRelay } from '../src/scenario-kit/hostile-relay.ts';
import { probeDevice } from '../src/scenario-kit/probe.ts';
import { note } from '../src/scenario-kit/report.ts';
import { claimCeremony, ensureSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { claimCard, env, persona, ticketSource } from '../src/scenario-kit/world.ts';

const appCode = (e: unknown) =>
  ((e as { details?: { code?: string } }).details?.code ??
    (e as { code?: string }).code ??
    String(e)) as string;

let slice: SliceState;

beforeAll(async () => {
  slice = await ensureSlice();
});

describe('b enrollment negatives', () => {
  it('wrong appliance: a pinned PeerId mismatch aborts before anything is sent', async (ctx) => {
    const e = env();
    const owner = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
    const observer = await startHostileRelay(e.relay?.url ?? '', { kind: 'observe' });
    try {
      const other = await generateIdentity(); // the client expects this appliance, the relay routes to the real one
      const s = openSession({
        tickets: ticketSource(owner, slice.deviceId, observer.url),
        identity: await newEndpointIdentity(),
        appliance: { peerId: other.peerId },
        channel: 'app',
      });
      s.connect();
      const st = await whenState(s, (x) => x.status === 'closed');
      expect(st.status === 'closed' && st.reason).toBe('identity_mismatch');
      const fromClient = observer.recorded.filter((r) => r.direction === 'toAppliance' && !r.text);
      note(ctx, 'client → relay binary messages before abort', {
        count: fromClient.length,
        sizes: fromClient.map((r) => r.bytes.length),
      });
      // Only Noise message 1 (the ephemeral key): no static key, no application byte.
      expect(fromClient.length).toBe(1);
      expect(fromClient[0]?.bytes.length).toBeLessThanOrEqual(64);
    } finally {
      await observer.close();
    }
  });

  it('reused claim: a claimed box takes no second claim, through the relay either (claim_used)', async (ctx) => {
    const e = env();
    const identity = await newEndpointIdentity();
    const owner = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
    // The owner's own account on a device the box doesn't know: the enrollment channel, through the relay.
    const s = openSession({
      tickets: async (r) => {
        const t = await clientTicket(
          e.control?.url ?? '',
          owner.session.token,
          owner.org,
          slice.deviceId,
          'enroll',
          r.class,
        );
        return { ticket: t.ticket, relayUrl: t.relay.url };
      },
      identity,
      appliance: { peerId: slice.peerId },
      channel: 'enroll',
      expect: 'any',
    });
    await whenOpen(s);
    // The claim on the box's page is refused before any letters are compared.
    const err = await sessionOps.claimLocalStart(s, {}).catch((x) => x);
    expect(err).toBeInstanceOf(OperationError);
    note(ctx, 'second claim refused', { code: (err as { code: string }).code, appCode: appCode(err) });
    expect(appCode(err)).toBe('claim_used');
    // And the claim through control isn't this box's way at all: it is set up on its own page.
    const viaControl = await (await claimCeremony())
      .runClaimCeremony({
        session: s,
        claim: { claim: 'clm_none', device: slice.deviceId },
        request: { method: 'code', device: slice.deviceId, letters: 'ABCD' },
        appliancePeerId: slice.peerId,
        clientPeerId: identity.peerId,
        account: { name: 'Mallory', email: 'mallory@harness.whombat.local' },
        endpoint: { label: 'second', platform: 'cli' },
      })
      .catch((x) => x);
    expect(viaControl).toBeInstanceOf(OperationError);
    note(ctx, 'claim through control refused', { appCode: appCode(viaControl) });
    expect(['not_allowed', 'claim_used']).toContain(appCode(viaControl));
    s.close('closed');
  });

  it('competing claim: another org cannot claim a claimed appliance, nor one with a live pending claim', async (ctx) => {
    const e = env();
    const card = claimCard();
    const rival = await persona('rival', 'Rival');
    const onClaimed = await startClaim(
      e.control?.url ?? '',
      rival.session.token,
      rival.org,
      card.deviceId,
      card.claimSecret,
    ).catch((x) => x);
    expect(onClaimed).toBeInstanceOf(ControlError);
    note(ctx, 'claim of a claimed appliance by another org', {
      status: onClaimed.status,
      code: onClaimed.code,
      reason: onClaimed.reason,
    });
    // Pending: a probe device (registered with control, no runtime) — first claim wins, the second org is refused.
    const { prov } = await probeDevice(`competing-${Date.now()}`);
    const first = await persona('first-claimer', 'First claimer');
    const ok = await startClaim(
      e.control?.url ?? '',
      first.session.token,
      first.org,
      prov.record.deviceId,
      prov.card.claimSecret,
    );
    expect(ok.claim.state).toBe('pending');
    const second = await startClaim(
      e.control?.url ?? '',
      rival.session.token,
      rival.org,
      prov.record.deviceId,
      // The rival doesn't hold the card (contracts ≥ 0.5.1: a wrong claim proof; a valid one would replace the
      // pending claim by design, CT-43 — holding the card is the right to claim).
      'AAAAAAAAAAAAAAAAAAAAAAAAAA',
    ).catch((x) => x);
    expect(second).toBeInstanceOf(ControlError);
    note(ctx, 'competing pending claim', { status: second.status, code: second.code, reason: second.reason });
    // The rival cannot get tickets for it either.
    const t = await clientTicket(
      e.control?.url ?? '',
      rival.session.token,
      rival.org,
      prov.record.deviceId,
      'enroll',
      'interactive',
    ).catch((x) => x);
    expect(t).toBeInstanceOf(ControlError);
  });

  it('unenrolled endpoint: enrollment channel only; a workspace op is refused', async (ctx) => {
    const e = env();
    const owner = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
    const identity = await newEndpointIdentity();
    // Asking for the app channel with an unknown key: the appliance answers with the enrollment channel.
    const app = openSession({
      tickets: ticketSource(owner, slice.deviceId),
      identity,
      appliance: { peerId: slice.peerId },
      channel: 'app',
    });
    app.connect();
    const st = await whenState(app, (x) => x.status === 'closed');
    expect(st.status === 'closed' && st.reason).toBe('not_enrolled');
    // On the enrollment channel it may connect, but workspace operations are refused.
    const enroll = openSession({
      tickets: async (r) => {
        const t = await clientTicket(
          e.control?.url ?? '',
          owner.session.token,
          owner.org,
          slice.deviceId,
          'enroll',
          r.class,
        );
        return { ticket: t.ticket, relayUrl: t.relay.url };
      },
      identity,
      appliance: { peerId: slice.peerId },
      channel: 'enroll',
      expect: 'any',
    });
    const info = await whenOpen(enroll);
    expect(info.channel).toBe('enroll');
    expect(info.account).toBeNull();
    // A real workspace read (me.get, allowlisted for enrolled endpoints) must be refused here.
    const r = await enroll.call({ id: 'me.get', method: 'GET' }, { params: {}, query: {}, body: undefined });
    note(ctx, 'workspace op from an unenrolled endpoint', { status: r.status, body: r.body });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain(slice.owner.email);
    const status = await sessionOps.applianceStatus(enroll).catch((x) => x);
    expect(status).toBeInstanceOf(OperationError);
    enroll.close('closed');
  });

  it('cloud-reset bypass: a new cloud session without local enrollment gets no content', async (ctx) => {
    // Same person signs in again (as after a cloud password/email reset) on a fresh browser profile.
    const again = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name, { fresh: true });
    expect(again.via).toBe('magic-link');
    const s = openSession({
      tickets: ticketSource(again, slice.deviceId),
      identity: await newEndpointIdentity(),
      appliance: { peerId: slice.peerId },
      channel: 'app',
    });
    s.connect();
    const st = await whenState(s, (x) => x.status === 'closed');
    note(ctx, 'new cloud session, new endpoint key', { state: st });
    expect(st.status === 'closed' && st.reason).toBe('not_enrolled');
  });

  it('last-device protection: the person cannot remove their own last device', async (ctx) => {
    const { session } = await ownerSession(slice);
    const list = await sessionOps.endpointsList(session);
    const mine = list.endpoints.filter((x) => x.accountId === slice.owner.accountId && !x.revokedAt);
    note(ctx, 'the person’s devices', { count: mine.length });
    if (mine.length === 1) {
      const err = await sessionOps.endpointsRevoke(session, String(mine[0]?.endpointId)).catch((x) => x);
      note(ctx, 'endpoints.revoke of the last device', { appCode: appCode(err) });
      expect(err).toBeInstanceOf(OperationError);
      expect(appCode(err)).toBe('last_endpoint');
    }
    session.close('closed');
  });
});
