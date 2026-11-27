/**
 * Share to Whombat (AP-715, ios-parity.md AP-6322). `startShareCapture` (from index.ts, before anything renders)
 * listens to expo-share-intent. On Android a share that started the app waits in the native module until asked for, and
 * one made while the app runs arrives as a new intent (the activity is singleTask); the module ignores intents without
 * a MIME type (links, push taps). On iPhone the share extension keeps the share in the app group and opens
 * `whombat://dataUrl=…`, which the module reads; React Navigation's linking and the managed root's links skip that URL
 * (`isShareUrl`). Either way the share lands in the pending share (`data/shareInbox`), whether or not anyone is signed in
 * yet.
 *
 * `ShareIntentBridge` sits in the navigation container: once a navigator is up (signed in, managed or not) and a share
 * is pending, it opens the Share screen.
 */
import { File, Paths } from 'expo-file-system';
import { parseShareIntent, ShareIntentModule } from 'expo-share-intent';
import { useEffect } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import {
  currentShare,
  isShareUrl,
  putShare,
  SHARE_APP_GROUP,
  setShareFileCleaner,
  sharePayload,
  subscribeShare,
} from '../data/shareInbox';
import { deviceLocale } from '../i18n/locale';
import { navigationRef } from './hooks';

let started = false;

export function startShareCapture(): void {
  const native = ShareIntentModule;
  // A build without the module (Expo Go) has nothing to share.
  if (started || !native) return;
  started = true;
  const ios = Platform.OS === 'ios';
  // The copies of shared files go once the share is sent, cancelled, replaced or wiped (MX-07): in the cache on Android,
  // in the app group's folder on iPhone (unknown there, nothing is deleted).
  setShareFileCleaner({
    cacheDir: ios ? (Paths.appleSharedContainers[SHARE_APP_GROUP]?.uri ?? '') : Paths.cache.uri,
    remove: (paths) => {
      for (const path of paths) {
        try {
          const file = new File(`file://${path}`);
          if (file.exists) file.delete();
        } catch {
          // Gone already.
        }
      }
    },
  });
  native.addListener('onChange', (event) => {
    try {
      // A share arrives outside the app's screens, so photos are named in the phone's own language.
      putShare(sharePayload(parseShareIntent(event.value, {}), new Date(), deviceLocale()));
    } catch {
      // Not a share we can read: nothing opens.
    }
  });
  if (ios) {
    const take = (url: string | null) => {
      if (isShareUrl(url)) void Promise.resolve(native.getShareIntent(url ?? '')).catch(() => {});
    };
    void Linking.getInitialURL().then(take, () => {});
    Linking.addEventListener('url', ({ url }) => take(url));
    return;
  }
  const ask = () => void Promise.resolve(native.getShareIntent('')).catch(() => {});
  ask();
  // An activity started again by a share while the app's JavaScript kept running: its intent waits to be asked for.
  AppState.addEventListener('change', (state) => {
    if (state === 'active') ask();
  });
}

export function ShareIntentBridge() {
  useEffect(() => {
    let alive = true;
    const open = async () => {
      if (!currentShare()) return;
      for (let i = 0; i < 50 && !navigationRef.isReady(); i++) await new Promise((ok) => setTimeout(ok, 100));
      if (!alive || !navigationRef.isReady() || !currentShare()) return;
      // An open Share screen shows the newest share itself.
      if (navigationRef.getCurrentRoute()?.name === 'Share') return;
      navigationRef.navigate('Share');
    };
    void open();
    const off = subscribeShare(() => void open());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return null;
}
