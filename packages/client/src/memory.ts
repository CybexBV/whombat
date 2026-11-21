/**
 * What the agent remembers, as people see and change it (Whombat hermes-engine.md HE-39; contracts 0.125 CT-1200…CT-1205;
 * app hermes-engine-app.md AP-5209…AP-5212): the same on the web (Settings → Profile) and the phone. Hermes keeps each
 * person's two files as entries; people change one entry at a time — edit it, remove it, add one — and the whole file is
 * written back with the version the change started from, so a change the agent made meanwhile is never lost. The words
 * are the contracts' (`MEMORY_COPY`, `NOTES_COPY`, `memoryUsageText`); these are the few the screens add around them.
 */
import {
  type MemoryFile,
  type MemoryFileView,
  memoryChars,
  memoryEntries,
  memoryFileText,
  memoryUsageText,
} from '@whombat/core/domain';
import { ApiError } from './http/errors';

/** The screens' own words around the contracts' (`MEMORY_COPY`). */
export const MEMORY_TEXT = {
  add: 'Add',
  remove: 'Remove',
  /** The add field's placeholder of each file. */
  placeholder: (file: MemoryFile, agent: string) =>
    file === 'memory'
      ? `Something ${agent} should remember about working with you`
      : `Something ${agent} should know about you`,
  saved: 'Saved.',
  removed: 'Removed.',
  failed: 'That didn’t work. Try again in a moment.',
  loadFailed: 'Couldn’t load this. Try again in a moment.',
  /** The agent's notes saved. */
  notesSaved: 'Saved. Every chat reads them from now on.',
} as const;

/** A file's entries (Hermes's own split). */
export function memoryFileEntries(view: Pick<MemoryFileView, 'text'>): string[] {
  return memoryEntries(view.text);
}

/** The file's text with one more entry at its end. */
export function memoryWithEntry(view: Pick<MemoryFileView, 'text'>, entry: string): string {
  return memoryFileText([...memoryEntries(view.text), entry.trim()]);
}

/** The file's text with entry `index` changed (an empty one removes it). */
export function memoryWithEdit(view: Pick<MemoryFileView, 'text'>, index: number, next: string): string {
  const entries = memoryEntries(view.text);
  const clean = next.trim();
  return memoryFileText(
    clean ? entries.map((e, i) => (i === index ? clean : e)) : entries.filter((_, i) => i !== index),
  );
}

/** The file's text without entry `index`. */
export function memoryWithout(view: Pick<MemoryFileView, 'text'>, index: number): string {
  return memoryFileText(memoryEntries(view.text).filter((_, i) => i !== index));
}

export type MemoryUsageTone = 'ok' | 'warn' | 'bad';

/** “1,240 of 2,200 characters”, how full the bar is (0…1) and its tone: amber from 90 %, red over the limit. */
export function memoryUsage(view: Pick<MemoryFileView, 'used' | 'limit'>): {
  text: string;
  fraction: number;
  tone: MemoryUsageTone;
} {
  const fraction = view.limit > 0 ? view.used / view.limit : 0;
  return {
    text: memoryUsageText(view.used, view.limit),
    fraction: Math.min(1, fraction),
    tone: fraction > 1 ? 'bad' : fraction >= 0.9 ? 'warn' : 'ok',
  };
}

/** Whether adding this entry would still fit the file. */
export function memoryEntryFits(view: Pick<MemoryFileView, 'text' | 'limit'>, entry: string): boolean {
  return memoryChars(memoryWithEntry(view, entry || 'x')) <= view.limit;
}

/**
 * What a refused write says (CT-1201): the agent changed the file meanwhile (`conflict` without a reason) is the
 * contracts' `changed` sentence; busy (a turn holds it), too long and the rest are the server's own words.
 */
export function memoryWriteProblem(error: unknown, changed: string): string {
  if (!(error instanceof ApiError)) return MEMORY_TEXT.failed;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  if (error.code === 'conflict' && reason !== 'busy') return changed;
  return error.message || MEMORY_TEXT.failed;
}
