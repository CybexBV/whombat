/**
 * Recently used reactions, per browser (docs/decisions/essentials-messages.md AP-444): `localStorage` under
 * `whombat:recent-emoji`, at most `RECENT_EMOJI_MAX`, most recent first (core's `pushRecentEmoji`). Anything stored
 * that isn't a short list of short strings is ignored; storage that is blocked or full keeps the list for the page.
 */
import { pushRecentEmoji, RECENT_EMOJI_MAX } from '@whombat/core';

export const RECENT_EMOJI_KEY = 'whombat:recent-emoji';

/** A reaction value's longest form (`ReactionValue`). */
const VALUE_MAX = 32;

let memory: string[] | null = null;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function parseRecentEmoji(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const chars = value.filter(
      (c): c is string => typeof c === 'string' && c.length > 0 && c.length <= VALUE_MAX,
    );
    return [...new Set(chars)].slice(0, RECENT_EMOJI_MAX);
  } catch {
    return [];
  }
}

export function readRecentEmoji(): string[] {
  if (memory) return memory;
  try {
    return parseRecentEmoji(storage()?.getItem(RECENT_EMOJI_KEY) ?? null);
  } catch {
    return [];
  }
}

/** Remember a reaction as the most recent one; returns the new list. */
export function rememberEmoji(char: string): string[] {
  const next = pushRecentEmoji(readRecentEmoji(), char);
  try {
    const s = storage();
    if (s) {
      s.setItem(RECENT_EMOJI_KEY, JSON.stringify(next));
      memory = null;
      return next;
    }
  } catch {
    // Blocked or full: keep it for this page.
  }
  memory = next;
  return next;
}

/** Tests: forget the in-memory fallback. */
export function __resetRecentEmojiForTests(): void {
  memory = null;
}
