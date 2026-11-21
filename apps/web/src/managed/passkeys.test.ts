import {
  ControlError,
  PASSKEY_COPY,
  PasskeyCancelled,
  PasskeyError,
  type PasskeyPlatform,
  passkeyErrorText,
  passkeySignIn,
} from '@whombat/client/managed';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteKitSaved, readKitSaved } from './kitRecord';
import { signInFailure, webPrf } from './passkeys';

describe('signInFailure (AP-804)', () => {
  const unsupported = new PasskeyError('unsupported');

  it('keeps the autofill quiet when it fails before a passkey was picked', () => {
    expect(signInFailure(unsupported, { conditional: true }, false)).toBeInstanceOf(PasskeyCancelled);
    expect(signInFailure(new Error('offline'), { conditional: true }, false)).toBeInstanceOf(
      PasskeyCancelled,
    );
  });

  it('says what went wrong once a passkey was picked from the autofill', () => {
    const invalid = new PasskeyError('invalid');
    expect(signInFailure(invalid, { conditional: true }, true)).toBe(invalid);
  });

  it('says what went wrong after a click on “Sign in with a passkey”', () => {
    expect(signInFailure(unsupported, {}, false)).toBe(unsupported);
    expect(signInFailure(unsupported, { conditional: false }, false)).toBe(unsupported);
  });
});

describe('webPrf (backup-options.md AP-6821)', () => {
  const salt = new Uint8Array(32).fill(7);
  const credential = (prf: unknown) => ({
    id: 'cred',
    rawId: new Uint8Array([1, 2, 3]).buffer,
    getClientExtensionResults: () => prf,
  });
  const stub = (get: (o: CredentialRequestOptions) => Promise<unknown>) => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    vi.stubGlobal('navigator', { credentials: { get } });
  };
  afterEach(() => vi.unstubAllGlobals());

  it('asks for the PRF of the Whombat’s passkeys with the salt, user verification required', async () => {
    let asked: CredentialRequestOptions | null = null;
    stub(async (o) => {
      asked = o;
      return credential({ prf: { results: { first: new Uint8Array(32).fill(9).buffer } } });
    });
    const got = await webPrf({ credentialIds: ['AQID'], salt });
    expect(got?.credentialId).toBe('AQID');
    expect(got?.output).toEqual(new Uint8Array(32).fill(9));
    const pk = (asked as unknown as CredentialRequestOptions).publicKey as PublicKeyCredentialRequestOptions;
    expect(pk.userVerification).toBe('required');
    expect((pk.challenge as Uint8Array).byteLength).toBe(32);
    expect(new Uint8Array(pk.allowCredentials?.[0]?.id as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    const first = (pk.extensions as { prf: { eval: { first: ArrayBuffer } } }).prf.eval.first;
    expect(new Uint8Array(first)).toEqual(salt);
  });

  it('keeps the selected credential when it has no PRF, and is cancelled when dismissed', async () => {
    stub(async () => credential({}));
    expect(await webPrf({ credentialIds: ['AQID'], salt })).toEqual({ credentialId: 'AQID', output: null });
    stub(async () => {
      throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
    });
    await expect(webPrf({ credentialIds: ['AQID'], salt })).rejects.toBeInstanceOf(PasskeyCancelled);
  });
});

describe('kitRecord (AP-6806)', () => {
  it('keeps the ways of the newest generation only', () => {
    noteKitSaved('dev_1', 1, 'file', new Date('2026-11-01T10:00:00Z'));
    noteKitSaved('dev_1', 1, 'print', new Date('2026-11-01T11:00:00Z'));
    expect(readKitSaved('dev_1')).toEqual({
      generation: 1,
      fileAt: '2026-11-01T10:00:00.000Z',
      printedAt: '2026-11-01T11:00:00.000Z',
    });
    noteKitSaved('dev_1', 2, 'print', new Date('2026-11-03T10:00:00Z'));
    expect(readKitSaved('dev_1')).toEqual({ generation: 2, printedAt: '2026-11-03T10:00:00.000Z' });
  });
});

describe('a passkey kept for a retired Whombat’s kit (backup-options.md BKO-10, AP-6823)', () => {
  const signIn = async (reason: string) => {
    const forget = vi.fn(async () => {});
    const platform = {
      get: async () => ({
        id: 'cred',
        rawId: 'cred',
        type: 'public-key',
        response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' },
        clientExtensionResults: {},
      }),
      forget,
    } as unknown as PasskeyPlatform;
    const error = await passkeySignIn(
      {
        control: {
          passkeyAuthenticateVerify: async () => {
            throw new ControlError('passkey_invalid', 'No.', {}, reason);
          },
        } as never,
        platform,
        endpoint: { peerId: 'peer', label: 'Chrome', platform: 'web' },
        registryFor: () => ({}) as never,
        openEnroll: async () => ({}) as never,
      },
      {
        prepared: {
          challengeId: 'c',
          nonce: 'n',
          endpoint: 'peer',
          options: { challenge: 'x' },
          at: Date.now(),
        },
      },
    ).catch((e: unknown) => e);
    return { error, forget };
  };

  it('says why and doesn’t tell the browser to forget it', async () => {
    const { error, forget } = await signIn('passkey_kept_for_kit');
    expect(passkeyErrorText(error)).toBe(PASSKEY_COPY.errors.kept);
    expect(forget).not.toHaveBeenCalled();
  });

  it('forgets one whose Whombat is gone', async () => {
    const { error, forget } = await signIn('passkey_unknown');
    expect(passkeyErrorText(error)).toBe(PASSKEY_COPY.errors.gone);
    expect(forget).toHaveBeenCalledWith('cred');
  });
});
