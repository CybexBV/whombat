/**
 * What the person sees of the 1Password sync (docs/decisions/onepassword-sync.md), and what it adds to the contracts it
 * touches: a Vault entry's source, a backup's item id and the guard's card.
 */
import { describe, expect, it } from 'vitest';
import { BackupVaultEntryRecord } from '../backup/records.js';
import { NeedsYouAction } from '../domain/home.js';
import {
  ONEPASSWORD_WATCH_CHECKS,
  ONEPASSWORD_WORDS,
  OnePasswordSyncView,
  onePasswordCheckedLine,
  onePasswordEntryLine,
  onePasswordGoneTitle,
  onePasswordKeptLine,
  onePasswordSkipText,
  onePasswordStatusLines,
  onePasswordWaitingLine,
} from './onepassword-view.js';
import { VaultEntry } from './schemas.js';

const ENTRY = 'vlt_entry1';

describe('what the person sees', () => {
  const NOW = '2026-11-24T14:05:00.000Z';
  const view = OnePasswordSyncView.parse({
    connectionId: 'con_1password',
    vaultTitle: 'Whombat',
    kept: 12,
    pending: 1,
    localOnly: 0,
    checkedAt: '2026-11-24T14:02:00.000Z',
    outcome: 'ok',
    problem: null,
    nextTryAt: null,
    readOnly: false,
    syncing: false,
    notInVault: [{ itemId: 'fmx3tsd5v5bew74o3v2z2a7wf4', title: 'Bank card', reason: 'other_kind' }],
    removals: null,
  });

  it('says the counts, the last check and each reason in the spec’s words', () => {
    expect(onePasswordKeptLine(view.kept)).toBe('12 logins and API tokens kept in step');
    expect(onePasswordKeptLine(1)).toBe('1 login or API token kept in step');
    expect(onePasswordCheckedLine(view.checkedAt, NOW, 'Europe/Amsterdam')).toBe('Last checked 3 min ago');
    expect(onePasswordCheckedLine(null, NOW, 'Europe/Amsterdam')).toBe('Not checked yet');
    expect(onePasswordSkipText('no_website')).toBe('No website');
    expect(onePasswordSkipText('vault_full')).toBe('Your Vault is full');
    expect(onePasswordSkipText('ssh_key')).toBe('SSH keys stay in 1Password');
    expect(onePasswordSkipText('unreachable')).toBe('Whombat may not reach this address');
    expect(ONEPASSWORD_WORDS.readOnly).toBe(
      'This token can only read. Make one that can read and write the vault.',
    );
    expect(ONEPASSWORD_WORDS.disconnectKeep).toBe('Keep the entries in your Vault');
    expect(ONEPASSWORD_WORDS.disconnectRemove).toBe('Remove them too');
  });

  it('says the waiting, failing, paused and read-only lines', () => {
    expect(onePasswordStatusLines(view, 'Europe/Amsterdam')).toEqual([]);
    expect(onePasswordWaitingLine('2026-11-24T13:20:00.000Z', 'Europe/Amsterdam')).toBe(
      'Waiting for 1Password’s limit. Next try at 14:20.',
    );
    expect(
      onePasswordStatusLines(
        { ...view, outcome: 'waiting', nextTryAt: '2026-11-24T13:20:00.000Z' },
        'Europe/Amsterdam',
      ),
    ).toEqual(['Waiting for 1Password’s limit. Next try at 14:20.']);
    expect(onePasswordStatusLines({ ...view, outcome: 'failing', problem: null }, 'UTC')).toEqual([
      'Whombat can’t reach 1Password.',
    ]);
    const removals = {
      token: 't1',
      since: NOW,
      entries: ['a', 'b', 'c', 'd'].map((n) => ({ entryId: `vlt_${n}`, name: n })),
    };
    expect(onePasswordStatusLines({ ...view, outcome: 'paused', removals, readOnly: true }, 'UTC')).toEqual([
      '1Password says 4 items are gone',
      'This token can only read. Make one that can read and write the vault.',
    ]);
    expect(onePasswordGoneTitle(1)).toBe('1Password says 1 item is gone');
    expect(ONEPASSWORD_WORDS.removeHere).toBe('Remove them here too');
    expect(ONEPASSWORD_WORDS.keepHere).toBe('Keep them here');
  });

  it('says a synced entry’s line on its page', () => {
    expect(
      onePasswordEntryLine(
        { kind: 'onepassword', state: 'synced', syncedAt: '2026-11-24T14:03:00.000Z' },
        NOW,
        'UTC',
      ),
    ).toBe('Kept in step with 1Password · 2 min ago');
    expect(onePasswordEntryLine({ kind: 'onepassword', state: 'pending', syncedAt: null }, NOW, 'UTC')).toBe(
      'Waiting to go to 1Password',
    );
    expect(
      onePasswordEntryLine(
        { kind: 'onepassword', state: 'problem', syncedAt: null, problem: ONEPASSWORD_WORDS.readOnly },
        NOW,
        'UTC',
      ),
    ).toBe(ONEPASSWORD_WORDS.readOnly);
  });

  it('watches the guard and an unreachable 1Password from the start, and the limit only when asked', () => {
    expect(ONEPASSWORD_WATCH_CHECKS.map((c) => [c.check, c.name, c.startsOn])).toEqual([
      ['onepassword.paused', '1Password sync needs you', true],
      ['onepassword.unreachable', 'Whombat can’t reach 1Password', true],
      ['onepassword.limit', 'Waiting for 1Password’s limit', false],
    ]);
  });
});

describe('the contracts it adds to', () => {
  it('lets a Vault entry say it is kept in step, and an older one say nothing', () => {
    const entry = {
      id: ENTRY,
      name: 'Grafana',
      description: '',
      kind: 'login',
      url: 'https://grafana.example.com/login',
      auth: { type: 'form', username: 'mara' },
      secret: { set: true, setAt: '2026-11-24T09:00:00.000Z' },
      check: { status: 'unchecked', summary: '', checkedAt: null },
      agentOn: true,
      lastUsedAt: null,
      createdAt: '2026-11-24T09:00:00.000Z',
      updatedAt: '2026-11-24T09:00:00.000Z',
    };
    expect(VaultEntry.parse(entry).source).toBeUndefined();
    expect(
      VaultEntry.parse({
        ...entry,
        source: { kind: 'onepassword', state: 'synced', syncedAt: entry.updatedAt },
      }).source,
    ).toEqual({ kind: 'onepassword', state: 'synced', syncedAt: entry.updatedAt });
    expect(
      VaultEntry.safeParse({ ...entry, source: { kind: 'bitwarden', state: 'synced', syncedAt: null } })
        .success,
    ).toBe(false);
  });

  it('keeps an entry’s item id in a backup file, and reads a file from before without it', () => {
    const record = {
      type: 'vault_entry',
      id: ENTRY,
      kind: 'login',
      name: 'Grafana',
      createdAt: '2026-11-24T09:00:00.000Z',
    };
    expect(BackupVaultEntryRecord.parse(record).onepasswordItemId).toBeUndefined();
    expect(
      BackupVaultEntryRecord.parse({ ...record, onepasswordItemId: 'fmx3tsd5v5bew74o3v2z2a7wf4' })
        .onepasswordItemId,
    ).toBe('fmx3tsd5v5bew74o3v2z2a7wf4');
    expect(BackupVaultEntryRecord.safeParse({ ...record, onepasswordItemId: '../x' }).success).toBe(false);
  });

  it('gives the guard’s card its two answers', () => {
    expect(
      NeedsYouAction.parse({
        id: 'remove',
        label: ONEPASSWORD_WORDS.removeHere,
        style: 'primary',
        kind: 'onepassword_removals',
        removals: { answer: 'remove', token: 't1' },
      }).removals,
    ).toEqual({ answer: 'remove', token: 't1' });
  });
});
