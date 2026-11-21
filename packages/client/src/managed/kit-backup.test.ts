import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAppliance } from '../session/fake';
import type { KitBackup } from '../session/managed-ops';
import { createSecureSession } from '../session/secure';
import type { ApplianceSession } from '../session/types';
import { isPeerId } from './pin';
import {
  KIT_BACKUP_TEXT,
  KIT_VERSION,
  kitBackupComplete,
  kitText,
  loadKitBackup,
  newRecoveryKit,
  readKitFile,
} from './recovery';

const PEER = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const kit = newRecoveryKit({ applianceName: 'Studio', device: 'dev_7KQ2M4XD', appliancePeerId: PEER });
const PEM = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBGYWtlV2hvbWJhdEJhY2t1cEtleQ==',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

const base = {
  kind: 'whombat.backup-recovery-material/1' as const,
  applianceId: 'dev_7KQ2M4XD',
  generation: 2,
  createdAt: '2026-09-28T18:00:00Z',
  repositoryPassword: 'rp-0123456789ab',
  repositoryId: 'repo_4f2a',
  manifestKey: 'ed25519:bWFuaWZlc3Qta2V5LWZha2U=',
};
const REST: KitBackup = {
  ...base,
  repository: 'rest:https://backup.example.com/whombat/',
  restUser: 'wb',
  restPassword: 'rest-secret',
};
const S3: KitBackup = {
  ...base,
  repository: 's3:https://s3.eu-central-1.amazonaws.com/burrow-backups/whombat',
  s3AccessKeyId: 'AKIAFAKE0123',
  s3SecretAccessKey: 'fake/secret+key',
  s3Region: 'eu-central-1',
};
const SFTP: KitBackup = {
  ...base,
  repository: 'sftp:nas.burrowhq.example:/srv/whombat',
  sftpUser: 'whombat',
  sftpPrivateKey: PEM,
  sftpHostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOnasHostKey0123456789',
  head: { seq: 12, manifestSha256: 'a'.repeat(64), at: '2026-09-28T17:00:00Z' },
};
const DISK: KitBackup = { ...base, repository: 'disk:' };

/** The backup section's lines and its JSON line, from a kit's text. */
function section(text: string): { lines: string[]; json: unknown } {
  const lines = text.split('\n');
  const at = lines.indexOf('Backup section for whombat-backup (save the next line as kit.json):');
  return { lines, json: at >= 0 ? JSON.parse(lines[at + 1] as string) : null };
}

describe('the recovery kit’s backup section, per destination kind (kit version 3, AP-265)', () => {
  it('REST: the destination, its user and password', () => {
    const text = kitText(kit, REST, 'acc_mara');
    expect(text).toContain(`Kit version: ${KIT_VERSION}`);
    expect(KIT_VERSION).toBe(3);
    for (const line of [
      'Destination: rest:https://backup.example.com/whombat/',
      'Destination user: wb',
      'Destination password: rest-secret',
      'Repository password: rp-0123456789ab',
      'Repository: repo_4f2a · generation 2',
      'Manifest key: ed25519:bWFuaWZlc3Qta2V5LWZha2U=',
    ])
      expect(text).toContain(line);
    expect(section(text).json).toEqual(REST);
  });

  it('S3: the access key, the secret key and the region', () => {
    const text = kitText(kit, S3, 'acc_mara');
    expect(text).toContain('Destination: s3:https://s3.eu-central-1.amazonaws.com/burrow-backups/whombat');
    expect(text).toContain('S3 access key: AKIAFAKE0123');
    expect(text).toContain('S3 secret key: fake/secret+key');
    expect(text).toContain('S3 region: eu-central-1');
    expect(section(text).json).toEqual(S3);
  });

  it('SFTP: the user, the pinned host key and the box’s private key as its PEM block', () => {
    const text = kitText(kit, SFTP, 'acc_mara');
    expect(text).toContain('SFTP user: whombat');
    expect(text).toContain('SFTP host key: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOnasHostKey0123456789');
    expect(text).toContain(`SFTP private key:\n${PEM}\n`);
    // The appliance's `whombat-backup -kit` reads the section itself, head included.
    expect(section(text).json).toEqual(SFTP);
  });

  it('a disk: the destination, nothing else to reach it', () => {
    const text = kitText(kit, DISK, 'acc_mara');
    expect(text).toContain('Destination: disk:');
    expect(text).not.toMatch(/S3 |SFTP |Destination user/);
    expect(section(text).json).toEqual(DISK);
  });

  it('every kind reads back as a checksummed kit that names the identity', () => {
    for (const b of [REST, S3, SFTP, DISK]) {
      const read = readKitFile(kitText(kit, b, 'acc_mara'));
      expect(read).toEqual({
        ok: true,
        kit: {
          secretKeyHex: kit.secretKeyHex,
          device: 'dev_7KQ2M4XD',
          accountId: 'acc_mara',
          appliancePeerId: PEER,
          version: 3,
        },
      });
      expect(isPeerId(read.ok ? read.kit.appliancePeerId : null)).toBe(true);
    }
    // A changed private key line is caught.
    expect(readKitFile(kitText(kit, SFTP).replace('QyNTUxOQAAACBG', 'QyNTUxOQAAACBH'))).toEqual({
      ok: false,
      reason: 'damaged',
    });
  });

  it('what a kind needs to reach its repository from another machine (the appliance’s own rule)', () => {
    expect(kitBackupComplete(S3)).toBe(true);
    expect(kitBackupComplete({ ...S3, s3SecretAccessKey: undefined })).toBe(false);
    expect(kitBackupComplete(SFTP)).toBe(true);
    expect(kitBackupComplete({ ...SFTP, sftpHostKey: undefined })).toBe(false);
    expect(kitBackupComplete(REST)).toBe(true);
    expect(kitBackupComplete(DISK)).toBe(true);
  });

  it('a gap is said in the kit, never a part of the section', () => {
    const text = kitText(kit, { gap: 'newer_app' }, 'acc_mara');
    expect(text).toContain(`Backups: not in this kit. ${KIT_BACKUP_TEXT.newer_app}`);
    expect(text).not.toContain('Destination:');
    expect(text).not.toContain('Backup section for whombat-backup');
    expect(kitText(kit, null)).toContain('Backups: none set up when this kit was made.');
  });
});

describe('the kit’s backup section from the appliance (AP-265)', () => {
  const live: ApplianceSession[] = [];
  afterEach(() => {
    for (const s of live.splice(0)) s.close();
  });
  function answering(status: number, body: unknown) {
    const appliance = createFakeAppliance({
      account: { id: 'acc_mara', name: 'Mara' },
      handle: async (op) =>
        op === 'backup.recoveryMaterial'
          ? { status, body }
          : { status: 404, body: { error: { code: 'unknown_op' } } },
    });
    const session = createSecureSession({
      connector: appliance.connector,
      backoff: { initialMs: 2, maxMs: 5 },
    });
    live.push(session);
    return session;
  }

  it('carries every member it knows, head included', async () => {
    expect(await loadKitBackup(answering(200, SFTP))).toEqual(SFTP);
  });

  it('a member this app doesn’t know: not written at all, and said so', async () => {
    const newer = { ...SFTP, sftpJumpHost: 'bastion.burrowhq.example' };
    expect(await loadKitBackup(answering(200, newer))).toEqual({ gap: 'newer_app' });
  });

  it('an S3 or SFTP section without what it needs is incomplete', async () => {
    const { s3SecretAccessKey: _, ...noSecret } = S3;
    expect(await loadKitBackup(answering(200, noSecret))).toEqual({ gap: 'incomplete' });
  });

  it('no destination: no section; a failed ask: said so', async () => {
    expect(
      await loadKitBackup(
        answering(409, { error: { code: 'backup_unprotected', message: 'No destination.' } }),
      ),
    ).toBeNull();
    expect(await loadKitBackup(answering(503, { error: { code: 'unavailable', message: 'x' } }))).toEqual({
      gap: 'unreachable',
    });
  });
});
