/** Contracts 0.26, the essentials: emoji, failed-turn copy, the composer (CT-167…CT-181). */
import { describe, expect, it } from 'vitest';
import { TurnFailureCode } from '../domain/dispatch.js';
import { composerPlaceholder } from './copy.js';
import {
  EMOJI,
  EMOJI_GROUP_LABELS,
  EMOJI_GROUPS,
  emojiByChar,
  pushRecentEmoji,
  QUICK_REACTIONS,
  RECENT_EMOJI_MAX,
  searchEmoji,
} from './emoji.js';
import { TURN_FAILURE_LABELS, turnFailureText, turnRetriedText } from './turns.js';

describe('EMOJI (CT-178)', () => {
  it('is a sane data set', () => {
    expect(EMOJI.length).toBeGreaterThanOrEqual(240);
    expect(EMOJI.length).toBeLessThanOrEqual(400);
    expect(new Set(EMOJI.map((e) => e.char)).size).toBe(EMOJI.length);
    expect(new Set(EMOJI.map((e) => e.name)).size).toBe(EMOJI.length);
    for (const e of EMOJI) {
      expect(EMOJI_GROUPS).toContain(e.group);
      expect(e.name).toBe(e.name.toLowerCase());
      expect(e.name.trim()).toBe(e.name);
      expect(e.char.length).toBeGreaterThan(0);
      expect(e.char.length).toBeLessThanOrEqual(32);
      // No letters or digits: every entry is an emoji, not text.
      expect(/[\p{L}\p{N}]/u.test(e.char), e.name).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(e.char), e.name).toBe(true);
      for (const k of e.keywords) expect(k).toBe(k.toLowerCase());
    }
    for (const g of EMOJI_GROUPS) {
      expect(EMOJI_GROUP_LABELS[g]).toBeTruthy();
      expect(EMOJI.some((e) => e.group === g)).toBe(true);
    }
    // Picker order: groups in EMOJI_GROUPS order.
    const order = EMOJI.map((e) => EMOJI_GROUPS.indexOf(e.group));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const q of QUICK_REACTIONS) expect(emojiByChar(q), q).toBeDefined();
  });

  it('searches by name and keyword, best first', () => {
    expect(searchEmoji('thumbs')[0]?.char).toBe('👍');
    expect(searchEmoji('+1')[0]?.char).toBe('👍');
    expect(searchEmoji(':tada:')[0]?.char).toBe('🎉');
    expect(searchEmoji('HEART').map((e) => e.char)).toContain('❤️');
    expect(searchEmoji('rocket')[0]?.char).toBe('🚀');
    expect(searchEmoji('')).toEqual([]);
    expect(searchEmoji('zzzzqqq')).toEqual([]);
    expect(searchEmoji('face', 5)).toHaveLength(5);
  });

  it('keeps a short recent list', () => {
    expect(pushRecentEmoji(['👍', '🎉'], '🎉')).toEqual(['🎉', '👍']);
    const many = EMOJI.slice(0, 30).map((e) => e.char);
    expect(pushRecentEmoji(many, '✅')).toHaveLength(RECENT_EMOJI_MAX);
  });
});

describe('failed-turn copy (CT-167)', () => {
  it('has a safe sentence and a label for every code, within the card limit', () => {
    for (const code of TurnFailureCode.options) {
      const text = turnFailureText(code, { provider: 'claude' });
      expect(text.length).toBeLessThanOrEqual(200);
      // Every code offers Try again except a content refusal, where the same request would be declined again: it
      // guides the person to reword or switch models instead.
      if (code === 'refused') expect(text).toMatch(/reword|switch models/i);
      else expect(text).toMatch(/Try again/);
      expect(text).not.toMatch(/'/);
      expect(TURN_FAILURE_LABELS[code]).toBeTruthy();
    }
  });

  it('names the provider and the reset time', () => {
    const chatgpt = turnFailureText('signin', { provider: 'codex' });
    expect(chatgpt).toContain('ChatGPT');
    expect(chatgpt).toContain('Settings → AI');
    expect(chatgpt).not.toMatch(/codex/i);
    expect(turnFailureText('provider')).toContain('the AI provider');
    expect(
      turnFailureText('usage_limit', {
        provider: 'claude',
        resetsAt: '2026-09-30T14:00:00.000Z',
        now: '2026-09-30T10:00:00.000Z',
        timeZone: 'Europe/Amsterdam',
      }),
    ).toBe(
      'I stopped because the Claude usage limit was reached. It resets at 16:00; press Try again after that.',
    );
    expect(turnFailureText('usage_limit')).toBe(
      'I stopped because the usage limit was reached. Press Try again once it resets.',
    );
    expect(turnRetriedText('2026-09-30T12:32:00.000Z', 'Europe/Amsterdam')).toBe('Tried again · 14:32');
  });
});

describe('the composer', () => {
  it('names the agent in the chat and the PR in a branch room', () => {
    expect(composerPlaceholder({ kind: 'dm', agentName: 'Dusty' })).toBe('Message Dusty');
    expect(composerPlaceholder({ kind: 'branch', prNumber: 482 })).toBe('Comment on PR #482');
  });
});
