import { describe, expect, it } from 'vitest';
import { CACHE_MISS_MIN_TOKENS, judgeCache, sumCacheResults } from './cache-result';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * A resumed turn of three calls on a session whose last context was 50 000 tokens: the turn adds 1 500 (its message,
 * replies, a tool result). `firstRead` is what the first call read from the cache.
 */
function turn(firstRead: number) {
  const calls = [51_000, 51_800, 52_500];
  const reads = [firstRead, 51_000, 51_800];
  return {
    inputTokens: calls.reduce((a, b) => a + b, 0),
    outputTokens: 400,
    cacheReadTokens: reads.reduce((a, b) => a + b, 0),
    cacheWriteTokens: calls.reduce((a, b, i) => a + b - (reads[i] ?? 0), 0),
    largestCallInputTokens: 52_500,
  };
}

describe('a resumed turn’s cache result (prompt-efficiency.md PE-12)', () => {
  it('a hit: every call read what came before it, the first the session’s last context', () => {
    expect(
      judgeCache({ usage: turn(50_000), priorContextTokens: 50_000, gapMs: 20 * MINUTE, ttlMs: HOUR }),
    ).toEqual({
      result: 'hit',
      unreadTokens: 0,
      priorContextTokens: 50_000,
      gapMs: 20 * MINUTE,
      ttlMs: HOUR,
    });
    // Small differences (reminders, a provider's cache blocks) are still a hit.
    expect(
      judgeCache({ usage: turn(49_200), priorContextTokens: 50_000, gapMs: 0, ttlMs: HOUR })?.result,
    ).toBe('hit');
  });

  it('expired: nothing of the history read, after the session’s cache lifetime', () => {
    // Only the tools and system prompt came from the cache (another conversation's turn kept them warm).
    const judged = judgeCache({
      usage: turn(31_000),
      priorContextTokens: 50_000,
      gapMs: 7 * MINUTE,
      ttlMs: 5 * MINUTE,
    });
    expect(judged).toMatchObject({ result: 'expired', unreadTokens: 19_000 });
    expect(
      judgeCache({ usage: turn(0), priorContextTokens: 50_000, gapMs: 2 * HOUR, ttlMs: HOUR })?.result,
    ).toBe('expired');
  });

  it('a miss: within the lifetime, the prefix wasn’t what the session cached', () => {
    expect(
      judgeCache({ usage: turn(31_000), priorContextTokens: 50_000, gapMs: MINUTE, ttlMs: 5 * MINUTE }),
    ).toMatchObject({ result: 'miss', unreadTokens: 19_000 });
    // A turn that read nothing at all within the hour of a person-paced turn.
    expect(
      judgeCache({ usage: turn(0), priorContextTokens: 50_000, gapMs: 30 * MINUTE, ttlMs: HOUR })?.result,
    ).toBe('miss');
  });

  it('a big tool result added to the context is not a miss', () => {
    // The turn read a 40 000-token file: written once, read by the next call.
    const usage = {
      inputTokens: 51_000 + 91_000,
      outputTokens: 300,
      cacheReadTokens: 50_000 + 51_000,
      cacheWriteTokens: 1_000 + 40_000,
      largestCallInputTokens: 91_000,
    };
    expect(judgeCache({ usage, priorContextTokens: 50_000, gapMs: MINUTE, ttlMs: HOUR })?.result).toBe('hit');
  });

  it('can’t be judged without the cache split, the largest call or a session context worth caching', () => {
    const { cacheReadTokens: _r, ...noSplit } = turn(50_000);
    const { largestCallInputTokens: _l, ...noLargest } = turn(50_000);
    for (const usage of [noSplit, noLargest])
      expect(judgeCache({ usage, priorContextTokens: 50_000, gapMs: 0, ttlMs: HOUR })).toBeNull();
    expect(judgeCache({ usage: turn(0), priorContextTokens: null, gapMs: 0, ttlMs: HOUR })).toBeNull();
    expect(judgeCache({ usage: turn(0), priorContextTokens: 3_000, gapMs: 0, ttlMs: HOUR })).toBeNull();
    expect(CACHE_MISS_MIN_TOKENS).toBe(1024);
  });

  it('counts add up, and stay absent where no turn had one', () => {
    expect(
      sumCacheResults([
        { cacheResults: { hit: 2, expired: 1, miss: 0 } },
        {},
        { cacheResults: { hit: 1, expired: 0, miss: 1 } },
      ] as never),
    ).toEqual({
      cacheResults: { hit: 3, expired: 1, miss: 1 },
    });
    expect(sumCacheResults([{}, {}] as never)).toEqual({});
  });
});
