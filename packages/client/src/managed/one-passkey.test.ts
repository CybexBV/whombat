import type { KitEnvelope, Passkey } from '@whombat/control-contracts';
import { KIT_PRF_SALT_V2_B64, kitKeyFromPrf, sealKitWithKey, toBase64url } from '@whombat/core/backup';
import {
  newPasskeyOwner,
  type OwnerPasskeyRecord,
  passkeyLinkChallenge,
  sealPasskeyOwner,
  signOwnerPasskey,
} from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import { fakePeerId } from '../session/fake';
import type { ApplianceSession } from '../session/types';
import type { ApplianceSummary } from './control';
import { onePasskeyWords, setUpOnePasskey } from './one-passkey';
import { PasskeyCancelled, type PasskeyPlatform } from './passkeys';
import type { KnownAppliance } from './registry';

const at = '2026-11-05T10:00:00Z';
const credentialId = 'c2hhcmVk';
const prf = () => new Uint8Array(32).fill(91);
const appliance = (name: string, orgId: string): ApplianceSummary => ({
  device: `wb-${name}`,
  name,
  orgId,
  contentPeerId: fakePeerId(name),
  state: 'claimed',
  lastSeenAt: 1,
  revocationsPending: 0,
});

function world({ homeSavedKey = true } = {}) {
  const home = appliance('Home', 'org_home');
  const office = appliance('Office', 'org_office');
  const owner = newPasskeyOwner();
  let record = signOwnerPasskey(
    {
      kind: 'whombat.owner-passkey/1',
      credentialId,
      userHandle: owner.userHandle,
      publicKey: 'AQID',
      revision: 1,
      appliances: [home.contentPeerId],
      sealedSeed: sealPasskeyOwner(owner.seed, prf(), credentialId),
    },
    owner.seed,
  );
  owner.seed.fill(0);
  let passkeys: Passkey[] = [home, office].map((box) => ({
    id: `old_${box.name}`,
    name: `Old ${box.name}`,
    appliance: box.contentPeerId,
    createdAt: at,
    lastUsedAt: null,
  }));
  let envelopes: KitEnvelope[] = [];
  const calls: { appliance: string; op: string; input: unknown }[] = [];
  const buffers: Uint8Array[] = [];
  let lastChallenge = '';
  const platform: PasskeyPlatform = {
    isAvailable: async () => true,
    supportsConditional: async () => false,
    create: vi.fn(async () => {
      throw new Error('must reuse the existing shared passkey');
    }),
    get: vi.fn<PasskeyPlatform['get']>(async (options) => {
      lastChallenge = options.challenge;
      expect(options.allowCredentials?.map((c) => c.id)).toEqual([credentialId]);
      expect(options.extensions).toMatchObject({ prf: { eval: { first: KIT_PRF_SALT_V2_B64 } } });
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
        clientExtensionResults: { prf: { results: { first: toBase64url(prf()) } } },
      };
    }),
    prf: vi.fn<NonNullable<PasskeyPlatform['prf']>>(async (input) => {
      expect(input.credentialIds).toEqual([credentialId]);
      const output = prf();
      buffers.push(output);
      return { credentialId, output, userHandle: record.userHandle };
    }),
    forget: vi.fn(async () => {}),
  };
  const makeSession = (box: ApplianceSummary) => {
    const peer = box.contentPeerId;
    const me = `acc_${box.name}`;
    let verified = false;
    let savedKey = box === home && homeSavedKey;
    const local = [
      {
        id: `old_${box.name}`,
        name: `Old ${box.name}`,
        accountId: me,
        personName: 'Mara',
        synced: true,
        current: false,
        createdAt: at,
        lastUsedAt: null,
      },
    ];
    const bringBack = () => ({
      state: 'ready',
      setup: verified ? 'verified' : 'verify',
      passkeys: 2,
      lockedAt: at,
      nasCopyAt: at,
      paperAt: null,
    });
    const key = kitKeyFromPrf(prf(), peer);
    const proof = toBase64url(new Uint8Array(32).fill(box.name === 'Home' ? 1 : 2));
    const session = {
      state: () => ({
        status: 'open',
        info: { appliance: { id: peer }, account: { id: me }, channel: 'app' },
      }),
      onState: vi.fn(() => () => {}),
      connect: vi.fn(),
      close: vi.fn(),
      invoke: async (op: string, input: Record<string, unknown>) => {
        calls.push({ appliance: peer, op, input });
        let body: unknown;
        if (op === 'passkeys.list') body = { passkeys: local, policy: { deviceBoundOnly: false } };
        else if (op === 'passkey.register.begin')
          body = {
            applianceNonce: 'a'.repeat(64),
            endpoint: fakePeerId(`endpoint-${box.name}`),
            rpId: 'dev.whombat.com',
            user: { id: input.ownerHandle },
            excludeCredentialIds: [],
          };
        else if (op === 'passkey.link') {
          const next = input.record as OwnerPasskeyRecord;
          expect(lastChallenge).toBe(
            passkeyLinkChallenge({
              nonce: 'a'.repeat(64),
              appliance: peer,
              endpoint: fakePeerId(`endpoint-${box.name}`),
              record: next,
            }),
          );
          body = {
            ...local[0],
            id: credentialId,
            name: 'Shared',
            ownerHandle: record.userHandle,
            publicKey: record.publicKey,
          };
        } else if (op === 'backup.passkeyKey.set') {
          expect(input.key).toBe(toBase64url(key));
          savedKey = true;
          body = { bringBack: bringBack() };
        } else if (op === 'backup.status')
          body = {
            status: {
              kind: 'whombat.backup-status/1',
              state: 'protected',
              protected: true,
              destination: { configured: true, kind: 'rest' },
              lastSuccess: null,
              lastFailure: null,
              lastAttemptOk: null,
              coverage: [],
              recoverability: { lastDrill: null },
              kitGeneration: 1,
              running: null,
              updatedAt: at,
            },
            summary: {
              state: 'protected',
              lastSuccessAt: null,
              ageS: null,
              coverage: [],
              unprotected: [],
              relogin: [],
              lastFailure: null,
              recoverable: false,
              bringBack: bringBack(),
            },
          };
        else if (op === 'backup.passkeyKey.verifyBegin') {
          expect(input.credentialId).toBe(credentialId);
          if (!savedKey)
            return {
              status: 409,
              body: {
                error: { code: 'conflict', message: 'Saving', details: { code: 'backup_passkey_saving' } },
              },
            };
          body = {
            salt: KIT_PRF_SALT_V2_B64,
            envelope: sealKitWithKey(
              JSON.stringify({
                kind: 'whombat.backup-recovery-material/1',
                applianceId: box.device,
                generation: 1,
                createdAt: at,
                repository: 'rest:http://nas/home',
                repositoryPassword: 'repo-secret',
                repositoryId: box.name,
                manifestKey: 'ed25519:AAAA',
              }),
              key,
              peer,
            ),
            challenge: sealKitWithKey(proof, key, `verification:${peer}`),
          };
        } else if (op === 'backup.passkeyKey.verifyConfirm') {
          expect(input.proof).toBe(proof);
          verified = true;
          body = { bringBack: bringBack() };
        } else if (op === 'passkey.remove') body = { ok: true };
        else throw new Error(`Unexpected operation ${op}`);
        return { status: 200, body };
      },
    } as unknown as ApplianceSession;
    return session;
  };
  const homeSession = makeSession(home);
  const officeSession = makeSession(office);
  const known: KnownAppliance = {
    device: office.device,
    orgId: office.orgId as string,
    peerId: office.contentPeerId,
    name: office.name,
    pinSource: 'claim',
    enrolled: true,
    kitPending: false,
  };
  const control = {
    session: async () => ({
      account: { accountId: 'cloud_mara', email: 'mara@example.com', name: 'Mara' },
      orgs: [
        { orgId: 'org_home', name: 'Home' },
        { orgId: 'org_office', name: 'Office' },
      ],
    }),
    appliances: async (orgId: string) => (orgId === 'org_home' ? [home] : [office]),
    passkeys: async () => [
      ...passkeys,
      { id: credentialId, name: 'Shared', appliance: null, owner: record, createdAt: at, lastUsedAt: null },
    ],
    putPasskeyOwner: async (_id: string, next: OwnerPasskeyRecord) => {
      record = next;
    },
    passkeyRegisterOptions: vi.fn(async () => {
      throw new Error('must not create');
    }),
    passkeyRegisterVerify: vi.fn(async () => {
      throw new Error('must not create');
    }),
    kitEnvelopes: async () => envelopes,
    retirePasskey: vi.fn(async (id: string) => {
      passkeys = passkeys.filter((p) => p.id !== id);
    }),
  };
  const input = {
    session: homeSession,
    platform,
    control,
    appliance: home.contentPeerId,
    me: 'acc_Home',
    name: 'Shared',
    whombats: { known: () => known, connect: () => officeSession },
    connectTimeoutMs: 1,
  };
  return {
    input,
    home,
    office,
    calls,
    platform,
    buffers,
    officeSession,
    setEnvelopes: (kits: KitEnvelope[]) => {
      envelopes = kits;
    },
    known,
  };
}

describe('one shared passkey everywhere', () => {
  it('reuses one credential across organizations, proves each appliance’s backups, then retires old access', async () => {
    const w = world();
    const progress = vi.fn();
    const out = await setUpOnePasskey({ ...w.input, onProgress: progress });
    expect(out).toMatchObject({
      credentialId,
      checked: [w.home.contentPeerId, w.office.contentPeerId],
      backupsChecked: [w.home.contentPeerId, w.office.contentPeerId],
      pending: [],
      kept: [],
      retired: ['Old Home', 'Old Office'],
    });
    expect(w.platform.create).not.toHaveBeenCalled();
    expect(w.platform.get).toHaveBeenCalledTimes(2);
    expect(w.platform.prf).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls.map(([note]) => note)).toEqual([
      expect.stringMatching(/Home · Whombat 1 of 2.*access and saved backups/),
      expect.stringMatching(/Office · Whombat 2 of 2.*prepare access/),
      expect.stringMatching(/Office · Whombat 2 of 2.*check access/),
    ]);
    expect(w.calls.filter((c) => c.op === 'backup.passkeyKey.verifyConfirm')).toHaveLength(2);
    const firstRemove = w.calls.findIndex((c) => c.op === 'passkey.remove');
    expect(
      w.calls.slice(0, firstRemove).filter((c) => c.op === 'backup.passkeyKey.verifyConfirm'),
    ).toHaveLength(2);
    expect(w.input.control.retirePasskey).toHaveBeenCalledWith('old_Office', {
      replacementId: credentialId,
      expectedRevision: null,
      checkedAppliances: out.checked,
    });
    expect(w.officeSession.close).toHaveBeenCalledOnce();
    expect(w.buffers.every((b) => b.every((n) => n === 0))).toBe(true);
    expect(JSON.stringify(w.calls)).not.toContain(toBase64url(prf()));
    expect(onePasskeyWords(out)).toContain('delete their old items');
    const again = await setUpOnePasskey(w.input);
    expect(again.retired).toEqual([]);
    expect(w.platform.get).toHaveBeenCalledTimes(4);
    expect(w.platform.prf).toHaveBeenCalledTimes(1);
    expect(w.platform.create).not.toHaveBeenCalled();
  });

  it('finishes a newly armed backup key with the same authorization that opens the saved owner seed', async () => {
    const w = world({ homeSavedKey: false });
    w.known.enrolled = false;
    const out = await setUpOnePasskey(w.input);
    expect(out.backupsChecked).toEqual([w.home.contentPeerId]);
    expect(w.platform.get).toHaveBeenCalledOnce();
    expect(w.platform.prf).not.toHaveBeenCalled();
    const homeCalls = w.calls.filter((c) => c.appliance === w.home.contentPeerId).map((c) => c.op);
    const save = homeCalls.indexOf('backup.passkeyKey.set');
    expect(save).toBeGreaterThan(homeCalls.indexOf('passkey.link'));
    expect(homeCalls.slice(save, save + 4)).toEqual([
      'backup.passkeyKey.set',
      'backup.status',
      'backup.passkeyKey.verifyBegin',
      'backup.passkeyKey.verifyConfirm',
    ]);
  });

  it.each(['envelope', 'challenge', 'salt'] as const)(
    'a newly saved backup with the wrong %s fails without another prompt or retirement',
    async (field) => {
      const w = world({ homeSavedKey: false });
      const invoke = w.input.session.invoke.bind(w.input.session);
      w.input.session.invoke = async (op, input, options) => {
        const answer = await invoke(op, input, options);
        if (op === 'backup.passkeyKey.verifyBegin' && answer.status === 200)
          return { ...answer, body: { ...(answer.body as object), [field]: 'wrong' } };
        return answer;
      };
      await expect(setUpOnePasskey(w.input)).rejects.toMatchObject({ code: 'invalid' });
      expect(w.platform.get).toHaveBeenCalledOnce();
      expect(w.platform.prf).not.toHaveBeenCalled();
      expect(w.input.control.retirePasskey).not.toHaveBeenCalled();
      expect(w.calls.some((c) => c.op === 'backup.passkeyKey.verifyConfirm')).toBe(false);
      expect(w.calls.some((c) => c.op === 'passkey.remove')).toBe(false);
    },
  );

  it('leaves saving pending instead of asking for another authorization', async () => {
    const w = world({ homeSavedKey: false });
    const invoke = w.input.session.invoke.bind(w.input.session);
    w.input.session.invoke = async (op, input, options) => {
      const answer = await invoke(op, input, options);
      if (op === 'backup.passkeyKey.verifyBegin')
        return {
          ...answer,
          status: 409,
          body: {
            error: { code: 'conflict', message: 'Saving', details: { code: 'backup_passkey_saving' } },
          },
        };
      return answer;
    };
    await expect(setUpOnePasskey(w.input)).rejects.toMatchObject({
      details: { code: 'backup_passkey_saving' },
    });
    expect(w.platform.get).toHaveBeenCalledOnce();
    expect(w.platform.prf).not.toHaveBeenCalled();
    expect(w.input.control.retirePasskey).not.toHaveBeenCalled();
    expect(w.calls.some((c) => c.op === 'backup.passkeyKey.verifyConfirm')).toBe(false);
  });

  it('requires the authorization to open the previously saved owner seed before arming backups', async () => {
    const w = world({ homeSavedKey: false });
    const get = w.platform.get;
    w.platform.get = vi.fn<PasskeyPlatform['get']>(async (options) => ({
      ...(await get(options)),
      clientExtensionResults: {
        prf: { results: { first: toBase64url(new Uint8Array(32).fill(1)) } },
      },
    }));
    await expect(setUpOnePasskey(w.input)).rejects.toMatchObject({ code: 'options_mismatch' });
    expect(w.platform.get).toHaveBeenCalledOnce();
    expect(w.platform.prf).not.toHaveBeenCalled();
    expect(w.input.control.retirePasskey).not.toHaveBeenCalled();
    expect(
      w.calls.some((c) =>
        ['passkey.link', 'backup.passkeyKey.set', 'backup.passkeyKey.verifyConfirm'].includes(c.op),
      ),
    ).toBe(false);
  });

  it('never trusts a changed directory identity or creates a session for an unenrolled appliance', async () => {
    const w = world();
    w.known.peerId = fakePeerId('impostor');
    const connect = vi.spyOn(w.input.whombats, 'connect');
    const out = await setUpOnePasskey(w.input);
    expect(connect).not.toHaveBeenCalled();
    expect(out.pending).toEqual([{ name: 'Office', reason: 'setup' }]);
    expect(out.kept).toEqual(['Old Office']);
    expect(w.input.control.retirePasskey).not.toHaveBeenCalledWith('old_Office', expect.anything());
  });

  it('an offline appliance keeps its old key, closes its temporary session and does not hold up Home', async () => {
    const w = world();
    w.officeSession.state = () => ({ status: 'connecting', attempt: 1 });
    const out = await setUpOnePasskey(w.input);
    expect(out.pending).toEqual([{ name: 'Office', reason: 'offline' }]);
    expect(out.checked).toEqual([w.home.contentPeerId]);
    expect(out.kept).toEqual(['Old Office']);
    expect(w.officeSession.close).toHaveBeenCalledOnce();
  });

  it('does not retire any key after a cancelled ceremony', async () => {
    const w = world();
    w.platform.get = async () => {
      throw new PasskeyCancelled();
    };
    await expect(setUpOnePasskey(w.input)).rejects.toBeInstanceOf(PasskeyCancelled);
    expect(w.input.control.retirePasskey).not.toHaveBeenCalled();
    expect(w.calls.some((c) => c.op === 'passkey.remove')).toBe(false);
  });

  it('consolidates appliance access before backups have been configured', async () => {
    const w = world();
    for (const session of [w.input.session, w.officeSession]) {
      const invoke = session.invoke.bind(session);
      session.invoke = (op, input, options) =>
        op === 'backup.status'
          ? Promise.resolve({
              requestId: 'no-backups',
              status: 200,
              body: {
                status: null,
                summary: {
                  state: 'unprotected',
                  lastSuccessAt: null,
                  ageS: null,
                  coverage: [],
                  unprotected: [],
                  relogin: [],
                  lastFailure: null,
                  recoverable: false,
                  bringBack: { state: 'none', passkeys: 0, lockedAt: null, nasCopyAt: null, paperAt: null },
                },
              },
            })
          : invoke(op, input, options);
    }
    const out = await setUpOnePasskey(w.input);
    expect(out.checked).toEqual([w.home.contentPeerId, w.office.contentPeerId]);
    expect(out.backupsChecked).toEqual([]);
    expect(out.retired).toEqual(['Old Home', 'Old Office']);
    expect(out.pending).toEqual([]);
    expect(onePasskeyWords(out)).not.toContain('backups have been checked');
  });

  it('does not reconnect a session that is already closed', async () => {
    const w = world();
    w.officeSession.state = () => ({ status: 'closed', reason: 'offline' });
    const out = await setUpOnePasskey(w.input);
    expect(out.pending).toEqual([{ name: 'Office', reason: 'offline' }]);
    expect(w.officeSession.connect).not.toHaveBeenCalled();
    expect(w.officeSession.close).toHaveBeenCalledOnce();
  });

  it('preserves a key needed by any recovery envelope, including a retired appliance’s', async () => {
    const w = world();
    w.setEnvelopes([
      {
        id: 'kit_old',
        appliance: fakePeerId('retired'),
        credentialId: 'old_Home',
        salt: KIT_PRF_SALT_V2_B64,
        envelope: 'wbkit1.AAAA.AAAA',
        generation: 1,
        createdAt: at,
        whombatName: 'Retired',
        retired: true,
      },
    ]);
    const out = await setUpOnePasskey(w.input);
    expect(out.kept).toEqual(['Old Home']);
    expect(out.retired).toEqual(['Old Office']);
    expect(
      w.calls.some((c) => c.op === 'passkey.remove' && (c.input as { id: string }).id === 'old_Home'),
    ).toBe(false);
  });

  it('an aggregate verified status cannot replace decryption of the saved envelope for this credential', async () => {
    const w = world();
    const invoke = w.input.session.invoke.bind(w.input.session);
    w.input.session.invoke = async (op, input, options) => {
      const answer = await invoke(op, input, options);
      if (op === 'backup.passkeyKey.verifyBegin')
        return {
          ...answer,
          body: {
            ...(answer.body as object),
            envelope: sealKitWithKey('wrong', new Uint8Array(32), w.home.contentPeerId),
          },
        };
      return answer;
    };
    await expect(setUpOnePasskey(w.input)).rejects.toMatchObject({ code: 'invalid' });
    expect(w.input.control.retirePasskey).not.toHaveBeenCalled();
    expect(
      w.calls.some((c) => c.op === 'backup.passkeyKey.set' || c.op === 'backup.passkeyKey.verifyConfirm'),
    ).toBe(false);
    expect(w.calls.some((c) => c.op === 'passkey.remove')).toBe(false);
  });

  it('reports an older key as kept if a concurrent recovery write makes guarded retirement fail', async () => {
    const w = world();
    w.input.control.retirePasskey.mockRejectedValue(new Error('a new recovery envelope was saved'));
    const out = await setUpOnePasskey(w.input);
    expect(out.retired).toEqual([]);
    expect(out.kept).toEqual(['Old Home', 'Old Office']);
    expect(w.platform.forget).not.toHaveBeenCalled();
    expect(onePasskeyWords(out)).not.toContain('delete their old items');
  });
});
