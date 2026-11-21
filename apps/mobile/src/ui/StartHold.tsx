/**
 * Android's launch screen until the first screen is drawn (one-layout-android.md AP-2643, `lib/launchScreen.ts`):
 * `LAUNCH.start()` before the first render, `useLaunchSettle()` in the root, and each placeholder of the start inside
 * `StartHold` — the fonts, the kept sign-in, the Whombat being opened, its burrow, the saved place.
 */
import * as SplashScreen from 'expo-splash-screen';
import { type ReactNode, useEffect } from 'react';
import { createLaunchScreen } from '../lib/launchScreen';

export const LAUNCH = createLaunchScreen({
  keep: () => void SplashScreen.preventAutoHideAsync().catch(() => {}),
  hide: () => SplashScreen.hide(),
  setTimer(fn, ms) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  // Two frames on: what was committed is laid out (the logo keeps Android from drawing it until it goes).
  afterDraw: (fn) => requestAnimationFrame(() => requestAnimationFrame(fn)),
});

/** A placeholder of the start: the logo stays while it shows (it renders its children, if any, underneath). */
export function StartHold({ children }: { children?: ReactNode }) {
  useEffect(() => LAUNCH.hold(), []);
  return children ?? null;
}

/**
 * In the app's first component inside the providers (the safe area renders nothing until it is measured): its first
 * frame is committed, the children's holds counted by then (their effects run first).
 */
export function useLaunchSettle(): void {
  useEffect(() => LAUNCH.settle(), []);
}
