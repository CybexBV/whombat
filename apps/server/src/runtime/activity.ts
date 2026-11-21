/**
 * Observed activity and turn lifecycle frames (docs/decisions/work-supervision.md WS-11…WS-19).
 *
 * - `recordActivity` upserts the runner's reports by `(dispatch, key)` inside the progress beat's transaction (so a
 *   runner that lost its lease writes nothing), ignoring a report whose `seq` isn't newer than the row's; copy comes
 *   from core `describeActivity` through `activityCopy` (a command not run reads as one, health-command-loops.md
 *   HC-05); the run the turn works on is attached (and backfilled onto earlier rows once the turn starts one); an
 *   `approvalId` is kept only for an approval this agent asked for in this burrow. A failed Whombat call's row says
 *   why — the words the agent got — as its detail (resourceful-agents.md RA-DS49).
 * - `interruptActivity` marks rows still running as `interrupted` when a turn is requeued, ended or swept, and at
 *   boot (WS-15) — never done. Rows waiting on an approval follow the approval instead (WS-13).
 * - Every changed row is an `activity.updated` frame on `conv:` and `run:`, and every dispatch state change a
 *   `dispatch.updated` frame on `conv:`.
 *
 * Runtime telemetry: written through the runtime service's transactions with its outbox frames, never signed into
 * the audit log (WS-14).
 */
import {
  type Activity,
  type ActivityReport,
  type ActivityStatus,
  type DispatchSummary,
  isBrowserActivityTool,
  isVaultActivityTool,
  type LinkRef,
  newId,
  stripUrlForActivity,
  summaryTrigger,
  TURN_MERGED_REASON,
  topics,
} from '@whombat/core';
import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { heldNeedles, scrubValue, scrubWith } from '../agent-commands/secrets';
import type { TxSession } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { activities, approvals, dispatches } from '../db/schema/index';

import { iso, isoOrNull } from '../lib/time';
import { wellFormed } from '../lib/well-formed';
import { activityCopy } from './activity-copy';
import type { DispatchRow } from './context';
import { dispatchRun } from './dispatch-scope';

export type ActivityRow = typeof activities.$inferSelect;
type ApprovalBits = Pick<
  typeof approvals.$inferSelect,
  'id' | 'number' | 'state' | 'execution' | 'executedAt' | 'conversationId'
>;

const LIVE_DISPATCH = ['claimed', 'running'] as const;

/**
 * How every Vault tool's row names its tool (docs/decisions/vault.md VT-53): one neutral name, so the room can't tell
 * a bridged tool (whose name is the owner's server's) from a brokered request, nor which entry it was.
 */
export const VAULT_ACTIVITY_TOOL = 'whombat.vault_request';
/** Most rows one sweep marks interrupted (the next sweep takes the rest). */
const INTERRUPT_BATCH = 500;

/**
 * Whombat tools whose failed row keeps no reason (resourceful-agents.md RA-DS49): the memory tool's answers quote the
 * entries they were given — a person's profile, the agent's notes — which the conversation's people may not read. The
 * runner sends none for them either (`REASONLESS_WHOMBAT_TOOLS`).
 */
const REASONLESS_TOOLS: ReadonlySet<string> = new Set(['whombat.memory']);

/**
 * Why a Whombat call failed (RA-DS49): the words the agent got, which the runner sends as the evidence output of a
 * failed Whombat row (an MCP error, or an answer that refused). Never for a denial or a cancel, nor for
 * `REASONLESS_TOOLS`; the caller leaves out Vault rows and Feedback assessments (VT-53, WS-14).
 */
function whombatFailureReason(r: ActivityReport): string | null {
  if (r.kind !== 'whombat' || r.status !== 'failed' || r.failure !== 'error' || REASONLESS_TOOLS.has(r.tool))
    return null;
  const text = r.evidence?.output?.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

/** A reason as a row's detail: its first 160 characters. */
function reasonDetail(reason: string): string {
  return reason.length > 160 ? `${reason.slice(0, 159)}…` : reason;
}

/* Reading ---------------------------------------------------------------------------------------- */

/**
 * The row as clients see it. A row waiting on an approval follows the approval's current state (WS-13): approved
 * but not executed still waits, executed is done, declined or failed execution fails.
 */
export function toActivity(row: ActivityRow, approval?: ApprovalBits | null): Activity {
  let status: ActivityStatus = row.status;
  let detail = row.detail;
  let title = row.title;
  let important = row.important;
  let link: LinkRef | null = null;
  if (approval) {
    link = { type: 'approval', number: approval.number };
    if (row.status === 'waiting' || row.status === 'done' || row.status === 'failed') {
      const executed = approval.executedAt !== null || approval.execution.state === 'succeeded';
      const state =
        approval.state === 'declined'
          ? 'declined'
          : approval.execution.state === 'failed'
            ? 'failed'
            : executed
              ? 'done'
              : approval.state;
      status = state === 'declined' || state === 'failed' ? 'failed' : state === 'done' ? 'done' : 'waiting';
      const copy = activityCopy({
        kind: row.kind,
        tool: row.tool,
        status,
        object: row.object,
        exitCode: row.exitCode,
        failure: row.failure,
        keyNeeded: row.keyNeeded,
      });
      title = copy.title;
      important = copy.important;
      detail =
        state === 'pending' ? `approval #${approval.number}` : `approval #${approval.number} · ${state}`;
    }
  }
  return {
    id: row.id,
    burrowId: row.burrowId,
    dispatchId: row.dispatchId,
    runId: row.runId,
    agentId: row.agentId,
    conversationId: row.conversationId,
    threadRootId: row.threadRootId,
    key: row.key,
    attempt: row.attempt,
    seq: row.seq,
    kind: row.kind,
    tool: row.tool,
    status,
    title: title.slice(0, 200),
    object: row.object,
    detail: detail ? detail.slice(0, 160) : null,
    important,
    approvalId: approval ? row.approvalId : null,
    link,
    evidence: row.evidence ?? null,
    startedAt: iso(row.startedAt),
    updatedAt: iso(row.updatedAt),
    finishedAt: isoOrNull(row.finishedAt),
  };
}

async function approvalsOf(db: Db, rows: readonly ActivityRow[]): Promise<Map<string, ApprovalBits>> {
  const ids = [...new Set(rows.map((r) => r.approvalId).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const found = await db
    .select({
      id: approvals.id,
      number: approvals.number,
      state: approvals.state,
      execution: approvals.execution,
      executedAt: approvals.executedAt,
      conversationId: approvals.conversationId,
    })
    .from(approvals)
    .where(inArray(approvals.id, ids));
  return new Map(found.map((a) => [a.id, a]));
}

/** Rows as clients see them (one query for their approvals). */
export async function toActivities(db: Db, rows: readonly ActivityRow[]): Promise<Activity[]> {
  const byId = await approvalsOf(db, rows);
  return rows.map((r) => toActivity(r, r.approvalId ? byId.get(r.approvalId) : null));
}

/* Frames ----------------------------------------------------------------------------------------- */

async function publishRows(tx: Tx, session: TxSession, rows: readonly ActivityRow[]): Promise<void> {
  if (!rows.length) return;
  for (const activity of await toActivities(tx, rows)) {
    session.publish(topics.conversation(activity.conversationId), { type: 'activity.updated', activity });
    if (activity.runId) session.publish(topics.run(activity.runId), { type: 'activity.updated', activity });
  }
}

/** Approval-derived status changes must reach both open feeds and clients catching up by revision. */
export async function refreshApprovalActivity(
  session: TxSession,
  approvalId: string,
  now: Date,
): Promise<void> {
  const changed = await session.tx
    .update(activities)
    .set({
      rev: sql`nextval('activities_rev_seq')`,
      // Clients also order equal-sequence reports by time, including two changes in the same millisecond.
      updatedAt: sql`greatest(${activities.updatedAt} + interval '1 millisecond', ${now.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(activities.burrowId, session.burrowId),
        eq(activities.approvalId, approvalId),
        inArray(activities.status, ['waiting', 'done', 'failed']),
      ),
    )
    .returning();
  await publishRows(session.tx, session, changed);
}

/** A short, safe reason for a failed or cancelled turn (never the raw error). */
export function dispatchReason(row: Pick<DispatchRow, 'state' | 'error' | 'cancelReason'>): string | null {
  const error = row.error ?? '';
  if (row.state === 'cancelled') {
    if (row.cancelReason === 'paused' || error === 'paused') return 'Paused';
    if (row.cancelReason === 'taken_over' || error === 'taken_over') return 'Taken over';
    if (error.startsWith('run_')) return 'The run had already stopped';
    // A follow-up the agent's running turn took (steering.md SX-11).
    if (error.startsWith('merged:')) return TURN_MERGED_REASON;
    return 'Stopped';
  }
  if (row.state !== 'failed') return null;
  if (error === 'lease_expired') return 'The runner stopped';
  if (error === 'runner_shutdown') return 'The runner restarted';
  if (error.startsWith('unrunnable:')) return 'No runner could run it';
  if (error === 'host_not_ready') return 'The runner’s host wasn’t ready';
  if (error === 'credential_source_changed') return 'The sign-in it would run on changed';
  if (/^(provider|client|managed)[.:]/.test(error)) return 'The AI provider couldn’t run it';
  return 'Couldn’t finish';
}

/**
 * The turn as clients see it. `reason`: a sentence that replaces the stored one (“Stopped by Mara”, RF-01), for the frame
 * and the answer of the command that knows it.
 */
export function dispatchSummary(
  row: DispatchRow,
  runId: string | null = row.runId,
  reason?: string | null,
): DispatchSummary {
  return {
    id: row.id,
    agentId: row.agentId,
    conversationId: row.conversationId,
    threadRootId: row.threadRootId,
    // Clients read the triggers they know (contracts 0.91, CT-406): an Undo request is a person's message to them.
    trigger: summaryTrigger(row.trigger),
    state: row.state,
    runId,
    createdAt: iso(row.createdAt),
    claimedAt: isoOrNull(row.claimedAt),
    heartbeatAt: isoOrNull(row.heartbeatAt),
    finishedAt: isoOrNull(row.finishedAt),
    reason: reason ?? dispatchReason(row),
    // Why a failed turn failed, in its public words (essentials-agents.md EA-08); never the technical detail.
    failure:
      row.state === 'failed' && row.failure ? { code: row.failure.code, reason: row.failure.reason } : null,
  };
}

/** `dispatch.updated` on the conversation topic (WS-19); `reason` as `dispatchSummary`'s. */
export function publishDispatch(
  session: Pick<TxSession, 'publish'>,
  row: DispatchRow,
  reason?: string | null,
): void {
  session.publish(topics.conversation(row.conversationId), {
    type: 'dispatch.updated',
    dispatch: dispatchSummary(row, row.runId, reason),
  });
}

/** Loads the dispatches by id (as they are now in `tx`) and publishes each. */
export async function publishDispatches(tx: Tx, session: TxSession, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await tx
    .select()
    .from(dispatches)
    .where(inArray(dispatches.id, [...new Set(ids)]));
  for (const row of rows) publishDispatch(session, row);
}

/* Writing ---------------------------------------------------------------------------------------- */

/**
 * Upserts the reports of one progress beat (the caller holds the lease in `tx`). Returns how many rows changed.
 */
export async function recordActivity(
  tx: Tx,
  session: TxSession,
  dispatch: DispatchRow,
  reports: readonly ActivityReport[],
  now: Date,
): Promise<number> {
  // One report per key (the newest) — Postgres can't upsert the same row twice in one statement. Objects and evidence
  // never carry a value the agent holds (agent-computer.md AC-32).
  const needles = await heldNeedles(session.services, tx, dispatch.agentId);
  const latest = new Map<string, ActivityReport>();
  for (const report of reports) {
    // What a command printed may hold bytes Postgres refuses (NUL from a binary file): one such row must not fail the
    // whole beat, which would lose the lease and stop the turn (files-space.md FS-D10).
    const raw = wellFormed(report) as ActivityReport;
    const r = needles.length
      ? {
          ...raw,
          object: raw.object && scrubWith(raw.object, needles),
          evidence: scrubValue(raw.evidence, needles),
        }
      : raw;
    const prev = latest.get(r.key);
    if (!prev || prev.seq < r.seq) latest.set(r.key, r);
  }
  const runId = await dispatchRun(tx, dispatch);
  // An approval is linked only when this agent asked for it in this burrow (a report can't point elsewhere).
  const asked = [...latest.values()].map((r) => r.approvalId).filter((x): x is string => !!x);
  const own = asked.length
    ? new Set(
        (
          await tx
            .select({ id: approvals.id })
            .from(approvals)
            .where(
              and(
                inArray(approvals.id, asked),
                eq(approvals.burrowId, dispatch.burrowId),
                eq(approvals.requesterId, dispatch.agentId),
              ),
            )
        ).map((a) => a.id),
      )
    : new Set<string>();
  // A Feedback assessment: kind and state only, whatever the runner sent (WS-14).
  const bare = dispatch.trigger === 'feedback';
  // The lease's claim: keys start with it (`<attempt>:…`), the row records it.
  const attempt = Math.max(1, dispatch.attempts);
  const values = [...latest.values()].map((r) => {
    // A Vault tool's row reads “Used a private Vault entry”: no tool, object, evidence or approval (VT-53).
    const vault = isVaultActivityTool(r.tool);
    const plain = bare || vault;
    // A browser row's object is a URL without credentials, query and fragment, whatever a runner sent (CT-128).
    const browser = isBrowserActivityTool(r.tool);
    const fields = {
      kind: r.kind,
      tool: vault ? VAULT_ACTIVITY_TOOL : r.tool,
      status: r.status,
      object: plain
        ? null
        : browser && r.object
          ? stripUrlForActivity(r.object).slice(0, 500) || null
          : r.object,
      exitCode: plain ? null : r.exitCode,
      failure: r.failure,
      keyNeeded: plain ? null : r.keyNeeded,
    };
    // A command's own output may say why in words people can't read (Codex's missing folder, RN-R4).
    const copy = activityCopy(fields, plain || browser ? null : (r.evidence?.output ?? null));
    // A failed Whombat call says why: the reason is its detail and its only evidence; a Whombat row keeps no other
    // evidence, whatever a runner sent (its arguments and results may be another room's, RA-DS49).
    // Not the browser's, whatever kind a runner gave it: its rows keep their own rules (BT-03).
    const reason = plain || browser ? null : whombatFailureReason(r);
    const evidence =
      plain || browser
        ? null
        : r.kind === 'whombat'
          ? reason
            ? { input: null, output: reason.slice(0, 4000), truncated: r.evidence?.truncated ?? false }
            : null
          : r.evidence;
    const approvalId = !vault && r.approvalId && own.has(r.approvalId) ? r.approvalId : null;
    const finished = r.status === 'done' || r.status === 'failed';
    return {
      id: newId('activity'),
      burrowId: dispatch.burrowId,
      dispatchId: dispatch.id,
      runId,
      agentId: dispatch.agentId,
      conversationId: dispatch.conversationId,
      threadRootId: dispatch.threadRootId,
      key: r.key,
      attempt,
      seq: r.seq,
      ...fields,
      title: copy.title.slice(0, 200),
      detail: reason ? reasonDetail(reason) : copy.detail ? copy.detail.slice(0, 160) : null,
      important: copy.important,
      approvalId,
      evidence,
      startedAt: now,
      updatedAt: now,
      finishedAt: finished ? now : null,
    };
  });
  const changed: ActivityRow[] = [];
  if (values.length) {
    const ex = (column: string) => sql.raw(`excluded.${column}`);
    changed.push(
      ...(await tx
        .insert(activities)
        .values(values)
        .onConflictDoUpdate({
          target: [activities.dispatchId, activities.key],
          set: {
            seq: ex('seq'),
            kind: ex('kind'),
            tool: ex('tool'),
            status: ex('status'),
            title: ex('title'),
            object: ex('object'),
            detail: ex('detail'),
            important: ex('important'),
            exitCode: ex('exit_code'),
            failure: ex('failure'),
            keyNeeded: ex('key_needed'),
            approvalId: ex('approval_id'),
            evidence: ex('evidence'),
            runId: sql`coalesce(${activities.runId}, excluded.run_id)`,
            rev: sql`nextval('activities_rev_seq')`,
            updatedAt: ex('updated_at'),
            finishedAt: sql`coalesce(${activities.finishedAt}, excluded.finished_at)`,
          },
          // Duplicates and out-of-order batches change nothing; an interrupted row stays interrupted.
          setWhere: sql`${activities.seq} < excluded.seq and ${activities.status} <> 'interrupted'`,
        })
        .returning()),
    );
  }
  if (runId) {
    // The turn started a run after its first actions: those rows belong to the run too.
    const seen = new Set(changed.map((c) => c.id));
    const backfilled = await tx
      .update(activities)
      .set({ runId, rev: sql`nextval('activities_rev_seq')` })
      .where(and(eq(activities.dispatchId, dispatch.id), isNull(activities.runId)))
      .returning();
    for (const row of backfilled) {
      const i = changed.findIndex((c) => c.id === row.id);
      if (i >= 0) changed[i] = row;
      else if (!seen.has(row.id)) changed.push(row);
    }
  }
  await publishRows(tx, session, changed);
  return changed.length;
}

/**
 * Rows of a turn still running become `interrupted` (never done, WS-15): the turn was requeued, ended, lost its
 * lease, or the server restarted. Rows waiting on an approval follow the approval and are left alone.
 */
export async function interruptActivity(
  tx: Tx,
  session: TxSession,
  dispatchIds: readonly string[],
  now: Date,
  why: 'stopped' | 'restarted' = 'stopped',
): Promise<number> {
  if (!dispatchIds.length) return 0;
  const open = await tx
    .select()
    .from(activities)
    .where(
      and(
        inArray(activities.dispatchId, [...dispatchIds]),
        or(
          eq(activities.status, 'running'),
          and(eq(activities.status, 'waiting'), isNull(activities.approvalId)),
        ),
      ),
    )
    .limit(INTERRUPT_BATCH);
  const changed: ActivityRow[] = [];
  for (const row of open) {
    const copy = activityCopy({
      kind: row.kind,
      tool: row.tool,
      status: 'interrupted',
      object: row.object,
      exitCode: row.exitCode,
      failure: row.failure,
      keyNeeded: row.keyNeeded,
    });
    const [updated] = await tx
      .update(activities)
      .set({
        status: 'interrupted',
        title: copy.title.slice(0, 200),
        detail: why === 'restarted' ? 'restarted' : copy.detail,
        important: copy.important,
        rev: sql`nextval('activities_rev_seq')`,
        updatedAt: now,
        finishedAt: now,
      })
      .where(and(eq(activities.id, row.id), eq(activities.status, row.status)))
      .returning();
    if (updated) changed.push(updated);
  }
  await publishRows(tx, session, changed);
  return changed.length;
}

/**
 * Rows still running whose turn no longer runs (ended by a take over, an automation or an assessment, or left
 * behind by a restart): interrupted. Run by the lease sweep and at boot.
 */
export async function orphanedDispatches(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: activities.dispatchId })
    .from(activities)
    .innerJoin(dispatches, eq(dispatches.id, activities.dispatchId))
    .where(
      and(
        or(
          eq(activities.status, 'running'),
          and(eq(activities.status, 'waiting'), isNull(activities.approvalId)),
        ),
        notInArray(dispatches.state, [...LIVE_DISPATCH]),
      ),
    )
    .limit(INTERRUPT_BATCH);
  return rows.map((r) => r.id);
}
