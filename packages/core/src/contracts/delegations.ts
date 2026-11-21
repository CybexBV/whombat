/**
 * The delegation card's buttons for the person (Whombat docs/decisions/delegate.md): tick or untick a task on the
 * checklist, hand the ticked ones over, stop one task, or stop it all (also “Not now” on a checklist). Session ops too
 * (`delegations.*`); a Whombat without them answers `unknown_op`.
 */
import { z } from 'zod';
import { CouncilProviderOption } from '../domain/council.js';
import { DelegationStage } from '../domain/delegation.js';
import { DelegationId, DelegationTaskId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const DelegationActionBody = z.strictObject({ delegationId: DelegationId });
export type DelegationActionBody = z.infer<typeof DelegationActionBody>;

export const DelegationPickBody = z.strictObject({
  delegationId: DelegationId,
  taskId: DelegationTaskId,
  picked: z.boolean(),
});
export type DelegationPickBody = z.infer<typeof DelegationPickBody>;

export const DelegationTaskBody = z.strictObject({ delegationId: DelegationId, taskId: DelegationTaskId });
export type DelegationTaskBody = z.infer<typeof DelegationTaskBody>;

/**
 * The AI chosen on the checklist: T3 Code's provider instance and model, an effort the model takes (null: its own) and
 * its fast tier (null: its own).
 */
export const DelegationAiChoice = z.strictObject({
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(80),
  effort: z.string().trim().min(1).max(20).nullable(),
  fast: z.boolean().nullable(),
});
export type DelegationAiChoice = z.infer<typeof DelegationAiChoice>;

/** The AI for one task (`taskId`) or for every task without a choice of its own (no `taskId`); null: the default. */
export const DelegationAiBody = z.strictObject({
  delegationId: DelegationId,
  taskId: DelegationTaskId.optional(),
  ai: DelegationAiChoice.nullable(),
});
export type DelegationAiBody = z.infer<typeof DelegationAiBody>;

/** What T3 Code can run now, to choose a task's AI from (null when it isn't connected or can't be reached). */
export const DelegationModelsResponse = z.object({
  options: z.array(CouncilProviderOption).nullable(),
  t3: z.enum(['ready', 'not_connected', 'unreachable']),
});
export type DelegationModelsResponse = z.infer<typeof DelegationModelsResponse>;

/** Where the delegation is after the press. */
export const DelegationActionResponse = z.object({ delegationId: DelegationId, stage: DelegationStage });
export type DelegationActionResponse = z.infer<typeof DelegationActionResponse>;

export const delegationEndpoints = {
  pick: endpoint({
    id: 'delegations.pick',
    method: 'POST',
    path: '/burrows/:burrow/delegations/pick',
    summary:
      'Tick or untick a task on a delegation’s checklist. 404 when it is gone; 409 when the checklist was handed over already.',
    params: B,
    body: DelegationPickBody,
    response: DelegationActionResponse,
  }),
  start: endpoint({
    id: 'delegations.start',
    method: 'POST',
    path: '/burrows/:burrow/delegations/start',
    summary:
      'Hand the ticked tasks to T3 Code: each starts in a thread of its own, a few at once. 404 when it is gone; 409 when nothing is ticked or it was handed over already.',
    params: B,
    body: DelegationActionBody,
    response: DelegationActionResponse,
  }),
  setAi: endpoint({
    id: 'delegations.setAi',
    method: 'POST',
    path: '/burrows/:burrow/delegations/ai',
    summary:
      'Choose the AI (model, effort, fast tier) one task of a checklist runs with, or every task without a choice of its own; null goes back to the default. 404 when it is gone; 409 when it was handed over already; 400 when T3 Code can’t run that model now.',
    params: B,
    body: DelegationAiBody,
    response: DelegationActionResponse,
  }),
  models: endpoint({
    id: 'delegations.models',
    method: 'GET',
    path: '/burrows/:burrow/delegations/models',
    summary:
      'The providers, models, efforts and fast tiers T3 Code can run now, to choose a task’s AI from on a checklist.',
    params: B,
    response: DelegationModelsResponse,
  }),
  stopTask: endpoint({
    id: 'delegations.stopTask',
    method: 'POST',
    path: '/burrows/:burrow/delegations/stop-task',
    summary: 'Stop one task of a delegation: its thread stops, or it won’t start. 404 when it is gone.',
    params: B,
    body: DelegationTaskBody,
    response: DelegationActionResponse,
  }),
  stop: endpoint({
    id: 'delegations.stop',
    method: 'POST',
    path: '/burrows/:burrow/delegations/stop',
    summary:
      'Stop a delegation: every task at work stops and the rest won’t start; a checklist is left unhanded. 404 when it is gone.',
    params: B,
    body: DelegationActionBody,
    response: DelegationActionResponse,
  }),
} as const;
