/**
 * `services.*` (contracts 3.0; docs/decisions/one-person.md OP-19, OP-S45): the agent's services as the person sees
 * them, and Stop. A stop of a running service is signed first (`service.stopped`, Keys: the person's say over what the
 * agent keeps running), then done; a service that is stopped already signs nothing.
 */

import { type AnyEndpoint, api } from '@whombat/core';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { notFound } from '../lib/errors';
import { loadAgentRow } from '../read/principals';
import { commitAs } from '../routes/burrows';
import { type HandlerContext, type RouteDef, route } from '../routes/define';
import { type AgentServiceView, ServiceNotFound, type ServicesList } from './service';

/** The signed line of a stop: “Stopped invoice-site”. */
export function serviceStoppedText(name: string): string {
  return `Stopped ${name}`;
}

/** The signed record of the person's Stop (`service.stopped`). */
export const recordServiceStop = defineCommand({
  name: 'services.stop',
  schema: z.object({
    serviceId: z.string(),
    name: z.string(),
    port: z.number().int(),
    agentId: z.string(),
    agentName: z.string(),
  }),
  async apply(_tx, ctx, input) {
    const event = await ctx.emit({
      type: 'service.stopped',
      kind: 'Keys',
      text: serviceStoppedText(input.name),
      where: `Agent · ${input.agentName} · Services`,
      aboutId: input.agentId,
      ref: { type: 'agent' },
      payload: { serviceId: input.serviceId, name: input.name, port: input.port },
    });
    return { eventId: event.id };
  },
});

type Ctx = Pick<HandlerContext<AnyEndpoint>, 'services' | 'access'>;

/** `services.list`. */
export function listServices(ctx: Ctx): Promise<ServicesList> {
  return ctx.services.agentServices.list();
}

/** `services.stop`: the service as it is afterwards and the signed event (null when it was stopped already). */
export async function stopService(
  ctx: Ctx,
  id: string,
): Promise<{ service: AgentServiceView; eventId: string | null }> {
  const services = ctx.services.agentServices;
  try {
    const now = await services.get(id);
    if (now.state !== 'running' && now.state !== 'starting') return { service: now, eventId: null };
    const agent = await loadAgentRow(ctx.services.db, ctx.access.burrow.id);
    if (!agent) throw notFound('Agent');
    const { eventId } = await commitAs(ctx, recordServiceStop, {
      serviceId: now.id,
      name: now.name,
      port: now.port,
      agentId: agent.id,
      agentName: agent.name,
    });
    return { service: await services.stop(id), eventId };
  } catch (err) {
    if (err instanceof ServiceNotFound) throw notFound('Service');
    throw err;
  }
}

export const agentServiceRoutes: RouteDef[] = [
  route(api.services.list, (ctx) => listServices(ctx)),
  route(api.services.stop, (ctx) => stopService(ctx, ctx.body.id)),
];
