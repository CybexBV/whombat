import type { WorkLine } from '@whombat/client';
import { MESSAGES_BY_CONVERSATION, PRINCIPALS } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { activeCommand, historyMessages, principalLookup, sameWorkLine } from './model';

const _TZ = 'Europe/Amsterdam';
const billing = MESSAGES_BY_CONVERSATION.cnv_pr482 ?? [];
const _lookup = principalLookup({ principals: PRINCIPALS });

describe('history and day grouping', () => {
  it('flattens infinite pages (newest page first) into one list, oldest first, without duplicates', () => {
    const [a, b, c] = billing;
    if (!a || !b || !c) throw new Error('fixture messages missing');
    const pages = [
      { messages: [b, c], before: 'x', hasMore: true },
      { messages: [a, b], before: null, hasMore: false },
    ];
    expect(historyMessages(pages).map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(historyMessages(undefined)).toEqual([]);
  });
});

describe('the `/` list', () => {
  it('opens only while the draft is a single /word', () => {
    expect(activeCommand('/')).toEqual({ query: '' });
    expect(activeCommand('/to')).toEqual({ query: 'to' });
    expect(activeCommand('/topic new')).toBeNull();
    expect(activeCommand('hi /to')).toBeNull();
  });
});

describe('work lines', () => {
  it('tells work lines that draw the same apart from ones that changed', () => {
    const line: WorkLine = {
      who: 'Council',
      text: '2 of 3 answered',
      tone: 'live',
      since: 1,
      progress: { kind: 'steps', done: 2, working: 1, total: 3 },
      members: [],
      spoken: 'Council, 2 of 3 answered, 12 minutes',
    };
    expect(sameWorkLine(line, { ...line, progress: { kind: 'steps', done: 2, working: 1, total: 3 } })).toBe(
      true,
    );
    expect(sameWorkLine(line, { ...line, text: '3 of 3 answered' })).toBe(false);
    expect(sameWorkLine(line, null)).toBe(false);
  });
});
