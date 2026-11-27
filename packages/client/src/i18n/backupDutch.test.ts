import { describe, expect, it } from 'vitest';
import { backupLookText, lookDoneLine } from '../managed/backup-look';
import { andList, BACKUP_OPTIONS_TEXT, backupLabel, backupOptionsText } from '../managed/backup-options';
import {
  BACKUP_SETUP_TEXT,
  backupErrorText,
  backupSetupText,
  destinationInput,
  emptyBackupForm,
} from '../managed/backup-setup';
import { accountsText, managedText } from '../managed/status-copy';
import { OperationError } from '../session/managed-ops';
import { EN, NL } from './catalog';
import { WORD_TREES } from './messages';

describe('backup screens in Dutch', () => {
  it('reads the setup screen and its form errors in Dutch', () => {
    const nl = backupSetupText('nl-NL');
    expect(nl.title).toContain('Bescherm');
    expect(nl.sftpKeyFingerprint('SHA256:abc')).toBe('Vingerafdruk SHA256:abc');
    const check = destinationInput({ ...emptyBackupForm('s3'), s3Endpoint: '' }, 'nl');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toContain('Vul');
  });

  it('turns a refusal into Dutch, but keeps the box’s own sentence for a refused place', () => {
    expect(backupErrorText(new Error('x'), 'nl')).toBe(accountsText('nl').errors.failed);
    expect(backupErrorText(new OperationError('op', 500, 'backup_failed', 'Failed.'), 'nl')).toContain(
      'back-up',
    );
  });

  it('reads the list and its joins in Dutch', () => {
    expect(backupOptionsText('nl').list.first).toBe('Eerste back-up');
    expect(andList(['a', 'b', 'c'], 'nl')).toBe('a, b en c');
    expect(andList(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('says what came back in Dutch', () => {
    expect(backupLookText('nl').title).toBe('Dingen terugzetten');
    const line = lookDoneLine(
      {
        state: 'done',
        picked: 3,
        back: 3,
        already: 0,
        notBack: 0,
        titles: [],
        signIn: [],
        error: null,
        finishedAt: null,
      },
      'nl',
    );
    expect(line).toContain('3 dingen');
  });

  it('reads the status words in Dutch', () => {
    expect(managedText('nl').fingerprint('ab')).toContain('ab');
    expect(accountsText('nl').errors.failed).toContain('lukte niet');
  });

  it('falls back to English for a language it doesn’t have', () => {
    expect(backupSetupText('fr').title).toBe(BACKUP_SETUP_TEXT.title);
    expect(backupLabel({ reason: 'scheduled' } as never, true, 'de')).toBe(BACKUP_OPTIONS_TEXT.list.first);
  });
});

describe('word trees in the catalog', () => {
  it('give every area its own prefix, apart from the flat catalog’s keys', () => {
    const prefixes = WORD_TREES.prefixes;
    expect(new Set(prefixes).size).toBe(prefixes.length);
    const flat = Object.keys(EN).filter((key) => !(key in WORD_TREES.en));
    expect(flat.length).toBeGreaterThan(0);
    for (const key of flat) {
      expect(prefixes.some((p) => key === p || key.startsWith(`${p}.`))).toBe(false);
    }
  });

  it('have a Dutch message for every English one', () => {
    expect(Object.keys(WORD_TREES.nl).sort()).toEqual(Object.keys(WORD_TREES.en).sort());
    for (const key of Object.keys(WORD_TREES.en)) {
      expect(EN[key as keyof typeof EN]).toBeDefined();
      expect(NL[key as keyof typeof NL]).toBeDefined();
    }
  });
});
