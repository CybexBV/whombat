/**
 * The one Needs you list's groups and count (Whombat needs-you-list.md NYL-02, NYL-04): quiet first, heads-ups, then
 * what the assistant does about a problem decides whose it is; only `you` counts.
 */
import { describe, expect, it } from 'vitest';
import { type NeedsYouItem, needsYouCount, needsYouGroupOf, needsYouItemHref } from './home.js';
import type { LookResearch } from './look-research.js';

const research = (state: LookResearch['state'], fix?: string): LookResearch => ({
  key: 'server:pve-02',
  state,
  ...(fix ? { fix } : {}),
  at: '2026-10-30T09:00:00.000Z',
});

type Facts = Pick<NeedsYouItem, 'kind' | 'nature' | 'research' | 'state'>;
const problem: Facts = { kind: 'alert', nature: 'problem' };
const onlyYou: Facts = { kind: 'hint', nature: 'you' };

describe('needsYouGroupOf', () => {
  it('puts what is ignored or reminded later at the foot, whatever it is', () => {
    expect(needsYouGroupOf({ ...problem, state: 'snoozed' })).toBe('quiet');
    expect(needsYouGroupOf({ kind: 'approval', state: 'acknowledged' })).toBe('quiet');
    expect(needsYouGroupOf({ ...problem, state: 'open' })).toBe('you');
  });

  it('folds heads-ups', () => {
    expect(needsYouGroupOf({ kind: 'hint', nature: 'fyi' })).toBe('fyi');
  });

  it('gives a problem to the assistant while it looks, takes its step or has just fixed it', () => {
    expect(needsYouGroupOf({ ...problem, research: research('looking') })).toBe('assistant');
    expect(needsYouGroupOf({ ...problem, research: research('fixing') })).toBe('assistant');
    expect(needsYouGroupOf({ ...problem, research: research('fixed') })).toBe('assistant');
  });

  it('gives a problem back to the person once it found something, or when nobody looks', () => {
    expect(needsYouGroupOf({ ...problem, research: research('found', 'Restart Zigbee') })).toBe('you');
    expect(needsYouGroupOf({ ...problem, research: research('found') })).toBe('you');
    expect(needsYouGroupOf({ ...problem, research: research('failed') })).toBe('you');
    expect(needsYouGroupOf(problem)).toBe('you');
  });

  it('keeps an only-you line with the person unless the assistant is taking the step they said yes to', () => {
    expect(needsYouGroupOf({ ...onlyYou, research: research('looking') })).toBe('you');
    expect(needsYouGroupOf({ ...onlyYou, research: research('fixed') })).toBe('you');
    expect(needsYouGroupOf({ ...onlyYou, research: research('fixing') })).toBe('assistant');
  });

  it('counts a line without a nature (an older source) as a problem, an ask as the person’s', () => {
    expect(needsYouGroupOf({ kind: 'alert', research: research('looking') })).toBe('assistant');
    expect(needsYouGroupOf({ kind: 'approval' })).toBe('you');
    expect(needsYouGroupOf({ kind: 'question' })).toBe('you');
    expect(needsYouGroupOf({ kind: 'enrollment' })).toBe('you');
  });
});

describe('needsYouCount', () => {
  it('counts only the first group, an item from an older Whombat as needing the person', () => {
    expect(
      needsYouCount([{ group: 'you' }, { group: 'assistant' }, { group: 'fyi' }, { group: 'quiet' }, {}]),
    ).toBe(2);
    expect(needsYouCount([])).toBe(0);
  });
});

describe('needsYouItemHref', () => {
  it('names the item in the list’s address', () => {
    expect(needsYouItemHref('hosts.alert:12')).toBe('/needs-you?item=hosts.alert%3A12');
  });
});
