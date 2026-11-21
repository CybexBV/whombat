import { describe, expect, it } from 'vitest';
import {
  b64urlToBuffer,
  bufferToB64url,
  creationOptionsFromJSON,
  credentialToJSON,
  type CredentialLike,
  isIpHost,
  passkeyErrorMessage,
  requestOptionsFromJSON,
  serializeCredential,
  toCreationOptions,
  toRequestOptions,
  unwrapOptions,
} from './webauthn';

const bytes = (...b: number[]) => new Uint8Array(b).buffer;
const arr = (b: ArrayBuffer | BufferSource | undefined) => Array.from(new Uint8Array(b as ArrayBuffer));

describe('base64url', () => {
  it('round-trips every byte value and length', () => {
    for (let len = 0; len < 70; len++) {
      const src = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff);
      const enc = bufferToB64url(src.buffer);
      expect(enc).not.toMatch(/[+/=]/);
      expect(arr(b64urlToBuffer(enc))).toEqual(Array.from(src));
    }
  });

  it('decodes padded, unpadded and standard base64 input', () => {
    expect(arr(b64urlToBuffer('-_8'))).toEqual([0xfb, 0xff]);
    expect(arr(b64urlToBuffer('-_8='))).toEqual([0xfb, 0xff]);
    expect(arr(b64urlToBuffer('+/8='))).toEqual([0xfb, 0xff]);
    expect(bufferToB64url(bytes(0xfb, 0xff))).toBe('-_8');
  });

  it('encodes typed-array views with an offset', () => {
    const big = new Uint8Array([9, 9, 1, 2, 3, 9]);
    expect(bufferToB64url(big.subarray(2, 5))).toBe(bufferToB64url(bytes(1, 2, 3)));
  });

  it('encodes large buffers', () => {
    const big = new Uint8Array(100_000).map((_, i) => i & 0xff);
    expect(arr(b64urlToBuffer(bufferToB64url(big)))).toEqual(Array.from(big));
  });
});

const CHALLENGE = bufferToB64url(bytes(1, 2, 3, 4));
const CRED_ID = bufferToB64url(bytes(7, 7, 7));
const USER_ID = bufferToB64url(bytes(42, 43));

describe('request options', () => {
  const inner = {
    challenge: CHALLENGE,
    timeout: 300000,
    rpId: 'rackoon.example',
    allowCredentials: [{ type: 'public-key', id: CRED_ID, transports: ['internal'] }],
    userVerification: 'preferred',
  };

  it('accepts the go-webauthn {publicKey} wrapper and a bare object alike', () => {
    for (const json of [{ publicKey: inner, mediation: 'optional' }, inner]) {
      const o = requestOptionsFromJSON(json);
      expect(arr(o.challenge)).toEqual([1, 2, 3, 4]);
      expect(arr(o.allowCredentials?.[0]?.id)).toEqual([7, 7, 7]);
      expect(o.allowCredentials?.[0]?.transports).toEqual(['internal']);
      expect(o.rpId).toBe('rackoon.example');
      expect(o.userVerification).toBe('preferred');
      expect(o.timeout).toBe(300000);
    }
  });

  it('leaves allowCredentials out when the hub omits it (discoverable login)', () => {
    const o = requestOptionsFromJSON({ publicKey: { challenge: CHALLENGE, rpId: 'r.example', allowCredentials: null } });
    expect('allowCredentials' in o).toBe(false);
  });

  it('falls back to the manual conversion without the native parser (node)', () => {
    expect(arr(toRequestOptions({ publicKey: inner }).challenge)).toEqual([1, 2, 3, 4]);
  });

  it('rejects garbage', () => {
    expect(() => requestOptionsFromJSON(null)).toThrow();
    expect(() => requestOptionsFromJSON({ publicKey: { challenge: 5 } })).toThrow(/challenge/);
    expect(() => unwrapOptions('x')).toThrow();
  });
});

describe('creation options', () => {
  const json = {
    publicKey: {
      rp: { name: 'Rackoon', id: 'rackoon.example' },
      user: { name: 'admin', displayName: 'admin', id: USER_ID },
      challenge: CHALLENGE,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 300000,
      excludeCredentials: [{ type: 'public-key', id: CRED_ID }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
      attestation: 'none',
    },
  };

  it('decodes challenge, user.id and excludeCredentials ids', () => {
    for (const o of [creationOptionsFromJSON(json), creationOptionsFromJSON(json.publicKey), toCreationOptions(json)]) {
      expect(arr(o.challenge)).toEqual([1, 2, 3, 4]);
      expect(arr(o.user.id)).toEqual([42, 43]);
      expect(o.user.name).toBe('admin');
      expect(arr(o.excludeCredentials?.[0]?.id)).toEqual([7, 7, 7]);
      expect(o.rp).toEqual({ name: 'Rackoon', id: 'rackoon.example' });
      expect(o.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
      expect(o.authenticatorSelection?.residentKey).toBe('required');
    }
  });

  it('needs a user', () => {
    expect(() => creationOptionsFromJSON({ challenge: CHALLENGE })).toThrow(/user/);
  });
});

describe('credential serialization', () => {
  const assertion: CredentialLike = {
    id: CRED_ID,
    rawId: bytes(7, 7, 7),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: { clientDataJSON: bytes(1), authenticatorData: bytes(2, 2), signature: bytes(3, 3, 3), userHandle: bytes(42, 43) },
    getClientExtensionResults: () => ({}),
  };

  it('serializes an assertion', () => {
    expect(serializeCredential(assertion)).toEqual({
      id: CRED_ID,
      rawId: CRED_ID,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: { clientDataJSON: 'AQ', authenticatorData: 'AgI', signature: 'AwMD', userHandle: USER_ID },
      clientExtensionResults: {},
    });
  });

  it('maps an empty user handle to null', () => {
    const r = serializeCredential({ ...assertion, response: { ...assertion.response, userHandle: new ArrayBuffer(0) } });
    expect((r.response as { userHandle: string | null }).userHandle).toBeNull();
  });

  it('serializes an attestation with transports', () => {
    const att: CredentialLike = {
      id: CRED_ID,
      rawId: bytes(7, 7, 7),
      type: 'public-key',
      authenticatorAttachment: null,
      response: { clientDataJSON: bytes(1), attestationObject: bytes(5, 5), getTransports: () => ['internal', 'hybrid'] },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    };
    expect(serializeCredential(att)).toEqual({
      id: CRED_ID,
      rawId: CRED_ID,
      type: 'public-key',
      authenticatorAttachment: null,
      response: { clientDataJSON: 'AQ', attestationObject: 'BQU', transports: ['internal', 'hybrid'] },
      clientExtensionResults: { credProps: { rk: true } },
    });
  });

  it('prefers the native toJSON and falls back when it throws or looks wrong', () => {
    const native = { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'AQ' } };
    expect(credentialToJSON({ ...assertion, toJSON: () => native })).toBe(native);
    expect(credentialToJSON({ ...assertion, toJSON: () => { throw new Error('broken'); } })).toEqual(serializeCredential(assertion));
    expect(credentialToJSON({ ...assertion, toJSON: () => ({}) })).toEqual(serializeCredential(assertion));
  });
});

describe('errors', () => {
  it('explains cancellations and IP-address origins', () => {
    expect(passkeyErrorMessage(new DOMException('x', 'NotAllowedError'), 'rackoon.example')).toMatch(/cancelled/);
    expect(passkeyErrorMessage(new DOMException('x', 'SecurityError'), '10.100.0.6')).toMatch(/need a host name.*10\.100\.0\.6/);
    expect(passkeyErrorMessage(new DOMException('x', 'SecurityError'), 'rackoon.example')).not.toMatch(/IP address/);
    expect(passkeyErrorMessage(new Error('The passkey was not accepted.'), 'h')).toBe('The passkey was not accepted.');
  });

  it('detects IP hosts', () => {
    expect(isIpHost('192.168.1.10')).toBe(true);
    expect(isIpHost('[::1]')).toBe(true);
    expect(isIpHost('localhost')).toBe(false);
    expect(isIpHost('hub.lan')).toBe(false);
  });
});
