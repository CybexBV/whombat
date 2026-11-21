/**
 * REST for kept sites (`api.keptSites.*`, docs/decisions/kept-sites.md): the websites the person's agent keeps signed in
 * between its turns, soonest to expire first, and stopping one. Never a cookie. Stopping goes through the commit
 * pipeline (`kept_site.stop`).
 */
import { api } from '@whombat/core';
import { forbidden } from '../lib/errors';
import { type RouteDef, route } from '../routes/define';
import { listKeptSites, stopKeptSite } from './kept-sites';

const personOnly = (kind: string) => {
  if (kind !== 'person') throw forbidden('Only you can see the websites kept signed in.');
};

export const keptSiteRoutes: RouteDef[] = [
  route(api.keptSites.list, async ({ services, access }) => {
    personOnly(access.principal.kind);
    return { sites: await listKeptSites(services, access.burrow.id) };
  }),

  route(api.keptSites.stop, async ({ services, access, params }) => {
    personOnly(access.principal.kind);
    return { site: await stopKeptSite(services, access.burrow.id, access.principal.id, params.siteId) };
  }),
];
