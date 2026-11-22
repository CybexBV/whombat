/**
 * Home Assistant's Restart (connection-pages.md CP-12; connection-pages-server.md CP-S18), the `homeassistant` kind's
 * `actions.restart` (service-dashboards.md SD-S04): `POST /api/services/homeassistant/restart` as the connection, after
 * the central checks in `things/actions.ts`; recorded as “Restarted Home Assistant” (kind `thing.restart`, no Undo).
 */
import { externalEffect } from '../../commit/scope';
import { ConnectionChangedError } from '../../connections/call-target';
import { signedConnectionFetch } from '../../connections/http';
import { ConnectionAuthError } from '../../connections/types';
import { ApiError, conflict, forbidden } from '../../lib/errors';
import { VaultCallError } from '../../vault/net';
import { displayName } from '../part-of';
import { writeDone } from './act';
import type { KindAction } from './registry';

export const RESTARTING_TEXT = 'Restarting Home Assistant. It’s back in about a minute.';

/** Restarts Home Assistant as the connection; refusals and failures in plain words. */
export const restartHomeAssistant: KindAction = async ({ services, row }) => {
  let status: number;
  try {
    const res = await externalEffect(
      'things.restart',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method: 'POST',
            url: `${row.baseUrl.replace(/\/+$/, '')}/api/services/homeassistant/restart`,
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
          { deadlineMs: 15_000 },
        ),
      { refused: (err) => err instanceof ConnectionAuthError || err instanceof ConnectionChangedError },
    );
    status = res.status;
  } catch (err) {
    if (err instanceof ConnectionAuthError)
      throw conflict('Home Assistant needs you to sign in again first.');
    if (err instanceof VaultCallError && err.reason === 'timeout')
      throw new ApiError(
        'unavailable',
        'Home Assistant didn’t answer. It may be restarting already; look again in a minute.',
      );
    throw new ApiError('unavailable', 'Whombat couldn’t reach Home Assistant just now.');
  }
  if (status === 401 || status === 403)
    throw forbidden('Home Assistant refused: Whombat’s account there isn’t an administrator.');
  if (status >= 400)
    throw new ApiError('unavailable', 'Home Assistant answered with an error and didn’t restart.');
  // A redirect (a sign-in page in front of it, say) doesn't say it restarts.
  if (!writeDone(status))
    throw new ApiError('unavailable', 'Home Assistant didn’t confirm the restart. Look again in a minute.');
  return { message: RESTARTING_TEXT, title: `Restarted ${displayName(row)}` };
};
