/**
 * The person's prompts on web and the phone (Whombat docs/decisions/prompts.md): the words both apps show, which
 * prompts `/` offers for what was typed, the projects a prompt can run on in the order the picker lists them, and how
 * long ago it ran there.
 */
import type { Prompt, PromptProject } from '@whombat/core';

export const PROMPT_WORDS = {
  /** The group's label in the `/` menu, above the skills. */
  group: 'PROMPTS',
  title: 'Prompts',
  intro: 'Words you use again and again. Type / in Chat to use one.',
  add: 'New prompt',
  edit: 'Edit prompt',
  fieldTitle: 'Title',
  fieldText: 'Prompt',
  onRepository: 'For a repository',
  onRepositoryHint: 'Asks which repository, then starts the work there in T3 Code.',
  ownIt: 'Let it reshape the code',
  ownItHint:
    'Tells the AI the code is its own to restructure. It merges duplicates more often, uses more of your plan and sometimes changes behaviour you didn’t ask about.',
  merge: 'Merge into main when it’s done',
  mergeHint:
    'Opens a pull request and merges it into the main branch once its checks pass. If they fail, it leaves it for you.',
  ai: 'AI',
  aiDefault: 'T3 Code’s default',
  save: 'Save',
  cancel: 'Cancel',
  remove: 'Remove',
  removeAsk: (title: string) => `Remove “${title}”?`,
  restore: 'Bring back Whombat’s prompts',
  restoreHint: 'The ones you removed come back and the ones you changed get their words back. Your own stay.',
  empty: 'No prompts yet.',
  saveFromMessage: 'Save as prompt',
  saved: 'Saved to your prompts',
  failed: 'Couldn’t save it. Try again.',
  /** The picker after a repository prompt was chosen. */
  pickTitle: 'Which repository?',
  pickSearch: 'Find a repository',
  pickEmpty: 'T3 Code has no projects yet.',
  pickNone: 'No repository by that name.',
  pickLoading: 'Asking T3 Code for its projects…',
  /** When the projects can't be listed: the prompt's words go into the message instead. */
  pickInstead: 'Put its words in the message',
  t3: {
    not_connected: 'Connect T3 Code with Manage to run a prompt on a repository.',
    unreachable: 'T3 Code can’t be reached now.',
  },
  useFailed: 'Couldn’t start it. Try again.',
} as const;

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** “Ran today”, “Ran yesterday”, “Ran 3 days ago”, then “Ran on 10 Nov” (by the viewer's own days). */
export function promptRanWord(at: string, now: Date = new Date()): string {
  const then = new Date(at);
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayOf(now) - dayOf(then)) / 86_400_000);
  if (days <= 0) return 'Ran today';
  if (days === 1) return 'Ran yesterday';
  if (days < 14) return `Ran ${days} days ago`;
  const year = then.getFullYear() === now.getFullYear() ? '' : ` ${then.getFullYear()}`;
  return `Ran on ${then.getDate()} ${MONTHS[then.getMonth()]}${year}`;
}
