/**
 * The NAS drivers as the backup places' registry takes them (docs/decisions/backup-places.md BPL-03, BPL-04, BPL-09):
 * made for one place (a TrueNAS, Synology or QNAP connection), its connection read when a step runs, failures as
 * `PlaceError` in one plain sentence.
 *
 * What a NAS says about itself (`status`) and what it keeps (`kept`) are read through its API, a sign-in each, so the
 * places list keeps them five minutes; a change through the driver forgets them. `status` offers “Set it up by hand”
 * when the NAS's API refused Whombat or answered in a way it doesn't know, and for a QNAP whose Container Station
 * Whombat didn't find (its API isn't documented, so not finding it may be Whombat's mistake); not when the NAS clearly
 * lacks what the app needs (an older DSM, no apps pool), since a person couldn't set it up there either.
 */
import { BACKUP_PLACE_TEXT, type BackupPlaceKept, type BackupPlaceKind } from '@whombat/core';
import { currentRow } from '../../connections/http';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import {
  type PlaceDriver,
  type PlaceDriverContext,
  type PlaceDriverFactory,
  PlaceError,
  type PlaceStatus,
} from '../drivers/types';
import { nasAddress, nasPlaceDriver } from './transport';
import { type NasLook, type NasPlaceDriver, NasPlaceError } from './types';

/** How long a NAS's own say and what it keeps are kept for the places list. */
export const NAS_LOOK_MS = 5 * 60_000;

const looks = new WeakMap<Services, Map<string, { at: number; value: Promise<unknown> }>>();

function remembered<T>(services: Services, key: string, fn: () => Promise<T>): Promise<T> {
  let map = looks.get(services);
  if (!map) {
    map = new Map();
    looks.set(services, map);
  }
  const hit = map.get(key);
  const now = Date.now();
  if (hit && now - hit.at < NAS_LOOK_MS) return hit.value as Promise<T>;
  const value = fn();
  const m = map;
  m.set(key, { at: now, value });
  // A failed read isn't kept: the next list asks again.
  value.catch(() => m.delete(key));
  return value;
}

/** After a change on a NAS: the next read asks it again. */
export function forgetNasLooks(services: Services, connectionId: string): void {
  const map = looks.get(services);
  if (!map) return;
  for (const key of [...map.keys()]) if (key.split('|')[1] === connectionId) map.delete(key);
}

/** A NAS driver's failure as the registry's. */
export function placeErrorOf(err: unknown): unknown {
  if (!(err instanceof NasPlaceError)) return err;
  switch (err.reason) {
    case 'unsupported':
      return new PlaceError('unsupported', err.message);
    case 'unreachable':
      return new PlaceError('unreachable', err.message);
    default:
      return new PlaceError('refused', err.message);
  }
}

/** BPL-04's status from a NAS's look, or from why it couldn't look. */
export function nasStatus(
  kind: BackupPlaceKind,
  look: (Pick<NasLook, 'reason' | 'freeBytes'> & Partial<NasLook>) | { error: unknown },
): PlaceStatus {
  if ('error' in look) {
    const err = look.error;
    if (err instanceof NasPlaceError)
      return {
        supported: false,
        reason: err.message,
        byHand: err.reason === 'refused' || err.reason === 'failed',
        freeBytes: null,
      };
    return { supported: false, reason: BACKUP_PLACE_TEXT.reasons.other, byHand: true, freeBytes: null };
  }
  if (look.reason === null)
    return {
      supported: true,
      reason: null,
      byHand: false,
      freeBytes: look.freeBytes,
      locations: look.locations ?? [],
      wasIn: look.wasIn ?? null,
    };
  return { supported: false, reason: look.reason, byHand: kind === 'qnap', freeBytes: null };
}

/** The registry's factory for a NAS kind. */
export function nasDriverFactory(
  kind: 'truenas' | 'synology' | 'qnap',
  make: (services: Services, row: CatalogConnectionRow) => NasPlaceDriver = nasPlaceDriver,
): PlaceDriverFactory {
  return (ctx: PlaceDriverContext): PlaceDriver => {
    const { services, target } = ctx;
    if (target.ref.type !== 'connection') throw new PlaceError('refused', BACKUP_PLACE_TEXT.reasons.other);
    const connectionId = target.ref.id;
    const row = async () => {
      const found = await currentRow(services, connectionId);
      if (!found) throw new PlaceError('unreachable', BACKUP_PLACE_TEXT.refused.gone);
      return found;
    };
    const driver = async () => {
      try {
        return make(services, await row());
      } catch (err) {
        throw placeErrorOf(err);
      }
    };
    /** A change: through the driver, its failure as the registry's, and the kept reads forgotten. */
    const change = async <T>(fn: (d: NasPlaceDriver) => Promise<T>): Promise<T> => {
      try {
        return await fn(await driver());
      } catch (err) {
        throw placeErrorOf(err);
      } finally {
        forgetNasLooks(services, connectionId);
      }
    };
    return {
      ensure: (client, restPassword, location) => change((d) => d.ensure(client, restPassword, location)),
      // Whombat writes a NAS's compose, so its cleanup always takes the windows.
      cleanup: (client, repositoryPassword, keep) =>
        change(async (d) => {
          await d.cleanup(client, repositoryPassword, keep);
          return { windows: true };
        }),
      forget: (client, deleteData) => change((d) => d.forget(client, deleteData)),
      kept: (client): Promise<BackupPlaceKept | null> =>
        remembered(services, `kept|${connectionId}|${client}`, async () => {
          try {
            return await (await driver()).kept(client);
          } catch (err) {
            throw placeErrorOf(err);
          }
        }),
      async addresses() {
        return [await nasAddress(services, await row())];
      },
      status: () =>
        remembered(services, `status|${connectionId}`, async () => {
          try {
            return nasStatus(kind, await (await driver()).look());
          } catch (error) {
            return nasStatus(kind, { error });
          }
        }),
    };
  };
}
