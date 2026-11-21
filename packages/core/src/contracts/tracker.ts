/**
 * People act on a run's tracker report (Whombat report-trackers.md TA-14, TA-15): read it live from its tracker on the
 * run page, and send the reporter a reply or set its status.
 * Agents have neither: what the customer hears comes from people (FBS-07, FBS-08). Since 3.12 (TA-45) the person also
 * answers a feature request's card (`tracker.decide`).
 */
import { z } from 'zod';
import { AutomationRunId } from '../domain/automation.js';
import { FeatureRequestView, TrackerDecideBody } from '../domain/feature-request.js';
import { TRACKER_REPLY_MAX, TrackerItemView, TrackerUpdateStatus } from '../domain/tracker.js';
import { FeatureRequestId, MessageId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const T = z.object({ burrow: BurrowParam, runId: AutomationRunId });

/**
 * What a person sends to a run's report (TA-15): a public reply (the tracker emails it and shows it as its team's)
 * and/or a status. `requestId` is the client's, made once per send and kept for a retry after a lost answer: the
 * tracker replays it, so nothing is emailed twice.
 */
export const TrackerUpdateBody = z
  .object({
    requestId: z.guid({ message: 'Expected a request id (a UUID)' }),
    message: z.string().trim().min(1).max(TRACKER_REPLY_MAX).optional(),
    status: TrackerUpdateStatus.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.message === undefined && body.status === undefined)
      ctx.addIssue({ code: 'custom', message: 'Write a reply or choose a status.', path: ['message'] });
    if (body.status === 'not_planned' && body.message === undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Tell the reporter why when it isn’t planned: write a reply.',
        path: ['message'],
      });
  });
export type TrackerUpdateBody = z.infer<typeof TrackerUpdateBody>;

export const trackerEndpoints = {
  item: endpoint({
    id: 'tracker.item',
    method: 'GET',
    path: '/burrows/:burrow/trackers/runs/:runId/item',
    summary:
      'The report a run started from, read live from its tracker (TA-14): for whoever can see the run (in its rooms). The reporter’s name and email are for people only. `can.update`: the caller may reply and set its status (people who may publish automations).',
    params: T,
    response: z.object({
      report: TrackerItemView,
      can: z.object({ update: z.boolean() }),
    }),
  }),
  update: endpoint({
    id: 'tracker.update',
    method: 'POST',
    path: '/burrows/:burrow/trackers/runs/:runId/item',
    summary:
      'Reply to the reporter through the tracker and/or set the report’s status (TA-15): people who may publish automations and can see the run, never an agent. The tracker emails the reporter. The server sends it with `requestId`, then posts what was sent in the run’s thread as the caller (`messageId`).',
    params: T,
    body: TrackerUpdateBody,
    response: z.object({ report: TrackerItemView, messageId: MessageId }),
  }),
  decide: endpoint({
    id: 'tracker.decide',
    method: 'POST',
    path: '/burrows/:burrow/trackers/feature-requests/:requestId/decide',
    summary:
      'The person’s answer to a feature request card (3.12, CT-1638; Whombat report-trackers.md TA-45): approve (Planned), build (Approve and build: In progress, then the automation builds it; only when the card offers it), decline with a reason (absent: the agent’s own) or ask the customer a question. The run goes on: the customer is told through the tracker in the agent’s words. People only; a request that no longer waits is a conflict.',
    params: z.object({ burrow: BurrowParam, requestId: FeatureRequestId }),
    body: TrackerDecideBody,
    response: z.object({ request: FeatureRequestView }),
  }),
} as const;
