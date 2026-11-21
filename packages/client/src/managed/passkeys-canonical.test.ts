import { base64urlDecode, base64urlEncode } from '@whombat/protocol';
import {
  EnrollPasskeyInput,
  PasskeyRegisterInput,
  passkeyUserHandleBase64url,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { fakePeerId } from '../session/fake';
import { OperationError } from '../session/managed-ops';
import {
  canonicalAssertion,
  canonicalBase64url,
  canonicalRegistration,
  passkeyFailureDetail,
} from './passkeys';

/** Standard, padded base64 of a base64url string's bytes. */
const toB64 = (s: string) => btoa(String.fromCharCode(...base64urlDecode(s)));
const bytes = (n: number, v: number) => base64urlEncode(new Uint8Array(n).fill(v));
const appliance = fakePeerId('appliance');
const userHandle = passkeyUserHandleBase64url(appliance);
const credentialId = 'YlwbBAw9xJqKn2WueISiQYW8-JOETtgadL8sLBxHUsP1Qvyu1UwpQUkUUdXokjM6WEEf3ODBH-heKk9W';
const clientDataJSON = base64urlEncode(
  new TextEncoder().encode(
    JSON.stringify({ type: 'webauthn.get', challenge: 'abc', origin: 'https://dev.whombat.com' }),
  ),
);
const authenticatorData = bytes(37, 7);
const signature = bytes(71, 9);
const enroll = (response: unknown) => ({
  nonce: 'a'.repeat(64),
  response,
  endpoint: { label: 'Firefox on Linux', platform: 'web' as const },
});

/** A password manager's assertion: padded standard base64, no extension results, its own attachment word. */
const extensionShaped = {
  id: `${toB64(credentialId)}`,
  rawId: `${toB64(credentialId)}`,
  type: 'public-key',
  response: {
    clientDataJSON: toB64(clientDataJSON),
    authenticatorData: toB64(authenticatorData),
    signature: toB64(signature),
    userHandle: toB64(userHandle),
  },
  authenticatorAttachment: 'hybrid',
};

describe('canonical WebAuthn JSON (AP-805)', () => {
  it('is what the Whombat refuses as it comes from some providers', () => {
    expect(EnrollPasskeyInput.safeParse(enroll(extensionShaped)).success).toBe(false);
  });

  it('becomes the same bytes in the contract’s shape', () => {
    const a = canonicalAssertion(extensionShaped);
    expect(EnrollPasskeyInput.safeParse(enroll(a)).success).toBe(true);
    expect(a).toEqual({
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: { clientDataJSON, authenticatorData, signature, userHandle },
      clientExtensionResults: {},
    });
  });

  it('leaves a browser’s canonical assertion as it is, and drops a null user handle and buffers in extensions', () => {
    const native = {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: { clientDataJSON, authenticatorData, signature, userHandle },
      clientExtensionResults: {},
      authenticatorAttachment: 'cross-platform',
    };
    expect(canonicalAssertion(native)).toEqual(native);
    const odd = canonicalAssertion({
      ...native,
      response: { ...native.response, userHandle: null },
      clientExtensionResults: { prf: { results: { first: new ArrayBuffer(4) } } },
    });
    expect(odd.response.userHandle).toBeUndefined();
    // The PRF's results never go anywhere (Whombat backup-passkey.md), whatever form they came in.
    expect(odd.clientExtensionResults).toEqual({ prf: {} });
    expect(EnrollPasskeyInput.safeParse(enroll(odd)).success).toBe(true);
    const phone = canonicalAssertion({
      ...native,
      clientExtensionResults: {
        prf: { results: { first: 'c2VjcmV0LXByZi1vdXRwdXQ' } },
        credProps: { rk: true },
      },
    });
    expect(JSON.stringify(phone)).not.toContain('c2VjcmV0LXByZi1vdXRwdXQ');
    expect(phone.clientExtensionResults).toEqual({ prf: {}, credProps: { rk: true } });
  });

  it('normalises a registration the same way', () => {
    const r = canonicalRegistration({
      id: toB64(credentialId),
      rawId: toB64(credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: toB64(clientDataJSON),
        attestationObject: toB64(bytes(40, 3)),
        transports: ['internal', 'hybrid', 'Not A Transport'],
        publicKeyAlgorithm: -7,
      },
    });
    expect(r.id).toBe(credentialId);
    expect(r.response.transports).toEqual(['internal', 'hybrid']);
    expect(
      PasskeyRegisterInput.safeParse({ controlNonce: 'b'.repeat(64), response: r, name: 'Firefox on Linux' })
        .success,
    ).toBe(true);
  });

  it('turns padded and standard base64 into base64url', () => {
    expect(canonicalBase64url('a+b/cw==')).toBe('a-b_cw');
    expect(canonicalBase64url('')).toBeUndefined();
    expect(canonicalBase64url(null)).toBeUndefined();
  });
});

describe('passkeyFailureDetail', () => {
  it('names the operation’s code and reason, never the input', () => {
    const e = new OperationError('enroll.passkey', 400, 'invalid_input', 'Invalid input.', { code: 'x' });
    expect(passkeyFailureDetail(e)).toBe('enroll.passkey: 400 invalid_input (x): Invalid input.');
    expect(passkeyFailureDetail(new TypeError('boom'))).toBe('TypeError: boom');
  });
});
