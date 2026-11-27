/**
 * When the person last touched the app. Live faces blink only while someone is there: they stop two minutes after the
 * last touch or change and start again with the next. Kept apart from the face engine so the app's root can report
 * touches without loading the faces' drawings.
 */

let last = Date.now();
const listeners = new Set<() => void>();

/** A touch anywhere in the app (the root view's `onTouchStart`). */
export function markFaceActivity(): void {
  last = Date.now();
  for (const listener of listeners) listener();
}

/** When the last touch was, ms since the epoch. */
export function lastFaceActivity(): number {
  return last;
}

/** Hears every touch; returns the way to stop. */
export function onFaceActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
