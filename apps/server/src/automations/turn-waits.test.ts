import { describe, expect, it } from 'vitest';
import {
  handedWaitOf,
  resumedLine,
  resumedOutput,
  STEP_WAIT_SLICE_MS,
  slicedWaitArgs,
  waitTimedOut,
} from './turn-waits';

const outsiders = { trigger: 'automation' as const, onBehalfOfAccountId: null };

describe('a step’s turn hands its T3 Code wait to Whombat', () => {
  it('an automation step’s outsiders’ turn waits at most a slice at a time; any other turn as it asked', () => {
    expect(slicedWaitArgs(outsiders, { threadId: 't', timeoutMs: 3_600_000 }).timeoutMs).toBe(
      STEP_WAIT_SLICE_MS,
    );
    expect(slicedWaitArgs(outsiders, { threadId: 't' }).timeoutMs).toBe(STEP_WAIT_SLICE_MS);
    expect(slicedWaitArgs(outsiders, { threadId: 't', timeoutMs: 10_000 }).timeoutMs).toBe(10_000);
    const person = { trigger: 'automation' as const, onBehalfOfAccountId: 'acc_1' };
    expect(slicedWaitArgs(person, { threadId: 't', timeoutMs: 3_600_000 }).timeoutMs).toBe(3_600_000);
    const chat = { trigger: 'mention' as const, onBehalfOfAccountId: null };
    expect(slicedWaitArgs(chat, { threadId: 't' }).timeoutMs).toBeUndefined();
  });

  it('only a wait whose time ran out counts as still at work', () => {
    expect(waitTimedOut({ status: 'running', timedOut: true })).toBe(true);
    expect(waitTimedOut({ status: 'completed', timedOut: false })).toBe(false);
    expect(waitTimedOut({ status: 'waiting' })).toBe(false);
    expect(waitTimedOut(null)).toBe(false);
  });

  it('each next turn counts, keeps the first claim, and its result starts after the newest message', () => {
    const claimedAt = new Date('2026-11-09T18:52:00Z');
    const waitsOn = { connectionId: 'con_1', threadId: 'mcp:fix', settled: true, at: '2026-11-09T19:00:00Z' };
    const usage = { inputTokens: 1000, outputTokens: 200 };
    const once = resumedOutput({ instructions: 'Fix it.' }, { claimedAt, waitsOn, usage }, 41);
    expect(handedWaitOf(once)).toMatchObject({
      count: 1,
      since: claimedAt.toISOString(),
      threadId: 'mcp:fix',
      afterOrd: 41,
    });
    // What each handed turn used adds up, so the run's limits count it.
    const first = handedWaitOf(once)?.tokens ?? 0;
    expect(first).toBeGreaterThan(0);
    const twice = resumedOutput(once, { claimedAt: new Date('2026-11-09T19:30:00Z'), waitsOn, usage }, 57);
    expect(handedWaitOf(twice)).toMatchObject({ count: 2, since: claimedAt.toISOString(), afterOrd: 57 });
    expect(handedWaitOf(twice)?.tokens).toBe(first * 2);
    expect(handedWaitOf(resumedOutput({}, { claimedAt, waitsOn, usage: null }, 1))?.tokens).toBe(0);
    expect(twice.instructions).toBe('Fix it.');
    expect(handedWaitOf({ instructions: 'Fix it.' })).toBeNull();
  });

  it('the next turn hears which thread it handed over and to read it', () => {
    const line = resumedLine('mcp:fix-25');
    expect(line).toContain('mcp:fix-25');
    expect(line).toContain('t3_thread_read');
  });
});
