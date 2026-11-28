import type { BackupOffsite } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import {
  OFFSITE_PRESETS,
  offsiteErrorText,
  offsiteFormFrom,
  offsiteInput,
  offsiteLine,
  offsiteText,
  offsiteView,
} from './backup-offsite';
import { backupHero } from './backup-options';

const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

const copy = (over: Partial<BackupOffsite> = {}): BackupOffsite => ({
  provider: 'b2',
  display: 's3.eu-central-003.backblazeb2.com/my-backups/box',
  endpoint: 's3.eu-central-003.backblazeb2.com',
  bucket: 'my-backups',
  folder: 'box',
  region: null,
  state: 'ok',
  configuredAt: '2026-11-20T10:00:00Z',
  lastCopyAt: hourAgo(),
  newestInCopyAt: hourAgo(),
  newestBackupAt: hourAgo(),
  backupsInCopy: 12,
  failedAttempts: 0,
  lastFailure: null,
  nextTryAt: null,
  lastClearedAt: null,
  ...over,
});

describe('the copy’s line', () => {
  it('names the storage and when it last copied, and warns while it fails', () => {
    expect(offsiteLine(copy())).toMatchObject({ dot: 'ok' });
    expect(offsiteLine(copy()).text).toContain('Backblaze B2');
    expect(offsiteLine(copy({ state: 'first', lastCopyAt: null })).dot).toBe('mut');
    // Nothing at the main place yet: nothing to copy, said as such and never as a copy that worked.
    const empty = offsiteLine(copy({ state: 'first', lastCopyAt: null, newestBackupAt: null }));
    expect(empty.dot).toBe('mut');
    expect(empty.text).not.toBe(offsiteLine(copy({ state: 'first', lastCopyAt: null })).text);
    expect(offsiteLine(copy({ state: 'failing' })).dot).toBe('warn');
    // Any other S3 storage goes by its bucket's name.
    expect(offsiteLine(copy({ provider: 's3' })).text).toContain('my-backups');
    expect(offsiteLine(copy(), 'nl').text).toContain('Backblaze B2');
  });

  it('sits under the main place on the Backups card, and nowhere when there is no copy', () => {
    const hero = (offsite: BackupOffsite | null | undefined) =>
      backupHero({
        status: null,
        policy: null,
        list: null,
        placeName: 'nas-01',
        summary: { offsite },
      } as never);
    expect(hero(copy()).offsite?.dot).toBe('ok');
    expect(hero(null).offsite).toBeNull();
    expect(hero(undefined).offsite).toBeNull();
  });
});

describe('the section', () => {
  it('says which step failed and when Whombat tries again', () => {
    const view = offsiteView(
      copy({
        state: 'failing',
        failedAttempts: 2,
        lastFailure: { at: hourAgo(), step: 'keys' },
        nextTryAt: '2026-11-28T09:30:00',
      }),
    );
    expect(view.problem).toContain(offsiteText().steps.keys);
    expect(view.problem).toContain('09:30');
    expect(offsiteView(copy()).problem).toBeNull();
    expect(offsiteView(copy({ state: 'copying' })).canCopy).toBe(false);
  });
});

describe('the form', () => {
  it('offers every storage, and keeps the place but never the key when changing it', () => {
    expect(OFFSITE_PRESETS.map((p) => p.provider)).toEqual(['b2', 'r2', 'hetzner', 'aws', 's3']);
    expect(offsiteFormFrom(copy())).toMatchObject({
      bucket: 'my-backups',
      folder: 'box',
      secretAccessKey: '',
    });
  });

  it('asks for what it needs, and splits a bucket’s address pasted whole', () => {
    const form = { ...offsiteFormFrom(null), accessKeyId: 'KEYID', secretAccessKey: 'shh' };
    expect(offsiteInput(form)).toBeNull();
    expect(
      offsiteInput({ ...form, endpoint: 'https://fsn1.your-objectstorage.com/Box-Backups/home/' }),
    ).toEqual({
      provider: 'b2',
      endpoint: 'https://fsn1.your-objectstorage.com',
      bucket: 'box-backups',
      folder: 'home',
      accessKeyId: 'KEYID',
      secretAccessKey: 'shh',
    });
    expect(
      offsiteInput({ ...form, endpoint: 's3.example.com', bucket: 'b', region: ' EU-1 ' }),
    ).toMatchObject({
      region: 'eu-1',
    });
  });

  it('says the step that failed in the person’s language', () => {
    const refused = new OperationError(
      'backup.setOffsite',
      409,
      'conflict',
      'The storage didn’t accept the key.',
      {
        code: 'backup_offsite_failed',
        step: 'keys',
      },
    );
    expect(offsiteErrorText(refused, 'nl')).toBe(offsiteText('nl').steps.keys);
  });
});
