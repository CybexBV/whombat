import type { Approval, InboxItem, InboxResponse, LinkRef } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { ShadeNotification } from '../../modules/whombat-live';
import {
  inboxRows,
  linkKey,
  noteRead,
  readInShade,
  refsToResolve,
  SHADE_READS_MAX,
  type ShadeTarget,
} from './shade';

const general = { type: 'pr', number: 482 } as const;
const inThread: LinkRef = { type: 'message', in: general, messageId: 'msg_9', threadRootId: 'msg_1' };
const inMain: LinkRef = { type: 'message', in: general, messageId: 'msg_4' };
const ask: LinkRef = { type: 'approval', number: 12 };

function row(id: string, o: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    burrowId: 'brw_1',
    principalId: 'prn_mara',
    kind: 'mention',
    actorId: 'prn_dusty',
    where: 'PR #482',
    text: 'Look at this',
    link: inMain,
    approvalId: null,
    createdAt: '2026-10-07T09:00:00.000Z',
    readAt: null,
    approval: null,
    ...o,
  };
}

const at = (iso: string) => Date.parse(iso);
const inbox = (n: ShadeNotification) => ({ ...n, tag: `whombat.inbox:${n.notificationId}` });
const pushed = (ref: string): ShadeNotification => ({
  tag: `whombat.push:${ref}`,
  postedAt: 0,
  ref,
  kind: 'message',
});
const none = { ids: new Set<string>(), allBefore: null };

describe('read in the app, gone from the shade (MN-04)', () => {
  it('a self-hosted push goes once its row is read here, named by an event, or covered by “mark all read”', () => {
    const shade = [
      inbox({ tag: '', notificationId: 'ntf_read', burrow: 'hq', postedAt: at('2026-10-07T09:00:05Z') }),
      inbox({ tag: '', notificationId: 'ntf_named', burrow: 'hq', postedAt: at('2026-10-07T09:00:05Z') }),
      inbox({ tag: '', notificationId: 'ntf_unread', burrow: 'hq', postedAt: at('2026-10-07T09:00:05Z') }),
      inbox({ tag: '', notificationId: 'ntf_early', burrow: 'hq', postedAt: at('2026-10-07T08:00:00Z') }),
      inbox({
        tag: '',
        notificationId: 'ntf_other',
        burrow: 'elsewhere',
        postedAt: at('2026-10-07T08:00:00Z'),
      }),
    ];
    const rows = [row('ntf_read', { readAt: '2026-10-07T09:01:00.000Z' }), row('ntf_unread')];
    expect(
      readInShade({
        shade,
        burrow: 'hq',
        rows,
        reads: { ids: new Set(['ntf_named']), allBefore: at('2026-10-07T08:30:00Z') },
        targets: new Map(),
      }),
    ).toEqual(['whombat.inbox:ntf_read', 'whombat.inbox:ntf_named', 'whombat.inbox:ntf_early']);
  });

  it('a managed push goes when every row with its resolved link is read, or when the ref is gone', () => {
    const targets = new Map<string, ShadeTarget>([
      ['ref_thread', { burrow: 'hq', link: inThread }],
      ['ref_main', { burrow: 'hq', link: inMain }],
      ['ref_gone', 'gone'],
      ['ref_other', { burrow: 'elsewhere', link: inMain }],
    ]);
    const shade = ['ref_thread', 'ref_main', 'ref_gone', 'ref_other', 'ref_unknown'].map(pushed);
    const rows = [
      // The same message twice (a mention and a reply row), both read; the top level's row still unread.
      row('ntf_a', { link: inThread, readAt: '2026-10-07T09:01:00.000Z' }),
      row('ntf_b', { kind: 'reply', link: { ...inThread }, readAt: '2026-10-07T09:01:00.000Z' }),
      row('ntf_c', { link: inMain }),
    ];
    expect(readInShade({ shade, burrow: 'hq', rows, reads: none, targets })).toEqual([
      'whombat.push:ref_thread',
      'whombat.push:ref_gone',
    ]);
    expect(refsToResolve(shade, targets)).toEqual(['ref_unknown']);
  });

  it('a NEEDS YOU push goes once its approval is decided, read or not', () => {
    const decided = { state: 'approved' } as Approval;
    const pending = { state: 'pending' } as Approval;
    const targets = new Map<string, ShadeTarget>([['ref_ask', { burrow: 'hq', link: ask }]]);
    const shade = [pushed('ref_ask')];
    const asked = (approval: Approval) => [row('ntf_ask', { kind: 'needs_you', link: ask, approval })];
    expect(readInShade({ shade, burrow: 'hq', rows: asked(pending), reads: none, targets })).toEqual([]);
    expect(readInShade({ shade, burrow: 'hq', rows: asked(decided), reads: none, targets })).toEqual([
      'whombat.push:ref_ask',
    ]);
  });

  it('nothing known, nothing cancelled', () => {
    expect(
      readInShade({
        shade: [pushed('ref_x'), { tag: 'whombat.inbox:/pr/482', postedAt: 0, path: '/pr/482' }],
        burrow: 'hq',
        rows: [],
        reads: none,
        targets: new Map(),
      }),
    ).toEqual([]);
  });

  it('links compare by content, whatever the key order', () => {
    expect(linkKey({ type: 'message', messageId: 'msg_9', in: general, threadRootId: 'msg_1' })).toBe(
      linkKey(inThread),
    );
    expect(linkKey(inThread)).not.toBe(linkKey(inMain));
  });

  it('merges the cached inboxes of a burrow, a read copy winning', () => {
    const one = (items: InboxItem[]): InboxResponse => ({
      sections: [{ kind: 'mention', title: 'MENTIONS', items }],
      counts: { all: items.length, needs_you: 0, mentions: items.length, agents: 0 },
      unread: 0,
    });
    const merged = inboxRows([
      one([row('ntf_1'), row('ntf_2')]),
      one([row('ntf_1', { readAt: '2026-10-07T09:01:00.000Z' })]),
    ]);
    expect(merged.map((r) => [r.id, r.readAt])).toEqual([
      ['ntf_1', '2026-10-07T09:01:00.000Z'],
      ['ntf_2', null],
    ]);
  });

  it('remembers named reads (bounded) and the latest “all up to”', () => {
    const reads = { ids: new Set<string>(), allBefore: null as number | null };
    noteRead(reads, { ids: Array.from({ length: SHADE_READS_MAX + 5 }, (_, i) => `ntf_${i}`) }, 0);
    expect(reads.ids.size).toBe(SHADE_READS_MAX);
    expect(reads.ids.has('ntf_0')).toBe(false);
    expect(reads.ids.has(`ntf_${SHADE_READS_MAX + 4}`)).toBe(true);
    noteRead(reads, { ids: null, before: '2026-10-07T09:00:00Z' }, 0);
    noteRead(reads, { ids: null, before: '2026-10-07T08:00:00Z' }, 0);
    expect(reads.allBefore).toBe(at('2026-10-07T09:00:00Z'));
    noteRead(reads, { ids: null }, at('2026-10-07T10:00:00Z'));
    expect(reads.allBefore).toBe(at('2026-10-07T10:00:00Z'));
  });
});
