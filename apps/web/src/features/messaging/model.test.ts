import { ANSWERING_T3_CODE, type WorkLine } from '@whombat/client';
import type { Message } from '@whombat/core';
import { MESSAGES_BY_CONVERSATION, PRINCIPALS } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  activeCommand,
  historyMessages,
  isFailedTurn,
  newestAgentFace,
  principalLookup,
  replyFaceState,
  sameWorkLine,
} from './model';

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

describe('the assistant’s live face in a chat', () => {
  const live = (text: string) => ({ text, tone: 'live' as const });

  it('thinks or works while it is on the reply, waits when a run needs the person', () => {
    expect(replyFaceState(live('is thinking'), false)).toBe('thinking');
    expect(replyFaceState(live('is looking into it'), false)).toBe('thinking');
    expect(replyFaceState(live(ANSWERING_T3_CODE), false)).toBe('thinking');
    expect(replyFaceState(live('is working · 38%'), false)).toBe('working');
    expect(replyFaceState({ text: 'needs you', tone: 'warn' }, false)).toBe('needs');
  });

  it('is sorry for a failed turn until it works on it again, and rests otherwise', () => {
    expect(replyFaceState(null, true)).toBe('sorry');
    expect(replyFaceState(live('is thinking'), true)).toBe('thinking');
    expect(replyFaceState(null, false)).toBe('idle');
    // Work handed to T3 Code is T3 Code's, not the assistant's own turn.
    expect(replyFaceState({ text: 'is working', tone: 'live', by: 't3code' }, false)).toBe('idle');
  });

  it('knows a failed turn nobody tried again', () => {
    const card = {
      kind: 'turn_failed',
      dispatchId: 'dsp_1',
      agentId: 'prn_neo',
      code: 'provider',
      reason: 'It stopped.',
      retriedAt: null,
      retryDispatchId: null,
    } as const;
    expect(isFailedTurn({ card } as Pick<Message, 'card'>)).toBe(true);
    expect(
      isFailedTurn({ card: { ...card, retriedAt: '2026-09-23T09:20:00Z' } } as Pick<Message, 'card'>),
    ).toBe(false);
    expect(isFailedTurn({ card: null })).toBe(false);
  });

  it('goes on the row that shows the face of the assistant’s newest message', () => {
    const m = (id: string, authorId: string) => ({ id, authorId }) as Message;
    const isAgent = (msg: Message) => msg.authorId === 'agent';
    // A message by the same author just before shows no face of its own.
    const continued = (msgs: readonly Message[], i: number) => msgs[i - 1]?.authorId === msgs[i]?.authorId;
    const days = [
      { messages: [m('a1', 'agent'), m('p1', 'person')] },
      { messages: [m('a2', 'agent'), m('a3', 'agent'), m('p2', 'person')] },
    ];
    expect(newestAgentFace(days, isAgent, continued)).toMatchObject({ rowId: 'a2', message: { id: 'a3' } });
    expect(newestAgentFace(days.slice(0, 1), isAgent, continued)).toMatchObject({ rowId: 'a1' });
    expect(newestAgentFace([{ messages: [m('p3', 'person')] }], isAgent, continued)).toBeNull();
  });
});
