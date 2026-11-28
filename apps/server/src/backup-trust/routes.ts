/**
 * What's protected and restore tests (docs/decisions/backup-trust.md): the page's one read, the person's switch per
 * Proxmox server, and *Test one now*.
 */
import { api, type HostServer } from '@whombat/core';
import { loadBurrowRow } from '../commit/pipeline';
import { hostsFor } from '../hosts/service';
import { badRequest, conflict, notFound } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { setRestoreTests } from './commands';
import { restoreTestsFor } from './runner';
import { forgetProtectedView, protectedView, restoreTestServerView } from './view';

/** A Proxmox server of this Whombat's, by its id. */
async function proxmoxServer(services: Services, burrowId: string, serverId: string): Promise<HostServer> {
  const hosts = hostsFor(services);
  if (!(await hosts.serves(burrowId).catch(() => false))) throw notFound('Server');
  const server = (await hosts.fleet()).servers.find((s) => s.id === serverId);
  if (!server) throw notFound('Server');
  if (server.platform !== 'proxmox') throw badRequest('Restore tests work on Proxmox servers.');
  return server;
}

const BLOCKED_TEXT = {
  manage_off: 'Turn on Manage for this server first.',
  offline: 'The server isn’t reachable now.',
  no_guests: 'There are no machines to test on this server.',
} as const;

export const backupTrustRoutes: RouteDef[] = [
  route(api.protected.get, async ({ services, access }) => protectedView(services, access.burrow.id)),

  route(api.restoreTests.set, async (ctx) => {
    const burrow = await loadBurrowRow(ctx.services.db, ctx.access.burrow.id);
    if (!burrow) throw notFound('Whombat');
    const server = await proxmoxServer(ctx.services, burrow.id, ctx.params.serverId);
    await commitAs(ctx, setRestoreTests, {
      ...ctx.body,
      serverId: server.id,
      serverName: server.name.slice(0, 160),
    });
    forgetProtectedView(ctx.services);
    return restoreTestServerView(ctx.services, burrow, server);
  }),

  route(api.restoreTests.run, async (ctx) => {
    const burrow = await loadBurrowRow(ctx.services.db, ctx.access.burrow.id);
    if (!burrow) throw notFound('Whombat');
    const server = await proxmoxServer(ctx.services, burrow.id, ctx.params.serverId);
    const before = await restoreTestServerView(ctx.services, burrow, server);
    if (before.running) throw conflict('A restore test is already running on this server.');
    if (before.blocked) throw conflict(BLOCKED_TEXT[before.blocked]);
    const id = await restoreTestsFor(ctx.services).startTest(
      burrow.id,
      server.id,
      ctx.body.guest ?? null,
      true,
      {
        burrowId: burrow.id,
        actorId: ctx.access.principal.id,
      },
    );
    if (!id) throw conflict(ctx.body.guest ? 'That machine can’t be tested.' : BLOCKED_TEXT.no_guests);
    forgetProtectedView(ctx.services);
    return restoreTestServerView(ctx.services, burrow, server);
  }),
];
