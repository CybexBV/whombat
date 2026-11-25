/**
 * Enrollment and trust over sessions (MA-04, MR-09…MR-12): claim with the card (CC-02, CT-66: wrong secret, rate
 * limit, claim window, reuse),
 * pairing, the recovery kit and recovery enrollment, revocation closing live sessions with a clear-cache notice,
 * pending/applied revocation reports, and that email/cloud sign-in grants nothing.
 */

import { randomBytes } from 'node:crypto';
import { generateKeypair } from '@whombat/core';
import { claimConfirmEqual } from '@whombat/protocol/claim';
import {
  claimCardPassword,
  normalizeClaimSecret,
  pairingFingerprint,
  RECOVERY_ENROLL_PURPOSE,
  RECOVERY_KIT_CONFIRM_PURPOSE,
  SESSION_PROTOCOL,
  signRecoveryStatement,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { applianceState } from '../db/schema/index';
import { useManagedRuntime } from '../test/managed';
import { verifyApplianceChain } from './audit';
import { pakeClaim, testIdentity } from './testing';
import { claimSecretHash } from './trust';

const m = useManagedRuntime();
const SECRET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DEVICE = 'dev-test-1';
const endpoint = (label: string) => ({ label, platform: 'web' as const });

type Result = { t: 'result'; output: Record<string, unknown> };
const output = (r: unknown) => (r as Result).output;

describe('claim, pairing, recovery, revocation', () => {
  const owner = testIdentity();
  let ownerAccountId = '';

  it('claims once with the card: not ready, wrong secret, claim window, then the person and endpoint in one step', async () => {
    const stranger = await m.client();
    const card = (secret: string, who: string, c = stranger) =>
      pakeClaim(
        c,
        {
          method: 'card',
          password: claimCardPassword(DEVICE, normalizeClaimSecret(secret)),
          deviceId: DEVICE,
          appliancePeerId: m.appliance.peerId,
        },
        { account: { name: who, email: `${who.toLowerCase()}@example.com` }, endpoint: endpoint(who) },
      );
    // Not provisioned yet.
    expect((await card(SECRET, 'Olive')).begin).toMatchObject({
      t: 'error',
      code: 'unavailable',
      details: { code: 'claim_not_ready' },
    });
    await m.runtime.trust.provisionClaim({ deviceId: DEVICE, secretHash: claimSecretHash(DEVICE, SECRET) });
    const wrong = await card('ZZZZZZZZZZZZZZZZZZZZZZZZZZ', 'Mallory');
    expect(wrong.begin).toMatchObject({ t: 'result' });
    expect(wrong.claim).toMatchObject({ t: 'error', code: 'forbidden', details: { code: 'claim_invalid' } });
    expect((wrong.claim as { message: string }).message).toBe('That claim code isn’t right.');
    // Begins are bounded per endpoint key (MR-26): 5 per hour, and this key has used 1.
    for (let i = 0; i < 4; i++)
      expect(
        (
          await pakeClaim(
            stranger,
            {
              method: 'card',
              password: claimCardPassword(DEVICE, 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ'),
              deviceId: DEVICE,
              appliancePeerId: m.appliance.peerId,
            },
            { account: { name: 'Mallory', email: 'mallory@example.com' }, endpoint: endpoint('Mallory') },
            { beginOnly: true },
          )
        ).begin,
      ).toMatchObject({ t: 'result' });
    expect((await card(SECRET, 'Mallory')).begin).toMatchObject({ t: 'error', code: 'rate_limited' });

    // The physical claim window, when the manager requires it.
    await m.runtime.trust.setClaimWindow({ required: true, openUntil: null });
    const c = await m.client(owner);
    expect((await card(SECRET, 'Olive', c)).begin).toMatchObject({
      t: 'error',
      code: 'forbidden',
      details: { code: 'claim_window_closed' },
    });
    await m.runtime.trust.setClaimWindow({ required: true, openUntil: new Date(Date.now() + 60_000) });
    const { claim: claimed, tags } = await card(SECRET, 'Olive', c);
    expect(claimed).toMatchObject({
      t: 'result',
      output: {
        name: 'Olive',
        recoveryKitRequired: false,
        endpoint: { current: true, revocation: 'none' },
      },
    });
    // The appliance proves it knew the password too: the client checks this before it trusts the result.
    expect(claimConfirmEqual(tags?.appliance ?? '', output(claimed).confirm as string)).toBe(true);
    ownerAccountId = output(claimed).accountId as string;
    expect(ownerAccountId).toMatch(/^acc_/);
    // The same session may now use the app (it picked up its enrollment).
    const burrow = await c.request('burrows.create', {
      params: {},
      body: { name: 'Olive HQ', slug: 'olive-hq' },
    });
    expect(burrow).toMatchObject({ t: 'result', kind: 'ok' });
    // Reported to control through the manager; the appliance can't be claimed again.
    await m.runtime.trust.reportPending();
    expect(m.manager.claimed).toEqual([{ claimId: 'clm_test_0001', claimedAt: expect.any(String) }]);
    const again = await card(SECRET, 'Eve', await m.client());
    expect(again.begin).toMatchObject({ t: 'error', code: 'conflict', details: { code: 'claim_used' } });
    expect(await verifyApplianceChain(m.t.services.db, m.t.services.custody)).toMatchObject({ ok: true });
  });

  const phone = testIdentity();
  let phoneEndpointId = '';
  it('pairs a new endpoint with a code an enrolled endpoint of the account approves', async () => {
    const fresh = await m.client(phone);
    const req = await fresh.request('enroll.pair.request', {
      endpoint: { label: 'Phone', platform: 'android' },
    });
    const { pairingId, code } = output(req) as { pairingId: string; code: string };
    expect(code).toMatch(/^\d{4}-\d{4}$/);
    expect(await fresh.request('enroll.pair.status', { pairingId })).toMatchObject({
      output: { state: 'pending' },
    });
    const laptop = await m.client(owner);
    const looked = output(await laptop.request('enroll.pair.lookup', { code })) as { fingerprint: string };
    expect(looked.fingerprint).toBe(pairingFingerprint(phone.peerId));
    const approved = await laptop.request('enroll.pair.approve', {
      code,
      approve: true,
      fingerprint: looked.fingerprint,
    });
    expect(approved).toMatchObject({
      output: { state: 'approved', endpoint: { label: 'Phone', accountId: ownerAccountId } },
    });
    phoneEndpointId = (output(approved).endpoint as { endpointId: string }).endpointId;
    expect(await fresh.request('enroll.pair.status', { pairingId })).toMatchObject({
      output: { state: 'approved', enrolled: { accountId: ownerAccountId } },
    });
    const reconnected = await m.client(phone);
    expect(reconnected.received.find((x) => x.t === 'welcome')).toMatchObject({
      channel: 'app',
      principal: { accountId: ownerAccountId },
    });
  });

  const recoveryKey = generateKeypair();
  it('registers and confirms the recovery kit, then enrolls a new endpoint of the person with a signed statement', async () => {
    const laptop = await m.client(owner);
    const kit = output(
      await laptop.request('recovery.kit.register', { recoveryPublicKey: recoveryKey.publicKey }),
    ) as {
      kitId: string;
      challenge: string;
    };
    const confirmation = {
      purpose: RECOVERY_KIT_CONFIRM_PURPOSE,
      appliance: m.appliance.peerId,
      kitId: kit.kitId,
      challenge: kit.challenge,
    } as const;
    const badSig = signRecoveryStatement(confirmation, generateKeypair().secretKey);
    expect(
      await laptop.request('recovery.kit.confirm', { kitId: kit.kitId, signature: badSig }),
    ).toMatchObject({
      t: 'error',
      code: 'forbidden',
    });
    const sig = signRecoveryStatement(confirmation, recoveryKey.secretKey);
    expect(await laptop.request('recovery.kit.confirm', { kitId: kit.kitId, signature: sig })).toMatchObject({
      output: { confirmed: true },
    });

    const lost = testIdentity();
    const statement = {
      purpose: RECOVERY_ENROLL_PURPOSE,
      appliance: m.appliance.peerId,
      endpoint: lost.peerId,
      accountId: ownerAccountId,
      issuedAt: new Date().toISOString(),
      nonce: randomBytes(16).toString('hex'),
    } as const;
    const signature = signRecoveryStatement(statement, recoveryKey.secretKey);
    // Another endpoint can't use a statement made for this one.
    const thief = await m.client();
    expect(
      await thief.request('recovery.enroll', { statement, signature, endpoint: endpoint('Thief') }),
    ).toMatchObject({
      t: 'error',
      code: 'forbidden',
    });
    // Nor a statement for another appliance.
    const other = { ...statement, appliance: testIdentity().peerId };
    const recovering = await m.client(lost);
    expect(
      await recovering.request('recovery.enroll', {
        statement: other,
        signature: signRecoveryStatement(other, recoveryKey.secretKey),
        endpoint: endpoint('New laptop'),
      }),
    ).toMatchObject({ t: 'error', code: 'forbidden' });
    const stale = { ...statement, issuedAt: new Date(Date.now() - 3600_000).toISOString() };
    expect(
      await recovering.request('recovery.enroll', {
        statement: stale,
        signature: signRecoveryStatement(stale, recoveryKey.secretKey),
        endpoint: endpoint('New laptop'),
      }),
    ).toMatchObject({ t: 'error', code: 'expired' });
    const enrolled = await recovering.request('recovery.enroll', {
      statement,
      signature,
      endpoint: endpoint('New laptop'),
    });
    expect(enrolled).toMatchObject({ t: 'result', output: { accountId: ownerAccountId } });
  });

  it('revocation closes the endpoint’s live session with a clear-cache notice; control hears (pending → applied)', async () => {
    const g = await m.client(phone);
    let laptop = await m.client(owner);
    m.manager.failReports = true;
    const revoked = await laptop.request('endpoints.revoke', { endpointId: phoneEndpointId });
    expect(revoked).toMatchObject({ t: 'result', output: { endpoint: { revocation: 'pending' } } });
    const notice = await g.waitFor((x) => x.t === 'revoked');
    expect(notice).toMatchObject({ t: 'revoked', scope: 'endpoint', clearCache: true });
    expect(await g.closed).toBe('endpoint_revoked');
    // The person's other sessions learn their account's authorization changed, and come back.
    expect(await laptop.closed).toBe('authz_changed');
    laptop = await m.client(owner);
    // The revoked key can't come back.
    const back = await m.client(phone).catch((err: Error) => err);
    expect(String(back)).toMatch(/no welcome/);
    const listed = output(await laptop.request('endpoints.list', {})) as {
      endpoints: { endpointId: string; revocation: string }[];
    };
    expect(listed.endpoints.find((e) => e.endpointId === phoneEndpointId)?.revocation).toBe('pending');
    m.manager.failReports = false;
    await m.runtime.trust.reportPending();
    expect(m.manager.revocations).toHaveLength(1);
    const after = output(await laptop.request('endpoints.list', {})) as {
      endpoints: { endpointId: string; revocation: string }[];
    };
    expect(after.endpoints.find((e) => e.endpointId === phoneEndpointId)?.revocation).toBe('applied');
    const status = output(await laptop.request('appliance.status', {}));
    expect(status).toMatchObject({
      revocationsPending: 0,
      revocationsApplied: 1,
      claimed: true,
    });
  });

  it('reports the managed policy with explanations, and backups as unprotected until the manager says otherwise', async () => {
    const laptop = await m.client(owner);
    const status = output(await laptop.request('appliance.status', {}));
    expect(status).toMatchObject({
      // Website feedback runs through the encrypted drop (feedback-drop FD-25) until the manager says it can't.
      policy: { feedbackIntake: { available: true } },
      backup: { state: 'unprotected', recoverable: false },
      update: null,
      appliance: { peerId: m.appliance.peerId, protocol: { major: SESSION_PROTOCOL.major } },
      providers: expect.any(Array),
    });
  });
  it('takes a restored backup’s new device id once, after what belonged to the earlier box went', async () => {
    const order: string[] = [];
    const deviceId = async () => (await m.t.services.db.select().from(applianceState))[0]?.claimDeviceId;
    const beforeAdopt = async (old: string) => {
      // The id still names the earlier box while its things go.
      order.push(`before ${old} ${await deviceId()}`);
    };
    const old = await m.runtime.trust.adoptDeviceId(
      { deviceId: 'dev-test-2', secretHash: null },
      { beforeAdopt },
    );
    expect(old).toBe(DEVICE);
    expect(order).toEqual([`before ${DEVICE} ${DEVICE}`]);
    expect(await deviceId()).toBe('dev-test-2');
    // The same id again changes nothing, and nothing goes.
    expect(
      await m.runtime.trust.adoptDeviceId({ deviceId: 'dev-test-2', secretHash: null }, { beforeAdopt }),
    ).toBe(null);
    expect(order).toHaveLength(1);
  });
  it('keeps the earlier id while what belonged to the earlier box couldn’t go, and takes it at the next start', async () => {
    const deviceId = async () => (await m.t.services.db.select().from(applianceState))[0]?.claimDeviceId;
    const before = await deviceId();
    const next = { deviceId: 'dev-test-3', secretHash: null };
    await expect(
      m.runtime.trust.adoptDeviceId(next, {
        beforeAdopt: async () => {
          throw new Error('the database is busy');
        },
      }),
    ).rejects.toThrow('busy');
    expect(await deviceId()).toBe(before);
    expect(await m.runtime.trust.adoptDeviceId(next, { beforeAdopt: async () => {} })).toBe(before);
    expect(await deviceId()).toBe('dev-test-3');
  });
});
