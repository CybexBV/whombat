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
 *
 * A push says whether it carries a preview (`preview: false` or `generic: true` means it doesn't); older pushes are
 * recognised by control's fixed text. The lines without a preview are in the person's language: the page registers the
 * worker as `/sw.js?lang=nl` and sends `{type: 'locale', lang}` when it changes, which the worker keeps in its own
 * cache (a worker has no `localStorage`).
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

const GENERIC_TEXT_NL = {
  message: 'Nieuw bericht',
  mention: 'Je bent genoemd',
  approval: 'Er wacht iets op jouw goedkeuring',
  run: 'Een assistent heeft nieuws over een uitvoering',
  update: 'Er is een update voor je Whombat',
  backup: 'De back-ups van je Whombat vragen aandacht',
  security: 'Een beveiligingswijziging op je Whombat',
  generic: 'Whombat heeft je nodig',
};

const TEXT_BY_LANGUAGE = { en: GENERIC_TEXT, nl: GENERIC_TEXT_NL };

/** Control's text when the appliance sent no preview (control `GENERIC_ALERT`). */
const CONTROL_GENERIC = { title: 'Whombat', body: 'Whombat needs you' };

/** Where the worker keeps the page's language between starts. */
const LOCALE_CACHE = 'whombat-sw-locale';
const LOCALE_ENTRY = '/__whombat-locale';

function cleanLanguage(value) {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return primary === 'nl' || primary === 'en' ? primary : null;
}

/** The language from the worker's own address (`/sw.js?lang=nl`). */
function scriptLanguage() {
  try {
    return cleanLanguage(new URL(self.location.href).searchParams.get('lang'));
  } catch {
    return null;
  }
}

let knownLanguage = null;

async function storedLanguage() {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(LOCALE_CACHE);
    const hit = await cache.match(LOCALE_ENTRY);
    return hit ? cleanLanguage(await hit.text()) : null;
  } catch {
    return null;
  }
}

async function rememberLanguage(language) {
  knownLanguage = language;
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(LOCALE_CACHE);
    await cache.put(LOCALE_ENTRY, new Response(language));
  } catch {
    // The address still carries it.
  }
}

/** The language for lines without a preview: what the page said last, else the worker's address, else English. */
async function currentLanguage() {
  if (knownLanguage) return knownLanguage;
  const language = (await storedLanguage()) || scriptLanguage() || 'en';
  knownLanguage = language;
  return language;
}

/** Whether a push carries no preview: its own flag, else control's fixed text from before the flag. */
function withoutPreview(payload, title, body) {
  if (payload.preview === false || payload.generic === true) return true;
  return !title || (title === CONTROL_GENERIC.title && body === CONTROL_GENERIC.body);
}

/** What a managed push says: its preview, else “Whombat” and the kind's line. */
function managedText(payload, kind, language) {
  const lines = TEXT_BY_LANGUAGE[language] || GENERIC_TEXT;
  const title = typeof payload.title === 'string' ? payload.title : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (withoutPreview(payload, title, body)) return { title: 'Whombat', body: lines[kind] };
  return { title, body: body || lines[kind] };
}

async function showManaged(payload) {
  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag : payload.ref;
  if (payload.clear === true || payload.clear === '1' || payload.clear === 'true') {
    for (const shown of await self.registration.getNotifications({ tag })) shown.close();
    return;
  }
  const kind = Object.hasOwn(GENERIC_TEXT, payload.kind) ? payload.kind : 'generic';
  const text = managedText(payload, kind, await currentLanguage());
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

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.type !== 'locale') return;
  const language = cleanLanguage(data.lang);
  if (!language) return;
  const done = rememberLanguage(language);
  if (typeof event.waitUntil === 'function') event.waitUntil(done);
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
