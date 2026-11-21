/** Needs Postgres: two appliances persist independent credential/account bindings and audit chains. */
import { randomBytes } from 'node:crypto';
import {
  newPasskeyOwner,
  passkeyEnrollChallengeBase64url,
  passkeyLinkChallenge,
  passkeyRegisterChallengeBase64url,
  sealPasskeyOwner,
  signOwnerPasskey,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { IDS } from '../seed/test-world';
import { TEST_APP_URL } from '../test/harness';
import { useManagedRuntime } from '../test/managed';
import { SoftwareAuthenticator } from '../test/webauthn';
import { testIdentity } from './testing';

const first = useManagedRuntime({ seed: true });
const second = useManagedRuntime({ seed: true });
const out = <T = Record<string, unknown>>(r: unknown) => (r as { output: T }).output;
const rpId = new URL(TEST_APP_URL).hostname;

describe('one shared passkey on independent appliances', () => {
  it('requires enrolled linking, a signed roster and a fresh bound assertion, then enrolls the same endpoint on both', async () => {
    const a = await first.enroll(IDS.mara);
    const b = await second.enroll(IDS.mara);
    const ca = await first.client(a);
    const cb = await second.client(b);
    const owner = newPasskeyOwner();
    const auth = new SoftwareAuthenticator();
    const controlNonce = randomBytes(32).toString('hex');
    const begin = out<{ applianceNonce: string; user: { id: string } }>(
      await ca.request('passkey.register.begin', { ownerHandle: owner.userHandle }),
    );
    expect(begin.user.id).toBe(owner.userHandle);
    const response = auth.create({
      rpId,
      origin: TEST_APP_URL,
      userId: owner.userHandle,
      challenge: passkeyRegisterChallengeBase64url({
        appliance: first.appliance.peerId,
        applianceNonce: begin.applianceNonce,
        controlNonce,
      }),
    });
    const saved = out<{ id: string; publicKey: string; ownerHandle: string }>(
      await ca.request('passkey.register', { controlNonce, response, name: 'My Whombats' }),
    );
    expect(saved.ownerHandle).toBe(owner.userHandle);
    const record = signOwnerPasskey(
      {
        kind: 'whombat.owner-passkey/1',
        credentialId: saved.id,
        userHandle: owner.userHandle,
        publicKey: saved.publicKey,
        revision: 1,
        appliances: [first.appliance.peerId, second.appliance.peerId],
        sealedSeed: sealPasskeyOwner(owner.seed, new Uint8Array(32).fill(5), saved.id),
      },
      owner.seed,
    );
    const linkBegin = async () =>
      out<{ applianceNonce: string; endpoint: string }>(
        await cb.request('passkey.register.begin', { ownerHandle: owner.userHandle }),
      );
    const link = async (tamper = false, wrongEndpoint = false) => {
      const begin = await linkBegin();
      const response = auth.get({
        rpId,
        origin: TEST_APP_URL,
        userHandle: null,
        challenge: passkeyLinkChallenge({
          nonce: begin.applianceNonce,
          endpoint: wrongEndpoint ? a.peerId : begin.endpoint,
          appliance: second.appliance.peerId,
          record,
        }),
      });
      return cb.request('passkey.link', {
        name: 'My Whombats',
        record: tamper ? { ...record, publicKey: 'AQID' } : record,
        response,
      });
    };
    expect(await link(true)).toMatchObject({ t: 'error', details: { code: 'passkey_invalid' } });
    expect(await link(false, true)).toMatchObject({ t: 'error', details: { code: 'passkey_invalid' } });
    expect(await link()).toMatchObject({
      t: 'result',
      output: { id: saved.id, ownerHandle: owner.userHandle, accountId: b.accountId },
    });
    const endpoint = testIdentity();
    const nonce = randomBytes(32).toString('hex');
    const assertion = auth.get({
      rpId,
      origin: TEST_APP_URL,
      challenge: passkeyEnrollChallengeBase64url({ nonce, endpoint: endpoint.peerId }),
    });
    for (const box of [first, second]) {
      const client = await box.client(endpoint);
      expect(
        await client.request('enroll.passkey', {
          nonce,
          response: assertion,
          endpoint: { label: 'Brave with 1Password', platform: 'web' },
        }),
      ).toMatchObject({ t: 'result' });
      client.close();
    }
    expect(await ca.request('passkey.remove', { id: saved.id })).toMatchObject({ t: 'result' });
    expect(out<{ passkeys: { id: string }[] }>(await cb.request('passkeys.list', {})).passkeys).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: saved.id })]),
    );
    ca.close();
    cb.close();
  });
});
