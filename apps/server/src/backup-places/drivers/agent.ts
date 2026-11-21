/**
 * The agent driver (docs/decisions/backup-places.md BPL-03 a): an Unraid or other Linux server with Whombat's helper,
 * Docker and Manage on, set up through the hosts service's backup-place routes (`../hub.ts`). The hub waits for the agent
 * up to five minutes (pulling the images can take a minute), so its calls get a little longer.
 */
import { BACKUP_PLACE_KEEP_DAYS, type BackupPlaceKept } from '@whombat/core';
import { HOSTS_API, HostsError, seg } from '../../hosts/client';
import { hostsErrorText } from '../../hosts/errors';
import { HOSTS_TEXT, hostsFor, isUnavailable, WHOMBAT_ACTOR } from '../../hosts/service';
import {
  cleanupBody,
  ensureAnswer,
  ensureBody,
  type HubBackupPlace,
  hubBackupPlace,
  PLACE_ROUTES,
  removeBody,
  serverAddress,
} from '../hub';
import { keepHasWindows } from '../keep';
import { placeWords } from '../words';
import { type PlaceDriverContext, type PlaceDriverFactory, PlaceError, type PlaceStatus } from './types';

/** How long a change may take on the hub (it waits up to 5 minutes for the agent). */
export const AGENT_PLACE_TIMEOUT_MS = 5.5 * 60_000;
/** An ensure that names a location may move the backups there, which the hub waits up to an hour for (BPL-14). */
export const AGENT_PLACE_MOVE_TIMEOUT_MS = 61 * 60_000;

/** The address the box's repository names: the hub's own address for the server when the agent reports it, else the first. */
export function pickAddress(addresses: readonly string[], known: string | null): string | null {
  return known && addresses.includes(known) ? known : (addresses[0] ?? null);
}

/** What a server keeps for a client, as the contract says it. */
export function keptOf(place: HubBackupPlace, client: string): BackupPlaceKept {
  const c = place.clients.find((x) => x.client === client);
  return {
    usedBytes: c?.usedBytes ?? null,
    freeBytes: place.freeBytes,
    cleanup: {
      on: c?.cleanup.set === true,
      keepDays: c?.cleanup.keepDays ?? BACKUP_PLACE_KEEP_DAYS,
      lastAt: c?.cleanup.lastAt ?? null,
      ok: c?.cleanup.ok ?? null,
    },
    byHand: false,
  };
}

export const agentDriver: PlaceDriverFactory = (ctx: PlaceDriverContext) => {
  const { target } = ctx;
  if (target.ref.type !== 'server') throw new Error(`agent driver for ${target.id}`);
  const serverId = target.ref.id;
  const hosts = hostsFor(ctx.services);

  /** A hub refusal or silence as a place error, in Whombat's words. */
  const failed = (err: unknown): never => {
    if (err instanceof PlaceError) throw err;
    if (isUnavailable(err)) throw new PlaceError('unreachable', HOSTS_TEXT.down);
    if (err instanceof HostsError) {
      if (err.code === 'self') throw new PlaceError('unsupported', placeWords.reason('self'));
      // The service's own sentence is for operators; its reason code picks Whombat's words.
      if (err.code === 'unsupported') throw new PlaceError('unsupported', placeWords.reason(err.reason));
      throw new PlaceError('refused', hostsErrorText(err, { server: target.name }));
    }
    throw err;
  };

  const detail = () =>
    hosts.call<unknown>({
      path: `${HOSTS_API}/servers/${seg(serverId)}`,
      actor: { ...WHOMBAT_ACTOR, role: 'admin' },
    });

  const change = <T>(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    admin = false,
    timeoutMs = AGENT_PLACE_TIMEOUT_MS,
  ) =>
    hosts
      .call<T>({
        method,
        path,
        body,
        actor: { ...ctx.actor, role: admin ? 'admin' : 'operator' },
        timeoutMs,
      })
      .catch(failed);

  return {
    async ensure(client, restPassword, location) {
      const raw = await detail().catch(failed);
      const place = hubBackupPlace(raw);
      const before = place?.clients.find((c) => c.client === client)?.location ?? null;
      const answer = ensureAnswer(
        await change(
          'POST',
          PLACE_ROUTES.ensure(serverId),
          ensureBody(client, restPassword, 0, location),
          false,
          location && location !== before ? AGENT_PLACE_MOVE_TIMEOUT_MS : AGENT_PLACE_TIMEOUT_MS,
        ),
      );
      const addresses = answer.addresses.length ? answer.addresses : (place?.addresses ?? []);
      const address = pickAddress(addresses, serverAddress(raw));
      if (!address || !answer.port) throw new PlaceError('refused', placeWords.noAddress(target.name));
      const root = place?.root ?? null;
      return {
        address,
        port: answer.port,
        path: root ? `${root}/${client}` : client,
        location: answer.location ?? location ?? before,
      };
    },

    async cleanup(client, repositoryPassword, keep, windows) {
      // A helper whose cleanup reports what it keeps takes the windows; any other gets the longest one in days.
      const reported = async () =>
        hubBackupPlace(await detail().catch(failed))?.clients.find((c) => c.client === client)?.cleanup
          .keep != null;
      const takes = windows ?? (await reported());
      const put = (w: boolean) =>
        change('PUT', PLACE_ROUTES.cleanup(serverId, client), cleanupBody(repositoryPassword, keep, w));
      await put(takes);
      // Not known yet (a cleanup it never had): a helper that reports what it keeps now takes the windows at once.
      if (windows === undefined && !takes && keepHasWindows(keep) && (await reported())) {
        await put(true);
        return { windows: true };
      }
      return { windows: takes };
    },

    async cleanupReport(client) {
      const c = hubBackupPlace(await detail().catch(failed))?.clients.find((x) => x.client === client);
      return c ? { set: c.cleanup.set, keep: c.cleanup.keep } : null;
    },

    async forget(client, deleteData) {
      await change('DELETE', PLACE_ROUTES.remove(serverId, client), removeBody(deleteData), deleteData);
    },

    async kept(client) {
      const place = hubBackupPlace(await detail().catch(failed));
      return place ? keptOf(place, client) : null;
    },

    async addresses() {
      const raw = await detail().catch(failed);
      const place = hubBackupPlace(raw);
      const known = serverAddress(raw);
      const list = place?.addresses ?? [];
      const first = pickAddress(list, known);
      return first ? [first, ...list.filter((a) => a !== first)] : list;
    },

    async status(): Promise<PlaceStatus> {
      const place = hubBackupPlace(await detail().catch(failed));
      return {
        supported: place?.supported === true,
        reason: place ? (place.supported ? null : placeWords.reason(place.reason)) : placeWords.helperOld,
        byHand: false,
        freeBytes: place?.freeBytes ?? null,
        locations: place?.locations ?? [],
        wasIn: null,
      };
    },
  };
};
