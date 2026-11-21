/**
 * Reactions and link previews on the phone (Whombat essentials item 14; contracts CT-174, CT-178; AP-507, AP-508): the
 * pills under a message, the emoji sheet's sections (recent, then the groups; a search replaces both) and the compact
 * card for a link. Pure: the emoji list and search are core's (`EMOJI`, `searchEmoji`), so web and phone find the same.
 */
import {
  EMOJI,
  EMOJI_GROUP_LABELS,
  EMOJI_GROUPS,
  type Emoji,
  emojiByChar,
  type LinkPreview,
  plural,
  pushRecentEmoji,
  QUICK_REACTIONS,
  RECENT_EMOJI_MAX,
  type Reaction,
  searchEmoji,
} from '@whombat/core';

export interface ReactionPill {
  value: string;
  count: number;
  /** The viewer reacted with it: a tap takes it back. */
  mine: boolean;
  /** “thumbs up, you”, “thumbs up, you and 1 more”, “finally, 1 reaction” (no people to count, AP-5733). */
  accessibilityLabel: string;
}

/** The emoji's name for TalkBack (`thumbs up`), else the value itself (a text reaction such as “finally”). */
export function reactionName(value: string): string {
  return emojiByChar(value)?.name ?? value;
}

export function reactionPills(reactions: readonly Reaction[]): ReactionPill[] {
  return reactions
    .filter((r) => r.count > 0)
    .map((r) => ({
      value: r.value,
      count: r.count,
      mine: r.mine,
      accessibilityLabel: `${reactionName(r.value)}, ${
        r.mine
          ? r.count > 1
            ? `you and ${r.count - 1} more`
            : 'you'
          : plural(r.count, 'reaction', 'reactions')
      }`,
    }));
}

/** The quick row of the message menu: core's six, the viewer's own marked. */
export function quickReactions(reactions: readonly Reaction[]): { value: string; mine: boolean }[] {
  const mine = new Set(reactions.filter((r) => r.mine).map((r) => r.value));
  return QUICK_REACTIONS.map((value) => ({ value, mine: mine.has(value) }));
}

export interface EmojiSection {
  key: string;
  /** `RECENT`, `SMILEYS`, `RESULTS` (mono section labels). */
  title: string;
  emoji: Emoji[];
}

/**
 * What the emoji sheet lists: with a search only its results (best first), else the recent ones (known emoji only,
 * at most `RECENT_EMOJI_MAX`) and every group in core's order.
 */
export function emojiSections(query: string, recent: readonly string[]): EmojiSection[] {
  if (query.trim()) {
    const found = searchEmoji(query, 96);
    return found.length ? [{ key: 'results', title: 'RESULTS', emoji: found }] : [];
  }
  const known = recent
    .map((c) => emojiByChar(c))
    .filter((e): e is Emoji => !!e)
    .slice(0, RECENT_EMOJI_MAX);
  return [
    ...(known.length ? [{ key: 'recent', title: 'RECENT', emoji: known }] : []),
    ...EMOJI_GROUPS.map((group) => ({
      key: group,
      title: EMOJI_GROUP_LABELS[group].toUpperCase(),
      emoji: EMOJI.filter((e) => e.group === group),
    })),
  ];
}

/** The emoji sheet's cells are 44dp squares, wrapped in rows across its width less 14dp a side (AP-905). */
export const EMOJI_CELL = 44;
export const EMOJI_SHEET_INSET = 14;

/** A line of the emoji sheet's list: a section's label, or one row of its emoji. */
export type EmojiLine =
  | { kind: 'title'; key: string; title: string }
  | { kind: 'row'; key: string; section: string; emoji: Emoji[] };

/** How many cells fit across the sheet (a wrapped row of 44dp cells), at least one. */
export function emojiPerRow(sheetWidth: number): number {
  return Math.max(1, Math.floor((sheetWidth - 2 * EMOJI_SHEET_INSET) / EMOJI_CELL));
}

/**
 * The sections as the lines of a virtualised list (AP-905): each label, then its emoji `perRow` at a time — the rows
 * the wrapped grid made, so only the ones in view are mounted (every group at once was ~390 buttons per opening).
 */
export function emojiLines(sections: readonly EmojiSection[], perRow: number): EmojiLine[] {
  const lines: EmojiLine[] = [];
  for (const s of sections) {
    lines.push({ kind: 'title', key: `${s.key}:title`, title: s.title });
    for (let at = 0; at < s.emoji.length; at += perRow)
      lines.push({
        kind: 'row',
        key: `${s.key}:${at}`,
        section: s.key,
        emoji: s.emoji.slice(at, at + perRow),
      });
  }
  return lines;
}

/** The recent list kept on the phone, parsed tolerantly (anything odd is dropped). */
export function parseRecentEmoji(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length <= 32)
      .slice(0, RECENT_EMOJI_MAX);
  } catch {
    return [];
  }
}

/** The recent list after using `char`, as stored. */
export function recentAfter(recent: readonly string[], char: string): string[] {
  return pushRecentEmoji(recent, char);
}

/* Link previews ------------------------------------------------------------------------------------------------- */

export interface PreviewCard {
  url: string;
  /** The site's name, else the link's host (`github.com`). */
  site: string;
  title: string;
  description: string | null;
  accessibilityLabel: string;
}

/** `github.com` from `https://github.com/…` (no `URL`: React Native's doesn't parse hosts everywhere). */
export function hostOf(url: string): string {
  const m = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^/?#:]+)/i.exec(url);
  return (m?.[1] ?? url).replace(/^www\./i, '').toLowerCase();
}

export function previewCards(previews: readonly LinkPreview[] | undefined): PreviewCard[] {
  return (previews ?? [])
    .filter((p) => /^https?:\/\//i.test(p.url) && p.title.trim())
    .slice(0, 3)
    .map((p) => {
      const site = p.siteName?.trim() || hostOf(p.url);
      return {
        url: p.url,
        site,
        title: p.title,
        description: p.description?.trim() || null,
        accessibilityLabel: `Link: ${p.title}, ${site}`,
      };
    });
}
