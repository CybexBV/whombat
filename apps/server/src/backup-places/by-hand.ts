/**
 * Setting a place up by hand on this server (docs/decisions/backup-places.md BPL-09): `backup.placeByHand` and
 * `backup.placeCheck` with the place records, the backup service and the move rule. What the person pastes and the
 * checks before the destination is set are `nas/by-hand.ts`'s.
 *
 * The REST password waits sealed in the place's record (`pending_password_enc`, a day); “Check it” sets the box's
 * backups to the app with it, records the place as set up by hand (no cleanup: the NAS never got the repository
 * password) and starts the first backup. The password goes no further than the record and the backup service.
 */
import { BACKUP_PLACE_TEXT, type BackupPlace, parseBackupPlaceId } from '@whombat/core';
import { currentRow } from '../connections/http';
import { ApiError } from '../lib/errors';
import { type BackupPort, setBackupDestination } from '../managed/backup';
import { boxBackupStatus } from '../managed/box-backup';
import type { Services } from '../services';
import { resolveHost } from '../vault/net';
import { isPrivateIpv4 } from './hub';
import { type ByHandDeps, type ByHandPlace, placeByHand, placeCheck } from './nas/by-hand';
import { FIRST_PLACE_PORT } from './nas/compose';
import { nasProbe, trueNasAppsPool } from './nas/transport';
import { NasPlaceError } from './nas/types';
import { type PlacesNow, placesNow } from './places';
import { loadPlaceRow, openPending, savePlaceRow, sealPending } from './store';
import {
  moveNeeded,
  moveNeededError,
  oneAtATime,
  type PlaceBy,
  restRepository,
  startFirstBackup,
  statusNow,
  type UsePlaceResult,
} from './use';

const T = BACKUP_PLACE_TEXT;

/** A place's numeric home-network address: as listed, or what its name resolves to now. */
async function numericAddress(services: Services, place: BackupPlace): Promise<string> {
  const listed = place.address;
  if (listed && isPrivateIpv4(listed)) return listed;
  if (listed) {
    const found = (await resolveHost(services, `http://${listed}/`)).find(isPrivateIpv4);
    if (found) return found;
  }
  throw new NasPlaceError('unreachable', T.reasons.noAddress(place.name));
}

/** A by-hand step that didn't work, as the op's answer. */
function refusal(err: unknown): unknown {
  if (err instanceof NasPlaceError)
    return new ApiError('conflict', err.message, { details: { code: 'backup_place_failed', step: 'check' } });
  return err;
}

function deps(
  services: Services,
  now: PlacesNow,
  finish: ByHandDeps['finish'] = async () => {
    throw new Error('Only “Check it” sets a place.');
  },
): ByHandDeps {
  const listed = (id: string) => now.places.find((p) => p.id === id) ?? null;
  return {
    place: async (id) => {
      const p = listed(id);
      return p ? { id: p.id, kind: p.kind, name: p.name } : null;
    },
    client: async () => now.client,
    async pending(id) {
      const row = await loadPlaceRow(services.db, id);
      const password = row ? openPending(services.custody, row, services.clock()) : null;
      return row && password && row.pendingUntil
        ? { client: row.client, port: FIRST_PLACE_PORT, password, expiresAt: row.pendingUntil }
        : null;
    },
    async putPending(id, pending) {
      const p = listed(id);
      if (!p) throw new ApiError('not_found', T.refused.gone, { details: { code: 'backup_place_gone' } });
      await savePlaceRow(services, id, {
        kind: p.kind,
        name: p.name,
        client: pending.client,
        pendingPasswordEnc: sealPending(services.custody, id, pending.password),
        pendingUntil: pending.expiresAt,
      });
    },
    address: async (place: ByHandPlace) => {
      const p = listed(place.id);
      if (!p) throw new NasPlaceError('unreachable', T.refused.gone);
      return numericAddress(services, p);
    },
    probe: nasProbe(services),
    async trueNasPool(place) {
      const ref = parseBackupPlaceId(place.id);
      if (ref?.type !== 'connection') return null;
      const row = await currentRow(services, ref.id);
      return row ? trueNasAppsPool(services, row) : null;
    },
    finish,
    now: () => services.clock(),
  };
}

/** `backup.placeByHand`: the compose to paste, its steps and until when it can be checked. */
export async function placeByHandFor(
  services: Services,
  input: { placeId: string },
): Promise<{ compose: string; steps: string[]; expiresAt: string }> {
  const now = await placesNow(services);
  if (!now.places.some((p) => p.id === input.placeId))
    throw new ApiError('not_found', T.refused.gone, { details: { code: 'backup_place_gone' } });
  return placeByHand(deps(services, now), input).catch((err: unknown) => {
    throw refusal(err);
  });
}

/** `backup.placeCheck`: sets the place made by hand once its app answers (the move rule as `usePlace`'s). */
export function placeCheckFor(
  services: Services,
  backup: BackupPort,
  input: { placeId: string; move?: boolean },
  by: PlaceBy,
): Promise<UsePlaceResult> {
  return oneAtATime(services, async () => {
    const now = await placesNow(services, { fresh: true });
    const status = await statusNow(backup);
    const needed = moveNeeded(status, now.currentPlaceId, input.placeId, input.move === true);
    if (needed)
      throw moveNeededError(
        needed,
        now.places.find((p) => p.id === now.currentPlaceId),
      );
    const finish: ByHandDeps['finish'] = async ({ place, client, address, port, password }) => {
      const out = await setBackupDestination(
        services,
        backup,
        {
          repository: restRepository(address, port, client),
          restUser: client,
          restPassword: password,
          allowInit: true,
        },
        by,
      ).catch((err: unknown) => {
        const why = err instanceof ApiError ? err.message : 'It didn’t answer. Try again in a moment.';
        throw new ApiError('conflict', `${T.failed.destination(place.name)} ${why}`.slice(0, 500), {
          details: { code: 'backup_place_failed', step: 'destination' },
        });
      });
      await savePlaceRow(services, place.id, {
        kind: place.kind,
        name: place.name,
        client,
        address,
        port,
        byHand: true,
        repositoryId: out.repositoryId,
        // Set up by hand, the app has no cleanup until Whombat can reach the NAS with Manage.
        cleanupAt: null,
        pendingPasswordEnc: null,
        pendingUntil: null,
      });
      await boxBackupStatus(services, { fresh: true });
      const firstBackup = await startFirstBackup(services, backup, by);
      return {
        placeId: place.id,
        destination: place.name,
        locationName: null,
        appendOnly: out.appendOnly,
        firstBackup,
      };
    };
    return placeCheck(deps(services, now, finish), input).catch((err: unknown) => {
      throw refusal(err);
    });
  });
}
