import { describe, expect, it } from 'vitest';
import { ranPhrase, stepsProgress } from '../commands/agent-runs';
import { MAX_BUCKETS, McpRateLimiter, TokenBuckets } from './rate-limit';

describe('token buckets', () => {
  it('allows a burst, then refills over time', () => {
    let now = 0;
    const buckets = new TokenBuckets({ capacity: 3, perSecond: 1 }, () => now);
    expect([buckets.take('a'), buckets.take('a'), buckets.take('a'), buckets.take('a')]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(buckets.retryAfter('a')).toBe(1);
    expect(buckets.take('b')).toBe(true);
    now = 1500;
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    now = 60_000;
    expect([buckets.take('a'), buckets.take('a'), buckets.take('a'), buckets.take('a')]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('a new key stays limited when the map is full: pruning never drops the bucket just taken (FR-14)', () => {
    let now = 0;
    const buckets = new TokenBuckets({ capacity: 2, perSecond: 1 / 3600 }, () => now);
    for (let i = 0; i < MAX_BUCKETS + 5; i++) buckets.take(`k${i}`);
    now = 10;
    // Every earlier key is below capacity: the map stays over the mark, and each call for a new key prunes.
    const results = [0, 1, 2].map(() => buckets.has('fresh') && buckets.take('fresh'));
    expect(results).toEqual([true, true, false]);
    // Full buckets go when a new key needs room.
    now = 100_000_000;
    buckets.take('another');
    expect(buckets.size).toBeLessThan(10);
  });

  it('limits per dispatch and per agent, taking from both or neither', () => {
    let now = 0;
    const limiter = new McpRateLimiter(
      { perAgent: { capacity: 3, perSecond: 0.1 }, perDispatch: { capacity: 2, perSecond: 0.1 } },
      () => now,
    );
    expect(limiter.take('prn_dusty', 'dsp_1')).toEqual({ ok: true });
    expect(limiter.take('prn_dusty', 'dsp_1')).toEqual({ ok: true });
    expect(limiter.take('prn_dusty', 'dsp_1')).toMatchObject({ ok: false, scope: 'dispatch' });
    // The refused call did not spend the agent's token.
    expect(limiter.take('prn_dusty', 'dsp_2')).toEqual({ ok: true });
    expect(limiter.take('prn_dusty', 'dsp_2')).toMatchObject({ ok: false, scope: 'agent', retryAfter: 10 });
    expect(limiter.take('prn_other', 'dsp_3')).toEqual({ ok: true });
    now = 10_000;
    expect(limiter.take('prn_dusty', 'dsp_2')).toEqual({ ok: true });
  });
});

describe('run helpers', () => {
  it('computes progress from steps (done counts fully, active half)', () => {
    expect(stepsProgress([])).toBe(0);
    expect(stepsProgress(['active', 'queued'])).toBe(25);
    expect(stepsProgress(['done', 'active', 'queued', 'queued', 'queued'])).toBe(30);
    expect(stepsProgress(['done', 'done'])).toBe(100);
  });

  it('turns the active step into the log line for tests', () => {
    expect(ranPhrase('Run the billing test suite')).toBe('Ran the billing test suite');
    expect(ranPhrase('Push and ask Joris to re-review')).toBe('Ran the tests');
    expect(ranPhrase(undefined)).toBe('Ran the tests');
  });
});
