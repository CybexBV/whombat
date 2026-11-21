import type { Handoff } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  currentStep,
  endedWords,
  handoffLine,
  handoffMinutes,
  handoffRow,
  pullRequestLabel,
  threadHandoffs,
} from './handoff';
import { threadWork } from './working';

const h = (over: Partial<Handoff> = {}): Handoff => ({
  id: 'mcp:thread-1',
  to: 't3code',
  conversationId: 'cnv_chat00000001',
  rootId: 'msg_root00000001',
  agentId: 'prn_dusty',
  title: 'Dusty - Fix Settle',
  state: 'working',
  since: '2026-11-03T09:00:00.000Z',
  endedAt: null,
  outcome: null,
  steps: [],
  asks: null,
  pullRequests: [],
  program: 'Codex · gpt-5.5',
  url: 'http://thetitan:3773/env/mcp%3Athread-1',
  ...over,
});
const SINCE = Date.parse('2026-11-03T09:00:00.000Z');

describe('the reply row', () => {
  it('says T3 Code is at work with a clock, needs the person’s OK first, counts jobs, waits calmly for checks', () => {
    expect(handoffRow([h()])).toEqual({ text: 'is working on it', tone: 'live', since: SINCE });
    expect(handoffRow([h(), h({ id: 'b', state: 'needs_ok' })])).toMatchObject({
      text: 'needs your OK',
      tone: 'warn',
    });
    expect(handoffRow([h(), h({ id: 'b', since: '2026-11-03T08:00:00.000Z' })])).toEqual({
      text: '· 2 jobs',
      tone: 'live',
      since: Date.parse('2026-11-03T08:00:00.000Z'),
    });
    expect(
      handoffRow([h({ state: 'checks', pullRequests: ['https://github.com/o/r/pull/342'] })]),
    ).toMatchObject({
      text: 'is waiting for the checks on #342',
      tone: 'calm',
    });
    // Ended work leaves the row to the agent's answer.
    expect(handoffRow([h({ state: 'ended', outcome: 'completed' })])).toBeNull();
  });

  it('is the agent’s own while it thinks there, “answering T3 Code” when T3 Code asked it', () => {
    const typing = [{ principalId: 'prn_dusty', threadRootId: 'msg_root00000001' }];
    expect(threadWork('msg_root00000001', [], typing, [h({ state: 'asked' })])).toMatchObject({
      agentId: 'prn_dusty',
      text: 'is answering T3 Code',
    });
    expect(threadWork('msg_root00000001', [], typing, [h()])?.text).toBe('is thinking');
    expect(threadWork('msg_root00000001', [], [], [h()])).toMatchObject({
      by: 't3code',
      text: 'is working on it',
    });
  });
});

describe('the line at the thread’s end', () => {
  it('says what it does now, what it asks, what to do and how it ended', () => {
    const steps = [
      { text: 'Changing useSettle.tsx', detail: null, done: true },
      { text: 'Running the tests', detail: 'pnpm test', done: false },
    ];
    expect(handoffLine(h({ steps }), 'Dusty')).toMatchObject({
      title: 'T3 Code is working on it',
      now: 'Now: running the tests',
      live: true,
      clockFrom: SINCE,
      meta: 'Dusty - Fix Settle · Codex · gpt-5.5',
    });
    expect(currentStep({ steps })?.text).toBe('Running the tests');
    expect(handoffLine(h({ state: 'asked', asks: 'Which branch?' }), 'Dusty')).toMatchObject({
      title: 'T3 Code asked Dusty something',
      now: 'Which branch?',
    });
    expect(handoffLine(h({ state: 'needs_ok', asks: 'hello.txt' }), 'Dusty')).toMatchObject({ tone: 'warn' });
    expect(handoffLine(h({ state: 'needs_ok', asks: 'hello.txt' }), 'Dusty').now).toContain('hello.txt');
    expect(handoffLine(h({ state: 'checks', pullRequests: ['#342'] }), 'Dusty').now).toContain('Dusty');
    const ended = { since: '2026-11-03T09:00:00.000Z', endedAt: '2026-11-03T09:14:30.000Z' };
    expect(endedWords({ ...ended, outcome: 'completed' })).toBe('T3 Code finished in 14m');
    expect(endedWords({ ...ended, outcome: 'failed' })).toBe('T3 Code ran into a problem after 14m');
    expect(endedWords({ ...ended, outcome: 'stopped' })).toBe('T3 Code was stopped');
  });

  it('keeps an ended one until the thread has a reply after it', () => {
    const ended = h({ state: 'ended', outcome: 'completed', endedAt: '2026-11-03T09:14:00.000Z' });
    const other = h({ id: 'other', rootId: 'msg_other0000001' });
    expect(threadHandoffs([ended, other], 'msg_root00000001', '2026-11-03T09:10:00.000Z')).toEqual([ended]);
    expect(threadHandoffs([ended], 'msg_root00000001', '2026-11-03T09:15:00.000Z')).toEqual([]);
  });

  it('counts minutes and finds a pull request’s number', () => {
    expect(handoffMinutes(SINCE, SINCE + 20_000)).toBe('1m');
    expect(handoffMinutes(SINCE, SINCE + 65 * 60_000)).toBe('1h 05m');
    expect(pullRequestLabel('https://github.com/o/r/pull/7')).toBe('#7');
    expect(pullRequestLabel('#12')).toBe('#12');
    expect(pullRequestLabel('https://example.com')).toBeNull();
  });
});
