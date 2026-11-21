/**
 * The reaction picker's model (docs/decisions/essentials-messages.md AP-444): what it lists — recent emoji first, then
 * core's groups, or the search results — and how the arrow keys move through the grid. Pure, so the keyboard rules are
 * tested without a browser.
 */
import {
  EMOJI,
  EMOJI_GROUP_LABELS,
  EMOJI_GROUPS,
  type Emoji,
  type EmojiGroup,
  emojiByChar,
  RECENT_EMOJI_MAX,
  searchEmoji,
} from '@whombat/core';

/** Emoji per row in the picker's grid. */
export const EMOJI_COLUMNS = 8;

export interface EmojiSection {
  id: 'recent' | 'results' | EmojiGroup;
  label: string;
  emoji: readonly Emoji[];
}

/** A cell of the grid: its section and its place in it. */
export interface EmojiCell {
  section: number;
  index: number;
}

/** A recent emoji that isn't in core's list (a reaction someone typed elsewhere) still shows, named by itself. */
function recentEmoji(char: string): Emoji {
  return emojiByChar(char) ?? { char, name: char, keywords: [], group: 'symbols' };
}

/** The picker's sections: the search results for a query, otherwise Recent (when there are any) and every group. */
export function emojiSections(query: string, recent: readonly string[]): EmojiSection[] {
  if (query.trim()) {
    const results = searchEmoji(query);
    return results.length ? [{ id: 'results', label: 'Results', emoji: results }] : [];
  }
  const groups: EmojiSection[] = EMOJI_GROUPS.map((group) => ({
    id: group,
    label: EMOJI_GROUP_LABELS[group],
    emoji: EMOJI.filter((e) => e.group === group),
  }));
  const recents = recent.slice(0, RECENT_EMOJI_MAX).map(recentEmoji);
  return recents.length ? [{ id: 'recent', label: 'Recent', emoji: recents }, ...groups] : groups;
}

/** The first emoji of each group, for the picker's group buttons. */
export function groupIcon(group: EmojiGroup): string {
  return EMOJI.find((e) => e.group === group)?.char ?? '';
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * Where a key moves from `at`. Left and right walk the emoji in order across sections; up and down keep the column,
 * stepping into the previous section's last row or the next section's first row (never past its last emoji); Home and
 * End go to the first and last emoji. `null` when there is nowhere to go (up from the first row: back to the search
 * field).
 */
export function moveInGrid(
  sections: readonly Pick<EmojiSection, 'emoji'>[],
  at: EmojiCell,
  key: GridKey,
  columns = EMOJI_COLUMNS,
): EmojiCell | null {
  const sizes = sections.map((s) => s.emoji.length);
  const lastSection = sizes.findLastIndex((n) => n > 0);
  const firstSection = sizes.findIndex((n) => n > 0);
  if (firstSection < 0) return null;
  const size = sizes[at.section] ?? 0;
  const column = at.index % columns;
  const prevWith = (from: number) => {
    for (let s = from - 1; s >= 0; s--) if ((sizes[s] ?? 0) > 0) return s;
    return -1;
  };
  const nextWith = (from: number) => {
    for (let s = from + 1; s < sizes.length; s++) if ((sizes[s] ?? 0) > 0) return s;
    return -1;
  };
  switch (key) {
    case 'Home':
      return { section: firstSection, index: 0 };
    case 'End':
      return { section: lastSection, index: (sizes[lastSection] ?? 1) - 1 };
    case 'ArrowRight': {
      if (at.index + 1 < size) return { section: at.section, index: at.index + 1 };
      const next = nextWith(at.section);
      return next < 0 ? at : { section: next, index: 0 };
    }
    case 'ArrowLeft': {
      if (at.index > 0) return { section: at.section, index: at.index - 1 };
      const prev = prevWith(at.section);
      return prev < 0 ? at : { section: prev, index: (sizes[prev] ?? 1) - 1 };
    }
    case 'ArrowDown': {
      if (at.index + columns < size) return { section: at.section, index: at.index + columns };
      // Within the last row already: the last emoji of a short row below, else the next section.
      const lastRowStart = Math.floor((size - 1) / columns) * columns;
      if (at.index < lastRowStart) return { section: at.section, index: size - 1 };
      const next = nextWith(at.section);
      if (next < 0) return at;
      return { section: next, index: Math.min(column, (sizes[next] ?? 1) - 1) };
    }
    case 'ArrowUp': {
      if (at.index - columns >= 0) return { section: at.section, index: at.index - columns };
      const prev = prevWith(at.section);
      if (prev < 0) return null;
      const prevSize = sizes[prev] ?? 1;
      const rowStart = Math.floor((prevSize - 1) / columns) * columns;
      return { section: prev, index: Math.min(rowStart + column, prevSize - 1) };
    }
  }
}

/** The accessible name of an emoji button: “thumbs up”, with “, yours” when the viewer already reacted with it. */
export function emojiLabel(e: Pick<Emoji, 'name'>, mine = false): string {
  return mine ? `${e.name}, yours` : e.name;
}
