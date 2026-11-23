/**
 * A one-time Find My watch (Whombat findmy-watch.md): the card's Cancel. Spread into `api.connections` (op name
 * `connections.findMyWatchCancel`). Only the box's person; the assistant starts, lists and cancels watches with its
 * `findmy_watch` tool.
 */
import { FindMyWatchCancelBody, FindMyWatchView } from '../domain/findmy-watch.js';
import { FindMyWatchId } from '../ids.js';
import { z } from 'zod';
import { BurrowParam, endpoint } from './endpoint.js';

/** Merged into `api.connections` (op names `connections.<action>`). */
export const findMyWatchEndpoints = {
  findMyWatchCancel: endpoint({
    id: 'connections.findMyWatchCancel',
    method: 'POST',
    path: '/burrows/:burrow/find-my/watches/:watchId/cancel',
    summary:
      'Stop a one-time Find My watch the assistant started (its card’s Cancel). A watch that already ended answers as it is.',
    params: z.object({ burrow: BurrowParam, watchId: FindMyWatchId }),
    body: FindMyWatchCancelBody,
    response: FindMyWatchView,
  }),
};
