/**
 * Web push service worker. Registered by the app shell (`navigator.serviceWorker.register('/sw.js')` +
 * subscribing with the `devices.vapidKey` public key and posting the subscription to `POST /devices`).
 * This file only needs to exist at `/sw.js` and handle two events: showing a push notification, and
 * focusing/opening its deep link on click.
 *
 * The payload is `PushPayload` (packages/core/src/contracts/notifications.ts) as JSON: `title`, `body`,
 * `path` (the app route to open), and `notificationId` (used as the notification tag so a re-push of the
 * same notification replaces rather than stacks).
 *
 * A managed Whombat's push comes from control (MA-18, CL-120) as `{title, body, kind, ref, tag?, clear?}`. `title`
 * and `body` are the appliance's preview (who wrote and where, the start of the message; CT-286), or control's fixed
 * “Whombat” / “Whombat needs you” when there is none, which is shown as one line per kind instead (the same words
 * as `PUSH_TEXT` in `@whombat/client/managed`, checked by `sw.test.ts`). Notifications with the same `tag` (a thread,
 * an approval; else the ref) replace each other quietly; `clear` closes the one with that tag and shows nothing. A
 * click opens `/?push=<kind>&ref=<ref>`, which the app resolves through its session.
 */

const GENERIC_TEXT = {
  message: 'New message',
  mention: 'You were mentioned',
  approval: 'Something is waiting for your approval',
  run: 'An agent has news about a run',
  update: 'Your Whombat has an update',
  backup: 'Your Whombat’s backups need a look',
  security: 'A security change on your Whombat',
  generic: 'Whombat needs you',
};

/** Control's text when the appliance sent no preview (control `GENERIC_ALERT`). */
const CONTROL_GENERIC = { title: 'Whombat', body: 'Whombat needs you' };

/** What a managed push says: its preview, else “Whombat” and the kind's line. */
function managedText(payload, kind) {
  const title = typeof payload.title === 'string' ? payload.title : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const generic = !title || (title === CONTROL_GENERIC.title && body === CONTROL_GENERIC.body);
  if (generic) return { title: 'Whombat', body: GENERIC_TEXT[kind] };
  return { title, body: body || GENERIC_TEXT[kind] };
}

async function showManaged(payload) {
  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag : payload.ref;
  if (payload.clear === true || payload.clear === '1' || payload.clear === 'true') {
    for (const shown of await self.registration.getNotifications({ tag })) shown.close();
    return;
  }
  const kind = Object.hasOwn(GENERIC_TEXT, payload.kind) ? payload.kind : 'generic';
  const text = managedText(payload, kind);
  await self.registration.showNotification(text.title, {
    body: text.body,
    tag,
    renotify: false,
    data: { path: `/?push=${encodeURIComponent(kind)}&ref=${encodeURIComponent(payload.ref)}` },
    icon: '/icon-192.png',
    badge: '/badge-96.png',
  });
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  if (typeof payload.kind === 'string' && typeof payload.ref === 'string' && !payload.path) {
    event.waitUntil(showManaged(payload));
    return;
  }
  const title = payload.title || 'Whombat';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      tag: payload.notificationId || payload.path || undefined,
      data: { path: payload.path || '/' },
      icon: '/icon-192.png',
      badge: '/badge-96.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.path || '/';
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientsList) {
        const url = new URL(client.url);
        if (url.origin === self.location.origin && 'focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(path);
          return;
        }
      }
      await self.clients.openWindow(path);
    })(),
  );
});
