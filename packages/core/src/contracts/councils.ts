/**
 * The council's buttons for the person (Whombat docs/decisions/council.md CNL-20, CNL-43): Go ahead on a plan the members
 * agreed on starts the builder; Stop ends the council and everything of it that still works. Session ops too
 * (`councils.*`); a Whombat without them answers `unknown_op`.
 */
import { z } from 'zod';
import {
  CouncilProviderOption,
  CouncilScore,
  CouncilSeatSetup,
  CouncilSetup,
  CouncilStage,
} from '../domain/council.js';
import { CouncilId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const CouncilActionBody = z.strictObject({ councilId: CouncilId });
export type CouncilActionBody = z.infer<typeof CouncilActionBody>;

/** Where the council is after the press. */
export const CouncilActionResponse = z.object({ councilId: CouncilId, stage: CouncilStage });
export type CouncilActionResponse = z.infer<typeof CouncilActionResponse>;

/**
 * The person's council (Whombat council.md CNL-50…CNL-54): what they set (null: none, Whombat seats its own), what
 * Whombat seats now (`automatic`), and what T3 Code can run now to choose from (`options`; null when T3 Code isn't
 * connected at Manage or can't be reached, `t3` says which).
 */
export const CouncilSetupResponse = z.object({
  setup: CouncilSetup.nullable(),
  automatic: z.array(CouncilSeatSetup),
  options: z.array(CouncilProviderOption).nullable(),
  t3: z.enum(['ready', 'not_connected', 'unreachable']),
});
export type CouncilSetupResponse = z.infer<typeof CouncilSetupResponse>;

/** The council to keep: its seats, the seat that builds, its rounds and the score to reach. */
export const SaveCouncilSetupBody = z.strictObject({
  seats: z.array(CouncilSeatSetup).min(2).max(4),
  builder: z.number().int().min(0).max(3),
  rounds: z.number().int().min(1).max(5),
  target: CouncilScore,
});
export type SaveCouncilSetupBody = z.infer<typeof SaveCouncilSetupBody>;

export const SaveCouncilSetupResponse = z.object({ setup: CouncilSetup });
export type SaveCouncilSetupResponse = z.infer<typeof SaveCouncilSetupResponse>;

export const ResetCouncilSetupResponse = z.object({ setup: z.null() });

export const councilEndpoints = {
  goAhead: endpoint({
    id: 'councils.goAhead',
    method: 'POST',
    path: '/burrows/:burrow/councils/go-ahead',
    summary:
      'Go ahead on the plan a council agreed on, from before councils built through a T3 Code checklist (Whombat council.md CNL-60): always 409 now, the checklist’s Hand over is the go-ahead.',
    params: B,
    body: CouncilActionBody,
    response: CouncilActionResponse,
  }),
  stop: endpoint({
    id: 'councils.stop',
    method: 'POST',
    path: '/burrows/:burrow/councils/stop',
    summary:
      'Stop a council: every member and the tasks of its checklist stop, and it ends as stopped. 404 when it is gone.',
    params: B,
    body: CouncilActionBody,
    response: CouncilActionResponse,
  }),
  setup: endpoint({
    id: 'councils.setup',
    method: 'GET',
    path: '/burrows/:burrow/councils/setup',
    summary:
      'The person’s council (null: none set, Whombat seats its own), what Whombat seats now, and the providers, models and efforts T3 Code can run now.',
    params: B,
    response: CouncilSetupResponse,
  }),
  saveSetup: endpoint({
    id: 'councils.saveSetup',
    method: 'POST',
    path: '/burrows/:burrow/councils/setup',
    summary:
      'Keep the council: who sits on it with which model and effort, the seat that builds, its rounds and the score to reach. 400 (validation_failed, with the reason) when its seats break the rules (two companies at least, no model twice).',
    params: B,
    body: SaveCouncilSetupBody,
    response: SaveCouncilSetupResponse,
  }),
  resetSetup: endpoint({
    id: 'councils.resetSetup',
    method: 'POST',
    path: '/burrows/:burrow/councils/setup/reset',
    summary: 'Forget the person’s council: Whombat seats its own again.',
    params: B,
    body: z.strictObject({}),
    response: ResetCouncilSetupResponse,
  }),
} as const;
