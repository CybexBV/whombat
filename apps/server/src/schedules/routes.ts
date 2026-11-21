/**
 * `schedules.*` (docs/decisions/resourceful-agents.md RA-30, contracts 0.44.0): an agent's schedules on its page (the
 * Schedules tab) and the room card's Cancel. The person sees, pauses, resumes and removes every one (one-person.md
 * OP-S79), each one signed `schedule.*` event (`schedules/commands.ts`).
 */
import { type AnyEndpoint, api } from '@whombat/core';
import { notFound } from '../lib/errors';
import { loadAgentRow } from '../read/principals';
import { commitAs } from '../routes/burrows';
import { type HandlerContext, type RouteDef, route } from '../routes/define';
import { pauseSchedule, removeSchedule, resumeSchedule } from './commands';
import { loadSchedule, schedulesOfAgent, toAgentSchedule } from './store';

async function agentOf(ctx: Pick<HandlerContext<AnyEndpoint>, 'services' | 'access'>) {
  const agent = await loadAgentRow(ctx.services.db, ctx.access.burrow.id);
  if (!agent) throw notFound('Agent');
  return agent;
}

type ScheduleChange = 'pause' | 'resume' | 'remove';
const COMMANDS = { pause: pauseSchedule, resume: resumeSchedule, remove: removeSchedule } as const;

function change(action: ScheduleChange): RouteDef {
  const endpoint: typeof api.schedules.pause = api.schedules[action] as unknown as typeof api.schedules.pause;
  return route(endpoint, async (ctx) => {
    const { eventId } = await commitAs(ctx, COMMANDS[action], { scheduleId: ctx.params.scheduleId });
    const row = await loadSchedule(ctx.services.db, ctx.params.scheduleId);
    if (!row) throw notFound('Schedule');
    return { schedule: toAgentSchedule(row), eventId };
  });
}

export const scheduleRoutes: RouteDef[] = [
  route(api.schedules.list, async (ctx) => {
    const agent = await agentOf(ctx);
    return { schedules: await schedulesOfAgent(ctx.services.db, agent, ctx.services.clock()) };
  }),
  change('pause'),
  change('resume'),
  change('remove'),
];
