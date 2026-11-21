/**
 * Home's chats with the assistant (home-redesign.md HR-40…HR-42): which state each chat has and the order they show in.
 */
import { describe, expect, it } from 'vitest';
import type { StoredPlanStep } from '../db/schema/index';
import { type ChatLine, type ChatSignals, homeChats, planProgress } from './chats';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 18, 12, minute));
const line = (id: string, minute: number, extra: Partial<ChatLine> = {}): ChatLine => ({
  id,
  title: `Chat ${id}`,
  lastAt: at(minute),
  default: false,
  ...extra,
});
const none: ChatSignals = { turns: new Map(), planChat: null, progress: new Map(), waiting: new Map() };
const step = (title: string, state: StoredPlanStep['state']) => ({ title, note: null, state });

describe('planProgress', () => {
  it('counts the steps done of those not cancelled and names the active one', () => {
    expect(
      planProgress([
        step('Find it', 'done'),
        step('Skip this', 'cancelled'),
        step('Remove the entities', 'active'),
        step('Restart', 'queued'),
      ]),
    ).toEqual({ done: 1, total: 3, step: 'Remove the entities' });
  });

  it('names the first step not done when none is active, and none when all are done', () => {
    expect(planProgress([step('Find it', 'done'), step('Your yes', 'gate')]).step).toBe('Your yes');
    expect(planProgress([step('Find it', 'done')])).toEqual({ done: 1, total: 1 });
  });
});

describe('homeChats', () => {
  it('puts the chat with a turn first, then waiting chats, then the newest others', () => {
    const chats = [line('a', 50), line('b', 40), line('c', 30), line('d', 20, { default: true })];
    const out = homeChats(chats, {
      ...none,
      turns: new Map([['c', at(55)]]),
      waiting: new Map([['d', at(10)]]),
      progress: new Map([['c', { done: 2, total: 4, step: 'Restart' }]]),
    });
    expect(out.map((c) => [c.conversationId, c.state])).toEqual([
      ['c', 'working'],
      ['d', 'waiting'],
      ['a', 'recent'],
      ['b', 'recent'],
    ]);
    expect(out[0]).toMatchObject({
      progress: { done: 2, total: 4 },
      step: 'Restart',
      at: at(55).toISOString(),
    });
    expect(out[1]).toMatchObject({ default: true, at: at(10).toISOString() });
    expect(out[1]).not.toHaveProperty('progress');
    expect(out[2]).toMatchObject({ at: at(50).toISOString() });
    expect(out[2]).not.toHaveProperty('default');
  });

  it('shows the open plan’s chat as working unless it waits for the person', () => {
    const chats = [line('a', 50), line('b', 40)];
    const planChat = { conversationId: 'b', at: at(45) };
    const progress = new Map([['b', { done: 1, total: 3, step: 'Your yes' }]]);
    expect(homeChats(chats, { ...none, planChat, progress })[0]).toMatchObject({
      conversationId: 'b',
      state: 'working',
      progress: { done: 1, total: 3 },
    });
    const waiting = homeChats(chats, { ...none, planChat, progress, waiting: new Map([['b', at(46)]]) });
    expect(waiting[0]).toMatchObject({ conversationId: 'b', state: 'waiting' });
    expect(waiting[0]).not.toHaveProperty('progress');
  });

  it('orders several working and waiting chats newest first and leaves out chats it doesn’t list', () => {
    const chats = [line('a', 1), line('b', 2), line('c', 3), line('d', 4)];
    const out = homeChats(chats, {
      ...none,
      turns: new Map([
        ['a', at(10)],
        ['b', at(20)],
        ['gone', at(30)],
      ]),
      waiting: new Map([
        ['c', at(5)],
        ['d', at(6)],
        ['b', at(7)],
      ]),
    });
    expect(out.map((c) => `${c.conversationId}:${c.state}`)).toEqual([
      'b:working',
      'a:working',
      'd:waiting',
      'c:waiting',
    ]);
  });

  it('carries at most eight, cut from the oldest others', () => {
    const chats = Array.from({ length: 12 }, (_, i) => line(`c${i}`, 59 - i));
    const out = homeChats(chats, { ...none, waiting: new Map([['c11', at(0)]]) });
    expect(out).toHaveLength(8);
    expect(out[0]?.conversationId).toBe('c11');
    expect(out.slice(1).map((c) => c.conversationId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  });

  it('gives an untitled chat a title and clips a long one', () => {
    const out = homeChats([line('a', 1, { title: '  ' }), line('b', 0, { title: 'x'.repeat(200) })], none);
    expect(out[0]?.title).toBe('New chat');
    expect(out[1]?.title).toHaveLength(160);
  });
});
