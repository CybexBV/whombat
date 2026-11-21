/**
 * `whombat-fold` — what a folding phone says about its screen (docs/app/decisions/iphone-duo.md): the edge where the
 * system keeps its own vertical bar (the iPhone Duo's clock and buttons), the fold, the clock's and cameras' regions,
 * and whether the phone is flat, half open or closed. Swift (iOS 27.1's reserved regions, hinge and vertical bar) and
 * Kotlin (Jetpack WindowManager); rectangles are in window points (dp on Android). Without the module (tests, older
 * builds) there is nothing to report.
 */
import { requireOptionalNativeModule } from 'expo';

import { type FoldInfo, foldInfoOf } from './parse';

export type { FoldInfo, FoldRect, Posture } from './parse';

interface NativeWhombatFold {
  current(): unknown;
  addListener(event: 'onChange', listener: (event: unknown) => void): { remove(): void };
}

const native = requireOptionalNativeModule<NativeWhombatFold>('WhombatFold');

/** The state as the native side last read it, or null when it hasn't (yet). */
export function currentFold(): FoldInfo | null {
  return native ? foldInfoOf(native.current()) : null;
}

/** Calls `listener` with every new state; returns the unsubscribe. */
export function onFoldChange(listener: (info: FoldInfo) => void): () => void {
  const sub = native?.addListener('onChange', (event) => {
    const info = foldInfoOf(event);
    if (info) listener(info);
  });
  return () => sub?.remove();
}
