/**
 * How things in an opened backup are named in the list (backup-look.md): a thread by its first line, a chat by its title,
 * a Vault entry by what it is, a search's words. Pure.
 */
import type { VaultEntryKind } from '@whombat/core';

/** Longest title an item carries. */
export const LOOK_TITLE_MAX = 120;

/** The first non-empty line of a message, Markdown marks dropped and cut short: what a thread is called in a list. */
export function threadTitleOf(text: string, subject: string | null = null): string {
  const line =
    text
      .split('\n')
      .map((l) =>
        l
          .replace(/^[#>*\-\s]+/, '')
          .replace(/[*_`]/g, '')
          .trim(),
      )
      .find((l) => l.length > 0) ?? '';
  return clip(line || subject || 'A thread without words');
}

/** A title cut to `LOOK_TITLE_MAX` characters, with an ellipsis when it was longer. */
export function clip(text: string, max = LOOK_TITLE_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** The words of a search: lower case, at least two letters each, at most eight. */
export function searchWords(query: string | undefined | null): string[] {
  return (query ?? '')
    .toLowerCase()
    .split(/[\s,;.!?“”"'’]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 8);
}

/** A word as an `ILIKE` pattern that matches it anywhere (its own `%`, `_` and `\` taken literally). */
export function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** What kind of thing a Vault entry is, as people say it. */
export function vaultKindWords(kind: VaultEntryKind | string): string {
  switch (kind) {
    case 'login':
      return 'A website sign-in';
    case 'ssh':
      return 'An SSH key';
    case 'secret':
      return 'A secret';
    case 'mcp':
    case 'http':
      return 'A service’s key';
    default:
      return 'In the Vault';
  }
}

/** “1 message”, “12 messages”. */
export function messagesWords(n: number): string {
  return n === 1 ? '1 message' : `${n} messages`;
}

/** “1 reply”, “4 replies”. */
export function repliesWords(n: number): string {
  return n === 1 ? '1 reply' : `${n} replies`;
}
