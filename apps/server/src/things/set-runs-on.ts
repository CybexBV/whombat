/**
 * `connections.setRunsOn` (connection-pages.md CP-08; connection-pages-server.md CP-S05): a person who may manage the
 * connection says what it runs on — a server or one of its guests Whombat watches, nothing Whombat watches, or back to
 * automatic. Stored on the connection through the commit pipeline (a shared one's change is a signed
 * `connection.changed`, a personal one's an account-level write, like other connection changes); answers what it runs on
 * now.
 */
import type { SetRunsOnBody, ThingRunsOn } from '@whombat/core';
import { applyChanges } from '../connections/connect';
import { type ConnectionViewer, visibleConnection } from '../connections/store';
import type { StoredRunsOn } from '../db/schema/index';
import { HOSTS_TEXT } from '../hosts/service';
import { ApiError, badRequest } from '../lib/errors';
import type { Services } from '../services';
import { displayName } from './part-of';
import { addressIndex, hostsServing, machineExists, resolveRunsOn } from './runs-on';

export async function setRunsOn(
  services: Services,
  viewer: ConnectionViewer,
  connectionId: string,
  body: SetRunsOnBody,
): Promise<{ runsOn: ThingRunsOn | null }> {
  const row = await visibleConnection(services.db, viewer, connectionId);
  const name = displayName(row);
  let stored: StoredRunsOn | null = null;
  let text: string;
  if (body.mode === 'auto') text = `Let Whombat find what ${name} runs on`;
  else if (body.mode === 'none') {
    stored = { mode: 'none' };
    text = `Said ${name} runs on nothing Whombat watches`;
  } else {
    const hosts = await hostsServing(services, viewer.burrowId);
    if (!hosts)
      throw new ApiError('unavailable', HOSTS_TEXT.absent, { details: { code: 'hosts_unavailable' } });
    if (!(await machineExists(hosts, body.serverId, body.guestId).catch(() => false)))
      throw badRequest(
        body.guestId
          ? 'Whombat doesn’t know that guest on that server.'
          : 'Whombat doesn’t watch that server.',
      );
    stored = { mode: 'chosen', serverId: body.serverId, guestId: body.guestId };
    const known = (await addressIndex(hosts).catch(() => null))?.machines.find(
      (m) => m.serverId === body.serverId && m.guestId === body.guestId,
    );
    text = `Said ${name} runs on ${known?.name ?? body.serverId}`;
  }
  const same = JSON.stringify(row.runsOn ?? null) === JSON.stringify(stored);
  const fresh = same
    ? row
    : (
        await applyChanges(services, viewer, row, { runsOn: stored }, ['runs_on'], {
          text: text.slice(0, 300),
        })
      ).row;
  const resolved = await resolveRunsOn(services, viewer.burrowId, fresh).catch(() => null);
  return { runsOn: resolved?.runsOn ?? null };
}
