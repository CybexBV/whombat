/**
 * Setting a backup place up (docs/decisions/backup-places.md BPL-05, BPL-06): one step for the person, the rest
 * Whombat's — a REST user and password, the backup app installed or updated, the box's destination set (`allowInit`),
 * the repository password handed to the cleanup, the record kept and the first backup started. A step that fails says
 * which in one sentence and leaves what worked; doing it again carries on. Removing a place not in use (`forgetPlace`).
 *
 * Where on the place (BPL-13, BPL-14): the person's choice, else where the backups are now, else the recommended one.
 * Another location on the place in use moves them when the agent can (Unraid, Linux: the same address, repository and
 * history, so the destination isn't set again); a NAS's API can't, so it starts new backups there (a new repository,
 * the old one stays), which is a move the person confirms like one to another place.
 *
 * One flow at a time per box (and never beside the keep-the-place-right job): each reads where backups go before it
 * changes it.
 * The REST and repository passwords pass through here to the place and the backup service, never into a record, an
 * event, a log or an answer.
 */
import { randomBytes } from 'node:crypto';
import { BACKUP_PLACE_TEXT, type BackupPlace, type BackupPlaceRef, parseBackupPlaceId } from '@whombat/core';
import { BackupRecoveryMaterial, BackupServiceStatus } from '@whombat/protocol/session';
import type { z } from 'zod';
import { externalEffect, outsideCommandScope } from '../commit/scope';
import type { HandedCleanup } from '../db/schema/backup-places';
import type { HostsActor } from '../hosts/client';
import { ApiError } from '../lib/errors';
import { iso } from '../lib/time';
import { appendApplianceEvent } from '../managed/audit';
import { setBackupDestination } from '../managed/backup';
import { type BackupPort, READ } from '../managed/backup-port';
import { boxBackupStatus } from '../managed/box-backup';
import type { Services } from '../services';
import { type PlaceDriver, PlaceError, type PlaceTarget, placeDriver } from './drivers/index';
import { rememberFirstBackup, tellFirstBackup } from './first-backup';
import { currentPlaceKeep, type PlaceKeep } from './keep';
import { locationSaid } from './locations';
import { oneAtATime } from './lock';
import { changeBoxBackupNotes } from './notes';
import { type PlacesNow, placesNow } from './places';
import { type BackupPlaceRow, deletePlaceRow, loadPlaceRow, savePlaceRow, updatePlaceRow } from './store';

const T = BACKUP_PLACE_TEXT;

type RecoveryMaterial = z.output<typeof BackupRecoveryMaterial>;

/** Who asked: the person from their device, or their assistant on their word. */
export interface PlaceBy {
  accountId: string;
  endpointId: string | null;
  agentId?: string;
  /** As the hosts service's audit names them. */
  actor: HostsActor;
}

export interface UsePlaceResult {
  placeId: string;
  destination: string;
  /** Where on it, as people read it (“the share whombat-backups”), when the place has a choice. */
  locationName: string | null;
  appendOnly: 'verified' | 'not-enforced' | 'unknown';
  firstBackup: boolean;
}

/** The kinds whose agent moves a Whombat's folder to another location itself (BPL-14). */
const MOVES_ITSELF = new Set<BackupPlace['kind']>(['unraid', 'linux']);

/** The box's repository on a place: plain http to its numeric LAN address (BK-29), the client's own folder. */
export function restRepository(address: string, port: number, client: string): string {
  return `rest:http://${address}:${port}/${client}/`;
}

/** A REST password: 32 random bytes. */
export const newRestPassword = () => randomBytes(32).toString('base64url');

export { oneAtATime } from './lock';

/** A failed step in one sentence (which step, then what the place or the backup service said). */
function stepFailed(step: 'install' | 'destination' | 'cleanup', place: string, err: unknown): ApiError {
  const why =
    err instanceof PlaceError || err instanceof ApiError
      ? err.message
      : 'It didn’t answer. Try again in a moment.';
  return new ApiError('conflict', `${T.failed[step](place)} ${why}`.slice(0, 500), {
    details: { code: 'backup_place_failed', step },
  });
}

/** The backup service's status asked now (null when it didn't answer one). */
export async function statusNow(port: BackupPort): Promise<BackupServiceStatus | null> {
  const res = await port.call('GET', '/v1/status', undefined, READ).catch(() => null);
  const parsed = res?.status === 200 ? BackupServiceStatus.safeParse(res.body) : null;
  return parsed?.success ? parsed.data : null;
}

/** The recovery material (the passwords in it go no further than the place and the backup service). */
export async function recoveryMaterial(port: BackupPort): Promise<RecoveryMaterial | null> {
  const res = await port.call('GET', '/v1/recovery-material', undefined, READ).catch(() => null);
  const parsed = res?.status === 200 ? BackupRecoveryMaterial.safeParse(res.body) : null;
  return parsed?.success ? parsed.data : null;
}

/**
 * Whether the box's destination may be set to `placeId` now (BPL-06): nothing set, only this Whombat's own disk, the
 * place itself already, or the person confirmed the move. Null, or where backups go now as people read it (empty when
 * the backup service didn't say).
 */
export function moveNeeded(
  status: BackupServiceStatus | null,
  current: string | null,
  placeId: string,
  move: boolean,
): { from: string } | null {
  if (move || current === placeId) return null;
  if (status && (!status.destination.configured || status.destination.kind === 'local')) return null;
  return { from: status?.destination.display ?? '' };
}

/** The refusal of a move the person hasn't confirmed: the app asks them and calls again with `move`. */
export function moveNeededError(needed: { from: string }, current: BackupPlace | undefined): ApiError {
  const from = current?.name ?? needed.from;
  return new ApiError('conflict', T.refused.move(from || 'another place'), {
    details: { code: 'move_needed', ...(from ? { from } : {}) },
  });
}

function targetOf(place: BackupPlace): PlaceTarget {
  const ref = parseBackupPlaceId(place.id) as BackupPlaceRef;
  if (ref.type === 'found')
    throw new ApiError('conflict', place.reason ?? T.reasons.other, {
      details: { code: 'backup_place_not_ready' },
    });
  return { id: place.id, ref, kind: place.kind, name: place.name };
}

/** The place by id from the list now, ready or in use; else the refusal. */
export function usablePlace(now: PlacesNow, placeId: string): BackupPlace {
  const place = now.places.find((p) => p.id === placeId);
  if (!place) throw new ApiError('not_found', T.refused.gone, { details: { code: 'backup_place_gone' } });
  if (place.state !== 'ready' && place.state !== 'in_use')
    throw new ApiError('conflict', place.reason ?? T.reasons.other, {
      details: { code: 'backup_place_not_ready' },
    });
  return place;
}

/** The location asked for, checked against the place's list; undefined when none was asked for. */
export function chosenLocation(place: BackupPlace, location: string | undefined): string | undefined {
  if (!location) return undefined;
  if (!place.locations.some((l) => l.id === location))
    throw new ApiError('not_found', T.location.gone, { details: { code: 'backup_location_gone' } });
  return location;
}

/**
 * Whether the person must confirm first (BPL-14): a NAS place in use asked for another location starts new backups
 * there. Null, or the location they are in now as the NAS names it.
 */
export function newBackupsNeeded(
  place: BackupPlace,
  location: string | undefined,
  move: boolean,
): { from: string } | null {
  if (move || !location || place.state !== 'in_use' || MOVES_ITSELF.has(place.kind)) return null;
  if (!place.location || place.location === location) return null;
  return { from: place.locations.find((l) => l.id === place.location)?.name ?? place.location };
}

/**
 * The first backup, started and not waited for (a checkpoint takes a while); whether it started. When it ends, the
 * thread the person said yes in hears how it went (`rememberFirstBackup`).
 */
export async function startFirstBackup(services: Services, port: BackupPort, by: PlaceBy): Promise<boolean> {
  try {
    await services.pipeline.transactAccount(async (tx) => {
      await appendApplianceEvent(tx, services.custody, {
        type: 'backup.run_requested',
        actorAccountId: by.accountId,
        endpointId: by.endpointId,
        payload: { reason: 'backup_place', ...(by.agentId ? { agentId: by.agentId } : {}) },
        at: services.clock(),
      });
    });
  } catch (err) {
    services.log.warn({ err: String(err) }, 'backup places: the first backup wasn’t recorded');
    return false;
  }
  // Its end is told on its own, never as part of the request that set the place up.
  outsideCommandScope(() => {
    void port
      .call('POST', '/v1/checkpoints', { reason: 'manual' })
      .then((res) => {
        if (res.status !== 200 && res.status !== 409)
          services.log.warn({ status: res.status }, 'backup places: the first backup didn’t finish');
      })
      .catch((err: unknown) =>
        services.log.warn({ err: String(err) }, 'backup places: the first backup failed'),
      )
      .then(() => tellFirstBackup(services))
      .catch((err: unknown) =>
        services.log.warn({ err: String(err) }, 'backup places: the first backup wasn’t told'),
      );
  });
  return true;
}

/** The thread to tell when the first backup is done: where the person said yes (the assistant's turn). */
export type FirstBackupThread = Omit<Parameters<typeof rememberFirstBackup>[1], 'place'>;

/**
 * Sets a place up and points the box's backups at it (BPL-05). `move`: the person confirmed moving backups that go
 * somewhere else; `allowMove: false` refuses any move but from the box's own disk (the assistant, BPL-06). `tell`: the
 * thread that hears how the first backup went.
 */
export function usePlace(
  services: Services,
  port: BackupPort,
  input: { placeId: string; move?: boolean; location?: string },
  by: PlaceBy,
  tell?: FirstBackupThread,
): Promise<UsePlaceResult> {
  return oneAtATime(services, () => usePlaceNow(services, port, input, by, tell));
}

/** `usePlace` inside a place flow that holds the lock already (the keep-the-place-right job). */
export async function usePlaceNow(
  services: Services,
  port: BackupPort,
  input: { placeId: string; move?: boolean; location?: string },
  by: PlaceBy,
  tell?: FirstBackupThread,
): Promise<UsePlaceResult> {
  const status = await statusNow(port);
  const now = await placesNow(services, { fresh: true });
  const needed = moveNeeded(status, now.currentPlaceId, input.placeId, input.move === true);
  if (needed)
    throw moveNeededError(
      needed,
      now.places.find((p) => p.id === now.currentPlaceId),
    );
  const place = usablePlace(now, input.placeId);
  const location = chosenLocation(place, input.location);
  const fresh = newBackupsNeeded(place, location, input.move === true);
  if (fresh) {
    const from = T.location.said(place.kind, fresh.from);
    throw new ApiError('conflict', T.location.newBackups(from), {
      details: { code: 'move_needed', from: fresh.from },
    });
  }
  const target = targetOf(place);
  const driver = placeDriver({ services, target, actor: by.actor });
  const { client } = now;
  const inUse = place.state === 'in_use';
  // A NAS place in use, somewhere else on it: new backups there, never the old repository joined.
  const newRepository =
    inUse && !MOVES_ITSELF.has(place.kind) && !!location && !!place.location && location !== place.location;
  // In use already: the same REST user and password (the app's line is rewritten with it), the same repository.
  const material = inUse ? await recoveryMaterial(port) : null;
  const restPassword =
    material?.restUser === client && material.restPassword ? material.restPassword : newRestPassword();
  // Backups on this Whombat's own disk until now: moving them is part of this yes.
  const fromOwnDisk = status?.destination.configured === true && status.destination.kind === 'local';

  const ensured = await externalEffect('backup.place', () =>
    driver.ensure(client, restPassword, location),
  ).catch((err: unknown) => {
    throw stepFailed('install', place.name, err);
  });
  const where = ensured.location ?? location ?? place.location ?? null;
  await savePlaceRow(services, place.id, {
    kind: place.kind,
    name: place.name,
    client,
    address: ensured.address,
    port: ensured.port,
    byHand: false,
    location: where,
  });

  const repository = restRepository(ensured.address, ensured.port, client);
  let appendOnly: UsePlaceResult['appendOnly'] = status?.destination.appendOnly ?? 'unknown';
  let firstBackup = false;
  if (!inUse || newRepository || material?.repository !== repository) {
    const out = await setBackupDestination(
      services,
      port,
      {
        repository,
        restUser: client,
        restPassword,
        allowInit: true,
        // The same repository at a new address: joined, never made again.
        ...(inUse && material && !newRepository ? { adoptPassword: material.repositoryPassword } : {}),
      },
      by,
    ).catch((err: unknown) => {
      throw stepFailed('destination', place.name, err);
    });
    appendOnly = out.appendOnly;
    if (out.appendOnly !== 'verified')
      services.log.warn(
        { place: place.id, appendOnly: out.appendOnly },
        'backup places: deleting isn’t refused',
      );
    await updatePlaceRow(services, place.id, { repositoryId: out.repositoryId });
    await boxBackupStatus(services, { fresh: true });
    if (fromOwnDisk)
      await changeBoxBackupNotes(services, (notes) => ({
        ...notes,
        moveLocal: { since: iso(services.clock()), tries: 0 },
      }));
    if (tell) await rememberFirstBackup(services, { ...tell, place: place.name });
    firstBackup = await startFirstBackup(services, port, by);
  }

  const row = await loadPlaceRow(services.db, place.id);
  await handCleanup(services, port, driver, {
    id: place.id,
    name: place.name,
    client,
    cleanupAt: inUse ? (row?.cleanupAt ?? null) : null,
  });
  return {
    placeId: place.id,
    destination: place.name,
    locationName: locationSaid(place.kind, place.locations, where),
    appendOnly,
    firstBackup,
  };
}

/**
 * Hands the place's cleanup the repository password and the person's keep windows and limit (backup-options.md BKO-04)
 * and records what it was handed, so the keep-the-place-right job can tell a change that didn't take. `keep`: what to
 * hand (the person's now when left out); `windows`: whether its helper takes them (the driver finds out when left out).
 */
export async function handCleanup(
  services: Services,
  port: BackupPort,
  driver: PlaceDriver,
  place: { id: string; name: string; client: string; cleanupAt: Date | null },
  options: { keep?: PlaceKeep; windows?: boolean } = {},
): Promise<HandedCleanup> {
  const opened = await recoveryMaterial(port);
  if (!opened) throw stepFailed('cleanup', place.name, null);
  const keep = options.keep ?? (await currentPlaceKeep(port));
  const handed = await externalEffect('backup.place_cleanup', () =>
    driver.cleanup(place.client, opened.repositoryPassword, keep, options.windows),
  ).catch((err: unknown) => {
    throw stepFailed('cleanup', place.name, err);
  });
  const record: HandedCleanup = { keep, windows: handed?.windows ?? true, at: iso(services.clock()) };
  await updatePlaceRow(services, place.id, {
    cleanupAt: place.cleanupAt ?? services.clock(),
    cleanupKeep: record,
  });
  return record;
}

/** Whombat can't tell where the backups go now: nothing that could delete or replace them is done. */
export function placeUnknownError(): ApiError {
  return new ApiError('unavailable', T.refused.unknown, { details: { code: 'backup_unavailable' } });
}

/**
 * Removes the backup app of a place not in use; `deleteData` also the backups it kept. Refused while the backup service
 * can't say which place is in use: the one asked for may be it.
 */
export function forgetPlace(
  services: Services,
  input: { placeId: string; deleteData?: boolean },
  by: PlaceBy,
): Promise<{ ok: true }> {
  return oneAtATime(services, async () => {
    const now = await placesNow(services, { fresh: true });
    if (!now.statusKnown) throw placeUnknownError();
    const row = await loadPlaceRow(services.db, input.placeId);
    const listed = now.places.find((p) => p.id === input.placeId);
    if (now.currentPlaceId === input.placeId)
      throw new ApiError('conflict', T.refused.inUse(listed?.name ?? row?.name ?? 'It'), {
        details: { code: 'backup_place_in_use' },
      });
    if (!row) throw new ApiError('not_found', T.refused.gone, { details: { code: 'backup_place_gone' } });
    const ref = parseBackupPlaceId(row.id);
    if (!row.byHand && ref && ref.type !== 'found') {
      const driver = placeDriver({
        services,
        target: { id: row.id, ref, kind: row.kind, name: row.name },
        actor: by.actor,
      });
      await externalEffect('backup.place_forget', () =>
        driver.forget(row.client, input.deleteData === true),
      ).catch((err: unknown) => {
        throw new ApiError('conflict', err instanceof PlaceError ? err.message : T.reasons.other, {
          details: { code: 'backup_place_failed', step: 'forget' },
        });
      });
    }
    await deletePlaceRow(services, row.id);
    return { ok: true as const };
  });
}

/**
 * A “lost or stolen” restore (backup-options.md): the place in use gets a new REST password, so the old box, which
 * knew the old one, can't add backups there any more; the box's destination takes it (the same repository, so its
 * history stays), which changes the recovery material, so the kit is locked again. Inside a place flow.
 */
export async function rotatePlacePassword(
  services: Services,
  port: BackupPort,
  row: BackupPlaceRow,
  actor: HostsActor,
): Promise<void> {
  const ref = parseBackupPlaceId(row.id);
  if (!ref || ref.type === 'found' || row.byHand)
    throw new ApiError('conflict', T.reasons.notYet, { details: { code: 'backup_place_not_ready' } });
  const material = await recoveryMaterial(port);
  if (!material) throw stepFailed('destination', row.name, null);
  const driver = placeDriver({
    services,
    target: { id: row.id, ref, kind: row.kind, name: row.name },
    actor,
  });
  const restPassword = newRestPassword();
  const ensured = await externalEffect('backup.place', () =>
    driver.ensure(row.client, restPassword, row.location ?? undefined),
  ).catch((err: unknown) => {
    throw stepFailed('install', row.name, err);
  });
  const out = await setBackupDestination(
    services,
    port,
    {
      repository: restRepository(ensured.address, ensured.port, row.client),
      restUser: row.client,
      restPassword,
      adoptPassword: material.repositoryPassword,
    },
    { accountId: null, endpointId: null },
  ).catch((err: unknown) => {
    throw stepFailed('destination', row.name, err);
  });
  await updatePlaceRow(services, row.id, {
    address: ensured.address,
    port: ensured.port,
    repositoryId: out.repositoryId,
  });
  await boxBackupStatus(services, { fresh: true });
}
