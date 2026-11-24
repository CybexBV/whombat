/**
 * A 1Password connection's sync (docs/decisions/onepassword-sync.md): its page part, Sync now, and the answer to the
 * guard's “1Password says 4 items are gone”. Spread into `api.connections` (op names `connections.onePassword…`): the
 * sync belongs to the 1Password connection, under its own path. Only the box's person; never on the desk display, an
 * Overview tile, a share link or in outsiders' turns, and never a setting of the assistant. The page part is the last
 * pass's stored state: reading it never calls 1Password.
 */
import { z } from 'zod';
import { ConnectionId } from '../ids.js';
import {
  OnePasswordRemovalsBody,
  OnePasswordSyncBody,
  OnePasswordSyncView,
} from '../vault/onepassword-view.js';
import { BurrowParam, endpoint } from './endpoint.js';

const BC = z.object({ burrow: BurrowParam, connectionId: ConnectionId });

/** Merged into `api.connections` (op names `connections.<action>`). */
export const onePasswordEndpoints = {
  onePassword: endpoint({
    id: 'connections.onePassword',
    method: 'GET',
    path: '/burrows/:burrow/connections/:connectionId/onepassword',
    summary:
      'A 1Password connection’s sync as its last pass left it: the vault’s name, how many entries are kept in step, waiting or kept only here, when it last checked and how that went, whether the token can only read, the items not in the Vault with their reasons, and the removals the guard holds. Never calls 1Password. 404 for a connection of another kind.',
    params: BC,
    response: OnePasswordSyncView,
  }),
  onePasswordSync: endpoint({
    id: 'connections.onePasswordSync',
    method: 'POST',
    path: '/burrows/:burrow/connections/:connectionId/onepassword/sync',
    summary:
      'Sync now: a pass starts soon, joined with any already asked for. Answers the page part with `syncing`. Not while the Whombat is read-only, paused for maintenance, draining or quarantined (`conflict`).',
    params: BC,
    body: OnePasswordSyncBody,
    response: OnePasswordSyncView,
  }),
  onePasswordRemovals: endpoint({
    id: 'connections.onePasswordRemovals',
    method: 'POST',
    path: '/burrows/:burrow/connections/:connectionId/onepassword/removals',
    summary:
      'Answer the guard for the removals shown (`token`): `remove` removes those entries here too, `keep` keeps them only in Whombat and never pushes them back. `conflict` when the set changed since (the page shows the new one). Signs each change as the person’s, with the source `onepassword`.',
    params: BC,
    body: OnePasswordRemovalsBody,
    response: OnePasswordSyncView,
  }),
};
