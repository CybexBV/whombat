/**
 * The delegation card's buttons (`api.delegations.*`, docs/decisions/delegate.md): tick or untick a task, hand the
 * ticked ones over (they start in T3 Code, a few at once), stop one task, or stop it all (Not now on a checklist). The
 * person's own presses.
 */
import { api } from '@whombat/core';
import { chosenAi, providerOptions } from '../council/members';
import { t3Providers } from '../council/setups';
import { badRequest, forbidden } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import { pickTask, setDelegationAi, startDelegation, stopDelegation, stopTaskByPerson } from './commands';
import { afterPersonsStop, startReady } from './run';

const personOnly = (kind: string) => {
  if (kind !== 'person') throw forbidden('Only you decide on this card.');
};

type Id = ReturnType<typeof api.delegations.start.response.parse>['delegationId'];

export const delegationRoutes: RouteDef[] = [
  route(api.delegations.pick, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    const { delegation } = await commitAs(ctx, pickTask, ctx.body);
    return { delegationId: delegation.id as Id, stage: delegation.stage };
  }),
  route(api.delegations.setAi, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    // Checked against what T3 Code runs now: its name and the options it takes for that effort and fast tier.
    let ai: ReturnType<typeof chosenAi> = null;
    if (ctx.body.ai) {
      const { providers } = await t3Providers(ctx.services, ctx.access.burrow.id);
      ai = providers ? chosenAi(providers, ctx.body.ai) : null;
      if (!ai) throw badRequest('T3 Code can’t run that model now. Pick another.');
    }
    const { delegation } = await commitAs(ctx, setDelegationAi, {
      delegationId: ctx.body.delegationId,
      taskId: ctx.body.taskId ?? null,
      ai,
    });
    return { delegationId: delegation.id as Id, stage: delegation.stage };
  }),
  route(api.delegations.models, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    const { providers, t3 } = await t3Providers(ctx.services, ctx.access.burrow.id);
    return { options: providers ? providerOptions(providers) : null, t3 };
  }),
  route(api.delegations.start, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    const { delegation } = await commitAs(ctx, startDelegation, { delegationId: ctx.body.delegationId });
    // A task that can't start wakes the agent, which tells the person.
    await startReady(ctx.services, delegation.id, delegation.burrowId);
    return { delegationId: delegation.id as Id, stage: delegation.stage };
  }),
  route(api.delegations.stopTask, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    const { delegation, working } = await commitAs(ctx, stopTaskByPerson, ctx.body);
    await afterPersonsStop(ctx.services, delegation, working);
    return { delegationId: delegation.id as Id, stage: delegation.stage };
  }),
  route(api.delegations.stop, async (ctx) => {
    personOnly(ctx.access.principal.kind);
    const { delegation, working } = await commitAs(ctx, stopDelegation, {
      delegationId: ctx.body.delegationId,
    });
    await afterPersonsStop(ctx.services, delegation, working);
    return { delegationId: delegation.id as Id, stage: delegation.stage };
  }),
];
