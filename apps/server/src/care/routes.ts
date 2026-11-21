/** The quiet hours for changes (docs/decisions/care-plan.md): read by anyone here, moved by the person. */
import { api } from '@whombat/core';
import { loadBurrowRow } from '../commit/pipeline';
import { notFound } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import { changeWindowView, setChangeWindow } from './window';

export const careRoutes: RouteDef[] = [
  route(api.changeWindow.get, async ({ services, access }) => {
    const row = await loadBurrowRow(services.db, access.burrow.id);
    if (!row) throw notFound('Whombat');
    return changeWindowView(row);
  }),
  route(api.changeWindow.set, async (ctx) => commitAs(ctx, setChangeWindow, ctx.body)),
];
