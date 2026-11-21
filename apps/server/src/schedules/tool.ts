/**
 * The `schedule` MCP tool (docs/decisions/resourceful-agents.md RA-30, RA-DC14, RA-DC15): `create` (active at once,
 * here and for the person this turn is for), `list` (what this turn may see, the rest only counted) and `cancel`.
 * Making and cancelling are commit-pipeline commands signed by the agent (`schedules/commands.ts`).
 */
import type { McpToolOutput, ScheduleToolInput } from '@whombat/core';
import type { z } from 'zod';
import { loadBurrowRow } from '../commit/pipeline';
import { ApiError } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { cancelScheduleByAgent, createSchedule } from './commands';
import { type ScheduleRow, schedulesForTurn, toolItem } from './store';

type Output = McpToolOutput<'schedule'>;

/** The burrow's time zone: how `when` is described to the agent. */
async function zoneOf(ctx: ToolContext): Promise<string> {
  return (await loadBurrowRow(ctx.services.db, ctx.burrowId))?.timeZone ?? 'UTC';
}

/** `ok` with `schedule` and what this turn may see now. */
async function okWith(ctx: ToolContext, schedule: ScheduleRow | null): Promise<Output> {
  const now = ctx.services.clock();
  const zone = await zoneOf(ctx);
  const { seen, others } = await schedulesForTurn(ctx.services.db, {
    agentId: ctx.agentId,
    conversationId: ctx.dispatch.conversationId,
    forAccountId: ctx.dispatch.onBehalfOfAccountId,
  });
  return {
    status: 'ok',
    schedule: schedule ? toolItem(schedule, zone, now) : null,
    schedules: seen.map((r) => toolItem(r, zone, now)),
    others,
  } as Output;
}

function options(ctx: ToolContext) {
  return { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf };
}

export async function scheduleTool(
  ctx: ToolContext,
  input: z.output<typeof ScheduleToolInput>,
): Promise<Output> {
  if (input.action === 'list') return okWith(ctx, null);
  if (input.action === 'cancel') {
    const res = await ctx.services.pipeline.commit(
      cancelScheduleByAgent,
      { dispatchId: ctx.dispatch.id, scheduleId: input.scheduleId as string },
      options(ctx),
    );
    if (res.status !== 'ok') return { status: 'unavailable', message: res.message };
    return okWith(ctx, res.result.schedule);
  }
  if (!input.when || !input.prompt) throw new ApiError('validation_failed', 'Say when, and what to do then.');
  const res = await ctx.services.pipeline.commit(
    createSchedule,
    { dispatchId: ctx.dispatch.id, when: input.when, prompt: input.prompt },
    options(ctx),
  );
  if (res.status !== 'ok') return { status: 'unavailable', message: res.message };
  const outcome = res.result;
  if (outcome.status === 'invalid') return { status: 'invalid', problems: outcome.problems.slice(0, 10) };
  if (outcome.status === 'unavailable') return outcome;
  return okWith(ctx, outcome.schedule);
}
