/**
 * The box's own Web Push key (hermes-engine.md HE-61, HE-S220; contracts 1.1.0 CT-1307): a community box has no control
 * to tell browsers through, so it signs web push itself with a VAPID P-256 pair made at its first start and kept from
 * then on (the public half in `appliance_state.vapid_public_key`, the private half sealed under the master key), so the
 * subscriptions browsers made stay valid across restarts and updates. A configured pair (`VAPID_PUBLIC_KEY`,
 * `VAPID_PRIVATE_KEY`) wins; a commercial box makes none (its browsers and phones are told through control).
 */
import { and, eq, isNull } from 'drizzle-orm';
import webPush from 'web-push';
import { applianceState } from '../db/schema/index';
import type { VapidPair } from '../push/sender';
import type { Services } from '../services';

const STATE_ID = 1;
const PRIVATE_AAD = 'whombat/vapid-private/v1';

/** The box's pair, made and stored on the first call. */
export async function ensureBoxVapid(services: Services): Promise<VapidPair> {
  const read = async (): Promise<VapidPair | null> => {
    const [row] = await services.db
      .select({ pub: applianceState.vapidPublicKey, priv: applianceState.vapidPrivateKeyEnc })
      .from(applianceState)
      .where(eq(applianceState.id, STATE_ID));
    return row?.pub && row.priv
      ? { publicKey: row.pub, privateKey: services.custody.open(PRIVATE_AAD, row.priv) }
      : null;
  };
  const held = await read();
  if (held) return held;
  const pair = webPush.generateVAPIDKeys();
  await services.pipeline.transactAccount(async (tx) => {
    await tx.insert(applianceState).values({ id: STATE_ID }).onConflictDoNothing();
    // Only where none is stored yet: two starts at once keep the first one's.
    await tx
      .update(applianceState)
      .set({
        vapidPublicKey: pair.publicKey,
        vapidPrivateKeyEnc: services.custody.seal(PRIVATE_AAD, pair.privateKey),
        updatedAt: services.clock(),
      })
      .where(and(eq(applianceState.id, STATE_ID), isNull(applianceState.vapidPublicKey)));
  });
  const stored = await read();
  if (!stored) throw new Error('the box’s web push key was not stored');
  return stored;
}
