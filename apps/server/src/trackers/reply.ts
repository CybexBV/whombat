/**
 * Replying to a tracker report's customer (docs/decisions/report-trackers.md TA-25…TA-28): what a `tracker_reply` step
 * would send for this run (`trackerReplyPlan`, also the approval guard's re-render) — step `from`'s assessment `reply`,
 * signed with that agent's name and role (“Dusty - AI Developer”), checked by `customerReplyProblem` against the
 * connection's address and the installation's other organizations —, the send itself in the engine's external pass
 * (`sendReply`: the report's status read just before, `trackerReplyStatus`'s status, the step's `request_id`, once more
 * after a 409), and the line the run's thread gets once it went (TA-27).
 */
import {
  type AutomationStep,
  customerReplyProblem,
  customerSignature,
  renderTemplate,
  signedReply,
  TRACKER_CLOSABLE_STATUSES,
  TrackerItemId,
  trackerReplyStatus,
  trackerStatusLabel,
} from '@whombat/core';
import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { reportedAssessment } from '../automations/assessment';
import type { Db, Tx } from '../db/client';
import { automationRunSteps, automationRuns, trackerFixes, trackerItems } from '../db/schema/index';
import { loadAgentRow } from '../read/principals';
import { trackerConnectionRow } from './connection';
import type { BoundDriver } from './drivers';
import { SourceProblem, TrackerNotFound, TrackerRefusal } from './errors';
import { scopeReport, trackerItemKey } from './items';
import { mirroredNumber } from './store';

type Step = Extract<AutomationStep, { kind: 'tracker_reply' }>;

/** Why a `tracker_reply` step has no report to answer. */
export const NO_REPORT_TO_ANSWER = 'Nothing to send: this run didn’t start from a tracker’s report.';

/** “Nothing to send: Dusty had nothing to tell the customer.” — an empty reply (TA-25). */
export function nothingToSend(agent: string): string {
  return `Nothing to send: ${agent} had nothing to tell the customer.`;
}

/** Why a reply that tells a decision sends nothing: there was none (TA-46). */
export const NO_DECISION = 'Nothing to send: there was no decision to tell.';

type DecisionStatus = 'planned' | 'in_progress' | 'not_planned' | 'needs_information';
const DECISION_STATUSES: readonly string[] = ['planned', 'in_progress', 'not_planned', 'needs_information'];

/** A `tracker_decision` step's outcome as a reply reads it (TA-46), or null while it decided nothing. */
function decisionOf(
  steps: readonly { stepId: string; output: unknown }[],
  stepId: string,
): { choice: string; status: DecisionStatus; message: string; needsWords: boolean } | null {
  const out = steps.find((s) => s.stepId === stepId)?.output as
    | { decided?: unknown; choice?: unknown; status?: unknown; message?: unknown; needsWords?: unknown }
    | undefined;
  if (out?.decided !== true || typeof out.status !== 'string' || !DECISION_STATUSES.includes(out.status))
    return null;
  return {
    choice: typeof out.choice === 'string' ? out.choice : '',
    status: out.status as DecisionStatus,
    message: typeof out.message === 'string' ? out.message : '',
    needsWords: out.needsWords === true,
  };
}

/** What a test run's card says first (TA-28). */
export const TEST_RUN_ASKS = 'This is a test run: the customer gets it only if you say yes.';

/** What a step would send, or why it sends nothing (`fatal`: the step can't run at all). */
export type TrackerReplyPlan =
  | {
      ok: true;
      connectionId: string;
      /** The connection's label (“Acme Desk dev”). */
      connection: string;
      reportId: string;
      number: number;
      /** The agent whose reply it is, and how it signs. */
      agent: string;
      signature: string;
      /** Exactly what the customer gets: the reply, a blank line and the signature. */
      message: string;
      /** The reply asks the customer for something (“Needs information”). */
      asks: boolean;
      /** The status it would set, as the report was when the run started (sent against the tracker's status then). */
      status: string | null;
      /** The reply closes the report (TA-54): sent as Closed when the tracker still has it open then. */
      closes: boolean;
      /**
       * The agent said the customer calls it solved or withdrew it (not only a question it answered): it closes a report
       * whose fix waits for a release or is out, too.
       */
      solved: boolean;
      /** The original it repeats (the tracker's id): the reply sets Duplicate, linked to it (TA-54). */
      duplicateOf: string | null;
      /** A decision's status (TA-46), sent whatever the tracker has then unless it has it already; null: the reply's own. */
      decisionStatus: DecisionStatus | null;
      /** What a person should check first (`customerReplyProblem`), or null. */
      problem: string | null;
      /** A test run's reply always asks (TA-28). */
      test: boolean;
      /** What a person says yes to (the card shows the exact signed text). */
      proposal: { title: string; details: string };
    }
  | { ok: false; reason: string; fatal?: boolean };

/**
 * The original a duplicate repeats (TA-54): the mirrored report `number` of the same connection and the same
 * organization (by the tracker's id), still open and not a duplicate itself (a duplicate links only to an original). Its
 * id, or null.
 */
async function duplicateOriginal(
  db: Db | Tx,
  connectionId: string,
  reportId: string,
  number: number,
): Promise<string | null> {
  const [own] = await db
    .select({ organizationId: trackerItems.organizationId })
    .from(trackerItems)
    .where(and(eq(trackerItems.connectionId, connectionId), eq(trackerItems.externalId, reportId)));
  if (!own?.organizationId) return null;
  const [original] = await db
    .select({
      externalId: trackerItems.externalId,
      status: trackerItems.status,
      seen: trackerItems.seenStatus,
    })
    .from(trackerItems)
    .where(
      and(
        eq(trackerItems.connectionId, connectionId),
        eq(trackerItems.number, number),
        eq(trackerItems.organizationId, own.organizationId),
        ne(trackerItems.externalId, reportId),
      ),
    );
  if (!original) return null;
  const status = original.seen ?? original.status;
  return ['closed', 'duplicate', 'not_planned', 'confirmed'].includes(status) ? null : original.externalId;
}

/**
 * Whether a fix of the report is still on its way to the customer: opened, merged, not yet live where they are — or
 * still being made, in another run of the report whose fix step has started.
 */
export async function fixUnderWay(
  db: Db | Tx,
  connectionId: string,
  reportId: string,
  runId: string | null,
  number: number,
): Promise<boolean> {
  if (number > 0) {
    const [making] = await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .innerJoin(automationRunSteps, eq(automationRunSteps.runId, automationRuns.id))
      .where(
        and(
          eq(automationRuns.itemKey, trackerItemKey(connectionId, number)),
          inArray(automationRuns.status, ['queued', 'running', 'waiting', 'paused']),
          ...(runId ? [ne(automationRuns.id, runId)] : []),
          eq(automationRunSteps.stepId, 'fix'),
          // A fix waiting for its turn (another fix at work, TA-69) is under way too.
          or(
            inArray(automationRunSteps.state, ['running', 'waiting', 'succeeded']),
            and(eq(automationRunSteps.state, 'pending'), isNotNull(automationRunSteps.startedAt)),
          ),
        ),
      )
      .limit(1);
    if (making) return true;
  }
  const [row] = await db
    .select({ id: trackerFixes.id })
    .from(trackerFixes)
    .where(
      and(
        eq(trackerFixes.connectionId, connectionId),
        eq(trackerFixes.reportId, reportId),
        inArray(trackerFixes.state, ['open', 'merged', 'development']),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Why a run that a customer's answer started shouldn't go on to fix their report (report-trackers.md TA-70), or null:
 * a fix of it is under way already (one run, one fix), or it is live and the answer calls for no other change (“works,
 * thanks” or “when?” isn't a new bug). An answer that reopened it (“Still happening”) goes on as before.
 */
export async function followUpHold(
  db: Db | Tx,
  run: { id: string; scope: unknown },
  read: Record<string, unknown>,
): Promise<string | null> {
  const scope = run.scope as { event?: unknown; answer?: unknown; status?: unknown } | null;
  const report = scopeReport(run.scope);
  if (!report || scope?.event !== 'reporter_replied') return null;
  // One fix of a report at a time, a reopen too: under way already, or another answer's run decided to fix it.
  if (
    (await fixUnderWay(db, report.connectionId, report.reportId, run.id, report.number)) ||
    (await anotherWillFix(db, report, run.id))
  )
    return 'A fix for this report is under way already, so the customer’s answer doesn’t start another.';
  // “Still happening” reopened it (the poller's reopen; a run from before it was kept reads the status).
  if (scope.answer === 'reopened' || (scope.answer === undefined && scope.status === 'new')) return null;
  // The latest attempt decides, not any older one: a newer fix that didn't land waits for the person even after an
  // older one went live.
  const latest = await latestFixAttempt(db, report, run.id);
  if (latest === 'unlanded')
    return 'An earlier fix of this report didn’t land and waits for you, so the customer’s answer doesn’t start another.';
  const recommends = (read.steps as { ask?: { assessment?: { recommends?: unknown } } } | undefined)?.ask
    ?.assessment?.recommends;
  return latest === 'landed' && recommends !== 'change'
    ? 'Its fix is merged already, and the customer’s answer doesn’t call for another change.'
    : null;
}

/**
 * How the report's latest fix attempt ended, by when it began: `landed` — merged and out of Whombat's hands (live,
 * confirmed, reopened, or stopped after its merge, as a device-agent fix awaiting its release); `unlanded` — a run's fix that
 * opened no pull request, or whose pull request was closed or stopped unmerged (it waits for the person, TA-61); null —
 * none (one under way is `fixUnderWay`'s).
 */
async function latestFixAttempt(
  db: Db | Tx,
  report: { connectionId: string; reportId: string; number: number },
  runId: string,
): Promise<'landed' | 'unlanded' | null> {
  const fixes = await db
    .select({
      state: trackerFixes.state,
      runId: trackerFixes.runId,
      mergedAt: trackerFixes.mergedAt,
      createdAt: trackerFixes.createdAt,
    })
    .from(trackerFixes)
    .where(
      and(eq(trackerFixes.connectionId, report.connectionId), eq(trackerFixes.reportId, report.reportId)),
    );
  const started =
    report.number > 0
      ? await db
          .select({ runId: automationRuns.id, at: automationRunSteps.startedAt })
          .from(automationRuns)
          .innerJoin(automationRunSteps, eq(automationRunSteps.runId, automationRuns.id))
          .where(
            and(
              eq(automationRuns.itemKey, trackerItemKey(report.connectionId, report.number)),
              ne(automationRuns.id, runId),
              eq(automationRuns.test, false),
              eq(automationRunSteps.stepId, 'fix'),
              isNotNull(automationRunSteps.startedAt),
            ),
          )
      : [];
  // Each attempt with when it began: a run's fix (its row, if it opened a pull request), or a person's own fix's row.
  const attempts: { at: number; fix: (typeof fixes)[number] | null }[] = [
    ...started.map((s) => ({
      at: s.at?.getTime() ?? 0,
      fix: fixes.find((f) => f.runId === s.runId) ?? null,
    })),
    ...fixes
      .filter((f) => !f.runId || !started.some((s) => s.runId === f.runId))
      .map((f) => ({ at: f.createdAt.getTime(), fix: f })),
  ];
  const last = attempts.sort((a, b) => b.at - a.at)[0];
  if (!last) return null;
  const f = last.fix;
  if (!f) return 'unlanded';
  // Reopened (“Still happening”) it had landed too: a new fix of it is the next attempt's to make.
  if (
    f.state === 'live' ||
    f.state === 'confirmed' ||
    f.state === 'reopened' ||
    (f.state === 'stopped' && f.mergedAt)
  )
    return 'landed';
  if (f.state === 'closed' || f.state === 'stopped') return 'unlanded';
  return null;
}

/** Whether another run of the report, still going, decided to fix it (its “worth fixing” check said yes). */
async function anotherWillFix(
  db: Db | Tx,
  report: { connectionId: string; number: number },
  runId: string,
): Promise<boolean> {
  if (report.number <= 0) return false;
  const [row] = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .innerJoin(automationRunSteps, eq(automationRunSteps.runId, automationRuns.id))
    .where(
      and(
        eq(automationRuns.itemKey, trackerItemKey(report.connectionId, report.number)),
        ne(automationRuns.id, runId),
        eq(automationRuns.test, false),
        inArray(automationRuns.status, ['queued', 'running', 'waiting', 'paused']),
        eq(automationRunSteps.stepId, 'worth_fixing'),
        eq(automationRunSteps.state, 'succeeded'),
        sql`${automationRunSteps.output}->>'result' = 'true'`,
      ),
    )
    .limit(1);
  return !!row;
}

/** The other organizations a connection has reports from (TA-28): their names, the report's own left out. */
export async function otherOrganizations(
  db: Db | Tx,
  connectionId: string,
  own: string | null,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: trackerItems.organization })
    .from(trackerItems)
    .where(
      and(
        eq(trackerItems.connectionId, connectionId),
        isNotNull(trackerItems.organization),
        own ? ne(sql`lower(${trackerItems.organization})`, own.toLowerCase()) : undefined,
      ),
    )
    .limit(500);
  return rows.map((r) => r.name).filter((n): n is string => !!n);
}

/** The agent of step `from`: its name and how it signs (TA-26). */
export async function replyAgent(
  db: Db | Tx,
  burrowId: string,
  steps: readonly AutomationStep[],
  from: string,
): Promise<{ agent: string; signature: string }> {
  const step = steps.find((s) => s.id === from);
  // The agent's voice (one-agent.md OA-15): every agent step is its turn.
  const row = step?.kind === 'dispatch_agent' ? await loadAgentRow(db, burrowId) : undefined;
  const agent = row?.name ?? 'The agent';
  return { agent, signature: customerSignature(agent) };
}

/** `> ` before every line: the reply as the thread quotes it, signature included. */
export function quoted(text: string): string {
  return text
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

/**
 * The run's thread once the reply went (TA-27): “Replied to the customer and set #16 to “Investigating”:” (or “Replied
 * to the customer:”) and the reply quoted, signature included.
 */
export function replyLine(number: number, status: string | null, message: string): string {
  const head = status
    ? `Replied to the customer and set #${number} to “${trackerStatusLabel(status)}”:`
    : 'Replied to the customer:';
  return `${head}\n\n${quoted(message)}`;
}

/**
 * What a `tracker_reply` step would send for this run (TA-25…TA-28): the report its template names, step `from`'s
 * reply signed with its agent's name and role, the status `trackerReplyStatus` gives against the status the run started
 * with, what `customerReplyProblem` finds (the connection's address as the allowed origin, the other organizations of
 * the connection's reports), and the card a person says yes to. An empty reply is a reason the step is skipped with.
 */
export async function trackerReplyPlan(
  db: Db | Tx,
  run: {
    id?: string;
    burrowId: string;
    test: boolean;
    definition: { steps: readonly AutomationStep[] };
    scope: unknown;
  },
  steps: readonly { stepId: string; output: unknown }[],
  step: Step,
  scope: Record<string, unknown>,
): Promise<TrackerReplyPlan> {
  const reportId = renderTemplate(step.report, scope, 100).trim();
  if (!reportId) return { ok: false, reason: NO_REPORT_TO_ANSWER };
  if (!TrackerItemId.safeParse(reportId).success)
    return { ok: false, reason: `Nothing to send: “${reportId.slice(0, 60)}” isn’t a report id.` };
  const row = await trackerConnectionRow(db, run.burrowId, step.connectionId);
  if (!row) return { ok: false, reason: 'Its tracker connection is gone.', fatal: true };
  const { agent, signature } = await replyAgent(db, run.burrowId, run.definition.steps, step.from);
  const kept = steps.find((s) => s.stepId === step.from)?.output as
    | { assessment?: unknown; closes?: unknown }
    | undefined;
  const assessment = reportedAssessment(kept?.assessment);
  // A reply that tells the person's decision on a feature request (TA-46): its draft, else what the agent wrote for
  // the person's own words, with the decision's status.
  const decision = step.decision ? decisionOf(steps, step.decision) : null;
  if (step.decision && !decision) return { ok: false, reason: NO_DECISION };
  const reply = (
    decision ? (decision.needsWords ? assessment.reply : decision.message) : assessment.reply
  ).trim();
  if (!reply) return { ok: false, reason: nothingToSend(agent) };
  const asks = decision ? decision.choice === 'ask' : assessment.replyAsks;
  const trigger = scope.trigger as {
    kind?: unknown;
    reportId?: unknown;
    connectionId?: unknown;
    number?: unknown;
    status?: unknown;
    organization?: unknown;
  } | null;
  const same =
    trigger?.kind === 'tracker' &&
    trigger.reportId === reportId &&
    trigger.connectionId === step.connectionId;
  const [mirrored] = await db
    .select({
      number: trackerItems.number,
      status: trackerItems.status,
      organization: trackerItems.organization,
      product: trackerItems.product,
    })
    .from(trackerItems)
    .where(and(eq(trackerItems.connectionId, step.connectionId), eq(trackerItems.externalId, reportId)));
  const number =
    same && typeof trigger?.number === 'number'
      ? trigger.number
      : (mirrored?.number ?? (await mirroredNumber(db, step.connectionId, reportId)) ?? 0);
  const startedWith =
    same && typeof trigger?.status === 'string' ? trigger.status : (mirrored?.status ?? 'new');
  const organization =
    same && typeof trigger?.organization === 'string'
      ? trigger.organization
      : (mirrored?.organization ?? null);
  const message = signedReply(reply, signature);
  const problem = customerReplyProblem(reply, {
    origin: row.baseUrl,
    organizations: await otherOrganizations(db, row.id, organization),
    ...(mirrored?.product ? { product: mirrored.product } : {}),
  });
  // A finished report is closed by its reply (TA-54), never while a fix for it is under way.
  // Nor when this run goes on to fix it: a change it recommends is still to come (TA-54).
  // A question its reply answers, asking nothing back and recommending no change, is finished too: the agent's flag is
  // easily left out, and the customer can still write back (TA-54).
  const answered =
    assessment.kind === 'question' && !assessment.replyAsks && assessment.recommends !== 'change';
  const closes =
    !decision &&
    (kept?.closes === true || answered) &&
    !assessment.replyAsks &&
    assessment.recommends !== 'change' &&
    !(await fixUnderWay(db, step.connectionId, reportId, run.id ?? null, number));
  // A repeat of the same organization's open report is linked to it (TA-54): the tracker then tells this
  // customer too once the original's fix is live.
  const original =
    closes && assessment.kind === 'duplicate' && assessment.duplicateOf
      ? await duplicateOriginal(db, step.connectionId, reportId, assessment.duplicateOf)
      : null;
  const status = decision
    ? decision.status === startedWith
      ? null
      : decision.status
    : original
      ? 'duplicate'
      : trackerReplyStatus({ ...assessment, closes, solved: closes && kept?.closes === true }, startedWith);
  const sets = status ? ` and sets #${number} to “${trackerStatusLabel(status)}”` : '';
  const details = [
    ...(problem ? [`Check it first: ${problem}`] : []),
    ...(run.test ? [TEST_RUN_ASKS] : []),
    `${agent}’s reply goes to the customer through ${row.label}, which emails it to them${sets}:`,
    message,
  ].join('\n\n');
  return {
    ok: true,
    connectionId: row.id,
    connection: row.label,
    reportId,
    number,
    agent,
    signature,
    message,
    asks,
    status,
    closes,
    solved: closes && kept?.closes === true,
    duplicateOf: original,
    decisionStatus: decision?.status ?? null,
    problem,
    test: run.test,
    proposal: { title: `Reply to the customer of ${row.label} #${number}`.slice(0, 160), details },
  };
}

/**
 * Whether the original a duplicate links to is, as the tracker has it now, open and not a duplicate itself (TA-54).
 * Gone is no; the tracker not answering throws, so the step tries again rather than dropping the link for good.
 */
async function openOriginal(driver: BoundDriver, id: string): Promise<boolean> {
  let original: Awaited<ReturnType<BoundDriver['item']>>;
  try {
    original = await driver.item(id);
  } catch (err) {
    if (err instanceof TrackerNotFound) return false;
    if (err instanceof SourceProblem && err.code === 'invalid_answer') return false;
    throw err;
  }
  return (
    !original.duplicateOf && !['closed', 'duplicate', 'not_planned', 'confirmed'].includes(original.status)
  );
}

/**
 * The send (TA-27), by the connection's driver: the signed reply with `trackerReplyStatus`'s status against the
 * report's status as the tracker has it then (a decision's own, TA-46) and the step's request id; the driver re-reads
 * the report before each attempt and once more after a conflict. A reply the tracker already has (an earlier send of
 * this step went through) isn't sent again. Answers the status it set (null: the status stayed). Throws the driver's
 * failures (`SourceProblem`, `TrackerRefusal`, `TrackerNotFound`, a second `TrackerConflict`).
 */
export async function sendReply(
  driver: BoundDriver,
  reportId: string,
  reply: {
    message: string;
    asks: boolean;
    closes?: boolean;
    solved?: boolean;
    duplicateOf?: string | null;
    status?: string | null;
  },
  requestId: string,
): Promise<{ status: string | null }> {
  // A finished report is linked as a duplicate only to an original that is still open and not a duplicate itself, as
  // the tracker has it now (TA-54); else it is closed.
  const linkable = reply.duplicateOf && !reply.status ? await openOriginal(driver, reply.duplicateOf) : false;
  const res = await driver
    .send(reportId, {
      requestId,
      message: reply.message,
      // A decision's status (TA-46) goes whatever the tracker has, unless it has it already; else the reply's own
      // (TA-27): a finished report is closed, or linked as a duplicate, only while the tracker still has it open.
      status: (now) =>
        reply.status
          ? now === reply.status
            ? null
            : reply.status
          : linkable && TRACKER_CLOSABLE_STATUSES.includes(now)
            ? 'duplicate'
            : trackerReplyStatus(
                {
                  replyAsks: reply.asks,
                  closes: reply.closes === true || !!reply.duplicateOf,
                  solved: reply.closes === true && reply.solved === true,
                },
                now,
              ),
      ...(linkable && reply.duplicateOf ? { duplicateOf: reply.duplicateOf } : {}),
    })
    .catch(async (err: unknown) => {
      // The tracker refused the link (its original moved on): the reply still goes, closing it plainly (TA-54). The
      // tracker keeps the request id only when a change committed, so the same one is safe.
      if (linkable && err instanceof TrackerRefusal) return null;
      throw err;
    });
  if (res === null)
    return sendReply(driver, reportId, { ...reply, duplicateOf: null, closes: true }, requestId);
  if ('skipped' in res) return { status: null };
  if (res.already) {
    const now = res.now;
    if (reply.status) return { status: now === reply.status ? now : null };
    return {
      status:
        now === 'investigating' ||
        now === 'needs_information' ||
        (reply.closes && now === 'closed') ||
        (!!reply.duplicateOf && now === 'duplicate')
          ? now
          : null,
    };
  }
  return { status: res.status };
}
