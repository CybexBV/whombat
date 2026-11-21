/**
 * The agent's schedules as people manage them (Whombat resourceful-agents.md RA-30, contracts 0.44.0): Settings →
 * Agent's Schedules and the room card's Cancel. Session ops too (`schedules.*`).
 *
 * - `schedules.list`: the agent's schedules: active and paused ones, and those that ended in the last 7 days
 *   (`AgentScheduleView`).
 * - `schedules.pause`, `schedules.resume`, `schedules.remove`: the person's. Resume continues a paused one, or renews one that ran its 90
 *   days (`expired`) for 90 more. Remove (the card's Cancel too) ends it (`cancelled`). Each signs a `schedule.*` event.
 */
import { z } from 'zod';
import { AgentScheduleView } from '../domain/schedules.js';
import { AgentScheduleId, EventId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const BA = z.object({ burrow: BurrowParam });
const BAS = BA.extend({ scheduleId: AgentScheduleId });

export const AgentSchedulesResponse = z.object({ schedules: z.array(AgentScheduleView) });
export type AgentSchedulesResponse = z.infer<typeof AgentSchedulesResponse>;

/** A change to one schedule: it as it is now, and the signed event. */
export const AgentScheduleResponse = z.object({ schedule: AgentScheduleView, eventId: EventId.nullable() });
export type AgentScheduleResponse = z.infer<typeof AgentScheduleResponse>;

export const scheduleEndpoints = {
  list: endpoint({
    id: 'schedules.list',
    method: 'GET',
    path: '/burrows/:burrow/agent/schedules',
    summary:
      'Turns the agent scheduled for itself (the Schedules tab): active, paused and recently ended, the prompt only where the viewer can read the room.',
    params: BA,
    response: AgentSchedulesResponse,
  }),
  pause: endpoint({
    id: 'schedules.pause',
    method: 'POST',
    path: '/burrows/:burrow/agent/schedules/:scheduleId/pause',
    summary:
      'Pause a schedule (the person it is for, or people who hold `agents.manage`). Signs `schedule.paused`.',
    params: BAS,
    response: AgentScheduleResponse,
  }),
  resume: endpoint({
    id: 'schedules.resume',
    method: 'POST',
    path: '/burrows/:burrow/agent/schedules/:scheduleId/resume',
    summary:
      'Resume a paused schedule, or renew one that ran its 90 days for 90 more. Signs `schedule.resumed`.',
    params: BAS,
    response: AgentScheduleResponse,
  }),
  remove: endpoint({
    id: 'schedules.remove',
    method: 'DELETE',
    path: '/burrows/:burrow/agent/schedules/:scheduleId',
    summary:
      'End a schedule for good (Remove on the tab, Cancel on the room card). The person it is for, or people who hold `agents.manage`. Signs `schedule.ended`.',
    params: BAS,
    response: AgentScheduleResponse,
  }),
};
