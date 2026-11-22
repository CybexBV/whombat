/**
 * Where a customer's report can't go on by itself (report-trackers.md TA-61): a run that set out to fix their bug
 * and ended without the merge, or a run that ended before the customer was answered. The run's end says why in its
 * thread (a failed run's own notice already does) and puts it in the person's Inbox, once per run — the one point in the
 * flow that waits for them.
 */
import type { AutomationStep, JsonObject } from '@whombat/core';
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { outsidersRun } from '../automations/runs';
import { type AutomationRunRow, type AutomationStepRow, loadStepRows } from '../automations/store';
import { loadBurrowRow } from '../commit/pipeline';
import type { ApplyContext } from '../commit/types';
import { automationRunSteps, automationRuns, automations, messages, notifications } from '../db/schema/index';
import { linkOfMessage } from '../domain/links';
import { postMessage } from '../domain/messages';
import { notify } from '../domain/notify';
import { threadPushGroup } from '../domain/push-preview';
import { thePerson } from '../domain/the-person';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import type { Services } from '../services';
import { scopeReport } from './items';

type Row = Pick<AutomationStepRow, 'stepId' | 'state' | 'error' | 'output' | 'startedAt'>;

/**
 * The verdict at the start of a review's reply, with the commit it may name (“Changes needed (reviewed 15cb03fe9).”):
 * the person's notice says why in words, without a commit hash.
 */
const VERDICT_LEAD = /^Changes needed[\s:—–-]*(?:\(?\s*reviewed\s+[0-9a-f]{7,40}\s*\)?[\s.:;—–-]*)?/i;

/** A step's own words in a sentence: its error, else the first line of what its agent said. */
function firstLine(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const line = text
    .split('\n')
    .map((l) => l.replace(/^[\s>*_#`-]+/, '').trim())
    .find(Boolean);
  if (!line) return null;
  const cut = line.length > 200 ? `${line.slice(0, 199)}…` : line;
  return /[.!?…]$/.test(cut) ? cut : `${cut}.`;
}

/**
 * Why a tracker run's report needs the person, in a sentence, or null when it doesn't: the fix that started and didn't
 * land (it couldn't be made or didn't finish, no review approved it, the pull request wasn't opened or merged), or a
 * run that failed before the customer heard anything. Pure: the definition's steps and the run's rows.
 */
export function unlandedReason(
  steps: readonly AutomationStep[],
  rows: readonly Row[],
  status: 'succeeded' | 'failed',
): { reason: string; fix: boolean } | null {
  const row = (id: string) => rows.find((r) => r.stepId === id);
  const fix = row('fix');
  const started = !!fix && (fix.startedAt !== null || !['pending', 'skipped'].includes(fix.state));
  if (steps.find((s) => s.id === 'fix')?.kind !== 'dispatch_agent' || !fix || !started) {
    // No fix was tried: only a run that ended before the customer was answered needs anyone.
    const reply = row('reply');
    if ((reply?.output as JsonObject | undefined)?.sent === true) return null;
    if (status === 'succeeded') {
      // It finished, but the turn the reply comes from reported no assessment, so the customer heard nothing (an empty
      // reply the agent chose needs nobody).
      const replyStep = steps.find((s) => s.id === 'reply');
      const from = replyStep?.kind === 'tracker_reply' ? row(replyStep.from) : undefined;
      return reply && (from?.output as JsonObject | undefined)?.unassessed === true
        ? { reason: 'Its assessment was never reported, so the customer wasn’t answered.', fix: false }
        : null;
    }
    const failed = rows.find((r) => r.state === 'failed' || r.state === 'blocked');
    return { reason: firstLine(failed?.error) ?? 'It stopped before the customer was answered.', fix: false };
  }
  const last =
    steps.find((s) => s.kind === 'merge_pull_request') ?? steps.find((s) => s.kind === 'open_pull_request');
  const end = last ? row(last.id) : undefined;
  if (
    end?.state === 'succeeded' &&
    (last?.kind === 'merge_pull_request' || (end.output as JsonObject).opened)
  )
    return null;
  const said = (r: Row | undefined, fallback: string) => ({
    reason: firstLine(r?.error) ?? fallback,
    fix: true,
  });
  if (fix.state === 'failed') return said(fix, 'The fix couldn’t be made.');
  if (fix.state === 'blocked') return said(fix, 'The fix couldn’t start.');
  if (fix.state !== 'succeeded') return { reason: 'The fix didn’t finish in time.', fix: true };
  const review = row('review');
  const output = (review?.output ?? {}) as { verdict?: unknown; unbound?: unknown; reply?: unknown };
  if (review?.state === 'failed' || review?.state === 'blocked')
    return said(review, 'Its review couldn’t be read.');
  if (review && review.state !== 'succeeded' && review.state !== 'skipped')
    return { reason: 'Its review didn’t finish in time.', fix: true };
  if (output.verdict === 'changes_needed')
    return {
      reason:
        typeof output.unbound === 'string'
          ? output.unbound
          : firstLine(output.reply)?.replace(VERDICT_LEAD, '') || 'No review approved the fix.',
      fix: true,
    };
  const pr = row('pr');
  if (pr && pr.state !== 'succeeded') return said(pr, 'Its pull request wasn’t opened.');
  // Prepared for a person instead of opened (its commits name the customer's organization, a key that asks): why.
  const prOut = (pr?.output ?? {}) as { opened?: unknown; reason?: unknown };
  if (pr && prOut.opened === false && typeof prOut.reason === 'string' && prOut.reason)
    return {
      reason: `Its pull request wasn’t opened: ${prOut.reason.replace(/[.\s]+$/, '')}, so it waits for you to open it.`,
      fix: true,
    };
  if (end?.state === 'failed' || end?.state === 'blocked') return said(end, 'It wasn’t merged.');
  return { reason: 'It wasn’t merged.', fix: true };
}

/**
 * At a finished run's end: when its report needs the person (`unlandedReason`), one line in its thread as the
 * automation — unless the run failed, whose own notice already says why — and the person's Inbox (`needs_you`, once
 * per run). The customer is mentioned only when the run's reply reached them. Not for a run a person stopped, nor a
 * test run (nobody told a customer).
 */
export async function noticeUnlandedFix(
  ctx: ApplyContext,
  run: AutomationRunRow,
  rows: readonly AutomationStepRow[],
  status: 'succeeded' | 'failed' | 'cancelled' | 'needs_review',
): Promise<void> {
  if (status !== 'succeeded' && status !== 'failed') return;
  const text = unlandedText(run, rows, status);
  if (!text || !run.threadRootId) return;
  const conversation = await loadConversationRow(ctx.tx, run.conversationId);
  if (!conversation || conversation.burrowId !== run.burrowId) return;
  // A failed run's own notice is in its thread already: the Inbox points at the thread, not a second line.
  const posted =
    status === 'succeeded'
      ? await postMessage(ctx, {
          conversation,
          text,
          threadRootId: run.threadRootId,
          mentions: [],
          dispatch: false,
          // The person hears through the notification below, once.
          notifyDmPerson: false,
          outsidersRun: outsidersRun(run.trigger),
        })
      : null;
  const { services } = ctx;
  const messageId = posted?.id ?? run.threadRootId;
  const at = ctx.now;
  // After the commit; a notification lost there (a restart, a failed write) is sent by the sweep (`resendUnlanded`).
  ctx.after(() => sendUnlanded(services, run, text, messageId, at));
}

/** The words of a run's needs-you notice (`unlandedReason`), or null when it needs nobody. */
function unlandedText(
  run: AutomationRunRow,
  rows: readonly Row[],
  status: 'succeeded' | 'failed',
): string | null {
  const report = scopeReport(run.scope);
  if (!report || run.test) return null;
  const found = unlandedReason(run.definition.steps, rows, status);
  if (!found) return null;
  const told = (rows.find((r) => r.stepId === 'reply')?.output as JsonObject | undefined)?.sent === true;
  const what = found.fix
    ? `The fix for ${report.connection} #${report.number} didn’t land: ${found.reason}`
    : `${report.connection} #${report.number} wasn’t finished: ${found.reason}`;
  return `${what}${told ? ' The customer was told it’s being looked into, so it needs you.' : ' It needs you.'}`;
}

const dedupOf = (runId: string) => `tracker_unlanded:${runId}`;

/** The person's Inbox item for a run (`needs_you`, its key once per run), pointing at `messageId` in its thread. */
async function sendUnlanded(
  services: Services,
  run: AutomationRunRow,
  text: string,
  messageId: string,
  at: Date,
): Promise<void> {
  const report = scopeReport(run.scope);
  const [burrow, person, conversation, message] = await Promise.all([
    loadBurrowRow(services.db, run.burrowId),
    thePerson(services.db, run.burrowId),
    loadConversationRow(services.db, run.conversationId),
    loadMessageRow(services.db, messageId),
  ]);
  if (!burrow || !person || !conversation || !message || !report) return;
  const [automation] = await services.db
    .select({ principalId: automations.principalId })
    .from(automations)
    .where(eq(automations.id, run.automationId));
  await notify(services, [
    {
      burrowId: burrow.id,
      burrowSlug: burrow.slug,
      principalId: person.id,
      kind: 'needs_you',
      actorId: automation?.principalId ?? run.automationId,
      where: report.connection,
      text: text.slice(0, 280),
      link: await linkOfMessage(services.db, conversation, message.id, message.threadRootId),
      messageId: message.id,
      createdAt: at,
      dedupKey: dedupOf(run.id),
      group: threadPushGroup(conversation.id, message.threadRootId),
    },
  ]);
}

/** How far back the sweep looks for a finished tracker run whose notice may have been lost. */
const RESEND_WITHIN_MS = 2 * 24 * 60 * 60_000;
const RESEND_PAGE = 50;
const RESEND_PAGES = 20;

/**
 * The sweep behind the run's end (TA-61): a real tracker run that finished in the last two days, needs the person and
 * has no Inbox item with its key gets it now — after a restart or a failed write right after the run ended. Its key
 * keeps it once. Answers how many it sent.
 */
export async function resendUnlanded(services: Services, pageSize = RESEND_PAGE): Promise<number> {
  const now = services.clock();
  let sent = 0;
  let after: { at: Date; id: string } | null = null;
  // Only runs that may need it — failed, a fix that started and no merge that succeeded, or a turn that reported no
  // assessment — and page through them all, so finished runs that need nothing never crowd one out (TA-61).
  for (let page = 0; page < RESEND_PAGES; page++) {
    const runs: (typeof automationRuns.$inferSelect)[] = await services.db
      .select()
      .from(automationRuns)
      .where(
        and(
          inArray(automationRuns.status, ['succeeded', 'failed']),
          eq(automationRuns.test, false),
          sql`${automationRuns.scope}->>'kind' = 'tracker'`,
          gt(automationRuns.finishedAt, new Date(now.getTime() - RESEND_WITHIN_MS)),
          lt(automationRuns.finishedAt, new Date(now.getTime() - 60_000)),
          isNotNull(automationRuns.threadRootId),
          sql`not exists (select 1 from ${notifications} where ${notifications.dedupKey} = 'tracker_unlanded:' || ${automationRuns.id})`,
          sql`(${automationRuns.status} = 'failed' or (
            exists (select 1 from ${automationRunSteps} s where s.run_id = ${automationRuns.id} and s.step_id = 'fix'
              and s.started_at is not null)
            and not exists (select 1 from ${automationRunSteps} s where s.run_id = ${automationRuns.id}
              and s.step_id = 'merge' and s.state = 'succeeded'))
            or exists (select 1 from ${automationRunSteps} s where s.run_id = ${automationRuns.id}
              and s.output->>'unassessed' = 'true'))`,
          after
            ? sql`(${automationRuns.finishedAt}, ${automationRuns.id}) < (${after.at.toISOString()}::timestamptz, ${after.id})`
            : undefined,
        ),
      )
      .orderBy(desc(automationRuns.finishedAt), desc(automationRuns.id))
      .limit(pageSize);
    for (const run of runs) {
      const status = run.status === 'failed' ? 'failed' : 'succeeded';
      const text = unlandedText(run, await loadStepRows(services.db, run.id), status);
      if (!text || !run.threadRootId) continue;
      // The thread's line, when the run posted one, else its root.
      const [line] = await services.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.threadRootId, run.threadRootId), eq(messages.text, text)))
        .limit(1);
      await sendUnlanded(services, run, text, line?.id ?? run.threadRootId, now);
      sent++;
    }
    const last = runs.at(-1);
    if (runs.length < pageSize || !last?.finishedAt) break;
    after = { at: last.finishedAt, id: last.id };
  }
  return sent;
}
