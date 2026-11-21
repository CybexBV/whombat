import { KIT_PRF_SALT_V2_B64, toBase64url } from '@whombat/core/backup';
import {
  newPasskeyOwner,
  type OwnerPasskeyRecord,
  openPasskeyOwner,
  passkeyLinkChallenge,
  passkeyRegisterChallengeBase64url,
  sealPasskeyOwner,
  signOwnerPasskey,
  verifyOwnerPasskey,
} from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import { fakePeerId } from '../session/fake';
import type { ApplianceSession } from '../session/types';
import { tapPasskeyForBackups } from './kit-passkey';
import {
  PasskeyCancelled,
  type PasskeyPlatform,
  type PasskeyRegisterDeps,
  passkeyRegister,
} from './passkeys';

const appliance = fakePeerId('shared-home');
const endpoint = fakePeerId('shared-browser');
const nonce = 'a'.repeat(64);
const controlNonce = 'b'.repeat(64);
const prf = () => new Uint8Array(32).fill(92);

function registration() {
  const calls: { op: string; input: unknown }[] = [];
  const cloud: unknown[] = [];
  let handle = '';
  const session = {
    invoke: async (op: string, input: Record<string, unknown>) => {
      calls.push({ op, input });
      if (op === 'passkey.register.begin') {
        handle = input.ownerHandle as string;
        return {
          status: 200,
          body: {
            applianceNonce: nonce,
            endpoint,
            rpId: 'dev.whombat.com',
            user: { id: handle },
            excludeCredentialIds: [],
          },
        };
      }
      if (op === 'passkey.register' || op === 'passkey.link')
        return {
          status: 200,
          body: {
            id: op === 'passkey.link' ? (input.record as OwnerPasskeyRecord).credentialId : 'bmV3LWNyZWQ',
            name: 'My Whombats',
            accountId: 'acc_mara',
            personName: 'Mara',
            createdAt: '2026-11-04T10:00:00Z',
            lastUsedAt: null,
            synced: true,
            current: false,
            ownerHandle: handle,
            publicKey: 'AQID',
          },
        };
      if (op === 'backup.passkeyKey.set')
        return {
          status: 200,
          body: {
            bringBack: {
              state: 'needs_passkey',
              setup: 'saving',
              passkeys: 1,
              lockedAt: null,
              nasCopyAt: null,
              paperAt: null,
            },
          },
        };
      if (op === 'backup.passkeyKey.verifyBegin')
        return {
          status: 409,
          body: {
            error: { code: 'conflict', message: 'Saving', details: { code: 'backup_passkey_saving' } },
          },
        };
      if (op === 'backup.status')
        return {
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
        };
      throw new Error(`unexpected op ${op}`);
    },
  } as unknown as ApplianceSession;
  const platform: PasskeyPlatform = {
    isAvailable: async () => true,
    supportsConditional: async () => false,
    create: async (options) => {
      expect(options.extensions).toMatchObject({ prf: { eval: { first: KIT_PRF_SALT_V2_B64 } } });
      expect(options.excludeCredentials).toEqual([]);
      return {
        id: 'bmV3LWNyZWQ',
        rawId: 'bmV3LWNyZWQ',
        type: 'public-key',
        response: { clientDataJSON: 'e30', attestationObject: 'AAAA' },
        clientExtensionResults: { prf: { enabled: true, results: { first: toBase64url(prf()) } } },
      };
    },
    get: async () => {
      throw new Error('unexpected get');
    },
  };
  const deps: PasskeyRegisterDeps = {
    session,
    appliance,
    platform,
    name: 'My Whombats',
    control: {
      passkeys: async () => [],
      putPasskeyOwner: async () => {
        throw new Error('new registrations must save the record atomically');
      },
      passkeyRegisterOptions: async (input) => ({
        controlNonce,
        options: {
          rp: { id: 'dev.whombat.com', name: 'Whombat' },
          user: { id: input.ownerHandle, name: 'mara@example.com', displayName: 'My Whombats' },
          challenge: passkeyRegisterChallengeBase64url({ appliance, applianceNonce: nonce, controlNonce }),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        },
      }),
      passkeyRegisterVerify: async (input) => {
        cloud.push(input);
        return { id: 'bmV3LWNyZWQ', name: input.name };
      },
    },
  };
  return { deps, calls, cloud };
}

describe('shared registration and safe upgrades', () => {
  it('keeps the owner seed encrypted and PRF local, with a new handle and an atomic cloud record', async () => {
    const w = registration();
    const saved = await passkeyRegister(w.deps);
    expect(saved.ownerHandle).toBeTruthy();
    const body = w.cloud[0] as { ownerRecord: unknown; response: { clientExtensionResults: unknown } };
    const record = verifyOwnerPasskey(body.ownerRecord, saved.ownerHandle as string);
    expect(record?.appliances).toEqual([appliance]);
    const seed = record ? openPasskeyOwner(record, prf()) : null;
    expect(seed).toHaveLength(32);
    expect(JSON.stringify(body.response.clientExtensionResults)).not.toContain('results');
    expect(JSON.stringify([w.calls, w.cloud])).not.toContain(toBase64url(prf()));
    if (seed) expect(JSON.stringify([w.calls, w.cloud])).not.toContain(toBase64url(seed));
    seed?.fill(0);
    expect(w.calls.some((c) => c.op === 'passkey.remove')).toBe(false);
  });

  it('cancellation while reusing an existing shared credential neither creates a replacement nor removes access', async () => {
    const w = registration();
    const owner = newPasskeyOwner();
    const record = signOwnerPasskey(
      {
        kind: 'whombat.owner-passkey/1',
        credentialId: 'b2xk',
        userHandle: owner.userHandle,
        publicKey: 'AQID',
        revision: 1,
        appliances: [fakePeerId('office')],
        sealedSeed: sealPasskeyOwner(owner.seed, prf(), 'b2xk'),
      },
      owner.seed,
    );
    w.deps.control.passkeys = async () => [
      {
        id: record.credentialId,
        name: 'My Whombats',
        appliance: null,
        owner: record,
        createdAt: '2026-11-04T10:00:00Z',
        lastUsedAt: null,
      },
    ];
    w.deps.platform.prf = async () => {
      throw new PasskeyCancelled();
    };
    w.deps.platform.create = async () => {
      throw new Error('must reuse the existing credential');
    };
    await expect(passkeyRegister(w.deps)).rejects.toBeInstanceOf(PasskeyCancelled);
    expect(w.calls).toEqual([]);
    expect(w.cloud).toEqual([]);
  });

  it('an upgrade reuses the existing shared credential without creating another vault item', async () => {
    const w = registration();
    const owner = newPasskeyOwner();
    const record = signOwnerPasskey(
      {
        kind: 'whombat.owner-passkey/1',
        credentialId: 'b2xk',
        userHandle: owner.userHandle,
        publicKey: 'AQID',
        revision: 1,
        appliances: [appliance],
        sealedSeed: sealPasskeyOwner(owner.seed, prf(), 'b2xk'),
      },
      owner.seed,
    );
    w.deps.control.passkeys = async () => [
      {
        id: record.credentialId,
        name: 'My Whombats',
        appliance: null,
        owner: record,
        createdAt: '2026-11-04T10:00:00Z',
        lastUsedAt: null,
      },
    ];
    w.deps.platform.create = async () => {
      throw new Error('must reuse the existing passkey');
    };
    w.deps.platform.prf = vi.fn(async () => ({ credentialId: record.credentialId, output: prf() }));
    w.deps.platform.get = vi.fn<PasskeyPlatform['get']>(async () => ({
      id: record.credentialId,
      rawId: record.credentialId,
      type: 'public-key',
      response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
      clientExtensionResults: { prf: { results: { first: toBase64url(prf()) } } },
    }));
    w.deps.control.putPasskeyOwner = async () => {};
    await tapPasskeyForBackups({ ...w.deps, me: 'acc_mara', upgrade: true });
    expect(w.cloud).toHaveLength(0);
    expect(w.calls.find((c) => c.op === 'passkey.register.begin')?.input).toMatchObject({
      ownerHandle: owner.userHandle,
    });
    expect(w.calls.some((c) => c.op === 'passkey.link')).toBe(true);
    expect(w.deps.platform.get).toHaveBeenCalledOnce();
    expect(w.deps.platform.prf).not.toHaveBeenCalled();
    expect(w.calls.some((c) => c.op === 'passkey.remove')).toBe(false);
    owner.seed.fill(0);
  });

  it('links an existing credential without a returned user handle and publishes its signed revision', async () => {
    const w = registration();
    const owner = newPasskeyOwner();
    const office = fakePeerId('office');
    const record = signOwnerPasskey(
      {
        kind: 'whombat.owner-passkey/1',
        credentialId: 'b2xk',
        userHandle: owner.userHandle,
        publicKey: 'AQID',
        revision: 1,
        appliances: [office],
        sealedSeed: sealPasskeyOwner(owner.seed, prf(), 'b2xk'),
      },
      owner.seed,
    );
    w.deps.control.passkeys = async () => [
      {
        id: record.credentialId,
        name: 'My Whombats',
        appliance: null,
        owner: record,
        createdAt: '2026-11-04T10:00:00Z',
        lastUsedAt: null,
      },
    ];
    w.deps.platform.prf = async () => ({ credentialId: record.credentialId, output: prf() });
    w.deps.platform.create = async () => {
      throw new Error('must reuse the existing credential');
    };
    w.deps.platform.get = async (options) => {
      const { signature: _, ...document } = record;
      const next = signOwnerPasskey(
        { ...document, revision: 2, appliances: [office, appliance] },
        owner.seed,
      );
      expect(options.challenge).toBe(passkeyLinkChallenge({ nonce, appliance, endpoint, record: next }));
      return {
        id: record.credentialId,
        rawId: record.credentialId,
        type: 'public-key',
        response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
        clientExtensionResults: {},
      };
    };
    let published: OwnerPasskeyRecord | undefined;
    w.deps.control.putPasskeyOwner = async (_id, next) => {
      published = next;
    };
    expect(await passkeyRegister(w.deps)).toMatchObject({ id: record.credentialId, backups: 'armed' });
    expect(verifyOwnerPasskey(published, owner.userHandle)).toMatchObject({
      revision: 2,
      appliances: [office, appliance],
      sealedSeed: record.sealedSeed,
    });
    expect(w.calls.map((c) => c.op)).toEqual([
      'passkey.register.begin',
      'passkey.link',
      'backup.passkeyKey.set',
    ]);
    expect(w.cloud).toEqual([]);
    owner.seed.fill(0);
  });
});
