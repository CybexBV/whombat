/**
 * The passkey backup key (backup-passkey.md) against a fake backup service and manager: the key kept sealed for one of
 * the person's own passkeys, the details locked with it and pushed, locked again when they change, `adoptedFrom` told
 * once, a failed push tried again, the key going with its passkey, the paper copy, and the Inbox's ask. Needs Postgres:
 * the keys, their envelopes and the state are rows, and the passkey check reads `appliance_passkeys`.
 */
import {
  fromBase64url,
  KIT_PRF_SALT_V2_B64,
  kitKeyFromPrf,
  openKitWithKey,
  toBase64url,
} from '@whombat/core/backup';
import { eq } from 'drizzle-orm';
import { afterEach, assert, beforeAll, describe, expect, it, vi } from 'vitest';
import { appliancePasskeys, backupPasskeyKeys } from '../db/schema/index';
import { loadOwnName } from '../desk/store';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import type { BackupPort } from './backup';
import { noteBroughtBack, relock, startBackupKeys, useBackupKeys } from './backup-key';
import { backupPasskeyNeedsYou } from './backup-key-inbox';
import { useBoxBackup } from './box-backup';
import { ManagerCallError } from './ports';

const m = useManagedRuntime({ seed: true });
const OLD = 'wb-old0-home-0001';
const CREDENTIAL = 'cGFzc2tleS1vbmU';
const PRF = new Uint8Array(32).map((_, i) => 200 - i);

let material: Record<string, unknown> = {
  kind: 'whombat.backup-recovery-material/1',
  applianceId: 'wb-home',
  generation: 3,
  createdAt: '2026-11-04T10:00:00Z',
  // Not a REST place: nothing here reaches a backup app on the network.
  repository: 'sftp:nas:/backups/home',
  sftpUser: 'whombat',
  sftpPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
  sftpHostKey: 'ssh-ed25519 AAAAC3Nz',
  repositoryPassword: 'repo-secret',
  repositoryId: 'repo-1',
  manifestKey: 'ed25519:AAAA',
  head: { seq: 7, manifestSha256: 'a'.repeat(64), at: '2026-11-04T09:00:00Z' },
};
let lastId = 'ck-7';
const status = () => ({
  kind: 'whombat.backup-status/1' as const,
  state: 'protected' as const,
  protected: true,
  destination: {
    configured: true,
    kind: 'sftp',
    display: 'nas',
    appendOnly: 'unknown' as const,
    repositoryId: 'repo-1',
  },
  lastSuccess: {
    id: lastId,
    at: '2026-11-04T09:00:00Z',
    ageSeconds: 60,
    snapshotId: 'aaaa',
    method: 'snapshot',
    quiesceHeldMs: 10,
    durationMs: 15_000,
    bytesAdded: 1,
    totalBytes: 2,
    files: 3,
    schemaVersion: 120,
  },
  lastFailure: null,
  lastAttemptOk: true,
  coverage: [],
  recoverability: { lastDrill: null },
  kitGeneration: material.generation as number,
  running: null,
  updatedAt: '2026-11-04T09:01:00Z',
});
const fake: BackupPort = {
  async call(_method, path) {
    if (path === '/v1/recovery-material') return { status: 200, body: material };
    if (path === '/v1/status') return { status: 200, body: status() };
    return { status: 404, body: null };
  },
};
let owner: Awaited<ReturnType<typeof m.enroll>>;
let key: Uint8Array;

beforeAll(async () => {
  m.runtime.dispatcher.backup = fake;
  useBoxBackup(m.t.services, { port: fake, status });
  useBackupKeys(m.t.services, { appliance: m.appliance.peerId, manager: m.manager });
  owner = await m.enroll(IDS.mara);
  await m.t.services.db.insert(appliancePasskeys).values({
    id: CREDENTIAL,
    accountId: owner.accountId,
    name: 'Phone',
    publicKey: Buffer.from([1, 2, 3]),
    backupEligible: true,
    backedUp: true,
  });
  key = kitKeyFromPrf(PRF, m.appliance.peerId);
});

afterEach(() => {
  m.manager.kitFails = null;
  m.manager.refusesNames = false;
});

const opened = (envelope: string) => {
  const text = openKitWithKey(envelope, key, m.appliance.peerId);
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
};

describe('a passkey’s backup key', () => {
  it('is kept only for one of the person’s own live passkeys', async () => {
    const c = await m.client(owner);
    expect(
      await c.request('backup.passkeyKey.set', {
        credentialId: 'bm90LW1pbmU',
        salt: KIT_PRF_SALT_V2_B64,
        key: toBase64url(key),
      }),
    ).toMatchObject({ t: 'error', details: { code: 'backup_passkey_unknown' } });
  });

  it('locks the details at once, sealed at rest, and control keeps the envelope', async () => {
    const c = await m.client(owner);
    const set = await c.request('backup.passkeyKey.set', {
      credentialId: CREDENTIAL,
      salt: KIT_PRF_SALT_V2_B64,
      key: toBase64url(key),
    });
    expect(set).toMatchObject({ t: 'result', output: { bringBack: { state: 'ready', passkeys: 1 } } });
    const [row] = await m.t.services.db
      .select()
      .from(backupPasskeyKeys)
      .where(eq(backupPasskeyKeys.credentialId, CREDENTIAL));
    expect(row?.keySealed).not.toContain(toBase64url(key));
    expect(row?.appliance).toBe(m.appliance.peerId);
    const push = m.manager.kitPushes.at(-1);
    expect(push?.envelopes).toHaveLength(1);
    expect(push?.envelopes[0]).toMatchObject({
      credentialId: CREDENTIAL,
      salt: KIT_PRF_SALT_V2_B64,
      generation: 3,
    });
    expect(push?.adoptedFrom).toBeUndefined();
    expect(opened(push?.envelopes[0]?.envelope ?? '')).toMatchObject({
      repositoryId: 'repo-1',
      head: { seq: 7 },
    });
    // The summary says so too.
    expect(await c.request('backup.status', {})).toMatchObject({
      t: 'result',
      output: { summary: { bringBack: { state: 'ready', passkeys: 1 } } },
    });
  });

  it('verifies decryption with a one-use challenge bound to the session and the stored envelope', async () => {
    const c = await m.client(owner);
    const other = await m.client(owner);
    type Begin = { envelope: string; challenge: string; salt: string };
    const begin = async () =>
      (
        (await c.request('backup.passkeyKey.verifyBegin', { credentialId: CREDENTIAL })) as unknown as {
          output: Begin;
        }
      ).output;
    const first = await begin();
    expect(opened(first.envelope)).toMatchObject({ repositoryId: 'repo-1' });
    const proof = openKitWithKey(first.challenge, key, `verification:${m.appliance.peerId}`);
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await other.request('backup.passkeyKey.verifyConfirm', { proof })).toMatchObject({ t: 'error' });
    expect(await c.request('backup.passkeyKey.verifyConfirm', { proof })).toMatchObject({
      t: 'result',
      output: { bringBack: { setup: 'verified', verifiedAt: expect.any(String) } },
    });
    expect(await c.request('backup.passkeyKey.verifyConfirm', { proof })).toMatchObject({ t: 'error' });
    const stale = await begin();
    material = { ...material, head: { seq: 7, manifestSha256: 'c'.repeat(64), at: '2026-11-04T09:00:01Z' } };
    await relock(m.t.services);
    const oldProof = openKitWithKey(stale.challenge, key, `verification:${m.appliance.peerId}`);
    expect(await c.request('backup.passkeyKey.verifyConfirm', { proof: oldProof })).toMatchObject({
      t: 'error',
    });
    c.close();
    other.close();
  });

  it('keeps a working recovery envelope when the provider returns a different key', async () => {
    const c = await m.client(owner);
    const [before] = await m.t.services.db
      .select()
      .from(backupPasskeyKeys)
      .where(eq(backupPasskeyKeys.credentialId, CREDENTIAL));
    expect(
      await c.request('backup.passkeyKey.set', {
        credentialId: CREDENTIAL,
        salt: KIT_PRF_SALT_V2_B64,
        key: toBase64url(new Uint8Array(32).fill(8)),
      }),
    ).toMatchObject({ t: 'error', details: { code: 'backup_passkey_key_changed' } });
    const [after] = await m.t.services.db
      .select()
      .from(backupPasskeyKeys)
      .where(eq(backupPasskeyKeys.credentialId, CREDENTIAL));
    expect(after?.envelope).toBe(before?.envelope);
    expect(after?.verifiedAt).toEqual(before?.verifiedAt);
    c.close();
  });

  it('keeps the first backup key when two devices save different keys concurrently', async () => {
    const credentialId = 'cmFjaW5nLWNyZWQ';
    await m.t.services.db.insert(appliancePasskeys).values({
      id: credentialId,
      accountId: owner.accountId,
      name: 'Shared passkey',
      publicKey: Buffer.from([1, 2, 3]),
      backupEligible: true,
      backedUp: true,
    });
    const [first, second] = await Promise.all([m.client(owner), m.client(owner)]);
    const clients = [first, second];
    try {
      const keys = [new Uint8Array(32).fill(11), new Uint8Array(32).fill(12)];
      const results = await Promise.all(
        clients.map((client, index) => {
          const key = keys[index];
          assert(key);
          return client.request('backup.passkeyKey.set', {
            credentialId,
            salt: KIT_PRF_SALT_V2_B64,
            key: toBase64url(key),
          });
        }),
      );
      expect(results.filter((r) => r.t === 'result')).toHaveLength(1);
      expect(results.find((r) => r.t === 'error')).toMatchObject({
        details: { code: 'backup_passkey_key_changed' },
      });
      const [saved] = await m.t.services.db
        .select()
        .from(backupPasskeyKeys)
        .where(eq(backupPasskeyKeys.credentialId, credentialId));
      const winner = keys[results.findIndex((r) => r.t === 'result')];
      assert(winner);
      assert(saved?.envelope);
      expect(openKitWithKey(saved.envelope, winner, m.appliance.peerId)).not.toBeNull();
    } finally {
      await first.request('passkey.remove', { id: credentialId });
      for (const client of clients) client.close();
    }
  });

  it('locks again after a backup, and only then', async () => {
    const before = m.manager.kitPushes.length;
    expect(await relock(m.t.services)).toBe('unchanged');
    expect(m.manager.kitPushes).toHaveLength(before);
    material = { ...material, head: { seq: 8, manifestSha256: 'b'.repeat(64), at: '2026-11-04T15:00:00Z' } };
    // Nothing goes out while the box is quarantined after a restore: it waits.
    m.t.services.maintenance.quarantined = true;
    try {
      expect(await relock(m.t.services)).toBe('later');
      expect(m.manager.kitPushes).toHaveLength(before);
    } finally {
      m.t.services.maintenance.quarantined = false;
    }
    expect(await relock(m.t.services)).toBe('locked');
    expect(opened(m.manager.kitPushes.at(-1)?.envelopes[0]?.envelope ?? '')).toMatchObject({
      head: { seq: 8 },
    });
  });

  it('tries a push control didn’t take again, and names the Whombat it was brought back from once', async () => {
    material = { ...material, generation: 4 };
    m.manager.kitFails = new ManagerCallError('/v1/backup/kit-envelopes', 503, 'control_unreachable', 'down');
    const before = m.manager.kitPushes.length;
    expect(await relock(m.t.services)).toBe('later');
    expect(m.manager.kitPushes).toHaveLength(before);
    const c = await m.client(owner);
    expect(await c.request('backup.status', {})).toMatchObject({
      output: { summary: { bringBack: { state: 'needs_passkey', passkeys: 1 } } },
    });
    m.manager.kitFails = null;
    await noteBroughtBack(m.t.services, OLD);
    await noteBroughtBack(m.t.services, 'not a device id');
    expect(await relock(m.t.services)).toBe('unchanged');
    expect(m.manager.kitPushes.at(-1)).toMatchObject({ adoptedFrom: OLD, envelopes: [{ generation: 4 }] });
    material = { ...material, head: { seq: 9, manifestSha256: 'c'.repeat(64), at: '2026-11-04T21:00:00Z' } };
    await relock(m.t.services);
    expect(m.manager.kitPushes.at(-1)?.adoptedFrom).toBeUndefined();
  });

  it('a finished bring back retires the passkeys that came with the backup, never one made since', async () => {
    await m.t.services.db.insert(appliancePasskeys).values({
      id: 'b2xkLXBhc3NrZXk',
      accountId: owner.accountId,
      name: 'Old phone',
      publicKey: Buffer.from([4, 5, 6]),
      backupEligible: true,
      backedUp: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await noteBroughtBack(m.t.services, OLD, '2026-06-01T00:00:00Z');
    const rows = await m.t.services.db.select().from(appliancePasskeys);
    expect(rows.find((r) => r.id === 'b2xkLXBhc3NrZXk')?.removedAt).not.toBeNull();
    expect(rows.find((r) => r.id === CREDENTIAL)?.removedAt).toBeNull();
  });

  it('the paper copy counts only for the details it was printed from', async () => {
    const c = await m.client(owner);
    expect(
      await c.request('backup.paperCopy.confirm', { repositoryId: 'repo-1', generation: 3 }),
    ).toMatchObject({
      t: 'error',
      details: { code: 'backup_paper_stale' },
    });
    expect(
      await c.request('backup.paperCopy.confirm', { repositoryId: 'repo-1', generation: 4 }),
    ).toMatchObject({
      t: 'result',
    });
  });

  it('goes with its passkey; then the paper copy is the way back, and the Inbox asks for the touch', async () => {
    const c = await m.client(owner);
    expect(await c.request('passkey.remove', { id: CREDENTIAL })).toMatchObject({ t: 'result' });
    const rows = await m.t.services.db
      .select()
      .from(backupPasskeyKeys)
      .where(eq(backupPasskeyKeys.credentialId, CREDENTIAL));
    expect(rows).toEqual([]);
    expect(await c.request('backup.status', {})).toMatchObject({
      output: { summary: { bringBack: { state: 'paper_only', passkeys: 0 } } },
    });
    const ctx = {
      db: m.t.services.db,
      burrowId: 'x',
      personId: IDS.mara,
      now: new Date(),
      services: m.t.services,
    };
    // A paper copy is a way back: nothing asks.
    expect(await backupPasskeyNeedsYou(ctx)).toEqual([]);
    material = { ...material, repositoryPassword: 'rotated' };
    await relock(m.t.services);
    const asks = await backupPasskeyNeedsYou(ctx);
    expect(asks.map((i) => i.ref)).toEqual([{ kind: 'backup', id: 'passkey' }]);
  });

  it('removing a key by hand is the person’s', async () => {
    await m.t.services.db
      .update(appliancePasskeys)
      .set({ removedAt: null })
      .where(eq(appliancePasskeys.id, CREDENTIAL));
    const c = await m.client(owner);
    await c.request('backup.passkeyKey.set', {
      credentialId: CREDENTIAL,
      salt: KIT_PRF_SALT_V2_B64,
      key: toBase64url(fromBase64url(toBase64url(key)) as Uint8Array),
    });
    expect(await c.request('backup.passkeyKey.remove', { credentialId: CREDENTIAL })).toMatchObject({
      t: 'result',
      output: { bringBack: { passkeys: 0 } },
    });
  });

  it('names the Whombat it was brought back from at once, before it has an envelope of its own', async () => {
    const gone = 'wb-old0-home-0002';
    await noteBroughtBack(m.t.services, gone);
    const before = m.manager.kitPushes.length;
    expect(await relock(m.t.services)).toBe('none');
    expect(m.manager.kitPushes.slice(before)).toEqual([
      expect.objectContaining({ envelopes: [], adoptedFrom: gone }),
    ]);
    // Told once.
    await relock(m.t.services);
    expect(m.manager.kitPushes).toHaveLength(before + 1);
  });

  it('pushes carry the Whombat’s own name', async () => {
    const name = await loadOwnName(m.t.services.db);
    expect(name).toBeTruthy();
    expect(
      m.manager.kitPushes.filter((p) => p.envelopes.length > 0).every((p) => p.applianceName === name),
    ).toBe(true);
  });

  it('the job locks again after a backup the manager’s report doesn’t carry, from the service’s own status', async () => {
    const c = await m.client(owner);
    await c.request('passkey.remove', { id: CREDENTIAL }).catch(() => {});
    await m.t.services.db
      .update(appliancePasskeys)
      .set({ removedAt: null })
      .where(eq(appliancePasskeys.id, CREDENTIAL));
    // The manager reports no backup status at all.
    useBoxBackup(m.t.services, { port: fake, status: () => null });
    const stop = startBackupKeys(
      m.t.services,
      { appliance: m.appliance.peerId, manager: m.manager },
      // No retry within the test: only the backup it sees makes it lock again.
      { lookMs: 20, retryMs: 10 * 60_000 },
    );
    try {
      await c.request('backup.passkeyKey.set', {
        credentialId: CREDENTIAL,
        salt: KIT_PRF_SALT_V2_B64,
        key: toBase64url(key),
      });
      const before = m.manager.kitPushes.length;
      material = {
        ...material,
        head: { seq: 12, manifestSha256: 'd'.repeat(64), at: '2026-11-05T03:00:00Z' },
      };
      lastId = 'ck-12';
      await vi.waitFor(
        () => {
          const last = m.manager.kitPushes.slice(before).at(-1);
          expect(opened(last?.envelopes[0]?.envelope ?? '')).toMatchObject({ head: { seq: 12 } });
        },
        { timeout: 5_000, interval: 20 },
      );
    } finally {
      stop();
      useBoxBackup(m.t.services, { port: fake, status });
    }
  });

  it('a manager from before names takes the push without one', async () => {
    m.manager.refusesNames = true;
    const before = m.manager.kitPushes.length;
    material = { ...material, head: { seq: 13, manifestSha256: 'e'.repeat(64), at: '2026-11-05T09:00:00Z' } };
    expect(await relock(m.t.services)).toBe('locked');
    const pushed = m.manager.kitPushes.slice(before);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.applianceName).toBeUndefined();
  });
});
