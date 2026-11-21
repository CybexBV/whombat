/**
 * A pull request on the phone (AP-712): the branch room's pane and its Files changed as one screen — title, state,
 * branch, CHECKS, REVIEWERS, FILES CHANGED (+/− with the minus sign) and Merge into main, with the web's rules
 * (`mergeButton`: the server's `mergeBlock` says who may and when; the note says how agents merge where they may hold
 * the Merge key) — and the file view's lines. Pure.
 */
import { MERGE_NOTE_WITH_KEYS, type MergeButtonView, mergeButton } from '@whombat/client';
import {
  type Check,
  formatAdditions,
  formatDeletions,
  formatDiffStat,
  mergeNote,
  PR_STATUS_LABELS,
  PR_STATUS_TONES,
  type PrFileLine,
  type Principal,
  type PullRequestDetail,
  REVIEW_STATE_LABELS,
  REVIEW_STATE_TONES,
  type Tone,
} from '@whombat/core';

export interface PrCheckRow {
  name: string;
  note: string;
  /** A filled ok circle when passed (or skipped), otherwise a warn ring (the web's marker). */
  passed: boolean;
  accessibilityLabel: string;
}

export interface PrReviewerRow {
  id: string;
  name: string;
  state: string;
  tone: Tone;
}

export interface PrFileRow {
  path: string;
  add: string;
  del: string;
  accessibilityLabel: string;
}

export interface PullRequestModel {
  title: string;
  /** “acme/billing · PR #12” */
  label: string;
  status: { text: string; tone: Tone };
  /** `feat/invoice-pdf → main` */
  branch: string;
  /** `+214 −12 · 6 files` */
  diff: string;
  checks: PrCheckRow[];
  reviewers: PrReviewerRow[];
  files: PrFileRow[];
  merge: MergeButtonView;
  /** Under the button: the mock's “Merging is for people…”, or how agents merge where they may hold the key. */
  mergeNote: string;
}

function checkRow(c: Check): PrCheckRow {
  const passed = c.state === 'passed' || c.state === 'skipped';
  return {
    name: c.name,
    note: c.note,
    passed,
    accessibilityLabel: `${c.name}, ${c.state}${c.note ? `, ${c.note}` : ''}`,
  };
}

export function pullRequestModel(
  detail: PullRequestDetail,
  opts: {
    lookup: (id: string) => Principal | undefined;
    agentsMayMerge: boolean;
    /** The agent by its name, for the merge note (core's `mergeNote(name)`, AP-4999). */
    agent: string;
  },
): PullRequestModel {
  const { pr } = detail;
  return {
    title: pr.title,
    label: `${pr.repoFullName ? `${pr.repoFullName} · ` : ''}PR #${pr.number}`,
    status: { text: PR_STATUS_LABELS[detail.status], tone: PR_STATUS_TONES[detail.status] },
    branch: `${pr.branch} → ${pr.baseBranch}`,
    diff: formatDiffStat({ add: pr.diff.add, del: pr.diff.del, files: pr.files.length }),
    checks: pr.checks.map(checkRow),
    reviewers: pr.reviewers.map((r) => ({
      id: r.principalId,
      name: opts.lookup(r.principalId)?.name ?? 'Someone',
      state: REVIEW_STATE_LABELS[r.state],
      tone: REVIEW_STATE_TONES[r.state],
    })),
    files: pr.files.map((f) => ({
      path: f.path,
      add: formatAdditions(f.add),
      del: formatDeletions(f.del),
      accessibilityLabel: `${f.path}, ${f.add} ${f.add === 1 ? 'line' : 'lines'} added, ${f.del} removed`,
    })),
    merge: mergeButton(detail),
    mergeNote: opts.agentsMayMerge ? MERGE_NOTE_WITH_KEYS : mergeNote(opts.agent),
  };
}

/** “Merge PR #12 into main?”: the phone asks first, a tap in a list is easily made (AP-712). */
export function mergeConfirm(detail: Pick<PullRequestDetail, 'pr'>): { title: string; body: string } {
  return {
    title: `Merge PR #${detail.pr.number} into ${detail.pr.baseBranch}?`,
    body: `${detail.pr.branch} goes into ${detail.pr.baseBranch}. This can’t be undone from here.`,
  };
}

/** The mark before a line (`+`, `−`, a space) and what TalkBack says before it. */
export const LINE_MARKS: Record<PrFileLine['kind'], string> = { context: ' ', add: '+', del: '−' };
export const LINE_KIND_LABELS: Record<PrFileLine['kind'], string | null> = {
  context: null,
  add: 'Added',
  del: 'Removed',
};

/** The pull request a link that knows only its number (a run) opens: with its repository when one room has it. */
export function pullRequestTarget(
  rooms: readonly { prNumber: number | null; repo?: string }[],
  number: number,
  repoFullName?: string | null,
): { number: number; repo?: string } {
  if (repoFullName) return { number, repo: repoFullName };
  const same = rooms.filter((r) => r.prNumber === number);
  const repo = same.length === 1 ? same[0]?.repo : undefined;
  return repo ? { number, repo } : { number };
}
