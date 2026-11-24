/** The box's own passkeys (own-address.md): made and armed in two touches, joined with one. */
import {
  fromBase64url,
  kitKeyFromPrf,
  openKitWithKey,
  sealKitWithKey,
  toBase64url,
} from '@whombat/core/backup';
import {
  boxPasskeyRegisterChallengeBase64url,
  passkeyEnrollChallengeBase64url,
} from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import { fakePeerId } from '../session/fake';
import { type ApplianceSession, NotDeliveredError } from '../session/types';
import {
  boxPasskeyCreationOptions,
  createAccountPasskey,
  createBoxPasskey,
  joinWithBoxPasskey,
} from './box-passkeys';
import { boxPasskeyOutcome, boxPasskeySetupProblem, OWN_ADDRESS_TEXT } from './own-address';
import { PASSKEY_COPY, PasskeyCancelled, PasskeyError, type PasskeyPlatform } from './passkeys';

const BOX = fakePeerId('box');
const ME = fakePeerId('new-browser');
const HOST = 'maple-otter-river.box.whombat.app';
const NONCE = 'b'.repeat(64);
const CRED = 'Y3JlZGVudGlhbC0x';
const PRF = new Uint8Array(32).fill(7);

const begin = () => ({
  nonce: NONCE,
  rpId: HOST,
  user: { id: 'u'.repeat(43), name: 'Home', displayName: 'Home · your Whombat' },
  excludeCredentialIds: ['b2xk'],
  challenge: boxPasskeyRegisterChallengeBase64url({ nonce: NONCE, appliance: BOX, rpId: HOST }),
});

const json = (o: unknown) => toBase64url(new TextEncoder().encode(JSON.stringify(o)));

const MATERIAL = JSON.stringify({
  kind: 'whombat.backup-recovery-material/1',
  applianceId: 'wb-home',
  generation: 3,
  createdAt: '2026-11-04T10:00:00Z',
  repository: 'rest:http://192.168.1.40:8747/home-3fkq/',
  restUser: 'home-3fkq',
  restPassword: 'rest-secret',
  repositoryPassword: 'repo-secret',
  repositoryId: 'repo-1',
  manifestKey: 'ed25519:AAAA',
});

const summary = {
  id: CRED,
  name: 'Chrome',
  accountId: 'acc_mara',
  personName: 'Mara',
  createdAt: '2026-11-18T10:00:00Z',
  lastUsedAt: null,
  synced: true,
  current: false,
  rpId: HOST,
};

/** A box that keeps what it's given: the backup key from the first touch, the envelope it opens on the second. */
function box(
  options: {
    setup?: 'verify' | 'saving';
    noBackups?: boolean;
    answers?: Record<string, () => { status: number; body: unknown }>;
  } = {},
) {
  const calls: { op: string; input: unknown }[] = [];
  let key: Uint8Array | null = null;
  let salt: string | null = null;
  const proof = toBase64url(new Uint8Array(32).fill(9));
  const ok = (body: unknown) => ({ status: 200, body });
  const bringBack = (setup: string) => ({
    state: setup === 'verified' ? 'ready' : 'needs_passkey',
    setup,
    passkeys: 1,
    lockedAt: null,
    nasCopyAt: null,
    paperAt: null,
  });
  const answers: Record<string, (input: never) => { status: number; body: unknown }> = {
    'boxPasskey.register.begin': () => ok(begin()),
    'boxPasskey.register': () => ok(summary),
    'backup.passkeyKey.set': (input: { salt: string; key: string }) => {
      if (options.noBackups)
        return { status: 501, body: { error: { code: 'not_implemented', message: 'No backup service.' } } };
      salt = input.salt;
      key = fromBase64url(input.key);
      return ok({ bringBack: bringBack(options.setup ?? 'verify') });
    },
    'backup.passkeyKey.verifyBegin': () =>
      ok({
        salt,
        envelope: sealKitWithKey(MATERIAL, key as Uint8Array, BOX),
        challenge: sealKitWithKey(proof, key as Uint8Array, `verification:${BOX}`),
      }),
    'backup.passkeyKey.verifyConfirm': (input: { proof: string }) =>
      input.proof === proof
        ? ok({ bringBack: bringBack('verified') })
        : { status: 403, body: { error: { code: 'forbidden' } } },
    'boxPasskey.enroll.begin': () => ok({ nonce: NONCE, rpId: HOST, timeoutMs: 120_000 }),
    'boxPasskey.enroll': () =>
      ok({
        accountId: 'acc_mara',
        name: 'Mara',
        principals: [],
        endpoint: {
          endpointId: 'end_1',
          peerId: ME,
          label: 'Chrome',
          platform: 'web',
          accountId: 'acc_mara',
          createdAt: '2026-11-18T10:00:00Z',
          lastSeenAt: '2026-11-18T10:00:00Z',
          current: true,
          revokedAt: null,
          revocation: 'none',
        },
        authzGeneration: 1,
      }),
    'boxPasskey.failed': () => ok({ ok: true }),
    ...options.answers,
  };
  const session = {
    state: () => ({ status: 'open', info: { appliance: { id: BOX } } }),
    invoke: async (op: string, input: unknown) => {
      calls.push({ op, input });
      const a = answers[op];
      return a ? a(input as never) : { status: 404, body: { error: { code: 'unknown_op' } } };
    },
  } as unknown as ApplianceSession;
  return { session, calls, key: () => key, salt: () => salt };
}

/** An authenticator: PRF at creation (`prfAtCreate`) or only on use, the same output for the same salt. */
function authenticator(options: { prfAtCreate: boolean }) {
  const seen: { create?: Record<string, unknown>; prfSalts: string[] } = { prfSalts: [] };
  const platform: PasskeyPlatform = {
    isAvailable: async () => true,
    supportsConditional: async () => false,
    async create(o) {
      seen.create = o as unknown as Record<string, unknown>;
      return {
        id: CRED,
        rawId: CRED,
        type: 'public-key',
        response: {
          clientDataJSON: json({
            type: 'webauthn.create',
            challenge: o.challenge,
            origin: `https://${HOST}`,
          }),
          attestationObject: 'o2NmbXRkbm9uZQ',
        },
        clientExtensionResults: options.prfAtCreate
          ? { prf: { enabled: true, results: { first: toBase64url(PRF) } } }
          : { prf: { enabled: true } },
      };
    },
    async get(o) {
      return {
        id: CRED,
        rawId: CRED,
        type: 'public-key',
        response: {
          clientDataJSON: json({ type: 'webauthn.get', challenge: o.challenge, origin: `https://${HOST}` }),
          authenticatorData: 'AAAA',
          signature: 'AAAA',
          userHandle: 'u'.repeat(43),
        },
        clientExtensionResults: {},
      };
    },
    async prf({ credentialIds, salt }) {
      seen.prfSalts.push(toBase64url(salt));
      return { credentialId: credentialIds[0] as string, output: new Uint8Array(PRF) };
    },
  };
  return { platform, seen };
}

describe('the options for making one', () => {
  it('are the box’s, with its RP ID, a fresh salt for PRF, discoverable and verified', () => {
    const o = boxPasskeyCreationOptions(begin(), BOX, 'c2FsdA');
    expect(o.rp.id).toBe(HOST);
    expect(o.user.displayName).toBe('Home · your Whombat');
    expect(o.excludeCredentials).toEqual([{ id: 'b2xk', type: 'public-key' }]);
    expect(o.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(o.extensions).toEqual({ prf: { eval: { first: 'c2FsdA' } } });
  });

  it('are refused when the challenge isn’t this box’s, so nothing is signed for another', () => {
    expect(() => boxPasskeyCreationOptions(begin(), fakePeerId('other-box'), 'c2FsdA')).toThrow(PasskeyError);
    expect(() =>
      boxPasskeyCreationOptions({ ...begin(), rpId: 'other-words-here.box.whombat.app' }, BOX, 'c2FsdA'),
    ).toThrow(PasskeyError);
  });
});

describe('making the box’s passkey (two touches, design §7.5)', () => {
  it('makes it, arms the backup key with a fresh salt and checks it opens the envelope', async () => {
    const b = box();
    const a = authenticator({ prfAtCreate: true });
    const made = await createBoxPasskey({
      session: b.session,
      platform: a.platform,
      appliance: BOX,
      name: 'Chrome',
    });
    expect(made).toMatchObject({ id: CRED, backups: 'verified' });
    expect(b.calls.map((c) => c.op)).toEqual([
      'boxPasskey.register.begin',
      'boxPasskey.register',
      'backup.passkeyKey.set',
      'backup.passkeyKey.verifyBegin',
      'backup.passkeyKey.verifyConfirm',
    ]);
    // The salt is random per arming (not the shared constant), and the box got the key, never the PRF output.
    const salt = b.salt() as string;
    expect(fromBase64url(salt)?.length).toBe(32);
    expect(
      (a.seen.create as { extensions: { prf: { eval: { first: string } } } }).extensions.prf.eval.first,
    ).toBe(salt);
    expect(b.key()).toEqual(kitKeyFromPrf(new Uint8Array(PRF), BOX));
    const sent = JSON.stringify(b.calls.find((c) => c.op === 'boxPasskey.register')?.input);
    expect(sent).not.toContain(toBase64url(new Uint8Array(32).fill(7)));
    // The second touch is the check, with the stored salt.
    expect(a.seen.prfSalts).toEqual([salt]);
    expect(openKitWithKey(sealKitWithKey('x', b.key() as Uint8Array, BOX), b.key() as Uint8Array, BOX)).toBe(
      'x',
    );
  });

  it('splits the first touch in two where the platform answers no PRF at creation', async () => {
    const b = box();
    const a = authenticator({ prfAtCreate: false });
    const made = await createBoxPasskey({
      session: b.session,
      platform: a.platform,
      appliance: BOX,
      name: 'Safari',
    });
    expect(made.backups).toBe('verified');
    expect(a.seen.prfSalts).toEqual([b.salt(), b.salt()]);
  });

  it('says the backups take it later while they are being saved', async () => {
    const b = box({ setup: 'saving' });
    const made = await createBoxPasskey({
      session: b.session,
      platform: authenticator({ prfAtCreate: true }).platform,
      appliance: BOX,
      name: 'Chrome',
    });
    expect(made.backups).toBe('saving');
    expect(b.calls.map((c) => c.op)).not.toContain('backup.passkeyKey.verifyBegin');
  });

  it('makes it without the backups where there is no PRF at all', async () => {
    const b = box();
    const { prf: _none, ...platform } = authenticator({ prfAtCreate: false }).platform;
    const made = await createBoxPasskey({ session: b.session, platform, appliance: BOX, name: 'Firefox' });
    expect(made.backups).toBe('unsupported');
    expect(b.calls.map((c) => c.op)).not.toContain('backup.passkeyKey.set');
  });

  it('says the passkey is made when the box has no backup service, instead of failing', async () => {
    const b = box({ noBackups: true });
    const made = await createBoxPasskey({
      session: b.session,
      platform: authenticator({ prfAtCreate: true }).platform,
      appliance: BOX,
      name: 'Chrome',
    });
    expect(made).toEqual({ id: CRED, backups: 'no_backups' });
    expect(boxPasskeyOutcome(made)).toBe(OWN_ADDRESS_TEXT.passkey.noBackups);
  });

  it('keeps the passkey made when the backup key’s touch is dismissed', async () => {
    const b = box();
    const a = authenticator({ prfAtCreate: false });
    const made = await createBoxPasskey({
      session: b.session,
      platform: { ...a.platform, prf: async () => Promise.reject(new PasskeyCancelled()) },
      appliance: BOX,
      name: 'Safari',
    });
    expect(made.backups).toBe('not_armed');
  });
});

describe('when making it fails', () => {
  /** What the page told the box, once it has. */
  const reported = async (b: ReturnType<typeof box>) => {
    await vi.waitFor(() => expect(b.calls.some((c) => c.op === 'boxPasskey.failed')).toBe(true));
    return b.calls.find((c) => c.op === 'boxPasskey.failed')?.input;
  };

  it('tells the box the browser’s own reason, and the person the way on', async () => {
    const b = box();
    const browser = Object.assign(new Error('The authenticator had a problem.'), { name: 'UnknownError' });
    const failure = createBoxPasskey({
      session: b.session,
      platform: {
        ...authenticator({ prfAtCreate: true }).platform,
        create: async () => Promise.reject(new PasskeyError('failed', undefined, { cause: browser })),
      },
      appliance: BOX,
      name: 'Chrome',
    });
    const error = await failure.catch((e: unknown) => e);
    expect(await reported(b)).toMatchObject({ stage: 'create', code: 'failed', name: 'UnknownError' });
    expect((await reported(b)) as { detail: string }).toMatchObject({
      detail: expect.stringContaining('authenticator had a problem'),
    });
    expect(boxPasskeySetupProblem(error)).toBe(OWN_ADDRESS_TEXT.passkey.failed);
    expect(OWN_ADDRESS_TEXT.passkey.failed).toContain('Later');
  });

  it('names the box’s refusal, and sends the person to the new address after a move', async () => {
    const moved = { code: 'address_moved', host: 'new-name.whombat.app' };
    const b = box({
      answers: {
        'boxPasskey.register.begin': () => ({
          status: 409,
          body: { error: { code: 'conflict', message: 'Moved.', details: moved } },
        }),
      },
    });
    const error = await createBoxPasskey({
      session: b.session,
      platform: authenticator({ prfAtCreate: true }).platform,
      appliance: BOX,
      name: 'Chrome',
    }).catch((e: unknown) => e);
    expect(await reported(b)).toMatchObject({ stage: 'begin', code: 'failed', name: 'address_moved' });
    expect(boxPasskeySetupProblem(error)).toBe(OWN_ADDRESS_TEXT.passkey.moved);
  });

  it('says to check the connection when the Whombat stops answering on the way', async () => {
    const b = box();
    const offline = {
      ...b.session,
      invoke: async () => Promise.reject(new NotDeliveredError('end_1', 'req_1')),
    } as unknown as ApplianceSession;
    const error = await createBoxPasskey({
      session: offline,
      platform: authenticator({ prfAtCreate: true }).platform,
      appliance: BOX,
      name: 'Chrome',
    }).catch((e: unknown) => e);
    expect(boxPasskeySetupProblem(error)).toBe(PASSKEY_COPY.errors.unreachable);
  });

  it('tells the box of a dismissed prompt too, and says nothing to the person', async () => {
    const b = box();
    const error = await createBoxPasskey({
      session: b.session,
      platform: {
        ...authenticator({ prfAtCreate: true }).platform,
        create: async () => Promise.reject(new PasskeyCancelled()),
      },
      appliance: BOX,
      name: 'Chrome',
    }).catch((e: unknown) => e);
    expect(await reported(b)).toMatchObject({ stage: 'create', code: 'cancelled' });
    expect(boxPasskeySetupProblem(error)).toBeNull();
  });

  it('goes on as before with a box that doesn’t take the report', async () => {
    const b = box({
      answers: { 'boxPasskey.failed': () => ({ status: 404, body: { error: { code: 'unknown_op' } } }) },
    });
    const error = await createBoxPasskey({
      session: b.session,
      platform: {
        ...authenticator({ prfAtCreate: true }).platform,
        create: async () => Promise.reject(new PasskeyError('failed')),
      },
      appliance: BOX,
      name: 'Chrome',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PasskeyError);
    await reported(b);
  });
});

describe('joining with the box’s passkey (design §7.3)', () => {
  it('binds the assertion to this device’s key with the box’s nonce', async () => {
    const b = box();
    const asked: string[] = [];
    const platform = authenticator({ prfAtCreate: true }).platform;
    const out = await joinWithBoxPasskey({
      session: b.session,
      platform: {
        get: (o) => {
          asked.push(o.challenge);
          return platform.get(o);
        },
      },
      endpointPeerId: ME,
      endpoint: { label: 'Chrome', platform: 'web' },
    });
    expect(out.accountId).toBe('acc_mara');
    expect(asked).toEqual([passkeyEnrollChallengeBase64url({ nonce: NONCE, endpoint: ME })]);
    expect(b.calls.at(-1)).toMatchObject({ op: 'boxPasskey.enroll', input: { nonce: NONCE } });
  });
});

describe('the account passkey (design §7.5)', () => {
  it('asks control for one that names no Whombat, without PRF', async () => {
    const asked: unknown[] = [];
    const out = await createAccountPasskey({
      control: {
        passkeyRegisterOptions: async (input) => {
          asked.push(input);
          return {
            options: {
              rp: { id: 'app.whombat.com', name: 'Whombat' },
              user: { id: 'dXNlcg', name: 'mara@burrowhq.example', displayName: 'Whombat account' },
              challenge: 'Y2hhbGxlbmdl',
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
              extensions: { prf: {} },
            },
          };
        },
        passkeyRegisterVerify: async (input) => ({ id: CRED, name: input.name }),
      },
      platform: {
        create: async (o) => {
          expect(o.extensions).toBeUndefined();
          return authenticator({ prfAtCreate: false }).platform.create(o);
        },
      },
      name: 'Chrome',
    });
    expect(asked).toEqual([{}]);
    expect(out).toEqual({ id: CRED, name: 'Chrome' });
  });
});
