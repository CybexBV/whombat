/**
 * The restore's bookkeeping (backup-file.md BF-04, BF-D06): source ids remapped through what a run found or made, an
 * id it can't place left as it is and listed, a rolled-back record leaving nothing behind, counts by the category's
 * counted types, addresses compared loosely.
 */
import type { BackupDirectoryEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { BurrowRow } from '../../commit/types';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { normalizeAddress, RestoreRun } from './run';

function run(directory: Map<string, BackupDirectoryEntry> = new Map()) {
  return new RestoreRun({
    services: { clock: () => new Date('2026-10-11T12:00:00Z') } as unknown as Services,
    db: {} as never,
    burrow: { id: 'bur_target', slug: 'target' } as BurrowRow,
    restorer: { id: 'prn_me', accountId: 'acc_me' } as PrincipalRow,
    restorerEmail: 'Mara@Example.com',
    sourceBurrowId: 'bur_source',
    onDifferent: 'keep',
    dry: true,
    directory,
    ctx: null,
    makerEmail: 'mara@example.com',
    scratch: null,
    blobs: new Set(),
  });
}

describe('a restore run', () => {
  it('remaps whole ids in raw JSON and lists the ones it can’t place', async () => {
    const r = run();
    r.remember('prn_dusty', 'prn_banjo2', 'agent');
    r.remember('cnv_general', 'cnv_here', 'channel');
    const out = await r.remapJson({
      conversationId: 'cnv_general',
      steps: [{ agentId: 'prn_dusty', text: 'ask prn_dusty nicely' }, { agentId: 'prn_gone' }],
    });
    expect(out.value).toEqual({
      conversationId: 'cnv_here',
      steps: [{ agentId: 'prn_banjo2', text: 'ask prn_dusty nicely' }, { agentId: 'prn_gone' }],
    });
    expect(out.missing).toEqual(['prn_gone']);
  });

  it('forgets what a rolled-back record found', () => {
    const r = run();
    r.remember('prn_a', 'prn_b', 'agent');
    const mark = r.mark();
    r.remember('prn_c', 'prn_d', 'agent');
    r.remember('prn_a', 'prn_z', 'agent');
    r.followUps.automationsOff++;
    r.rollback(mark);
    expect(r.mapped('prn_c')).toBeNull();
    expect(r.mapped('prn_a')).toBe('prn_b');
    expect(r.followUps.automationsOff).toBe(0);
  });

  it('counts only what a category counts, and a difference once', () => {
    const r = run();
    r.count('automations', { type: 'automation' }, 'added');
    r.count('automations', { type: 'destination' }, 'added');
    r.count('settings', { type: 'repo' }, 'kept');
    r.count('settings', { type: 'account_profile' }, 'detail');
    expect(r.tally('automations')).toMatchObject({ added: 1 });
    expect(r.tally('settings')).toMatchObject({ kept: 1, different: 1, added: 0 });
  });

  it('counts the servers of a hub, not the hub', () => {
    const r = run();
    r.count('servers', { type: 'servers_hub', servers: [{}, {}, {}] }, 'added');
    r.count('servers', { type: 'server_ask' }, 'added');
    expect(r.tally('servers')).toMatchObject({ added: 3 });
  });

  it('keeps notes per code and category', () => {
    const r = run();
    r.note('unreadable', 'messages');
    r.note('unreadable', 'messages', 2);
    r.note('drafts', 'automations');
    expect(r.noteList()).toEqual([
      { code: 'unreadable', category: 'messages', count: 3 },
      { code: 'drafts', category: 'automations', count: 1 },
    ]);
  });
});

describe('addresses', () => {
  it('compare by scheme, host and path, without a trailing slash or case', () => {
    expect(normalizeAddress('HTTPS://Grafana.Example.test/')).toBe(
      normalizeAddress('https://grafana.example.test'),
    );
    expect(normalizeAddress('https://a.test/x')).not.toBe(normalizeAddress('https://a.test/y'));
    expect(normalizeAddress(null)).toBe('');
  });
});
