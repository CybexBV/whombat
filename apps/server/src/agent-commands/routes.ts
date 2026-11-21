/**
 * The agent's commands over HTTP (docs/decisions/agent-computer.md AC-41, AC-42; one-person.md OP-07, OP-S43,
 * OP-S109): the runner's endpoints (runner token, and the dispatch's lease as a fencing token on every call) and the
 * agent's Access settings list of commands always allowed.
 *
 * - `runner.turnKeys`: the turn's keys (`keys.ts`).
 * - `runner.notify`: a background job's `whombat notify` wakes the agent (`runtime/job-notify.ts`), fenced by the
 *   runner and the attempt of the turn that started the job.
 * - `runner.authorizeCommand`: run / blocked / pending (`commands.ts`).
 * - `runner.authorizeWait`: a long poll (at most `waitMs`, 25 s by default) on the `run_command` approval: woken by the
 *   decision itself, else it looks again every second. `run` (with the scope and the openings), `declined`, or
 *   `pending` still — the runner asks again until its wait is over (exit 125).
 */
import {
  actionScope,
  api,
  commandAllowedText,
  commandBlockedText,
  commandCategoryKey,
  commandDeclinedText,
  decide,
  describeDecision,
  runnerApi,
} from '@whombat/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { approvals, commandPasses, dispatches } from '../db/schema/index';
import { ghTurnOf } from '../github/agent-gh';
import { ApiError, notFound } from '../lib/errors';
import { onBehalfOf } from '../mcp/tools';
import { loadAgentRow, loadGrants, loadPrincipalRow, shortName } from '../read/principals';
import { commitAs } from '../routes/burrows';
import { ok, type RouteDef, route, runnerRoute } from '../routes/define';
import { dispatchScopeOf, runInDispatchScope } from '../runtime/dispatch-scope';
import { NOTIFY_REFUSALS, takeJobNotify } from '../runtime/job-notify';
import { disconnectSignal, requireRunner } from '../runtime/routes';
import type { Services } from '../services';
import {
  allowancesOf,
  authorizeCommand,
  classifyAgain,
  commandPassOf,
  openingsFor,
  removeCommandAllowance,
} from './commands';
import { turnKeysFor } from './keys';
import { approvalChangeOrTimeout } from './waiters';

/** The person who decided, by short name (“Mara”). */
async function deciderName(services: Services, id: string | null): Promise<string> {
  const row = id ? await loadPrincipalRow(services.db, id) : undefined;
  return row ? shortName(row) : 'A person';
}

/**
 * One look at a `run_command` approval for a waiting runner: `run` once a person said yes (the pass is delivered, a
 * `once` pass spent), `declined` after a no — or a yes whose key was taken away since — and null while it waits.
 */
async function lookAt(
  services: Services,
  dispatch: typeof dispatches.$inferSelect,
  approvalId: string,
): Promise<
  | {
      outcome: 'run';
      scope: 'once' | 'task' | 'agent';
      message: string;
      open: { host: string; port: number | null }[];
    }
  | { outcome: 'declined'; scope: null; message: string; open: [] }
  | null
> {
  const now = services.clock();
  await services.pipeline.transactAccount((tx) =>
    tx.update(commandPasses).set({ polledAt: now }).where(eq(commandPasses.approvalId, approvalId)),
  );
  const [row] = await services.db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (row?.action.type !== 'run_command') throw notFound('Approval');
  if (row.state === 'pending') return null;
  const name = await deciderName(services, row.decidedById);
  if (row.state !== 'approved')
    return {
      outcome: 'declined',
      scope: null,
      // A web or browser tool's no (HE-44, CT-1236): “it didn't happen”.
      message: commandDeclinedText(name, row.action.params.category),
      open: [],
    };
  // A key taken away (or set to Off) after the yes stops the command (as `keysStillTurn` stops an execution).
  const action = row.action;
  const decision = decide(
    { id: dispatch.agentId, kind: 'agent' },
    await loadGrants(services.db, dispatch.agentId),
    commandCategoryKey(action.params.category),
    actionScope(action),
  );
  if (decision.outcome === 'deny')
    return {
      outcome: 'declined',
      scope: null,
      message: describeDecision(decision, await deciderName(services, dispatch.agentId)),
      open: [],
    };
  const scope = row.scope ?? 'once';
  // Delivered: the yes reached the command in its turn, so nobody is woken for it; a `once` pass is spent by it.
  await services.pipeline.transactAccount((tx) =>
    tx
      .update(commandPasses)
      .set({
        deliveredAt: sql`coalesce(${commandPasses.deliveredAt}, ${now.toISOString()}::timestamptz)`,
        ...(scope === 'once'
          ? { usedAt: sql`coalesce(${commandPasses.usedAt}, ${now.toISOString()}::timestamptz)` }
          : {}),
      })
      .where(and(eq(commandPasses.approvalId, approvalId), isNull(commandPasses.wokenAt))),
  );
  return {
    outcome: 'run',
    scope,
    message: commandAllowedText(scope, name),
    open: await openingsFor(services, dispatch.burrowId, action.params.category, action.params.target),
  };
}

export const agentCommandRoutes: RouteDef[] = [
  runnerRoute(runnerApi.turnKeys, async ({ params, query, req, services }) => {
    requireRunner(services, req);
    const dispatch = await services.runtime.liveDispatch(params.dispatchId, {
      runnerId: query.runnerId,
      attempt: query.attempt,
    });
    return turnKeysFor(services, dispatch);
  }),

  runnerRoute(runnerApi.notify, async ({ body, req, services }) => {
    requireRunner(services, req);
    // Fenced by the runner and the attempt of the turn that started the job (its turn may have ended since).
    const [origin] = await services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, body.fromDispatchId));
    if (!origin) throw notFound('Turn');
    if (origin.runnerId !== body.runnerId || origin.attempts !== body.attempt)
      throw new ApiError('conflict', 'This runner didn’t run that turn.');
    const out = await takeJobNotify(services, body);
    if (out?.outcome === 'woken') return { dispatchId: out.dispatchId };
    if (out?.outcome === 'duplicate') {
      const [turn] = await services.db
        .select({ id: dispatches.id })
        .from(dispatches)
        .where(and(eq(dispatches.messageId, out.messageId), eq(dispatches.trigger, 'notify')));
      if (turn) return { dispatchId: turn.id };
      throw new ApiError('conflict', 'That notice was taken, and its turn is gone.');
    }
    const reason = out?.reason;
    const message = reason ? `Not taken: ${NOTIFY_REFUSALS[reason]}.` : 'Not taken.';
    if (reason === 'unknown_turn') throw notFound('Turn');
    if (reason === 'other_agent' || reason === 'outside') throw new ApiError('forbidden', message);
    if (reason === 'too_many') throw new ApiError('rate_limited', message);
    if (reason === 'empty') throw new ApiError('validation_failed', message);
    throw new ApiError('conflict', message);
  }),

  runnerRoute(runnerApi.authorizeCommand, async ({ body, req, services }) => {
    requireRunner(services, req);
    const dispatch = await services.runtime.liveDispatch(body.dispatchId, body);
    // The guard leaves gh alone where it goes through Whombat (agent-gh.md AGH-11), as the runner's does.
    const gh = (await ghTurnOf(services, dispatch)).context;
    const asked = await classifyAgain(services, dispatch.burrowId, body, { ghThroughWhombat: gh !== null });
    const behalf = await onBehalfOf(services, dispatch);
    const res = await runInDispatchScope(dispatchScopeOf(dispatch), () =>
      services.pipeline.commit(
        authorizeCommand,
        {
          dispatchId: dispatch.id,
          command: body.command,
          category: asked.category,
          target: asked.target,
          reason: body.reason ?? null,
        },
        { burrowId: dispatch.burrowId, actorId: dispatch.agentId, onBehalfOf: behalf },
      ),
    );
    if (res.status === 'blocked') {
      const agent = await loadPrincipalRow(services.db, dispatch.agentId);
      return {
        outcome: 'blocked' as const,
        approvalId: null,
        message: commandBlockedText(asked.category, agent ? shortName(agent) : 'the agent'),
        open: [],
      };
    }
    const result = ok(res);
    if (result.outcome === 'why')
      return { outcome: 'blocked' as const, approvalId: null, message: result.message, open: [] };
    if (result.outcome === 'pending')
      return {
        outcome: 'pending' as const,
        approvalId: result.approvalId,
        message: result.message,
        open: [],
      };
    return { outcome: 'run' as const, approvalId: result.approvalId, message: '', open: result.open };
  }),

  runnerRoute(
    runnerApi.authorizeWait,
    async ({ params, query, req, reply, services }) => {
      requireRunner(services, req);
      const dispatch = await services.runtime.liveDispatch(query.dispatchId, query);
      const pass = await commandPassOf(services.db, params.approvalId);
      if (!pass || pass.agentId !== dispatch.agentId || pass.burrowId !== dispatch.burrowId)
        throw notFound('Approval');
      const signal = disconnectSignal(reply);
      const deadline = Date.now() + query.waitMs;
      for (;;) {
        const answer = await lookAt(services, dispatch, pass.approvalId);
        if (answer) return answer;
        const left = deadline - Date.now();
        if (left <= 0 || signal.aborted) break;
        await approvalChangeOrTimeout(services, pass.approvalId, Math.min(1000, left), signal);
      }
      return { outcome: 'pending' as const, scope: null, message: '', open: [] };
    },
    { logLevel: 'warn' },
  ),

  route(api.agent.commandAllowances, async ({ access, services }) => {
    const agent = await loadAgentRow(services.db, access.burrow.id);
    if (!agent) throw notFound('Agent');
    return { allowances: await allowancesOf(services.db, agent.id) };
  }),

  route(api.agent.removeCommandAllowance, async (ctx) => {
    const { agentId, eventId } = await commitAs(ctx, removeCommandAllowance, {
      allowanceId: ctx.params.allowanceId,
    });
    return { allowances: await allowancesOf(ctx.services.db, agentId), eventId };
  }),
];
