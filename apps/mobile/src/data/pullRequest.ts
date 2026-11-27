/**
 * A pull request on the phone (AP-712): the branch room's pane and its Files changed as one screen — title, state,
 * branch, CHECKS, REVIEWERS, FILES CHANGED (+/− with the minus sign) and Merge into main, with the web's rules
 * (`mergeButton`: the server's `mergeBlock` says who may and when; the note says how agents merge where they may hold
 * the Merge key) — and the file view's lines. Pure.
 */
import { type MergeButtonView, mergeButton, mergeNoteWithKeys } from '@whombat/client';
import {
  type Check,
  formatAdditions,
  formatDeletions,
  formatDiffStat,
  mergeNote,
  PR_STATUS_TONES,
  type PrFileLine,
  type Principal,
  type PullRequestDetail,
  prStatusLabels,
  REVIEW_STATE_TONES,
  reviewStateLabels,
  type Tone,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

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

function checkRow(c: Check, locale?: string): PrCheckRow {
  const passed = c.state === 'passed' || c.state === 'skipped';
  const state = mobileTranslator(locale).t(`data.pullRequest.check.${c.state}`);
  return {
    name: c.name,
    note: c.note,
    passed,
    accessibilityLabel: `${c.name}, ${state}${c.note ? `, ${c.note}` : ''}`,
  };
}

export function pullRequestModel(
  detail: PullRequestDetail,
  opts: {
    lookup: (id: string) => Principal | undefined;
    agentsMayMerge: boolean;
    /** The agent by its name, for the merge note (core's `mergeNote(name)`, AP-4999). */
    agent: string;
    locale?: string;
  },
): PullRequestModel {
  const { pr } = detail;
  const locale = opts.locale;
  const { t, tp } = mobileTranslator(locale);
  const reviewStates = reviewStateLabels(locale);
  return {
    title: pr.title,
    label: `${pr.repoFullName ? `${pr.repoFullName} · ` : ''}PR #${pr.number}`,
    status: { text: prStatusLabels(locale)[detail.status], tone: PR_STATUS_TONES[detail.status] },
    branch: `${pr.branch} → ${pr.baseBranch}`,
    diff: formatDiffStat({ add: pr.diff.add, del: pr.diff.del, files: pr.files.length }, locale),
    checks: pr.checks.map((c) => checkRow(c, locale)),
    reviewers: pr.reviewers.map((r) => ({
      id: r.principalId,
      name: opts.lookup(r.principalId)?.name ?? t('data.approval.someone'),
      state: reviewStates[r.state],
      tone: REVIEW_STATE_TONES[r.state],
    })),
    files: pr.files.map((f) => ({
      path: f.path,
      add: formatAdditions(f.add),
      del: formatDeletions(f.del),
      accessibilityLabel: tp('data.pullRequest.fileLines', f.add, { path: f.path, removed: f.del }),
    })),
    merge: mergeButton(detail, locale),
    mergeNote: opts.agentsMayMerge ? mergeNoteWithKeys(locale) : mergeNote(opts.agent, locale),
  };
}

/** “Merge PR #12 into main?”: the phone asks first, a tap in a list is easily made (AP-712). */
export function mergeConfirm(
  detail: Pick<PullRequestDetail, 'pr'>,
  locale?: string,
): { title: string; body: string } {
  const { t } = mobileTranslator(locale);
  const { number, branch, baseBranch } = detail.pr;
  return {
    title: t('data.pullRequest.mergeTitle', { number, base: baseBranch }),
    body: t('data.pullRequest.mergeBody', { branch, base: baseBranch }),
  };
}

/** The mark before a line (`+`, `−`, a space) and what TalkBack says before it. */
export const LINE_MARKS: Record<PrFileLine['kind'], string> = { context: ' ', add: '+', del: '−' };

export function lineKindLabels(locale?: string): Record<PrFileLine['kind'], string | null> {
  const { t } = mobileTranslator(locale);
  return { context: null, add: t('data.pullRequest.added'), del: t('data.pullRequest.removed') };
}

export const LINE_KIND_LABELS: Record<PrFileLine['kind'], string | null> = lineKindLabels();

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
