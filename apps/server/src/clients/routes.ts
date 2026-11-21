/**
 * `api.clients.list|install|remove` (contracts 0.9.0 CT-72), over REST and — as `clients.*` ops — over the session:
 * Claude Code alone (hermes-native.md HN-A01).
 * Listing is for any signed-in device; installing and removing are the person's (like `host.recheckAgents`):
 * installing a client is a change to the whole machine.
 */
import { api } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { RequestAuth } from '../auth/request';
import { principals } from '../db/schema/index';
import { forbidden, unauthorized } from '../lib/errors';
import { type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { aiClients, isClientProvider, noClientNeeded } from './service';

/** The person, in their burrow (one-person.md OP-S06). */
export async function canManageClients(services: Services, auth: RequestAuth): Promise<boolean> {
  const accountId = auth.account?.id;
  if (!accountId) return false;
  const [person] = await services.db
    .select({ id: principals.id })
    .from(principals)
    .where(and(eq(principals.accountId, accountId), eq(principals.kind, 'person')))
    .limit(1);
  return Boolean(person);
}

async function requirePerson(services: Services, auth: RequestAuth, what: string): Promise<void> {
  if (!auth.account) throw unauthorized();
  if (!(await canManageClients(services, auth))) throw forbidden(`Only you can ${what}.`);
}

export const clientRoutes: RouteDef[] = [
  route(api.clients.list, async ({ auth, services }) => {
    if (!auth.account) throw unauthorized();
    const listed = await (await aiClients(services)).list();
    return { ...listed, canManage: await canManageClients(services, auth) };
  }),
  // Claude Code is the only client; ChatGPT needs nothing installed (hermes-native.md HN-A01).
  route(api.clients.install, async ({ auth, params, services }) => {
    await requirePerson(services, auth, 'install an AI client');
    if (!isClientProvider(params.provider)) throw noClientNeeded();
    return (await aiClients(services)).install(params.provider);
  }),
  route(api.clients.remove, async ({ auth, params, services }) => {
    await requirePerson(services, auth, 'remove an AI client');
    if (!isClientProvider(params.provider)) throw noClientNeeded();
    return (await aiClients(services)).remove(params.provider);
  }),
];
