/**
 * The English words of Settings → This Whombat, Backups, Remote help, the passkey, the own address and the screens,
 * recorded once before they moved into the catalog: every string, and every word function called with a spread of
 * arguments, must still come out the same. The file snapshot is the record; it changes only on purpose.
 */
import { describe, expect, it } from 'vitest';
import { DESK_TEXT } from '../desk/model';
import { DESK_SCREENS_TEXT } from '../desk/screens';
import { BACKUP_LOOK_TEXT } from '../managed/backup-look';
import { BACKUP_OPTIONS_TEXT } from '../managed/backup-options';
import { BACKUP_PLACES_TEXT } from '../managed/backup-places';
import { BACKUP_SETUP_TEXT } from '../managed/backup-setup';
import { ONE_PASSKEY_TEXT } from '../managed/one-passkey';
import { OWN_NAME_TEXT } from '../managed/own-name';
import { PASSKEY_SETUP_TEXT } from '../managed/passkey-setup';
import { KIT_BACKUP_TEXT } from '../managed/recovery';
import { REMOTE_HELP_TEXT } from '../managed/remote-help';
import { ACCOUNTS_TEXT, MANAGED_TEXT } from '../managed/status-copy';
import { HERMES_WORDS, THIS_WHOMBAT_TEXT } from '../managed/this-whombat';

/** Argument lists a word function is called with: words, numbers on both sides of one, nothing, and a mix. */
function argSets(arity: number): unknown[][] {
  const fill = (v: unknown) => Array.from({ length: arity }, () => v);
  const sets: unknown[][] = [
    ['Alpha', 'Beta', 'Gamma', 'Delta'].slice(0, arity),
    fill(0),
    fill(1),
    fill(2),
    fill(45),
    fill(90),
    fill(null),
    fill(['Alpha', 'Beta']),
  ];
  for (let i = 0; i < arity; i++) {
    const words = ['Alpha', 'Beta', 'Gamma', 'Delta'].slice(0, arity);
    words[i] = null as unknown as string;
    sets.push(words);
    const numbers: unknown[] = fill(3);
    numbers[i] = 'Alpha';
    sets.push(numbers);
  }
  return sets;
}

/** Every string under `value`, and what every function under it says for each argument list, by path. */
export function wordsRecord(
  value: unknown,
  path = '',
  out: Record<string, string> = {},
): Record<string, string> {
  if (typeof value === 'string') out[path] = value;
  else if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown;
    for (const args of argSets(Math.max(1, fn.length))) {
      let said: unknown;
      try {
        said = fn(...args);
      } catch {
        said = '(throws)';
      }
      wordsRecord(said, `${path}(${JSON.stringify(args)})`, out);
    }
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) wordsRecord(v, `${path}[${i}]`, out);
  } else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) wordsRecord(v, path ? `${path}.${k}` : k, out);
  return out;
}

export const ENGLISH_TEXTS = {
  THIS_WHOMBAT_TEXT,
  HERMES_WORDS,
  BACKUP_OPTIONS_TEXT,
  BACKUP_PLACES_TEXT,
  BACKUP_SETUP_TEXT,
  BACKUP_LOOK_TEXT,
  REMOTE_HELP_TEXT,
  KIT_BACKUP_TEXT,
  ONE_PASSKEY_TEXT,
  OWN_NAME_TEXT,
  PASSKEY_SETUP_TEXT,
  MANAGED_TEXT,
  ACCOUNTS_TEXT,
  DESK_TEXT,
  DESK_SCREENS_TEXT,
};

/** The few word functions that take a yes or no, called both ways. */
function yesNoRecord(): Record<string, string> {
  return {
    'DESK_TEXT.offDialog.lead(true)': DESK_TEXT.offDialog.lead(true),
    'DESK_TEXT.offDialog.lead(false)': DESK_TEXT.offDialog.lead(false),
  };
}

describe('English copy of the localized managed and desk words', () => {
  it('stays byte for byte what it was', async () => {
    const record = { ...wordsRecord(ENGLISH_TEXTS), ...yesNoRecord() };
    expect(Object.keys(record).length).toBeGreaterThan(1000);
    // By path, so moving a key within its table isn't a change of words.
    const sorted = Object.fromEntries(
      Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    await expect(`${JSON.stringify(sorted, null, 2)}\n`).toMatchFileSnapshot(
      './__snapshots__/english-copy.json',
    );
  });
});
