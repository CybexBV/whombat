import { describe, expect, it } from 'vitest';
import { byRecentActivity, isMuted, sidebarSummaries, unreadBadge, withNotify } from './conversations';
import { bootstrap, summary, t } from './test/fixtures';

describe('the sidebar’s rooms (AP-4909)', () => {
  it('lists every sidebar conversation: the branch rooms and the person’s rooms', () => {
    const b = bootstrap();
    expect(sidebarSummaries(b.sidebar).map((c) => c.id)).toEqual(['cnv_pr482', 'cnv_chat', 'cnv_feedback']);
    expect(sidebarSummaries(undefined)).toEqual([]);
  });

  it('orders by recent activity, unused ones last in the order given (AP-461)', () => {
    const rows = [
      { id: 'a', lastMessageAt: null },
      { id: 'b', lastMessageAt: t(5) },
      { id: 'c', lastMessageAt: t(9) },
      { id: 'd', lastMessageAt: null },
    ];
    expect([...rows].sort(byRecentActivity).map((r) => r.id)).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('notification levels (CT-175, AP-469, AP-470)', () => {
  it('mutes only a conversation set to Nothing, and then badges only its mentions', () => {
    expect(isMuted({ kind: 'branch' })).toBe(false);
    expect(isMuted({ kind: 'branch', notify: 'none' })).toBe(true);
    expect(unreadBadge({ kind: 'branch', unread: 4, mentions: 0 })).toEqual({ count: 4, bold: true });
    expect(unreadBadge({ kind: 'branch', notify: 'none', unread: 4, mentions: 0 })).toEqual({
      count: 0,
      bold: false,
    });
    expect(unreadBadge({ kind: 'dm', notify: 'none', unread: 4, mentions: 1 })).toEqual({
      count: 1,
      bold: true,
    });
  });

  it('stores nothing new for a level the summary already has in effect', () => {
    const s = summary({ kind: 'branch' });
    expect(withNotify(s, 'mentions')).toBe(s);
    expect(withNotify(s, 'none').notify).toBe('none');
    const dm = summary({ kind: 'dm' });
    expect(withNotify(dm, 'all')).toBe(dm);
  });
});
