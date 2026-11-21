/**
 * The person's backup ops (MR-19) against a fake backup service, and quarantine mode (MR-20): no runner turns,
 * approved executions, automations or push while the backup service's quarantine marker exists.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupRecoveryMaterial } from '@whombat/protocol/session';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applianceEvents, commandReceipts } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import type { BackupPort } from './backup';

const m = useManagedRuntime({ seed: true });
const calls: { method: string; path: string; body: unknown }[] = [];
let answer: (path: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
const fake: BackupPort = {
  async call(method, path, body) {
    calls.push({ method, path, body });
    return answer(path);
  },
};
let owner: Awaited<ReturnType<typeof m.enroll>>;

beforeAll(async () => {
  m.runtime.dispatcher.backup = fake;
  owner = await m.enroll(IDS.mara);
});

describe('backup ops', () => {
  it('configure the destination (credentials passed through, never audited), show material, run now', async () => {
    const c = await m.client(owner);
    answer = (path) =>
      path === '/v1/destination'
        ? { status: 200, body: { repositoryId: 'r1', appendOnly: 'verified', generation: 2 } }
        : path === '/v1/recovery-material'
          ? {
              status: 200,
              body: {
                kind: 'whombat.backup-recovery-material/1',
                generation: 2,
                repositoryId: 'r1',
                repositoryPassword: 's3cret',
              },
            }
          : path === '/v1/checkpoints'
            ? { status: 200, body: { ok: true, ref: 'ck-1', verified: false, id: 'ck-1', seq: 1 } }
            : { status: 200, body: null };
    const set = await c.request('backup.configureDestination', {
      repository: 'rest:https://backup.example.com/appliance/',
      restUser: 'app',
      restPassword: 'rest-pass',
      allowInit: true,
    });
    expect(set).toMatchObject({
      t: 'result',
      output: { repositoryId: 'r1', appendOnly: 'verified', generation: 2 },
    });
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/v1/destination',
      body: { restPassword: 'rest-pass' },
    });
    expect(
      await c.request('backup.configureDestination', { repository: 'rest:https://u:p@x/' }),
    ).toMatchObject({
      t: 'error',
      code: 'validation_failed',
    });
    const material = await c.request('backup.recoveryMaterial', {});
    expect(material).toMatchObject({ t: 'result', output: { repositoryPassword: 's3cret' } });
    expect(await c.request('backup.runNow', {})).toMatchObject({ t: 'result', output: { ref: 'ck-1' } });
    answer = () => ({ status: 409, body: { error: 'busy' } });
    expect(await c.request('backup.runNow', {})).toMatchObject({
      t: 'error',
      details: { code: 'backup_busy' },
    });
    const events = await m.t.services.db.select().from(applianceEvents);
    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'backup.destination_set',
        'backup.recovery_material_viewed',
        'backup.run_requested',
      ]),
    );
    expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/rest-pass|s3cret/);
    const status = await c.request('backup.status', {});
    expect(status).toMatchObject({ t: 'error', details: { code: 'backup_unavailable' } });
  });
});

describe('backup destinations beyond the REST server (MD-17, CT-142)', () => {
  const S3 = {
    repository: 's3:https://s3.example.com/whombat-backups/box-1',
    s3AccessKeyId: 'AKIAEXAMPLEKEY01',
    s3SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY',
    s3Region: 'eu-central-1',
    allowInit: true,
  };

  it('pass an S3 bucket’s credentials to the backup service and nowhere else', async () => {
    const c = await m.client(owner);
    answer = () => ({
      status: 200,
      body: { repositoryId: 'r-s3', appendOnly: 'not-enforced', generation: 3, kind: 's3' },
    });
    const set = await c.request('backup.configureDestination', S3);
    expect(set).toMatchObject({
      t: 'result',
      output: { repositoryId: 'r-s3', appendOnly: 'not-enforced', generation: 3, kind: 's3' },
    });
    // The input goes to the service as the person sent it.
    expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/v1/destination', body: S3 });
    const [event] = await m.t.services.db
      .select()
      .from(applianceEvents)
      .where(eq(applianceEvents.type, 'backup.destination_set'))
      .orderBy(desc(applianceEvents.seq))
      .limit(1);
    expect(event?.payload).toMatchObject({ kind: 's3', host: 's3.example.com', repositoryId: 'r-s3' });
    const receipts = await m.t.services.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.op, 'backup.configureDestination'));
    const kept = JSON.stringify([event, receipts]);
    expect(kept).not.toContain(S3.s3AccessKeyId);
    expect(kept).not.toContain(S3.s3SecretAccessKey);
  });

  it('never answer (or keep) a credential a refusing service echoes', async () => {
    const c = await m.client(owner);
    answer = () => ({
      status: 400,
      body: { error: `the bucket refused key ${S3.s3AccessKeyId} with secret ${S3.s3SecretAccessKey}` },
    });
    const refused = await c.request('backup.configureDestination', S3);
    expect(refused).toMatchObject({
      t: 'error',
      code: 'conflict',
      message: 'the bucket refused key [redacted] with secret [redacted]',
      details: { code: 'backup_destination_failed' },
    });
    const receipts = await m.t.services.db.select().from(commandReceipts);
    expect(JSON.stringify(receipts)).not.toContain(S3.s3SecretAccessKey);
  });

  it('SFTP: the box’s public key, the pinned host key’s fingerprint back', async () => {
    const c = await m.client(owner);
    const key = {
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyExampleKeyExampleKey whombat-backup@box-1',
      fingerprint: 'SHA256:3pd8Tg1ZlJmL3lzHa7NaKe2m1xnEXAMPLEfingerprint',
    };
    answer = (path) =>
      path === '/v1/ssh-public-key' ? { status: 200, body: key } : { status: 500, body: null };
    expect(await c.request('backup.sshPublicKey', {})).toMatchObject({ t: 'result', output: key });
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/v1/ssh-public-key' });
    answer = () => ({
      status: 200,
      body: {
        repositoryId: 'r-sftp',
        appendOnly: 'not-enforced',
        generation: 4,
        kind: 'sftp',
        hostKeyFingerprint: 'SHA256:nasHostKeyFingerprintExample',
      },
    });
    const sftp = { repository: 'sftp:nas.local:/volume1/whombat', sftpUser: 'whombat', allowInit: true };
    expect(await c.request('backup.configureDestination', sftp)).toMatchObject({
      t: 'result',
      output: { kind: 'sftp', hostKeyFingerprint: 'SHA256:nasHostKeyFingerprintExample' },
    });
    expect(calls.at(-1)).toEqual({ method: 'PUT', path: '/v1/destination', body: sftp });
    // A backup service from before SFTP destinations, and one that answers nonsense.
    answer = () => ({ status: 404, body: null });
    expect(await c.request('backup.sshPublicKey', {})).toMatchObject({
      t: 'error',
      code: 'not_implemented',
      details: { code: 'backup_unavailable' },
    });
    answer = () => ({ status: 200, body: { publicKey: 42 } });
    expect(await c.request('backup.sshPublicKey', {})).toMatchObject({
      t: 'error',
      details: { code: 'backup_unavailable' },
    });
  });

  it('a destination slower than the request’s deadline: accepted first, then its answer (MD-17)', async () => {
    const c = await m.client(owner);
    const slow: BackupPort = {
      async call(method, path, body) {
        calls.push({ method, path, body });
        // A disk formatted and mounted first (BK-20): longer than the request's deadline.
        await new Promise((resolve) => setTimeout(resolve, 600));
        return {
          status: 200,
          body: { repositoryId: 'r-slow', appendOnly: 'not-enforced', generation: 6, kind: 'disk' },
        };
      },
    };
    m.runtime.dispatcher.backup = slow;
    try {
      const answer = await c.request(
        'backup.configureDestination',
        { repository: 'disk:', allowInit: true },
        { deadlineMs: 200 },
      );
      expect(answer).toMatchObject({ t: 'result', output: { repositoryId: 'r-slow', kind: 'disk' } });
      // The client heard `accepted` before the service answered, so its deadline no longer applied.
      const id = (answer as { id: string }).id;
      const accepted = c.received.findIndex((x) => x.t === 'accepted' && x.id === id);
      expect(accepted).toBeGreaterThanOrEqual(0);
      expect(accepted).toBeLessThan(c.received.indexOf(answer));
    } finally {
      m.runtime.dispatcher.backup = fake;
    }
  });

  it('the recovery material reaches the kit whole, with the newest checkpoint’s head (contracts 0.22.3)', async () => {
    const c = await m.client(owner);
    const material = BackupRecoveryMaterial.parse({
      kind: 'whombat.backup-recovery-material/1',
      applianceId: 'box-1',
      generation: 3,
      createdAt: '2026-09-28T18:00:00Z',
      repository: 's3:https://s3.example.com/whombat-backups/box-1',
      s3AccessKeyId: S3.s3AccessKeyId,
      s3SecretAccessKey: S3.s3SecretAccessKey,
      s3Region: S3.s3Region,
      repositoryPassword: 'repo-password',
      repositoryId: 'r-s3',
      manifestKey: `ed25519:${Buffer.alloc(32, 7).toString('base64')}`,
      head: { seq: 42, manifestSha256: 'ab'.repeat(32), at: '2026-09-28T19:00:00Z' },
    });
    expect(material.head).toBeDefined();
    answer = (path) =>
      path === '/v1/recovery-material' ? { status: 200, body: material } : { status: 500, body: null };
    const got = await c.request('backup.recoveryMaterial', {});
    expect(got).toMatchObject({ t: 'result', output: material });
    // What the person's app reads with this contract keeps it too (the withheld-checkpoint check, BK review I-2).
    expect(BackupRecoveryMaterial.parse((got as { output: unknown }).output).head).toEqual(material.head);
  });

  it('the attached backup disk', async () => {
    const c = await m.client(owner);
    answer = () => ({
      status: 200,
      body: { repositoryId: 'r-disk', appendOnly: 'not-enforced', generation: 5, kind: 'disk' },
    });
    expect(
      await c.request('backup.configureDestination', { repository: 'disk:', allowInit: true }),
    ).toMatchObject({ t: 'result', output: { kind: 'disk', repositoryId: 'r-disk' } });
    const [event] = await m.t.services.db
      .select()
      .from(applianceEvents)
      .where(eq(applianceEvents.type, 'backup.destination_set'))
      .orderBy(desc(applianceEvents.seq))
      .limit(1);
    expect(event?.payload).toMatchObject({ kind: 'disk', host: 'disk' });
  });
});

describe('quarantine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-quarantine-'));
  const marker = join(dir, 'quarantine.json');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('follows the marker: no turns, automations or push while it exists', async () => {
    m.runtime.watchQuarantine(marker, 50);
    expect(m.t.services.maintenance.quarantined).toBe(false);
    writeFileSync(marker, '{"kind":"whombat.quarantine/1"}');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(m.t.services.maintenance.quarantined).toBe(true);
    expect(m.t.services.maintenance.paused).toBe(true);
    expect(await m.t.services.runtime.claimOne('rnr_test', ['claude'])).toBeNull();
    const before = m.manager.pushes.length;
    await m.t.services.push.control?.([IDS.mara], {
      burrow: 'burrow-hq',
      notificationId: null,
      kind: 'mention',
      title: 't',
      body: 'b',
      path: '/',
    });
    expect(m.manager.pushes.length).toBe(before);
    rmSync(marker);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(m.t.services.maintenance.quarantined).toBe(false);
    const [row] = await m.t.services.db.select().from(applianceEvents).where(eq(applianceEvents.seq, 1));
    expect(row).toBeTruthy();
  });
});

describe('appliance.status reads the backup service', () => {
  it('says the box is backed up when the service says so, though the manager forwards no backup facts', async () => {
    const at = new Date().toISOString();
    const status = {
      kind: 'whombat.backup-status/1',
      state: 'protected',
      protected: true,
      destination: { configured: true, kind: 'rest', display: 'BlackBox', appendOnly: 'verified' },
      lastSuccess: {
        id: 'ck-1',
        at,
        ageSeconds: 5,
        snapshotId: 'snap1',
        method: 'snapshot',
        quiesceHeldMs: 10,
        durationMs: 1000,
        bytesAdded: 1,
        totalBytes: 2,
        files: 3,
        schemaVersion: 1,
      },
      lastFailure: null,
      lastAttemptOk: true,
      coverage: [],
      recoverability: { lastDrill: null },
      kitGeneration: 1,
      running: null,
      updatedAt: at,
    };
    answer = (path) => (path === '/v1/status' ? { status: 200, body: status } : { status: 404, body: null });
    const { useBoxBackup } = await import('./box-backup');
    useBoxBackup(m.t.services, { port: fake, status: () => null });
    const c = await m.client(owner);
    const out = await c.request('appliance.status', {});
    expect(out).toMatchObject({ t: 'result', output: { backup: { state: 'protected', lastSuccessAt: at } } });
  });
});
