/**
 * `@whombat/client/web` — browser-only helpers (DOM APIs). React Native has its own equivalents
 * (AppState, NetInfo) in the mobile app.
 */
import type { Realtime } from '../realtime/realtime';

/**
 * Reconnect right away when the browser comes back online or the tab becomes visible again, instead
 * of waiting out the backoff. Returns a cleanup function.
 */
export function bindBrowserLifecycle(realtime: Realtime, target: Window = window): () => void {
  const wake = () => {
    if (target.document.visibilityState !== 'hidden') realtime.reconnectNow();
  };
  target.addEventListener('online', wake);
  target.document.addEventListener('visibilitychange', wake);
  return () => {
    target.removeEventListener('online', wake);
    target.document.removeEventListener('visibilitychange', wake);
  };
}

export { createObjectUrlCache, type ObjectUrlCache, type ObjectUrlEntry, saveResource } from './resources';
