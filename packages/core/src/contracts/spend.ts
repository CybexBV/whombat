/**
 * Spend (Whombat spend.md SP-01, SP-02): read-only views of what the agent's turns used. No realtime frames: clients
 * refetch on open.
 */
import { z } from 'zod';
import { SpendAgentWeek, SpendDaily, SpendOverview } from '../domain/spend.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const spendEndpoints = {
  overview: endpoint({
    id: 'spend.overview',
    method: 'GET',
    path: '/burrows/:burrow/spend',
    summary:
      'Settings → Agent → Spend: turns, tokens and reported cost for today, 7 and 30 days, and the plans that used the most.',
    params: B,
    response: SpendOverview,
  }),
  week: endpoint({
    id: 'spend.week',
    method: 'GET',
    path: '/burrows/:burrow/spend/week',
    summary: 'Settings → Agent’s “This week” line: the agent’s turns in the last 7 days.',
    params: B,
    response: SpendAgentWeek,
  }),
  daily: endpoint({
    id: 'spend.daily',
    method: 'GET',
    path: '/burrows/:burrow/spend/daily',
    summary:
      'Settings → This Whombat → How it’s doing: turns and tokens per day for the last 30 days in the burrow’s time zone, today last.',
    params: B,
    response: SpendDaily,
  }),
};
