/**
 * A pull request on the web's branch room and the phone's pull request screen (TODO 10.2–10.3; AP-664, AP-712): Merge
 * into main — the button, why it is off, the note under it and what a refused merge says — and the file view's
 * changes and neighbours. The rules (PR status, merge blocks, who may merge) are the server's and `@whombat/core`'s;
 * this only arranges them. Pure, no DOM and no React Native.
 */
import type { FileChange, MergeBlock, PrFileLine, PullRequestDetail } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { ApiError } from './http/errors';
import type { CommitResult } from './http/types';
import { clientTree } from './i18n/catalog';
import { ASKS_AREA_WORDS } from './i18n/messages/chatWork/asks';

const words = (locale?: string | null) => clientTree(locale, ASKS_AREA_WORDS).pullRequests;

/* MERGE ------------------------------------------------------------------------------------------- */

/**
 * The note under Merge into main on a Whombat where agents can be given Merge (`keys.merge_deploy`, MDS-02; AP-611):
 * the mock's `MERGE_NOTE` (“Merging is for people. Agents in this burrow don’t hold a merge key.”) is no longer always
 * true there, and the branch room can't see the agents' keys, so it says what holds instead.
 */
export function mergeNoteWithKeys(locale?: string | null): string {
  return words(locale).mergeNoteWithKeys;
}

export const MERGE_NOTE_WITH_KEYS = mergeNoteWithKeys();

/** Why the button is off, for its description (the server's 409 says the same), in a locale. */
export function mergeBlockHints(locale?: string | null): Record<NonNullable<MergeBlock>, string> {
  const b = words(locale).blocks;
  return { agent: b.agent, not_open: b.not_open, checks: b.checks, review: b.review };
}

/** Why the button is off, for its description (the server's 409 says the same). */
export const MERGE_BLOCK_HINTS: Record<NonNullable<MergeBlock>, string> = mergeBlockHints();

export interface MergeButtonView {
  /** “Merge into main”, “Merged into main”. */
  label: string;
  /** `ready` = primary (btn), `blocked` = sf2 + mut + not-allowed, `merged` = sf2 + ok + default. */
  look: 'ready' | 'blocked' | 'merged';
  canMerge: boolean;
  /** Why it is blocked, or null. */
  hint: string | null;
}

export function mergeButton(
  detail: Pick<PullRequestDetail, 'pr' | 'mergeBlock'>,
  locale?: string | null,
): MergeButtonView {
  const w = words(locale);
  if (detail.pr.state === 'merged') {
    return { label: w.merged, look: 'merged', canMerge: false, hint: null };
  }
  if (detail.mergeBlock === null) {
    return { label: w.merge, look: 'ready', canMerge: true, hint: null };
  }
  return {
    label: w.merge,
    look: 'blocked',
    canMerge: false,
    hint: mergeBlockHints(locale)[detail.mergeBlock],
  };
}

/** What a merge that didn't go through says (the branch room's words): null when it merged. */
export function mergeOutcomeText(result: CommitResult<unknown>, locale?: string | null): string | null {
  const w = words(locale);
  switch (result.status) {
    case 'ok':
      return null;
    case 'blocked':
      return interpolate(w.blocked, { key: result.keyNeeded.label });
    case 'pending_approval':
      return w.pending;
  }
}

/** What a merge that failed says: the server's own sentence, else a generic one. */
export function mergeErrorText(error: unknown, locale?: string | null): string {
  return error instanceof ApiError && error.message ? error.message : words(locale).failed;
}

/* THE FILE VIEW (AP-664) -------------------------------------------------------------------------- */

/** The index of the first line of every change (a run of removed and added lines). */
export function changeStarts(lines: readonly Pick<PrFileLine, 'kind'>[]): number[] {
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (line.kind !== 'context' && (i === 0 || lines[i - 1]?.kind === 'context')) starts.push(i);
  });
  return starts;
}

/** Digits of the largest line number, at least 2 (the gutter's width in `ch`). */
export function gutterDigits(lines: readonly Pick<PrFileLine, 'old' | 'new'>[]): number {
  let max = 0;
  for (const l of lines) max = Math.max(max, l.old ?? 0, l.new ?? 0);
  return Math.max(2, String(max).length);
}

/** The files before and after `path` in Files changed. */
export function neighbours(
  files: readonly Pick<FileChange, 'path'>[],
  path: string,
): { previous: string | null; next: string | null } {
  const i = files.findIndex((f) => f.path === path);
  if (i < 0) return { previous: null, next: null };
  return { previous: files[i - 1]?.path ?? null, next: files[i + 1]?.path ?? null };
}
