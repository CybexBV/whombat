/**
 * Observed activity and the Work view (docs/decisions/work-supervision.md WS-16, WS-18), what agents' turns used
 * (docs/decisions/spend.md SP-01, SP-02; per day, box-status.md BS-07), trying a failed turn again
 * (essentials-agents.md EA-09), stopping a turn and the needs-you count (docs/decisions/review-features.md RF-01, RF-06).
 */
import { api } from '@whombat/core';
import { activityList } from '../read/activity';
import { needsYouCount } from '../read/needs-you';
import { spendAgentWeek, spendDaily, spendOverview } from '../read/spend';
import { workOverview } from '../read/work-overview';
import { retryDispatch } from '../runtime/failure';
import { cancelDispatch } from '../runtime/stop';
import { commitAs } from './burrows';
import { route } from './define';

export const supervisionRoutes = [
  route(api.activity.list, async ({ access, query, services }) =>
    activityList(services.db, access.principal, access.burrow.id, query),
  ),

  route(api.work.overview, async ({ access, services }) =>
    workOverview(services, access.principal, access.burrow.id),
  ),

  route(api.spend.overview, async ({ access, services }) =>
    spendOverview(services, access.principal, access.burrow),
  ),

  route(api.spend.week, async ({ access, services }) =>
    spendAgentWeek(services, access.principal, access.burrow),
  ),

  // Tokens per day for Settings → This Whombat → How it’s doing (docs/decisions/box-status.md BS-07).
  route(api.spend.daily, async ({ access, services }) =>
    spendDaily(services, access.principal, access.burrow),
  ),

  // “Try again” on a failed turn (docs/decisions/essentials-agents.md EA-09): once per turn, a second press answers
  // with the first retry.
  route(api.dispatches.retry, async (ctx) =>
    commitAs(ctx, retryDispatch, { dispatchId: ctx.params.dispatchId }),
  ),

  // Stop on an agent's turn (review-features.md RF-01): a second press answers with how the turn ended.
  route(api.dispatches.cancel, async (ctx) =>
    commitAs(ctx, cancelDispatch, { dispatchId: ctx.params.dispatchId }),
  ),

  // How many things wait on the viewer: the only place that number is counted (bootstrap's field is always 0).
  route(api.work.needsYou, async ({ access, services }) => ({
    count: await needsYouCount(services.db, access.burrow.id, access.principal),
  })),
];
