import { DEFAULT_CHAT_PREFERENCES } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  apartInTime,
  autoSettle,
  chatPreferencesOf,
  quietCutoff,
  type SettleCandidate,
  settleRefusal,
  threadSettleOf,
} from './settle-rules';

const now = new Date('2026-10-28T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY_MS);
const open = (over: Partial<SettleCandidate> = {}): SettleCandidate => ({
  lastAt: daysAgo(1),
  keptOpen: false,
  pinned: false,
  working: false,
  waiting: false,
  endedAt: null,
  ...over,
});

describe('the person’s choices', () => {
  it('are the defaults until they choose', () => {
    expect(chatPreferencesOf(undefined)).toEqual(DEFAULT_CHAT_PREFERENCES);
    expect(chatPreferencesOf({ theme: 'dark', timeZone: null })).toEqual({
      settleQuietDays: 3,
      settleMerged: true,
    });
    expect(chatPreferencesOf({ chat: { settleQuietDays: null, settleMerged: false } })).toEqual({
      settleQuietDays: null,
      settleMerged: false,
    });
  });
});

describe('refusing to settle', () => {
  it('names the agent while it works, then asks for the answer, else lets it settle', () => {
    expect(settleRefusal({ working: true, waiting: true }, 'Dusty')).toMatch(/^Dusty /);
    expect(settleRefusal({ working: false, waiting: true }, 'Dusty')).toMatch(/your answer/);
    expect(settleRefusal({ working: false, waiting: false }, 'Dusty')).toBeNull();
  });

  it('says “Your assistant” when there is no name', () => {
    expect(settleRefusal({ working: true, waiting: false }, null)).toMatch(/^Your assistant /);
  });
});

describe('settling by itself', () => {
  const prefs = DEFAULT_CHAT_PREFERENCES;

  it('settles a thread quiet for the person’s days at its last message’s time', () => {
    expect(autoSettle(open({ lastAt: daysAgo(3) }), prefs, now)).toEqual({
      how: 'quiet',
      at: daysAgo(3).toISOString(),
    });
    expect(autoSettle(open({ lastAt: daysAgo(2.9) }), prefs, now)).toBeNull();
    expect(autoSettle(open({ lastAt: daysAgo(30) }), { ...prefs, settleQuietDays: null }, now)).toBeNull();
  });

  it('settles when its pull request merged, at that time, before quiet days apply', () => {
    const endedAt = daysAgo(0.5);
    expect(autoSettle(open({ endedAt }), prefs, now)).toEqual({ how: 'merged', at: endedAt.toISOString() });
    expect(autoSettle(open({ lastAt: daysAgo(9), endedAt }), prefs, now)?.how).toBe('merged');
    expect(autoSettle(open({ endedAt }), { ...prefs, settleMerged: false }, now)).toBeNull();
  });

  it('never while it works or waits, nor when the person kept it open, pinned something or hasn’t read it', () => {
    const quiet = { lastAt: daysAgo(10), endedAt: daysAgo(5) };
    for (const busy of [
      { working: true },
      { waiting: true },
      { keptOpen: true },
      { pinned: true },
      { unread: true },
    ])
      expect(autoSettle(open({ ...quiet, ...busy }), prefs, now)).toBeNull();
  });

  it('counts whole days back from now', () => {
    expect(quietCutoff(now, 3).toISOString()).toBe('2026-10-25T12:00:00.000Z');
  });
});

describe('a first message’s settle', () => {
  it('is null while open, and when and how once settled', () => {
    expect(threadSettleOf({ settledAt: null, settledHow: null })).toBeNull();
    expect(threadSettleOf({ settledAt: now, settledHow: 'person' })).toEqual({
      at: now.toISOString(),
      how: 'person',
    });
  });
});

describe('threads settled together', () => {
  it('never share a moment, so the shelf pages through all of them', () => {
    const at = now.toISOString();
    const apart = apartInTime([
      { id: 'a', settle: { at, how: 'merged' as const } },
      { id: 'b', settle: { at, how: 'merged' as const } },
      { id: 'c', settle: { at: daysAgo(1).toISOString(), how: 'quiet' as const } },
      { id: 'd', settle: { at, how: 'merged' as const } },
    ]);
    expect(apart.map((s) => Date.parse(s.settle.at) - now.getTime())).toEqual([0, -1, -DAY_MS, -2]);
    expect(apart.map((s) => s.settle.how)).toEqual(['merged', 'merged', 'quiet', 'merged']);
  });
});
