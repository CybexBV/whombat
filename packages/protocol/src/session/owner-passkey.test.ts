import { describe, expect, it } from 'vitest';
import { base64urlDecode } from '../bytes.js';
import {
  newPasskeyOwner,
  openPasskeyOwner,
  ownerPublicKey,
  passkeyLinkChallenge,
  sealPasskeyOwner,
  signOwnerPasskey,
  verifyOwnerPasskey,
} from './owner-passkey.js';

const peer = '12D3KooWJ2B9nRkz4uPogcWCvz5txFeaU91EAKxR2CKdb5zWHpCM';
const second = '12D3KooWQZJfJ6tp55ZBqfMFbXAMfaXrj5cMdEG4M3PVkNV44XHC';

describe('a shared owner passkey', () => {
  it('authenticates a roster using the authenticator handle and binds its sealed seed to the credential', () => {
    const owner = newPasskeyOwner();
    const other = newPasskeyOwner();
    const prf = new Uint8Array(32).fill(93);
    const record = signOwnerPasskey(
      {
        kind: 'whombat.owner-passkey/1',
        credentialId: 'cGFzc2tleQ',
        userHandle: owner.userHandle,
        publicKey: 'AQID',
        revision: 1,
        appliances: [peer],
        sealedSeed: sealPasskeyOwner(owner.seed, prf, 'cGFzc2tleQ'),
      },
      owner.seed,
    );
    expect(ownerPublicKey(owner.userHandle)).toHaveLength(32);
    expect(base64urlDecode(owner.userHandle).length).toBeLessThanOrEqual(64);
    expect(verifyOwnerPasskey(record, owner.userHandle)).toEqual(record);
    expect(verifyOwnerPasskey(record, other.userHandle)).toBeNull();
    // The encrypted seed is random; replacing its suffix must always change it.
    const tamperedSeed = `${record.sealedSeed.slice(0, -2)}${record.sealedSeed.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(tamperedSeed).not.toBe(record.sealedSeed);
    for (const change of [
      { appliances: [second] },
      { publicKey: 'BAUG' },
      { revision: 2 },
      { credentialId: 'b3RoZXI' },
      { sealedSeed: tamperedSeed },
    ]) {
      expect(verifyOwnerPasskey({ ...record, ...change }, owner.userHandle)).toBeNull();
    }
    expect(openPasskeyOwner(record, prf)).toEqual(owner.seed);
    expect(openPasskeyOwner(record, new Uint8Array(32).fill(94))).toBeNull();
    expect(openPasskeyOwner({ ...record, credentialId: 'b3RoZXI' }, prf)).toBeNull();
    const input = { nonce: 'a'.repeat(64), appliance: peer, endpoint: second, record };
    expect(passkeyLinkChallenge(input)).not.toBe(passkeyLinkChallenge({ ...input, appliance: second }));
    expect(passkeyLinkChallenge(input)).not.toBe(passkeyLinkChallenge({ ...input, endpoint: peer }));
    expect(passkeyLinkChallenge(input)).not.toBe(
      passkeyLinkChallenge({ ...input, record: { ...record, revision: 2 } }),
    );
  });
});
