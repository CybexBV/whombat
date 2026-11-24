/**
 * A 1Password vault kept in step with the Vault, as the apps show it (Whombat onepassword-sync.md; app
 * onepassword-sync.md): the tag rule, the entry's line, the connection's page part, what removing it carries, and what
 * 1Password's connection page no longer pretends (automations' words, choices that change later).
 */
import { catalogEntry } from '@whombat/core/domain';
import {
  ONEPASSWORD_WORDS,
  type OnePasswordSyncView,
  onePasswordGoneTitle,
  onePasswordSkipText,
  onePasswordWaitingLine,
} from '@whombat/core/vault';
import { describe, expect, it } from 'vitest';
import { choiceSettings } from './connections/choices';
import { connectionState, usedByAgents, usedByAutomations, usedByVaultSync } from './connections/form';
import {
  disconnectQuery,
  ONEPASSWORD_APP_TEXT,
  ONEPASSWORD_DISCONNECT_OPTIONS,
  onePasswordAnsweredText,
  onePasswordPage,
  vaultEntrySourceLine,
  vaultEntryTag,
} from './onePassword';

const NOW = '2026-11-24T14:05:00.000Z';
const TZ = 'Europe/Amsterdam';

const VIEW: OnePasswordSyncView = {
  connectionId: 'con_1password',
  vaultTitle: 'Whombat',
  kept: 12,
  pending: 0,
  localOnly: 0,
  checkedAt: '2026-11-24T14:02:00.000Z',
  outcome: 'ok',
  problem: null,
  nextTryAt: null,
  readOnly: false,
  syncing: false,
  notInVault: [],
  removals: null,
};

const onepassword = () => {
  const e = catalogEntry('onepassword');
  if (!e) throw new Error('no onepassword entry');
  return e;
};

describe('the Vault', () => {
  it('tags an entry kept in step with 1Password, and only that one', () => {
    expect(vaultEntryTag({ source: { kind: 'onepassword', state: 'synced', syncedAt: NOW } })).toBe(
      ONEPASSWORD_WORDS.tag,
    );
    expect(
      vaultEntryTag({ source: { kind: 'onepassword', state: 'problem', syncedAt: null, problem: 'x' } }),
    ).toBe('1Password');
    expect(vaultEntryTag({})).toBeNull();
    // A place a newer Whombat knows and this app doesn't: no tag rather than a wrong one.
    expect(
      vaultEntryTag({ source: { kind: 'bitwarden', state: 'synced', syncedAt: NOW } as never }),
    ).toBeNull();
  });

  it('says how the entry stands with 1Password on its page, a problem in the warning colour', () => {
    expect(
      vaultEntrySourceLine(
        { source: { kind: 'onepassword', state: 'synced', syncedAt: '2026-11-24T14:03:00.000Z' } },
        NOW,
        TZ,
      ),
    ).toEqual({ text: 'Kept in step with 1Password · 2 min ago', tone: 'plain' });
    expect(
      vaultEntrySourceLine({ source: { kind: 'onepassword', state: 'pending', syncedAt: null } }, NOW, TZ),
    ).toEqual({ text: ONEPASSWORD_WORDS.pending, tone: 'plain' });
    const stopped = vaultEntrySourceLine(
      {
        source: {
          kind: 'onepassword',
          state: 'problem',
          syncedAt: NOW,
          problem: 'No longer kept in step: 1Password has no place for this sign-in.',
        },
      },
      NOW,
      TZ,
    );
    expect(stopped?.tone).toBe('warn');
    expect(stopped?.text).toMatch(/^No longer kept in step/);
    expect(vaultEntrySourceLine({}, NOW, TZ)).toBeNull();
  });
});

describe('the connection’s page part', () => {
  it('names the vault, counts what is kept in step and says when it last checked', () => {
    const page = onePasswordPage(VIEW, NOW, TZ);
    expect(page.vault).toBe('Whombat');
    expect(page.kept).toBe('12 logins and API tokens kept in step');
    expect(page.checked).toBe('Last checked 3 min ago');
    expect(page.status).toEqual([]);
    expect(page.removals).toBeNull();
    expect(page.syncing).toBe(false);
    expect(onePasswordPage({ ...VIEW, vaultTitle: null, checkedAt: null }, NOW, TZ)).toMatchObject({
      vault: ONEPASSWORD_APP_TEXT.vaultUnknown,
      checked: ONEPASSWORD_WORDS.notChecked,
    });
  });

  it('says a pass is on its way while it syncs', () => {
    expect(onePasswordPage({ ...VIEW, syncing: true }, NOW, TZ)).toMatchObject({
      syncing: true,
      checked: ONEPASSWORD_APP_TEXT.syncing,
    });
  });

  it('says why it is waiting or failing, a failing pass in the Not working colour', () => {
    const nextTryAt = '2026-11-24T13:20:00.000Z';
    expect(onePasswordPage({ ...VIEW, outcome: 'waiting', nextTryAt }, NOW, TZ).status).toEqual([
      { text: onePasswordWaitingLine(nextTryAt, TZ), tone: 'warn' },
    ]);
    expect(onePasswordPage({ ...VIEW, outcome: 'failing' }, NOW, TZ).status).toEqual([
      { text: ONEPASSWORD_WORDS.unreachable, tone: 'bad' },
    ]);
    expect(
      onePasswordPage(
        { ...VIEW, outcome: 'failing', problem: ONEPASSWORD_WORDS.stopped, readOnly: true },
        NOW,
        TZ,
      ).status,
    ).toEqual([
      { text: ONEPASSWORD_WORDS.stopped, tone: 'bad' },
      { text: ONEPASSWORD_WORDS.readOnly, tone: 'warn' },
    ]);
  });

  it('holds the paused removals with their names and the set’s token, said once', () => {
    const removals = {
      token: 'set_7',
      since: NOW,
      entries: ['GitHub', 'Stripe API', 'Plex', 'Grafana'].map((name, i) => ({ entryId: `vlt_${i}`, name })),
    };
    const page = onePasswordPage({ ...VIEW, outcome: 'paused', removals }, NOW, TZ);
    expect(page.removals).toEqual({
      title: onePasswordGoneTitle(4),
      names: ['GitHub', 'Stripe API', 'Plex', 'Grafana'],
      token: 'set_7',
    });
    // The title isn't said again among the status lines.
    expect(page.status).toEqual([]);
    // Removals left over from an earlier pause don't show once the pass is past it.
    expect(onePasswordPage({ ...VIEW, outcome: 'ok', removals }, NOW, TZ).removals).toBeNull();
  });

  it('lists what isn’t in the Vault with each reason in the person’s words', () => {
    const page = onePasswordPage(
      {
        ...VIEW,
        notInVault: [
          { itemId: 'fmx3tsd5v5bew74o3v2z2a7wf4', title: 'Bank card', reason: 'other_kind' },
          { itemId: 'q2w3e4r5t6y7u8i9o0p1a2s3d4', title: 'NAS admin', reason: 'unreachable' },
        ],
      },
      NOW,
      TZ,
    );
    expect(page.notInVault).toEqual([
      { id: 'fmx3tsd5v5bew74o3v2z2a7wf4', title: 'Bank card', reason: onePasswordSkipText('other_kind') },
      { id: 'q2w3e4r5t6y7u8i9o0p1a2s3d4', title: 'NAS admin', reason: onePasswordSkipText('unreachable') },
    ]);
  });
});

describe('removing it and answering the guard', () => {
  it('offers keeping the entries first, and sends the choice only for the Vault’s sync', () => {
    expect(ONEPASSWORD_DISCONNECT_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['keep', ONEPASSWORD_WORDS.disconnectKeep],
      ['remove', ONEPASSWORD_WORDS.disconnectRemove],
    ]);
    expect(disconnectQuery(onepassword(), 'remove')).toEqual({ vaultEntries: 'remove' });
    expect(disconnectQuery('onepassword', 'keep')).toEqual({ vaultEntries: 'keep' });
    expect(disconnectQuery('homeassistant', 'remove')).toBeUndefined();
    expect(ONEPASSWORD_APP_TEXT.removeAsk('1Password')).toMatch(/^Remove 1Password\?/);
  });

  it('says what the answer did', () => {
    expect(onePasswordAnsweredText('remove')).toBe(ONEPASSWORD_APP_TEXT.removed);
    expect(onePasswordAnsweredText('keep')).toBe(ONEPASSWORD_APP_TEXT.kept);
  });
});

describe('1Password as a connection', () => {
  it('is neither the agent’s nor automations’: the Vault’s sync uses it', () => {
    expect(usedByVaultSync('onepassword')).toBe(true);
    expect(usedByAutomations('onepassword')).toBe(false);
    expect(usedByAgents('onepassword')).toBe(false);
    expect(usedByVaultSync('homeassistant')).toBe(false);
    expect(usedByAutomations('tracker')).toBe(true);
    // A refused token isn't “Needs a new token” for automations: the plain state.
    expect(
      connectionState({
        catalogId: 'onepassword',
        status: 'needs_reauth',
        signIn: 'token',
        reauthReason: null,
      }).text,
    ).toBe('Needs you to sign in again');
  });

  it('has nothing to change later: the vault and the entries’ question are asked when linking', () => {
    expect(choiceSettings(onepassword(), { vault: 'abc', entries: 'put' }, null)).toEqual([]);
  });
});
