import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import { backupErrorText, destinationInput, emptyBackupForm } from './backup-setup';
import { buildNumberOfVersion } from './build';
import { ACCOUNTS_TEXT } from './status-copy';
import {
  askFirstView,
  backupBlocksText,
  hasUpdateCheck,
  sinceText,
  type UpdateStatus,
  updateCheckNotice,
  updatePollMs,
  updateReady,
  updateView,
} from './updates';

const NOW = new Date('2026-09-29T12:00:00Z');
const base: UpdateStatus = {
  state: 'Healthy',
  current: 'pve-20260928.6',
  candidate: null,
  lastCheckedAt: '2026-09-29T11:55:00Z',
  deferredReason: null,
  failure: null,
};
const protectedBackup = { state: 'protected' } as const;
const view = (update: UpdateStatus, backup: { state: string } = protectedBackup) =>
  updateView({ update, backup: backup as never }, { now: NOW, timeZone: 'UTC' });

describe('build numbers from the version (AP-259)', () => {
  it('major × 1e6 + minor × 1e3 + patch; not X.Y.Z is 0', () => {
    expect(buildNumberOfVersion('0.12.0')).toBe(12000);
    expect(buildNumberOfVersion('0.11.1')).toBe(11001);
    expect(buildNumberOfVersion('1.2.3')).toBe(1002003);
    expect(buildNumberOfVersion('0.12.0-rc.1')).toBe(12000);
    expect(buildNumberOfVersion('dev')).toBe(0);
    expect(buildNumberOfVersion('0.1000.0')).toBe(0);
  });
});

describe('This Whombat · UPDATES (AP-258)', () => {
  it('up to date, with the last update', () => {
    const v = view({
      ...base,
      lastUpdate: { release: 'pve-20260928.6', from: 'pve-20260928.4', at: '2026-09-28T18:10:00Z' },
    });
    expect(v.rows).toEqual([
      { dot: 'ok', title: 'Up to date', meta: 'Software pve-20260928.6' },
      { dot: 'ok', title: 'Updated to pve-20260928.6 on 28 September 2026', lastUpdate: true },
    ]);
    expect(v.summaryOf).toBe('pve-20260928.6');
    expect(v.pollMs).toBeNull();
  });

  it('waiting for work to finish: what runs and since when; asked again every 15 s', () => {
    const v = view({
      ...base,
      state: 'WaitingForSafeBoundary',
      candidate: 'pve-20260929.1',
      deferredReason: 'task_running',
      waiting: { reason: 'boundary', since: '2026-09-29T11:02:00Z', blockers: [{ kind: 'run', count: 2 }] },
    });
    expect(v.rows[1]).toEqual({
      dot: 'warn',
      title: 'It waits for work in progress to finish.',
      meta: '2 runs in progress · Waiting since 11:02',
    });
    expect(v.pollMs).toBe(15_000);
  });

  it('waiting for a backup without a destination: the way to set one up', () => {
    const update: UpdateStatus = {
      ...base,
      state: 'Staged',
      candidate: 'pve-20260930.1',
      waiting: {
        reason: 'checkpoint',
        since: '2026-09-27T08:00:00Z',
        blockers: [{ kind: 'no_destination', count: 1 }],
      },
    };
    const waiting = view(update, { state: 'unprotected' });
    expect(waiting.rows[1]).toEqual({
      dot: 'warn',
      title:
        'It needs a backup destination first: it changes the database in a way that can’t be undone. Set one up and it goes ahead.',
      meta: 'Waiting since 27 September',
      action: 'backup',
    });
    expect(waiting.pollMs).toBe(5_000);
  });

  it('a failed update: why, in plain words, and that nothing changed', () => {
    const v = view({
      ...base,
      state: 'Failed',
      current: 'pve-20260928.4',
      candidate: 'pve-20260928.5',
      failure: 'schema_incompatible',
      failureDetail: {
        stage: 'Staged',
        code: 'schema_incompatible',
        reasons: ['candidate_cannot_read_schema'],
        release: 'pve-20260928.5',
        schema: { database: 48, target: null, candidateWrites: 49, candidateReads: { min: 49, max: 49 } },
        failedChecks: [],
        at: 1790000000,
      },
    });
    expect(v.rows[0]).toEqual({
      dot: 'bad',
      title: 'The last update didn’t work · still on the previous version',
      meta: 'pve-20260928.5 couldn’t start on this Whombat’s database: it reads schema 49 only and the database is at 48. Nothing was changed. Your Whombat is still on pve-20260928.4.',
    });
  });

  it('a failed update from a runtime without the detail still says nothing changed', () => {
    expect(view({ ...base, state: 'Failed', failure: 'health_check_failed' }).rows[0]?.meta).toBe(
      'Your Whombat is still on pve-20260928.6. Nothing changed.',
    );
  });

  it('forward repair is worded, not shown as a failure', () => {
    const v = view({ ...base, state: 'ForwardRepairRequired', current: 'pve-20261001.1' });
    expect(v.rows[0]?.dot).toBe('warn');
    expect(v.rows[0]?.title).toBe('Updated · can’t go back to the previous version');
    expect(v.rows[0]?.meta).toContain('installs a fixed version as soon as there is one');
  });

  it('asks again while an update moves; not when settled', () => {
    expect(updatePollMs({ ...base, state: 'Downloading' })).toBe(5_000);
    expect(updatePollMs({ ...base, state: 'Verifying' })).toBe(5_000);
    expect(updatePollMs({ ...base, state: 'Failed' })).toBeNull();
    expect(updatePollMs(null)).toBeNull();
  });

  it('since: a time today, a date before', () => {
    expect(sinceText('2026-09-29T08:05:00Z', NOW, 'UTC')).toBe('08:05');
    expect(sinceText('2026-09-20T08:05:00Z', NOW, 'UTC')).toBe('20 September');
  });

  it('what a missing destination blocks', () => {
    expect(backupBlocksText({ backup: { state: 'unprotected' } as never })).toBe(
      'Updates that change the database in a breaking way wait until a backup exists.',
    );
    expect(backupBlocksText({ backup: { state: 'protected' } as never })).toBeNull();
  });
});

describe('backup destinations (AP-260)', () => {
  it('an S3 bucket: endpoint, bucket and folder make the repository; the keys travel beside it', () => {
    const r = destinationInput({
      ...emptyBackupForm('s3'),
      s3Endpoint: 's3.eu-central-1.amazonaws.com/',
      s3Bucket: 'burrow-backups',
      s3Folder: '/whombat/',
      s3AccessKeyId: ' AKIA123 ',
      s3SecretAccessKey: 'secret/key',
      s3Region: 'eu-central-1',
    });
    expect(r).toEqual({
      ok: true,
      input: {
        repository: 's3:https://s3.eu-central-1.amazonaws.com/burrow-backups/whombat',
        s3AccessKeyId: 'AKIA123',
        s3SecretAccessKey: 'secret/key',
        s3Region: 'eu-central-1',
        allowInit: true,
      },
    });
    expect(
      destinationInput({ ...emptyBackupForm('s3'), s3Endpoint: 'https://u:p@s3.example.com' }),
    ).toMatchObject({
      ok: false,
      field: 's3Endpoint',
    });
    expect(
      destinationInput({ ...emptyBackupForm('s3'), s3Endpoint: 'https://minio.local:9000', s3Bucket: 'b1' }),
    ).toMatchObject({ ok: false, field: 's3AccessKeyId' });
  });

  it('SFTP: restic’s spelling with and without a port; the user and a pinned host key beside it', () => {
    const form = {
      ...emptyBackupForm('sftp'),
      sftpHost: 'nas.local',
      sftpPath: '/srv/whombat',
      sftpUser: 'whombat',
    };
    expect(destinationInput(form)).toEqual({
      ok: true,
      input: { repository: 'sftp:nas.local:/srv/whombat', sftpUser: 'whombat', allowInit: true },
    });
    expect(
      destinationInput({
        ...form,
        sftpPort: '2222',
        sftpHostKey: 'nas.local ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOnasHostKey0123456789',
        adoptPassword: 'rp-123',
      }),
    ).toEqual({
      ok: true,
      input: {
        repository: 'sftp://nas.local:2222//srv/whombat',
        sftpUser: 'whombat',
        sftpHostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOnasHostKey0123456789',
        adoptPassword: 'rp-123',
      },
    });
    // Port 22 is SSH's own: the short form.
    expect(destinationInput({ ...form, sftpPort: '22' })).toMatchObject({
      ok: true,
      input: { repository: 'sftp:nas.local:/srv/whombat' },
    });
    expect(destinationInput({ ...form, sftpPath: 'srv/whombat' })).toMatchObject({
      ok: false,
      field: 'sftpPath',
    });
    expect(destinationInput({ ...form, sftpHost: 'me@nas' })).toMatchObject({ ok: false, field: 'sftpHost' });
    expect(destinationInput({ ...form, sftpHostKey: 'not a key' })).toMatchObject({
      ok: false,
      field: 'sftpHostKey',
    });
    expect(destinationInput({ ...form, sftpPort: '70000' })).toMatchObject({ ok: false, field: 'sftpPort' });
  });

  it('a REST server as typed, never with credentials in it; a disk is disk:', () => {
    expect(
      destinationInput({
        ...emptyBackupForm('rest'),
        restRepository: 'rest:https://backup.example.com/whombat/',
        restUser: 'wb',
        restPassword: 'pw',
      }),
    ).toEqual({
      ok: true,
      input: {
        repository: 'rest:https://backup.example.com/whombat/',
        restUser: 'wb',
        restPassword: 'pw',
        allowInit: true,
      },
    });
    expect(
      destinationInput({
        ...emptyBackupForm('rest'),
        restRepository: 'rest:https://u:p@backup.example.com/',
      }),
    ).toMatchObject({ ok: false, error: 'Leave passwords out of the address; use the fields below it.' });
    expect(destinationInput(emptyBackupForm('disk'))).toEqual({
      ok: true,
      input: { repository: 'disk:', allowInit: true },
    });
  });
});

describe('a destination that fails says why, in the service’s words (BK-21, AP-260)', () => {
  it('shows the sentence for a failed destination or refused input, the app’s words otherwise', () => {
    const refused = new OperationError(
      'backup.configureDestination',
      409,
      'backup_destination_failed',
      'The host key doesn’t match: compare the fingerprints (possible interception).',
    );
    expect(backupErrorText(refused)).toBe(
      'The host key doesn’t match: compare the fingerprints (possible interception).',
    );
    expect(
      backupErrorText(
        new OperationError(
          'backup.configureDestination',
          400,
          'bad_request',
          'repository: not a restic repository',
        ),
      ),
    ).toBe('repository: not a restic repository');
    expect(backupErrorText(new OperationError('backup.runNow', 409, 'backup_busy', 'x'))).toBe(
      'A backup is running already.',
    );
    expect(
      backupErrorText(
        new OperationError('backup.configureDestination', 409, 'backup_destination_failed', 'Failed.'),
      ),
    ).toBe(ACCOUNTS_TEXT.errors.backup_destination_failed);
    expect(backupErrorText(new Error('offline'))).toBe('That didn’t work. Try again.');
  });

  it('a disk is prepared when empty (allowInit), unless joining a replaced Whombat’s backups', () => {
    expect(destinationInput(emptyBackupForm('disk'))).toEqual({
      ok: true,
      input: { repository: 'disk:', allowInit: true },
    });
    expect(destinationInput({ ...emptyBackupForm('disk'), adoptPassword: 'rp-1' })).toEqual({
      ok: true,
      input: { repository: 'disk:', adoptPassword: 'rp-1' },
    });
  });
});

describe('Ask before updating (Whombat ask-before-updating.md ABU-01, ABU-03)', () => {
  it('an update waiting for the owner is ready, with its version and Update now', () => {
    const v = view({
      ...base,
      state: 'WaitingForSafeBoundary',
      candidate: 'pve-20261116.1',
      askFirst: true,
      waiting: { reason: 'owner', since: '2026-09-29T11:02:00Z', blockers: [] },
    });
    expect(v.rows[0]).toMatchObject({ dot: 'warn', title: 'Update ready' });
    expect(v.rows[1]).toMatchObject({ dot: 'warn', action: 'install', release: 'pve-20261116.1' });
    expect(v.rows[1]?.meta).toContain('pve-20261116.1');
    expect(v.pollMs).toBe(15_000);
  });

  it('updateReady names the release waiting for the owner, and nothing else', () => {
    const owner = { reason: 'owner' as const, since: '2026-09-29T11:02:00Z', blockers: [] };
    const waiting = {
      ...base,
      state: 'WaitingForSafeBoundary',
      candidate: 'pve-20261116.1',
      askFirst: true,
      waiting: owner,
    } as UpdateStatus;
    expect(updateReady({ update: waiting })).toBe('pve-20261116.1');
    expect(updateReady({ update: { ...waiting, paused: true } })).toBeNull();
    expect(updateReady({ update: { ...waiting, waiting: { ...owner, reason: 'boundary' } } })).toBeNull();
    expect(updateReady({ update: base })).toBeNull();
    expect(updateReady(null)).toBeNull();
  });

  it('the switch shows only where the box’s manager keeps it', () => {
    expect(askFirstView({ update: base })).toBeNull();
    expect(askFirstView({ update: null })).toBeNull();
    expect(askFirstView({ update: { ...base, askFirst: false } })).toMatchObject({ on: false });
    expect(askFirstView({ update: { ...base, askFirst: true } })).toMatchObject({ on: true });
  });
});

describe('Paused update channel', () => {
  it('shows a calm paused row when healthy and keeps the last update row', () => {
    const v = view({
      ...base,
      paused: true,
      lastUpdate: { release: 'pve-20260928.6', from: 'pve-20260928.4', at: '2026-09-28T18:10:00Z' },
    });
    expect(v.rows).toEqual([
      { dot: 'mut', title: 'Updates are paused for now.', meta: 'Software pve-20260928.6' },
      { dot: 'ok', title: 'Updated to pve-20260928.6 on 28 September 2026', lastUpdate: true },
    ]);
    expect(v.pollMs).toBeNull();
  });

  it('replaces a held pre-activation state calmly without an install action or polling', () => {
    const v = view({
      ...base,
      state: 'WaitingForSafeBoundary',
      candidate: 'pve-20261116.1',
      paused: true,
      waiting: { reason: 'hold', since: '2026-09-29T11:02:00Z', blockers: [] },
    });
    expect(v.rows).toEqual([
      { dot: 'mut', title: 'Updates are paused for now.', meta: 'Software pve-20260928.6' },
    ]);
    expect(v.pollMs).toBeNull();
  });

  it('keeps an activation in progress visible and polling while paused', () => {
    const v = view({ ...base, state: 'Verifying', candidate: 'pve-20261116.1', paused: true });
    expect(v.rows[0]).toMatchObject({ dot: 'mut', title: 'Checking the update' });
    expect(v.pollMs).toBe(5_000);
  });

  it('keeps a rollback or failure row and notes that updates are paused', () => {
    const v = view({ ...base, state: 'RolledBack', failure: 'health_check_failed', paused: true });
    expect(v.rows[0]?.dot).toBe('bad');
    expect(v.rows[1]).toEqual({ dot: 'mut', title: 'Updates are paused for now.' });
    expect(v.pollMs).toBeNull();
  });
});

describe('Check for updates (check-for-updates.md)', () => {
  it('is offered by a box at session minor 13 or later', () => {
    expect(hasUpdateCheck({ major: 5, minor: 12 })).toBe(false);
    expect(hasUpdateCheck({ major: 5, minor: 13 })).toBe(true);
    expect(hasUpdateCheck(null)).toBe(false);
  });

  it('says what came of it; a version found waits for the owner’s yes where they asked for that', () => {
    expect(updateCheckNotice('upToDate', false)).toMatch(/up to date/);
    expect(updateCheckNotice('found', false)).toMatch(/on its way/);
    expect(updateCheckNotice('found', true)).toMatch(/your yes/);
    expect(updateCheckNotice('nothingNewer', undefined)).toMatch(/already on its way/);
    expect(updateCheckNotice('refused', undefined)).toMatch(/won’t install/);
  });
});
