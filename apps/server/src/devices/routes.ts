/**
 * REST for device skills (`api.deviceSkills.*`, contracts 0.80 CT-340; one-whombat-devices.md ONE-DD07): the person's
 * choice on a `device_skill` card. The person only (`burrow.manage` in the command); a proposal of another burrow is a
 * 404.
 */
import { api } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { deviceSkills } from '../db/schema/index';
import { notFound } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { decideDeviceSkill, declineDeviceSkill, skillCard } from './skills';

async function proposalIn(services: Services, burrowId: string, id: string) {
  const [row] = await services.db
    .select()
    .from(deviceSkills)
    .where(and(eq(deviceSkills.id, id), eq(deviceSkills.burrowId, burrowId)));
  if (!row) throw notFound('Device skill');
  return row;
}

export const deviceSkillRoutes: RouteDef[] = [
  route(api.deviceSkills.decide, async (ctx) => {
    const { services, access, params, body } = ctx;
    await proposalIn(services, access.burrow.id, params.proposalId);
    const r = await commitAs(ctx, decideDeviceSkill, {
      proposalId: params.proposalId,
      actions: body.actions,
      switchOn: body.switchOn,
    });
    return { card: skillCard(r.row), connectionId: r.connectionId };
  }),

  route(api.deviceSkills.decline, async (ctx) => {
    const { services, access, params } = ctx;
    await proposalIn(services, access.burrow.id, params.proposalId);
    const r = await commitAs(ctx, declineDeviceSkill, { proposalId: params.proposalId });
    return { card: skillCard(r.row), connectionId: null };
  }),
];
