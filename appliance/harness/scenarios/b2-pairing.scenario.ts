/**
 * (b2) Pairing with a fingerprint (contracts 0.5.2 CT-46, MR-32) and re-setting-up a removed device:
 * - a new endpoint asks for a code; the person's signed-in device looks the code up (`enroll.pair.lookup`) and sees
 *   the asking device's short fingerprint; approving with another fingerprint is refused
 *   (`pairing_fingerprint_mismatch`) and the pairing stays pending; the right fingerprint lets it in;
 * - the person removes that device: its key is refused on both channels; the same device with a new key (the app
 *   reset its storage) pairs in again and gets the person's app channel;
 * - `hello.cachedAccountId` (CT-47): a cache fetched as another account is cleared on connect.
 * Real client, relay, control and runtime.
 */
import { pairingFingerprint } from '@whombat/protocol/session';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ApplianceSession,
  newEndpointIdentity,
  openSession,
  sessionOps,
  whenOpen,
  whenState,
} from '../src/scenario-kit/app-client.ts';
import { note } from '../src/scenario-kit/report.ts';
import { ensureSlice, lookupPairing, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { refused, sessionFor } from '../src/scenario-kit/trust.ts';
import { type Persona, persona, ticketSource } from '../src/scenario-kit/world.ts';

let slice: SliceState;
let owner: ApplianceSession;
let p: Persona;
let paired: { identity: Awaited<ReturnType<typeof newEndpointIdentity>>; endpointId: string } | null = null;

beforeAll(async () => {
  slice = await ensureSlice();
  owner = (await ownerSession(slice)).session;
  p = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
});

describe('b2 pairing with a fingerprint', () => {
  it('look-up shows the asking device; a wrong fingerprint is refused and the pairing stays pending; the right one lets it in', async (ctx) => {
    const identity = await newEndpointIdentity();
    const { session: enroll, info } = await sessionFor(slice, p, identity, 'enroll');
    expect(info.channel).toBe('enroll');
    const req = (await sessionOps.pairRequest(enroll, {
      endpoint: { label: 'Harness phone', platform: 'cli' },
    })) as { pairingId: string; code: string };
    const found = await lookupPairing(owner, req.code);
    const expected = pairingFingerprint(identity.peerId);
    note(ctx, 'look-up', { code: req.code, found, newDeviceShows: expected });
    expect(found.pairingId).toBe(req.pairingId);
    expect(found.label).toBe('Harness phone');
    expect(found.fingerprint).toBe(expected);

    // Another device's fingerprint (a code typed from the wrong screen): refused, nothing is let in.
    const stranger = pairingFingerprint((await newEndpointIdentity()).peerId);
    const mismatch = await refused(
      sessionOps.pairApprove(owner, { code: req.code, approve: true, fingerprint: stranger }),
      'approval with another fingerprint',
    );
    const still = (await sessionOps.pairStatus(enroll, req.pairingId)) as { state: string };
    note(ctx, 'wrong fingerprint', { mismatch, status: still });
    expect(mismatch.appCode).toBe('pairing_fingerprint_mismatch');
    expect(still.state).toBe('pending');
    const listed = await sessionOps.endpointsList(owner);
    expect(listed.endpoints.some((x) => x.label === 'Harness phone')).toBe(false);

    const approved = (await sessionOps.pairApprove(owner, {
      code: req.code,
      approve: true,
      fingerprint: found.fingerprint,
    })) as { state: string; endpoint?: { endpointId: string } };
    const st = (await sessionOps.pairStatus(enroll, req.pairingId)) as {
      state: string;
      enrolled?: { accountId: string; endpoint: { endpointId: string } };
    };
    enroll.close('closed');
    note(ctx, 'approved', { approved, status: st });
    expect(approved.state).toBe('approved');
    expect(st.state).toBe('approved');
    expect(st.enrolled?.accountId).toBe(slice.owner.accountId);
    const endpointId = st.enrolled?.endpoint.endpointId ?? approved.endpoint?.endpointId ?? '';
    const app = await sessionFor(slice, p, identity, 'app');
    expect(app.info.channel).toBe('app');
    expect(app.info.account?.id).toBe(slice.owner.accountId);
    expect(app.info.endpointId).toBe(endpointId);
    app.session.close('closed');
    paired = { identity, endpointId };
  });

  it('a removed device: its key is refused on both channels; the same device with a new key pairs in again', async (ctx) => {
    if (!paired) throw new Error('needs the paired device of the previous step');
    await sessionOps.endpointsRevoke(owner, paired.endpointId);
    const refusedOn: Record<string, string> = {};
    for (const channel of ['app', 'enroll'] as const) {
      const s = openSession({
        tickets: ticketSource(p, slice.deviceId),
        identity: paired.identity,
        appliance: { peerId: slice.peerId },
        channel,
        ...(channel === 'enroll' ? { expect: 'any' as const } : {}),
      });
      s.connect();
      const st = await whenState(s, (x) => x.status === 'closed' || x.status === 'open', 20_000);
      refusedOn[channel] = st.status === 'closed' ? st.reason : `open (${JSON.stringify(st)})`;
      s.close('closed');
    }
    note(ctx, 'removed key reconnects', refusedOn);
    expect(['revoked', 'not_enrolled']).toContain(refusedOn.app);
    expect(['revoked', 'not_enrolled']).toContain(refusedOn.enroll);

    // Re-setup: the app reset its storage, so the device has a new key and asks again.
    const fresh = await newEndpointIdentity();
    const { session: enroll } = await sessionFor(slice, p, fresh, 'enroll');
    const req = (await sessionOps.pairRequest(enroll, {
      endpoint: { label: 'Harness phone', platform: 'cli' },
    })) as { pairingId: string; code: string };
    const found = await lookupPairing(owner, req.code);
    expect(found.fingerprint).toBe(pairingFingerprint(fresh.peerId));
    expect(found.fingerprint).not.toBe(pairingFingerprint(paired.identity.peerId));
    const approved = (await sessionOps.pairApprove(owner, {
      code: req.code,
      approve: true,
      fingerprint: found.fingerprint,
    })) as { state: string };
    enroll.close('closed');
    expect(approved.state).toBe('approved');
    const app = await sessionFor(slice, p, fresh, 'app');
    const list = await sessionOps.endpointsList(owner);
    const rows = list.endpoints as { endpointId: string; label: string; revokedAt: string | null }[];
    note(ctx, 're-set up', {
      newEndpoint: app.info.endpointId,
      devices: rows.filter((r) => r.label === 'Harness phone'),
    });
    expect(app.info.account?.id).toBe(slice.owner.accountId);
    expect(app.info.endpointId).not.toBe(paired.endpointId);
    expect(rows.find((r) => r.endpointId === paired?.endpointId)?.revokedAt).toBeTruthy();
    expect(rows.find((r) => r.endpointId === app.info.endpointId)?.revokedAt ?? null).toBeNull();
    app.session.close('closed');
  });

  it('hello.cachedAccountId: a cache fetched as another account is cleared; the own account keeps it', async (ctx) => {
    const first = await ownerSession(slice);
    const gen = first.info.authzGeneration;
    first.session.close('closed');
    const open = async (accountId: string) => {
      const s = openSession({
        tickets: ticketSource(p, slice.deviceId),
        identity: (await import('../src/scenario-kit/slice.ts')).identityOf(slice),
        appliance: { peerId: slice.peerId },
        channel: 'app',
        cached: () => ({ accountId, authzGeneration: gen }),
      });
      const info = await whenOpen(s);
      s.close('closed');
      return info.clearCache;
    };
    const own = await open(slice.owner.accountId);
    const other = await open('acc_0000000000000000000000000000');
    note(ctx, 'clearCache', { own, other, authzGeneration: gen });
    expect(own).toBe(false);
    expect(other).toBe(true);
  });
});
