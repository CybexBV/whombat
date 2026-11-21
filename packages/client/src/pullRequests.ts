/**
 * A pull request on the web's branch room and the phone's pull request screen (TODO 10.2–10.3; AP-664, AP-712): Merge
 * into main — the button, why it is off, the note under it and what a refused merge says — and the file view's
 * changes and neighbours. The rules (PR status, merge blocks, who may merge) are the server's and `@whombat/core`'s;
 * this only arranges them. Pure, no DOM and no React Native.
 */
import type { FileChange, MergeBlock, PrFileLine, PullRequestDetail } from '@whombat/core';
import { ApiError } from './http/errors';
import type { CommitResult } from './http/types';

/* MERGE ------------------------------------------------------------------------------------------- */

/**
 * The note under Merge into main on a Whombat where agents can be given Merge (`keys.merge_deploy`, MDS-02; AP-611):
 * the mock's `MERGE_NOTE` (“Merging is for people. Agents in this burrow don’t hold a merge key.”) is no longer always
 * true there, and the branch room can't see the agents' keys, so it says what holds instead.
 */
export const MERGE_NOTE_WITH_KEYS =
  'Your agent merges only with the Merge key. On Ask, a person approves each merge first.';

/** Why the button is off, for its description (the server's 409 says the same). */
export const MERGE_BLOCK_HINTS: Record<NonNullable<MergeBlock>, string> = {
  agent: 'Merging is for people.',
  not_open: 'This pull request isn’t open.',
  checks: 'Checks have to pass before this can be merged.',
  review: 'It needs an approving review, with no changes requested, before it can be merged.',
};

export interface MergeButtonView {
  label: 'Merge into main' | 'Merged into main';
  /** `ready` = primary (btn), `blocked` = sf2 + mut + not-allowed, `merged` = sf2 + ok + default. */
  look: 'ready' | 'blocked' | 'merged';
  canMerge: boolean;
  /** Why it is blocked, or null. */
  hint: string | null;
}

export function mergeButton(detail: Pick<PullRequestDetail, 'pr' | 'mergeBlock'>): MergeButtonView {
  if (detail.pr.state === 'merged') {
    return { label: 'Merged into main', look: 'merged', canMerge: false, hint: null };
  }
  if (detail.mergeBlock === null) {
    return { label: 'Merge into main', look: 'ready', canMerge: true, hint: null };
  }
  return {
    label: 'Merge into main',
    look: 'blocked',
    canMerge: false,
    hint: MERGE_BLOCK_HINTS[detail.mergeBlock],
  };
}

/** What a merge that didn't go through says (the branch room's words): null when it merged. */
export function mergeOutcomeText(result: CommitResult<unknown>): string | null {
  switch (result.status) {
    case 'ok':
      return null;
    case 'blocked':
      return `Blocked: merging needs the “${result.keyNeeded.label}” key.`;
    case 'pending_approval':
      return 'That needs a person to approve it first. We’ve asked.';
  }
}

/** What a merge that failed says: the server's own sentence, else a generic one. */
export function mergeErrorText(error: unknown): string {
  return error instanceof ApiError && error.message
    ? error.message
    : 'Couldn’t merge. Try again in a moment.';
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
