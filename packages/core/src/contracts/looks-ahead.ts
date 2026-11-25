/**
 * Looks ahead (Whombat looks-ahead.md): its switch, calendars, incoming mail switch, standing rules, stopped kinds,
 * what it keeps an eye on, recent checks and an on-demand check, in Settings under the assistant. Session ops `looksAhead.get`,
 * `looksAhead.update` and `looksAhead.checkNow`; the person's own.
 */
import { z } from 'zod';
import { LooksAheadCheckNowResult, LooksAheadUpdate, LooksAheadView } from '../domain/looks-ahead.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const looksAheadEndpoints = {
  get: endpoint({
    id: 'looksAhead.get',
    method: 'GET',
    path: '/burrows/:burrow/looks-ahead',
    summary:
      'Looks ahead: whether the assistant checks upcoming plans and incoming mail, which calendars, standing rules, stopped kinds, what it keeps an eye on, the last week and recent checks.',
    params: B,
    response: LooksAheadView,
  }),
  update: endpoint({
    id: 'looksAhead.update',
    method: 'PUT',
    path: '/burrows/:burrow/looks-ahead',
    summary:
      'Switch Looks ahead, incoming mail, a calendar or a kind of finding on or off, add/remove a standing rule, or stop keeping an eye on something. The person’s own.',
    params: B,
    body: LooksAheadUpdate,
    response: LooksAheadView,
  }),
  checkNow: endpoint({
    id: 'looksAhead.checkNow',
    method: 'POST',
    path: '/burrows/:burrow/looks-ahead/check',
    summary: 'Run one Looks ahead pass right now (fresh calendar and mail read) and return the updated view.',
    params: B,
    body: z.strictObject({}),
    response: LooksAheadCheckNowResult,
  }),
};
