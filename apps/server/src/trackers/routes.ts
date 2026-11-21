/**
 * REST adapters for a run's tracker report (`api.tracker.*`, report-trackers.md TA-14, TA-15) and a feature request's
 * answer (TA-45): thin, over people.ts and features.ts.
 */
import { api } from '@whombat/core';
import { route } from '../routes/define';
import { trackerDecideOp } from './features';
import { trackerItemOp, trackerUpdateOp } from './people';

export const trackerRoutes = [
  route(api.tracker.item, async ({ access, params, services }) =>
    trackerItemOp(services, access, params.runId),
  ),
  route(api.tracker.update, async ({ access, body, params, services }) =>
    trackerUpdateOp(services, access, params.runId, body),
  ),
  // The person's answer to a feature request's card (TA-45).
  route(api.tracker.decide, async ({ access, body, params, services }) =>
    trackerDecideOp(services, access, params.requestId, body),
  ),
];
