/**
 * Plan steps follow the work they link to (docs/decisions/work-supervision.md WS-05). `followPlanWork` loads the
 * linked objects' *current* status (never an event's copy), projects with core `projectPlanStep` and writes only
 * when the projection key changed (`shouldApplyProjection`; the key is kept on the stored step as `followKey`). So
 * repeated or out-of-order calls, and the startup reconcile, can't corrupt a plan: calling it twice changes
 * nothing the second time, and a step someone finished or cancelled by hand for the same work stays.
 *
 * Callers: every run status change (`publishRun`), every approval change (`syncPlanSteps`), every automation run
 * change (`publishRun` of automations), every state change of a dispatch asked to do a step (runtime), and
 * `reconcilePlans` at startup.
 */
import {
  type AutomationRunStatus,
  approvalPhase,
  approvalView,
  type DispatchState,
  type PlanStepWork,
  projectPlanStep,
  type RunStatus,
  shouldApplyProjection,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import type { ApplyContext, BurrowRow, TxSession } from '../commit/types';
import type { Db } from '../db/client';
import {
  approvals,
  automationRuns,
  automations,
  burrows as burrowsTable,
  dispatches,
  plans,
  runs,
} from '../db/schema/index';
import { toApproval } from '../read/work';
import type { Services } from '../services';
import {
  commandWriter,
  lockPlanRow,
  type PlanRow,
  type PlanWriter,
  principalNames,
  type StoredStep,
  savePlan,
  sessionWriter,
} from './plans';

/** Linked work a step can follow. */
export type WorkRef =
  | { kind: 'run'; id: string }
  | { kind: 'approval'; id: string }
  | { kind: 'automation_run'; id: string }
  | { kind: 'dispatch'; id: string };

const FIELD: Record<WorkRef['kind'], 'runId' | 'approvalId' | 'automationRunId' | 'dispatchId'> = {
  run: 'runId',
  approval: 'approvalId',
  automation_run: 'automationRunId',
  dispatch: 'dispatchId',
};

/** Plans of the burrow with a step linked to `ref` (the GIN index on `steps`). */
async function plansLinkedTo(db: Db, burrowId: string, ref: WorkRef): Promise<PlanRow[]> {
  return db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.burrowId, burrowId),
        sql`${plans.steps} @> ${JSON.stringify([{ [FIELD[ref.kind]]: ref.id }])}::jsonb`,
      ),
    )
    .for('update');
}

interface LoadedWork {
  work: PlanStepWork;
  /** Who moved the step, for signing a runtime follow: the run's agent, the approval's requester, … */
  signerId: string | null;
}

/** The current state of everything a step links to. */
async function loadWork(db: Db, step: StoredStep): Promise<LoadedWork> {
  const work: PlanStepWork = {};
  let signerId: string | null = null;
  if (step.runId) {
    const [r] = await db
      .select({
        id: runs.id,
        number: runs.number,
        status: runs.status,
        takenOverById: runs.takenOverById,
        agentId: runs.agentId,
      })
      .from(runs)
      .where(eq(runs.id, step.runId));
    if (r) {
      work.run = {
        id: r.id,
        number: r.number,
        status: r.status as RunStatus,
        takenOverById: r.takenOverById,
      };
      signerId ??= r.agentId;
    }
  }
  if (step.automationRunId) {
    const [r] = await db
      .select({
        id: automationRuns.id,
        number: automationRuns.number,
        status: automationRuns.status,
        principalId: automations.principalId,
      })
      .from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .where(eq(automationRuns.id, step.automationRunId));
    if (r) {
      work.automationRun = { id: r.id, number: r.number, status: r.status as AutomationRunStatus };
      signerId ??= r.principalId;
    }
  }
  if (step.approvalId) {
    const [row] = await db.select().from(approvals).where(eq(approvals.id, step.approvalId));
    if (row) {
      const approval = toApproval(row);
      const view = approvalView(approval, {
        names: () => undefined,
        now: approval.createdAt,
        timeZone: 'UTC',
      });
      // Without a viewer the view says “Needs a person” for a pending one (the mock's label).
      const label = approvalPhase(approval) === 'needs_person' ? 'Needs a person' : view.planStep.label;
      work.approval = { id: row.id, number: row.number, step: { state: view.planStep.state, label } };
      signerId ??= row.requesterId;
    }
  }
  if (step.dispatchId) {
    const [d] = await db
      .select({ id: dispatches.id, state: dispatches.state, agentId: dispatches.agentId })
      .from(dispatches)
      .where(eq(dispatches.id, step.dispatchId));
    if (d) {
      const [run] = step.runId
        ? [{ id: step.runId }]
        : await db.select({ id: runs.id }).from(runs).where(eq(runs.dispatchId, d.id)).limit(1);
      work.dispatch = { id: d.id, state: d.state as DispatchState, hasRun: !!run };
      signerId ??= d.agentId;
    }
  }
  return { work, signerId };
}

/**
 * The plan's steps with their linked work projected (only the steps `only` names, when given). Returns null when
 * nothing moves, else the new steps and who moved the first one.
 */
export async function projectSteps(
  db: Db,
  plan: PlanRow,
  only: (s: StoredStep) => boolean,
): Promise<{ steps: StoredStep[]; signerId: string | null } | null> {
  let changed = false;
  let signerId: string | null = null;
  const steps: StoredStep[] = [];
  for (const step of plan.steps) {
    if (!only(step) || !(step.runId || step.approvalId || step.automationRunId || step.dispatchId)) {
      steps.push(step);
      continue;
    }
    const loaded = await loadWork(db, step);
    const takenOver = loaded.work.run?.takenOverById;
    const names = await principalNames(db, takenOver ? [takenOver] : []);
    const projection = projectPlanStep(step, loaded.work, (id) => names.get(id) ?? 'Someone');
    if (!projection || !shouldApplyProjection(step, projection)) {
      steps.push(step);
      continue;
    }
    changed = true;
    signerId ??= loaded.signerId;
    steps.push({
      ...step,
      state: projection.state,
      stateLabel: projection.stateLabel,
      note: projection.note,
      followKey: projection.followKey,
    });
  }
  return changed ? { steps, signerId } : null;
}

async function followIn(
  tx: Db,
  plan: PlanRow,
  only: (s: StoredStep) => boolean,
  writerFor: (signerId: string | null) => PlanWriter,
): Promise<boolean> {
  const projected = await projectSteps(tx, plan, only);
  if (!projected) return false;
  // A projection is bookkeeping of what the linked work did: that work's own events are the log (text null).
  await savePlan(writerFor(projected.signerId), plan, {
    steps: projected.steps,
    text: null,
    payload: { followed: true },
  });
  return true;
}

/**
 * Follows `ref` into every plan step linked to it. In a command (`ctx`), signed by its actor; in a runtime session,
 * by `signerId` (else whoever the linked work belongs to). Returns how many plans changed.
 */
export async function followPlanWork(
  on: ApplyContext | { session: TxSession; burrow: BurrowRow; now: Date; signerId: string },
  ref: WorkRef,
): Promise<number> {
  const tx = 'actor' in on ? on.tx : on.session.tx;
  const writerFor =
    'actor' in on
      ? () => commandWriter(on)
      : (signer: string | null) => sessionWriter(on.session, on.burrow, signer ?? on.signerId, on.now);
  const field = FIELD[ref.kind];
  let changed = 0;
  for (const plan of await plansLinkedTo(tx, on.burrow.id, ref))
    if (await followIn(tx, plan, (s) => s[field] === ref.id, writerFor)) changed++;
  return changed;
}

/**
 * Startup reconcile (WS-05): every step that isn't finished and has a link is followed again, one plan per commit,
 * so work that moved while no process was listening (a crash between a run's change and its follow, a dispatch
 * swept while the server was down) shows up. Idempotent: an unchanged projection writes nothing.
 */
export async function reconcilePlans(services: Services): Promise<number> {
  const rows = await services.db
    .select({ id: plans.id, burrowId: plans.burrowId })
    .from(plans)
    .where(
      sql`exists (select 1 from jsonb_array_elements(${plans.steps}) s
            where s->>'state' not in ('done', 'cancelled')
              and (s->>'runId' is not null or s->>'approvalId' is not null
                   or s->>'automationRunId' is not null or s->>'dispatchId' is not null))`,
    );
  let changed = 0;
  for (const row of rows) {
    try {
      const { result } = await services.pipeline.transact(row.burrowId, async (session) => {
        const [burrow] = await session.tx
          .select()
          .from(burrowsTable)
          .where(eq(burrowsTable.id, row.burrowId));
        const [plan] = await session.tx.select().from(plans).where(eq(plans.id, row.id)).for('update');
        if (!burrow || !plan) return false;
        // Signed by whoever the linked work belongs to (the run's agent, the approval's requester, …).
        const writerFor = (signer: string | null) =>
          sessionWriter(session, burrow, signer ?? plan.createdById ?? '', services.clock());
        return followIn(session.tx, plan, (s) => s.state !== 'done' && s.state !== 'cancelled', writerFor);
      });
      if (result) changed++;
    } catch (err) {
      services.log.warn({ err: String(err), planId: row.id }, 'could not reconcile a plan');
    }
  }
  return changed;
}

/**
 * Runtime: a dispatch asked to do a plan step changed state (claimed, running, finished, requeued, swept). Its own
 * commit after the dispatch's (the runtime writes dispatches outside the burrow lock); reads the current state, so
 * a late or repeated call changes nothing.
 */
export async function followDispatch(
  services: Services,
  dispatch: { id: string; burrowId: string; agentId: string; planId: string | null },
): Promise<void> {
  if (!dispatch.planId) return;
  try {
    await services.pipeline.transact(dispatch.burrowId, async (session) => {
      const [burrow] = await session.tx
        .select()
        .from(burrowsTable)
        .where(eq(burrowsTable.id, dispatch.burrowId));
      if (!burrow) return;
      await followPlanWork(
        { session, burrow, now: services.clock(), signerId: dispatch.agentId },
        { kind: 'dispatch', id: dispatch.id },
      );
    });
  } catch (err) {
    services.log.warn({ err: String(err), dispatchId: dispatch.id }, 'could not follow a plan step’s turn');
  }
}

/* Starting a step through a turn (WS-04) ------------------------------------------------------------- */

/**
 * The dispatch queued for a started step (`enqueueDispatches`, inside its commit): the step links it and follows it
 * (“Asked”), and the dispatch carries the step (`DispatchContext.planStep`). Signed as the one who started it.
 */
export async function linkDispatchToStep(
  w: PlanWriter,
  dispatchId: string,
  planStep: { planId: string; stepId: string },
): Promise<void> {
  const plan = await lockPlanRow(w.session.tx, w.burrow.id, planStep.planId);
  if (!plan) return;
  const index = plan.steps.findIndex((s) => s.id === planStep.stepId);
  const step = plan.steps[index];
  if (!step || step.state === 'done' || step.state === 'cancelled') return;
  await w.session.tx
    .update(dispatches)
    .set({ planId: plan.id, planStepId: step.id })
    .where(eq(dispatches.id, dispatchId));
  let next: StoredStep = { ...step, dispatchId };
  const projected = await projectSteps(w.session.tx, { ...plan, steps: [next] }, () => true);
  if (projected) next = projected.steps[0] as StoredStep;
  await savePlan(w, plan, {
    steps: replaceStep(plan.steps, index, next),
    text: null,
    payload: { dispatchId },
  });
}

/** Nobody was woken for a started step (the agent can't be woken there): the step says so instead of waiting. */
export async function stepNotStarted(
  w: PlanWriter,
  planStep: { planId: string; stepId: string },
  why: string,
): Promise<void> {
  const plan = await lockPlanRow(w.session.tx, w.burrow.id, planStep.planId);
  if (!plan) return;
  const index = plan.steps.findIndex((s) => s.id === planStep.stepId);
  const step = plan.steps[index];
  if (!step || step.dispatchId || step.state !== 'active' || step.stateLabel !== 'Asked') return;
  const next: StoredStep = { ...step, state: 'blocked', stateLabel: 'Couldn’t start', note: why };
  await savePlan(w, plan, { steps: replaceStep(plan.steps, index, next), text: null });
}

function replaceStep(steps: readonly StoredStep[], index: number, step: StoredStep): StoredStep[] {
  const next = [...steps];
  next[index] = step;
  return next;
}
