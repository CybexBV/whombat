/**
 * The council card's button (`api.councils.stop`, docs/decisions/council.md CNL-43, CNL-60): Stop ends the council and
 * stops its threads and its checklist's tasks. The person's own press. And the person's council (CNL-50…CNL-54).
 */
import { api } from '@whombat/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { delegations } from '../db/schema/index';
import { stopDelegation } from '../delegate/commands';
import { afterPersonsStop } from '../delegate/run';
import { conflict, forbidden } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import { providerOptions } from './members';
import { stopByPerson } from './run';
import { councilSetupView, resetCouncilSetup, saveCouncilSetup, t3Providers } from './setups';

const personOnly = (kind: string) => {
  if (kind !== 'person') throw forbidden('Only you decide on your council.');
};

export const councilRoutes: RouteDef[] = [
  // An older app's Go ahead button: the go-ahead is the person's own words in the council's thread now.
  route(api.councils.goAhead, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    throw conflict('Tell the assistant to go ahead in the council’s thread: it passes that on.');
  }),
  route(api.councils.stop, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    const council = await stopByPerson(
      ctx.services,
      ctx.access.burrow.id,
      ctx.access.principal.id,
      ctx.body.councilId,
    );
    // Its plan's tasks stop with it (CNL-60).
    const [d] = await ctx.services.db
      .select()
      .from(delegations)
      .where(and(eq(delegations.councilId, council.id), inArray(delegations.stage, ['offer', 'working'])))
      .orderBy(desc(delegations.createdAt))
      .limit(1);
    if (d) {
      const stopped = await commitAs(ctx, stopDelegation, { delegationId: d.id });
      await afterPersonsStop(ctx.services, stopped.delegation, stopped.working);
    }
    return { councilId: council.id as typeof ctx.body.councilId, stage: council.stage };
  }),
  // The person's council (CNL-50…CNL-54): read with what T3 Code can run now, kept, or forgotten.
  route(api.councils.setup, async ({ services, access }) => {
    personOnly(access.principal.kind);
    return councilSetupView(services, access.burrow.id);
  }),
  route(api.councils.saveSetup, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    // The seats' names as T3 Code gives them now, kept with the council (none while it can't be asked).
    const { providers } = await t3Providers(ctx.services, ctx.access.burrow.id);
    const options = providers ? providerOptions(providers) : null;
    const names = ctx.body.seats.map((s) => {
      const p = options?.find((o) => o.id === s.provider);
      const m = p?.models.find((x) => x.id === s.model);
      return p && m ? { providerName: p.name, modelLabel: m.label } : null;
    });
    return { setup: await commitAs(ctx, saveCouncilSetup, { ...ctx.body, names }) };
  }),
  route(api.councils.resetSetup, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    await commitAs(ctx, resetCouncilSetup, {});
    return { setup: null };
  }),
];
