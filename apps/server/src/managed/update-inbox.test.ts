import type { UpdateFacts } from '@whombat/control-contracts/local';
import { describe, expect, it } from 'vitest';
import { ownerWaitOf, UPDATES_HREF, updateReadyItem } from './update-inbox';

const facts = (extra: Partial<UpdateFacts>): UpdateFacts => ({
  state: 'Staged',
  current: 'pve-20261115.1',
  candidate: 'pve-20261116.1',
  lastCheckedAt: '2026-11-16T08:00:00Z',
  deferredReason: null,
  failure: null,
  ...extra,
});

describe('the Inbox item for an update waiting for the owner (ask-before-updating.md ABU-05)', () => {
  it('only an update waiting for the owner’s yes counts', () => {
    const since = '2026-11-16T08:00:00Z';
    expect(ownerWaitOf(facts({ waiting: { reason: 'owner', since, blockers: [] } }))).toBe('pve-20261116.1');
    expect(ownerWaitOf(facts({ waiting: { reason: 'boundary', since, blockers: [] } }))).toBeNull();
    expect(ownerWaitOf(facts({}))).toBeNull();
    expect(ownerWaitOf(null)).toBeNull();
  });

  it('one item per release, opening This Whombat’s updates', () => {
    const item = updateReadyItem('pve-20261116.1', '2026-11-16T08:00:00.000Z');
    expect(item).toMatchObject({
      ref: { kind: 'update', id: 'pve-20261116.1' },
      nature: 'you',
      href: UPDATES_HREF,
    });
    expect(item.actions?.[0]).toMatchObject({ kind: 'open', href: UPDATES_HREF });
    expect(updateReadyItem('pve-20261117.1', item.at).id).not.toBe(item.id);
  });
});
