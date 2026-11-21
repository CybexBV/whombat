/** The reaction picker's model and recent list (docs/decisions/essentials-messages.md AP-444). */
import { EMOJI_GROUPS, RECENT_EMOJI_MAX } from '@whombat/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMOJI_COLUMNS, emojiLabel, emojiSections, groupIcon, moveInGrid } from './emojiModel';
import {
  __resetRecentEmojiForTests,
  parseRecentEmoji,
  RECENT_EMOJI_KEY,
  readRecentEmoji,
  rememberEmoji,
} from './recentEmoji';

afterEach(() => {
  __resetRecentEmojiForTests();
  vi.restoreAllMocks();
});

describe('emojiSections', () => {
  it('lists Recent first, then every group in order', () => {
    const sections = emojiSections('', ['🎉', 'finally']);
    expect(sections.map((s) => s.id)).toEqual(['recent', ...EMOJI_GROUPS]);
    expect(sections[0]?.emoji.map((e) => e.char)).toEqual(['🎉', 'finally']);
    // A recent reaction that isn't in core's list is named by itself.
    expect(sections[0]?.emoji[1]?.name).toBe('finally');
    expect(emojiSections('', []).map((s) => s.id)).toEqual([...EMOJI_GROUPS]);
  });

  it('shows search results alone, or nothing when none match', () => {
    const results = emojiSections('tada', ['👍']);
    expect(results.map((s) => s.id)).toEqual(['results']);
    expect(results[0]?.emoji[0]?.char).toBe('🎉');
    expect(emojiSections('zzqqxx', [])).toEqual([]);
  });

  it('gives each group a button face and labels emoji by name', () => {
    for (const g of EMOJI_GROUPS) expect(groupIcon(g)).not.toBe('');
    expect(emojiLabel({ name: 'thumbs up' })).toBe('thumbs up');
    expect(emojiLabel({ name: 'thumbs up' }, true)).toBe('thumbs up, yours');
  });
});

describe('moveInGrid', () => {
  // Two sections: 10 emoji (a row of 8 and a row of 2), then 3.
  const sections = [{ emoji: Array.from({ length: 10 }) }, { emoji: Array.from({ length: 3 }) }] as never;

  it('walks left and right across sections', () => {
    expect(moveInGrid(sections, { section: 0, index: 9 }, 'ArrowRight')).toEqual({ section: 1, index: 0 });
    expect(moveInGrid(sections, { section: 1, index: 0 }, 'ArrowLeft')).toEqual({ section: 0, index: 9 });
    expect(moveInGrid(sections, { section: 1, index: 2 }, 'ArrowRight')).toEqual({ section: 1, index: 2 });
    expect(moveInGrid(sections, { section: 0, index: 0 }, 'ArrowLeft')).toEqual({ section: 0, index: 0 });
  });

  it('keeps the column going down and up, clamped to short rows', () => {
    expect(moveInGrid(sections, { section: 0, index: 1 }, 'ArrowDown')).toEqual({ section: 0, index: 9 });
    // From the first row over a short last row: its last emoji.
    expect(moveInGrid(sections, { section: 0, index: 5 }, 'ArrowDown')).toEqual({ section: 0, index: 9 });
    // From the last row into the next section, same column (clamped).
    expect(moveInGrid(sections, { section: 0, index: 8 }, 'ArrowDown')).toEqual({ section: 1, index: 0 });
    expect(moveInGrid(sections, { section: 0, index: 9 }, 'ArrowDown')).toEqual({ section: 1, index: 1 });
    expect(moveInGrid(sections, { section: 1, index: 2 }, 'ArrowDown')).toEqual({ section: 1, index: 2 });
    expect(moveInGrid(sections, { section: 1, index: 1 }, 'ArrowUp')).toEqual({ section: 0, index: 9 });
    expect(moveInGrid(sections, { section: 1, index: 2 }, 'ArrowUp')).toEqual({ section: 0, index: 9 });
    expect(moveInGrid(sections, { section: 0, index: 9 }, 'ArrowUp')).toEqual({ section: 0, index: 1 });
  });

  it('leaves the grid upwards from the first row, and Home / End go to the ends', () => {
    expect(moveInGrid(sections, { section: 0, index: 3 }, 'ArrowUp')).toBeNull();
    expect(moveInGrid(sections, { section: 1, index: 1 }, 'Home')).toEqual({ section: 0, index: 0 });
    expect(moveInGrid(sections, { section: 0, index: 1 }, 'End')).toEqual({ section: 1, index: 2 });
    expect(moveInGrid([], { section: 0, index: 0 }, 'ArrowDown')).toBeNull();
    expect(EMOJI_COLUMNS).toBe(8);
  });
});

describe('recent emoji', () => {
  it('keeps the newest first, without duplicates, at most RECENT_EMOJI_MAX, per browser', () => {
    rememberEmoji('👍');
    rememberEmoji('🎉');
    expect(rememberEmoji('👍')).toEqual(['👍', '🎉']);
    expect(JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) ?? '[]')).toEqual(['👍', '🎉']);
    for (let i = 0; i < 20; i++) rememberEmoji(`r${i}`);
    expect(readRecentEmoji()).toHaveLength(RECENT_EMOJI_MAX);
    expect(readRecentEmoji()[0]).toBe('r19');
  });

  it('ignores anything stored that isn’t a short list of short strings', () => {
    expect(parseRecentEmoji('not json')).toEqual([]);
    expect(parseRecentEmoji('{"a":1}')).toEqual([]);
    expect(parseRecentEmoji(JSON.stringify(['👍', 3, '', 'x'.repeat(40), '👍', '🎉']))).toEqual(['👍', '🎉']);
    localStorage.setItem(RECENT_EMOJI_KEY, '[[1]]');
    expect(readRecentEmoji()).toEqual([]);
  });

  it('keeps the list for the page when storage refuses', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(rememberEmoji('👀')).toEqual(['👀']);
    expect(readRecentEmoji()).toEqual(['👀']);
  });
});
