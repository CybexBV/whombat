/**
 * The backup places' session ops (docs/decisions/backup-places.md; contracts `session/backup-places.ts`), the owner's:
 * `backup.places` lists them, `backup.usePlace` sets one up and moves the backups there, `backup.forgetPlace` removes
 * one not in use; `backup.placeByHand` hands out the app to paste and `backup.placeCheck` sets a place made by hand
 * (BPL-09).
 */

import { thePerson } from '../domain/the-person';
import { actorOf, hostsFor } from '../hosts/service';
import { ApiError } from '../lib/errors';
import { type BackupPort, sessionPort } from '../managed/backup';
import type { SessionOpContext } from '../managed/dispatcher';
import { requirePerson } from '../managed/trust';
import { placeByHandFor, placeCheckFor } from './by-hand';
import { placesNow } from './places';
import { forgetPlace, type PlaceBy, usePlace } from './use';

function port(c: SessionOpContext): BackupPort {
  if (!c.backup)
    throw new ApiError('not_allowed', 'This appliance has no backup service.', {
      details: { code: 'backup_unavailable' },
    });
  return sessionPort(c.backup);
}

/** The person from their device, or their assistant for them, as the hosts service's audit names them. */
export async function byThePerson(c: SessionOpContext): Promise<PlaceBy> {
  const { endpointId, account } = requirePerson(c.principal);
  const burrowId = await hostsFor(c.services)
    .homeBurrowId()
    .catch(() => null);
  const person = burrowId ? await thePerson(c.services.db, burrowId) : null;
  return {
    accountId: account.id,
    endpointId,
    actor: actorOf(person ?? { id: account.id, name: 'The owner' }, 'operator'),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type Handler = (c: SessionOpContext, input: any) => Promise<unknown>;

export const BACKUP_PLACE_HANDLERS: Readonly<Record<string, Handler>> = {
  'backup.places': async (c) => {
    requirePerson(c.principal);
    const now = await placesNow(c.services, { fresh: true });
    return { places: now.places, currentPlaceId: now.currentPlaceId };
  },

  'backup.usePlace': async (c, input: { placeId: string; move?: boolean; location?: string }) => {
    const by = await byThePerson(c);
    const backup = port(c);
    // Accepted before anything is installed: setting a place up can't be cancelled halfway and may take minutes.
    await c.services.pipeline.transactAccount(async () => {});
    return usePlace(c.services, backup, input, by);
  },

  'backup.forgetPlace': async (c, input: { placeId: string; deleteData?: boolean }) => {
    const by = await byThePerson(c);
    await c.services.pipeline.transactAccount(async () => {});
    return forgetPlace(c.services, input, by);
  },

  // BPL-09: the compose to paste (the password waits sealed in the place's record), then “Check it”.
  'backup.placeByHand': async (c, input: { placeId: string }) => {
    requirePerson(c.principal);
    return placeByHandFor(c.services, input);
  },
  'backup.placeCheck': async (c, input: { placeId: string; move?: boolean }) => {
    const by = await byThePerson(c);
    const backup = port(c);
    await c.services.pipeline.transactAccount(async () => {});
    return placeCheckFor(c.services, backup, input, by);
  },
};
