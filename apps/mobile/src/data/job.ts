/**
 * The phone's rules for a job handed to T3 Code (docs/app/decisions/job-view.md AP-7886…AP-7899), on top of
 * `@whombat/client`'s `job.ts`: which hand-over a thread of Chat or Feedback shows as its job, which parts its panel
 * draws, and which moves of a job the app says in a toast while it is open (only needing the person, done and failed;
 * never a step). Pure.
 */
import {
  type JobNoticeKind,
  jobCanMessage,
  jobChanges,
  jobChecks,
  jobHandoffs,
  jobNotice,
  jobPlan,
  jobPullRequest,
  jobQuestion,
  jobReceipt,
} from '@whombat/client';
import type { Handoff } from '@whombat/core';

/** How many changed files the phone lists (the rest are counted). */
export const PHONE_FILES = 5;

/** The job a thread shows: its latest hand-over, ended ones too (their receipt). */
export const threadJob = (handoffs: readonly Handoff[], rootId: string): Handoff | null =>
  jobHandoffs(handoffs, rootId).at(-1) ?? null;

/** The panel's parts, in the order they show; empty when the box gave none (the panel then isn't drawn). */
export type JobPart = 'receipt' | 'question' | 'plan' | 'pullRequest' | 'changes' | 'checks' | 'message';

export function jobParts(h: Handoff): JobPart[] {
  const parts: JobPart[] = [];
  if (jobReceipt(h)) parts.push('receipt');
  if (jobQuestion(h)) parts.push('question');
  if (jobPlan(h)) parts.push('plan');
  if (jobPullRequest(h)) parts.push('pullRequest');
  if (jobChanges(h, PHONE_FILES)) parts.push('changes');
  if (jobChecks(h)) parts.push('checks');
  if (jobCanMessage(h)) parts.push('message');
  return parts;
}

/**
 * What the app says while it is open when jobs moved: one toast per job that started to need the person, finished or
 * failed since the last list, unless its thread is the one on screen. `seen`: each job's last state (by its id), kept by
 * the caller; the first list only fills it.
 */
export function jobToasts(
  seen: Map<string, Handoff>,
  handoffs: readonly Handoff[],
  onScreen: string | null,
  first: boolean,
): { kind: JobNoticeKind; text: string; rootId: string | null }[] {
  const out: { kind: JobNoticeKind; text: string; rootId: string | null }[] = [];
  for (const h of handoffs) {
    const before = seen.get(h.id);
    seen.set(h.id, h);
    if (first || !before || h.rootId === onScreen) continue;
    const notice = jobNotice(before, h);
    if (notice) out.push({ ...notice, rootId: h.rootId });
  }
  return out;
}
