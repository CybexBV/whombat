/**
 * The phone's push for the open managed Whombat (AP-29): registers once the session is open, follows token rotations,
 * records when a push arrives — natively, whether or not the app runs — and refreshes the inbox then. Its state is
 * separate from the session's (assignment §12). It never asks cold (MN-05): while the system hasn't asked, the inbox's
 * card offers “Turn on” with a reason, and so does Settings → Notifications after “Not now”.
 */
import { useQueryClient } from '@tanstack/react-query';
import { DESK_QUERY_KEY } from '@whombat/client/desk/react';
import type { ControlApi, PushState } from '@whombat/client/managed';
import { queryKeys } from '@whombat/client/query';
import type { ApplianceSession, ConnectionState } from '@whombat/client/session';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { WhombatLive } from '../../modules/whombat-live';
import { phoneNotifications } from '../push/phoneNotifications';
import { pushPrompt } from '../push/promptStore';
import { devRelayToken } from '../push/registration';
import { PUSH_RELAY } from './config';
import type { ManagedPush } from './context';
import { type NativePush, registerBoxPush, registerManagedPush, savedPushState } from './push';
import { secureStore } from './secureStore';
import { secretPushStore } from './stores';

export const pushStore = secretPushStore(secureStore);

export const expoNativePush: NativePush = {
  platform: Platform.OS === 'ios' ? 'apns' : 'fcm',
  appId: 'com.whombat.mobile',
  async permission(ask) {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return 'granted';
    if (!ask) return current.canAskAgain && current.status === 'undetermined' ? 'undetermined' : 'denied';
    if (!current.canAskAgain) return 'denied';
    return (await Notifications.requestPermissionsAsync()).granted ? 'granted' : 'denied';
  },
  async token() {
    try {
      return String((await Notifications.getDevicePushTokenAsync()).data);
    } catch (error) {
      // Test builds without Firebase: control's FCM stand-in delivers this token's pushes with adb
      // (`scripts/push.mjs fcm`). Never in a shipped build (the variable isn't set there).
      if (PUSH_RELAY) return devRelayToken(Device.osBuildId ?? Device.modelName ?? 'device');
      throw error;
    }
  },
};

export function useManagedPush(input: {
  control: ControlApi;
  session: ApplianceSession;
  device: string;
  connection: ConnectionState;
  /**
   * `control` (a phone signed in through the cloud): the token goes to control, the handle to the box. `box` (a phone
   * that joined without a cloud account, whombat-link.md LNK-36): the token goes to the box, which registers it with
   * Whombat Link.
   */
  via?: 'control' | 'box';
}): ManagedPush {
  const { control, session, device, connection, via = 'control' } = input;
  const qc = useQueryClient();
  const [state, setState] = useState<PushState>({ status: 'off' });
  const current = useRef(state);
  current.current = state;
  const [lastReceivedAt, setLastReceivedAt] = useState<number | null>(() => WhombatLive.lastGenericPushAt());
  // Android knows natively when the last push came; iOS from the notifications still on screen (never later than one
  // this app saw arrive).
  const noteLastPush = useCallback(() => {
    void phoneNotifications.lastPushAt().then((at) => {
      if (at !== null) setLastReceivedAt((cur) => (Platform.OS === 'ios' ? Math.max(cur ?? 0, at) : at));
    });
  }, []);
  useEffect(() => noteLastPush(), [noteLastPush]);
  const running = useRef(false);

  const register = useCallback(
    async (ask: boolean) => {
      if (running.current) return;
      running.current = true;
      setState((s) => (s.status === 'registered' ? s : { status: 'registering' }));
      try {
        const next =
          via === 'box'
            ? await registerBoxPush({ native: expoNativePush, session, ask })
            : await registerManagedPush({
                native: expoNativePush,
                control,
                store: pushStore,
                session,
                device,
                ask,
              });
        setState(next);
        // Not asked yet: the inbox's card asks, with a reason (MN-05).
        if (next.status === 'off') pushPrompt.offer(() => register(true));
        else pushPrompt.withdraw();
      } finally {
        running.current = false;
      }
    },
    [control, session, device, via],
  );

  useEffect(() => {
    // The box keeps a box-registered phone's token itself: nothing saved here to show first.
    if (via === 'box') return;
    void savedPushState(pushStore, device).then((s) => setState((cur) => (cur.status === 'off' ? s : cur)));
  }, [device, via]);

  // Once per open session of this appliance: register when notifications are allowed; never asks here (MN-05).
  const opened = connection.status === 'open';
  const registeredOnce = useRef(false);
  useEffect(() => {
    if (!opened || registeredOnce.current) return;
    registeredOnce.current = true;
    void register(false);
  }, [opened, register]);
  useEffect(() => () => pushPrompt.withdraw(), []);

  useEffect(() => {
    const offs = [
      phoneNotifications.onPush((push) => {
        setLastReceivedAt(Date.now());
        void qc.invalidateQueries({ queryKey: queryKeys.scope('notifications.inbox') });
        // The desk screen asking to unlock comes as `security` (desk-display-android.md AP-3055): its card shows at once.
        if (push.kind === 'security') void qc.invalidateQueries({ queryKey: DESK_QUERY_KEY });
      }),
      WhombatLive.onPushToken(() => void register(false)),
    ];
    const tokenSub = Notifications.addPushTokenListener(() => void register(false));
    // Pushes that arrived while the app was in the background, and a permission changed in the settings.
    const appState = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      noteLastPush();
      // Allowed in the settings since (or a failed registration): try again, without asking.
      if (registeredOnce.current && current.current.status !== 'registered') void register(false);
    });
    return () => {
      for (const off of offs) off();
      tokenSub.remove();
      appState.remove();
    };
  }, [qc, register, noteLastPush]);

  return useMemo(
    () => ({
      state,
      lastReceivedAt,
      enable: () => void register(true),
      openSettings: () => void Linking.openSettings(),
    }),
    [state, lastReceivedAt, register],
  );
}
