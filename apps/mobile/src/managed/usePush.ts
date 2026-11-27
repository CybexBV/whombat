/**
 * The phone's push for the open managed Whombat (AP-29): registers once the session is open, follows token rotations,
 * records when a push arrives — natively, whether or not the app runs — and refreshes the inbox then. Its state is
 * separate from the session's (assignment §12). Notifications come on by themselves wherever the phone lets them
 * (`pushStart`): allowed already, it registers without a word; an iPhone never asked is allowed quietly (provisional,
 * no question) and registers; Android 13 and later never asked gets one sheet with the reason at this first open, and
 * Settings → Notifications keeps Turn on after Not now.
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
import { allowedQuietly, osMajor, type PushFacts, pushFacts, pushStart } from '../push/autoOn';
import { phoneNotifications } from '../push/phoneNotifications';
import { pushPrompt } from '../push/promptStore';
import { devRelayToken } from '../push/registration';
import { PUSH_RELAY } from './config';
import type { ManagedPush } from './context';
import { type NativePush, type PushAsk, registerBoxPush, registerManagedPush, savedPushState } from './push';
import { secureStore } from './secureStore';
import { secretPushStore } from './stores';

export const pushStore = secretPushStore(secureStore);

/**
 * iOS's quiet notifications: no question shows, they wait in Notification Center, and iOS offers Keep or Turn off. The
 * alert, badge and sound are what Keep turns on.
 */
const QUIETLY = { ios: { allowProvisional: true, allowAlert: true, allowBadge: true, allowSound: true } };

const PLATFORM: PushFacts['platform'] =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'other';

/** Where the phone stands, without asking (`notNow`: said on this phone). */
export async function readPushFacts(notNow: boolean): Promise<PushFacts> {
  return pushFacts(await Notifications.getPermissionsAsync(), PLATFORM, osMajor(Platform.Version), notNow);
}

export const expoNativePush: NativePush = {
  platform: Platform.OS === 'ios' ? 'apns' : 'fcm',
  appId: 'com.whombat.mobile',
  async permission(how) {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return 'granted';
    if (how === 'ask') {
      // On an iPhone allowed quietly this is the question that turns them into alerts.
      if (!current.canAskAgain) return allowedQuietly(current) ? 'granted' : 'denied';
      const answer = await Notifications.requestPermissionsAsync();
      return answer.granted || allowedQuietly(answer) ? 'granted' : 'denied';
    }
    if (allowedQuietly(current)) return 'granted';
    const never = current.canAskAgain && current.status === 'undetermined';
    if (how === 'quietly' && never && Platform.OS === 'ios') {
      const answer = await Notifications.requestPermissionsAsync(QUIETLY);
      if (answer.granted || allowedQuietly(answer)) return 'granted';
      return answer.status === 'denied' ? 'denied' : 'undetermined';
    }
    return never ? 'undetermined' : 'denied';
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
  // An iPhone allowed quietly (provisional): on, without alerts; Settings offers to turn alerts on.
  const [quiet, setQuiet] = useState(false);
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
    async (ask: PushAsk) => {
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
        // Decided (or nothing to decide): the sheet's question is answered.
        if (next.status !== 'off') pushPrompt.withdraw();
        if (next.status === 'registered')
          void readPushFacts(false).then(
            (f) => setQuiet(f.provisional),
            () => {},
          );
      } finally {
        running.current = false;
      }
    },
    [control, session, device, via],
  );

  // The first open of this session: on by themselves where the phone lets them be, else the sheet's one question.
  const start = useCallback(async () => {
    const notNow = await pushPrompt.notNowKept();
    const plan = await readPushFacts(notNow).then(pushStart, () => 'register' as const);
    if (plan === 'sheet') {
      setState((s) => (s.status === 'registered' ? s : { status: 'off' }));
      pushPrompt.offer(() => register('ask'));
      return;
    }
    await register(plan === 'quietly' ? 'quietly' : 'look');
  }, [register]);

  useEffect(() => {
    // The box keeps a box-registered phone's token itself: nothing saved here to show first.
    if (via === 'box') return;
    void savedPushState(pushStore, device).then((s) => setState((cur) => (cur.status === 'off' ? s : cur)));
  }, [device, via]);

  // Once per open session of this appliance: on by themselves where the phone lets them be.
  const opened = connection.status === 'open';
  const registeredOnce = useRef(false);
  useEffect(() => {
    if (!opened || registeredOnce.current) return;
    registeredOnce.current = true;
    void start();
  }, [opened, start]);
  useEffect(() => () => pushPrompt.withdraw(), []);

  useEffect(() => {
    const offs = [
      phoneNotifications.onPush((push) => {
        setLastReceivedAt(Date.now());
        void qc.invalidateQueries({ queryKey: queryKeys.scope('notifications.inbox') });
        // The desk screen asking to unlock comes as `security` (desk-display-android.md AP-3055): its card shows at once.
        if (push.kind === 'security') void qc.invalidateQueries({ queryKey: DESK_QUERY_KEY });
      }),
      WhombatLive.onPushToken(() => void register('look')),
    ];
    const tokenSub = Notifications.addPushTokenListener(() => void register('look'));
    // Pushes that arrived while the app was in the background, and a permission changed in the settings.
    const appState = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      noteLastPush();
      if (!registeredOnce.current) return;
      // Allowed in the settings since (or a failed registration): try again, without asking.
      if (current.current.status !== 'registered') {
        void register('look');
        return;
      }
      // Kept or turned off on an iPhone (iOS's Keep and Turn off on a quiet notification, or its settings). Android
      // says what it holds back on the row itself (`useDelivery`).
      void readPushFacts(false).then(
        (f) => {
          setQuiet(f.provisional);
          if (Platform.OS === 'ios' && f.status === 'denied') setState({ status: 'denied' });
        },
        () => {},
      );
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
      quiet: state.status === 'registered' && quiet,
      lastReceivedAt,
      enable: () => void register('ask'),
      openSettings: () => void Linking.openSettings(),
    }),
    [state, quiet, lastReceivedAt, register],
  );
}
