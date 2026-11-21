/**
 * Subscription usage's model (AP-340…AP-349, SS-01): tones and words, plans, a fresh snapshot and a refresh's outcome. The usage itself shows in Settings → AI's sign-in rows (yourAi.test.tsx); the crew
 * shell's Usage cards went with it (one-agent.md AP-4928).
 */
import type { UsageListOutput } from '@whombat/core/contracts';
import type { SubscriptionUsage, UsageWindow } from '@whombat/core/domain';
import { SEED_NOW, USAGE_SNAPSHOTS, usageList } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { pinMockDate } from '../../test/clock';
import { formatPlan, kindText, meterTone, mineByProvider, windowStatusWord, withUsage } from './model';
import { refreshOutcomeOf } from './useUsage';

pinMockDate();

const minutes = (n: number) => new Date(SEED_NOW.getTime() + n * 60_000).toISOString();

function win(
  kind: UsageWindow['kind'],
  usedPct: number | null,
  status: UsageWindow['status'] = 'ok',
): UsageWindow {
  const label =
    { five_hour: '5-hour', seven_day: '7-day', seven_day_opus: '7-day Opus' }[kind as string] ?? 'Usage';
  return { kind, label, usedPct, resetsAt: minutes(130), status };
}

const maraClaude = USAGE_SNAPSHOTS[0] as SubscriptionUsage;
const maraCodex = USAGE_SNAPSHOTS[1] as SubscriptionUsage;

function mine(...subs: SubscriptionUsage[]): UsageListOutput {
  return { mine: subs };
}

describe('usage model', () => {
  it('colors and words: ok, warning from 80 %, near the limit from 95 %, limited', () => {
    expect(meterTone(win('five_hour', 42))).toBe('ok');
    expect(windowStatusWord(win('five_hour', 42))).toBeNull();
    expect(meterTone(win('five_hour', 83))).toBe('warn');
    expect(windowStatusWord(win('five_hour', 83))).toBe('High');
    expect(meterTone(win('five_hour', 96))).toBe('bad');
    expect(windowStatusWord(win('five_hour', 96))).toBe('Near the limit');
    expect(meterTone(win('five_hour', 40, 'limited'))).toBe('bad');
    expect(windowStatusWord(win('five_hour', null, 'limited'))).toBe('Limit reached');
    expect(meterTone(win('five_hour', null))).toBe('mut');
  });

  it('plans, kinds and the providers without a sign-in', () => {
    expect(formatPlan('max')).toBe('Max');
    expect(formatPlan('max_5x')).toBe('Max 5x');
    expect(formatPlan(null)).toBeNull();
    expect(kindText(maraClaude)).toBe('Max plan');
    expect(kindText(maraCodex)).toBe('API key');
    expect(kindText({ kind: 'subscription', plan: null })).toBe('Subscription');
    expect(mineByProvider([maraCodex]).map((c) => [c.provider, c.usage?.kind ?? null])).toEqual([
      ['claude', null],
      ['codex', 'api_key'],
    ]);
  });

  it('puts a fresh snapshot in the person’s list, by provider', () => {
    const fresh = { ...maraClaude, observedAt: SEED_NOW.toISOString(), windows: [win('five_hour', 70)] };
    const next = withUsage(usageList(), fresh);
    expect(next.mine.find((s) => s.provider === 'claude')?.windows[0]?.usedPct).toBe(70);
    expect(withUsage(mine(), fresh).mine).toEqual([fresh]);
  });

  it('reads a refresh error: too soon with its wait, not signed in, anything else', () => {
    expect(refreshOutcomeOf({ status: 429, code: 'rate_limited', details: { retryAfter: 42 } })).toEqual({
      kind: 'too_soon',
      retryAfter: 42,
    });
    expect(refreshOutcomeOf({ status: 429, code: 'rate_limited' })).toEqual({
      kind: 'too_soon',
      retryAfter: 60,
    });
    expect(refreshOutcomeOf({ status: 404, code: 'not_found' })).toEqual({ kind: 'not_signed_in' });
    expect(refreshOutcomeOf(new Error('offline'))).toEqual({ kind: 'failed' });
  });
});
