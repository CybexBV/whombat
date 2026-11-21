/**
 * Regression tests for the independent security review part 1 (the appliance
 * `docs/implementation/reviews/security-part1-trust.md`, fixes per MA-19; docs/decisions/managed-runtime.md MR-22…).
 * They are the review's PoCs inverted: each asserts the fixed behaviour.
 */
import { randomBytes } from 'node:crypto';
import { generateKeypair } from '@whombat/core';
import {
  pairingFingerprint,
  RECOVERY_ENROLL_PURPOSE,
  RECOVERY_KIT_CONFIRM_PURPOSE,
  RECOVERY_ROTATE_PURPOSE,
  requestDigest,
  signRecoveryStatement,
} from '@whombat/protocol/session';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { applianceEndpoints, commandReceipts } from '../db/schema/index';
import { useManagedRuntime } from '../test/managed';
import { TEST_WAYS, testIdentity } from './testing';
import { PAIRING_TRIES_PER_ACCOUNT } from './trust';

const m = useManagedRuntime();
const endpoint = (label: string) => ({ label, platform: 'web' as const });
type Result = { t: 'result'; output: Record<string, unknown> };
const output = (r: unknown) => (r as Result).output;

describe('security review part 1', () => {
  const olive = testIdentity();
  const phoneKey = testIdentity();
  let oliveAccount = '';

  it('claims the appliance (setup)', async () => {
    // The box's way in for device links (one-person.md OP-S04: Olive's other devices join her account by one).
    m.runtime.trust.ways = () => TEST_WAYS;
    const { claim: claimed } = await m.claim(await m.client(olive), { deviceId: 'dev-sec1', name: 'Olive' });
    expect(claimed).toMatchObject({ t: 'result' });
    oliveAccount = output(claimed).accountId as string;
  });

  it('M-2: the person’s last live device can’t be revoked; another of their devices can', async () => {
    const o = await m.client(olive);
    const link = output(await o.request('enroll.link.create', {})) as { secret: string };
    const phone = output(
      await (await m.client(phoneKey)).request('enroll.link.accept', {
        secret: link.secret,
        endpoint: endpoint('Phone'),
      }),
    ) as { accountId: string; endpoint: { endpointId: string } };
    expect(phone.accountId).toBe(oliveAccount);
    expect(await o.request('endpoints.revoke', { endpointId: phone.endpoint.endpointId })).toMatchObject({
      t: 'result',
    });
    const [oliveDevice] = await m.t.services.db
      .select()
      .from(applianceEndpoints)
      .where(and(eq(applianceEndpoints.accountId, oliveAccount), isNull(applianceEndpoints.revokedAt)));
    const o2 = await m.client(olive);
    expect(await o2.request('endpoints.revoke', { endpointId: oliveDevice?.id })).toMatchObject({
      t: 'error',
      details: { code: 'last_endpoint' },
    });
  });

  const k1 = generateKeypair();

  /** Registers (or rotates to) a kit and confirms it with its key. */
  async function confirmKit(
    c: Awaited<ReturnType<typeof m.client>>,
    kit: { kitId: string; challenge: string },
    secretKey: string,
  ) {
    const confirmation = {
      purpose: RECOVERY_KIT_CONFIRM_PURPOSE,
      appliance: m.appliance.peerId,
      kitId: kit.kitId,
      challenge: kit.challenge,
    } as const;
    return c.request('recovery.kit.confirm', {
      kitId: kit.kitId,
      signature: signRecoveryStatement(confirmation, secretKey),
    });
  }
  /** Tries to recover a new device into `accountId` with a statement signed by `secretKey`. */
  async function recover(accountId: string, secretKey: string) {
    const device = testIdentity();
    const statement = {
      purpose: RECOVERY_ENROLL_PURPOSE,
      appliance: m.appliance.peerId,
      endpoint: device.peerId,
      accountId,
      issuedAt: new Date().toISOString(),
      nonce: randomBytes(16).toString('hex'),
    } as const;
    return (await m.client(device)).request('recovery.enroll', {
      statement,
      signature: signRecoveryStatement(statement, secretKey),
      endpoint: endpoint('Recovered'),
    });
  }

  it('H-1: an unconfirmed kit recovers nothing; a confirmed one only into the kit’s account; the person hears of it', async () => {
    const o = await m.client(olive);
    expect(await o.request('push.handles.set', { handle: 'push-handle-olive-0001' })).toMatchObject({
      t: 'result',
    });
    // No kit at all: `recovery_key_missing`.
    expect(await recover(oliveAccount, k1.secretKey)).toMatchObject({
      t: 'error',
      code: 'forbidden',
      details: { code: 'recovery_key_missing' },
    });
    const pushesBefore = m.manager.pushes.length;
    const kit = output(await o.request('recovery.kit.register', { recoveryPublicKey: k1.publicKey })) as {
      kitId: string;
      challenge: string;
    };
    // Registered, not confirmed: it recovers nothing yet (CT-45 `recovery_kit_unverified`).
    expect(await recover(oliveAccount, k1.secretKey)).toMatchObject({
      t: 'error',
      code: 'forbidden',
      details: { code: 'recovery_kit_unverified' },
    });
    expect(output(await o.request('appliance.status', {})).recovery).toEqual({
      enrolled: true,
      kitVerified: false,
      ownerAccountId: null,
      rotationPending: false,
    });
    expect(await confirmKit(o, kit, k1.secretKey)).toMatchObject({ output: { confirmed: true } });
    expect(output(await o.request('appliance.status', {})).recovery).toEqual({
      enrolled: true,
      kitVerified: true,
      ownerAccountId: oliveAccount,
      rotationPending: false,
    });
    // The person's devices with a push handle got a content-free security notice.
    const notices = m.manager.pushes.slice(pushesBefore);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((p) => p.kind === 'security' && p.handles.includes('push-handle-olive-0001'))).toBe(
      true,
    );
    // The kit enrolls only into the kit's account, never another.
    expect(await recover('acc_someone-else', k1.secretKey)).toMatchObject({
      t: 'error',
      details: { code: 'recovery_not_kit_owner' },
    });
    expect(await recover(oliveAccount, k1.secretKey)).toMatchObject({
      t: 'result',
      output: { accountId: oliveAccount },
    });
  });

  it('H-1: the recovery key isn’t replaced without the current kit', async () => {
    const o = await m.client(olive);
    const k2 = generateKeypair();
    // Registering over an existing key: refused.
    expect(await o.request('recovery.kit.register', { recoveryPublicKey: k2.publicKey })).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'recovery_key_exists' },
    });
    // Rotating needs the current key's signature over the new key; the new key's own signature doesn't do.
    const rotation = {
      purpose: RECOVERY_ROTATE_PURPOSE,
      appliance: m.appliance.peerId,
      newRecoveryPublicKey: k2.publicKey,
    } as const;
    expect(
      await o.request('recovery.kit.rotate', {
        newRecoveryPublicKey: k2.publicKey,
        currentKeySignature: signRecoveryStatement(rotation, k2.secretKey),
      }),
    ).toMatchObject({ t: 'error', details: { code: 'recovery_rotation_invalid' } });
    expect(await recover(oliveAccount, k2.secretKey)).toMatchObject({ t: 'error' });
    // Olive's kit still works.
    expect(await recover(oliveAccount, k1.secretKey)).toMatchObject({ t: 'result' });
  });

  it('H-1: a rotation signed by the current kit stays pending until confirmed; the old key works until then', async () => {
    const o = await m.client(olive);
    const k3 = generateKeypair();
    const rotation = {
      purpose: RECOVERY_ROTATE_PURPOSE,
      appliance: m.appliance.peerId,
      newRecoveryPublicKey: k3.publicKey,
    } as const;
    const kit = output(
      await o.request('recovery.kit.rotate', {
        newRecoveryPublicKey: k3.publicKey,
        currentKeySignature: signRecoveryStatement(rotation, k1.secretKey),
      }),
    ) as { kitId: string; challenge: string };
    expect(output(await o.request('appliance.status', {})).recovery).toMatchObject({
      rotationPending: true,
      kitVerified: true,
    });
    expect(await recover(oliveAccount, k3.secretKey)).toMatchObject({
      t: 'error',
      details: { code: 'recovery_signature_invalid' },
    });
    expect(await recover(oliveAccount, k1.secretKey)).toMatchObject({ t: 'result' });
    expect(await confirmKit(o, kit, k3.secretKey)).toMatchObject({ output: { confirmed: true } });
    expect(await recover(oliveAccount, k1.secretKey)).toMatchObject({
      t: 'error',
      details: { code: 'recovery_signature_invalid' },
    });
    expect(await recover(oliveAccount, k3.secretKey)).toMatchObject({ t: 'result' });
    expect(output(await o.request('appliance.status', {})).recovery).toMatchObject({
      rotationPending: false,
    });
  });

  it('L-1/L-2: a secret op’s receipt keeps neither the input digest nor the result; a retry learns only that it happened', async () => {
    const o = await m.client(olive);
    const id = 'req_sec1_link_0001';
    const created = await o.request('enroll.link.create', {}, { id });
    const secret = (output(created) as { secret: string }).secret;
    const rows = await m.t.services.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.requestId, id));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(secret);
    expect(rows[0]?.digest).toBe(requestDigest('enroll.link.create', null));
    expect(rows[0]?.outcome).toEqual({ kind: 'result', resultKind: 'ok', redacted: true });
    // The same request id again: `unknown_outcome`, never the secret.
    const again = await o.request('enroll.link.create', {}, { id });
    expect(again).toMatchObject({ t: 'error', code: 'unknown_outcome' });
    expect(JSON.stringify(again)).not.toContain(secret);
    // `status`: completed, redacted.
    o.send({ t: 'status', id });
    const status = await o.waitFor((x) => x.t === 'outcome' && (x as { id: string }).id === id);
    expect(status).toMatchObject({ t: 'outcome', state: 'completed', redacted: true });
    expect(status).not.toHaveProperty('result');
    // A secret input (the link's secret on accept) leaves no digest of itself either.
    const acceptId = 'req_sec1_accept_0001';
    await (await m.client()).request(
      'enroll.link.accept',
      { secret, endpoint: endpoint('Laptop') },
      { id: acceptId },
    );
    const [accept] = await m.t.services.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.requestId, acceptId));
    expect(accept?.digest).toBe(requestDigest('enroll.link.accept', null));
    expect(JSON.stringify(accept)).not.toContain(secret);
    // The `api` ops that carry secrets take the same path (the op registry's `secret` flag).
    for (const op of ['connectors.setGoogleApp', 'canvases.collabToken', 'devices.register'])
      expect(m.runtime.dispatcher.allowlist.get(op)?.secret, op).toBe(true);
  });

  it('L-4: pairing codes can’t be sprayed; the approver sees which device asked, with the fingerprint it shows', async () => {
    const victim = testIdentity();
    const v = await m.client(victim);
    const shown = output(await v.request('enroll.pair.request', { endpoint: endpoint('Victim phone') })) as {
      code: string;
      pairingId: string;
    };
    // The person looks the code up first: label, platform and the fingerprint the new device shows.
    const o = await m.client(olive);
    const looked = await o.request('enroll.pair.lookup', { code: shown.code });
    expect(looked).toMatchObject({
      t: 'result',
      output: {
        pairingId: shown.pairingId,
        label: 'Victim phone',
        platform: 'web',
        fingerprint: pairingFingerprint(victim.peerId),
      },
    });
    // CT-46: the approval names the fingerprint the person compared; another device's is refused (and uses a try).
    expect(
      await o.request('enroll.pair.approve', {
        code: shown.code,
        approve: true,
        fingerprint: pairingFingerprint(testIdentity().peerId),
      }),
    ).toMatchObject({ t: 'error', code: 'forbidden', details: { code: 'pairing_fingerprint_mismatch' } });
    const status = output(await v.request('enroll.pair.status', { pairingId: shown.pairingId }));
    expect(status).toMatchObject({ state: 'pending' });
    // An approval without the fingerprint is not a valid request any more (it uses no try).
    expect(await o.request('enroll.pair.approve', { code: shown.code, approve: true })).toMatchObject({
      t: 'error',
      code: 'validation_failed',
    });
    const fingerprint = pairingFingerprint(victim.peerId);
    expect(
      await o.request('enroll.pair.approve', { code: shown.code, approve: true, fingerprint }),
    ).toMatchObject({ t: 'result', output: { state: 'approved' } });
    // Unenrolled keys can't look codes up.
    expect(await (await m.client()).request('enroll.pair.lookup', { code: shown.code })).toMatchObject({
      t: 'error',
      code: 'enrollment_required',
    });

    // Codes sprayed from the account: only what is left of its budget is evaluated (three tries were used above).
    const other = testIdentity();
    const next = output(
      await (await m.client(other)).request('enroll.pair.request', { endpoint: endpoint('Other') }),
    ) as { code: string };
    const answers = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        o.request('enroll.pair.approve', {
          code: `0000-${String(i).padStart(4, '0')}`,
          approve: true,
          fingerprint: '0000-0000-0000',
        }),
      ),
    );
    const limited = answers.filter((a) => (a as { code?: string }).code === 'rate_limited').length;
    expect(60 - limited).toBe(PAIRING_TRIES_PER_ACCOUNT - 3);
    // Even the right code is refused once the budget is spent.
    expect(
      await o.request('enroll.pair.approve', {
        code: next.code,
        approve: true,
        fingerprint: pairingFingerprint(other.peerId),
      }),
    ).toMatchObject({ t: 'error', code: 'rate_limited' });
  });
});
