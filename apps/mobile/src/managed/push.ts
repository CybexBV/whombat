/**
 * Managed push on the phone (MA-10, MA-18; AP-29): the FCM (Android) or APNs (iOS) token goes to control over the
 * cloud session, control answers with an opaque handle, and the handle goes to the open appliance over the secure
 * session (`push.handles.set`). Notifications are content-free; a tap opens the app, which asks the session what
 * happened. Pure: the platform and control are injected (unit-tested); `usePush.ts` wires expo-notifications.
 */
import {
  type ControlApi,
  ensurePushHandle,
  type PushState,
  type PushStore,
  tellAppliance,
} from '@whombat/client/managed';
import { type ApplianceSession, OperationError, sessionOps } from '@whombat/client/session';

export interface NativePush {
  platform: 'fcm' | 'apns';
  /** The app's id for control (`NativePushRegistration.appId`): FCM project / APNs topic. */
  appId: string;
  /** Whether notifications are allowed; asks (the system dialog) only when `ask` and the person hasn't decided. */
  permission(ask: boolean): Promise<'granted' | 'denied' | 'undetermined'>;
  /** The device token; throws when this build or device has no push service. */
  token(): Promise<string>;
}

export async function registerManagedPush(input: {
  native: NativePush;
  control: Pick<ControlApi, 'pushRegister' | 'pushUnregister'>;
  store: PushStore;
  session: ApplianceSession;
  device: string;
  ask: boolean;
}): Promise<PushState> {
  const { native, control, store, session, device, ask } = input;
  const permission = await native.permission(ask).catch(() => 'denied' as const);
  if (permission === 'undetermined') return { status: 'off' };
  if (permission === 'denied') return { status: 'denied' };
  let token: string;
  try {
    token = await native.token();
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const saved = await ensurePushHandle(control, store, {
      platform: native.platform,
      token,
      appId: native.appId,
    });
    await tellAppliance(session, store, device, saved);
    return { status: 'registered', handle: saved.handle };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Push through the box (Whombat docs/decisions/whombat-link.md LNK-36): a phone that joined a Whombat without a cloud
 * account hands its token to the box (`push.token.set`), which registers it with Whombat Link. While Link is off the
 * box keeps it and registers it once Link is on: the row says there are no notifications yet. A box before Link
 * (`unknown_op`) sends none to phones.
 */
export async function registerBoxPush(input: {
  native: NativePush;
  session: ApplianceSession;
  ask: boolean;
}): Promise<PushState> {
  const { native, session, ask } = input;
  const permission = await native.permission(ask).catch(() => 'denied' as const);
  if (permission === 'undetermined') return { status: 'off' };
  if (permission === 'denied') return { status: 'denied' };
  let token: string;
  try {
    token = await native.token();
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const out = await sessionOps.pushTokenSet(session, {
      platform: native.platform,
      token,
      appId: native.appId,
    });
    return out.registered
      ? { status: 'registered', handle: BOX_PUSH_HANDLE }
      : { status: 'unavailable', reason: 'link_off' };
  } catch (error) {
    if (error instanceof OperationError && error.code === 'unknown_op')
      return { status: 'unavailable', reason: 'community' };
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The handle a box-registered phone shows (the real one is the box's, at control). */
export const BOX_PUSH_HANDLE = 'box';

/** Signed out: the box stops sending this phone's pushes. Nothing to do when the session isn't open. */
export async function clearBoxPush(session: ApplianceSession | null): Promise<void> {
  if (!session) return;
  await sessionOps.pushTokenClear(session).catch(() => {});
}

/** What this install had set up for `device` (shown before the first registration of this run finishes). */
export async function savedPushState(store: PushStore, device: string): Promise<PushState> {
  const saved = await store.get().catch(() => null);
  return saved?.appliances.includes(device)
    ? { status: 'registered', handle: saved.handle }
    : { status: 'off' };
}
