/**
 * The 1Password connection's sync over sessions (docs/decisions/onepassword-sync.md OPW-K12): its page part, Sync now
 * and the answer to the guard. Only the box's person; reading never calls 1Password.
 */
import { api } from '@whombat/core';
import { visibleConnection } from '../../connections/store';
import type { CatalogConnectionRow } from '../../connections/types';
import { ApiError, forbidden } from '../../lib/errors';
import { commitAs } from '../../routes/burrows';
import { type HandlerContext, type RouteDef, route } from '../../routes/define';
import { answerOnePasswordRemovals } from './commands';
import { ONEPASSWORD_CATALOG_ID, onePasswordSyncView } from './store';
import { onePasswordSyncFor } from './sync';

type Ctx = HandlerContext<(typeof api.connections)[keyof typeof api.connections]>;

/** Why Sync now can't start a pass now. */
export const ONEPASSWORD_SYNC_LATER = {
  readOnly: 'This Whombat can only read now, so it can’t sync with 1Password.',
  paused: 'This Whombat is busy with maintenance. It syncs with 1Password when that’s done.',
} as const;

/** The person, and the 1Password connection the route names (404 for any other connection). */
async function onePasswordGuard(
  ctx: Pick<Ctx, 'services' | 'access'>,
  connectionId: string,
): Promise<CatalogConnectionRow> {
  if (ctx.access.principal.kind !== 'person') throw forbidden('Only you can see the 1Password sync.');
  const row = await visibleConnection(ctx.services.db, { burrowId: ctx.access.burrow.id }, connectionId);
  if (row.catalogId !== ONEPASSWORD_CATALOG_ID)
    throw new ApiError('not_found', 'That connection isn’t 1Password.', {
      details: { code: 'not_onepassword' },
    });
  return row;
}

export const onePasswordRoutes: RouteDef[] = [
  route(api.connections.onePassword, async (ctx) => {
    const row = await onePasswordGuard(ctx, ctx.params.connectionId);
    return onePasswordSyncView(ctx.services.db, row, onePasswordSyncFor(ctx.services).syncing);
  }),

  route(api.connections.onePasswordSync, async (ctx) => {
    const row = await onePasswordGuard(ctx, ctx.params.connectionId);
    const services = ctx.services;
    if (services.schemaAccess === 'read-only')
      throw new ApiError('conflict', ONEPASSWORD_SYNC_LATER.readOnly);
    if (services.maintenance.paused || services.maintenance.held)
      throw new ApiError('conflict', ONEPASSWORD_SYNC_LATER.paused);
    // Sync now reads the vault in full, whatever its version says.
    onePasswordSyncFor(services).request(0, 'now');
    return onePasswordSyncView(services.db, row, true);
  }),

  route(api.connections.onePasswordRemovals, async (ctx) => {
    const row = await onePasswordGuard(ctx, ctx.params.connectionId);
    await commitAs(ctx, answerOnePasswordRemovals, {
      connectionId: row.id,
      answer: ctx.body.answer,
      token: ctx.body.token,
    });
    return onePasswordSyncView(ctx.services.db, row, onePasswordSyncFor(ctx.services).syncing);
  }),
];
