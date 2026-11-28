/**
 * The copy somewhere else (offsite-copy.md): the bucket's address as the backup service takes it, the service's document
 * as the app reads it, the recovery material an older app gets, and the Inbox's item. Pure.
 */
import {
  type BackupOffsite,
  BackupOffsite as BackupOffsiteSchema,
  type BackupOffsiteServiceDoc,
  BackupRecoveryMaterial,
  OFFSITE_MINOR,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { OFFSITE_FAILURES, OFFSITE_LATE_MS, offsiteItem } from '../home/box-backup';
import { materialFor } from './backup';
import { endpointOf, offsiteOf, offsiteRepository, placeOf } from './backup-offsite';
import { offsiteForAgent } from './backup-tool';

const NOW = new Date('2026-11-28T10:00:00Z');

const doc = (over: Partial<BackupOffsiteServiceDoc> = {}): BackupOffsiteServiceDoc => ({
  kind: 'whombat.backup-offsite/1',
  configured: true,
  state: 'ok',
  provider: 'b2',
  display: 's3.eu-central-003.backblazeb2.com/my-backups/box',
  repository: 's3:https://s3.eu-central-003.backblazeb2.com/my-backups/box',
  s3Region: 'eu-central-003',
  configuredAt: '2026-11-20T10:00:00Z',
  running: false,
  lastCopy: {
    at: '2026-11-28T03:10:00Z',
    checkpointId: 'ck-1',
    checkpointAt: '2026-11-28T03:00:00Z',
    count: 1,
  },
  failedAttempts: 0,
  newestBackupAt: '2026-11-28T03:00:00Z',
  backupsInCopy: 12,
  ...over,
});

describe('the bucket’s address', () => {
  it('takes the storage’s host with or without https, never a path, a user or a query', () => {
    expect(endpointOf('s3.eu-central-003.backblazeb2.com')?.host).toBe('s3.eu-central-003.backblazeb2.com');
    expect(endpointOf('https://fsn1.your-objectstorage.com/')?.host).toBe('fsn1.your-objectstorage.com');
    expect(endpointOf('http://192.168.1.20:9000')?.protocol).toBe('http:');
    for (const bad of [
      'http://s3.example.com',
      'http://203.0.113.9:9000',
      'https://host/bucket',
      'https://key:secret@host',
      'ftp://host',
      'https://host?x=1',
      '',
    ])
      expect(endpointOf(bad)).toBeNull();
  });

  it('takes plain http by the backup service’s own rule: the home network, this machine, link-local', () => {
    // The same table as the backup service's own test (appliance/backup/internal/offsite/offsite_test.go).
    const table: Record<string, boolean> = {
      '192.168.1.20:9000': true,
      '10.0.0.5': true,
      '172.16.0.1': true,
      '127.0.0.1:9000': true,
      '169.254.10.10': true,
      '[fd00::1]:9000': true,
      '[::1]': true,
      '[fe80::1]': true,
      '[::ffff:192.168.1.20]': true,
      '203.0.113.9': false,
      '172.32.0.1': false,
      's3.example.com': false,
      'localhost:9000': false,
      '[2001:db8::1]': false,
      '[::ffff:203.0.113.9]': false,
    };
    for (const [host, ok] of Object.entries(table))
      expect([host, endpointOf(`http://${host}`) !== null]).toEqual([host, ok]);
  });

  it('makes the restic repository and reads it back for the form', () => {
    const repository = offsiteRepository({
      endpoint: 'https://s3.eu-central-003.backblazeb2.com',
      bucket: 'my-backups',
      folder: '/box/',
    });
    expect(repository).toBe('s3:https://s3.eu-central-003.backblazeb2.com/my-backups/box');
    expect(placeOf(repository ?? '')).toEqual({
      endpoint: 's3.eu-central-003.backblazeb2.com',
      bucket: 'my-backups',
      folder: 'box',
    });
    expect(offsiteRepository({ endpoint: 'http://192.168.1.20:9000', bucket: 'whombat' })).toBe(
      's3:http://192.168.1.20:9000/whombat',
    );
    expect(placeOf('s3:http://192.168.1.20:9000/whombat')?.endpoint).toBe('http://192.168.1.20:9000');
    expect(placeOf('/srv/copy')).toBeNull();
  });
});

describe('the service’s document', () => {
  it('reads as the app shows it: never a key, the step of a failure, none when unset', () => {
    const o = offsiteOf(doc()) as BackupOffsite;
    expect(BackupOffsiteSchema.safeParse(o).success).toBe(true);
    expect(o).toMatchObject({
      provider: 'b2',
      bucket: 'my-backups',
      folder: 'box',
      state: 'ok',
      backupsInCopy: 12,
    });
    expect(o.lastFailure).toBeNull();
    const failing = offsiteOf(
      doc({
        state: 'failing',
        failedAttempts: 2,
        lastFailure: {
          at: '2026-11-28T09:00:00Z',
          step: 'keys',
          reason: 'The storage didn’t accept the key.',
        },
        nextTryAt: '2026-11-28T09:30:00Z',
      }),
    );
    expect(failing?.lastFailure).toEqual({ at: '2026-11-28T09:00:00Z', step: 'keys' });
    expect(failing?.nextTryAt).toBe('2026-11-28T09:30:00Z');
    // A step this runtime doesn't know is a copy that stopped; a provider it doesn't know is any S3 storage.
    expect(
      offsiteOf(
        doc({
          provider: 'wasabi',
          failedAttempts: 1,
          lastFailure: { at: NOW.toISOString(), step: 'x', reason: '' },
        }),
      ),
    ).toMatchObject({ provider: 's3', lastFailure: { step: 'copy' } });
    expect(offsiteOf(doc({ configured: false, state: 'none' }))).toBeNull();
  });
});

describe('the recovery material', () => {
  const material = {
    kind: 'whombat.backup-recovery-material/1',
    applianceId: 'apl-1',
    generation: 2,
    createdAt: '2026-11-28T10:00:00Z',
    repository: 'rest:https://nas.example.com/box/',
    repositoryPassword: 'pw',
    repositoryId: 'repo-1',
    manifestKey: 'ed25519:x',
    offsite: {
      provider: 'b2',
      repository: 's3:https://s3.eu-central-003.backblazeb2.com/my-backups/box',
      s3AccessKeyId: 'KEYID',
      s3SecretAccessKey: 'secret',
      repositoryId: 'copy-1',
    },
  };

  it('names the second place to an app that reads it, and leaves it out for an older one', () => {
    expect(BackupRecoveryMaterial.strict().safeParse(materialFor(material, OFFSITE_MINOR)).success).toBe(
      true,
    );
    const older = materialFor(material, OFFSITE_MINOR - 1);
    expect('offsite' in older).toBe(false);
    expect(BackupRecoveryMaterial.strict().omit({ offsite: true }).safeParse(older).success).toBe(true);
    // Not a session (the server's own reads): unchanged.
    expect(materialFor(material, undefined)).toBe(material);
  });
});

describe('the Inbox’s item', () => {
  const offsite = (over: Partial<BackupOffsite>): BackupOffsite => ({
    ...(offsiteOf(doc()) as BackupOffsite),
    ...over,
  });

  it('waits for repeated failures, then says why and that the backups here are fine', () => {
    const fail = { at: '2026-11-28T09:00:00Z', step: 'keys' as const };
    expect(offsiteItem(offsite({ state: 'failing', failedAttempts: 1, lastFailure: fail }), NOW)).toBeNull();
    const item = offsiteItem(
      offsite({ state: 'failing', failedAttempts: OFFSITE_FAILURES, lastFailure: fail }),
      NOW,
      'nl-NL',
    );
    expect(item).toMatchObject({
      kind: 'alert',
      nature: 'you',
      href: '/settings?tab=appliance&section=backups',
    });
    expect(item?.body).toContain('Backblaze B2');
    // The episode is everything since the last copy that worked: one id, so an Ignore lasts it.
    expect(item?.id).toBe('backup:offsite:2026-11-28T03:10:00Z');
  });

  it('says the copy is behind only after two days of newer backups waiting', () => {
    const behind = (lastCopyAt: string) => offsiteItem(offsite({ state: 'behind', lastCopyAt }), NOW);
    expect(behind(new Date(NOW.getTime() - OFFSITE_LATE_MS + 60_000).toISOString())).toBeNull();
    expect(behind(new Date(NOW.getTime() - OFFSITE_LATE_MS - 60_000).toISOString())).not.toBeNull();
    expect(offsiteItem(offsite({ state: 'ok', lastCopyAt: '2026-11-01T00:00:00Z' }), NOW)).toBeNull();
    // With no backup at the main place there is nothing to copy, so nothing is late.
    expect(
      offsiteItem(
        offsite({ state: 'first', lastCopyAt: null, newestInCopyAt: null, newestBackupAt: null }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe('the assistant', () => {
  it('reads where the copy is by name and why it fails, never a key or an address', () => {
    const read = offsiteForAgent(
      offsiteOf(
        doc({
          state: 'failing',
          failedAttempts: 3,
          lastFailure: { at: '2026-11-28T09:00:00Z', step: 'bucket', reason: '' },
        }),
      ) as BackupOffsite,
    );
    expect(read).toMatchObject({ place: 'Backblaze B2', state: 'failing' });
    expect(read.problem).toBeTruthy();
    expect(JSON.stringify(read)).not.toContain('backblazeb2.com');
  });
});
