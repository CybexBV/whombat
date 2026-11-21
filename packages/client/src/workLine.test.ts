import type { ChatThread, Handoff } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { councilStepIndex, councilSteps, threadWorkLine } from './workLine';

const NOW = Date.parse('2026-11-07T10:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const thread = (over: Partial<ChatThread> = {}): ChatThread => ({
  conversationId: 'conv_1' as never,
  room: 'chat',
  rootId: 'msg_1' as never,
  authorId: 'p_1' as never,
  text: 'The backup page has been empty since yesterday, can you fix it?',
  createdAt: at(30),
  replyCount: 3,
  lastAt: at(2),
  working: false,
  ...over,
});

const handoff = (over: Partial<Handoff> = {}): Handoff => ({
  id: 't3:1',
  to: 't3code',
  conversationId: 'conv_1' as never,
  rootId: 'msg_1' as never,
  agentId: 'a_1' as never,
  title: 'Dusty - Fix the empty backup page',
  state: 'working',
  since: at(6),
  endedAt: null,
  outcome: null,
  steps: [{ text: 'Running the tests', detail: null, done: false }],
  asks: null,
  pullRequests: [],
  program: null,
  url: null,
  ...over,
});

describe('threadWorkLine', () => {
  it('says how far a council is, with its members', () => {
    const line = threadWorkLine(
      thread({
        work: {
          kind: 'council',
          stage: 'research',
          answered: 2,
          of: 3,
          members: [
            { mark: 'openai', letter: 'G', working: false },
            { mark: 'claude', letter: 'C', working: true },
          ],
          since: at(12),
        },
      }),
      [],
      NOW,
    );
    expect(line).toMatchObject({ who: 'Council', tone: 'live' });
    expect(line?.text).toContain('2 of 3');
    expect(line?.progress).toEqual({ kind: 'steps', done: 2, working: 1, total: 3 });
    expect(line?.members).toHaveLength(2);
    expect(line?.spoken).toContain('12 minutes');
  });

  it('a council at its go-ahead waits for the person and has no clock', () => {
    const line = threadWorkLine(
      thread({ work: { kind: 'council', stage: 'approve', answered: 3, of: 3, members: [], since: at(40) } }),
      [],
      NOW,
    );
    expect(line).toMatchObject({ tone: 'warn', since: null, progress: null });
  });

  it('says what T3 Code does now, with a sweep', () => {
    const line = threadWorkLine(thread(), [handoff()], NOW);
    expect(line).toMatchObject({ who: 'T3 Code', tone: 'live', progress: { kind: 'sweep' } });
    expect(line?.text).toBe('running the tests');
    expect(line?.since).toBe(NOW - 6 * 60_000);
  });

  it('a permission T3 Code waits for comes first', () => {
    const line = threadWorkLine(thread(), [handoff(), handoff({ id: 't3:2', state: 'needs_ok' })], NOW);
    expect(line?.tone).toBe('warn');
  });

  it('a checklist counts its tasks and says when one needs the person', () => {
    const line = threadWorkLine(
      thread({ work: { kind: 'tasks', done: 2, total: 5, working: 2, needsYou: true, since: at(41) } }),
      [handoff()],
      NOW,
    );
    expect(line).toMatchObject({ who: 'Tasks', tone: 'warn' });
    expect(line?.text).toContain('2 of 5');
    expect(line?.progress).toEqual({ kind: 'steps', done: 2, working: 2, total: 5 });
  });

  it('nothing going on: no line', () => {
    expect(threadWorkLine(thread(), [handoff({ state: 'ended', outcome: 'completed' })], NOW)).toBeNull();
  });
});

describe('council steps', () => {
  it('shows only the steps a council of its kind takes', () => {
    expect(councilSteps('improve')).toHaveLength(5);
    expect(councilStepIndex('approve', 'improve')).toBe(2);
    expect(councilStepIndex('done', 'improve')).toBe(5);
    // Research agrees on one answer; it never waits for a go-ahead or builds.
    expect(councilSteps('research')).toHaveLength(2);
    expect(councilStepIndex('agree', 'research')).toBe(1);
    expect(councilStepIndex('done', 'research')).toBe(2);
    // A review is one round: nothing to show.
    expect(councilSteps('review')).toEqual([]);
    expect(councilStepIndex('stopped', 'improve')).toBe(-1);
  });
});

describe('an offered list on the work line', () => {
  it('waits for the person’s Hand over, without a clock or progress', () => {
    const line = threadWorkLine(
      {
        work: {
          kind: 'tasks',
          done: 0,
          total: 4,
          working: 0,
          needsYou: true,
          offered: true,
          since: '2026-11-09T06:22:00Z',
        },
      } as never,
      [],
      Date.parse('2026-11-09T07:00:00Z'),
    );
    expect(line).toMatchObject({
      who: 'Tasks',
      text: 'waiting for your hand-over · 4 tasks',
      tone: 'warn',
      since: null,
    });
    expect(line?.progress).toBeNull();
  });
});
