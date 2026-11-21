/**
 * The passkey as the key to the backups on the device (Whombat backup-passkey.md): “Use my passkey”, what a new
 * Whombat brings back from, and the paper copy.
 */
import { KIT_PRF_SALT_V2, kitKeyFromPrf, sealKit, sealKitWithKey, toBase64url } from '@whombat/core/backup';
import { kitMaterialOf, newPasskeyOwner, passkeyUserHandleBase64url } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { fakePeerId } from '../session/fake';
import { OperationError } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import {
  accountKitsToBringBack,
  armBackupKey,
  BACKUP_PASSKEY_TEXT,
  kitFromScan,
  kitQrPayload,
  kitsToBringBackFrom,
  paperCopyText,
  tapPasskeyForBackups,
  unlockKitWithPasskey,
  withLivePasskeys,
} from './kit-passkey';
import { passkeyPrfBytes } from './passkey-backup-key';
import type { PasskeyPlatform } from './passkeys';

const WHOMBAT = fakePeerId('home');
const OLD = fakePeerId('old-home');
const PRF = () => new Uint8Array(32).map((_, i) => 90 + i);

function session(answers: Record<string, (input: unknown) => unknown>) {
  const calls: { op: string; input: unknown }[] = [];
  const s = {
    state: () => ({ status: 'open' }),
    invoke: async (op: string, input: unknown) => {
      calls.push({ op, input });
      const answer = answers[op];
      return answer
        ? { status: 200, body: answer(input) }
        : { status: 404, body: { error: { code: 'unknown_op', message: 'x' } } };
    },
  } as unknown as ApplianceSession;
  return { s, calls };
}

const bringBack = { state: 'ready', passkeys: 1, lockedAt: null, nasCopyAt: null, paperAt: null };
const passkey = (id: string, accountId: string) => ({
  id,
  name: 'Phone',
  accountId,
  personName: 'Mara',
  createdAt: '2026-10-05T10:00:00Z',
  lastUsedAt: null,
  synced: true,
  current: false,
});

describe('Touch my passkey', () => {
  it('asks the person’s passkeys for the constant salt and hands the Whombat only its key', async () => {
    const asked: { credentialIds: readonly string[]; salt: Uint8Array }[] = [];
    const app = session({
      'passkeys.list': () => ({
        passkeys: [passkey('mine', 'acc_mara'), passkey('theirs', 'acc_tom')],
        policy: { deviceBoundOnly: false },
      }),
      'backup.passkeyKey.set': () => ({ bringBack: { ...bringBack, setup: 'saving' } }),
    });
    const out = await armBackupKey({
      session: app.s,
      appliance: WHOMBAT,
      me: 'acc_mara',
      platform: {
        prf: async (input) => {
          asked.push(input);
          return { credentialId: 'mine', output: PRF() };
        },
      },
    });
    expect(out).toEqual({ kind: 'armed', bringBack: { ...bringBack, setup: 'saving' } });
    expect(asked[0]?.credentialIds).toEqual(['mine']);
    expect(asked[0]?.salt).toEqual(KIT_PRF_SALT_V2);
    expect(app.calls.at(-1)?.input).toMatchObject({
      credentialId: 'mine',
      key: toBase64url(kitKeyFromPrf(PRF(), WHOMBAT)),
    });
    expect(JSON.stringify(app.calls)).not.toContain(toBase64url(PRF()));
  });

  it('a passkey made for the Whombat this one came back from isn’t used: a new one is needed', async () => {
    const app = session({
      'passkeys.list': () => ({ passkeys: [passkey('old', 'acc_mara')], policy: { deviceBoundOnly: false } }),
      'backup.passkeyKey.set': () => ({ bringBack }),
    });
    const out = await armBackupKey({
      session: app.s,
      appliance: WHOMBAT,
      me: 'acc_mara',
      platform: {
        prf: async () => ({
          credentialId: 'old',
          output: PRF(),
          userHandle: passkeyUserHandleBase64url(OLD),
        }),
      },
    });
    expect(out).toEqual({ kind: 'no_passkey' });
    expect(app.calls.map((c) => c.op)).toEqual(['passkeys.list']);
  });

  it('offers only the newest shared passkey after an upgrade, ahead of older sign-in credentials', async () => {
    const older = newPasskeyOwner();
    const newer = newPasskeyOwner();
    older.seed.fill(0);
    newer.seed.fill(0);
    const app = session({
      'passkeys.list': () => ({
        passkeys: [
          passkey('legacy', 'acc_mara'),
          { ...passkey('shared-old', 'acc_mara'), ownerHandle: older.userHandle },
          {
            ...passkey('shared-new', 'acc_mara'),
            ownerHandle: newer.userHandle,
            createdAt: '2026-11-05T10:00:00Z',
          },
        ],
        policy: { deviceBoundOnly: false },
      }),
      'backup.passkeyKey.verifyBegin': () => {
        throw new OperationError('backup.passkeyKey.verifyBegin', 409, 'conflict', 'Saving', {
          code: 'backup_passkey_saving',
        });
      },
      'backup.passkeyKey.set': () => ({ bringBack: { ...bringBack, setup: 'saving' } }),
    });
    const out = await armBackupKey({
      session: app.s,
      appliance: WHOMBAT,
      me: 'acc_mara',
      platform: {
        prf: async ({ credentialIds }) => {
          expect(credentialIds).toEqual(['shared-new']);
          return { credentialId: 'shared-new', output: PRF(), userHandle: newer.userHandle };
        },
      },
    });
    expect(out.kind).toBe('armed');
    expect(app.calls.at(-1)?.input).toMatchObject({ credentialId: 'shared-new' });
  });

  it('links the selected cloud credential before asking a different local passkey for its key', async () => {
    const app = session({
      'passkeys.list': () => ({
        passkeys: [passkey('legacy', 'acc_mara')],
        policy: { deviceBoundOnly: false },
      }),
    });
    const out = await armBackupKey({
      session: app.s,
      appliance: WHOMBAT,
      me: 'acc_mara',
      credentialId: 'shared-new',
      platform: {
        prf: async () => {
          throw new Error('The shared passkey must be linked first');
        },
      },
    });
    expect(out).toEqual({ kind: 'no_passkey' });
    expect(app.calls.map((c) => c.op)).toEqual(['passkeys.list']);
  });

  it('says when there is no passkey to touch, and when the platform has no PRF', async () => {
    const app = session({ 'passkeys.list': () => ({ passkeys: [], policy: { deviceBoundOnly: false } }) });
    expect(
      await armBackupKey({
        session: app.s,
        appliance: WHOMBAT,
        me: 'acc_mara',
        platform: { prf: async () => null },
      }),
    ).toEqual({ kind: 'no_passkey' });
    await expect(
      armBackupKey({ session: app.s, appliance: WHOMBAT, me: null, platform: {} }),
    ).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('what a new Whombat brings back from', () => {
  const envelope = sealKit('{"kit":1}', PRF(), OLD);
  const found = {
    appliance: OLD,
    applianceName: 'Home',
    credentialId: 'old-cred',
    salt: toBase64url(KIT_PRF_SALT_V2),
    envelope,
    generation: 3,
    createdAt: '2026-11-04T10:00:00.000Z',
    at: '192.168.1.40:8747',
  };

  it('the account’s envelopes first; none there, the ones on the network, which the passkey opens', async () => {
    const app = session({ 'backup.findKits': () => ({ kits: [found], places: 1 }) });
    const none = { kitEnvelopes: async () => [] };
    const kits = await kitsToBringBackFrom({ control: none, session: app.s, thisAppliance: WHOMBAT });
    expect(kits).toMatchObject([{ appliance: OLD, from: 'network', whombatName: 'Home' }]);
    const text = await unlockKitWithPasskey(
      { prf: async () => ({ credentialId: 'old-cred', output: PRF() }) },
      kits[0] as NonNullable<(typeof kits)[0]>,
    );
    expect(text).toBe('{"kit":1}');
    const account = {
      kitEnvelopes: async () => [
        { ...found, id: 'k1', whombatName: 'Home', retired: true, createdAt: '2026-11-04T10:00:00Z' },
      ],
    };
    const fromAccount = await kitsToBringBackFrom({
      control: account,
      session: app.s,
      thisAppliance: WHOMBAT,
    });
    expect(fromAccount).toMatchObject([{ from: 'account' }]);
    expect(app.calls.filter((c) => c.op === 'backup.findKits')).toHaveLength(1);
  });

  it('a passkey the account removed (a lost phone) no longer offers its kit', async () => {
    const app = session({ 'backup.findKits': () => ({ kits: [found], places: 1 }) });
    const kit = (credentialId: string, createdAt: string) => ({
      ...found,
      credentialId,
      id: credentialId,
      whombatName: 'Home',
      retired: false,
      createdAt,
    });
    const control = {
      // The removed passkey's kit is the newest: it would have been offered first.
      kitEnvelopes: async () => [
        kit('removed', '2026-11-04T12:00:00Z'),
        kit('old-cred', '2026-11-04T10:00:00Z'),
      ],
      passkeys: async () => [{ id: 'old-cred' }] as never,
    };
    const kits = await kitsToBringBackFrom({ control, session: app.s, thisAppliance: WHOMBAT });
    expect(kits.map((k) => k.credentialId)).toEqual(['old-cred']);
    // Only the removed passkey's kit at the account: none from it, so the network's (a live passkey's) is offered.
    const onlyRemoved = { ...control, kitEnvelopes: async () => [kit('removed', '2026-11-04T12:00:00Z')] };
    expect(await accountKitsToBringBack(onlyRemoved, WHOMBAT)).toEqual([]);
    expect(
      await kitsToBringBackFrom({ control: onlyRemoved, session: app.s, thisAppliance: WHOMBAT }),
    ).toMatchObject([{ from: 'network', credentialId: 'old-cred' }]);
  });

  it('on the network, a live passkey’s kit wins over a removed one’s of the same Whombat', () => {
    const live = new Set(['live']);
    const a = { appliance: OLD, credentialId: 'removed' };
    const b = { appliance: OLD, credentialId: 'live' };
    const other = { appliance: 'other', credentialId: 'someone-else' };
    expect(withLivePasskeys([a, b, other], live, { prefer: true })).toEqual([b, other]);
    expect(withLivePasskeys([a, b, other], live)).toEqual([b]);
    expect(withLivePasskeys([a, b], null)).toEqual([a, b]);
  });
});

describe('the paper copy', () => {
  const material = {
    kind: 'whombat.backup-recovery-material/1' as const,
    applianceId: 'wb-home',
    generation: 3,
    createdAt: '2026-11-04T10:00:00Z',
    repository: 'rest:http://192.168.1.40:8747/home-3fkq/',
    restUser: 'home-3fkq',
    restPassword: 'rest-secret',
    repositoryPassword: 'repo-secret',
    repositoryId: 'repo-1',
    manifestKey: 'ed25519:AAAA',
  };

  it('holds the backup part bring back reads, and no recovery key', () => {
    const text = paperCopyText({
      applianceName: 'Home',
      appliancePeerId: WHOMBAT,
      material,
      made: '2026-11-04',
    });
    expect(kitMaterialOf(text)).toEqual(material);
    expect(text).toContain(WHOMBAT);
    expect(text).not.toContain('Recovery key');
  });

  it('keeps the earlier Whombats a brought-back one adopted, through the paper and its QR code', () => {
    const adopted = [
      {
        applianceId: 'wb-old-home',
        manifestKey: 'ed25519:BBBB',
        until: {
          checkpointId: 'ck-20261104T120700Z-aa11bb',
          seq: 2,
          manifestSha256: 'a'.repeat(64),
          known: ['b'.repeat(64)],
        },
      },
    ];
    const text = paperCopyText({
      applianceName: 'Home',
      appliancePeerId: WHOMBAT,
      material: { ...material, adopted },
      made: '2026-11-04',
    });
    expect(kitMaterialOf(text)?.adopted).toEqual(adopted);
    const scanned = kitFromScan(kitQrPayload(text) ?? '');
    expect(scanned && kitMaterialOf(scanned)?.adopted).toEqual(adopted);
  });
});

describe('password-manager PRF buffers', () => {
  it('preserves 32 bytes from BufferSource and 1Password arrays, and rejects coercible or malformed output', () => {
    const expected = new Uint8Array(32).map((_, i) => i + 32);
    expect(passkeyPrfBytes(expected.buffer)).toEqual(expected);
    expect(passkeyPrfBytes(expected)).toEqual(expected);
    expect(passkeyPrfBytes([...expected])).toEqual(expected);
    const view = new Uint8Array(48);
    view.set(expected, 8);
    expect(passkeyPrfBytes(new DataView(view.buffer, 8, 32))).toEqual(expected);
    for (const invalid of [
      new Uint8Array(31),
      new Uint8Array(33),
      Array(32).fill('1'),
      Array(32).fill(-1),
      Array(32).fill(256),
      Array(32).fill(1.5),
      { length: 32 },
      null,
    ])
      expect(passkeyPrfBytes(invalid)).toBeNull();
  });
});

describe('verified backup protection', () => {
  const material = JSON.stringify({
    kind: 'whombat.backup-recovery-material/1',
    applianceId: 'wb-home',
    generation: 3,
    createdAt: '2026-11-04T10:00:00Z',
    repository: 'rest:http://nas/home',
    repositoryPassword: 'backup-secret',
    repositoryId: 'repo-1',
    manifestKey: 'ed25519:AAAA',
  });
  const key = kitKeyFromPrf(PRF(), WHOMBAT);
  const proof = toBase64url(new Uint8Array(32).fill(5));
  const make = (saving = false, wrong = false, shared = false) => {
    let touches = 0;
    const owner = newPasskeyOwner();
    owner.seed.fill(0);
    const app = session({
      'passkeys.list': () => ({
        passkeys: [{ ...passkey('mine', 'acc_mara'), ...(shared && { ownerHandle: owner.userHandle }) }],
        policy: { deviceBoundOnly: false },
      }),
      'backup.passkeyKey.set': () => ({ bringBack: { ...bringBack, setup: saving ? 'saving' : 'verify' } }),
      'backup.passkeyKey.verifyBegin': () => ({
        salt: toBase64url(KIT_PRF_SALT_V2),
        envelope: sealKitWithKey(material, key, WHOMBAT),
        challenge: sealKitWithKey(proof, key, `verification:${WHOMBAT}`),
      }),
      'backup.passkeyKey.verifyConfirm': (input) => {
        expect(input).toEqual({ proof });
        return { bringBack: { ...bringBack, setup: 'verified', verifiedAt: '2026-11-04T10:01:00Z' } };
      },
    });
    const platform: PasskeyPlatform = {
      isAvailable: async () => true,
      supportsConditional: async () => false,
      create: async () => {
        throw new Error('must not replace a working passkey');
      },
      get: async () => {
        throw new Error('not used');
      },
      prf: async () => {
        touches++;
        return {
          credentialId: 'mine',
          output: wrong && touches === (shared ? 1 : 2) ? new Uint8Array(32).fill(4) : PRF(),
        };
      },
    };
    return {
      app,
      platform,
      touches: () => touches,
      input: { session: app.s, appliance: WHOMBAT, me: 'acc_mara', control: null, name: 'Browser', platform },
    };
  };
  it('reports protection only after a fresh evaluation opens the stored envelope and its challenge', async () => {
    const w = make();
    expect(await tapPasskeyForBackups(w.input)).toBe(BACKUP_PASSKEY_TEXT.armed);
    expect(w.touches()).toBe(2);
    expect(w.app.calls.at(-1)?.op).toBe('backup.passkeyKey.verifyConfirm');
  });
  it('checks an already saved shared key in one fresh touch without writing it again', async () => {
    const w = make(false, false, true);
    expect(await tapPasskeyForBackups(w.input)).toBe(BACKUP_PASSKEY_TEXT.armed);
    expect(w.touches()).toBe(1);
    expect(w.app.calls.map((c) => c.op)).toEqual([
      'passkeys.list',
      'backup.passkeyKey.verifyBegin',
      'backup.passkeyKey.verifyConfirm',
    ]);
  });
  it('a failed saved-key check neither rewrites the key nor requests another passkey', async () => {
    const w = make(false, true, true);
    expect(await tapPasskeyForBackups(w.input)).toBe(BACKUP_PASSKEY_TEXT.wrongKey);
    expect(w.touches()).toBe(1);
    expect(w.app.calls.map((c) => c.op)).toEqual(['passkeys.list', 'backup.passkeyKey.verifyBegin']);
  });
  it('reports saving without claiming protection or asking for another touch immediately', async () => {
    const w = make(true);
    expect(await tapPasskeyForBackups(w.input)).toBe(BACKUP_PASSKEY_TEXT.saving);
    expect(w.touches()).toBe(1);
  });
  it('never confirms a different key from the second touch', async () => {
    const w = make(false, true);
    expect(await tapPasskeyForBackups(w.input)).toBe(BACKUP_PASSKEY_TEXT.wrongKey);
    expect(w.app.calls.some((c) => c.op === 'backup.passkeyKey.verifyConfirm')).toBe(false);
  });
  it('offers an upgrade for an older credential that returns no PRF, without changing access', async () => {
    const w = make();
    w.platform.prf = async () => ({ credentialId: 'mine', output: null });
    expect(await tapPasskeyForBackups(w.input)).toBe(BACKUP_PASSKEY_TEXT.upgrade);
    expect(w.app.calls.map((c) => c.op)).toEqual(['passkeys.list']);
  });
});
