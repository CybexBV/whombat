import type { Grant } from '@whombat/core/domain';
import { agentDefaultGrants } from '@whombat/core/keys';
import { describe, expect, it } from 'vitest';
import { accountKeyGroups, accountKeysText, withAccountTier } from './accountKeys';

const held: Grant[] = agentDefaultGrants('prn_agent');

describe('an account’s keys on its page', () => {
  it('lists the services the account brings, trashing in three states and sending capped at Ask', () => {
    const groups = accountKeyGroups(held, ['mail', 'docs'], 'Dusty');
    expect(groups.map((g) => g.title)).toEqual(['Mail', 'Files']);
    const mail = groups[0]?.rows ?? [];
    const trash = mail.find((r) => r.keyId === 'mail.delete');
    expect(trash).toMatchObject({ tier: 'ask', choices: ['can', 'ask', 'cannot'], note: null });
    const send = mail.find((r) => r.keyId === 'mail.send');
    expect(send).toMatchObject({ tier: 'ask', choices: ['ask', 'cannot'] });
    expect(send?.note).toBeTruthy();
    expect(groups[1]?.rows.find((r) => r.keyId === 'files.delete')?.choices).toHaveLength(3);
  });

  it('reads a key it doesn’t hold as Off, and one held above its cap at the cap', () => {
    const groups = accountKeyGroups([{ keyId: 'mail.send', tier: 'can' }], ['mail'], 'Dusty');
    const rows = groups[0]?.rows ?? [];
    expect(rows.find((r) => r.keyId === 'mail.read')?.tier).toBe('cannot');
    expect(rows.find((r) => r.keyId === 'mail.send')?.tier).toBe('ask');
  });

  it('changes one key and keeps every other grant, adding a key it didn’t hold', () => {
    const next = withAccountTier(held, 'mail.delete', 'can');
    expect(next).toHaveLength(held.length);
    expect(next.find((g) => g.keyId === 'mail.delete')?.tier).toBe('can');
    expect(next.find((g) => g.keyId === 'mail.send')?.tier).toBe('ask');
    const added = withAccountTier(
      held.filter((g) => g.keyId !== 'mail.delete'),
      'mail.delete',
      'can',
    );
    expect(added.find((g) => g.keyId === 'mail.delete')).toEqual({ keyId: 'mail.delete', tier: 'can' });
  });

  it('names the assistant in the title', () => {
    expect(accountKeysText('Dusty').title).toContain('DUSTY');
  });
});
