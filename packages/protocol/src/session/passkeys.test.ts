import { describe, expect, it } from 'vitest';
import { base64urlEncode, utf8Encode } from '../bytes.js';
import {
  EnrollPasskeyInput,
  PasskeyRegisterInput,
  PasskeysListOutput,
  parsePasskeyUserHandle,
  passkeyEnrollChallenge,
  passkeyEnrollChallengeBase64url,
  passkeyRegisterChallenge,
  passkeyRegisterChallengeBase64url,
  passkeyUserHandle,
  passkeyUserHandleBase64url,
} from './passkeys.js';

const APPLIANCE = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const ENDPOINT = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// Fixed vectors, computed independently (Python: hashlib.sha256 over json.dumps(sort_keys, compact)).
const ENROLL = { nonce: `${'00'.repeat(16)}${'ff'.repeat(16)}`, endpoint: ENDPOINT };
const ENROLL_SHA256 = 'd3d94850d5cfd3dd7b616b3e6f27992f7aa683c9690fc2a080cc441f004177be';
const REGISTER = {
  controlNonce: '0123456789abcdef'.repeat(4),
  applianceNonce: 'a5'.repeat(32),
  appliance: APPLIANCE,
};
const REGISTER_SHA256 = '0a98b39211393ddd7e023abc6c1fa653ff653843e48e317987531365f397fa83';

describe('passkey user handles (PK-01)', () => {
  it('is wb1: and the PeerId, 56 bytes', () => {
    const handle = passkeyUserHandle(APPLIANCE);
    expect(handle.length).toBe(56);
    expect(passkeyUserHandleBase64url(APPLIANCE)).toBe(
      'd2IxOjEyRDNLb29XOXc2RFNWU0gzYzFlYTU3YUtadnQxdUFDaVFBNVREd3l6ZUJYRDlnalFzdEg',
    );
    expect(() => passkeyUserHandle('12D3KooWnope')).toThrow();
  });

  it('parses back from base64url or bytes; anything else names no Whombat', () => {
    expect(parsePasskeyUserHandle(passkeyUserHandleBase64url(APPLIANCE))).toBe(APPLIANCE);
    expect(parsePasskeyUserHandle(passkeyUserHandle(APPLIANCE))).toBe(APPLIANCE);
    // An account-level passkey of control (CL-11): random bytes.
    expect(parsePasskeyUserHandle(base64urlEncode(new Uint8Array(32).fill(7)))).toBeNull();
    expect(parsePasskeyUserHandle(utf8Encode(`wb2:${APPLIANCE}`))).toBeNull();
    expect(parsePasskeyUserHandle(utf8Encode('wb1:12D3KooWnope'))).toBeNull();
    expect(parsePasskeyUserHandle(utf8Encode(`wb1:${APPLIANCE} `))).toBeNull();
    expect(parsePasskeyUserHandle('not base64url!')).toBeNull();
    expect(parsePasskeyUserHandle(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe('passkey challenges (PK-03)', () => {
  it('match the fixed vectors', () => {
    expect(hex(passkeyEnrollChallenge(ENROLL))).toBe(ENROLL_SHA256);
    expect(passkeyEnrollChallengeBase64url(ENROLL)).toBe('09lIUNXP0917YWs-byeZL3qmg8lpD8KggMxEHwBBd74');
    expect(hex(passkeyRegisterChallenge(REGISTER))).toBe(REGISTER_SHA256);
    expect(passkeyRegisterChallengeBase64url(REGISTER)).toBe('CpizkhE5Pd1-Ajq8bB-mU_9lOEPkjjF5h1MTZfOX-oM');
  });

  it('bind the endpoint and both nonces', () => {
    expect(hex(passkeyEnrollChallenge({ ...ENROLL, endpoint: APPLIANCE }))).not.toBe(ENROLL_SHA256);
    expect(hex(passkeyRegisterChallenge({ ...REGISTER, applianceNonce: REGISTER.controlNonce }))).not.toBe(
      REGISTER_SHA256,
    );
  });

  it('refuse malformed input', () => {
    expect(() => passkeyEnrollChallenge({ ...ENROLL, nonce: 'ab'.repeat(16) })).toThrow();
    expect(() => passkeyEnrollChallenge({ ...ENROLL, nonce: 'AB'.repeat(32) })).toThrow();
    expect(() => passkeyRegisterChallenge({ ...REGISTER, appliance: 'x' })).toThrow();
  });
});

describe('passkey op inputs', () => {
  const assertion = {
    id: 'q3Vx9LpA0dZkT7mW2bNcYe',
    rawId: 'q3Vx9LpA0dZkT7mW2bNcYe',
    type: 'public-key',
    response: {
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAQ',
      signature: 'MEUCIQDexample',
      userHandle: passkeyUserHandleBase64url(APPLIANCE),
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };
  const endpoint = { label: 'Chrome on Linux', platform: 'web' };

  it('enroll.passkey: strict around the WebAuthn JSON, which drops unknown members', () => {
    const nonce = ENROLL.nonce;
    expect(EnrollPasskeyInput.safeParse({ nonce, response: assertion, endpoint }).success).toBe(true);
    const newer = { ...assertion, response: { ...assertion.response, extra: 1 }, extra: 2 };
    const parsed = EnrollPasskeyInput.parse({ nonce, response: newer, endpoint });
    expect(parsed.response).toEqual(assertion);
    expect(EnrollPasskeyInput.safeParse({ nonce, response: assertion, endpoint, x: 1 }).success).toBe(false);
    expect(
      EnrollPasskeyInput.safeParse({ nonce: 'ab'.repeat(16), response: assertion, endpoint }).success,
    ).toBe(false);
    expect(
      EnrollPasskeyInput.safeParse({ nonce, response: { ...assertion, type: 'password' }, endpoint }).success,
    ).toBe(false);
  });

  it('passkey.register needs a name', () => {
    const response = {
      id: 'q3Vx9LpA0dZkT7mW2bNcYe',
      rawId: 'q3Vx9LpA0dZkT7mW2bNcYe',
      type: 'public-key',
      response: {
        clientDataJSON: 'eyJ9',
        attestationObject: 'o2NmbXRkbm9uZQ',
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: { credProps: { rk: true } },
    };
    const controlNonce = REGISTER.controlNonce;
    expect(PasskeyRegisterInput.safeParse({ controlNonce, response, name: 'Pixel 9' }).success).toBe(true);
    expect(PasskeyRegisterInput.safeParse({ controlNonce, response, name: ' ' }).success).toBe(false);
    expect(PasskeyRegisterInput.safeParse({ controlNonce, response }).success).toBe(false);
  });

  it('passkeys.list carries the policy', () => {
    expect(
      PasskeysListOutput.safeParse({
        passkeys: [
          {
            id: 'q3Vx9LpA0dZkT7mW2bNcYe',
            name: 'Chrome on Linux',
            accountId: 'acc_mara0001',
            personName: 'Mara',
            createdAt: '2026-10-05T12:00:00Z',
            lastUsedAt: null,
            synced: true,
            current: false,
          },
        ],
        policy: { deviceBoundOnly: false },
      }).success,
    ).toBe(true);
  });
});
