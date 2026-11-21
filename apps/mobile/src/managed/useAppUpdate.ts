/**
 * Whether a newer build of this app is published (AP-701), for “Update the app” and the update rows: Android compares
 * the APK control hands out with its own `versionCode` (`updateCheckFor`, one answer for the whole app); the iPhone has
 * no APK. `useAppUpdate` gives the APK itself, for the calm “Update
 * available” row (SS-71); `useUpdateCheck` adds where the check stands and “Check for updates” (AP-2972).
 *
 * Asked while `open`: as a screen shows it, when the app comes back to the front, and every five minutes while it
 * stays there, each time only once the last answer is five minutes old (AP-2971).
 */
import type { AndroidDownload, ControlApi } from '@whombat/client/managed';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import {
  type AppUpdateStatus,
  appUpdateStatus,
  newerAppPublished,
  UPDATE_CHECK_FRESH_MS,
  UPDATE_UNASKED,
  type UpdateCheck,
  updateCheckFor,
} from './appUpdate';
import { APP_BUILD } from './config';
import { PHONE_PLATFORM, phoneClient } from './env';

const noSubscription = () => () => {};
const unasked = () => UPDATE_UNASKED;

export interface AppUpdateCheck {
  /** The published APK when it is newer than this build. */
  update: AndroidDownload | null;
  status: AppUpdateStatus;
  /** Asks control now (“Check for updates”, pulling Settings down). */
  checkNow(): Promise<void>;
}

/**
 * The app's update check (AP-2972): null on the iPhone and without a control client (self-hosted, the demo world),
 * where there is no APK to look for.
 */
export function useUpdateCheck(control: ControlApi | null | undefined, open = true): AppUpdateCheck | null {
  const check: UpdateCheck | null = control && PHONE_PLATFORM === 'android' ? updateCheckFor(control) : null;
  const state = useSyncExternalStore(check ? check.subscribe : noSubscription, check ? check.state : unasked);
  useEffect(() => {
    if (!check || !open) return;
    const ask = () => void check.get();
    ask();
    const timer = setInterval(ask, UPDATE_CHECK_FRESH_MS);
    const sub = AppState.addEventListener('change', (next) => next === 'active' && ask());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [check, open]);
  const checkNow = useCallback(async () => {
    await check?.get(true);
  }, [check]);
  const ownBuild = phoneClient(APP_BUILD).buildNumber;
  return useMemo(
    () =>
      check
        ? {
            update: newerAppPublished(state.published, ownBuild) ? state.published : null,
            status: appUpdateStatus(state, ownBuild),
            checkNow,
          }
        : null,
    [check, state, ownBuild, checkNow],
  );
}

/**
 * The published APK when it is newer than this build (SS-71), for “Update available”: null on the iPhone, without a
 * control client (self-hosted, the demo world) and while nothing newer is out.
 */
export function useAppUpdate(control: ControlApi | null | undefined, open = true): AndroidDownload | null {
  return useUpdateCheck(control, open)?.update ?? null;
}
