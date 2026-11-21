import { describe, expect, it } from 'vitest';
import { threadReadable, threadReadUpTo } from './chatInbox';

const me = 'prn_me';
const neo = 'prn_neo';
const msg = (id: string, authorId: string) => ({ id, authorId, deletedAt: null });

describe('a thread that opened with something new', () => {
  it('waits for its own read before placing the New line or reading it', () => {
    expect(threadReadable({ rootOnly: true, fetching: false })).toBe(false);
    expect(threadReadable({ rootOnly: false, fetching: true })).toBe(false);
    expect(threadReadable({ rootOnly: false, fetching: false })).toBe(true);
  });

  it('places the line from the copy read now, not the old one', () => {
    // Kept on the phone: R, A1, mine, A2 (all read). Two replies came since: A3 and A4.
    const old = [msg('R', neo), msg('A1', neo), msg('M', me), msg('A2', neo)];
    const now = [...old, msg('A3', neo), msg('A4', neo)];
    expect(threadReadUpTo(old, 2, me)).toBe('R');
    expect(threadReadUpTo(now, 2, me)).toBe('A2');
  });
});
