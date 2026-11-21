import {
  ControlError,
  PASSKEY_COPY,
  PasskeyCancelled,
  PasskeyError,
  passkeyErrorOf,
  passkeyErrorText,
} from '@whombat/client/managed';
import { toBase64url } from '@whombat/core/backup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../modules/whombat-passkeys', () => ({
  WhombatPasskeys: { supported: () => false },
  passkeyFailureCode: (e: unknown) => (e as { code?: string }).code ?? 'failed',
}));

const { phonePasskeyFailure, phonePasskeys, prfOfAssertion, prfRequest } = await import('./passkeys');

describe('passkeys through Credential Manager (AP-798)', () => {
  it('says the native rejections in the shared words', () => {
    expect(phonePasskeyFailure({ code: 'cancelled' })).toBeInstanceOf(PasskeyCancelled);
    expect(phonePasskeyFailure({ code: 'exists' })).toMatchObject({ code: 'exists' });
    expect(phonePasskeyFailure({ code: 'none' })).toMatchObject({ code: 'none' });
    expect(phonePasskeyFailure({ code: 'weird' })).toMatchObject({ code: 'failed' });
  });

  it('hands the WebAuthn JSON through and back', async () => {
    const native = {
      supported: () => true,
      create: vi.fn(async (o: unknown) => ({ made: o })),
      get: vi.fn(async () => {
        throw Object.assign(new Error('x'), { code: 'cancelled' });
      }),
    };
    const p = phonePasskeys(native as never);
    expect(await p.isAvailable()).toBe(true);
    expect(await p.supportsConditional()).toBe(false);
    expect(await p.create({ challenge: 'c' } as never)).toEqual({ made: { challenge: 'c' } });
    await expect(p.get({ challenge: 'c' })).rejects.toBeInstanceOf(PasskeyCancelled);
    expect(new PasskeyError('none').code).toBe('none');
  });

  it('a passkey kept for a retired Whombat’s kit says so (and is no `gone`, which alone is forgotten)', () => {
    const kept = new ControlError('passkey_invalid', 'Kept.', {}, 'passkey_kept_for_kit');
    expect(passkeyErrorOf(kept)).toBe('kept');
    expect(passkeyErrorText(kept)).toBe(PASSKEY_COPY.errors.kept);
  });
});

describe('PRF through the passkey prompt (backup-options-android.md AP-6855)', () => {
  it('asks for one of the Whombat’s passkeys with the salt', () => {
    const r = prfRequest({
      rpId: 'app.whombat.com',
      credentialIds: ['k1', 'k2'],
      salt: new Uint8Array([1, 2, 3]),
      challenge: new Uint8Array(32),
    });
    expect(r).toMatchObject({
      rpId: 'app.whombat.com',
      allowCredentials: [
        { id: 'k1', type: 'public-key' },
        { id: 'k2', type: 'public-key' },
      ],
      userVerification: 'required',
      extensions: { prf: { eval: { first: 'AQID' } } },
    });
  });

  it('reads the output and which passkey gave it; null without PRF', () => {
    expect(
      prfOfAssertion({
        id: 'k2',
        clientExtensionResults: { prf: { results: { first: toBase64url(new Uint8Array(32).fill(9)) } } },
      }),
    ).toEqual({ credentialId: 'k2', output: new Uint8Array(32).fill(9) });
    expect(prfOfAssertion({ id: 'k2', clientExtensionResults: {} })).toEqual({
      credentialId: 'k2',
      output: null,
    });
    expect(prfOfAssertion(null)).toBeNull();
  });

  it('offers prf only where the native module can carry it', async () => {
    const answer = {
      id: 'k1',
      clientExtensionResults: { prf: { results: { first: toBase64url(new Uint8Array(32).fill(9)) } } },
    };
    const native = { supported: () => true, prfSupported: () => true, get: vi.fn(async () => answer) };
    const p = phonePasskeys(native as never, 'app.whombat.com');
    expect(await p.prf?.({ credentialIds: ['k1'], salt: new Uint8Array([9]) })).toEqual({
      credentialId: 'k1',
      output: new Uint8Array(32).fill(9),
    });
    expect(phonePasskeys({ ...native, prfSupported: () => false } as never, 'x').prf).toBeUndefined();
    expect(phonePasskeys({ supported: () => true } as never, 'x').prf).toBeUndefined();
  });
});
