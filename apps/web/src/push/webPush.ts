/**
 * Desktop web push (TODO 9.4, `docs/decisions/web-push-connect.md`): register `apps/web/public/sw.js`,
 * subscribe/unsubscribe with a VAPID key, and turn a `PushSubscription` into the request body
 * `devices.register` expects. Pure browser-API wrappers, no React — `useWebPush.ts` is the hook.
 */

/** `'serviceWorker' in navigator && 'PushManager' in window`, safe to call anywhere (incl. SSR-less tests). */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window
  );
}

/** VAPID public keys are URL-safe base64; `PushManager.subscribe` wants a raw `Uint8Array`. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The language the service worker writes notifications without a preview in (it can't read `localStorage`). */
let workerLanguage: 'en' | 'nl' = 'en';

/**
 * The worker's script address: `/sw.js` in English, `/sw.js?lang=nl` in Dutch, so a worker started fresh by a push
 * (no page open) still knows the language.
 */
export function serviceWorkerUrl(language: 'en' | 'nl' = workerLanguage): string {
  return language === 'nl' ? '/sw.js?lang=nl' : '/sw.js';
}

/** Registers (or reuses) the shell's service worker. Idempotent — the browser dedupes by script URL. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(serviceWorkerUrl());
}

/**
 * Tells the service worker which language to use: kept for the next registration, and sent to a worker that is
 * already running (`{type: 'locale', lang}`), which keeps it in its own cache for the next start.
 */
export function setServiceWorkerLanguage(language: 'en' | 'nl'): void {
  const changed = language !== workerLanguage;
  workerLanguage = language;
  if (!changed || !isPushSupported()) return;
  void (async () => {
    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      if (!registration) return;
      registration.active?.postMessage({ type: 'locale', lang: language });
      // Register again under the new address so a fresh worker starts in this language too.
      await navigator.serviceWorker.register(serviceWorkerUrl(language));
    } catch {
      // No worker yet: the next registration uses the new address.
    }
  })();
}

/** The existing push subscription for this browser, if any, without prompting for permission. */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/** Subscribes this browser to push. Triggers the browser's own permission prompt (a user gesture only). */
export async function subscribePush(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<PushSubscription> {
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    // TS's DOM lib types `Uint8Array` as generic over `ArrayBufferLike`; `applicationServerKey` wants
    // the plain `ArrayBuffer` form. The bytes are the same either way.
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
  });
}

/** Unsubscribes this browser locally; the caller still needs `devices.remove` to stop server pushes. */
export async function unsubscribePush(subscription: PushSubscription): Promise<boolean> {
  return subscription.unsubscribe();
}
