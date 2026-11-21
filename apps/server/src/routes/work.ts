import { api } from '@whombat/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { decideApproval, undoDecision } from '../commands/approvals';
import {
  addPlanStep,
  createPlan,
  createPlanCanvas,
  removePlanStep,
  startPlanStep,
  updatePlan,
  updatePlanStep,
} from '../commands/plans';
import { mergePr } from '../commands/prs';
import { retryRun } from '../commands/run-recovery';
import { pauseRun, resumeRun, takeOverRun } from '../commands/runs';
import { canvases, plans, pullRequests, repos, runs } from '../db/schema/index';
import { prFileView } from '../github/pr-file';
import { notFound } from '../lib/errors';
import { type PrincipalRow, principalByHandle } from '../read/principals';
import {
  approvalByNumber,
  approvalForViewer,
  lastDecisionEventId,
  loadPlan,
  loadPlans,
  loadPullRequests,
  loadRun,
  loadRuns,
  prByNumber,
  runByNumber,
  runLogLines,
  toApproval,
} from '../read/work';
import {
  approvalList,
  approvalVisible,
  canvasDetail,
  prDetail,
  readableRun,
  runDetail,
} from '../read/work-views';
import type { Services } from '../services';
import { commitAs } from './burrows';
import { route } from './define';

export const workRoutes = [
  route(api.prs.list, async ({ access, query, services }) => {
    const where = [eq(pullRequests.burrowId, access.burrow.id), eq(repos.enabled, true)];
    if (query.state) where.push(eq(pullRequests.state, query.state));
    const rows = await services.db
      .select({ pr: pullRequests })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(and(...where))
      .orderBy(desc(pullRequests.openedAt));
    return {
      prs: await loadPullRequests(
        services.db,
        rows.map((r) => r.pr),
      ),
    };
  }),

  route(api.prs.get, async ({ access, params, query, services }) => {
    const row = await prByNumber(services.db, access.burrow.id, params.number, query.repo);
    if (!row) throw notFound('Pull request');
    return prDetail(services.db, access.principal, row);
  }),

  // CT-241: one file of the PR, whole (pr-file-view.md PF-01): a read, as visible as the PR itself.
  route(api.prs.file, async ({ access, params, query, services }) => {
    const row = await prByNumber(services.db, access.burrow.id, params.number, query.repo);
    if (!row) throw notFound('Pull request');
    return prFileView(services, access.principal, row, query.path);
  }),

  route(api.prs.merge, async (ctx) => {
    await commitAs(ctx, mergePr, {
      number: ctx.params.number,
      repo: ctx.query.repo,
      method: ctx.body.method,
    });
    const row = await prByNumber(ctx.services.db, ctx.access.burrow.id, ctx.params.number, ctx.query.repo);
    if (!row) throw notFound('Pull request');
    return prDetail(ctx.services.db, ctx.access.principal, row);
  }),

  route(api.runs.list, async ({ access, query, services }) => {
    const where = [eq(runs.burrowId, access.burrow.id)];
    if (query.status) where.push(eq(runs.status, query.status));
    if (query.agent) {
      const agent = await principalByHandle(services.db, access.burrow.id, query.agent);
      if (!agent) return { runs: [] };
      where.push(eq(runs.agentId, agent.id));
    }
    const rows = await services.db
      .select()
      .from(runs)
      .where(and(...where))
      .orderBy(desc(runs.startedAt))
      .limit(query.limit);
    return { runs: await loadRuns(services.db, rows) };
  }),

  route(api.runs.get, async ({ access, params, services }) => {
    const row = readableRun(
      access.principal,
      await runByNumber(services.db, access.burrow.id, params.number),
    );
    return runDetail(services.db, access.principal, row);
  }),

  route(api.runs.log, async ({ access, params, query, services }) => {
    const row = readableRun(
      access.principal,
      await runByNumber(services.db, access.burrow.id, params.number),
    );
    const lines = await runLogLines(services.db, row.id, { after: query.after, limit: query.limit + 1 });
    return { lines: lines.slice(0, query.limit), hasMore: lines.length > query.limit };
  }),

  route(api.runs.pause, async (ctx) => {
    const { runId } = await commitAs(ctx, pauseRun, { number: ctx.params.number });
    const run = await loadRun(ctx.services.db, runId);
    if (!run) throw notFound('Run');
    return { run };
  }),

  route(api.runs.resume, async (ctx) => {
    const { runId } = await commitAs(ctx, resumeRun, { number: ctx.params.number });
    const run = await loadRun(ctx.services.db, runId);
    if (!run) throw notFound('Run');
    return { run };
  }),

  route(api.runs.retry, async (ctx) => {
    const { runId } = await commitAs(ctx, retryRun, { number: ctx.params.number });
    const run = await loadRun(ctx.services.db, runId);
    if (!run) throw notFound('Run');
    return { run };
  }),

  route(api.runs.takeOver, async (ctx) => {
    const { runId, branch } = await commitAs(ctx, takeOverRun, { number: ctx.params.number });
    const run = await loadRun(ctx.services.db, runId);
    if (!run) throw notFound('Run');
    return {
      run,
      branch,
      instructions: `git fetch origin ${branch} && git switch ${branch}`,
    };
  }),

  route(api.approvals.list, async ({ access, query, services }) =>
    approvalList(services.db, access.principal, access.burrow.id, {
      ...(query.state ? { state: query.state } : {}),
      ...(query.before ? { before: query.before } : {}),
      limit: query.limit,
    }),
  ),

  route(api.approvals.get, async ({ access, params, services }) => {
    const row = await approvalByNumber(services.db, access.burrow.id, params.number);
    if (!row) throw notFound('Request');
    const approval = toApproval(row);
    if (!(await approvalVisible(services.db, access.principal, approval))) throw notFound('Request');
    return {
      approval: await approvalForViewer(services.db, access.principal.id, row),
      eventId: await lastDecisionEventId(services.db, approval.id),
    };
  }),

  route(api.approvals.decide, async (ctx) => {
    // Someone who can't see a request gets the same 404 as for one that doesn't exist (no existence oracle).
    await requireVisibleApproval(ctx.services, ctx.access, ctx.params.number);
    const { eventId } = await commitAs(ctx, decideApproval, { number: ctx.params.number, ...ctx.body });
    const row = await approvalByNumber(ctx.services.db, ctx.access.burrow.id, ctx.params.number);
    if (!row) throw notFound('Request');
    return { approval: await approvalForViewer(ctx.services.db, ctx.access.principal.id, row), eventId };
  }),

  route(api.approvals.undo, async (ctx) => {
    await requireVisibleApproval(ctx.services, ctx.access, ctx.params.number);
    const { eventId } = await commitAs(ctx, undoDecision, { number: ctx.params.number });
    const row = await approvalByNumber(ctx.services.db, ctx.access.burrow.id, ctx.params.number);
    if (!row) throw notFound('Request');
    return { approval: await approvalForViewer(ctx.services.db, ctx.access.principal.id, row), eventId };
  }),

  route(api.plans.list, async ({ access, query, services }) => {
    // Every conversation of the burrow is the person's: its plans, or one room's.
    const where = [eq(plans.burrowId, access.burrow.id)];
    if (query.conversationId) where.push(eq(plans.conversationId, query.conversationId));
    // Open: some step still to do (or none yet).
    if (query.status === 'open')
      where.push(
        sql`(jsonb_array_length(${plans.steps}) = 0 or exists (select 1 from jsonb_array_elements(${plans.steps}) s
              where s->>'state' not in ('done', 'cancelled')))`,
      );
    const rows = await services.db
      .select({ id: plans.id })
      .from(plans)
      .where(and(...where))
      .orderBy(desc(plans.updatedAt), desc(plans.id))
      .limit(query.limit);
    const loaded = await loadPlans(
      services.db,
      rows.map((r) => r.id),
    );
    return { plans: rows.flatMap((r) => loaded.get(r.id) ?? []) };
  }),

  route(api.plans.get, async ({ access, params, services }) => {
    return { plan: await visiblePlan(services, access, params.planId) };
  }),

  route(api.plans.create, async (ctx) => {
    const { planId } = await commitAs(ctx, createPlan, ctx.body);
    return { plan: await visiblePlan(ctx.services, ctx.access, planId) };
  }),

  route(api.plans.update, async (ctx) => {
    await visiblePlan(ctx.services, ctx.access, ctx.params.planId);
    await commitAs(ctx, updatePlan, { planId: ctx.params.planId, ...ctx.body });
    return { plan: await visiblePlan(ctx.services, ctx.access, ctx.params.planId) };
  }),

  route(api.plans.addStep, async (ctx) => {
    await visiblePlan(ctx.services, ctx.access, ctx.params.planId);
    await commitAs(ctx, addPlanStep, { planId: ctx.params.planId, ...ctx.body });
    return { plan: await visiblePlan(ctx.services, ctx.access, ctx.params.planId) };
  }),

  route(api.plans.updateStep, async (ctx) => {
    await visiblePlan(ctx.services, ctx.access, ctx.params.planId);
    await commitAs(ctx, updatePlanStep, {
      planId: ctx.params.planId,
      stepId: ctx.params.stepId,
      ...ctx.body,
    });
    return { plan: await visiblePlan(ctx.services, ctx.access, ctx.params.planId) };
  }),

  route(api.plans.removeStep, async (ctx) => {
    await visiblePlan(ctx.services, ctx.access, ctx.params.planId);
    await commitAs(ctx, removePlanStep, { planId: ctx.params.planId, stepId: ctx.params.stepId });
    return { plan: await visiblePlan(ctx.services, ctx.access, ctx.params.planId) };
  }),

  route(api.plans.startStep, async (ctx) => {
    await visiblePlan(ctx.services, ctx.access, ctx.params.planId);
    const started = await commitAs(ctx, startPlanStep, {
      planId: ctx.params.planId,
      stepId: ctx.params.stepId,
      ...ctx.body,
    });
    // The mention's dispatch is queued in the post-commit hook, before the commit returns (WS-04).
    const plan = await visiblePlan(ctx.services, ctx.access, ctx.params.planId);
    const step = plan.steps.find((s) => s.id === ctx.params.stepId);
    return {
      plan,
      dispatchId: started.dispatchId ?? ('posted' in started ? (step?.dispatchId ?? null) : null),
      messageId: started.messageId,
      automationRunNumber: started.automationRunNumber,
    };
  }),

  route(api.plans.createCanvas, async (ctx) => {
    await visiblePlan(ctx.services, ctx.access, ctx.params.planId);
    const made = await commitAs(ctx, createPlanCanvas, { planId: ctx.params.planId });
    const [row] = await ctx.services.db.select().from(canvases).where(eq(canvases.id, made.canvasId));
    if (!row) throw notFound('Canvas');
    const { canvas } = await canvasDetail(ctx.services.db, row);
    return { plan: await visiblePlan(ctx.services, ctx.access, ctx.params.planId), canvas };
  }),
];

/** The burrow's plan; the same 404 as for a missing one otherwise (WS-10). */
async function visiblePlan(
  services: Services,
  access: { principal: PrincipalRow; burrow: { id: string } },
  planId: string,
) {
  const plan = await loadPlan(services.db, planId);
  if (!plan || plan.burrowId !== access.burrow.id) throw notFound('Plan');
  return plan;
}

/** The approval `number` exists and `access.principal` may see it; else the same 404 as for a missing one. */
async function requireVisibleApproval(
  services: Services,
  access: { principal: PrincipalRow; burrow: { id: string } },
  number: number,
): Promise<void> {
  const row = await approvalByNumber(services.db, access.burrow.id, number);
  if (!row || !(await approvalVisible(services.db, access.principal, toApproval(row))))
    throw notFound('Request');
}
