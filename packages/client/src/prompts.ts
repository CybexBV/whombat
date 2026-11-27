/**
 * The person's prompts on web and the phone (Whombat docs/decisions/prompts.md): the words both apps show, which
 * prompts `/` offers for what was typed, the projects a prompt can run on in the order the picker lists them, and how
 * long ago it ran there.
 */
import type { Prompt, PromptProject } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from './i18n/catalog';
import { ASKS_AREA_WORDS } from './i18n/messages/chatWork/asks';

/** The prompts' words, in a locale (English when none). */
export function promptWords(locale?: string | null) {
  const w = clientTree(locale, ASKS_AREA_WORDS).prompts;
  return {
    /** The group's label in the `/` menu, above the skills. */
    group: w.group,
    title: w.title,
    intro: w.intro,
    add: w.add,
    edit: w.edit,
    fieldTitle: w.fieldTitle,
    fieldText: w.fieldText,
    onRepository: w.onRepository,
    onRepositoryHint: w.onRepositoryHint,
    ownIt: w.ownIt,
    ownItHint: w.ownItHint,
    merge: w.merge,
    mergeHint: w.mergeHint,
    ai: w.ai,
    aiDefault: w.aiDefault,
    save: w.save,
    cancel: w.cancel,
    remove: w.remove,
    removeAsk: (title: string) => interpolate(w.removeAsk, { title }),
    restore: w.restore,
    restoreHint: w.restoreHint,
    empty: w.empty,
    saveFromMessage: w.saveFromMessage,
    saved: w.saved,
    failed: w.failed,
    /** The picker after a repository prompt was chosen. */
    pickTitle: w.pickTitle,
    pickSearch: w.pickSearch,
    pickEmpty: w.pickEmpty,
    pickNone: w.pickNone,
    pickLoading: w.pickLoading,
    /** When the projects can't be listed: the prompt's words go into the message instead. */
    pickInstead: w.pickInstead,
    t3: { not_connected: w.t3.not_connected, unreachable: w.t3.unreachable },
    useFailed: w.useFailed,
  };
}

/** The prompts' words, in English. */
export const PROMPT_WORDS = promptWords();

/** A title as `/` matches it: lower case, words joined by dashes (“Find what’s broken” → `find-whats-broken`). */
export function promptSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The prompts `/` offers for what was typed after it, in the list's order: all of them for nothing typed, else those
 * with a word of the title that starts with it (`/te` finds “Prune the tests”).
 */
export function promptsFor<P extends Pick<Prompt, 'title'>>(prompts: readonly P[], query = ''): P[] {
  const q = promptSlug(query);
  if (!q) return [...prompts];
  return prompts.filter((p) => {
    const slug = promptSlug(p.title);
    return slug.startsWith(q) || slug.includes(`-${q}`);
  });
}

/** A prompt's first line, short enough for a menu row. */
export function promptPreview(text: string, max = 90): string {
  const first = text.trim().split('\n')[0] ?? '';
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`;
}

export interface PromptProjectRow extends PromptProject {
  /** When this prompt last ran on it; null: never. */
  ranAt: string | null;
}

/**
 * The picker's rows: the projects this prompt ran on first, the latest at the top, then the others by title; `search`
 * keeps those whose title or folder has it.
 */
export function promptProjectRows(
  prompt: Pick<Prompt, 'runs'> | null | undefined,
  projects: readonly PromptProject[],
  search = '',
): PromptProjectRow[] {
  const ran = new Map((prompt?.runs ?? []).map((r) => [r.projectId, r.at] as const));
  const q = search.trim().toLowerCase();
  return projects
    .filter((p) => !q || p.title.toLowerCase().includes(q) || (p.folder ?? '').toLowerCase().includes(q))
    .map((p) => ({ ...p, ranAt: ran.get(p.id) ?? null }))
    .sort((a, b) => {
      if (a.ranAt && b.ranAt) return a.ranAt < b.ranAt ? 1 : a.ranAt > b.ranAt ? -1 : 0;
      if (a.ranAt) return -1;
      if (b.ranAt) return 1;
      return a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
    });
}

/** “Ran today”, “Ran yesterday”, “Ran 3 days ago”, then “Ran on 10 Nov” (by the viewer's own days). */
export function promptRanWord(at: string, now: Date = new Date(), locale?: string | null): string {
  const w = clientTree(locale, ASKS_AREA_WORDS).prompts;
  const months = Object.values(w.months);
  const then = new Date(at);
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayOf(now) - dayOf(then)) / 86_400_000);
  if (days <= 0) return w.ranToday;
  if (days === 1) return w.ranYesterday;
  if (days < 14) return interpolate(w.ranDaysAgo, { days });
  const year = then.getFullYear() === now.getFullYear() ? '' : ` ${then.getFullYear()}`;
  return interpolate(w.ranOn, { date: `${then.getDate()} ${months[then.getMonth()] ?? ''}${year}` });
}
