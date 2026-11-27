/**
 * “Needs you to sign in again” (CX-15): once per connection per 24 hours, the person hears it from the agent in their Chat,
 * like the Google repair message (assistant-guides.md AG-13).
 */
import { type CatalogReauthReason, thingId } from '@whombat/core';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { applyContext } from '../commit/pipeline';
import { catalogConnections } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { thePerson } from '../domain/the-person';
import { personalPlace } from '../guides/place';
import { type ServerMessageKey, tServer } from '../i18n/catalog';
import { burrowLocale } from '../i18n/locale';
import { iso } from '../lib/time';
import { toActor } from '../read/principals';
import type { Services } from '../services';
import { quietNow } from '../things/quiet/defaults';
import { thingQuiet } from '../things/quiet/store';
import { connectionRow } from './store';
import type { CatalogConnectionRow } from './types';

/** At most one message per connection in this long. */
export const REPAIR_SPACING_MS = 24 * 60 * 60_000;

/** Why the service stopped letting the assistant in, as the assistant says it, by the reason's code. */
const REASON_KEY: Record<CatalogReauthReason, ServerMessageKey> = {
  token_invalid: 'chat.repair.token_invalid',
  revoked: 'chat.repair.revoked',
  app_removed: 'chat.repair.app_removed',
  expired: 'chat.repair.expired',
};

export function repairText(
  row: Pick<CatalogConnectionRow, 'label' | 'reauthReason'>,
  locale?: string | null,
): string {
  return tServer(locale, REASON_KEY[row.reauthReason ?? 'revoked'], { name: row.label });
}

/** Posts `text` in the person's DM with their Assistant in that burrow; false without one. */
export async function tellPerson(
  services: Services,
  burrowId: string,
  personId: string,
  text: string,
): Promise<boolean> {
  const { result } = await services.pipeline.transact(burrowId, async (session) => {
    const place = await personalPlace(session.tx, burrowId, personId);
    if (!place) return false;
    const now = services.clock();
    const ctx = applyContext(session, {
      burrow: place.burrow,
      actor: toActor(place.agent),
      now,
      at: iso(now),
      decision: null,
      requirement: null,
      approvalId: null,
      onBehalfOf: {},
    });
    await postMessage(ctx, {
      conversation: place.dm,
      text,
      mentions: [],
      dispatch: false,
    });
    return true;
  });
  return result;
}

/**
 * Tells the person that the connection needs connecting again, at most once a day. Never throws. Not while its
 * sign-in is ignored, snoozed or not watched (quiet-notices.md QN-S19): its line says it, quietly.
 */
export async function notifyNeedsReauth(services: Services, connectionId: string): Promise<number> {
  try {
    const now = services.clock();
    const row = await connectionRow(services.db, connectionId);
    if (!row) return 0;
    const quiet = await thingQuiet(services.db, row.burrowId, thingId('connection', row.id));
    if (quietNow(quiet, 'conn.signin', '', now)) return 0;
    const [claimed] = await services.pipeline.transactAccount((tx) =>
      tx
        .update(catalogConnections)
        .set({ repairNotifiedAt: now })
        .where(
          and(
            eq(catalogConnections.id, connectionId),
            eq(catalogConnections.status, 'needs_reauth'),
            or(
              isNull(catalogConnections.repairNotifiedAt),
              lt(catalogConnections.repairNotifiedAt, new Date(now.getTime() - REPAIR_SPACING_MS)),
            ),
          ),
        )
        .returning(),
    );
    if (!claimed) return 0;
    const person = await thePerson(services.db, claimed.burrowId);
    if (!person) return 0;
    const locale = await burrowLocale(services, claimed.burrowId);
    return (await tellPerson(services, claimed.burrowId, person.id, repairText(claimed, locale))) ? 1 : 0;
  } catch (err) {
    services.log.warn({ connectionId, err: String(err) }, 'connection repair message failed');
    return 0;
  }
}
