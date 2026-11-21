/** Where the “New” divider goes (docs/decisions/web-messages.md WX-07). */
import { describe, expect, it } from 'vitest';
import { unreadStart } from './unreadDivider';

const m = (id: string, authorId = 'agt_dusty') => ({ id, authorId });
const messages = [m('msg_1'), m('msg_2'), m('msg_3', 'prn_mara'), m('msg_4'), m('msg_5')];
const base = { messages, viewerId: 'prn_mara', hasOlder: false, unread: 2 };

describe('unreadStart', () => {
  it('starts after the last-read message, at the first one someone else wrote', () => {
    expect(unreadStart({ ...base, lastReadId: 'msg_2' })).toBe('msg_4');
    expect(unreadStart({ ...base, lastReadId: 'msg_1' })).toBe('msg_2');
  });

  it('shows none with nothing unread, without a marker, or when everything after is your own', () => {
    expect(unreadStart({ ...base, lastReadId: 'msg_2', unread: 0 })).toBeNull();
    expect(unreadStart({ ...base, lastReadId: null })).toBeNull();
    expect(unreadStart({ ...base, messages: messages.slice(0, 3), lastReadId: 'msg_2' })).toBeNull();
  });

  it('puts it at the top of the loaded page when the marker is older, and nowhere when it is gone', () => {
    expect(unreadStart({ ...base, lastReadId: 'msg_0', hasOlder: true })).toBe('msg_1');
    expect(unreadStart({ ...base, lastReadId: 'msg_0', hasOlder: false })).toBeNull();
  });
});
