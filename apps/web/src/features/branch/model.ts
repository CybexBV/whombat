/**
 * Pure view logic for the branch room (TODO 10.2–10.3): the header chip, the CHECKS and REVIEWERS
 * rows, the files table bars and the Merge into main button. The rules (PR status, merge blocks,
 * approval phases) live in `@whombat/core`; this only arranges them for the components.
 */
import {
  type ApprovalView,
  approvalView,
  type Check,
  type Decider,
  diffBarScale,
  diffBarWidths,
  type FileChange,
  formatAdditions,
  formatDeletions,
  PR_STATUS_LABELS,
  PR_STATUS_TONES,
  type Principal,
  type PrStatus,
  type PullRequestDetail,
  REVIEW_STATE_LABELS,
  REVIEW_STATE_TONES,
  type Reviewer,
  shortNameOf,
  type Tone,
} from '@whombat/core';
import type { DotTone } from '../../components/StatusDot';

export type PrincipalLookup = (id: string) => Principal | undefined;

const TONE_TO_DOT: Record<Tone, DotTone> = { ok: 'ok', warn: 'warn', bad: 'bad', neutral: 'mut' };

export function toneToDot(tone: Tone): DotTone {
  return TONE_TO_DOT[tone];
}

/** Header chip: "Open · changes requested" → "Open · ready" → "Merged", with the sidebar's dot tone. */
export function prStatusChip(status: PrStatus): { label: string; tone: DotTone } {
  return { label: PR_STATUS_LABELS[status], tone: toneToDot(PR_STATUS_TONES[status]) };
}

/* CHECKS ------------------------------------------------------------------------------------------ */

export interface CheckRow {
  name: string;
  note: string;
  /**
   * Marker, as in the mock: a filled ok circle when passed (or skipped), otherwise a warn ring —
   * failing checks included; the note ("38/41") and the state label say the rest.
   */
  mark: 'passed' | 'pending';
  /** Screen-reader state ("passed", "queued"). */
  stateLabel: string;
}

export function checkRows(checks: readonly Check[]): CheckRow[] {
  return checks.map((c) => ({
    name: c.name,
    note: c.note,
    mark: c.state === 'passed' || c.state === 'skipped' ? 'passed' : 'pending',
    stateLabel: c.state,
  }));
}

/* REVIEWERS --------------------------------------------------------------------------------------- */

export interface ReviewerRow {
  principal: Principal | undefined;
  /** "Waffle", "Mara Okafor" (agents by name, people by full name, as in the mock). */
  name: string;
  /** "Changes requested", "Approved", "Pending". */
  state: string;
  tone: DotTone;
}

export function reviewerRows(reviewers: readonly Reviewer[], lookup: PrincipalLookup): ReviewerRow[] {
  return reviewers.map((r) => {
    const p = lookup(r.principalId);
    return {
      principal: p,
      name: p?.name ?? 'Someone',
      state: REVIEW_STATE_LABELS[r.state],
      tone: toneToDot(REVIEW_STATE_TONES[r.state]),
    };
  });
}

/* STAGING ----------------------------------------------------------------------------------------- */

export interface StagingView {
  /** "Neo is waiting for a person to approve the staging deploy." */
  summary: string;
  /** Approval number for `?approval=`; the "Review deploy" button shows only while nobody decided. */
  number: number;
  showReview: boolean;
  /** "Review deploy" (deploys) or "Review request". */
  reviewLabel: string;
}

export function stagingView(
  detail: Pick<PullRequestDetail, 'staging'>,
  ctx: { lookup: PrincipalLookup; viewer?: Decider; now: Date | number; timeZone: string },
): StagingView | null {
  const approval = detail.staging;
  if (!approval) return null;
  const view: ApprovalView = approvalView(approval, {
    names: (id) => {
      const p = ctx.lookup(id);
      return p ? { name: p.name, shortName: shortNameOf(p) } : undefined;
    },
    viewer: ctx.viewer,
    now: ctx.now,
    timeZone: ctx.timeZone,
  });
  return {
    summary: view.short,
    number: approval.number,
    showReview: view.phase === 'needs_person',
    reviewLabel: approval.action.type === 'deploy' ? 'Review deploy' : 'Review request',
  };
}

/* MERGE ------------------------------------------------------------------------------------------- */

/** Merge into main: shared with the phone's pull request screen (`@whombat/client`, AP-712). */
export {
  MERGE_BLOCK_HINTS,
  MERGE_NOTE_WITH_KEYS,
  type MergeButtonView,
  mergeButton,
} from '@whombat/client';

/* FILES ------------------------------------------------------------------------------------------- */

export interface FileRow {
  path: string;
  add: string;
  del: string;
  addWidth: number;
  delWidth: number;
  /** "34 lines added, 9 removed" for the bar. */
  summary: string;
}

export function fileRows(files: readonly FileChange[]): FileRow[] {
  const scale = diffBarScale(files);
  return files.map((f) => {
    const w = diffBarWidths(f, scale);
    return {
      path: f.path,
      add: formatAdditions(f.add),
      del: formatDeletions(f.del),
      addWidth: w.add,
      delWidth: w.del,
      summary: `${f.add} ${f.add === 1 ? 'line' : 'lines'} added, ${f.del} removed`,
    };
  });
}
