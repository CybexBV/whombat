/**
 * REST for shared links (`api.shares.*`, docs/decisions/share-links.md): the person's own links to threads of their
 * Chat. Writes go through the commit pipeline; the call to control happens between `share_create` and
 * `share_published`, outside any transaction.
 */
import { api } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { shares } from '../db/schema/index';
import { forbidden, notFound } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import { createShare } from './commands';
import { linkView, listShares, liveShareIds, publishShare, stopShares } from './publish';
import { loadShareThread, previewOf } from './snapshot';

const personOnly = (kind: string) => {
  if (kind !== 'person') throw forbidden('Only you can share your Chat.');
};

export const shareRoutes: RouteDef[] = [
  route(api.shares.preview, async ({ services, access, body }) => {
    personOnly(access.principal.kind);
    const thread = await loadShareThread(services.db, access.burrow.id, access.principal.id, body);
    return previewOf(thread, services.files.store, new Date());
  }),

  route(api.shares.create, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    const made = await commitAs(ctx, createShare, { ...ctx.body, personId: ctx.access.principal.id });
    return {
      share: await publishShare(ctx.services, ctx.access.burrow.id, made.id, ctx.access.principal.id),
    };
  }),

  route(api.shares.list, async ({ services, access }) => {
    personOnly(access.principal.kind);
    return { shares: await listShares(services, access.burrow.id) };
  }),

  route(api.shares.stop, async ({ services, access, params }) => {
    personOnly(access.principal.kind);
    const [row] = await services.db.select().from(shares).where(eq(shares.id, params.shareId));
    if (!row || row.burrowId !== access.burrow.id || !row.viewerUrl) throw notFound('Link');
    await stopShares(services, access.burrow.id, access.principal.id, [row.id]);
    const [after] = await services.db.select().from(shares).where(eq(shares.id, row.id));
    return { share: linkView(services, after ?? row, new Date()) };
  }),

  route(api.shares.stopAll, async ({ services, access }) => {
    personOnly(access.principal.kind);
    const ids = await liveShareIds(services, access.burrow.id);
    const { stopped } = await stopShares(services, access.burrow.id, access.principal.id, ids);
    return { stopped: stopped.length };
  }),
];
