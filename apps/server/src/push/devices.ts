/**
 * Turns rows (`devices`, `live_activities`) into the `PushDevice` shape the transports send to, and prunes
 * a device when a transport reports its token is gone (404/410, `UNREGISTERED`, `BadDeviceToken`, …).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { devices, liveActivities, principals } from '../db/schema/index';
import type { PushDevice } from './types';

type DeviceRow = typeof devices.$inferSelect;

function toPushDevice(row: DeviceRow): PushDevice {
  return {
    id: row.id,
    provider: row.provider,
    token: row.token,
    webPush: row.webPush ?? null,
  };
}

/** The account behind a burrow principal (person), or `null` for agents / people without a login yet. */
async function accountIdOf(db: Db, principalId: string): Promise<string | null> {
  const [row] = await db
    .select({ accountId: principals.accountId })
    .from(principals)
    .where(eq(principals.id, principalId));
  return row?.accountId ?? null;
}

/** Every push target of a person, across every account device (a phone gets DMs from every burrow). */
export async function devicesForPrincipal(db: Db, principalId: string): Promise<PushDevice[]> {
  const accountId = await accountIdOf(db, principalId);
  if (!accountId) return [];
  const rows = await db.select().from(devices).where(eq(devices.accountId, accountId));
  return rows.map(toPushDevice);
}

/**
 * Push targets for one live activity (a run or a pending approval), for the principals given (the person).
 * Android devices always get the data push (it drives the ongoing / Live Update notification); browsers get none.
 * iOS devices use, in order of preference: a token already registered for this exact activity
 * (`devices.registerLiveActivity`, an update token), else the account's push-to-start token
 * (`Device.liveActivityToken`) so the activity can be started remotely; an iOS device with neither is
 * skipped — it has not opted in to this activity yet.
 */
export async function devicesForActivity(
  db: Db,
  kind: 'run' | 'approval',
  refId: string,
  principalIds: readonly string[],
): Promise<PushDevice[]> {
  const ids = [...new Set(principalIds)];
  if (ids.length === 0) return [];
  const accountRows = await db
    .select({ accountId: principals.accountId })
    .from(principals)
    .where(inArray(principals.id, ids));
  const accountIds = [...new Set(accountRows.map((r) => r.accountId).filter((x): x is string => !!x))];
  if (accountIds.length === 0) return [];
  const deviceRows = await db.select().from(devices).where(inArray(devices.accountId, accountIds));
  if (deviceRows.length === 0) return [];
  const registered = await db
    .select()
    .from(liveActivities)
    .where(
      and(
        inArray(
          liveActivities.deviceId,
          deviceRows.map((d) => d.id),
        ),
        eq(liveActivities.kind, kind),
        eq(liveActivities.refId, refId),
      ),
    );
  const registeredByDevice = new Map(registered.map((r) => [r.deviceId, r]));
  const out: PushDevice[] = [];
  for (const row of deviceRows) {
    // A browser has no live activity or ongoing notification: the data push would show as a stray notification.
    if (row.provider === 'webpush') continue;
    if (row.provider !== 'apns') {
      out.push(toPushDevice(row));
      continue;
    }
    const reg = registeredByDevice.get(row.id);
    const liveActivity = { kind, refId };
    if (reg) {
      out.push({ id: row.id, provider: 'apns', token: reg.pushToken, webPush: null, liveActivity });
    } else if (row.liveActivityToken) {
      out.push({
        id: row.id,
        provider: 'apns',
        token: row.liveActivityToken,
        webPush: null,
        apnsPushToStart: true,
        liveActivity,
      });
    }
  }
  return out;
}

/** Deletes a device the push service reports as gone. Safe to call for an id that no longer exists. */
export async function pruneDevice(db: Db, deviceId: string): Promise<void> {
  await db.delete(devices).where(eq(devices.id, deviceId));
}

/**
 * Removes what the push service reports as gone: the device, or for a live activity's token only that token (the
 * activity's registration, or the device's push-to-start token while it is still the one sent to). The phone keeps its
 * alert token: a live activity's token going stale says nothing about it.
 */
export async function prunePushTarget(db: Db, target: PushDevice): Promise<void> {
  const activity = target.liveActivity;
  if (!activity) return pruneDevice(db, target.id);
  if (target.apnsPushToStart) {
    await db
      .update(devices)
      .set({ liveActivityToken: null })
      .where(and(eq(devices.id, target.id), eq(devices.liveActivityToken, target.token)));
    return;
  }
  await db
    .delete(liveActivities)
    .where(
      and(
        eq(liveActivities.deviceId, target.id),
        eq(liveActivities.kind, activity.kind),
        eq(liveActivities.refId, activity.refId),
        eq(liveActivities.pushToken, target.token),
      ),
    );
}
