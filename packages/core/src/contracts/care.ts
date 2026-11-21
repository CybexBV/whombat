/**
 * A Whombat's quiet hours for changes (Whombat docs/decisions/care-plan.md): when changes that can wait happen — the
 * care plans' updates and restarts, an approval's *Tonight* — from `start` to `end` in its time zone, 03:00–05:00 until
 * the person moves them. Read by anyone who uses the Whombat; changed by the person, signed.
 */
import { z } from 'zod';
import { ChangeWindow } from '../domain/care-plan.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

/** The quiet hours, the zone they are read in, and whether the person moved them (`default`: never). */
export const ChangeWindowView = z.object({
  window: ChangeWindow,
  timeZone: z.string().min(1).max(64),
  default: z.boolean(),
});
export type ChangeWindowView = z.infer<typeof ChangeWindowView>;

export const SetChangeWindowBody = z.object({ window: ChangeWindow });
export type SetChangeWindowBody = z.infer<typeof SetChangeWindowBody>;

export const changeWindowEndpoints = {
  get: endpoint({
    id: 'changeWindow.get',
    method: 'GET',
    path: '/burrows/:burrow/change-window',
    summary:
      'The Whombat’s quiet hours for changes: when updates, restarts and “Tonight” approvals happen, in its time zone.',
    params: B,
    response: ChangeWindowView,
  }),
  set: endpoint({
    id: 'changeWindow.set',
    method: 'PUT',
    path: '/burrows/:burrow/change-window',
    summary:
      'Move the quiet hours for changes. Schedules made from them before keep their times; new ones and “Tonight” use these. 403 when the caller may not.',
    params: B,
    body: SetChangeWindowBody,
    response: ChangeWindowView,
  }),
};
