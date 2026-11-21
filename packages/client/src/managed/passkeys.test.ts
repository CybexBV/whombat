import { KIT_PRF_SALT_V2_B64, kitKeyFromPrf, toBase64url } from '@whombat/core/backup';
import {
  newPasskeyOwner,
  PASSKEY_ENROLL_PURPOSE,
  passkeyEnrollChallengeBase64url,
  passkeyRegisterChallengeBase64url,
  passkeyUserHandleBase64url,
  sealPasskeyOwner,
  signOwnerPasskey,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { fakePeerId } from '../session/fake';
import type { ApplianceSession } from '../session/types';
import type { ApplianceSummary, ControlSession } from './control';
import { ControlError, controlErrorCodeOf, createHttpControl, storageTokenStore } from './control';
import { deliverBackupKey, heldBackupKey } from './passkey-backup-key';
import {
  createPasskeyNudge,
  createSeenDevices,
  keepOnlyLivePasskeys,
  PASSKEY_COPY,
  type PasskeyAssertionJSON,
  PasskeyCancelled,
  PasskeyError,
  type PasskeyPlatform,
  type PasskeySignInDeps,
  passkeyEnrolledDevices,
  passkeyErrorOf,
  passkeyErrorText,
  passkeyRegister,
  passkeyRemove,
  passkeySignIn,
  preparePasskeySignIn,
  registrationOptionsFor,
} from './passkeys';
import { createRegistry, type SyncStorage } from './registry';

const NONCE = 'a'.repeat(64);
const ENDPOINT = fakePeerId('new-browser');
const WHOMBAT = fakePeerId('burrow-hq');
const IMPOSTOR = fakePeerId('impostor');
const DEVICE = 'dev_7KQ2M4XD';
const ORG = 'org_burrowhq';

function memory(): SyncStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

const cloud: ControlSession = {
  account: { accountId: 'acc_mara', email: 'mara@burrowhq.example', name: 'Mara' },
  orgs: [{ orgId: ORG, name: 'Burrow HQ' }],
};

const entry = (over: Partial<ApplianceSummary> = {}): ApplianceSummary => ({
  device: DEVICE,
  orgId: ORG,
  name: 'Burrow HQ',
  state: 'claimed',
  contentPeerId: WHOMBAT,
  lastSeenAt: null,
  revocationsPending: 0,
  ...over,
});

function assertion(handleFor: string | null = WHOMBAT): PasskeyAssertionJSON {
  return {
    id: 'cred_1',
    rawId: 'cred_1',
    type: 'public-key',
    response: {
      clientDataJSON: 'e30',
      authenticatorData: 'AAAA',
      signature: 'AAAA',
      ...(handleFor ? { userHandle: passkeyUserHandleBase64url(handleFor) } : {}),
    },
    clientExtensionResults: {},
  };
}

/** A session stub: records ops, answers from `answers`. */
function stubSession(answers: Record<string, (input: unknown) => { status: number; body: unknown }>) {
  const calls: { op: string; input: unknown }[] = [];
  let closed = false;
  const session = {
    state: () => ({
      status: 'open',
      info: {
        protocol: { major: 2, minor: 0 },
        capabilities: [],
        appliance: { id: WHOMBAT, name: null },
        account: null,
        endpointId: null,
        authzGeneration: 1,
        clearCache: false,
        channel: 'enroll',
        direct: null,
        edition: 'commercial',
      },
    }),
    invoke: async (op: string, input: unknown) => {
      calls.push({ op, input });
      const answer = answers[op];
      return answer ? answer(input) : { status: 404, body: { error: { code: 'unknown_op' } } };
    },
    close: () => {
      closed = true;
    },
  } as unknown as ApplianceSession;
  return { session, calls, closed: () => closed };
}

const enrolledBody = {
  accountId: 'acc_mara',
  name: 'Mara',
  principals: [],
  endpoint: {
    endpointId: 'end_1',
    peerId: ENDPOINT,
    label: 'Chrome on Linux',
    platform: 'web',
    accountId: 'acc_mara',
    createdAt: '2026-10-05T10:00:00Z',
    lastSeenAt: '2026-10-05T10:00:00Z',
    current: true,
    revokedAt: null,
    revocation: 'none',
  },
  authzGeneration: 1,
};

function world(
  input: {
    challenge?: string;
    handle?: string | null;
    directory?: ApplianceSummary[];
    storage?: SyncStorage;
    enrollAnswer?: { status: number; body: unknown };
    verify?: () => Promise<ControlSession>;
  } = {},
) {
  const storage = input.storage ?? memory();
  const enroll = stubSession({
    'enroll.passkey': () => input.enrollAnswer ?? { status: 200, body: enrolledBody },
  });
  const gets: unknown[] = [];
  const forgot: string[] = [];
  const kept: { userId: string; ids: string[] }[] = [];
  const platform: PasskeyPlatform = {
    isAvailable: async () => true,
    supportsConditional: async () => true,
    create: async () => {
      throw new Error('not here');
    },
    get: async (options) => {
      gets.push(options);
      return assertion(input.handle === undefined ? WHOMBAT : input.handle);
    },
    forget: async (id) => void forgot.push(id),
    keepOnly: async (userId, ids) => void kept.push({ userId, ids: [...ids] }),
  };
  const deleted: string[] = [];
  const opened: { orgId: string; device: string; peerId: string }[] = [];
  const deps: PasskeySignInDeps = {
    control: {
      passkeyAuthenticateOptions: async (endpoint) => ({
        challengeId: 'wac_1',
        nonce: NONCE,
        options: {
          challenge: input.challenge ?? passkeyEnrollChallengeBase64url({ nonce: NONCE, endpoint }),
          rpId: 'app.whombat.com',
          allowCredentials: [{ id: 'chosen', type: 'public-key' }],
        },
      }),
      passkeyAuthenticateVerify: input.verify ?? (async () => cloud),
      appliances: async () => input.directory ?? [entry()],
      deletePasskey: async (id) => void deleted.push(id),
    },
    platform,
    endpoint: { peerId: ENDPOINT, label: 'Chrome on Linux', platform: 'web' },
    registryFor: (accountId) => createRegistry(accountId, storage),
    openEnroll: async (t) => {
      opened.push(t);
      return enroll.session;
    },
  };
  return { deps, storage, enroll, gets, opened, forgot, kept, deleted };
}

describe('passkey sign-in (PK-04)', () => {
  it('refuses a challenge other than the one this device computes, before anything is signed', async () => {
    const w = world({ challenge: passkeyEnrollChallengeBase64url({ nonce: NONCE, endpoint: IMPOSTOR }) });
    await expect(passkeySignIn(w.deps)).rejects.toMatchObject({ code: 'challenge_mismatch' });
    expect(w.gets).toEqual([]);
    // A nonce control didn't send is the same refusal.
    await expect(
      preparePasskeySignIn(
        { passkeyAuthenticateOptions: async () => ({ challengeId: 'x', options: { challenge: 'abc' } }) },
        ENDPOINT,
      ),
    ).rejects.toBeInstanceOf(PasskeyError);
    expect(PASSKEY_ENROLL_PURPOSE).toBe('whombat-passkey-enroll/1');
  });

  it('asks for a discoverable, verified passkey (never a list control chose)', async () => {
    const prepared = await preparePasskeySignIn(world().deps.control, ENDPOINT);
    expect(prepared.options.allowCredentials).toBeUndefined();
    expect(prepared.options.userVerification).toBe('required');
  });

  it('pins the Whombat the passkey names, enrolls with enroll.passkey and opens it', async () => {
    const w = world();
    const out = await passkeySignIn(w.deps);
    expect(out).toMatchObject({ kind: 'open', enrolled: true, known: { device: DEVICE, peerId: WHOMBAT } });
    expect(w.opened).toEqual([{ orgId: ORG, device: DEVICE, peerId: WHOMBAT }]);
    expect(w.enroll.calls).toEqual([
      {
        op: 'enroll.passkey',
        input: {
          nonce: NONCE,
          response: assertion(),
          endpoint: { label: 'Chrome on Linux', platform: 'web' },
        },
      },
    ]);
    expect(w.enroll.closed()).toBe(true);
    const registry = createRegistry('acc_mara', w.storage);
    expect(registry.get(DEVICE)).toMatchObject({
      pinSource: 'passkey',
      enrolled: true,
      accountId: 'acc_mara',
      peerId: WHOMBAT,
    });
    expect(registry.lastUsed()).toBe(DEVICE);
  });

  it('opens a Whombat this device is already let in to without enrolling again', async () => {
    const storage = memory();
    createRegistry('acc_mara', storage).put({
      device: DEVICE,
      orgId: ORG,
      name: 'Old name',
      peerId: WHOMBAT,
      pinSource: 'claim',
      enrolled: true,
      kitPending: false,
    });
    const w = world({ storage });
    const out = await passkeySignIn(w.deps);
    expect(out).toMatchObject({
      kind: 'open',
      enrolled: false,
      known: { pinSource: 'claim', name: 'Burrow HQ' },
    });
    expect(w.opened).toEqual([]);
    expect(createRegistry('acc_mara', storage).lastUsed()).toBe(DEVICE);
  });

  it('stops hard when this device pinned another identity than the directory, sending nothing', async () => {
    const storage = memory();
    createRegistry('acc_mara', storage).put({
      device: DEVICE,
      orgId: ORG,
      name: null,
      peerId: WHOMBAT,
      pinSource: 'kit',
      enrolled: false,
      kitPending: false,
    });
    const w = world({ storage, directory: [entry({ contentPeerId: IMPOSTOR })] });
    const out = await passkeySignIn(w.deps);
    expect(out).toMatchObject({ kind: 'changed', device: DEVICE, session: cloud });
    expect(w.opened).toEqual([]);
    expect(createRegistry('acc_mara', storage).get(DEVICE)?.peerId).toBe(WHOMBAT);
  });

  it('a passkey of a Whombat the directory doesn’t list (or lists under another identity) is not in the org', async () => {
    const w = world({ handle: IMPOSTOR });
    expect(await passkeySignIn(w.deps)).toMatchObject({ kind: 'not_in_org', session: cloud });
    expect(w.opened).toEqual([]);
    expect(createRegistry('acc_mara', w.storage).list()).toEqual([]);
  });

  it('an account-level passkey (no wb1: handle) only signs in', async () => {
    const w = world({ handle: null });
    expect(await passkeySignIn(w.deps)).toEqual({ kind: 'signed_in', session: cloud });
  });

  it('a retired Whombat is never pinned; its passkey is forgotten by the browser and control', async () => {
    const w = world({ directory: [entry({ state: 'retired' })] });
    expect(await passkeySignIn(w.deps)).toMatchObject({ kind: 'retired', name: 'Burrow HQ' });
    expect(createRegistry('acc_mara', w.storage).list()).toEqual([]);
    expect(w.kept).toEqual([{ userId: passkeyUserHandleBase64url(WHOMBAT), ids: [] }]);
    expect(w.deleted).toEqual(['cred_1']);
  });

  it('a passkey control doesn’t know (its Whombat gone) is forgotten by the browser and says gone', async () => {
    const w = world({
      verify: async () => {
        throw new ControlError('passkey_invalid', 'Unknown.', {}, 'passkey_unknown');
      },
    });
    await expect(passkeySignIn(w.deps)).rejects.toMatchObject({ code: 'gone' });
    expect(w.forgot).toEqual(['cred_1']);
    expect(w.opened).toEqual([]);
  });

  it('a passkey that merely didn’t verify (an expired challenge) is never forgotten', async () => {
    const w = world({
      verify: async () => {
        throw new ControlError('passkey_invalid', 'Try again.', {}, 'passkey_invalid');
      },
    });
    await expect(passkeySignIn(w.deps)).rejects.toBeInstanceOf(ControlError);
    expect(w.forgot).toEqual([]);
  });

  it('a platform that can’t forget changes nothing about what the person is told', async () => {
    const w = world({
      verify: async () => {
        throw new ControlError('passkey_invalid', 'Unknown.', {}, 'passkey_unknown');
      },
    });
    w.deps.platform.forget = async () => {
      throw new Error('not supported');
    };
    await expect(passkeySignIn(w.deps)).rejects.toMatchObject({ code: 'gone' });
  });

  it('the Whombat’s refusal is an outcome with the session (the cloud sign-in stands)', async () => {
    const w = world({
      enrollAnswer: {
        status: 403,
        body: { error: { code: 'not_allowed', message: 'No.', details: { code: 'passkey_not_allowed' } } },
      },
    });
    expect(await passkeySignIn(w.deps)).toMatchObject({
      kind: 'setup',
      reason: 'not_allowed',
      session: cloud,
    });
  });

  it('a key the Whombat already let in just opens (PK-11)', async () => {
    const w = world({
      enrollAnswer: {
        status: 409,
        body: { error: { code: 'conflict', message: 'x', details: { code: 'endpoint_enrolled' } } },
      },
    });
    expect(await passkeySignIn(w.deps)).toMatchObject({ kind: 'open', known: { enrolled: true } });
  });

  it('a dismissed prompt is silent', async () => {
    const w = world();
    w.deps.platform.get = async () => {
      throw new PasskeyCancelled();
    };
    const error = await passkeySignIn(w.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PasskeyCancelled);
    expect(passkeyErrorText(error)).toBeNull();
  });

  it('uses prepared options while fresh, asks again once they are old', async () => {
    const w = world();
    let asked = 0;
    const ask = w.deps.control.passkeyAuthenticateOptions;
    w.deps.control.passkeyAuthenticateOptions = async (e) => {
      asked++;
      return ask(e);
    };
    let t = 1_000_000;
    w.deps.now = () => t;
    const prepared = await preparePasskeySignIn(w.deps.control, ENDPOINT, () => t);
    await passkeySignIn(w.deps, { prepared });
    expect(asked).toBe(1);
    t += 3 * 60_000;
    await passkeySignIn(w.deps, { prepared });
    expect(asked).toBe(2);
  });
});

describe('registering a passkey (PK-06)', () => {
  const APPLIANCE_NONCE = 'b'.repeat(64);
  const CONTROL_NONCE = 'c'.repeat(64);
  const userId = passkeyUserHandleBase64url(WHOMBAT);
  const begin = {
    applianceNonce: APPLIANCE_NONCE,
    rpId: 'app.whombat.com',
    user: { id: userId, name: 'mara@burrowhq.example', displayName: 'Burrow HQ' },
    excludeCredentialIds: ['old_cred'],
  };
  const options = (over: Record<string, unknown> = {}) => ({
    rp: { id: 'app.whombat.com', name: 'Whombat' },
    user: { id: userId, name: 'mara@burrowhq.example', displayName: 'Burrow HQ' },
    challenge: passkeyRegisterChallengeBase64url({
      controlNonce: CONTROL_NONCE,
      applianceNonce: APPLIANCE_NONCE,
      appliance: WHOMBAT,
    }),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    ...over,
  });
  const summary = {
    id: 'new_cred',
    name: 'Chrome on Linux',
    accountId: 'acc_mara',
    personName: 'Mara',
    createdAt: '2026-10-05T10:00:00Z',
    lastUsedAt: null,
    synced: true,
    current: false,
  };
  const registration = {
    id: 'new_cred',
    rawId: 'new_cred',
    type: 'public-key' as const,
    response: { clientDataJSON: 'e30', attestationObject: 'AAAA' },
    clientExtensionResults: {},
  };

  function setup(verify: () => Promise<{ id: string; name: string }>, controlOptions = options()) {
    const app = stubSession({
      'passkey.register.begin': () => ({ status: 200, body: begin }),
      'passkey.register': () => ({ status: 200, body: summary }),
      'passkey.remove': () => ({ status: 200, body: { ok: true } }),
    });
    const created: unknown[] = [];
    let verifies = 0;
    const deps = {
      session: app.session,
      appliance: WHOMBAT,
      name: 'Chrome on Linux',
      control: {
        passkeyRegisterOptions: async () => ({ controlNonce: CONTROL_NONCE, options: controlOptions }),
        passkeyRegisterVerify: async () => {
          verifies++;
          return verify();
        },
      },
      platform: {
        isAvailable: async () => true,
        supportsConditional: async () => false,
        create: async (o: unknown) => {
          created.push(o);
          return registration;
        },
        get: async () => assertion(),
      } satisfies PasskeyPlatform,
    };
    return { deps, app, created, verifies: () => verifies };
  }

  it('the Whombat first, then control; the Whombat’s exclusions are added', async () => {
    const s = setup(async () => ({ id: 'new_cred', name: 'Chrome on Linux' }));
    expect(await passkeyRegister(s.deps)).toMatchObject({ id: 'new_cred' });
    expect(s.app.calls.map((c) => c.op)).toEqual(['passkey.register.begin', 'passkey.register']);
    expect(s.app.calls[1]?.input).toEqual({
      controlNonce: CONTROL_NONCE,
      response: registration,
      name: 'Chrome on Linux',
    });
    expect(s.created[0]).toMatchObject({
      excludeCredentials: [{ id: 'old_cred', type: 'public-key' }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
    });
  });

  it('control failing twice removes it on the Whombat again', async () => {
    const s = setup(async () => {
      throw new ControlError('unavailable', 'down');
    });
    await expect(passkeyRegister(s.deps)).rejects.toMatchObject({ code: 'control_failed' });
    expect(s.verifies()).toBe(2);
    expect(s.app.calls.map((c) => c.op)).toEqual([
      'passkey.register.begin',
      'passkey.register',
      'passkey.remove',
    ]);
    expect(s.app.calls[2]?.input).toEqual({ id: 'new_cred' });
  });

  it('control failing once is retried and kept', async () => {
    let n = 0;
    const s = setup(async () => {
      n++;
      if (n === 1) throw new ControlError('unavailable', 'blip');
      return { id: 'new_cred', name: 'Chrome on Linux' };
    });
    await passkeyRegister(s.deps);
    expect(s.app.calls.map((c) => c.op)).not.toContain('passkey.remove');
  });

  it('refuses control’s options that don’t match the Whombat’s begin, before the authenticator', async () => {
    for (const bad of [
      options({ user: { id: passkeyUserHandleBase64url(IMPOSTOR), name: 'x', displayName: 'x' } }),
      options({ challenge: 'nope' }),
      options({ rp: { id: 'evil.example', name: 'Whombat' } }),
    ]) {
      const s = setup(async () => ({ id: 'new_cred', name: 'x' }), bad);
      await expect(passkeyRegister(s.deps)).rejects.toMatchObject({ code: 'options_mismatch' });
      expect(s.created).toEqual([]);
    }
    expect(() =>
      registrationOptionsFor({ options: null, controlNonce: CONTROL_NONCE, begin, appliance: WHOMBAT }),
    ).toThrow(PasskeyError);
  });
  it('adding a passkey arms the Whombat where the platform answers PRF at creation (backup-passkey.md)', async () => {
    const PRF = new Uint8Array(32).map((_, i) => i + 7);
    const prfAnswer = (base: Record<string, unknown>) => ({
      ...base,
      clientExtensionResults: { prf: { results: { first: toBase64url(PRF) } } },
    });
    const make = (answer: Record<string, unknown>) => {
      const s = setup(async () => ({ id: 'new_cred', name: 'Chrome on Linux' }));
      s.deps.platform.create = async (o: unknown) => {
        s.created.push(o);
        return answer as never;
      };
      return s;
    };
    const armed = make(
      prfAnswer({
        id: 'new_cred',
        rawId: 'new_cred',
        type: 'public-key',
        response: { clientDataJSON: 'e30', attestationObject: 'AAAA' },
      }),
    );
    // The Whombat's stub answers backup.passkeyKey.set like an unknown op: `failed`, the passkey still added.
    expect((await passkeyRegister(armed.deps)).backups).toBe('failed');
    expect(armed.created[0]).toMatchObject({ extensions: { prf: { eval: { first: KIT_PRF_SALT_V2_B64 } } } });
    expect(armed.app.calls.map((c) => c.op)).toEqual([
      'passkey.register.begin',
      'passkey.register',
      'backup.passkeyKey.set',
    ]);
    expect(JSON.stringify(armed.app.calls[1])).not.toContain(
      toBase64url(new Uint8Array(32).map((_, i) => i + 7)),
    );
    const plain = make({
      id: 'new_cred',
      rawId: 'new_cred',
      type: 'public-key',
      response: { clientDataJSON: 'e30', attestationObject: 'AAAA' },
      clientExtensionResults: { prf: { enabled: true } },
    });
    expect((await passkeyRegister(plain.deps)).backups).toBe('touch');
    const none = make({
      id: 'new_cred',
      rawId: 'new_cred',
      type: 'public-key',
      response: { clientDataJSON: 'e30', attestationObject: 'AAAA' },
      clientExtensionResults: { prf: { enabled: false } },
    });
    expect((await passkeyRegister(none.deps)).backups).toBe('unsupported');
  });
});

describe('removing a passkey (PK-08)', () => {
  it('removes the caller’s own at control too, someone else’s only on the Whombat', async () => {
    const app = stubSession({ 'passkey.remove': () => ({ status: 200, body: { ok: true } }) });
    const deleted: string[] = [];
    const control = {
      deletePasskey: async (id: string) => {
        deleted.push(id);
      },
    };
    expect(
      await passkeyRemove({
        session: app.session,
        control,
        passkey: { id: 'a', accountId: 'acc_mara' },
        me: 'acc_mara',
      }),
    ).toEqual({ control: 'removed' });
    expect(
      await passkeyRemove({
        session: app.session,
        control,
        passkey: { id: 'b', accountId: 'acc_tom' },
        me: 'acc_mara',
      }),
    ).toEqual({ control: 'skipped' });
    expect(deleted).toEqual(['a']);
    expect(app.calls.map((c) => c.input)).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

describe('errors and the nudge', () => {
  it('control’s passkey_unknown is a passkey refusal (not a sign-out) that says gone', async () => {
    const body = { error: { code: 'unauthorized', message: 'x', details: { code: 'passkey_unknown' } } };
    expect(controlErrorCodeOf(401, body)).toBe('passkey_invalid');
    const control = createHttpControl('http://control.test', {
      tokens: storageTokenStore(memory()),
      fetch: async () => new Response(JSON.stringify(body), { status: 401 }),
    });
    const refused = await control.passkeyAuthenticateVerify('wac_1', assertion()).catch((e: unknown) => e);
    expect(passkeyErrorOf(refused)).toBe('gone');
  });

  it('names the Whombat’s and control’s refusals', () => {
    expect(passkeyErrorOf(new ControlError('passkey_invalid', 'x'))).toBe('invalid');
    expect(passkeyErrorOf(new ControlError('unavailable', 'x'))).toBe('unreachable');
    expect(passkeyErrorOf(new ControlError('passkey_invalid', 'x', {}, 'passkey_unknown'))).toBe('gone');
    expect(passkeyErrorText(new PasskeyError('limit'))).toBe(PASSKEY_COPY.errors.limit);
  });

  it('is offered once per device key and Whombat, and Not now is remembered', () => {
    const storage = memory();
    const nudge = createPasskeyNudge(storage);
    expect(nudge.shows(DEVICE, ENDPOINT)).toBe(false);
    nudge.due(DEVICE, ENDPOINT);
    expect(nudge.shows(DEVICE, ENDPOINT)).toBe(true);
    expect(nudge.shows(DEVICE, IMPOSTOR)).toBe(false);
    nudge.done(DEVICE, ENDPOINT);
    nudge.due(DEVICE, ENDPOINT);
    expect(createPasskeyNudge(storage).shows(DEVICE, ENDPOINT)).toBe(false);
  });

  it('a passkey that opened nothing makes it owed on the next Whombat, even after Not now', () => {
    const storage = memory();
    const nudge = createPasskeyNudge(storage);
    nudge.due(DEVICE, ENDPOINT);
    nudge.done(DEVICE, ENDPOINT);
    nudge.owe();
    expect(createPasskeyNudge(storage).shows(DEVICE, ENDPOINT)).toBe(true);
    expect(nudge.shows('dev_other', IMPOSTOR)).toBe(true);
    nudge.done(DEVICE, ENDPOINT);
    expect(nudge.shows(DEVICE, ENDPOINT)).toBe(false);
    expect(nudge.shows('dev_other', IMPOSTOR)).toBe(false);
  });

  it('tells the platform which of the person’s passkeys this Whombat still takes', async () => {
    const kept: { userId: string; ids: readonly string[] }[] = [];
    const platform = {
      keepOnly: async (userId: string, ids: readonly string[]) => void kept.push({ userId, ids }),
    };
    const p = (id: string, accountId: string) =>
      ({
        id,
        accountId,
        name: id,
        personName: 'Mara',
        createdAt: '',
        lastUsedAt: null,
        synced: true,
        current: false,
      }) as const;
    await keepOnlyLivePasskeys(platform, {
      appliance: WHOMBAT,
      accountId: 'acc_mara',
      passkeys: [p('mine', 'acc_mara'), p('theirs', 'acc_other')],
    });
    expect(kept).toEqual([{ userId: passkeyUserHandleBase64url(WHOMBAT), ids: ['mine'] }]);
    // Without a known account nothing is said: an empty list would hide every passkey.
    await keepOnlyLivePasskeys(platform, { appliance: WHOMBAT, accountId: null, passkeys: [] });
    expect(kept).toHaveLength(1);
    await expect(
      keepOnlyLivePasskeys(null, { appliance: WHOMBAT, accountId: 'a', passkeys: [] }),
    ).resolves.toBeUndefined();
  });

  it('finds the device a passkey let in during the last day (PK-09)', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    const e = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
      endpointId: id,
      createdAt,
      current: false,
      revocation: 'none',
      ...over,
    });
    const found = passkeyEnrolledDevices(
      [
        e('new', '2026-10-05T11:00:00Z'),
        e('paired', '2026-10-05T10:00:00Z'),
        e('old', '2026-10-03T11:00:00Z'),
        e('me', '2026-10-05T08:00:00Z', { current: true }),
        e('paired-just-before', '2026-10-05T10:59:40Z'),
      ],
      [
        { id: 'p1', name: 'Pixel', lastUsedAt: '2026-10-05T11:00:01Z' },
        { id: 'p2', name: 'Chrome', lastUsedAt: '2026-10-03T11:00:00Z' },
        // Its newest device is this one: nothing to tell here.
        { id: 'p3', name: 'Laptop', lastUsedAt: '2026-10-05T08:00:00Z' },
      ],
      now,
    );
    // The device closest to the passkey's last use, not one paired a moment before it.
    expect([...found.keys()]).toEqual(['new']);
    const seen = createSeenDevices(memory());
    expect(seen.seen(DEVICE, 'new')).toBe(false);
    seen.see(DEVICE, 'new');
    expect(seen.seen(DEVICE, 'new')).toBe(true);
  });
});

describe('the backup key in the same touch (Whombat backup-passkey.md)', () => {
  const PRF = new Uint8Array(32).map((_, i) => i + 7);
  const prfAnswer = (base: PasskeyAssertionJSON | Record<string, unknown>) => ({
    ...base,
    clientExtensionResults: { prf: { results: { first: toBase64url(PRF) } } },
  });

  it('a sign-in asks for the PRF output, sends none of it, and the opened Whombat gets its key', async () => {
    const w = world();
    let verified: unknown = null;
    w.deps.platform.get = async (options) => {
      w.gets.push(options);
      return prfAnswer(assertion()) as PasskeyAssertionJSON;
    };
    w.deps.control.passkeyAuthenticateVerify = async (_id, response) => {
      verified = response;
      return cloud;
    };
    const out = await passkeySignIn(w.deps);
    expect(out.kind).toBe('open');
    expect(w.gets[0]).toMatchObject({ extensions: { prf: { eval: { first: KIT_PRF_SALT_V2_B64 } } } });
    const secret = toBase64url(PRF);
    expect(JSON.stringify(verified)).not.toContain(secret);
    expect(JSON.stringify(w.enroll.calls)).not.toContain(secret);
    expect(heldBackupKey(DEVICE)).toBe(true);
    const app = stubSession({
      'backup.passkeyKey.set': () => ({
        status: 200,
        body: { bringBack: { state: 'ready', passkeys: 1, lockedAt: null, nasCopyAt: null, paperAt: null } },
      }),
    });
    expect(await deliverBackupKey(app.session, DEVICE)).toMatchObject({ bringBack: { state: 'ready' } });
    expect(app.calls).toEqual([
      {
        op: 'backup.passkeyKey.set',
        input: {
          credentialId: 'cred_1',
          salt: KIT_PRF_SALT_V2_B64,
          key: toBase64url(
            kitKeyFromPrf(
              new Uint8Array(32).map((_, i) => i + 7),
              WHOMBAT,
            ),
          ),
        },
      },
    ]);
    // Once.
    expect(await deliverBackupKey(app.session, DEVICE)).toBe(null);
    expect(app.calls).toHaveLength(1);
  });

  it('a sign-in without PRF holds nothing', async () => {
    const w = world();
    await passkeySignIn(w.deps);
    expect(heldBackupKey(DEVICE)).toBe(false);
  });
});

describe('shared-passkey sign-in', () => {
  it('uses only the owner-signed roster and can enroll the same device on two appliances', async () => {
    const w = world({
      directory: [entry(), entry({ device: 'dev_second', contentPeerId: IMPOSTOR, name: 'Office' })],
    });
    const owner = newPasskeyOwner();
    const record = signOwnerPasskey(
      {
        kind: 'whombat.owner-passkey/1',
        credentialId: 'cred_1',
        userHandle: owner.userHandle,
        publicKey: 'AQID',
        revision: 1,
        appliances: [WHOMBAT, IMPOSTOR],
        sealedSeed: sealPasskeyOwner(owner.seed, new Uint8Array(32).fill(2), 'cred_1'),
      },
      owner.seed,
    );
    w.deps.platform.get = async () => ({
      ...assertion(null),
      response: { ...assertion(null).response, userHandle: owner.userHandle },
    });
    w.deps.control.passkeys = async () => [
      {
        id: 'cred_1',
        name: 'My Whombats',
        appliance: null,
        owner: record,
        createdAt: '2026-11-04T09:00:00Z',
        lastUsedAt: null,
      },
    ];
    const originalOpen = w.deps.openEnroll;
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    w.deps.openEnroll = async (target) => {
      if (target.peerId === WHOMBAT) await first;
      else releaseFirst();
      return originalOpen(target);
    };
    expect(await passkeySignIn(w.deps)).toMatchObject({ kind: 'signed_in' });
    expect(w.opened.map((x) => x.peerId).sort()).toEqual([WHOMBAT, IMPOSTOR].sort());
    expect(
      w.deps
        .registryFor('acc_mara')
        .list()
        .map((x) => ({ peerId: x.peerId, enrolled: x.enrolled })),
    ).toEqual(
      expect.arrayContaining([
        { peerId: WHOMBAT, enrolled: true },
        { peerId: IMPOSTOR, enrolled: true },
      ]),
    );
    expect(w.deps.registryFor('acc_mara').list()).toHaveLength(2);
    expect(w.deleted).toEqual([]);
  });

  it('refuses an altered cloud roster before pinning or opening an appliance', async () => {
    const w = world();
    const owner = newPasskeyOwner();
    const record = signOwnerPasskey(
      {
        kind: 'whombat.owner-passkey/1',
        credentialId: 'cred_1',
        userHandle: owner.userHandle,
        publicKey: 'AQID',
        revision: 1,
        appliances: [WHOMBAT],
        sealedSeed: sealPasskeyOwner(owner.seed, new Uint8Array(32).fill(2), 'cred_1'),
      },
      owner.seed,
    );
    w.deps.platform.get = async () => ({
      ...assertion(null),
      response: { ...assertion(null).response, userHandle: owner.userHandle },
    });
    w.deps.control.passkeys = async () => [
      {
        id: 'cred_1',
        name: 'My Whombats',
        appliance: null,
        owner: { ...record, appliances: [IMPOSTOR] },
        createdAt: '2026-11-04T09:00:00Z',
        lastUsedAt: null,
      },
    ];
    await expect(passkeySignIn(w.deps)).rejects.toMatchObject({ code: 'options_mismatch' });
    expect(w.opened).toEqual([]);
    expect(w.deps.registryFor('acc_mara').list()).toEqual([]);
  });

  it('unlinks a shared passkey on this appliance without deleting it account-wide', async () => {
    const removed: string[] = [];
    const app = stubSession({ 'passkey.remove': () => ({ status: 200, body: { ok: true } }) });
    await passkeyRemove({
      session: app.session,
      me: 'acc_mara',
      appliance: WHOMBAT,
      passkey: { id: 'cred_1', accountId: 'acc_mara', ownerHandle: newPasskeyOwner().userHandle },
      control: {
        deletePasskey: async () => {
          throw new Error('must not delete globally');
        },
        unlinkPasskey: async (id, peer) => {
          removed.push(`${id}:${peer}`);
        },
      },
    });
    expect(removed).toEqual([`cred_1:${WHOMBAT}`]);
  });
});
